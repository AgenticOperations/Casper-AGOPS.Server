export * from './mcp.js';

/**
 * @agops-labs/sdk — thin REST client for the AgentOps proxy (Phase 2 Milestone F.3, D-4).
 *
 * Two credential kinds, matching the server's existing auth model (no new auth mechanism, D-4③):
 *   - sk_ operator/admin key: createAgent, attachTradingFlow, revokeAgent, getDecision.
 *   - ag_ agent key: authorize (x402-payment via authorize-x402, everything else via authorize-action).
 * One client instance uses ONE apiKey — construct separate clients for operator vs. agent calls,
 * matching how the server scopes each route today.
 */

export interface AgentOpsClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CreateAgentInput {
  name: string;
  teamId?: string;
}

export interface CreateAgentResult {
  agent: { id: string; name: string; org_id: string; status: string };
  api_key: string;
}

export interface AttachTradingFlowInput {
  orgId: string;
  flow: unknown; // CompiledTradingFlow (server-defined shape) — kept opaque here to avoid a server import
  roleAssignments: Record<string, string>;
}

export interface AttachTradingFlowResult {
  role_assignments: Record<string, { agentId: string; policyId: string }>;
}

export interface RevokeAgentInput {
  agentId: string;
}

export interface RevokeAgentResult {
  agent_id: string;
  agent_suspended: boolean;
  aborted_decision_ids: string[];
  committed_decision_ids: string[];
}

export interface DecisionStatus {
  decision_id: string;
  outcome: 'ALLOW' | 'DENY';
  status: string;
  [key: string]: unknown;
}

export type AuthorizeInput =
  | {
      kind: 'x402-payment';
      agentId: string;
      idempotencyKey: string;
      paymentRequired: unknown;
    }
  | {
      kind: 'action';
      agentId: string;
      idempotencyKey: string;
      intent: unknown;
    };

export type AuthorizeResult =
  | { mode: 'async'; decisionId: string }
  | ({ mode: 'sync' } & Record<string, unknown>);

export interface AgentOpsClient {
  createAgent(input: CreateAgentInput): Promise<CreateAgentResult>;
  attachTradingFlow(input: AttachTradingFlowInput): Promise<AttachTradingFlowResult>;
  revokeAgent(input: RevokeAgentInput): Promise<RevokeAgentResult>;
  getDecision(decisionId: string): Promise<DecisionStatus>;
  /** Sync by default (D-4④): returns the ALLOW/DENY body directly. Pass { async: true } to get
   * just a pollable decisionId immediately instead — poll it via getDecision(). */
  authorize(input: AuthorizeInput, opts?: { async?: boolean }): Promise<AuthorizeResult>;
}

export function createAgentOpsClient(config: AgentOpsClientConfig): AgentOpsClient {
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const res = await fetchImpl(`${config.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return (await res.json()) as T;
  }

  return {
    async createAgent(input) {
      return request<CreateAgentResult>('/v1/agents', {
        method: 'POST',
        body: { name: input.name, ...(input.teamId ? { team_id: input.teamId } : {}) },
      });
    },

    async attachTradingFlow(input) {
      return request<AttachTradingFlowResult>(`/v1/orgs/${input.orgId}/trading-flows/attach`, {
        method: 'POST',
        body: { flow: input.flow, role_assignments: input.roleAssignments },
      });
    },

    async revokeAgent(input) {
      return request<RevokeAgentResult>(`/v1/agents/${input.agentId}/revoke-delegation`, {
        method: 'POST',
      });
    },

    async getDecision(decisionId) {
      return request<DecisionStatus>(`/v1/casper-guard/decisions/${decisionId}/status`, {
        method: 'GET',
      });
    },

    async authorize(input, opts) {
      const path = input.kind === 'x402-payment' ? '/v1/casper-guard/authorize-x402' : '/v1/casper-guard/authorize-action';
      const body =
        input.kind === 'x402-payment'
          ? { agent_id: input.agentId, idempotency_key: input.idempotencyKey, payment_required: input.paymentRequired }
          : { agent_id: input.agentId, idempotency_key: input.idempotencyKey, intent: input.intent };

      const raw = await request<Record<string, unknown>>(path, { method: 'POST', body });

      if (opts?.async) {
        return { mode: 'async', decisionId: raw.decision_id as string };
      }
      return { mode: 'sync', ...raw };
    },
  };
}
