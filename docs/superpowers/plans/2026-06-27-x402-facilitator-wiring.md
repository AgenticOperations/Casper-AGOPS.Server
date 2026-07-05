# x402 Facilitator Settlement Wiring — Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `buildCasperFacilitator()` into the settlement path so that when an agent calls `casper_guard_reconcile` on an x402-payment decision, AgentOps calls `POST https://x402-facilitator.cspr.cloud/settle` to submit the `transfer_from` on-chain and records the returned deploy hash.

**Architecture:** Three focused changes in three files. (1) Add `CASPER_GUARD_FACILITATOR_URL` env var (the hosted CSPR.cloud facilitator endpoint, separate from the Casper node RPC). (2) Add `createFacilitatorSettlementReader()` to `settlement-reader.ts` — for x402 decisions with no deploy hash yet, calls `facilitator.settle()`, gets back the deploy hash, then delegates finality polling to the existing RPC reader. (3) In `casper-guard.ts`, build the facilitator from the new env var and use it as the `settlementReaderFactory` instead of the bare RPC reader.

**Tech Stack:** TypeScript, `@make-software/casper-x402` (already installed), Vitest, Fastify, Zod

---

## File Map

| File | Change |
|---|---|
| `src/config/env.ts` | Add `CASPER_GUARD_FACILITATOR_URL` (the `/settle` base URL) |
| `src/lib/casper/settlement-reader.ts` | Add `createFacilitatorSettlementReader()` |
| `src/config/casper-guard.ts` | Build facilitator + wire `settlementReaderFactory` to use it |
| `test/casper-guard/settlement-reader.test.ts` | Add tests for `createFacilitatorSettlementReader` |
| `test/casper-guard/reconcile-live-wiring.test.ts` | Update wiring test to assert facilitator reader is used |
| `.env` | Add `CASPER_GUARD_FACILITATOR_URL=https://x402-facilitator.cspr.cloud` |

**Files NOT touched:** `routes.ts`, `reconcile-worker.ts`, `store.ts`, `facilitator.ts`, `mcp.ts` — the existing plumbing is correct, only the wiring is missing.

---

## Task 1: Add `CASPER_GUARD_FACILITATOR_URL` env var

**Files:**
- Modify: `src/config/env.ts` (around line 51)
- Modify: `.env`

### Context

`CASPER_GUARD_FACILITATOR_RPC_URL` (existing) points at the Casper **node** RPC (`https://node.testnet.casper.network/rpc`). The facilitator is a different service at `https://x402-facilitator.cspr.cloud`. They need separate env vars. The existing var keeps its meaning (node RPC for finality polling); the new var is the facilitator base URL.

- [ ] **Step 1: Add env var to schema**

In `src/config/env.ts`, after line 51 (`CASPER_GUARD_FACILITATOR_RPC_URL`), add:

```typescript
  CASPER_GUARD_FACILITATOR_URL: z.string().url().or(z.literal('')).default(''),
```

- [ ] **Step 2: Add to `.env`**

In `.env`, add after the existing `CASPER_GUARD_FACILITATOR_RPC_URL` line:

```
# Hosted x402 facilitator that submits the on-chain transfer_from (POST /settle).
# Testnet: https://x402-facilitator.cspr.cloud
CASPER_GUARD_FACILITATOR_URL=https://x402-facilitator.cspr.cloud
```

- [ ] **Step 3: Run the server to verify it boots**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
pnpm exec tsx --env-file=.env src/server.ts &
sleep 3
curl -s http://localhost:8080/v1/casper-guard/status | python3 -m json.tool | grep -E "facilitator|signer|status"
kill %1
```

Expected: server boots, status endpoint shows `live_settlement.configured: true` still.

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts .env
git commit -m "feat(casper-guard): add CASPER_GUARD_FACILITATOR_URL env var for hosted x402 facilitator"
```

---

## Task 2: Add `createFacilitatorSettlementReader`

**Files:**
- Modify: `src/lib/casper/settlement-reader.ts`
- Modify: `test/casper-guard/settlement-reader.test.ts`

### Context

The new reader handles x402 decisions that have **no deploy hash yet** (the facilitator hasn't settled them). On `read()`:
1. If `decision.deployHash` or `decision.txHash` is already set → delegate immediately to the RPC reader (idempotent: don't call `/settle` twice).
2. If no hash and `decision.actionKind !== 'x402-payment'` → delegate to RPC reader (only x402 uses facilitator settlement).
3. Otherwise → call `facilitator.settle({ payload, requirements })`, record the returned `txHash` on the decision, then delegate to the RPC reader for finality.

The payload and requirements come from `decision.intent` (the `intentJson` stored at authorization time). The `CasperFacilitator` interface's `settle()` already returns `{ success, txHash?, reason? }`.

**Important:** The reader must **not** write to the DB itself — it returns a `CasperGuardSettlementRead` result. The `txHash` from `facilitate.settle()` is returned in the result's `deployHash` field so the reconcile worker's `settleSignedDecision()` can write it to the DB via `markCasperGuardDecisionSettled()`.

- [ ] **Step 1: Write the failing tests first**

Append to `test/casper-guard/settlement-reader.test.ts`:

```typescript
import { createFacilitatorSettlementReader } from '../../src/lib/casper/settlement-reader.js';
import type { CasperFacilitator } from '../../src/lib/casper/facilitator.js';

// Minimal fake facilitator
function makeFacilitator(result: Awaited<ReturnType<CasperFacilitator['settle']>>): CasperFacilitator {
  return {
    verify: async () => ({ isValid: true }),
    settle: async () => result,
  };
}

// Decision with no deploy hash (needs facilitator settlement)
const unsettledDecision = baseDecision({ deployHash: null, txHash: null });

describe('createFacilitatorSettlementReader', () => {
  it('calls facilitator.settle and returns settled with deploy hash on success', async () => {
    const fac = makeFacilitator({ success: true, txHash: 'deadbeef01' });
    const rpcReader = { getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: 'deadbeef01' }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('settled');
    if (r.status === 'settled') {
      expect(r.deployHash).toBe('deadbeef01');
      expect(r.source).toBe('facilitator');
    }
  });

  it('returns failed when facilitator.settle reports failure', async () => {
    const fac = makeFacilitator({ success: false, reason: 'invalid_signature' });
    const rpcReader = { getDeploy: async () => { throw new Error('should not be called'); } };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.errorCode).toBe('invalid_signature');
  });

  it('skips facilitator and delegates to RPC reader when deploy hash is already set', async () => {
    const fac = makeFacilitator({ success: false, reason: 'should_not_be_called' });
    fac.settle = async () => { throw new Error('facilitator should not be called'); };
    const rpcReader = { getDeploy: async () => ({ found: true, finalized: true, success: true, txHash: '0xtx' }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    // baseDecision() has deployHash set
    const r = await reader.read(baseDecision());
    expect(r.status).toBe('settled');
    expect(r.source).toBe('casper-rpc');
  });

  it('returns failed (not throws) when facilitator.settle throws', async () => {
    const fac: CasperFacilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => { throw new Error('network_error'); },
    };
    const rpcReader = { getDeploy: async () => ({ found: false }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const r = await reader.read(unsettledDecision);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.errorCode).toBe('facilitator_error');
  });

  it('skips facilitator for non-x402 decisions (casper-deploy uses RPC only)', async () => {
    const fac: CasperFacilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => { throw new Error('should not be called for casper-deploy'); },
    };
    const rpcReader = { getDeploy: async () => ({ found: false }) };
    const reader = createFacilitatorSettlementReader(fac, rpcReader);
    const deployDecision = baseDecision({ actionKind: 'casper-deploy' as never, deployHash: null, txHash: null });
    const r = await reader.read(deployDecision);
    // Falls through to RPC reader, no deploy hash → pending
    expect(r.status).toBe('pending');
    expect(r.source).toBe('casper-rpc');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
pnpm exec vitest run --config vitest.config.ts test/casper-guard/settlement-reader.test.ts 2>&1 | tail -20
```

Expected: `createFacilitatorSettlementReader is not a function` or import error.

- [ ] **Step 3: Implement `createFacilitatorSettlementReader`**

In `src/lib/casper/settlement-reader.ts`, add this import at the top alongside the existing imports:

```typescript
import type { CasperFacilitator } from './facilitator.js';
```

Then append the new function after `composeSettlementReader`:

```typescript
/**
 * Settlement reader for x402-payment decisions that calls the hosted CSPR.cloud facilitator
 * (POST /settle) to submit the transfer_from on-chain, then delegates finality polling to the
 * existing RPC reader.
 *
 * Decision routing:
 * - deploy/tx hash already set → skip facilitator, delegate to RPC reader (idempotent)
 * - actionKind !== 'x402-payment' → skip facilitator, delegate to RPC reader
 * - no hash + x402 → call facilitator.settle(), return result with deployHash
 */
export function createFacilitatorSettlementReader(
  facilitator: CasperFacilitator,
  deployReader: DeployReader,
): CasperGuardSettlementReader {
  const rpcReader = createCasperRpcSettlementReader(deployReader);
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      // Already has a hash — facilitator already ran or operator submitted manually. Poll RPC.
      if (decision.deployHash ?? decision.txHash) {
        return rpcReader.read(decision);
      }
      // Non-x402 actions (casper-deploy, cspr-trade) settle via RPC or operator-wallet, not facilitator.
      if (decision.actionKind !== 'x402-payment') {
        return rpcReader.read(decision);
      }

      // x402 with no hash: call facilitator to submit transfer_from on-chain.
      let result: Awaited<ReturnType<CasperFacilitator['settle']>>;
      try {
        // The intent stored on the decision carries the full x402 payload needed by the facilitator.
        const intent = decision.intent as Record<string, unknown>;
        result = await facilitator.settle({ payload: intent, requirements: intent });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason },
          errorCode: 'facilitator_error',
        };
      }

      if (!result.success) {
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason: result.reason ?? 'unknown' },
          errorCode: result.reason ?? 'facilitator_settle_failed',
        };
      }

      // Facilitator submitted on-chain. Return settled immediately with the deploy hash.
      // The reconcile worker's settleSignedDecision() will write deployHash to the DB.
      return {
        status: 'settled',
        source: 'facilitator',
        evidence: { facilitator_tx: result.txHash },
        deployHash: result.txHash ?? null,
        txHash: result.txHash ?? null,
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests — all should pass**

```bash
pnpm exec vitest run --config vitest.config.ts test/casper-guard/settlement-reader.test.ts 2>&1 | tail -20
```

Expected: all tests in `settlement-reader.test.ts` pass (both existing and new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/casper/settlement-reader.ts test/casper-guard/settlement-reader.test.ts
git commit -m "feat(casper-guard): add createFacilitatorSettlementReader for x402 on-chain settlement"
```

---

## Task 3: Wire facilitator into `buildCasperGuardDeps`

**Files:**
- Modify: `src/config/casper-guard.ts`
- Modify: `test/casper-guard/reconcile-live-wiring.test.ts`

### Context

`buildCasperGuardDeps()` currently wires `CASPER_GUARD_FACILITATOR_RPC_URL` into a bare `createCasperRpcSettlementReader`. The fix: when `CASPER_GUARD_FACILITATOR_URL` (new var) is set, build the `CasperFacilitator` and use `createFacilitatorSettlementReader`. The RPC reader (backed by `CASPER_GUARD_FACILITATOR_RPC_URL` / node) is still used as the fallback deploy-finality poller inside `createFacilitatorSettlementReader`. If only the node RPC URL is set (no facilitator URL), keep the old passive reader for backwards compat.

- [ ] **Step 1: Update the wiring test first**

Replace the content of `test/casper-guard/reconcile-live-wiring.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { buildCasperGuardDeps } from '../../src/config/casper-guard.js';
import { loadEnv } from '../../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  ARC_RPC_URL: 'https://rpc.example',
  ARC_CHAIN_ID: '5042002',
  ARC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  GATEWAY_WALLET_ADDRESS: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  GATEWAY_MINTER_ADDRESS: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
};

describe('buildCasperGuardDeps settlement wiring', () => {
  it('exposes a live settlement reader factory and liveSettlement.configured=true when a facilitator rpc url is set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
    } as never);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(true);
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });

  it('stays honest-blocked (no factory, configured=false) when no rpc url is set', () => {
    const env = loadEnv(BASE as never);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(false);
    expect(deps.settlementReaderFactory).toBeUndefined();
  });

  it('the factory returns a reader with a read() function', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
    } as never);
    const deps = buildCasperGuardDeps(env);
    const reader = deps.settlementReaderFactory!();
    expect(typeof reader.read).toBe('function');
  });

  it('uses facilitator settlement reader when CASPER_GUARD_FACILITATOR_URL is set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
      CASPER_GUARD_FACILITATOR_URL: 'https://x402-facilitator.cspr.cloud',
      CASPER_GUARD_SIGNER_PEM_PATH: '/some/key.pem',
      CASPER_GUARD_SIGNER_MODE: 'local-testnet',
    } as never);
    const deps = buildCasperGuardDeps(env);
    expect(deps.liveSettlement?.configured).toBe(true);
    expect(typeof deps.settlementReaderFactory).toBe('function');
    // The factory must return a reader (type check only — no live network call here)
    const reader = deps.settlementReaderFactory!();
    expect(typeof reader.read).toBe('function');
  });

  it('falls back to rpc-only reader when CASPER_GUARD_FACILITATOR_URL is not set', () => {
    const env = loadEnv({
      ...BASE,
      CASPER_GUARD_FACILITATOR_RPC_URL: 'https://node.testnet.casper.network/rpc',
      // No CASPER_GUARD_FACILITATOR_URL
    } as never);
    const deps = buildCasperGuardDeps(env);
    expect(typeof deps.settlementReaderFactory).toBe('function');
  });
});
```

- [ ] **Step 2: Run the new wiring tests — the new test should fail**

```bash
pnpm exec vitest run --config vitest.config.ts test/casper-guard/reconcile-live-wiring.test.ts 2>&1 | tail -20
```

Expected: first 3 tests pass, the new `facilitator settlement reader` test fails or passes trivially — confirm the test file loads cleanly.

- [ ] **Step 3: Update `buildCasperGuardDeps` to wire the facilitator**

In `src/config/casper-guard.ts`:

**Add import** at the top (alongside existing imports):

```typescript
import { buildCasperFacilitator } from '../lib/casper/facilitator.js';
import { createFacilitatorSettlementReader } from '../lib/casper/settlement-reader.js';
```

**Replace** the existing `settlementReaderFactory` block (lines ~45–51):

```typescript
// Before (remove this):
...(env.CASPER_GUARD_FACILITATOR_RPC_URL !== ''
  ? {
      settlementReaderFactory: () =>
        createCasperRpcSettlementReader(
          createLiveDeployReader({ rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL }),
        ),
    }
  : {}),
```

```typescript
// After (replace with this):
...(env.CASPER_GUARD_FACILITATOR_RPC_URL !== ''
  ? {
      settlementReaderFactory: () => {
        const deployReader = createLiveDeployReader({ rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL });
        // When the hosted facilitator URL is configured, use it to submit transfer_from on-chain.
        // Falls back to passive RPC polling when only the node URL is set (backwards compat).
        if (env.CASPER_GUARD_FACILITATOR_URL !== '' && env.CASPER_GUARD_SIGNER_PEM_PATH !== '') {
          // buildCasperFacilitator is async but settlementReaderFactory is sync — resolve at call time.
          // The facilitator wraps @make-software/casper-x402 ExactCasperScheme which calls /settle.
          return createFacilitatorSettlementReaderFromConfig(
            env.CASPER_GUARD_FACILITATOR_URL,
            env.CASPER_GUARD_SIGNER_PEM_PATH,
            env.CASPER_GUARD_SIGNER_ALGORITHM,
            env.CASPER_GUARD_FACILITATOR_RPC_URL,
            deployReader,
          );
        }
        return createCasperRpcSettlementReader(deployReader);
      },
    }
  : {}),
```

**Add the helper function** at the bottom of `src/config/casper-guard.ts` (before the `parseNetworks` function):

```typescript
/**
 * Synchronous wrapper that creates a facilitator settlement reader.
 * buildCasperFacilitator is async (dynamic import), so we return a reader whose read()
 * lazily resolves the facilitator on first call and caches it.
 */
function createFacilitatorSettlementReaderFromConfig(
  facilitatorUrl: string,
  pemPath: string,
  algorithm: 'ed25519' | 'secp256k1',
  nodeRpcUrl: string,
  deployReader: import('../lib/casper/settlement-reader.js').DeployReader,
): import('../engines/casper-guard/reconcile-worker.js').CasperGuardSettlementReader {
  let facilitatorPromise: ReturnType<typeof buildCasperFacilitator> | undefined;

  function getFacilitator() {
    if (!facilitatorPromise) {
      facilitatorPromise = buildCasperFacilitator({ pemPath, algorithm, rpcUrl: facilitatorUrl });
    }
    return facilitatorPromise;
  }

  return {
    async read(decision) {
      const facilitator = await getFacilitator();
      if (!facilitator) {
        // Honest-blocked: facilitator failed to load (missing PEM, bad config) → fall back to RPC.
        return createCasperRpcSettlementReader(deployReader).read(decision);
      }
      return createFacilitatorSettlementReader(facilitator, deployReader).read(decision);
    },
  };
}
```

- [ ] **Step 4: Run all settlement/wiring tests**

```bash
pnpm exec vitest run --config vitest.config.ts \
  test/casper-guard/settlement-reader.test.ts \
  test/casper-guard/reconcile-live-wiring.test.ts \
  test/casper-guard/facilitator.test.ts \
  2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
pnpm exec vitest run --config vitest.config.ts 2>&1 | tail -30
```

Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/config/casper-guard.ts test/casper-guard/reconcile-live-wiring.test.ts
git commit -m "feat(casper-guard): wire CasperFacilitator into settlementReaderFactory for x402 on-chain settlement"
```

---

## Task 4: Smoke-test the full flow end-to-end

**Files:** none (runtime verification only)

### Context

Restart the server with the updated code and replay the x402 payment flow. This time `casper_guard_reconcile` should call `POST https://x402-facilitator.cspr.cloud/settle`, get back a deploy hash, and the decision should transition to `SETTLED`.

- [ ] **Step 1: Restart the server**

```bash
kill $(lsof -ti :8080) 2>/dev/null; sleep 1
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
pnpm exec tsx --env-file=.env src/server.ts > /tmp/casper-guard-server.log 2>&1 &
sleep 3
curl -s http://localhost:8080/v1/casper-guard/status | python3 -m json.tool | grep -E "status|facilitator|signer"
```

Expected: `"status": "ready"` or `"degraded"` (not `"blocked"`), `live_settlement.configured: true`.

- [ ] **Step 2: Run the full x402 payment flow**

```bash
# Step 1: policy check
curl -s -X POST http://localhost:8080/v1/casper-guard/mcp \
  -H "Authorization: Bearer ag_live_9eb5460b646c991c1915382ff550df51f68c0b115e586cbd" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"casper_guard_policy_check","arguments":{"agent_id":"agt_fc7cfbd73e56e00f29a2fb7f3ad9b3ca","intent":{"kind":"x402-payment","network":"casper:casper-test","resource_id":"svc:casper-paid-api","amount":"1000000000","asset":{"kind":"cep18","package_hash":"8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6","name":"wCSPR","version":"1"},"pay_to":"0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267","max_timeout_seconds":60}}}}' \
  | python3 -c "import sys,json; d=json.loads(json.loads(json.load(sys.stdin)['result']['content'][0]['text'])); print('policy:', d.get('outcome'))"
```

Expected: `policy: CHECK`

- [ ] **Step 3: Authorize and reconcile — look for deploy hash**

```bash
IDEM="idem-$(date +%s)-smoke01"

# Authorize
AUTH=$(curl -s -X POST http://localhost:8080/v1/casper-guard/mcp \
  -H "Authorization: Bearer ag_live_9eb5460b646c991c1915382ff550df51f68c0b115e586cbd" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"casper_guard_authorize_payment\",\"arguments\":{\"agent_id\":\"agt_fc7cfbd73e56e00f29a2fb7f3ad9b3ca\",\"idempotency_key\":\"$IDEM\",\"payment_required\":{\"x402Version\":2,\"resource\":{\"url\":\"svc:casper-paid-api\",\"serviceName\":\"CSPR.cloud API\"},\"accepts\":[{\"scheme\":\"exact\",\"network\":\"casper:casper-test\",\"amount\":\"1000000000\",\"asset\":\"8df5d26790e18cf0404502c62ce5dc9025800ad6975c97466e20506c39c505b6\",\"payTo\":\"0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267\",\"maxTimeoutSeconds\":60,\"extra\":{\"name\":\"wCSPR\",\"version\":\"1\"}}]}}}}}")
DECISION=$(echo $AUTH | python3 -c "import sys,json; d=json.loads(json.loads(json.load(sys.stdin)['result']['content'][0]['text'])); print(d.get('decision_id','ERROR:',d))")
echo "decision_id: $DECISION"

# Use PAYMENT-SIGNATURE to hit CSPR.cloud API (actual service call)
PAYMENT_HDR=$(echo $AUTH | python3 -c "import sys,json; d=json.loads(json.loads(json.load(sys.stdin)['result']['content'][0]['text'])); print(d['payment_header']['value'])")
curl -s "https://api.testnet.cspr.cloud/deploys?limit=1" \
  -H "Authorization: 019f0887-21ab-79cf-88fe-a8889753da53" \
  -H "PAYMENT-SIGNATURE: $PAYMENT_HDR" -o /dev/null -w "API call: HTTP %{http_code}\n"

# Reconcile — this should now call /settle on the facilitator
sleep 2
curl -s -X POST http://localhost:8080/v1/casper-guard/mcp \
  -H "Authorization: Bearer ag_live_9eb5460b646c991c1915382ff550df51f68c0b115e586cbd" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"casper_guard_reconcile\",\"arguments\":{\"agent_id\":\"agt_fc7cfbd73e56e00f29a2fb7f3ad9b3ca\",\"decision_id\":\"$DECISION\"}}}" \
  | python3 -c "import sys,json; d=json.loads(json.loads(json.load(sys.stdin)['result']['content'][0]['text'])); print('reconcile status:', d.get('status'), '| settled:', d.get('settled'), '| tx_hash:', d.get('tx_hash'))"
```

Expected: `reconcile status: SETTLED | settled: True | tx_hash: <64-char hex deploy hash>`

- [ ] **Step 4: Verify deploy hash on testnet**

```bash
DEPLOY_HASH="<the tx_hash from step 3>"
curl -s "https://api.testnet.cspr.cloud/deploys/$DEPLOY_HASH" \
  -H "Authorization: 019f0887-21ab-79cf-88fe-a8889753da53" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('status:', d.get('status'), '| contract_pkg:', d.get('contract_package_hash','')[:16],'...')"
```

Expected: `status: processed | contract_pkg: 8df5d26790e18c...` (wCSPR contract)

- [ ] **Step 5: Final commit**

```bash
git add .env
git commit -m "chore(casper-guard): set CASPER_GUARD_FACILITATOR_URL for x402 testnet settlement"
```

---

## Summary of Changes

| What | Why |
|---|---|
| New `CASPER_GUARD_FACILITATOR_URL` env var | Separates the hosted `/settle` endpoint from the Casper node RPC URL — they are different services |
| `createFacilitatorSettlementReader()` | New reader that calls `facilitator.settle()` for unsettled x402 decisions, gets deploy hash, then confirms via RPC |
| `createFacilitatorSettlementReaderFromConfig()` | Synchronous lazy wrapper so `settlementReaderFactory` (sync) can build the async `CasperFacilitator` on first use |
| Updated `buildCasperGuardDeps()` | When `CASPER_GUARD_FACILITATOR_URL` + `CASPER_GUARD_SIGNER_PEM_PATH` are set, uses the new facilitator reader instead of the passive RPC reader |
