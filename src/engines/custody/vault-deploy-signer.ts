import type { KeyVault } from './key-vault.js';

const importRuntime = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier) as Promise<unknown>;

// ed25519 = 1, secp256k1 = 2 (casper-js-sdk PrivateKey.d.ts KeyAlgorithm values). The vault only
// generates ed25519 keys today (key-vault.ts), so this is fixed — widen if a vault algorithm
// choice is ever added.
const ED25519_ALGORITHM_TAG = 1;

type CasperSdkDeploySigning = {
  Deploy: {
    fromJSON(json: unknown): { hash: { toBytes(): Uint8Array }; toJSON(): unknown };
    setSignature(deploy: unknown, signature: Uint8Array, publicKey: unknown): unknown;
  };
  PublicKey: {
    fromHex(hex: string): unknown;
  };
};

/**
 * E.3: sign a CSPR.trade unsigned deploy JSON with an agent's DELEGATED key from the vault —
 * never a master/operator key. Casper-js-sdk's `Deploy.sign(key)` is synchronous and expects a
 * key object with a sync `signAndAddAlgorithmBytes`, which the vault (async decrypt-then-sign)
 * cannot satisfy directly. Instead: compute the raw signature over the deploy hash via the
 * vault's async signWith, then attach it through the confirmed `Deploy.setSignature(deploy,
 * signature, publicKey)` static — functionally identical to what `.sign()` does internally
 * (algorithm-tag byte + raw signature), just async-safe.
 */
export async function signDeployJsonWithVault(input: {
  vault: KeyVault;
  agentId: string;
  publicKeyHex: string;
  unsignedDeployJson: string;
}): Promise<string> {
  const sdk = (await importRuntime('casper-js-sdk')) as CasperSdkDeploySigning;

  const deploy = sdk.Deploy.fromJSON(JSON.parse(input.unsignedDeployJson));
  const rawSignature = await input.vault.signWith(input.agentId, deploy.hash.toBytes());

  const taggedSignature = new Uint8Array(1 + rawSignature.length);
  taggedSignature[0] = ED25519_ALGORITHM_TAG;
  taggedSignature.set(rawSignature, 1);

  const publicKey = sdk.PublicKey.fromHex(input.publicKeyHex);
  sdk.Deploy.setSignature(deploy, taggedSignature, publicKey);

  return JSON.stringify(deploy.toJSON());
}
