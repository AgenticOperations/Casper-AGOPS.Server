import { describe, it, expect } from 'vitest';
import {
  resolvePassport,
  type IdentityRegistryReader,
} from '../../src/engines/identity/passport.js';

/**
 * E7 ERC-8004 passport read-side (engine-specs-FINAL.md:226; logical↔on-chain identity decouple,
 * engine-specs-FINAL.md:75). Resolving a passport binds a P1 logical node to its on-chain ERC-8004
 * Identity Registry entry. It is READ-SIDE: it never blocks or alters a payment, so a registry read
 * that returns null or throws degrades discovery only and resolves to `{ registered: false }` —
 * never an exception into a caller, never a payment effect.
 */

const AGENT = 'agt_alpha';
const ADDR = '0x1111111111111111111111111111111111111111';
const PASSPORT = 'erc8004:1:0x8004A818BFB912233c491871b3d84c89A494BD9e:42';

/** A reader bound to one address → PASSPORT, everything else unregistered. */
function readerBound(): IdentityRegistryReader {
  return { resolvePassportId: (a) => Promise.resolve(a === ADDR ? PASSPORT : null) };
}

describe('resolvePassport — E7 ERC-8004 passport read-side', () => {
  it('returns the passport id when the on-chain identity is registered', async () => {
    const r = await resolvePassport(readerBound(), { agentId: AGENT, onChainAddress: ADDR });
    expect(r).toEqual({ registered: true, agentId: AGENT, passportId: PASSPORT });
  });

  it('returns unregistered (not an error) when the address has no on-chain identity', async () => {
    const r = await resolvePassport(readerBound(), {
      agentId: AGENT,
      onChainAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(r).toEqual({ registered: false, agentId: AGENT });
  });

  it('fails soft to unregistered when the registry read THROWS (read-side never propagates)', async () => {
    const throwing: IdentityRegistryReader = {
      resolvePassportId: () => Promise.reject(new Error('rpc down')),
    };
    const r = await resolvePassport(throwing, { agentId: AGENT, onChainAddress: ADDR });
    expect(r).toEqual({ registered: false, agentId: AGENT });
  });

  it('treats an empty/whitespace passport id as unregistered', async () => {
    const blank: IdentityRegistryReader = { resolvePassportId: () => Promise.resolve('   ') };
    const r = await resolvePassport(blank, { agentId: AGENT, onChainAddress: ADDR });
    expect(r).toEqual({ registered: false, agentId: AGENT });
  });
});
