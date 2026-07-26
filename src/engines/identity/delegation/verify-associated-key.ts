/**
 * Task 5 — the on-chain verifier for the master-signed grant deploy.
 *
 * GLOBAL RULE "NO BLIND PROMOTE": a returned deploy hash is NOT proof of execution. The verifier
 * MUST read on-chain state — (1) the deploy/transaction executed successfully AND (2) the agent
 * account hash is an associated key at weight 1 on the master account — before the route promotes.
 *
 * The verifier is an injectable seam so tests do NO network I/O (they inject the stub).
 */

export interface AssociatedKeyVerifyInput {
  masterAccountHash: string; // bare hex (no "account-hash-" prefix)
  agentAccountHash: string; // bare hex
  deployHash: string; // 64 hex
  rpcUrl: string;
}

export type AssociatedKeyVerifyResult =
  | { ok: true; weight: number }
  | { ok: false; reason: 'not_finalized_yet' | 'deploy_failed' | 'key_not_associated' | 'rpc_error' };

export interface AssociatedKeyVerifier {
  verify(input: AssociatedKeyVerifyInput): Promise<AssociatedKeyVerifyResult>;
}

/** Test seam: returns exactly the given result, no network. */
export function createStubAssociatedKeyVerifier(result: AssociatedKeyVerifyResult): AssociatedKeyVerifier {
  // AssociatedKeyVerifier is async because the live verifier awaits a JSON-RPC call.
  // eslint-disable-next-line @typescript-eslint/require-await
  return { verify: async () => result };
}

/**
 * Live verifier over plain fetch JSON-RPC (mirrors the proven pattern in treasury-routes.ts).
 * Defensive throughout: any fetch/RPC throw or unrecognized shape → { ok:false, reason:'rpc_error' }.
 * Never throws.
 */
export function createLiveAssociatedKeyVerifier(): AssociatedKeyVerifier {
  return {
    async verify(input: AssociatedKeyVerifyInput): Promise<AssociatedKeyVerifyResult> {
      const { rpcUrl, deployHash, masterAccountHash, agentAccountHash } = input;

      const rpcPost = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!res.ok) throw new Error('rpc_error');
        return (await res.json()) as Record<string, unknown>;
      };

      // --- Step 1: confirm execution success ---
      let succeeded: boolean | null = null; // true=Success, false=Failure, null=not yet
      try {
        // Casper 2.0 path: info_get_transaction
        const txBody = (await rpcPost('info_get_transaction', {
          transaction_hash: { Version1: deployHash },
        })) as {
          result?: {
            execution_info?: {
              execution_result?: { Version2?: { error_message?: string | null } };
            };
          };
          error?: { code?: number };
        };

        if (txBody.error) throw new Error('try_deploy');

        const execInfo = txBody.result?.execution_info;
        if (!execInfo) return { ok: false, reason: 'not_finalized_yet' };
        const v2 = execInfo.execution_result?.Version2;
        if (!v2) return { ok: false, reason: 'not_finalized_yet' };
        succeeded = v2.error_message == null;
      } catch (e) {
        if ((e as Error).message !== 'try_deploy') return { ok: false, reason: 'rpc_error' };

        // info_get_deploy — the grant is submitted as a 1.x Deploy, but a Casper 2.0 node returns
        // the deploy's result under `execution_info.execution_result.Version2` (same shape as
        // info_get_transaction), NOT the legacy `execution_results[]` array. Handle BOTH: the 2.0
        // execution_info shape first, then the pre-2.0 array for older nodes.
        try {
          const deployBody = (await rpcPost('info_get_deploy', { deploy_hash: deployHash })) as {
            result?: {
              execution_info?: {
                execution_result?: { Version2?: { error_message?: string | null }; Version1?: unknown };
              };
              execution_results?: Array<{ result?: { Success?: unknown; Failure?: unknown } }>;
            };
          };

          // Casper 2.0 shape: execution_info.execution_result.Version2 (matches info_get_transaction).
          const execInfo = deployBody.result?.execution_info;
          if (execInfo) {
            const v2 = execInfo.execution_result?.Version2;
            if (!v2) return { ok: false, reason: 'not_finalized_yet' };
            succeeded = v2.error_message == null;
          } else {
            // Pre-2.0 shape: execution_results[] array.
            const execs = deployBody.result?.execution_results ?? [];
            if (execs.length === 0) return { ok: false, reason: 'not_finalized_yet' };
            succeeded = !!execs[0]?.result?.Success;
          }
        } catch {
          return { ok: false, reason: 'rpc_error' };
        }
      }

      if (!succeeded) return { ok: false, reason: 'deploy_failed' };

      // --- Step 2: state assertion — the agent account hash must be an associated key at weight 1
      // on the master account. Read the master account's associated_keys from global state. ---
      try {
        const stateBody = (await rpcPost('query_global_state', {
          state_identifier: null, // latest
          key: `account-hash-${masterAccountHash}`,
          path: [],
        })) as {
          result?: {
            stored_value?: {
              Account?: { associated_keys?: Array<{ account_hash?: string; weight?: number }> };
            };
          };
          error?: unknown;
        };

        const keys = stateBody.result?.stored_value?.Account?.associated_keys;
        if (!Array.isArray(keys)) return { ok: false, reason: 'rpc_error' };

        const target = `account-hash-${agentAccountHash}`.toLowerCase();
        const match = keys.find((k) => {
          const ah = (k.account_hash ?? '').toLowerCase();
          return ah === target || ah === agentAccountHash.toLowerCase();
        });

        if (!match || match.weight !== 1) return { ok: false, reason: 'key_not_associated' };
        return { ok: true, weight: 1 };
      } catch {
        return { ok: false, reason: 'rpc_error' };
      }
    },
  };
}
