import {
  CASPER_X402_TESTNET_NETWORK,
  type CasperClientSigner,
  type CasperNetwork,
} from './x402.js';

const importRuntime = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier) as Promise<unknown>;

/**
 * casper-js-sdk `KeyAlgorithm` numeric values (PublicKey.d.ts): ED25519 = 1, SECP256K1 = 2. The Casper
 * signer must load the PEM with the SAME algorithm the key was generated under — a secp256k1 PEM loaded as
 * ed25519 (the library default) yields a wrong/invalid key. We pass the value explicitly per-config.
 */
export const CASPER_KEY_ALGORITHM = { ed25519: 1, secp256k1: 2 } as const;
export type CasperKeyAlgorithmName = keyof typeof CASPER_KEY_ALGORITHM;

type CasperX402Runtime = {
  createClientCasperSigner(pemPath: string, algorithm?: number): Promise<CasperClientSigner>;
  toClientCasperSigner(privateKey: unknown): CasperClientSigner;
};

export type CasperSignerMode = 'local-testnet' | 'operator-wallet' | 'enterprise-custody';

export type CasperSignerProviderErrorCode =
  | 'CASPER_SIGNER_NETWORK_NOT_ALLOWED'
  | 'CASPER_SIGNER_PENDING_APPROVAL'
  | 'CASPER_SIGNER_UNAVAILABLE'
  | 'CASPER_SIGNER_UNSUPPORTED_MODE';

export class CasperSignerProviderError extends Error {
  readonly code: CasperSignerProviderErrorCode;

  constructor(code: CasperSignerProviderErrorCode, message: string) {
    super(message);
    this.name = 'CasperSignerProviderError';
    this.code = code;
  }
}

type LocalTestnetSignerConfig = {
  mode: 'local-testnet';
  privateKey?: unknown;
  pemPath?: string;
  /** Key algorithm the PEM was generated under. Defaults to ed25519 when omitted. */
  algorithm?: CasperKeyAlgorithmName;
};

type OperatorWalletSignerConfig = {
  mode: 'operator-wallet';
  approvalReference?: string;
};

type EnterpriseCustodySignerConfig = {
  mode: 'enterprise-custody';
  configured: boolean;
};

export type CasperSignerProviderConfig =
  | LocalTestnetSignerConfig
  | OperatorWalletSignerConfig
  | EnterpriseCustodySignerConfig;

export class CasperSignerProvider {
  readonly mode: CasperSignerMode;
  private readonly config: CasperSignerProviderConfig;

  private constructor(config: CasperSignerProviderConfig) {
    this.config = config;
    this.mode = config.mode;
  }

  static localTestnet(config: Omit<LocalTestnetSignerConfig, 'mode'>): CasperSignerProvider {
    return new CasperSignerProvider({ mode: 'local-testnet', ...config });
  }

  static operatorWalletPending(
    config: Omit<OperatorWalletSignerConfig, 'mode'> = {},
  ): CasperSignerProvider {
    return new CasperSignerProvider({ mode: 'operator-wallet', ...config });
  }

  static enterpriseCustodyUnavailable(): CasperSignerProvider {
    return new CasperSignerProvider({ mode: 'enterprise-custody', configured: false });
  }

  async getClientSigner(input: { network: CasperNetwork }): Promise<CasperClientSigner> {
    if (this.config.mode !== 'local-testnet') {
      throw this.unavailableModeError();
    }

    if (input.network !== CASPER_X402_TESTNET_NETWORK) {
      throw new CasperSignerProviderError(
        'CASPER_SIGNER_NETWORK_NOT_ALLOWED',
        `Local Casper signer is restricted to ${CASPER_X402_TESTNET_NETWORK}`,
      );
    }

    if (!this.config.privateKey && !this.config.pemPath) {
      throw new CasperSignerProviderError(
        'CASPER_SIGNER_UNAVAILABLE',
        'Local Casper signer requires explicit testnet private key material',
      );
    }

    const casperX402 = (await importRuntime('@make-software/casper-x402')) as CasperX402Runtime;
    if (this.config.privateKey) {
      return casperX402.toClientCasperSigner(this.config.privateKey);
    }

    const pemPath = this.config.pemPath;
    if (!pemPath) {
      throw new CasperSignerProviderError(
        'CASPER_SIGNER_UNAVAILABLE',
        'Local Casper signer requires explicit testnet private key material',
      );
    }
    // Load the PEM under the algorithm it was generated with (ed25519 default). A secp256k1 PEM MUST be
    // loaded as secp256k1 or signing produces an invalid key.
    const algorithm = CASPER_KEY_ALGORITHM[this.config.algorithm ?? 'ed25519'];
    return casperX402.createClientCasperSigner(pemPath, algorithm);
  }

  private unavailableModeError(): CasperSignerProviderError {
    switch (this.config.mode) {
      case 'operator-wallet':
        return new CasperSignerProviderError(
          'CASPER_SIGNER_PENDING_APPROVAL',
          'Operator wallet signing requires an explicit approval workflow before signing',
        );
      case 'enterprise-custody':
        return new CasperSignerProviderError(
          'CASPER_SIGNER_UNAVAILABLE',
          'Enterprise custody signing is unavailable until configured',
        );
      case 'local-testnet':
        return new CasperSignerProviderError(
          'CASPER_SIGNER_UNSUPPORTED_MODE',
          'Unsupported Casper signer mode',
        );
    }
  }
}
