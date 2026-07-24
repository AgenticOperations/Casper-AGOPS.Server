# @agentops/sdk

Thin REST + MCP client for the AgentOps (Casper-AGOPS) proxy. Phase 2, Milestone F.3 (D-4).

## REST client

```ts
import { createAgentOpsClient } from '@agentops/sdk';

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
import { createAgentOpsMcpClient } from '@agentops/sdk';

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
