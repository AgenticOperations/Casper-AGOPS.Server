import type {
  CasperGuardSettlementRead,
  CasperGuardSettlementReader,
} from '../../engines/casper-guard/reconcile-worker.js';
import type { CasperGuardDecisionRecord } from '../../engines/casper-guard/store.js';
import type { CasperFacilitator } from './facilitator.js';

/** On-chain finality for a single deploy/tx, normalized away from RPC wire shapes. */
export interface DeployFinality {
  found: boolean;
  finalized?: boolean;
  success?: boolean;
  txHash?: string | null;
  error?: string | null;
}

/** Injectable port — the live impl (createLiveDeployReader) hits the node RPC; tests inject a fake. */
export interface DeployReader {
  getDeploy(hash: string): Promise<DeployFinality>;
}

/**
 * Reads settlement finality for a Casper Guard decision off-chain via the node RPC.
 *
 * Fail-closed: an unreadable / not-yet-finalized / not-found deploy is `pending`, never `settled`.
 * Expiry is NOT decided here — the reconcile FSM owns expiry (markCasperGuardDecisionExpiryCheck),
 * and the decision record exposes no absolute deadline to this reader.
 */
export function createCasperRpcSettlementReader(port: DeployReader): CasperGuardSettlementReader {
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      const hash = decision.deployHash ?? decision.txHash;
      const source = 'casper-rpc' as const;
      // No hash to chase yet: the agent has not broadcast — pending, never settled.
      if (!hash) {
        return { status: 'pending', source, evidence: { reason: 'no_deploy_hash' }, errorCode: null };
      }

      const fin = await port.getDeploy(hash);
      if (!fin.found) {
        return { status: 'pending', source, evidence: { hash, reason: 'not_found_yet' }, errorCode: null };
      }
      if (!fin.finalized) {
        return { status: 'pending', source, evidence: { hash, reason: 'not_finalized' }, errorCode: null };
      }
      if (fin.success) {
        return {
          status: 'settled',
          source,
          evidence: { hash },
          txHash: fin.txHash ?? hash,
          deployHash: decision.deployHash ?? null,
        };
      }
      return {
        status: 'failed',
        source,
        evidence: { hash, error: fin.error ?? 'execution_error' },
        errorCode: 'execution_error',
      };
    },
  };
}

/**
 * Live DeployReader backed by the Casper node JSON-RPC (`info_get_deploy`).
 *
 * Normalizes the wire `execution_results[].result` ({ Success } | { Failure }) into {@link DeployFinality}.
 * Network/HTTP failures fail-closed to `found: false` → the reader reports `pending` (never `settled`).
 */
export function createLiveDeployReader(cfg: { rpcUrl: string }): DeployReader {
  return {
    async getDeploy(hash: string): Promise<DeployFinality> {
      const cleaned = hash.startsWith('0x') ? hash.slice(2) : hash;
      let res: Response;
      try {
        res = await fetch(cfg.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info_get_deploy', params: { deploy_hash: cleaned } }),
        });
      } catch {
        return { found: false };
      }
      if (!res.ok) return { found: false };
      const body = (await res.json()) as { result?: { execution_results?: unknown[] } };
      const execs = body.result?.execution_results ?? [];
      // A deploy known to the node but not yet executed reports an empty execution_results array.
      if (execs.length === 0) return { found: true, finalized: false, success: false };
      const result =
        (execs[0] as { result?: { Success?: unknown; Failure?: { error_message?: string } } }).result ?? {};
      if ('Success' in result && result.Success) {
        return { found: true, finalized: true, success: true, txHash: cleaned };
      }
      const error = (result as { Failure?: { error_message?: string } }).Failure?.error_message ?? 'execution_error';
      return { found: true, finalized: true, success: false, error };
    },
  };
}

/**
 * Settlement reader for x402-payment decisions that calls the hosted CSPR.cloud facilitator
 * (POST /settle) to submit the transfer_from on-chain, then delegates finality polling to the
 * existing RPC reader.
 *
 * Decision routing:
 * - deploy/tx hash already set → skip facilitator, delegate to RPC reader (idempotent)
 * - actionKind !== 'x402-payment' → skip facilitator, delegate to RPC reader
 * - no hash + x402 → call facilitator.settle(), return result with deployHash
 */
export function createFacilitatorSettlementReader(
  facilitator: CasperFacilitator,
  deployReader: DeployReader,
): CasperGuardSettlementReader {
  const rpcReader = createCasperRpcSettlementReader(deployReader);
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      // Already has a hash — facilitator already ran or operator submitted manually. Poll RPC.
      if (decision.deployHash ?? decision.txHash) {
        return rpcReader.read(decision);
      }
      // Non-x402 actions (casper-deploy, cspr-trade) settle via RPC or operator-wallet, not facilitator.
      if (decision.actionKind !== 'x402-payment') {
        return rpcReader.read(decision);
      }

      // x402 with no hash: call facilitator to submit transfer_from on-chain.
      let result: Awaited<ReturnType<CasperFacilitator['settle']>>;
      try {
        const intent = decision.intent as Record<string, unknown>;
        result = await facilitator.settle({ payload: intent, requirements: intent });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason },
          errorCode: 'facilitator_error',
        };
      }

      if (!result.success) {
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason: result.reason ?? 'unknown' },
          errorCode: result.reason ?? 'facilitator_settle_failed',
        };
      }

      // Facilitator submitted on-chain. Return settled with the deploy hash so the reconcile
      // worker's settleSignedDecision() can write it to the DB.
      return {
        status: 'settled',
        source: 'facilitator',
        evidence: { facilitator_tx: result.txHash },
        deployHash: result.txHash ?? null,
        txHash: result.txHash ?? null,
      };
    },
  };
}

/**
 * Compose a live reader with an operator-supplied body fallback (non-breaking).
 *
 * The live result wins when it is conclusive (settled / failed / expired). A still-`pending` or
 * `ambiguous` live read defers to the operator-supplied body so manual reconcile keeps working.
 */
export function composeSettlementReader(
  live: CasperGuardSettlementReader,
  bodyFallback: () => CasperGuardSettlementRead,
): CasperGuardSettlementReader {
  return {
    async read(decision) {
      const r = await live.read(decision);
      if (r.status === 'pending' || r.status === 'ambiguous') return bodyFallback();
      return r;
    },
  };
}
