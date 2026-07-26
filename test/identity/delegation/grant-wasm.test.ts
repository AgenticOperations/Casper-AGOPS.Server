import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  loadGrantWasm,
  loadRevokeWasm,
  grantWasmBase64,
  revokeWasmBase64,
} from '../../../src/engines/identity/delegation/grant-wasm.js';
import { accountHashFromPublicKeyHex } from '../../../src/engines/identity/delegation/associated-keys.js';

const GRANT_SHA = 'd57786c8f9503190231d4c99261e56d61e631fa566fede9e8d974350551bce44';
const REVOKE_SHA = 'b4452a15b43bf19aba6ecda400191cd44f12f80b96ab0e2ca043f67c1282d089';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('grant-wasm loader (pure, no docker)', () => {
  it('loadGrantWasm() returns non-empty bytes with the pinned sha256', () => {
    const wasm = loadGrantWasm();
    expect(wasm).toBeInstanceOf(Uint8Array);
    expect(wasm.length).toBeGreaterThan(0);
    expect(sha256(wasm)).toBe(GRANT_SHA);
  });

  it('loadRevokeWasm() returns non-empty bytes with the pinned sha256', () => {
    const wasm = loadRevokeWasm();
    expect(wasm).toBeInstanceOf(Uint8Array);
    expect(wasm.length).toBeGreaterThan(0);
    expect(sha256(wasm)).toBe(REVOKE_SHA);
  });

  it('base64 accessors decode back to the pinned sha256', () => {
    expect(sha256(Buffer.from(grantWasmBase64(), 'base64'))).toBe(GRANT_SHA);
    expect(sha256(Buffer.from(revokeWasmBase64(), 'base64'))).toBe(REVOKE_SHA);
  });
});

describe('accountHashFromPublicKeyHex pins the SDK method chain', () => {
  it('derives the known account hash for a known secp256k1 public key', () => {
    const pubkey = '0202f5a92ab6da536e7b1a351406f3744d27d7f92e5ae0c38911a03ba9edde30c179';
    const expected = 'eee1fe0bd6eabd51ef0828d43b429969ef237c214cdd2c8f32d7f36fcc7d811d';
    expect(accountHashFromPublicKeyHex(pubkey)).toBe(expected);
  });
});
