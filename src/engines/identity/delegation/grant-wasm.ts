/**
 * WASM loader for the delegation session contracts (D-2). The grant-init endpoint serves these
 * bytes to the browser/SDK for signing — the server itself signs NOTHING and touches no key
 * material. Bytes are read once at module load and cached.
 *
 * Path is resolved from import.meta.url so it works under tsx (dev, reading src/) AND compiled
 * dist/ (scripts/copy-wasm.mjs mirrors the .wasm files into dist next to this module's .js).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wasmDir = fileURLToPath(new URL('./wasm/', import.meta.url));

const grantWasm = new Uint8Array(readFileSync(`${wasmDir}grant-delegated-key.wasm`));
const revokeWasm = new Uint8Array(readFileSync(`${wasmDir}revoke-delegated-key.wasm`));

const grantB64 = Buffer.from(grantWasm).toString('base64');
const revokeB64 = Buffer.from(revokeWasm).toString('base64');

export function loadGrantWasm(): Uint8Array {
  return grantWasm;
}

export function loadRevokeWasm(): Uint8Array {
  return revokeWasm;
}

export function grantWasmBase64(): string {
  return grantB64;
}

export function revokeWasmBase64(): string {
  return revokeB64;
}
