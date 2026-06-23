import type { GuardRegistryAnchorer } from '../../engines/casper-guard/reconcile-worker.js';

/** Injectable Casper deploy submitter — live impl uses casper-js-sdk; tests inject a fake. */
export interface CasperDeploySubmitter {
  submit(input: {
    packageHash: string;
    entryPoint: string;
    args: Record<string, string>;
  }): Promise<{ txHash: string }>;
}

export function createOdraGuardRegistryAnchorer(cfg: {
  packageHash: string;
  entryPoint: string;
  submitter: CasperDeploySubmitter;
}): GuardRegistryAnchorer {
  return {
    async anchorDecision({ decisionId, decisionHash }) {
      const { txHash } = await cfg.submitter.submit({
        packageHash: cfg.packageHash,
        entryPoint: cfg.entryPoint,
        args: { decision_id: decisionId, decision_hash: decisionHash },
      });
      return { txHash };
    },
  };
}
