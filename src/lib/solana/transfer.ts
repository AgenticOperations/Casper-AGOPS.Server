import type { UsdcBaseUnits } from '../../contracts/index.js';

/**
 * Solana SPL-USDC transfer-authorization signing — a DESIGNED-FOR seam (doc 04 §3 M2).
 *
 * The dual-rail architecture supports Solana, but live SPL signing is Phase-2. This is an
 * explicit, typed boundary that throws on use, so the seam stays visible and is never mistaken
 * for a working path or a silent stub. The shape mirrors the EVM authorization so wiring it
 * later is a swap, not a redesign.
 */

export class SolanaSeamNotImplemented extends Error {
  constructor() {
    super(
      'phase2_not_implemented: Solana SPL transfer-authorization signing is a designed-for seam',
    );
    this.name = 'SolanaSeamNotImplemented';
  }
}

export interface SplTransferAuthorizationParams {
  /** base58 agent-float address */
  agentFloatAddress: string;
  /** base58 destination */
  destination: string;
  amount: UsdcBaseUnits;
  /** Unix seconds */
  validBefore: number;
}

export function signSplTransferAuthorization(_params: SplTransferAuthorizationParams): never {
  throw new SolanaSeamNotImplemented();
}
