import { describe, it, expect, beforeAll } from 'vitest';
import {
  createArcPublicClient,
  viemTokenDomainSource,
  viemNonceReconciler,
  type ArcPublicClient,
} from '../../src/lib/arc/client.js';
import { generateNonce } from '../../src/lib/eip712/eip3009.js';

/**
 * L8 live wiring smoke — verifies the two transport-bound read seams against a real Arc testnet RPC:
 * the EIP-5267 `eip712Domain()` read (so the USDC domain is resolved dynamically, never hardcoded)
 * and the EIP-3009 `authorizationState()` read (so EXPIRY_CHECK can confirm nonce consumption).
 *
 * CREDS-GATED: skips (and logs the skip) unless ARC_LIVE_RPC_URL + ARC_LIVE_USDC_ADDRESS are set, so
 * it never reads as covered in CI. The full funded broadcast → settle end-to-end (a signed X-PAYMENT
 * relayed on-chain, then reconciled to SETTLED) needs a funded float wallet + a relayer and is
 * exercised by the M9 demo e2e — flag before running.
 */

const RPC_URL = process.env.ARC_LIVE_RPC_URL;
const USDC = process.env.ARC_LIVE_USDC_ADDRESS as `0x${string}` | undefined;
const LIVE = Boolean(RPC_URL && USDC);

let client: ArcPublicClient | undefined;

beforeAll(() => {
  if (!LIVE) {
    // eslint-disable-next-line no-console
    console.warn(
      '[live-settle-arc-testnet] SKIPPED — set ARC_LIVE_RPC_URL + ARC_LIVE_USDC_ADDRESS (funded Arc testnet creds) to run the live read-seam smoke.',
    );
    return;
  }
  client = createArcPublicClient(RPC_URL!);
});

describe('Arc testnet live read seams (creds-gated)', () => {
  it('reads the live USDC EIP-712 domain via eip712Domain() (dynamic, not hardcoded)', async ({
    skip,
  }) => {
    if (!LIVE || !client || !USDC) return skip();
    const domain = await viemTokenDomainSource(client).readEip712Domain({ address: USDC });
    expect(domain).not.toBeNull();
    expect(domain?.name).toBeTruthy();
    expect(domain?.version).toBeTruthy();
    expect(domain?.verifyingContract.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('reads live nonce state via authorizationState(); a fresh nonce is unconsumed', async ({
    skip,
  }) => {
    if (!LIVE || !client || !USDC) return skip();
    const consumed = await viemNonceReconciler(client).wasNonceConsumed({
      token: USDC,
      authorizer: '0x0000000000000000000000000000000000000001',
      nonce: generateNonce(),
    });
    expect(consumed).toBe(false);
  });
});
