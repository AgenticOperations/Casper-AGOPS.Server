export const CASPER_NETWORK_HEADER = 'x-agentops-network';
export type CasperScopedNetwork = 'casper:casper-test' | 'casper:casper';
const VALID: readonly CasperScopedNetwork[] = ['casper:casper-test', 'casper:casper'];

/**
 * Resolve the request's Casper network from the x-agentops-network header value.
 * Absent → testnet default (preserves all existing testnet callers). Unknown/array → rejected.
 */
export function resolveRequestNetwork(
  headerValue: string | string[] | undefined,
): { ok: true; network: CasperScopedNetwork } | { ok: false } {
  if (headerValue === undefined) return { ok: true, network: 'casper:casper-test' };
  if (typeof headerValue !== 'string') return { ok: false };
  if ((VALID as readonly string[]).includes(headerValue)) {
    return { ok: true, network: headerValue as CasperScopedNetwork };
  }
  return { ok: false };
}
