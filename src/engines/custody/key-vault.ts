import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const importRuntime = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier) as Promise<unknown>;

type CasperSdkKeys = {
  PrivateKey: {
    generate(algorithm: unknown): { toPem(): string; publicKey: { toHex(): string }; sign(msg: Uint8Array): Uint8Array };
    fromPem(pem: string, algorithm: unknown): { publicKey: { toHex(): string }; sign(msg: Uint8Array): Uint8Array };
  };
  KeyAlgorithm: { ED25519: unknown };
};

/**
 * Per-agent delegated-key vault (D-3). Private key material is decrypted in-memory only for the
 * duration of a sign call — signWith/rotate/revoke are the only surface; no method returns raw
 * private key bytes or PEM.
 */
export interface KeyVault {
  generateKeypair(agentId: string): Promise<{ publicKey: string }>;
  store(agentId: string, privateKeyPem: string): Promise<void>;
  signWith(agentId: string, message: Uint8Array): Promise<Uint8Array>;
  rotate(agentId: string): Promise<{ publicKey: string }>;
  revoke(agentId: string): Promise<void>;
}

/** Injectable ciphertext blob store — in-memory for tests, Postgres-backed in deployment. */
export interface VaultBlobStore {
  get(agentId: string): Promise<string | null>;
  set(agentId: string, blob: string): Promise<void>;
  delete(agentId: string): Promise<void>;
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/** EncryptedStoreVault (D-3, finals backend): AES-256-GCM at rest, free — no paid KMS. */
export class EncryptedStoreVault implements KeyVault {
  private readonly key: Buffer;
  private readonly blobStore: VaultBlobStore;

  constructor(config: { masterSecretHex: string; store: VaultBlobStore }) {
    // Derive a 32-byte AES key from the master secret via scrypt — the master secret itself is
    // never used directly as key material.
    this.key = scryptSync(config.masterSecretHex, 'agentops-key-vault', 32);
    this.blobStore = config.store;
  }

  async generateKeypair(agentId: string): Promise<{ publicKey: string }> {
    const sdk = (await importRuntime('casper-js-sdk')) as CasperSdkKeys;
    const privateKey = sdk.PrivateKey.generate(sdk.KeyAlgorithm.ED25519);
    await this.store(agentId, privateKey.toPem());
    return { publicKey: privateKey.publicKey.toHex() };
  }

  async store(agentId: string, privateKeyPem: string): Promise<void> {
    await this.blobStore.set(agentId, this.encrypt(privateKeyPem));
  }

  async signWith(agentId: string, message: Uint8Array): Promise<Uint8Array> {
    const pem = await this.loadPem(agentId);
    const sdk = (await importRuntime('casper-js-sdk')) as CasperSdkKeys;
    const privateKey = sdk.PrivateKey.fromPem(pem, sdk.KeyAlgorithm.ED25519);
    return privateKey.sign(message);
  }

  async rotate(agentId: string): Promise<{ publicKey: string }> {
    return this.generateKeypair(agentId);
  }

  async revoke(agentId: string): Promise<void> {
    await this.blobStore.delete(agentId);
  }

  private async loadPem(agentId: string): Promise<string> {
    const blob = await this.blobStore.get(agentId);
    if (!blob) {
      throw new Error(`No delegated key stored for agent ${agentId}`);
    }
    return this.decrypt(blob);
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), ciphertext.toString('base64'), authTag.toString('base64')].join('.');
  }

  private decrypt(blob: string): string {
    const [ivB64, ciphertextB64, authTagB64] = blob.split('.');
    if (!ivB64 || !ciphertextB64 || !authTagB64) {
      throw new Error('Malformed vault ciphertext blob');
    }
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}

/** KmsVault (documented production future-scope) — NOT built for finals; every call throws. */
export class KmsVault implements KeyVault {
  private unavailable(): never {
    throw new Error('KmsVault is not configured — production future-scope, not built for finals');
  }

  async generateKeypair(_agentId: string): Promise<{ publicKey: string }> {
    this.unavailable();
  }

  async store(_agentId: string, _privateKeyPem: string): Promise<void> {
    this.unavailable();
  }

  async signWith(_agentId: string, _message: Uint8Array): Promise<Uint8Array> {
    this.unavailable();
  }

  async rotate(_agentId: string): Promise<{ publicKey: string }> {
    this.unavailable();
  }

  async revoke(_agentId: string): Promise<void> {
    this.unavailable();
  }
}
