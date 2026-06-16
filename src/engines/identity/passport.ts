import type { AgentId } from '../../contracts/index.js';

/**
 * E7 ERC-8004 passport read-side (engine-specs-FINAL.md:226). Binds a P1 logical node (an
 * {@link AgentId}) to its on-chain ERC-8004 Identity Registry entry — the "passport". Logical
 * identity is decoupled from on-chain identity (engine-specs-FINAL.md:75): a node can exist in P1
 * before it is registered on-chain, so "unregistered" is a normal, non-error outcome.
 *
 * This is the TRUST plane, fully decoupled from custody and from the payment hot path. Resolving a
 * passport NEVER blocks or alters a payment (engine-specs-FINAL.md:237-243); a registry read failure
 * degrades discovery quality only. So this function FAILS SOFT — a null, blank, or throwing read all
 * resolve to `{ registered: false }`; it never propagates an exception to its caller.
 *
 * The on-chain read sits behind the {@link IdentityRegistryReader} seam (mirroring the
 * `TokenDomainSource` / `NonceReconciler` pattern in `lib/arc/client.ts`), so the engine stays
 * Testcontainers-only and the viem-backed read is the sole creds-gated layer, wired in M9.
 */

export interface IdentityRegistryReader {
  /**
   * ERC-8004 Identity Registry read: the passport id bound to this on-chain identity address, or
   * null when the address is not registered. Read-only; may return null or throw on RPC failure —
   * the caller treats both as "unregistered" (fail-soft). Never used on the payment hot path.
   */
  resolvePassportId(onChainAddress: string): Promise<string | null>;
}

export type PassportResult =
  | { registered: true; agentId: AgentId; passportId: string }
  | { registered: false; agentId: AgentId };

export async function resolvePassport(
  reader: IdentityRegistryReader,
  params: { agentId: AgentId; onChainAddress: string },
): Promise<PassportResult> {
  const { agentId, onChainAddress } = params;

  let passportId: string | null;
  try {
    passportId = await reader.resolvePassportId(onChainAddress);
  } catch {
    return { registered: false, agentId }; // read-side: a read failure is never an error to the caller.
  }

  if (passportId === null || passportId.trim().length === 0) {
    return { registered: false, agentId };
  }
  return { registered: true, agentId, passportId };
}
