# @agops-labs/sdk

Thin REST + MCP client for the AgentOps (Casper-AGOPS) proxy. Phase 2, Milestone F.3 (D-4).

**No private key ever touches this SDK.** The agent holds an `ag_` API key and asks the proxy for
permission; policy is evaluated and the payment is signed server-side, inside the vault. A
compromised agent can be denied or revoked instantly — it never held the key that would let it pay
without asking.

## Guarded fetch (recommended)

A drop-in `fetch` that handles the whole x402 handshake — call the service, get a 402, check policy,
attach the signed header, retry — so you write one call instead of five steps:

```ts
import { createGuardedFetch, PaymentDeniedError } from '@agops-labs/sdk';

const guardedFetch = createGuardedFetch({
  baseUrl: 'https://your-proxy.example',
  apiKey: 'ag_live_...',
  agentId: 'agt_...',            // must be the agent this key belongs to
  onDecision: (d) => console.log('decision', d.decisionId),   // optional audit hook
});

const res = await guardedFetch('https://svc.example/risk-oracle/score', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pair: 'CSPR-USDC', side: 'buy', size_motes: '1000000000' }),
});
const data = await res.json();   // paid 200
```

Non-402 responses pass through untouched, so this is safe as the only `fetch` in an agent — free
endpoints and errors behave exactly as the platform `fetch` does.

When policy refuses, it throws `PaymentDeniedError` with the reason rather than returning a
confusing 402:

```ts
try {
  await guardedFetch(SERVICE_URL);
} catch (err) {
  if (err instanceof PaymentDeniedError) {
    console.log(err.reason);      // e.g. 'spend_cap_exceeded', 'service_not_allowed'
    console.log(err.decisionId);  // audit id for this refusal
  }
}
```

`PaymentDeniedError` means policy worked correctly. `PaymentFlowError` is the different case where
the call never reached policy — a bad key, a tenant mismatch, or a malformed challenge.

Idempotency keys are generated per payment automatically. Pass `idempotencyKey: () => yourKey` only
if you need to control retry semantics yourself — reusing one key across different payments makes
the server return the first decision again.

## REST client

Use this when you want to drive the steps yourself (or authorize a `cspr-trade` / `casper-deploy` /
`evm-transfer` action rather than pay for an HTTP resource).

```ts
import { createAgentOpsClient } from '@agops-labs/sdk';

// Operator (sk_) client — fleet management.
const operator = createAgentOpsClient({ baseUrl: 'https://your-proxy.example', apiKey: 'sk_live_...' });
const { agent, api_key } = await operator.createAgent({ name: 'Trader' });
await operator.attachTradingFlow({ orgId: 'org_1', flow: compiledFlow, roleAssignments: { trader: agent.id } });
await operator.revokeAgent({ agentId: agent.id });
const decision = await operator.getDecision('cgd_...');

// Agent (ag_) client — authorize a payment or on-chain action.
const asAgent = createAgentOpsClient({ baseUrl: 'https://your-proxy.example', apiKey: api_key });

// Sync by default (D-4④): returns the ALLOW/DENY body directly.
const result = await asAgent.authorize({
  kind: 'x402-payment',
  agentId: agent.id,
  idempotencyKey: 'idem_1',
  paymentRequired: rawPaymentRequiredBodyFrom402Response,
});

// Async opt-in: get a pollable decisionId immediately instead.
const { decisionId } = await asAgent.authorize(sameInput, { async: true });
const status = await operator.getDecision(decisionId);
```

## MCP client

For agent frameworks (LangChain, CrewAI, ...) that consume the proxy as MCP tools instead of raw
REST:

```ts
import { createAgentOpsMcpClient } from '@agops-labs/sdk';

const mcp = createAgentOpsMcpClient({ url: 'https://your-proxy.example/v1/casper-guard/mcp', apiKey: 'ag_live_...' });
const tools = await mcp.listTools();
const result = await mcp.callTool('casper_guard_authorize_payment', {
  agent_id: agent.id,
  idempotency_key: 'idem_1',
  payment_required: rawPaymentRequiredBody,
});
```

Note: `casper_guard_create_agent`, `casper_guard_attach_trading_flow`, and `casper_guard_revoke_agent`
are OPERATOR-scoped tools — call `createAgentOpsMcpClient` with an `sk_` key for those, not an
agent's `ag_` key.

## One client per credential

A single client instance uses one API key. The server scopes `sk_` (operator) vs `ag_` (agent)
routes separately — construct two client instances if your code needs both.
