/**
 * Casper node RPC helper — reads an account's current CSPR balance via `query_balance`.
 * Used by treasury balance reporting (Casper-native replacement for Circle's getBalances).
 */

export type CasperBalanceResult =
  | { ok: true; motes: bigint }
  | { ok: false; reason: 'rpc_error' };

export async function queryCasperAccountBalance(params: {
  rpcUrl: string;
  accountHash: string;
}): Promise<CasperBalanceResult> {
  try {
    const rawHash = params.accountHash.startsWith('00')
      ? params.accountHash.slice(2)
      : params.accountHash;
    const res = await fetch(params.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query_balance',
        params: {
          purse_identifier: { main_purse_under_account_hash: `account-hash-${rawHash}` },
        },
      }),
    });
    if (!res.ok) return { ok: false, reason: 'rpc_error' };
    const body = (await res.json()) as { result?: { balance?: string }; error?: unknown };
    if (body.error || typeof body.result?.balance !== 'string') {
      return { ok: false, reason: 'rpc_error' };
    }
    return { ok: true, motes: BigInt(body.result.balance) };
  } catch {
    return { ok: false, reason: 'rpc_error' };
  }
}
