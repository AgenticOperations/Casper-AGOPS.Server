/**
 * Casper node RPC helper — queries account transfers to find an inbound CSPR transfer
 * whose numeric `id` (memo field) matches a deposit reference.
 *
 * Uses `chain_get_block_transfers` on recent blocks or `state_get_account_info` to derive
 * the latest block, then walks backward a configurable number of blocks looking for a match.
 *
 * Casper transfer wire shape (info_get_deploy execution result transforms):
 *   { deploy_hash, from, to, amount, id, gas }
 *
 * `id` is the uint64 memo the sender sets via --transfer-id in casper-client or the
 * SDK's TransferDeployItem. We match on (to == operatorAccountHash) AND (id == refId).
 *
 * Amount is in motes (1 CSPR = 1_000_000_000 motes). We store and credit in motes (base units).
 */

export interface CasperTransferMatch {
  found: true;
  deployHash: string;
  fromAccountHash: string;
  amount: bigint;
}

export interface CasperTransferMiss {
  found: false;
  reason: 'not_found' | 'rpc_error';
}

export type CasperTransferResult = CasperTransferMatch | CasperTransferMiss;

export interface TransferReader {
  findTransferByRefId(params: {
    operatorAccountHash: string;
    refId: bigint;
    /** How many of the most-recent blocks to scan. Default 100 (~10 min at 6s/block). */
    blockDepth?: number;
  }): Promise<CasperTransferResult>;
}

interface RpcTransfer {
  deploy_hash?: string;
  from?: string;
  to?: string;
  amount?: string;
  id?: number | string | null;
}

interface RpcBlockTransfersResult {
  transfers?: RpcTransfer[];
}

interface RpcBlockResult {
  block?: {
    hash?: string;
    header?: { height?: number };
  };
  block_with_signatures?: {
    block?: {
      hash?: string;
      header?: { height?: number };
    };
  };
}

/**
 * Build a live TransferReader backed by the Casper node JSON-RPC.
 * Scans the most recent `blockDepth` blocks for a transfer matching (to, id).
 */
export function createLiveTransferReader(cfg: { rpcUrl: string }): TransferReader {
  const { rpcUrl } = cfg;

  async function rpc<T>(method: string, params: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error) return null;
    return body.result ?? null;
  }

  async function getLatestBlockHeight(): Promise<number | null> {
    const result = await rpc<RpcBlockResult>('chain_get_block', {});
    if (!result) return null;
    // Casper 1.x: result.block.header.height; Casper 2.x: result.block_with_signatures.block.header.height
    return (
      result.block?.header?.height ??
      result.block_with_signatures?.block?.header?.height ??
      null
    );
  }

  async function getTransfersAtHeight(height: number): Promise<RpcTransfer[]> {
    const result = await rpc<RpcBlockTransfersResult>('chain_get_block_transfers', {
      block_identifier: { Height: height },
    });
    return result?.transfers ?? [];
  }

  return {
    async findTransferByRefId({ operatorAccountHash, refId, blockDepth = 100 }) {
      const latestHeight = await getLatestBlockHeight();
      if (latestHeight === null) {
        return { found: false, reason: 'rpc_error' };
      }

      // Normalize operator account hash: strip any leading "account-hash-" prefix, lowercase.
      const normalizedOperator = operatorAccountHash
        .replace(/^account-hash-/i, '')
        .toLowerCase();

      const startHeight = Math.max(0, latestHeight - blockDepth + 1);

      // Scan from newest to oldest — most recent deposit is most likely.
      for (let h = latestHeight; h >= startHeight; h--) {
        const transfers = await getTransfersAtHeight(h);
        for (const t of transfers) {
          if (!t.deploy_hash || !t.to || t.id == null) continue;

          const toNorm = t.to.replace(/^account-hash-/i, '').toLowerCase();
          const transferId = BigInt(t.id);

          if (toNorm === normalizedOperator && transferId === refId) {
            return {
              found: true,
              deployHash: t.deploy_hash,
              fromAccountHash: t.from ?? '',
              amount: BigInt(t.amount ?? '0'),
            };
          }
        }
      }

      return { found: false, reason: 'not_found' };
    },
  };
}

/** Stub for tests / when RPC URL is not configured. Always returns not_found. */
export function createStubTransferReader(): TransferReader {
  return {
    // Must stay async to satisfy TransferReader; the live implementation awaits an RPC call.
    // eslint-disable-next-line @typescript-eslint/require-await
    async findTransferByRefId() {
      return { found: false, reason: 'not_found' };
    },
  };
}
