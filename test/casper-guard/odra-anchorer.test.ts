import { describe, it, expect, vi } from 'vitest';
import { createOdraGuardRegistryAnchorer } from '../../src/lib/casper/odra-anchorer.js';
import type { CasperGuardDecisionRecord } from '../../src/engines/casper-guard/store.js';

const decision = { decisionId: 'cgd_9', orgId: 'org_1', agentId: 'agt_1' } as unknown as CasperGuardDecisionRecord;

describe('OdraGuardRegistryAnchorer', () => {
  it('submits anchor_decision with the id + hash and returns the tx hash', async () => {
    const submit = vi.fn().mockResolvedValue({ txHash: '0xanchored' });
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64),
      entryPoint: 'anchor_decision',
      submitter: { submit },
    });
    const res = await anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision });
    expect(res.txHash).toBe('0xanchored');
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        packageHash: 'd'.repeat(64),
        entryPoint: 'anchor_decision',
        args: { decision_id: 'cgd_9', decision_hash: 'sha256:abc' },
      }),
    );
  });

  it('throws when the submitter fails (so the anchor is marked failed upstream)', async () => {
    const anchorer = createOdraGuardRegistryAnchorer({
      packageHash: 'd'.repeat(64),
      entryPoint: 'anchor_decision',
      submitter: { submit: vi.fn().mockRejectedValue(new Error('node_unreachable')) },
    });
    await expect(
      anchorer.anchorDecision({ decisionId: 'cgd_9', decisionHash: 'sha256:abc', decision }),
    ).rejects.toThrow('node_unreachable');
  });
});
