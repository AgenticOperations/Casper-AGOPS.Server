import type { UsdcBaseUnits } from '../../contracts/index.js';

/**
 * THE single Circle Gateway wrapper (parent CLAUDE.md: every Circle call goes through one
 * wrapper, never a raw endpoint). All four operations route through the injected transport, so
 * there is exactly one network boundary to audit, mock, and rate-limit. Live Circle calls are
 * wired in M6 (Provisioning); M2 establishes the typed boundary the rest of custody builds on.
 *
 * Amounts cross the boundary as base-unit decimal strings (money is never a JS float).
 */

export interface GatewayTransport {
  request<T>(req: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<T>;
}

export interface GatewayBalance {
  /** Unified org balance, base units. */
  available: UsdcBaseUnits;
}

export interface GatewayOpResult {
  id: string;
}

export class GatewayClient {
  constructor(private readonly transport: GatewayTransport) {}

  getBalances(orgId: string): Promise<GatewayBalance> {
    return this.transport.request<GatewayBalance>({
      method: 'GET',
      path: `/v1/gateway/balances/${orgId}`,
    });
  }

  deposit(params: { orgId: string; amount: UsdcBaseUnits }): Promise<GatewayOpResult> {
    return this.transport.request<GatewayOpResult>({
      method: 'POST',
      path: '/v1/gateway/deposit',
      body: { orgId: params.orgId, amount: params.amount.toString() },
    });
  }

  /** Treasury → own-agent float (internal allocation; treasury signer role). */
  depositFor(params: {
    orgId: string;
    agentId: string;
    amount: UsdcBaseUnits;
  }): Promise<GatewayOpResult> {
    return this.transport.request<GatewayOpResult>({
      method: 'POST',
      path: '/v1/gateway/deposit-for',
      body: { orgId: params.orgId, agentId: params.agentId, amount: params.amount.toString() },
    });
  }

  withdraw(params: { orgId: string; amount: UsdcBaseUnits }): Promise<GatewayOpResult> {
    return this.transport.request<GatewayOpResult>({
      method: 'POST',
      path: '/v1/gateway/withdraw',
      body: { orgId: params.orgId, amount: params.amount.toString() },
    });
  }

  /** Agent-float → treasury reclaim (E5/L5 teardown, BUG-21) — the inverse of {@link depositFor}. The
   *  single Circle boundary owns this internal movement too. Phase-1 placeholder path like the other
   *  operations; reconciled to the live Circle Gateway endpoint at M9 (no real Circle endpoint invented). */
  reclaimFor(params: {
    orgId: string;
    agentId: string;
    amount: UsdcBaseUnits;
  }): Promise<GatewayOpResult> {
    return this.transport.request<GatewayOpResult>({
      method: 'POST',
      path: '/v1/gateway/reclaim-for',
      body: { orgId: params.orgId, agentId: params.agentId, amount: params.amount.toString() },
    });
  }

  /**
   * Operation finality for the two-phase float promotion (E5/L3, BUG-39/42). The single Circle
   * boundary owns this read too — there is no second transport. A depositFor's float is only promoted
   * `pending → confirmed` once the operation is `complete`; the caller treats any non-`complete` status
   * (or a thrown/timed-out read) as not-yet-final and never promotes on a blind timeout.
   */
  async isFinal(txRef: string): Promise<boolean> {
    const op = await this.transport.request<{ status: string }>({
      method: 'GET',
      path: `/v1/gateway/operations/${txRef}`,
    });
    return op.status === 'complete';
  }
}
