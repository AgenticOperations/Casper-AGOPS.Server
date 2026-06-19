import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Identifier minting + agent API-key hashing for Engine 1 (Control).
 *
 * Two credential classes exist and never mix on the hot path (doc 03 §9; the authorize
 * path rejects `sk_`):
 *  - `ag_live_…`  per-agent bearer token presented to POST /v1/payment/authorize
 *  - `sk_live_…`  org admin session key — used for the admin surface only
 *
 * We persist only the SHA-256 hash of a key; the plaintext is shown once at issue and
 * never stored. Verification is constant-time. The token is high-entropy (192 bits), so a
 * fast hash plus a timing-safe compare is the correct primitive here, not a password KDF.
 */

const ID_BYTES = 16; // 128-bit surrogate id body
const KEY_BYTES = 24; // 192-bit secret body

function body(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function newOrgId(): string {
  return `org_${body(ID_BYTES)}`;
}
export function newAgentId(): string {
  return `agt_${body(ID_BYTES)}`;
}
export function newTeamId(): string {
  return `team_${body(ID_BYTES)}`;
}
export function newPolicyId(): string {
  return `policy_${body(ID_BYTES)}`;
}
export function newAssignmentId(): string {
  return `pa_${body(ID_BYTES)}`;
}
export function newPaymentId(): string {
  return `pay_${body(ID_BYTES)}`;
}
export function newCasperGuardDecisionId(): string {
  return `cgd_${body(ID_BYTES)}`;
}
export function newCasperGuardHoldId(): string {
  return `cgh_${body(ID_BYTES)}`;
}
export function newCasperGuardAnchorId(): string {
  return `cga_${body(ID_BYTES)}`;
}
export function newUserId(): string {
  return `usr_${body(ID_BYTES)}`;
}
export function newSessionId(): string {
  return `sess_${body(ID_BYTES)}`;
}
export function newMembershipId(): string {
  return `mem_${body(ID_BYTES)}`;
}
export function newApiKeyId(): string {
  return `ak_${body(ID_BYTES)}`;
}
export function newOAuthAccountId(): string {
  return `oa_${body(ID_BYTES)}`;
}
export function newTokenRowId(): string {
  return `tok_${body(ID_BYTES)}`;
}

export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedKey {
  /** Shown once at issue, never persisted. */
  token: string;
  /** Persisted; the only durable form of the credential. */
  hash: string;
}

export function issueAgentApiKey(): IssuedKey {
  const token = `ag_live_${body(KEY_BYTES)}`;
  return { token, hash: hashApiKey(token) };
}

export function issueAdminKey(): IssuedKey {
  const token = `sk_live_${body(KEY_BYTES)}`;
  return { token, hash: hashApiKey(token) };
}

/**
 * A 256-bit opaque secret (session token, email-verify / reset link token). The plaintext is delivered
 * once (cookie or link); only its sha256 hash is persisted — same posture as the sk_/ag_ keys.
 */
export function issueOpaqueToken(): IssuedKey {
  const token = body(32); // 256-bit
  return { token, hash: hashApiKey(token) };
}

/** Constant-time verification of a presented token against a stored hash. */
export function verifyApiKey(token: string, storedHash: string): boolean {
  const computed = hashApiKey(token);
  if (computed.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}
