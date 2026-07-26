/**
 * On-chain readers for JIT agent funding (Task 3).
 *
 * NEW work (not a cspr.cloud reuse). Uses Casper node JSON-RPC directly:
 *   - `readAccountPurseExists`: `query_balance` with `main_purse_under_account_hash`. A "no main
 *     purse" / account-not-found RPC error means the account has never been funded → false. A
 *     successful balance → true. Mirrors the seam in balance-reader.ts:18-26.
 *   - `readWcsprBalance` / `readOperatorWcsprBalance`: read the WCSPR CEP-18 `balances` dictionary
 *     via `state_get_dictionary_item`. The dictionary item key is the base64 of the 33-byte
 *     account-hash Key (`00` tag + 32-byte hash) — confirmed empirically on testnet against the
 *     WCSPR contract's `balances` uref. Absent dictionary item → 0n (fresh account), never throws.
 *
 * The `fetchFn` seam is injectable so unit tests never hit the chain.
 */

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface OnChainReaders {
  readAccountPurseExists(accountHash: string): Promise<boolean>;
  readWcsprBalance(accountHash: string): Promise<bigint>;
  readOperatorWcsprBalance(): Promise<bigint>;
}

export interface OnChainReadersConfig {
  rpcUrl: string;
  wcsprPackageHash: string;
  operatorAccountHash: string;
  /** WCSPR `balances` dictionary seed uref (`uref-…-007`). Resolved once from the contract. */
  balancesUref: string;
  fetchFn?: FetchLike;
}

function stripPrefix(accountHash: string): string {
  return accountHash.startsWith('00') ? accountHash.slice(2) : accountHash;
}

/**
 * CEP-18 balances dictionary item key: base64 of the 33-byte account-hash Key
 * (0x00 tag byte + 32-byte raw account hash). Confirmed on testnet.
 */
export function balanceDictItemKey(accountHash: string): string {
  const raw = stripPrefix(accountHash);
  const bytes = Buffer.from('00' + raw, 'hex'); // 33 bytes: Key tag 0x00 (Account) + hash
  return bytes.toString('base64');
}

async function rpc(
  fetchFn: FetchLike,
  rpcUrl: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return { error: { message: 'http_error' } };
  return (await res.json()) as { result?: unknown; error?: unknown };
}

/**
 * Resolve the WCSPR `balances` dictionary seed uref from the contract package. Queries the latest
 * contract version's named keys via `query_global_state` (hash-prefixed key, Casper 2.0 legacy
 * Contract storage). Returns null if it cannot be resolved (funding then stays unconfigured).
 */
export async function resolveWcsprBalancesUref(input: {
  rpcUrl: string;
  packageHash: string;
  fetchFn?: FetchLike;
}): Promise<string | null> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const pkg = await rpc(fetchFn, input.rpcUrl, 'query_global_state', {
    state_identifier: null,
    key: `hash-${input.packageHash}`,
    path: [],
  });
  const versions = (
    pkg.result as
      | { stored_value?: { ContractPackage?: { versions?: { contract_hash: string }[] } } }
      | undefined
  )?.stored_value?.ContractPackage?.versions;
  const latestVersion = versions?.[versions.length - 1];
  if (!latestVersion) return null;
  const contractHex = latestVersion.contract_hash.replace(/^contract-/, ''); // "contract-<hex>" → hex

  const contract = await rpc(fetchFn, input.rpcUrl, 'query_global_state', {
    state_identifier: null,
    key: `hash-${contractHex}`,
    path: [],
  });
  const namedKeys = (
    contract.result as
      | { stored_value?: { Contract?: { named_keys?: { name: string; key: string }[] } } }
      | undefined
  )?.stored_value?.Contract?.named_keys;
  const balances = namedKeys?.find((n) => n.name === 'balances');
  return balances?.key ?? null;
}

export function createOnChainReaders(cfg: OnChainReadersConfig): OnChainReaders {
  const fetchFn = cfg.fetchFn ?? globalThis.fetch;

  async function readAccountPurseExists(accountHash: string): Promise<boolean> {
    const raw = stripPrefix(accountHash);
    const body = await rpc(fetchFn, cfg.rpcUrl, 'query_balance', {
      purse_identifier: { main_purse_under_account_hash: `account-hash-${raw}` },
    });
    // A successful balance means the main purse exists; any error (no main purse / not found)
    // means the account has never been funded — the clean purse-existence signal.
    const balance = (body.result as { balance?: string } | undefined)?.balance;
    return !body.error && typeof balance === 'string';
  }

  async function readBalanceForKey(accountHash: string): Promise<bigint> {
    const srhBody = await rpc(fetchFn, cfg.rpcUrl, 'chain_get_state_root_hash', []);
    const stateRootHash = (srhBody.result as { state_root_hash?: string } | undefined)?.state_root_hash;
    if (!stateRootHash) return 0n;

    const body = await rpc(fetchFn, cfg.rpcUrl, 'state_get_dictionary_item', {
      state_root_hash: stateRootHash,
      dictionary_identifier: {
        URef: {
          seed_uref: cfg.balancesUref,
          dictionary_item_key: balanceDictItemKey(accountHash),
        },
      },
    });
    if (body.error) return 0n; // absent dictionary item → fresh account, balance 0.
    const parsed = (body.result as { stored_value?: { CLValue?: { parsed?: string } } } | undefined)
      ?.stored_value?.CLValue?.parsed;
    if (parsed == null) return 0n;
    try {
      return BigInt(parsed);
    } catch {
      return 0n;
    }
  }

  return {
    readAccountPurseExists,
    readWcsprBalance: (accountHash: string) => readBalanceForKey(accountHash),
    readOperatorWcsprBalance: () => readBalanceForKey(cfg.operatorAccountHash),
  };
}
