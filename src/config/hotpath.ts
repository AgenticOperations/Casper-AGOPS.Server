import { privateKeyToAccount } from 'viem/accounts';
import type { HotPathDeps } from '../app.js';
import type { Env } from './env.js';
import { LocalKmsSigner } from '../lib/kms/signer.js';
import type { TokenDomainSource } from '../lib/eip712/domain.js';
import type { DomainRegistry } from '../engines/identity/domain-binding.js';
import { wellKnownDomainRegistry } from '../lib/identity/well-known-registry.js';
import { createArcPublicClient, viemTokenDomainSource } from '../lib/arc/client.js';

/**
 * Hot-path wiring for the booted server (M9). Without this, POST /v1/payment/authorize fails closed
 * with 503 (app.ts/authorize.ts). One LocalKmsSigner account per role. The USDC EIP-712 domain source is
 * ARC_LIVE-gated behind the SAME TokenDomainSource seam: ARC_LIVE='true' uses the viem-backed EIP-5267
 * live read (proven in M5, fails closed); otherwise the labeled local default — the known-correct USDC v2
 * constant — so the demo runs hermetically with no live chain. The demo vendor host is bound
 * deterministically (a real binding to the operator's demo vendor, not a bypass); every other host falls
 * through to the network-backed .well-known registry.
 */
export function buildHotPath(env: Env): HotPathDeps {
  const signer = new LocalKmsSigner({
    'agent-float': privateKeyToAccount(env.AGENT_FLOAT_PRIVATE_KEY as `0x${string}`),
    'treasury-allocation': privateKeyToAccount(env.TREASURY_PRIVATE_KEY as `0x${string}`),
  });

  // ARC_LIVE gates the EIP-712 domain source. ON → the viem-backed EIP-5267 live read (the production
  // swap proven in M5; fails closed to the registry / no-quote on a read miss). OFF (default) → the
  // labeled local DEFAULT: the known-correct USDC v2 constant, so the demo runs hermetically with no live
  // chain. Either way it is the SAME TokenDomainSource seam — no other hot-path behavior changes.
  const tokenDomainSource: TokenDomainSource =
    env.ARC_LIVE === 'true'
      ? viemTokenDomainSource(createArcPublicClient(env.ARC_RPC_URL))
      : {
          // Fallback constant name is "USDC" (NOT mainnet's "USD Coin") — verified against the Arc testnet
          // USDC on-chain DOMAIN_SEPARATOR: name="USDC",version="2" reproduces it exactly. "USD Coin" would
          // sign an invalid domain and the on-chain transferWithAuthorization would revert.
          readEip712Domain: ({ address }) =>
            Promise.resolve({ name: 'USDC', version: '2', chainId: BigInt(env.ARC_CHAIN_ID), verifyingContract: address }),
        };

  const network = wellKnownDomainRegistry();
  const domainRegistry: DomainRegistry = {
    resolvePaymentAddress: (host) =>
      host === env.DEMO_VENDOR_HOST
        ? Promise.resolve(env.DEMO_VENDOR_ADDRESS)
        : network.resolvePaymentAddress(host),
  };

  return { signer, tokenDomainSource, domainRegistry, chainId: env.ARC_CHAIN_ID };
}
