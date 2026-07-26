import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { lcpDiscover } from '../../lib/lcp/discover.js';
import { authenticateAgent } from '../oracle/auth.js';
import { authForRoute } from '../identity/access/route-guard.js';
import { registerAgent, createPolicyVersion, assignPolicy } from '../control/store.js';
import { attachTradingFlow } from '../control/attach-trading-flow.js';
import { revokeAgentDelegation } from '../identity/delegation/revoke-agent-delegation.js';
import { suspendAgent } from '../control/kill-switch.js';
import { revokeDelegatedKey } from '../identity/delegation/delegated-keys-store.js';
import type { CompiledTradingFlow } from '../control/trading-flow.js';
import { revokeAgentInFlight } from './policy.js';
import { normalizeCasperGuardIntent } from './types.js';
import {
  auditExport,
  authorizeWithStoredPolicy,
  intentFromPaymentRequired,
  allowedActionsFromRails,
  selectNetworkSlot,
  type CasperGuardDeps,
} from './routes.js';
import { CASPER_X402_TESTNET_NETWORK } from '../../lib/casper/x402.js';
import {
  markDecisionSettledByUser,
  readCasperGuardDecision,
  settleCasperGuardHold,
  type CasperGuardDecisionRecord,
} from './store.js';
import {
  reconcileCasperGuardDecision,
  computeCasperGuardDecisionHash,
  type AnchorStatus,
} from './reconcile-worker.js';
import { composeSettlementReader } from '../../lib/casper/settlement-reader.js';
import {
  CSPR_TRADE_READ_ONLY_TOOLS,
  isCsprTradeReadOnlyTool,
  callCsprTradeReadOnly,
} from '../../lib/casper/cspr-trade.js';
import { settleHold } from '../ledger/window.js';
import { emitDecisionSafe } from '../monitoring/telemetry.js';
import { CASPER_X402_HEADER_NAME } from '../../lib/casper/x402.js';

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const callSchema = z.object({
  name: z.string(),
  arguments: z.record(z.unknown()).default({}),
});

// Shared sub-schemas reused across intent variants.
const ASSET_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      description: 'Native CSPR asset',
      properties: {
        kind: { type: 'string', enum: ['native'] },
        symbol: { type: 'string', enum: ['CSPR'] },
      },
      required: ['kind', 'symbol'],
    },
    {
      type: 'object',
      description: 'CEP-18 fungible token (e.g. USDC on Casper)',
      properties: {
        kind: { type: 'string', enum: ['cep18'] },
        package_hash: { type: 'string', pattern: '^[0-9a-fA-F]{64}$', description: '64-char hex contract package hash' },
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'package_hash', 'name', 'version'],
    },
    {
      type: 'object',
      description: 'Native ETH asset (EVM networks)',
      properties: {
        kind: { type: 'string', enum: ['native-eth'] },
        symbol: { type: 'string', enum: ['ETH'] },
      },
      required: ['kind', 'symbol'],
    },
    {
      type: 'object',
      description: 'ERC-20 token (EVM networks)',
      properties: {
        kind: { type: 'string', enum: ['erc20'] },
        address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        name: { type: 'string', minLength: 1 },
        decimals: { type: 'integer', minimum: 0, maximum: 18 },
      },
      required: ['kind', 'address', 'name', 'decimals'],
    },
  ],
} as const;

const INTENT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      title: 'casper-deploy',
      description: 'Native Casper deploy — transfer, contract-call, or contract-install. Use resource_id "casper:deploy:guard-registry".',
      properties: {
        kind: { type: 'string', enum: ['casper-deploy'] },
        network: { type: 'string', enum: ['casper:casper-test', 'casper:casper'], description: 'Default to "casper:casper-test". Use "casper:casper" (MAINNET — real, irreversible funds) ONLY when the user explicitly asked for mainnet. Never infer mainnet.' },
        resource_id: { type: 'string', description: 'Must be in the agent\'s service_scope. Use "casper:deploy:guard-registry" for Casper deploys.' },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Amount in motes (integer string, no decimals).' },
        asset: { ...ASSET_SCHEMA, description: 'Use {"kind":"native","symbol":"CSPR"} for native CSPR transfers.' },
        deploy_kind: { type: 'string', enum: ['transfer', 'contract-call', 'contract-install'] },
        target: { type: 'string', minLength: 1, description: 'Recipient account hash (66-char: "00" + 64-char hex) or contract address.' },
        entry_point: { type: 'string', description: 'Entry point name for contract-call deploys.' },
        args_hash: { type: 'string', description: 'SHA-256 hash of the deploy args for audit.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'asset', 'deploy_kind', 'target'],
    },
    {
      type: 'object',
      title: 'cspr-trade',
      description: 'CSPR.trade DEX swap on Casper testnet. Valid tokens: CSPR and sCSPR (wrapped CSPR). USDT does NOT exist on Casper testnet — never use it. Provide from_asset, to_asset, amount, min_received, and slippage_bps — the server fetches the real quote internally. Use resource_id "cspr.trade:swap". route_id is optional (server derives it).',
      properties: {
        kind: { type: 'string', enum: ['cspr-trade'] },
        network: { type: 'string', enum: ['casper:casper-test', 'casper:casper'], description: 'Default to "casper:casper-test". Use "casper:casper" (MAINNET — real, irreversible funds) ONLY when the user explicitly asked for mainnet. Never infer mainnet.' },
        resource_id: { type: 'string', description: 'Must be "cspr.trade:swap".' },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Amount of from_asset in smallest unit (motes for CSPR).' },
        from_asset: { ...ASSET_SCHEMA, description: 'Asset being sold.' },
        to_asset: { ...ASSET_SCHEMA, description: 'Asset being bought.' },
        min_received: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'Minimum to_asset amount to accept (in smallest unit). Prevents slippage above tolerance.' },
        slippage_bps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Slippage tolerance in basis points (100 = 1%). Must be ≤ policy maxSlippageBps.' },
        route_id: { type: 'string', minLength: 1, description: 'Route identifier from CSPR.trade get_quote response. Optional — the server re-derives it from the token pair; omit if you do not have a quote.' },
        risk_label: { type: 'string', description: 'Risk label from CSPR.trade quote ("low", "medium", "high"). Required for policy trade_risk check.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'from_asset', 'to_asset', 'min_received', 'slippage_bps'],
    },
    {
      type: 'object',
      title: 'evm-transfer',
      description: 'EVM chain transfer (ETH or ERC-20). Caller broadcasts from their own wallet then reconciles with tx_hash.',
      properties: {
        kind: { type: 'string', enum: ['evm-transfer'] },
        network: { type: 'string', enum: ['evm:sepolia', 'evm:base-sepolia'] },
        resource_id: { type: 'string', minLength: 1 },
        amount: { type: 'string', pattern: '^[1-9][0-9]*$' },
        asset: ASSET_SCHEMA,
        to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'EVM recipient address.' },
      },
      required: ['kind', 'network', 'resource_id', 'amount', 'asset', 'to'],
    },
  ],
} as const;

export const TOOL_DESCRIPTORS = [
  {
    name: 'casper_guard_policy_check',
    description: 'Dry-run a AgentOps intent against the agent policy without signing. Returns allowed_resource_ids and allowed_networks on DENY so the caller can correct the intent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        intent: INTENT_SCHEMA,
      },
      required: ['agent_id', 'intent'],
    },
  },
  {
    name: 'casper_guard_authorize_payment',
    description: [
      'Authorize a Casper x402 HTTP payment for any paid service endpoint and return the ready-to-use PAYMENT-SIGNATURE header on ALLOW.',
      'Use this whenever you need to call a paid HTTP service (any resource_id listed by casper_guard_list_services).',
      'Do NOT use casper_guard_authorize_action for HTTP service calls — that tool is only for on-chain actions (DEX swaps, deploys, EVM transfers).',
      'REQUIRED: pass the raw payment_required body returned by the HTTP 402 response exactly as-is — do not reconstruct or modify it.',
      'The 402 body already contains the correct asset, payTo address, and amount; do not guess or invent these values.',
      'On ALLOW, the response includes payment_header: { name, value }.',
      'Use payment_header.value verbatim as the PAYMENT-SIGNATURE HTTP header when retrying the endpoint.',
      'Also include x-guard-decision-id: decision_id in the retry request.',
      'signed_header_hash_audit_only is for audit trail only — do NOT use it as a header value.',
      'No PEM key or wallet signing is needed — the server handles all cryptography.',
      'Flow: (1) hit endpoint without headers → get HTTP 402 + payment_required body, (2) call this tool with that body, (3) retry endpoint with { "PAYMENT-SIGNATURE": payment_header.value, "x-guard-decision-id": decision_id }.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 160 },
        payment_required: { type: 'object', description: 'The raw payment_required object from the HTTP 402 response body. Pass it as-is — do not modify.' },
      },
      required: ['agent_id', 'idempotency_key', 'payment_required'],
    },
  },
  {
    name: 'casper_guard_authorize_action',
    description: [
      'Authorize a CSPR.trade DEX swap (cspr-trade), Casper on-chain deploy (casper-deploy), or EVM transfer (evm-transfer).',
      'NEVER use this for HTTP service calls (order book, risk oracle, trade log) — those use casper_guard_authorize_payment.',
      'NEVER use casper-deploy with resource_id starting with "svc:" or "cspr.trade:" — Guard will deny with action_kind_resource_mismatch.',
      'casper-deploy is ONLY for resource_id "casper:deploy:guard-registry" (on-chain contract calls).',
      'cspr-trade is for DEX swaps with resource_id "cspr.trade:swap".',
      'evm-transfer is for EVM chain transfers with evm:sepolia or evm:base-sepolia network.',
      'NETWORK: default to casper:casper-test. casper:casper is MAINNET — real, irreversible funds — and is permitted ONLY when the user explicitly asked for mainnet in this request. Never infer it, never carry it over from an earlier step, and confirm before authorizing. EVM rails use evm:sepolia or evm:base-sepolia.',
      'Field names use snake_case (e.g. deploy_kind, resource_id, from_asset) — camelCase is rejected.',
      'For casper-deploy: call casper_guard_reconcile with decision_id after ALLOW — operator broadcasts.',
      'For evm-transfer: broadcast from your own wallet first, then call casper_guard_reconcile with tx_hash.',
      'For cspr-trade: call casper_guard_reconcile without tx_hash — settlement is read from chain.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 160 },
        intent: INTENT_SCHEMA,
      },
      required: ['agent_id', 'idempotency_key', 'intent'],
    },
  },
  {
    name: 'casper_guard_decision_status',
    description: 'Read the durable status for a AgentOps decision.',
    inputSchema: {
      type: 'object',
      properties: { decision_id: { type: 'string' } },
      required: ['decision_id'],
    },
  },
  {
    name: 'casper_guard_audit_export',
    description: 'Export judge-verifiable audit JSON for a AgentOps decision.',
    inputSchema: {
      type: 'object',
      properties: { decision_id: { type: 'string' } },
      required: ['decision_id'],
    },
  },
  {
    name: 'casper_guard_reconcile',
    description: [
      'Record settlement for an ALLOW decision and anchor the proof to the AgentOpsRegistry.',
      'casper-deploy: call with decision_id only — the operator broadcast the deploy; settlement is resolved server-side.',
      'evm-transfer: broadcast from your own wallet FIRST, then call with tx_hash.',
      'x402-payment / cspr-trade: call WITHOUT tx_hash — the platform reads settlement from chain.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        decision_id: { type: 'string' },
        tx_hash: {
          type: 'string',
          description: 'Deploy/transaction hash returned by your wallet after broadcasting. Required for casper-deploy and evm-transfer; omit for x402-payment and cspr-trade.',
        },
      },
      required: ['agent_id', 'decision_id'],
    },
  },
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
  {
    name: 'casper_guard_list_services',
    description: [
      'List all available paid x402 services and their endpoints, including their URLs, resource IDs, prices, and what data they return.',
      'Call this tool FIRST whenever the user asks for any data or capability that might come from a service — even if they use informal language.',
      'Available services include: order book depth (bids/asks, mid price, spread, volume), risk oracle score (risk score 0-100, risk label, max safe size), trade log publishing, and trade log reading.',
      'If the user mentions "order book", "bids", "asks", "depth", "price", "spread", "risk score", "risk label", "safe size", "trade log", or any similar concept — call this tool first to find the matching service before doing anything else.',
      'After calling this tool you will know the exact URL and resource_id to use in the x402 payment flow.',
      'The complete x402 service-call flow:',
      '(1) Call this tool to find the service URL and resource_id.',
      '(2) Hit the service endpoint WITHOUT any headers — it returns HTTP 402 with a payment_required body.',
      '(3) Pass that exact payment_required body (unmodified) to casper_guard_authorize_payment.',
      '(4) On ALLOW, use payment_header.value as the PAYMENT-SIGNATURE header and decision_id as x-guard-decision-id.',
      '(5) Retry the endpoint with those two headers — the server returns the data.',
      '(6) Call casper_guard_reconcile with agent_id and decision_id to settle this payment and anchor the proof on-chain.',
      'No PEM key or manual signing required. The server handles all cryptography.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'casper_guard_trade_data',
    description: [
      'Read LIVE market data from the CSPR.trade DEX through Guard — tradable tokens and their CEP-18 package hashes, pools and reserves, real swap quotes, price impact, balances, and history.',
      'Use this for anything about what can actually be traded and at what price: "which pairs exist", "what is the package hash for sCSPR", "what would 5 CSPR get me", "what is the price impact".',
      'This is the authoritative source for pre-trade numbers — always quote from here before proposing or authorizing a cspr-trade swap, and never estimate a fill price from any other source.',
      'READ-ONLY: no funds move and nothing is signed. Executing a swap still requires casper_guard_authorize_action followed by casper_guard_reconcile.',
      'Distinct from casper_guard_list_services, which lists the paid x402 HTTP demo services (order book, risk oracle) — those are separate endpoints with their own payment flow.',
      'Free — no x402 payment, no decision, no hold.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The calling agent id.' },
        network: {
          type: 'string',
          enum: ['casper:casper-test', 'casper:casper'],
          description:
            'Which venue to read. Defaults to casper:casper-test. Reading casper:casper (mainnet) market data is safe and moves no funds — mainnet pools are far deeper, so mainnet quotes are more meaningful than near-empty testnet pools.',
        },
        tool: {
          type: 'string',
          enum: [...CSPR_TRADE_READ_ONLY_TOOLS],
          description:
            'The CSPR.trade read tool to call. get_tokens lists tradable tokens with package hashes; get_pairs lists pools with reserves; get_quote prices a swap; estimate_price_impact reports slippage severity.',
        },
        arguments: {
          type: 'object',
          description:
            'Arguments for that tool, passed through unchanged. e.g. get_quote takes { token_in, token_out, amount, type: "exact_in" } where amount is in the smallest unit. Omit for tools that take none.',
          additionalProperties: true,
        },
      },
      required: ['agent_id', 'tool'],
    },
  },
  {
    name: 'casper_guard_create_agent',
    description: [
      'FLEET MANAGEMENT (admin/operator use only — requires an sk_ operator key, not an agent ag_ key).',
      'Create a new agent under the calling operator\'s org and return its ag_ API key ONCE.',
      'Use this to provision a new member of a trading fleet (Milestone D) before attaching a trading flow.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        team_id: { type: 'string', description: 'Optional — groups agents into a fleet (D-6②).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'casper_guard_attach_trading_flow',
    description: [
      'FLEET MANAGEMENT (admin/operator use only — requires an sk_ operator key, not an agent ag_ key).',
      'Attach a compiled trading flow (Milestone D — e.g. a Data+Risk+Trader fleet template instance) to real agents.',
      'Writes a spend + allocation policy per role and assigns the spend policy to that role\'s agent.',
      'The flow must already be compiled (compileTradingFlow / instantiateFleetTemplate) before calling this tool.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'object', description: 'A CompiledTradingFlow object (name, version, roles[]).' },
        role_assignments: {
          type: 'object',
          description: 'Map of role name -> agent_id, one entry per role in the flow.',
        },
      },
      required: ['flow', 'role_assignments'],
    },
  },
  {
    name: 'casper_guard_revoke_agent',
    description: [
      'FLEET MANAGEMENT (admin/operator use only — requires an sk_ operator key, not an agent ag_ key).',
      'Full delegated-key revoke (D-2④ honest hard-stop): instantly suspends the agent (kill-switch, no on-chain wait),',
      'revokes its delegated_keys record, and aborts any still-unsigned in-flight decisions while leaving',
      'already-signed decisions to settle normally. Does NOT itself submit the on-chain revoke deploy —',
      'that is a separate user/SDK-signed step (buildRevokeDeployArgs).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
      },
      required: ['agent_id'],
    },
  },
] as const;

export function registerCasperGuardMcpRoute(app: FastifyInstance): void {
  app.post('/v1/casper-guard/mcp', async (request, reply) => {
    const parsed = rpcSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(rpcError(null, -32600, 'invalid_request'));
    }
    const rpc = parsed.data;

    // MCP protocol handshake — must respond before any tools/list or tools/call is accepted.
    // mcp-remote, Claude Code, and all compliant clients send this first.
    if (rpc.method === 'initialize') {
      return reply.code(200).send(rpcResult(rpc.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'casper-guard', version: '1.0.0' },
      }));
    }

    // One-way notification sent by clients after a successful initialize — no response body needed.
    if (rpc.method === 'notifications/initialized') {
      return reply.code(200).send({ jsonrpc: '2.0' });
    }

    if (rpc.method === 'tools/list') {
      return reply.code(200).send(rpcResult(rpc.id, { tools: TOOL_DESCRIPTORS }));
    }

    if (rpc.method !== 'tools/call') {
      return reply.code(200).send(rpcError(rpc.id, -32601, 'method_not_found'));
    }

    const call = callSchema.safeParse(rpc.params);
    if (!call.success) {
      return reply.code(200).send(rpcError(rpc.id, -32602, 'invalid_params'));
    }

    const deps = app.deps.casperGuard;
    if (!deps?.signer && requiresSigner(call.data.name)) {
      return reply.code(200).send(rpcError(rpc.id, -32000, 'casper_guard_signer_not_configured'));
    }

    try {
      switch (call.data.name) {
        case 'casper_guard_authorize_payment':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await authorizePaymentTool(app, deps!, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_authorize_action':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await authorizeActionTool(app, deps!, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_decision_status':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await decisionStatusTool(app, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_audit_export':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await auditExportTool(app, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_policy_check':
          return reply.code(200).send(rpcToolResult(rpc.id, await policyCheckTool(app, deps, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_reconcile':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await reconcileTool(app, deps!, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_legal_context':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await legalContextTool(call.data.arguments)));
        case 'casper_guard_list_services':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, listServicesTool()));
        case 'casper_guard_trade_data':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await tradeDataTool(app, deps, request.headers.authorization, call.data.arguments)));
        case 'casper_guard_create_agent':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await createAgentTool(app, request, call.data.arguments)));
        case 'casper_guard_attach_trading_flow':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await attachTradingFlowTool(app, request, call.data.arguments)));
        case 'casper_guard_revoke_agent':
          return reply
            .code(200)
            .send(rpcToolResult(rpc.id, await revokeAgentTool(app, request, call.data.arguments)));
        default:
          return reply.code(200).send(rpcError(rpc.id, -32602, 'unknown_tool'));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ tool: call.data.name, err }, 'mcp tool handler threw');
      return reply.code(200).send(rpcToolResult(rpc.id, { ok: false, error: message }));
    }
  });
}

async function authorizePaymentTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const idempotencyKey = requireString(args.idempotency_key, 'idempotency_key');
  const intent = intentFromPaymentRequired(args.payment_required);
  // Route to the slot the intent names — see slotNetworkForIntent. The network here comes from the
  // service's own 402 challenge, so a mainnet service resolves to the mainnet slot.
  const selection = selectNetworkSlot(deps, slotNetworkForIntent(intent.network));
  if (!selection.ok) throw new Error(selection.error);
  const result = await authorizeWithStoredPolicy(app, deps, selection.slot, {
    orgId: auth.orgId,
    agentId: auth.agentId,
    idempotencyKey,
    intent,
  });
  if (result.outcome === 'DENY') {
    return { outcome: 'DENY', decision_id: result.decisionId, reason: result.reason, signature_required: false, ...(result.detail ? { detail: result.detail } : {}) };
  }
  const headerValue = result.headers?.[CASPER_X402_HEADER_NAME];
  if (!headerValue) throw new Error('casper_payment_header_unavailable');
  return {
    outcome: 'ALLOW',
    decision_id: result.decisionId,
    hold_id: result.holdId,
    // Use payment_header.value verbatim as the PAYMENT-SIGNATURE HTTP header.
    // Use decision_id as the x-guard-decision-id HTTP header.
    // No additional signing needed — the server already signed this.
    payment_header: { name: CASPER_X402_HEADER_NAME, value: headerValue },
    // AUDIT ONLY — do not use this as a header value.
    signed_header_hash_audit_only: result.signedHeaderHash,
    _instructions: 'Retry the service endpoint with headers: { "PAYMENT-SIGNATURE": payment_header.value, "x-guard-decision-id": decision_id }. No PEM key or additional signing required.',
    next_step: 'After the service call completes, call casper_guard_reconcile with agent_id and decision_id to settle this payment and anchor the proof on-chain.',
  };
}

async function authorizeActionTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const idempotencyKey = requireString(args.idempotency_key, 'idempotency_key');
  const intent = normalizeCasperGuardIntent(args.intent);
  /*
   * Route to the slot the INTENT names. MCP calls carry no x-agentops-network header, so the
   * intent's own network is the only signal — passing undefined here would sign and settle a
   * `casper:casper` intent with the TESTNET signer/facilitator/anchorer while recording it as
   * mainnet. A mainnet intent with no configured mainnet slot fails closed (503-equivalent
   * network_not_configured) rather than silently executing on testnet.
   */
  const selection = selectNetworkSlot(deps, slotNetworkForIntent(intent.network));
  if (!selection.ok) throw new Error(selection.error);
  const result = await authorizeWithStoredPolicy(app, deps, selection.slot, {
    orgId: auth.orgId,
    agentId: auth.agentId,
    idempotencyKey,
    intent,
  });
  if (result.outcome === 'DENY') {
    return { outcome: 'DENY', decision_id: result.decisionId, reason: result.reason, signature_required: false, ...(result.detail ? { detail: result.detail } : {}) };
  }
  const userBroadcastRequired = intent.kind === 'evm-transfer';
  return {
    outcome: 'ALLOW',
    decision_id: result.decisionId,
    hold_id: result.holdId,
    signed_header_hash: result.signedHeaderHash,
    ...(userBroadcastRequired ? { signature_required: true } : {}),
    next_step: userBroadcastRequired
      ? 'Broadcast the transaction from your own wallet, then call casper_guard_reconcile with the tx_hash.'
      : 'Call casper_guard_reconcile with the decision_id — the operator will handle execution.',
  };
}

async function decisionStatusTool(
  app: FastifyInstance,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  const decision = await readTenantDecision(app, auth.agent.orgId, requireString(args.decision_id, 'decision_id'));
  return decisionStatus(decision);
}

async function auditExportTool(
  app: FastifyInstance,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  return auditExport(await readTenantDecision(app, auth.agent.orgId, requireString(args.decision_id, 'decision_id')));
}

/**
 * F.2 fleet-management tools. Unlike every other tool in this file (agent ag_ auth via
 * authenticateAgent), these three are OPERATOR-scoped — they use the same sk_/session admin auth
 * (authForRoute) as the REST routes in delegation-routes.ts, since creating agents, attaching
 * trading flows, and revoking an agent's delegated key are all admin-level actions. An agent's own
 * ag_ key does NOT satisfy this check.
 */
async function createAgentTool(app: FastifyInstance, request: FastifyRequest, args: Record<string, unknown>) {
  const auth = await authForRoute(app, request, 'admin');
  if (!auth.ok) throw new Error(auth.reason);
  const name = requireString(args.name, 'name');
  const teamId = typeof args.team_id === 'string' ? args.team_id : undefined;

  const { agent, apiKey } = await registerAgent(app.deps.pg, {
    orgId: auth.principal.orgId,
    name,
    ...(teamId ? { teamId } : {}),
  });
  return {
    agent: { id: agent.id, name: agent.name, org_id: agent.orgId, status: agent.status },
    api_key: apiKey.token, // shown ONCE
  };
}

async function attachTradingFlowTool(app: FastifyInstance, request: FastifyRequest, args: Record<string, unknown>) {
  const auth = await authForRoute(app, request, 'admin');
  if (!auth.ok) throw new Error(auth.reason);
  if (typeof args.flow !== 'object' || args.flow === null) throw new Error('invalid_flow');
  if (typeof args.role_assignments !== 'object' || args.role_assignments === null) {
    throw new Error('invalid_role_assignments');
  }

  const result = await attachTradingFlow(
    { pool: app.deps.pg, createPolicyVersion, assignPolicy },
    {
      orgId: auth.principal.orgId,
      flow: args.flow as CompiledTradingFlow,
      roleAssignments: args.role_assignments as Record<string, string>,
    },
  );
  return { role_assignments: result.roleAssignments };
}

async function revokeAgentTool(app: FastifyInstance, request: FastifyRequest, args: Record<string, unknown>) {
  const auth = await authForRoute(app, request, 'admin');
  if (!auth.ok) throw new Error(auth.reason);
  const agentId = requireString(args.agent_id, 'agent_id');

  const result = await revokeAgentDelegation(
    { pool: app.deps.pg, redis: app.deps.redis, suspendAgent, revokeDelegatedKey, revokeAgentInFlight },
    { agentId, orgId: auth.principal.orgId },
  );
  return {
    agent_id: agentId,
    agent_suspended: result.agentSuspended,
    aborted_decision_ids: result.abortedDecisionIds,
    committed_decision_ids: result.committedDecisionIds,
  };
}

async function policyCheckTool(
  app: FastifyInstance,
  deps: CasperGuardDeps | undefined,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const intent = normalizeCasperGuardIntent(args.intent);
  const { policy } = await import('../enforcement/policy-epoch-guard.js').then((m) =>
    m.resolveEffectivePolicy(app.deps.pg, app.deps.redis, {
      orgId: auth.orgId,
      agentId: auth.agentId,
    }),
  );

  const allowedNetworks = deps?.networks ?? [CASPER_X402_TESTNET_NETWORK];
  const allowedActions = allowedActionsFromRails(policy.spend.railPermission);
  const serviceScope = policy.spend.serviceScope;

  if (!allowedActions.includes(intent.kind)) {
    return { outcome: 'DENY', reason: 'action_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId };
  }
  if (!allowedNetworks.includes(intent.network)) {
    return { outcome: 'DENY', reason: 'network_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId, allowed_networks: allowedNetworks };
  }
  if (!serviceScope.includes(intent.resourceId)) {
    return { outcome: 'DENY', reason: 'service_not_allowed', agent_id: auth.agentId, policy_id: policy.policyId, allowed_resource_ids: serviceScope };
  }

  // Mirror the policy engine's action_kind_resource_mismatch check so dry-run catches it too.
  if (intent.kind === 'casper-deploy') {
    const r = intent.resourceId;
    if (r.startsWith('svc:') || r.startsWith('cspr.trade:')) {
      return {
        outcome: 'DENY',
        reason: 'action_kind_resource_mismatch',
        hint: 'svc:* and cspr.trade:* resource IDs require x402-payment or cspr-trade, not casper-deploy. Use casper_guard_authorize_payment for service calls.',
        agent_id: auth.agentId,
        policy_id: policy.policyId,
      };
    }
  }

  return {
    outcome: 'CHECK',
    agent_id: auth.agentId,
    action_kind: intent.kind,
    policy_epoch: policy.policyEpoch,
    policy_id: policy.policyId,
    allowed_networks: allowedNetworks,
    allowed_resource_ids: serviceScope,
  };
}

/**
 * Map an intent's network onto the Casper slot that must sign and settle it.
 *
 * Casper networks map to their own slot. EVM networks (evm:sepolia / evm:base-sepolia) have no
 * Casper slot of their own — they are user-broadcast rails where the Casper side only records and
 * anchors — so they resolve to the default (testnet) slot exactly as before this routing existed.
 */
export function slotNetworkForIntent(network: string): string | undefined {
  return network === 'casper:casper' || network === 'casper:casper-test' ? network : undefined;
}

/**
 * Trade-fill reporting for a settled cspr-trade decision.
 *
 * A settled swap proves the deploy executed. It does NOT prove what price was obtained: the venue
 * returns no post-execution fill, and this server does not (yet) decode CEP-18 transfer events out
 * of the deploy's execution effects. `min_received` is enforced at AUTHORIZATION time, against the
 * quote (policy.ts → verifyMinReceivedWithinSlippage) — it is not re-verified against the realized
 * output.
 *
 * Reporting an unverified number as the fill is the failure mode this block exists to prevent. So it
 * publishes the authorized floor and states plainly that the realized amount is unverified, rather
 * than echoing a pre-trade estimate in a field the caller would read as executed truth.
 */
function tradeFillDisclosure(decision: CasperGuardDecisionRecord): Record<string, unknown> {
  if (decision.actionKind !== 'cspr-trade') return {};
  const intent = decision.intent;
  const minReceived = intent.kind === 'cspr-trade' ? intent.minReceived : null;
  return {
    fill: {
      amount_in: decision.amount,
      min_received_authorized: minReceived,
      executed_amount_out: null,
      executed_price: null,
      // Explicitly tri-state: not `false` (which would imply the floor was breached) and not `true`
      // (which would imply verification happened). Nothing on-chain has been read back.
      min_received_satisfied: null,
      verification: 'unverified',
      verification_reason:
        'Settlement confirms the swap deploy executed on-chain. The realized output amount is not read back from execution effects, so the executed price and the min_received floor are not verified post-trade. min_received was enforced pre-trade against the venue quote at authorization time.',
    },
  };
}

async function reconcileTool(
  app: FastifyInstance,
  deps: CasperGuardDeps,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  const auth = await requireAgent(app, authz, args.agent_id);
  const decisionId = requireString(args.decision_id, 'decision_id');
  // tx_hash is provided by the user after they broadcast their own transaction.
  // For casper-deploy and evm-transfer this is required — the user signs and sends from their wallet.
  const userTxHash = typeof args.tx_hash === 'string' && args.tx_hash.length > 0 ? args.tx_hash : null;

  const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
  if (!decision) throw new Error('casper_guard_decision_not_found');
  if (decision.agentId !== auth.agentId) throw new Error('casper_guard_decision_agent_mismatch');

  // User-signed settlement path — covers evm-transfer (ETH/ERC-20) only.
  // The user broadcast the tx from their own wallet and passes the tx_hash here.
  // casper-deploy is operator-executed: falls through to the normal FSM settlement reader path.
  // Platform role: record the hash, release the hold, anchor the decision proof to Casper.
  if (
    decision.outcome === 'ALLOW' &&
    decision.actionKind === 'evm-transfer' &&
    (decision.status === 'RESERVED' || decision.status === 'SIGNED') &&
    userTxHash
  ) {
    await markDecisionSettledByUser(app.deps.pg, { decisionId, txHash: userTxHash });
    await Promise.all([
      settleHold(app.deps.redis, auth.agentId, decisionId),
      settleCasperGuardHold(app.deps.pg, decisionId),
    ]);

    let anchorTxHash: string | null = null;
    let anchorStatus: AnchorStatus = 'not_configured';
    let anchorError: string | null = null;
    if (deps.anchorer) {
      const refreshed = await readCasperGuardDecision(app.deps.pg, decisionId);
      if (refreshed && refreshed.status === 'SETTLED') {
        const decisionHash = computeCasperGuardDecisionHash(refreshed);
        try {
          const { txHash } = await deps.anchorer.anchorDecision({ decisionId, decisionHash, decision: refreshed });
          anchorTxHash = txHash;
          anchorStatus = 'anchored';
        } catch (err) {
          // Anchoring failure is non-fatal — the decision IS settled either way. But it must never be
          // silent: a swallowed error here is indistinguishable from "anchoring was never configured",
          // which is exactly the ambiguity `anchor_status` exists to remove.
          anchorStatus = 'failed';
          anchorError = err instanceof Error ? err.message : String(err);
          console.error('casper_guard_anchor_failed', { decisionId, error: anchorError });
        }
      } else {
        anchorStatus = 'skipped_not_settled';
      }
    }

    void emitDecisionSafe(app.deps.redis, {
      paymentId: decisionId,
      agentId: decision.agentId,
      orgId: decision.orgId,
      outcome: 'SETTLED',
      holdStatus: 'SETTLED',
      txHash: userTxHash,
      railScheme: decision.actionKind,
      railChain: decision.network,
      resourceId: decision.resourceId,
      amount: decision.amount,
      ts: Date.now(),
    });

    return {
      decision_id: decisionId,
      status: 'SETTLED',
      settled: true,
      anchored: anchorTxHash !== null,
      anchor_status: anchorStatus,
      ...(anchorError ? { anchor_error: anchorError } : {}),
      tx_hash: userTxHash,
      deploy_hash: userTxHash,
      anchor_tx_hash: anchorTxHash,
    };
  }

  // evm-transfer requires the user to broadcast from their wallet and pass back the tx_hash.
  // casper-deploy is operator-executed — no user broadcast needed; falls through to normal settlement path.
  if (
    decision.outcome === 'ALLOW' &&
    decision.actionKind === 'evm-transfer' &&
    (decision.status === 'RESERVED' || decision.status === 'SIGNED') &&
    !userTxHash
  ) {
    return {
      decision_id: decisionId,
      status: 'AWAITING_USER_TX',
      settled: false,
      anchored: false,
      anchor_status: 'skipped_not_settled' satisfies AnchorStatus,
      tx_hash: null,
      message: `Broadcast the EVM transaction from your own wallet first, then call casper_guard_reconcile again with tx_hash set to the transaction hash you received.`,
    };
  }

  // x402-payment and cspr-trade go through the normal FSM settlement reader path.
  const settlementReader = deps.settlementReaderFactory
    ? composeSettlementReader(
        deps.settlementReaderFactory(),
        () => ({ status: 'pending', source: 'casper-rpc' as const, evidence: {} }),
      )
    : { read: async () => ({ status: 'pending' as const, source: 'casper-rpc' as const, evidence: {} }) };

  const result = await reconcileCasperGuardDecision(
    {
      pool: app.deps.pg,
      redis: app.deps.redis,
      settlementReader,
      ...(deps.anchorer ? { anchorer: deps.anchorer } : {}),
    },
    { decisionId, agentId: auth.agentId },
  );

  const finalDecision = await readCasperGuardDecision(app.deps.pg, decisionId);

  // Graceful failure surfacing: when a decision did not settle (FAILED_TERMINAL / EXPIRED),
  // the bare status is not actionable. The concrete reason was recorded on the reconciliation
  // attempt that produced the failure (settlement-reader → reconcile-worker:100-108), as
  // errorCode + evidence. Pull the latest such attempt so the caller sees *why* it failed
  // (e.g. facilitator_settle_failed: insufficient balance, execution_error, header_decode_failed)
  // instead of an opaque FAILED_TERMINAL.
  const failureAttempt =
    result.status !== 'SETTLED'
      ? [...(finalDecision?.reconciliationAttempts ?? [])]
          .filter((a) => a.status === 'failed')
          .sort((a, b) => b.attemptNumber - a.attemptNumber)[0]
      : undefined;

  return {
    decision_id: result.decisionId,
    status: result.status,
    settled: result.settled,
    anchored: result.anchored,
    // Why the decision is or is not anchored — distinguishes "no Odra contract bound" from a failed
    // anchor attempt from "already anchored by an earlier reconcile". A bare `anchored: false` cannot.
    anchor_status: result.anchorStatus,
    ...(result.anchorError ? { anchor_error: result.anchorError } : {}),
    tx_hash: finalDecision?.txHash ?? null,
    deploy_hash: finalDecision?.deployHash ?? null,
    anchor_tx_hash: finalDecision?.auditAnchors?.find((a) => a.status === 'confirmed')?.txHash ?? null,
    ...(finalDecision ? tradeFillDisclosure(finalDecision) : {}),
    ...(failureAttempt
      ? {
          failure_reason: failureAttempt.errorCode ?? 'unknown',
          failure_source: failureAttempt.source,
          failure_evidence: failureAttempt.evidence,
        }
      : {}),
  };
}

async function requireAgent(app: FastifyInstance, authz: string | undefined, requestedAgentId: unknown) {
  const auth = await authenticateAgent(app.deps.pg, authz);
  if (!auth.ok) throw new Error(auth.reason);
  const agentId = requireString(requestedAgentId, 'agent_id');
  if (auth.agent.agentId !== agentId) throw new Error('tenant_mismatch');
  return auth.agent;
}

async function readTenantDecision(
  app: FastifyInstance,
  orgId: string,
  decisionId: string,
): Promise<CasperGuardDecisionRecord> {
  const decision = await readCasperGuardDecision(app.deps.pg, decisionId);
  if (!decision || decision.orgId !== orgId) throw new Error('decision_not_found');
  return decision;
}

/**
 * Read-only CSPR.trade market-data passthrough.
 *
 * Authenticates the agent (so calls are attributable and tenant-fenced) but creates NO decision and
 * NO hold — nothing is spent and nothing is signed. The allowlist inside callCsprTradeReadOnly is
 * what keeps this from becoming a way around authorize_action: an agent can read any quote it likes,
 * but cannot reach build_swap or submit_transaction through this path.
 *
 * The venue's response is returned verbatim under `data`. Guard does not reshape market data — it
 * decides whether the call is allowed, not what the market says.
 */
async function tradeDataTool(
  app: FastifyInstance,
  deps: CasperGuardDeps | undefined,
  authz: string | undefined,
  args: Record<string, unknown>,
) {
  await requireAgent(app, authz, args.agent_id);
  const toolName = requireString(args.tool, 'tool');
  const network =
    args.network === 'casper:casper' || args.network === 'casper:casper-test'
      ? args.network
      : 'casper:casper-test';

  const mcpUrl = deps?.tradeDataUrls?.[network];
  if (!mcpUrl) {
    return {
      ok: false,
      error: 'trade_venue_not_configured',
      network,
      detail: `No CSPR.trade venue is configured for ${network}.`,
    };
  }

  if (!isCsprTradeReadOnlyTool(toolName)) {
    return {
      ok: false,
      error: 'cspr_trade_tool_not_permitted',
      tool: toolName,
      detail:
        'Only read-only market-data tools are available here. Executing a swap requires casper_guard_authorize_action followed by casper_guard_reconcile.',
      permitted_tools: [...CSPR_TRADE_READ_ONLY_TOOLS],
    };
  }

  const toolArgs =
    args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : {};

  try {
    const data = await callCsprTradeReadOnly(mcpUrl, toolName, toolArgs);
    return { ok: true, network, tool: toolName, data };
  } catch (err) {
    // Venue errors are reported, never masked as empty data — a caller must be able to tell
    // "the venue said no" apart from "there is no liquidity".
    return {
      ok: false,
      error: 'cspr_trade_read_failed',
      network,
      tool: toolName,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function listServicesTool() {
  return {
    network: 'casper:casper-test',
    payment_header: 'PAYMENT-SIGNATURE',
    payment_flow: [
      '1. Call casper_guard_list_services (this tool) to find the service URL and resource_id.',
      '2. Hit the service endpoint WITHOUT any payment header — it returns HTTP 402 with a payment_required body.',
      '3. Pass that payment_required body to casper_guard_authorize_payment to get the signed PAYMENT-SIGNATURE header.',
      '4. Retry the service endpoint with the header: { "payment-signature": "<value>" } and optionally { "x-guard-decision-id": "<decision_id>" }.',
    ],
    services: [
      {
        name: 'Order Book Depth',
        resource_id: 'svc:order-book',
        method: 'GET',
        url: 'https://casper-agopsservice-production.up.railway.app/order-book/depth',
        query_params: [{ name: 'pair', description: 'Trading pair on Casper testnet, e.g. CSPR-USDC. NOTE: USDT does not exist on Casper testnet — use USDC or CSPR.', required: false, default: 'CSPR-USDC' }],
        price_cspr: 2,
        price_motes: '2000000000',
        description: 'Returns live order book depth (bids/asks) for a CSPR trading pair, including mid price, spread, and 24h volume. Available pairs: CSPR-USDC. Do NOT use USDT — it is not deployed on Casper testnet.',
      },
      {
        name: 'Risk Oracle Score',
        resource_id: 'svc:risk-oracle',
        method: 'POST',
        url: 'https://casper-agopsservice-production.up.railway.app/risk-oracle/score',
        body_schema: {
          pair: { type: 'string', description: 'Trading pair on Casper testnet, e.g. CSPR-USDC. Do NOT use USDT — it is not deployed on Casper testnet.', required: true },
          side: { type: 'string', enum: ['buy', 'sell'], required: true },
          size_motes: { type: 'string', description: 'Order size in motes (positive integer string)', required: true },
        },
        price_cspr: 3,
        price_motes: '3000000000',
        description: 'Scores the market risk of a proposed trade. Returns risk_score (0-100), label (low/medium/high), max_safe_size_motes, and reason. Use pair CSPR-USDC (not CSPR-USDT).',
      },
      {
        name: 'Trade Log Publish',
        resource_id: 'svc:trade-log-publish',
        method: 'POST',
        url: 'https://casper-agopsservice-production.up.railway.app/trade-log/publish',
        price_cspr: 1,
        price_motes: '1000000000',
        description: 'Publish a trade execution record to the shared trade log.',
      },
      {
        name: 'Trade Log Read',
        resource_id: 'svc:trade-log-read',
        method: 'GET',
        url: 'https://casper-agopsservice-production.up.railway.app/trade-log/trades',
        price_cspr: 0,
        price_motes: '0',
        description: 'Read recent trades from the shared trade log. Free — no payment required.',
      },
    ],
  };
}

async function legalContextTool(args: Record<string, unknown>) {
  const resourceId = requireString(args.resource_id, 'resource_id');
  const minTrustLevel =
    typeof args.min_trust_level === 'number' &&
    [1, 2, 3, 4].includes(args.min_trust_level)
      ? (args.min_trust_level as 1 | 2 | 3 | 4)
      : null;

  const result = await lcpDiscover(resourceId);

  if (!result.ok) {
    return { ok: false, reason: result.reason, resource_id: resourceId };
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

function decisionStatus(decision: CasperGuardDecisionRecord) {
  return {
    decision_id: decision.decisionId,
    outcome: decision.outcome,
    status: decision.status,
    reason_code: decision.reasonCode,
    action_kind: decision.actionKind,
    network: decision.network,
    amount: decision.amount,
    hold: decision.hold
      ? { hold_id: decision.hold.holdId, status: decision.hold.status, amount: decision.hold.amount }
      : null,
  };
}

function requiresSigner(name: string): boolean {
  return name === 'casper_guard_authorize_payment' || name === 'casper_guard_authorize_action';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid_${field}`);
  return value;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

// MCP spec: tools/call responses must wrap output in content[].text, not as bare result fields.
// Clients (Claude Code, mcp-remote) parse result.content[0].text — a bare result object is ignored.
function rpcToolResult(id: string | number | null | undefined, data: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] },
  };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
