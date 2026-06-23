import type {
  CasperGuardSettlementRead,
  CasperGuardSettlementReader,
} from '../../engines/casper-guard/reconcile-worker.js';
import type { CasperGuardDecisionRecord } from '../../engines/casper-guard/store.js';

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
