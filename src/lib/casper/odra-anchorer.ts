import { readFileSync } from 'node:fs';
import type { GuardRegistryAnchorer } from '../../engines/casper-guard/reconcile-worker.js';
import { CASPER_KEY_ALGORITHM, type CasperKeyAlgorithmName } from './signer.js';

/** Injectable Casper deploy submitter — live impl uses casper-js-sdk; tests inject a fake. */
export interface CasperDeploySubmitter {
  submit(input: {
    packageHash: string;
    entryPoint: string;
    args: Record<string, string>;
  }): Promise<{ txHash: string }>;
}

/** Injectable native CSPR transfer submitter — separate from CEP-18 contract-call path. */
export interface NativeCsprTransferSubmitter {
  submitTransfer(input: {
    toAccountHash: string;
    amountMotes: string;
  }): Promise<{ txHash: string }>;
}

// Runtime-only type for the casper-js-sdk pieces we call (transitive dep — no direct type import).
type CasperSdk = {
  RpcClient: new (handler: unknown) => {
    putTransaction(t: unknown): Promise<{ transactionHash: { toHex(): string } }>;
  };
  HttpHandler: new (endpoint: string) => unknown;
  PrivateKey: {
    fromPem(content: string, algorithm: number): { publicKey: unknown; sign(msg: Uint8Array): Uint8Array };
  };
  KeyAlgorithm: { ED25519: 1; SECP256K1: 2 };
  Args: { fromMap(map: Record<string, unknown>): unknown };
  CLValue: { newCLString(val: string): unknown };
  // Casper 2.0 Transaction API — entry-point calls on a stored contract package.
  ContractCallBuilder: new () => {
    byPackageHash(hash: string): ContractCallBuilderChain;
  };
  // Casper 2.0 Transaction API — native transfers.
  NativeTransferBuilder: new () => {
    from(publicKey: unknown): unknown;
    targetAccountHash(accountHash: unknown): unknown;
    amount(amount: string): unknown;
    id(id: number): unknown;
    chainName(name: string): unknown;
    payment(amount: number): unknown;
    build(): { sign(privateKey: unknown): void; hash: { toHex(): string } };
  };
  AccountHash: { fromString(hex: string): unknown };
};

type ContractCallBuilderChain = {
  entryPoint(name: string): ContractCallBuilderChain;
  runtimeArgs(args: unknown): ContractCallBuilderChain;
  from(publicKey: unknown): ContractCallBuilderChain;
  chainName(name: string): ContractCallBuilderChain;
  payment(amount: number): ContractCallBuilderChain;
  build(): { sign(privateKey: unknown): void; hash: { toHex(): string } };
};

const importRuntime = (s: string): Promise<unknown> => import(/* @vite-ignore */ s) as Promise<unknown>;
const importSdk = async (): Promise<CasperSdk> => {
  const mod = await importRuntime('casper-js-sdk') as { default?: CasperSdk } & CasperSdk;
  // casper-js-sdk ships as CJS, so ESM dynamic import wraps it under .default
  return (mod.default ?? mod);
};

/**
 * Live Casper deploy submitter using casper-js-sdk v5.
 *
 * Builds a `StoredVersionedContractByHash` session calling `entryPoint` on `packageHash`,
 * signs with the funded PEM key, submits via `putDeploy`, returns the deploy hash as txHash.
 * SDK import is deferred — unit tests inject a fake submitter and never load casper-js-sdk.
 */
export function createLiveCasperDeploySubmitter(cfg: {
  rpcUrl: string;
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  chainName?: string;
}): CasperDeploySubmitter {
  return {
    async submit({ packageHash, entryPoint, args }) {
      const sdk = await importSdk();

      const pemContent = readFileSync(cfg.pemPath, 'utf8');
      const sdkAlgorithm =
        CASPER_KEY_ALGORITHM[cfg.algorithm] === 1 ? sdk.KeyAlgorithm.ED25519 : sdk.KeyAlgorithm.SECP256K1;
      const privateKey = sdk.PrivateKey.fromPem(pemContent, sdkAlgorithm);

      const namedArgs = sdk.Args.fromMap(
        Object.fromEntries(Object.entries(args).map(([k, v]) => [k, sdk.CLValue.newCLString(v)])),
      );

      // Casper 2.0 Transaction API (TransactionV1 / ContractCallBuilder). The prior implementation
      // used the Casper 1.x Deploy/putDeploy path, which Casper 2.0 nodes accept but never execute
      // or include in a block — anchor calls silently no-op while looking "confirmed".
      const transaction = new sdk.ContractCallBuilder()
        .byPackageHash(packageHash)
        .entryPoint(entryPoint)
        .runtimeArgs(namedArgs)
        .from(privateKey.publicKey)
        .chainName(cfg.chainName ?? 'casper-test')
        .payment(3_000_000_000) // 3 CSPR gas cap
        .build();
      transaction.sign(privateKey);

      const client = new sdk.RpcClient(new sdk.HttpHandler(cfg.rpcUrl));
      const result = await client.putTransaction(transaction);
      return { txHash: result.transactionHash.toHex() };
    },
  };
}

/**
 * Native CSPR transfer submitter for the `casper-deploy` rail with native asset.
 *
 * Uses casper-js-sdk v5 `NativeTransferBuilder` (Casper 2.0 Transaction API). The
 * CEP-18 / x402 payment path is entirely separate — this is only called when an agent
 * authorizes a `casper-deploy` intent with `asset.kind === "native"` and then triggers
 * reconcile to settle on-chain. Uses the same funded PEM as the Odra anchorer.
 */
export function createNativeCsprTransferSubmitter(cfg: {
  rpcUrl: string;
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  chainName?: string;
}): NativeCsprTransferSubmitter {
  return {
    async submitTransfer({ toAccountHash, amountMotes }) {
      const sdk = await importSdk();
      const pemContent = readFileSync(cfg.pemPath, 'utf8');
      const sdkAlgorithm =
        CASPER_KEY_ALGORITHM[cfg.algorithm] === 1 ? sdk.KeyAlgorithm.ED25519 : sdk.KeyAlgorithm.SECP256K1;
      const privateKey = sdk.PrivateKey.fromPem(pemContent, sdkAlgorithm);

      // Strip the "00" account-hash prefix if present (AccountHash.fromString expects raw 64-char hex)
      const rawHash = toAccountHash.startsWith('00') ? toAccountHash.slice(2) : toAccountHash;
      const accountHash = sdk.AccountHash.fromString(rawHash);

      type NativeBuilder = {
        from(pk: unknown): NativeBuilder;
        targetAccountHash(h: unknown): NativeBuilder;
        amount(a: string): NativeBuilder;
        id(i: number): NativeBuilder;
        chainName(n: string): NativeBuilder;
        payment(p: number): NativeBuilder;
        build(): { sign(k: unknown): void; hash: { toHex(): string } };
      };
      const tx = (new sdk.NativeTransferBuilder() as unknown as NativeBuilder)
        .from((privateKey as unknown as { publicKey: unknown }).publicKey)
        .targetAccountHash(accountHash)
        .amount(amountMotes)
        .id(Date.now())
        .chainName(cfg.chainName ?? 'casper-test')
        .payment(100_000_000) // 0.1 CSPR gas cap for native transfer
        .build();

      tx.sign(privateKey);

      const client = new sdk.RpcClient(new sdk.HttpHandler(cfg.rpcUrl));
      const result = await client.putTransaction(tx);
      return { txHash: result.transactionHash.toHex() };
    },
  };
}

export function createOdraGuardRegistryAnchorer(cfg: {
  packageHash: string;
  entryPoint: string;
  submitter: CasperDeploySubmitter;
}): GuardRegistryAnchorer {
  return {
    async anchorDecision({ decisionId, decisionHash }) {
      const { txHash } = await cfg.submitter.submit({
        packageHash: cfg.packageHash,
        entryPoint: cfg.entryPoint,
        args: { decision_id: decisionId, decision_hash: decisionHash },
      });
      return { txHash };
    },
  };
}
