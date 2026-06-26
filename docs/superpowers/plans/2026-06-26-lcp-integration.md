# LCP Integration — Hackathon Demo Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Legal Context Protocol (LCP) fetch-and-verify as a pre-authorization legal evidence layer, embedded in the decision `intent_json` so it flows automatically into the on-chain GuardRegistry anchor.

**Architecture:** A new `src/lib/lcp/discover.ts` module does one thing: fetch `/.well-known/legal-context.json` for a domain, verify the `atrHash` if present, and return a typed result. `routes.ts:authorizeWithStoredPolicy` calls it before `authorizeCasperGuardIntent` and merges the LCP context into the intent. Because `intent` is already in `computeCasperGuardDecisionHash`, no change to the reconcile-worker is needed — LCP data lands in the on-chain anchor automatically. A new `casper_guard_legal_context` MCP tool exposes this to AI agents directly.

**Tech Stack:** Node.js built-ins only (`node:crypto`, global `fetch`). No new npm dependencies. Vitest for tests.

---

## File Map

| Action | Path | What changes |
|--------|------|--------------|
| **Create** | `src/lib/lcp/discover.ts` | New module — fetch + atrHash verify |
| **Create** | `test/lcp/discover.test.ts` | Unit tests for discover (no DB/Redis) |
| **Modify** | `src/engines/casper-guard/policy.ts` | Add 3 deny reasons + `lcp?` field on `CasperGuardPolicy` |
| **Modify** | `src/engines/casper-guard/routes.ts` | Call `lcpDiscover` inside `authorizeWithStoredPolicy` |
| **Modify** | `src/engines/casper-guard/mcp.ts` | Add `casper_guard_legal_context` tool descriptor + handler |
| **Create** | `test/casper-guard/lcp-mcp.test.ts` | Integration test for the new MCP tool |

---

## Task 1: `src/lib/lcp/discover.ts` — the core module

**Files:**
- Create: `src/lib/lcp/discover.ts`

### What this file must do

1. Accept a `resourceId` string (e.g. `https://api.weather.example/premium`)
2. Extract the origin (`https://api.weather.example`)
3. Fetch `{origin}/.well-known/legal-context.json`
4. Parse the response
5. If `atrHash` is present: fetch the `terms` URL, sha256 the body, compare
6. Return a typed `LcpContext` object or `null` on fetch failure

### Types

```typescript
export interface LcpContext {
  termsUrl: string;
  atrHash: string | null;      // sha256:hex — what the merchant claims the hash is
  trustLevel: 1 | 2 | 3 | 4;  // 1=informational, 2=provable, 3=signed, 4=integrated
  fetchedAt: number;           // unix seconds
  acceptanceRequired: boolean;
  hashVerified: boolean;       // true only if atrHash was present AND matched
}

export type LcpDiscoverResult =
  | { ok: true; context: LcpContext }
  | { ok: false; reason: 'fetch_failed' | 'hash_mismatch' | 'parse_error' };
```

### The full implementation

```typescript
import { createHash } from 'node:crypto';

export interface LcpContext {
  termsUrl: string;
  atrHash: string | null;
  trustLevel: 1 | 2 | 3 | 4;
  fetchedAt: number;
  acceptanceRequired: boolean;
  hashVerified: boolean;
}

export type LcpDiscoverResult =
  | { ok: true; context: LcpContext }
  | { ok: false; reason: 'fetch_failed' | 'hash_mismatch' | 'parse_error' };

interface RawLcpDocument {
  terms?: unknown;
  atrHash?: unknown;
  acceptanceRequired?: unknown;
  trustLevel?: unknown;
}

export async function lcpDiscover(
  resourceId: string,
  options?: { timeoutMs?: number; fetchFn?: typeof fetch },
): Promise<LcpDiscoverResult> {
  const fetchFn = options?.fetchFn ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const fetchedAt = Math.floor(Date.now() / 1000);

  let origin: string;
  try {
    origin = new URL(resourceId).origin;
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  const lcpUrl = `${origin}/.well-known/legal-context.json`;

  let raw: RawLcpDocument;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchFn(lcpUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: 'fetch_failed' };
    raw = (await res.json()) as RawLcpDocument;
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  if (typeof raw.terms !== 'string') {
    return { ok: false, reason: 'parse_error' };
  }

  const termsUrl = raw.terms;
  const claimedAtrHash = typeof raw.atrHash === 'string' ? raw.atrHash : null;
  const acceptanceRequired = raw.acceptanceRequired === true;
  const rawTrustLevel = raw.trustLevel;
  const trustLevel: 1 | 2 | 3 | 4 =
    rawTrustLevel === 2 || rawTrustLevel === 3 || rawTrustLevel === 4 ? rawTrustLevel : 1;

  // If atrHash present, fetch terms doc and verify
  if (claimedAtrHash !== null) {
    let termsBody: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetchFn(termsUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, reason: 'fetch_failed' };
      termsBody = await res.text();
    } catch {
      return { ok: false, reason: 'fetch_failed' };
    }

    const computed = `sha256:${createHash('sha256').update(termsBody).digest('hex')}`;
    if (computed !== claimedAtrHash) {
      return { ok: false, reason: 'hash_mismatch' };
    }

    return {
      ok: true,
      context: {
        termsUrl,
        atrHash: claimedAtrHash,
        trustLevel: trustLevel === 1 ? 2 : trustLevel, // atrHash verified = at least level 2
        fetchedAt,
        acceptanceRequired,
        hashVerified: true,
      },
    };
  }

  return {
    ok: true,
    context: {
      termsUrl,
      atrHash: null,
      trustLevel: 1,
      fetchedAt,
      acceptanceRequired,
      hashVerified: false,
    },
  };
}
```

- [ ] **Step 1: Create `src/lib/lcp/discover.ts`** with the exact code above.

- [ ] **Step 2: Create `test/lcp/discover.test.ts`** with the following content:

```typescript
import { describe, expect, it } from 'vitest';
import { lcpDiscover } from '../../src/lib/lcp/discover.js';

function makeFetch(responses: Record<string, { status: number; body: string | object }>): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = input.toString();
    const entry = responses[url];
    if (!entry) throw new Error(`unexpected_fetch_url: ${url}`);
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => JSON.parse(body) as unknown,
      text: async () => body,
    } as Response;
  };
}

describe('lcpDiscover', () => {
  it('returns ok=false on network error', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: async () => { throw new Error('network_down'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fetch_failed');
  });

  it('returns ok=false on non-200 response', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({ 'https://example.com/.well-known/legal-context.json': { status: 404, body: '' } }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('fetch_failed');
  });

  it('returns ok=false on parse error (missing terms field)', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({
        'https://example.com/.well-known/legal-context.json': {
          status: 200,
          body: { notTerms: 'something' },
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse_error');
  });

  it('returns trustLevel=1, hashVerified=false when no atrHash', async () => {
    const result = await lcpDiscover('https://example.com/api', {
      fetchFn: makeFetch({
        'https://example.com/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://example.com/terms.md', acceptanceRequired: false },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.trustLevel).toBe(1);
      expect(result.context.hashVerified).toBe(false);
      expect(result.context.atrHash).toBeNull();
    }
  });

  it('returns acceptanceRequired=true when merchant sets it', async () => {
    const result = await lcpDiscover('https://vendor.example/resource', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://vendor.example/terms.md', acceptanceRequired: true },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.acceptanceRequired).toBe(true);
  });

  it('verifies atrHash and returns hashVerified=true on match', async () => {
    const { createHash } = await import('node:crypto');
    const termsContent = 'These are the terms of service v3.';
    const hash = `sha256:${createHash('sha256').update(termsContent).digest('hex')}`;
    const result = await lcpDiscover('https://vendor.example/api', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: { terms: 'https://vendor.example/terms.md', atrHash: hash, acceptanceRequired: true },
        },
        'https://vendor.example/terms.md': { status: 200, body: termsContent },
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.hashVerified).toBe(true);
      expect(result.context.atrHash).toBe(hash);
      expect(result.context.trustLevel).toBe(2);
    }
  });

  it('returns hash_mismatch when atrHash does not match terms content', async () => {
    const result = await lcpDiscover('https://vendor.example/api', {
      fetchFn: makeFetch({
        'https://vendor.example/.well-known/legal-context.json': {
          status: 200,
          body: {
            terms: 'https://vendor.example/terms.md',
            atrHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
        'https://vendor.example/terms.md': { status: 200, body: 'Different content.' },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hash_mismatch');
  });

  it('handles invalid resourceId gracefully', async () => {
    const result = await lcpDiscover('not-a-url', {
      fetchFn: async () => { throw new Error('should_not_be_called'); },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run only the new test to verify it passes**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/lcp/discover.test.ts
```

Expected: all 7 tests pass. No DB or Redis required — pure unit tests.

---

## Task 2: Add LCP types to `policy.ts`

**Files:**
- Modify: `src/engines/casper-guard/policy.ts:23-48`

**Exact changes — no other lines touched:**

- [ ] **Step 1: Add 3 deny reasons** to `CasperGuardDenyReason` (lines 23-34). Append before the closing `;`:

```typescript
  | 'legal_acceptance_required'
  | 'legal_context_fetch_failed'
  | 'legal_terms_hash_mismatch'
```

Result after edit:

```typescript
export type CasperGuardDenyReason =
  | 'per_transaction_max_exceeded'
  | 'spend_cap_exceeded'
  | 'action_not_allowed'
  | 'network_not_allowed'
  | 'service_not_allowed'
  | 'velocity_exceeded'
  | 'org_suspended'
  | 'trade_risk_exceeded'
  | 'idempotency_in_progress'
  | 'idempotency_conflict'
  | 'x402_asset_not_supported'
  | 'legal_acceptance_required'
  | 'legal_context_fetch_failed'
  | 'legal_terms_hash_mismatch';
```

- [ ] **Step 2: Add `lcp?` field** to `CasperGuardPolicy` interface (after `trade?`):

```typescript
  lcp?: {
    required: boolean;
    minTrustLevel: 1 | 2 | 3 | 4;
    failOpen: boolean;
  };
```

- [ ] **Step 3: Run the existing policy tests to confirm nothing broke**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/casper-guard/policy.test.ts
```

Expected: all pass. The new fields are optional — no existing test is affected.

---

## Task 3: Wire LCP into `routes.ts:authorizeWithStoredPolicy`

**Files:**
- Modify: `src/engines/casper-guard/routes.ts` (function at line 328)

**What to do:** Before calling `authorizeCasperGuardIntent`, call `lcpDiscover`. If it returns `ok: true`, attach the LCP context to `intent` as `intent.lcp`. Because `intent` is typed as `CasperGuardIntent` (a discriminated union), we attach `lcp` to the intent object as an extra field at runtime — TypeScript does not forbid extra properties on objects passed to functions. Then apply the `failOpen` / `acceptanceRequired` precedence rule.

**The precedence rule (hardcoded, not configurable):**
- If `lcpResult.ok === false` AND `policy.lcp?.failOpen !== true` → DENY with `legal_context_fetch_failed`
- If `lcpResult.ok === false` AND `policy.lcp?.failOpen === true` → proceed (skip legal check)
- If `lcpResult.ok === true` AND `context.acceptanceRequired === true` → always require trust level ≥ `policy.lcp?.minTrustLevel ?? 1` — merchant `acceptanceRequired` CANNOT be overridden by `failOpen`
- If `lcpResult.ok === true` AND `context.hashVerified === false` AND trust level required is ≥ 2 → DENY with `legal_terms_hash_mismatch`

- [ ] **Step 1: Add the import** at the top of `routes.ts` (after existing imports):

```typescript
import { lcpDiscover } from '../../lib/lcp/discover.js';
```

- [ ] **Step 2: Replace the body of `authorizeWithStoredPolicy`** (lines 328-368) with:

```typescript
export async function authorizeWithStoredPolicy(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  params: {
    orgId: string;
    agentId: string;
    idempotencyKey: string;
    intent: CasperGuardIntent;
  },
) {
  const { policy } = await resolveEffectivePolicy(app.deps.pg, app.deps.redis, {
    orgId: params.orgId,
    agentId: params.agentId,
  });

  const guardPolicy: CasperGuardPolicy = {
    policyRef: `${policy.policyId}@epoch${policy.policyEpoch}`,
    spendCap: policy.spend.spendCap.toString(),
    perTransactionMax: policy.spend.perTransactionMax.toString(),
    serviceScope: policy.spend.serviceScope,
    allowedActions: allowedActionsFromRails(policy.spend.railPermission),
    allowedNetworks: deps.networks ?? [CASPER_X402_TESTNET_NETWORK],
    velocityLimitPerHour: policy.spend.velocityLimitPerHour,
    trade: deps.trade ?? { maxSlippageBps: 100, allowedRiskLabels: ['low', 'medium'] },
  } satisfies CasperGuardPolicy;

  // LCP pre-authorization legal discovery
  const lcpResult = await lcpDiscover(params.intent.resourceId);
  const lcpPolicy = guardPolicy.lcp;

  if (!lcpResult.ok) {
    if (lcpResult.reason === 'hash_mismatch') {
      // Hash mismatch is always terminal — never failOpen
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_terms_hash_mismatch' as const,
      };
    }
    // fetch_failed or parse_error: apply failOpen
    if (lcpPolicy?.required && !lcpPolicy.failOpen) {
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_context_fetch_failed' as const,
      };
    }
    // failOpen=true or no lcp policy: proceed without legal context
  } else {
    const ctx = lcpResult.context;
    const minTrust = lcpPolicy?.minTrustLevel ?? 1;

    // Merchant acceptanceRequired always overrides operator failOpen
    if (ctx.acceptanceRequired && ctx.trustLevel < minTrust) {
      return {
        outcome: 'DENY' as const,
        decisionId: newCasperGuardDecisionId(),
        reason: 'legal_acceptance_required' as const,
      };
    }

    // Attach LCP context to intent for downstream hash inclusion
    (params.intent as Record<string, unknown>).lcp = {
      terms_url: ctx.termsUrl,
      atr_hash: ctx.atrHash,
      trust_level: ctx.trustLevel,
      fetched_at: ctx.fetchedAt,
      acceptance_required: ctx.acceptanceRequired,
    };
  }

  return authorizeCasperGuardIntent(
    {
      pool: app.deps.pg,
      redis: app.deps.redis,
      signer: deps.signer!,
    },
    {
      decisionId: newCasperGuardDecisionId(),
      holdId: newCasperGuardHoldId(),
      idempotencyKey: params.idempotencyKey,
      orgId: params.orgId,
      agentId: params.agentId,
      intent: params.intent,
      policy: guardPolicy,
      now: Math.floor(Date.now() / 1000),
    },
  );
}
```

- [ ] **Step 3: Run existing routes tests to confirm nothing broke**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/casper-guard/routes.test.ts
```

Expected: all pass. `lcpDiscover` will make real HTTP calls in tests — if tests use a local server, the fetch to `/.well-known/legal-context.json` will 404 and return `ok: false`. Because no `lcp.required` is set on the test policy, this means failOpen by default → existing tests unaffected.

> **If any route tests fail because of unexpected LCP fetch errors**: the fix is to pass `{ skipLcp: true }` or mock fetch in the test. Read the failing test first to understand the exact failure, then adjust. The test must NOT be changed to skip LCP in prod code paths.

---

## Task 4: Add `casper_guard_legal_context` MCP tool

**Files:**
- Modify: `src/engines/casper-guard/mcp.ts`

The tool: given a `resource_id` and optional `min_trust_level`, calls `lcpDiscover` and returns the result. No auth required (LCP is a public read). No DB or Redis involved.

- [ ] **Step 1: Add the import** at top of `mcp.ts`:

```typescript
import { lcpDiscover } from '../../lib/lcp/discover.js';
```

- [ ] **Step 2: Add the tool descriptor** to `TOOL_DESCRIPTORS` array (after `casper_guard_reconcile`, before `] as const`):

```typescript
  {
    name: 'casper_guard_legal_context',
    description: [
      'Fetch and verify the Legal Context Protocol (LCP) document for a service domain.',
      'Returns the legal terms URL, atrHash (SHA-256 proof of terms at transaction time), trust level, and whether acceptance is required.',
      'Call this BEFORE casper_guard_authorize_payment or casper_guard_authorize_action to surface legal terms the agent should reason about.',
      'If atrHash is present and verified, trust_level=2+ guarantees the exact document the agent saw is cryptographically committed to the on-chain GuardRegistry anchor.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        resource_id: {
          type: 'string',
          description: 'The resource URL or service identifier to fetch LCP context for (e.g. "https://api.weather.example/premium").',
        },
        min_trust_level: {
          type: 'number',
          enum: [1, 2, 3, 4],
          description: 'Optional minimum trust level required. Returns an error if the discovered trust level is below this.',
        },
      },
      required: ['resource_id'],
    },
  },
```

- [ ] **Step 3: Add the handler** to the switch block in `registerCasperGuardMcpRoute` (before the `default:` case):

```typescript
      case 'casper_guard_legal_context':
        return reply
          .code(200)
          .send(rpcToolResult(rpc.id, await legalContextTool(call.data.arguments)));
```

- [ ] **Step 4: Add the handler function** at the bottom of the file (before the closing brace helpers):

```typescript
async function legalContextTool(args: Record<string, unknown>) {
  const resourceId = requireString(args.resource_id, 'resource_id');
  const minTrustLevel =
    typeof args.min_trust_level === 'number' &&
    [1, 2, 3, 4].includes(args.min_trust_level)
      ? (args.min_trust_level as 1 | 2 | 3 | 4)
      : null;

  const result = await lcpDiscover(resourceId);

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      resource_id: resourceId,
    };
  }

  const ctx = result.context;

  if (minTrustLevel !== null && ctx.trustLevel < minTrustLevel) {
    return {
      ok: false,
      reason: 'trust_level_insufficient',
      resource_id: resourceId,
      discovered_trust_level: ctx.trustLevel,
      required_trust_level: minTrustLevel,
    };
  }

  return {
    ok: true,
    resource_id: resourceId,
    terms_url: ctx.termsUrl,
    atr_hash: ctx.atrHash,
    trust_level: ctx.trustLevel,
    fetched_at: ctx.fetchedAt,
    acceptance_required: ctx.acceptanceRequired,
    hash_verified: ctx.hashVerified,
    note: ctx.hashVerified
      ? 'atrHash verified — this exact document will be committed to the on-chain GuardRegistry anchor.'
      : 'No atrHash — terms fetched informational only.',
  };
}
```

- [ ] **Step 5: Remove `casper_guard_legal_context` from the `requiresSigner` check** (it does not need a signer). Verify `requiresSigner` in `mcp.ts` only guards `authorize_payment` and `authorize_action` — confirm it does not block the new tool. No change needed if the function only names those two tools.

- [ ] **Step 6: Run MCP tests**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/casper-guard/mcp.test.ts
```

Expected: all existing tests pass. The new tool adds a case to the switch — no existing case is changed.

---

## Task 5: Write integration test for the new MCP tool

**Files:**
- Create: `test/casper-guard/lcp-mcp.test.ts`

This test mocks out the global `fetch` so no real HTTP calls happen, then calls the MCP endpoint directly via the Fastify test server.

> **Note on test pattern:** Look at `test/casper-guard/mcp.test.ts` for the exact harness setup (how `startStores`, the Fastify app, and auth headers are constructed). Mirror that pattern exactly.

- [ ] **Step 1: Read `test/casper-guard/mcp.test.ts`** (first 100 lines) to understand the harness.

- [ ] **Step 2: Create `test/casper-guard/lcp-mcp.test.ts`** that:
  1. Starts the test server with `startStores` + the casper-guard app registration
  2. For each test case, stubs `globalThis.fetch` before calling the MCP endpoint
  3. Sends `POST /v1/casper-guard/mcp` with method `tools/call`, name `casper_guard_legal_context`
  4. Asserts on the returned `content[0].text` JSON

  Key scenarios to test:
  - Happy path: `/.well-known/legal-context.json` returns valid doc with no `atrHash` → `ok: true`, `trust_level: 1`
  - Happy path with verified hash → `ok: true`, `hash_verified: true`, `trust_level: 2`
  - Fetch failure → `ok: false`, `reason: fetch_failed`
  - `min_trust_level: 3` but discovered level is 2 → `ok: false`, `reason: trust_level_insufficient`
  - Tool does NOT require auth header → should work without `Authorization`

  Template for the test file (fill in after reading `mcp.test.ts` for the harness):

```typescript
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
// import harness helpers matching the pattern in mcp.test.ts

describe('casper_guard_legal_context MCP tool', () => {
  // setup/teardown matching mcp.test.ts pattern

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(responses: Record<string, { status: number; body: string | object }>) {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input.toString();
      const entry = responses[url];
      if (!entry) return new Response(null, { status: 404 });
      const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
      return new Response(body, { status: entry.status, headers: { 'content-type': 'application/json' } });
    });
  }

  it('returns ok=true with trust_level=1 when no atrHash', async () => {
    mockFetch({
      'https://api.example.com/.well-known/legal-context.json': {
        status: 200,
        body: { terms: 'https://api.example.com/terms.md' },
      },
    });
    // POST to MCP endpoint, assert response
  });

  // ... remaining scenarios
});
```

- [ ] **Step 3: Run the new test**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/casper-guard/lcp-mcp.test.ts
```

Expected: all pass.

---

## Task 6: Full regression run

- [ ] **Step 1: Run all casper-guard tests**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts test/casper-guard/
```

Expected: zero failures. If any test fails because `lcpDiscover` makes an unexpected real HTTP fetch, the fix is `vi.stubGlobal('fetch', ...)` in that specific test's `beforeEach` — do NOT change production code to skip LCP.

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/kaushalchaudhari/Desktop/web3/AgentOps-build/Casper-AGOPS.Server
npx vitest run --config vitest.casper.config.ts
```

Expected: all pass. This is the gate — do not declare done until this is green.

---

## Implementation Constraints

1. **`reconcile-worker.ts` is NOT touched.** LCP data lands in the on-chain hash automatically because `intent` is already in `computeCasperGuardDecisionHash` at line 274.

2. **No new npm dependencies.** `node:crypto` and global `fetch` (Node 18+) only.

3. **`failOpen` default is true** when no `lcp` policy is set — existing tests pass a policy with no `lcp` field, so `lcpPolicy?.required` is `undefined` (falsy) → all existing flows continue unaffected.

4. **Hash mismatch is never failOpen.** A merchant publishing a wrong hash is an active integrity failure. Always deny.

5. **`casper_guard_legal_context` requires no auth.** LCP documents are public. The tool handler calls `lcpDiscover` directly, no `requireAgent` call.
