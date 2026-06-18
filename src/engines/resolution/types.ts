/**
 * Wire shapes for the agent-submitted 402 (E2 input) and the resolver's fail-closed error.
 *
 * These mirror the x402 `402 PAYMENT-REQUIRED` body. They are UNTRUSTED — the agent submits
 * `raw_402_body` verbatim to the Oracle, so every field is validated and nothing in here is a trust
 * input on its own (engine-specs-FINAL.md:296: agent-asserted values are audit-only). The parser
 * (`parse-402.ts`) turns one entry into a typed {@link import('../../contracts/index.js').Quote}.
 */

/** One offered payment rail in the 402 `accepts[]` array (x402 spec). */
export interface Raw402Accept {
  /** x402 scheme, e.g. "exact". */
  scheme: string;
  /** Network hint, e.g. "arc-testnet" / "solana-devnet"; used only for chain detection. */
  network?: string;
  /** Amount in token base units, as a decimal integer string (never a float). */
  maxAmountRequired: string;
  /** The x402-spec resource identifier; the GRANT-STATE claim key. Falls back to method+host+path. */
  resource?: string;
  /** Vendor pay-to address. */
  payTo: string;
  /** Seconds the authorization stays valid (raw x402 validBefore = now + this). */
  maxTimeoutSeconds?: number;
  /** Token contract address — the raw-x402 verifyingContract. */
  asset?: string;
  /** Rail-specific extras. circle-nano carries the Gateway domain name + verifyingContract here. */
  extra?: {
    name?: string;
    version?: string;
    verifyingContract?: string;
  };
}

export interface Raw402Body {
  x402Version?: number;
  accepts: Raw402Accept[];
  error?: string;
}

/** The agent-asserted call context; used only for the resource_id fallback + the audit log. */
export interface RequestContext {
  method: string;
  url: string;
}

export type ResolutionErrorCode =
  | 'malformed_accepts'
  | 'unknown_rail'
  | 'unsupported_token'
  | 'missing_destination'
  | 'invalid_amount'
  | 'invalid_timeout';

/** Fail-closed resolver error: no quote means no spend (engine-specs-FINAL.md:307,111). */
export class ResolutionError extends Error {
  constructor(
    public readonly code: ResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResolutionError';
  }
}
