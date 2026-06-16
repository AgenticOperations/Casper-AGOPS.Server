/**
 * RBAC matrix. Three roles; an sk_ machine key is mapped to KEY_ROLE='admin' (it can read + write +
 * manage keys/agents, but NOT manage members or delete the org — those need a human owner). The numeric
 * rank lets requireRole(min) be a single >= compare.
 *
 * Documented permission matrix (applied in P1c.5 route migration):
 *   member  — reads (summary, balances, agents, policy/reputation, monitoring decisions, reports)
 *   admin   — member + control-writes (treasury deposit/provision, policy dial, agent lifecycle,
 *             api-key issue/list/revoke, kill-switch + suspend)
 *   owner   — admin + member management (invite/role/remove) + delete-org
 */
export type Role = 'owner' | 'admin' | 'member';

export const ROLE_RANK: Readonly<Record<Role, number>> = { member: 0, admin: 1, owner: 2 };

/** The role an sk_ machine key acts as. Keys never manage members or delete an org. */
export const KEY_ROLE: Role = 'admin';

export function satisfiesRole(actual: Role, min: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}
