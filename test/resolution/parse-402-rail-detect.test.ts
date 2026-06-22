import { describe, it, expect } from 'vitest';
import { parse402 } from '../../src/engines/resolution/parse-402.js';
import { ResolutionError, type Raw402Body, type RequestContext } from '../../src/engines/resolution/types.js';

/**
 * E2 Resolution (engine-specs-FINAL.md:96-115, policy-engine-FINAL.md:98-114). The 402 is parsed
 * SERVER-SIDE into one signable quote: rail detect by `accepts.extra.name`, resource bound from the
 * x402-spec `accepts.resource` field, dual-rail validBefore, and fail-closed on anything malformed,
 * unknown, or missing the contract needed to build a safe signing payload. Pure — no container runtime.
 */

const NOW = 1_750_000_000; // fixed Unix seconds; this test never reads the clock
const CIRCLE_NANO_VALIDITY = 3 * 24 * 60 * 60;

const ctx: RequestContext = { method: 'GET', url: 'https://api.vendor.test/v1/forecast?city=oslo' };

function circleNanoBody(): Raw402Body {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'arc-testnet',
        maxAmountRequired: '2500000', // 2.5 USDC
        resource: 'https://api.vendor.test/v1/forecast',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 60,
        asset: '0x2222222222222222222222222222222222222222',
        extra: {
          name: 'GatewayWalletBatched',
          version: '1',
          verifyingContract: '0x3333333333333333333333333333333333333333',
        },
      },
    ],
  };
}

function rawX402Body(): Raw402Body {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'arc-testnet',
        maxAmountRequired: '1000000', // 1 USDC
        resource: 'https://api.vendor.test/v1/forecast',
        payTo: '0x4444444444444444444444444444444444444444',
        maxTimeoutSeconds: 600,
        asset: '0x5555555555555555555555555555555555555555', // the USDC token = verifyingContract
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
}

describe('parse402 — server-side 402 → quote + rail detect', () => {
  it('classifies a GatewayWalletBatched accept as circle-nano with a 3-day validBefore', () => {
    const q = parse402(circleNanoBody(), ctx, NOW);
    expect(q.rail).toEqual({ scheme: 'circle-nano', chain: 'arc' });
    expect(q.validBefore).toBe(NOW + CIRCLE_NANO_VALIDITY);
    expect(q.amount).toBe(2_500_000n);
    expect(q.asset).toBe('USDC');
    expect(q.destination).toBe('0x1111111111111111111111111111111111111111');
    expect(q.resourceId).toBe('https://api.vendor.test/v1/forecast');
    // circle-nano signs against the Gateway contract from extra, never the token.
    expect(q.verifyingContract).toBe('0x3333333333333333333333333333333333333333');
    // the x402 wire scheme/network are echoed verbatim for the re-submitted X-PAYMENT envelope.
    expect(q.x402Scheme).toBe('exact');
    expect(q.x402Network).toBe('arc-testnet');
  });

  it('classifies a non-Gateway accept as raw-x402 with validBefore = now + maxTimeoutSeconds', () => {
    const q = parse402(rawX402Body(), ctx, NOW);
    expect(q.rail).toEqual({ scheme: 'raw-x402', chain: 'arc' });
    expect(q.validBefore).toBe(NOW + 600);
    expect(q.amount).toBe(1_000_000n);
    // raw x402 signs against the token itself (domain resolved via the EIP-5267 ladder at sign).
    expect(q.verifyingContract).toBe('0x5555555555555555555555555555555555555555');
    // the vendor host is captured for the E7 Domain Binding Verifier (BUG-17), from request_context.url.
    expect(q.originHost).toBe('api.vendor.test');
  });

  it('detects the solana chain from the accepts.network for a raw-x402 rail', () => {
    const body = rawX402Body();
    body.accepts[0]!.network = 'solana-devnet';
    const q = parse402(body, ctx, NOW);
    expect(q.rail).toEqual({ scheme: 'raw-x402', chain: 'solana' });
    // chain is our internal routing classification; the wire network is still echoed verbatim.
    expect(q.x402Network).toBe('solana-devnet');
  });

  it('falls back to canonical(method+host+path) when accepts.resource is absent', () => {
    const body = rawX402Body();
    delete body.accepts[0]!.resource;
    const q = parse402(body, ctx, NOW);
    expect(q.resourceId).toBe('GET api.vendor.test/v1/forecast');
  });

  it('uses the default raw-x402 timeout when maxTimeoutSeconds is absent', () => {
    const body = rawX402Body();
    delete body.accepts[0]!.maxTimeoutSeconds;
    const q = parse402(body, ctx, NOW);
    expect(q.validBefore).toBe(NOW + 300);
  });

  it('rejects (fail-closed) an empty accepts array', () => {
    expect(() => parse402({ accepts: [] }, ctx, NOW)).toThrow(ResolutionError);
    try {
      parse402({ accepts: [] }, ctx, NOW);
    } catch (e) {
      expect((e as ResolutionError).code).toBe('malformed_accepts');
    }
  });

  it('rejects a circle-nano accept missing extra.verifyingContract (cannot sign safely)', () => {
    const body = circleNanoBody();
    delete body.accepts[0]!.extra!.verifyingContract;
    try {
      parse402(body, ctx, NOW);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ResolutionError).code).toBe('unsupported_token');
    }
  });

  it('rejects a raw-x402 accept missing the token asset (no verifyingContract)', () => {
    const body = rawX402Body();
    delete body.accepts[0]!.asset;
    try {
      parse402(body, ctx, NOW);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ResolutionError).code).toBe('unsupported_token');
    }
  });

  it('rejects a missing pay-to destination', () => {
    const body = rawX402Body();
    // @ts-expect-error exercising the malformed-input guard
    delete body.accepts[0]!.payTo;
    try {
      parse402(body, ctx, NOW);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ResolutionError).code).toBe('missing_destination');
    }
  });

  it('rejects a non-integer amount', () => {
    const body = rawX402Body();
    body.accepts[0]!.maxAmountRequired = '1.5';
    try {
      parse402(body, ctx, NOW);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ResolutionError).code).toBe('invalid_amount');
    }
  });

  it('rejects a non-positive maxTimeoutSeconds (fail-closed; no already-expired authorization)', () => {
    for (const bad of [0, -1, 1.5]) {
      const body = rawX402Body();
      body.accepts[0]!.maxTimeoutSeconds = bad;
      try {
        parse402(body, ctx, NOW);
        expect.unreachable(`should have thrown for maxTimeoutSeconds=${bad}`);
      } catch (e) {
        expect((e as ResolutionError).code).toBe('invalid_timeout');
      }
    }
  });
});
