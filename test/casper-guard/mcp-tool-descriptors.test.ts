import { describe, it, expect } from 'vitest';
import { TOOL_DESCRIPTORS } from '../../src/engines/casper-guard/mcp.js';

describe('TOOL_DESCRIPTORS (F.2 — fleet-management tools, Docker-independent unit check)', () => {
  it('includes the three new fleet-management tools with valid object schemas', () => {
    const byName = Object.fromEntries(TOOL_DESCRIPTORS.map((t) => [t.name, t]));

    for (const name of ['casper_guard_create_agent', 'casper_guard_attach_trading_flow', 'casper_guard_revoke_agent']) {
      expect(byName[name]).toBeDefined();
      expect(byName[name]!.inputSchema.type).toBe('object');
      expect(typeof byName[name]!.description).toBe('string');
      expect(byName[name]!.description.length).toBeGreaterThan(0);
    }
  });

  it('does not duplicate or reorder the existing agent-facing tools', () => {
    const names = TOOL_DESCRIPTORS.map((t) => t.name);
    expect(names.slice(0, 8)).toEqual([
      'casper_guard_policy_check',
      'casper_guard_authorize_payment',
      'casper_guard_authorize_action',
      'casper_guard_decision_status',
      'casper_guard_audit_export',
      'casper_guard_reconcile',
      'casper_guard_legal_context',
      'casper_guard_list_services',
    ]);
  });
});
