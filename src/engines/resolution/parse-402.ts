import type { Quote, Rail } from '../../contracts/index.js';
import {
  ResolutionError,
  type Raw402Accept,
  type Raw402Body,
  type RequestContext,
} from './types.js';

/**
 * E2 Resolution — turn an intercepted 402 into one concrete, signable quote
 * (engine-specs-FINAL.md:96-115, policy-engine-FINAL.md:98-114). This is a pure transform: it
 * assembles the facts P3 will judge, makes NO policy decision, and moves NO money. Fail-closed
 * everywhere — a malformed/ambiguous accept, an unknown rail, or a missing contract yields no quote
 * (engine-specs-FINAL.md:111,307), so an authorize on a bad 402 can never reach signing.
 *
 * Rail detect (policy-engine-FINAL.md:98-100): `accepts.extra.name == "GatewayWalletBatched"` →
 * circle-nano, else raw x402. Only enumerated rails are signable. The `401 + WWW-Authenticate:Payment`
 * MPP branch stays dormant (not handled here).
 */

const CIRCLE_NANO_DOMAIN_NAME = 'GatewayWalletBatched';
/**
 * Fixed circle-nano authorization validity (policy-engine-FINAL.md:207). Phase-1 signs every Gateway
 * authorization with this window and does NOT consult the server-advertised maxTimeoutSeconds for
 * circle-nano (that is a raw-x402 field); dynamic Gateway-window negotiation is a designed-for seam.
 */
const CIRCLE_NANO_VALIDITY_SECONDS = 3 * 24 * 60 * 60;
/**
 * SILENT-SPEC fallback (policy-engine-FINAL.md:201 — "VALUE UNCONFIRMED, spike before lock"): used
 * only when a raw-x402 accept omits maxTimeoutSeconds. 300s is a sane default; the live value is
 * confirmed against the rail before mainnet lock.
 */
const DEFAULT_RAW_X402_TIMEOUT_SECONDS = 300;

/** Phase-1 is Arc; a network string naming Solana selects the (designed-for) SPL rail seam. */
function detectChain(network: string | undefined): 'arc' | 'solana' {
  return network?.toLowerCase().includes('solana') ? 'solana' : 'arc';
}

/** Vendor host for the E7 Domain Binding Verifier (BUG-17). Empty string on an unparseable URL → fail-closed. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

/** Fallback resource_id when `accepts.resource` is absent: canonical(method + host + path). */
function canonicalResource(ctx: RequestContext): string {
  const method = ctx.method.toUpperCase();
  try {
    const u = new URL(ctx.url);
    return `${method} ${u.host}${u.pathname}`;
  } catch {
    return `${method} ${ctx.url}`;
  }
}

function parseAmount(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ResolutionError(
      'invalid_amount',
      `maxAmountRequired must be a base-unit integer string, got ${String(raw)}`,
    );
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new ResolutionError('invalid_amount', 'maxAmountRequired must be greater than zero');
  }
  return value;
}

/**
 * Resolve the raw-x402 authorization validity. A missing value falls back to the spec default; a
 * present value must be a positive integer — a negative/zero/huge/fractional timeout would yield an
 * already-expired or absurd validBefore. Fail-closed: a malformed timeout means no quote.
 */
function resolveTimeout(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_RAW_X402_TIMEOUT_SECONDS;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new ResolutionError(
      'invalid_timeout',
      `maxTimeoutSeconds must be a positive integer, got ${String(raw)}`,
    );
  }
  return raw;
}

export function parse402(body: Raw402Body, ctx: RequestContext, nowSeconds: number): Quote {
  const accepts = body?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new ResolutionError('malformed_accepts', 'no accepts[] offered in the 402 body');
  }
  // First offered rail. Selecting among multiple accepts by RailPermission is a later refinement;
  // P3-A still rejects a quote whose rail the policy forbids, so this is safe, not silent-permit.
  const accept: Raw402Accept | undefined = accepts[0];
  if (!accept || typeof accept !== 'object') {
    throw new ResolutionError('malformed_accepts', 'accepts[0] is not an object');
  }

  const amount = parseAmount(accept.maxAmountRequired);

  const destination = accept.payTo;
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new ResolutionError('missing_destination', 'accepts[0].payTo is required');
  }

  const resourceId =
    typeof accept.resource === 'string' && accept.resource.length > 0
      ? accept.resource
      : canonicalResource(ctx);

  let rail: Rail;
  let verifyingContract: string;
  let validBefore: number;

  if (accept.extra?.name === CIRCLE_NANO_DOMAIN_NAME) {
    // circle-nano: signs against the Gateway contract from extra; domain is the protocol constant.
    const gateway = accept.extra.verifyingContract;
    if (typeof gateway !== 'string' || gateway.length === 0) {
      throw new ResolutionError(
        'unsupported_token',
        'circle-nano requires accepts.extra.verifyingContract',
      );
    }
    rail = { scheme: 'circle-nano', chain: 'arc' };
    verifyingContract = gateway;
    validBefore = nowSeconds + CIRCLE_NANO_VALIDITY_SECONDS;
  } else {
    // raw x402: verifyingContract is the token itself; its domain is resolved via the EIP-5267
    // ladder at sign time (agent-asserted extra.name/version is NOT trusted for the domain).
    const token = accept.asset;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ResolutionError(
        'unsupported_token',
        'raw-x402 requires accepts.asset (the token address)',
      );
    }
    rail = { scheme: 'raw-x402', chain: detectChain(accept.network) };
    verifyingContract = token;
    validBefore = nowSeconds + resolveTimeout(accept.maxTimeoutSeconds);
  }

  // The x402 wire scheme/network are echoed verbatim — they are what the server advertised and what
  // the agent must re-submit; we never reconstruct them from the internal rail.
  return {
    resourceId,
    amount,
    asset: 'USDC',
    rail,
    destination,
    verifyingContract,
    x402Scheme: accept.scheme,
    x402Network: accept.network ?? '',
    originHost: hostOf(ctx.url),
    validBefore,
  };
}
