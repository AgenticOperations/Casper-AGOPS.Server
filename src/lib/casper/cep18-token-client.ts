/**
 * Typed CEP-18 token contract-call client for WCSPR.
 *
 * The existing string-only submitter (`createLiveCasperDeploySubmitter` in odra-anchorer.ts)
 * builds every runtime arg with `CLValue.newCLString`, which cannot express the TYPED args
 * (Key / U256 / U512) that WCSPR `transfer` / `deposit` require. This module adds:
 *   - pure arg descriptors (what unit tests assert),
 *   - an injectable submitter interface (`Cep18CallSubmitter`) mirroring `CasperDeploySubmitter`,
 *   - a live adapter that maps descriptors → real casper-js-sdk CLValues (added in Task 2).
 *
 * We only CALL the third-party WCSPR contract; we never deploy or update it.
 */

import { readFileSync as nodeReadFileSync } from 'node:fs';
import { CASPER_KEY_ALGORITHM, type CasperKeyAlgorithmName } from './signer.js';

// A submitter that performs an operator-signed typed contract call. Live impl uses casper-js-sdk;
// tests inject a fake. Mirrors CasperDeploySubmitter but with TYPED args (Key / U256 / U512) that
// the string-only anchorer submitter cannot express.
export interface Cep18CallSubmitter {
  call(input: {
    packageHash: string;
    entryPoint: string;
    args: Cep18TypedArgs;
    paymentMotes: number;
  }): Promise<{ txHash: string }>;
}

// Descriptor form is what tests assert; the live adapter maps these to real CLValues.
export type ClTypedArg =
  | { clType: 'U256'; value: string }
  | { clType: 'U512'; value: string }
  | { kind: 'account-hash-key'; rawHash: string };
export type Cep18TypedArgs = Record<string, ClTypedArg>;

export function buildCep18TransferArgs(p: {
  recipientAccountHash: string;
  amountMotes: string;
}): { recipient: ClTypedArg; amount: ClTypedArg } {
  // Repo stores account hashes as `00`+64hex; Key.newKey("account-hash-"+…) wants the RAW 64 hex.
  const rawHash = p.recipientAccountHash.startsWith('00')
    ? p.recipientAccountHash.slice(2)
    : p.recipientAccountHash;
  return {
    recipient: { kind: 'account-hash-key', rawHash },
    amount: { clType: 'U256', value: p.amountMotes },
  };
}

export function buildWcsprDepositArgs(p: { amountMotes: string }): { amount: ClTypedArg } {
  // WCSPR `deposit` is payable and takes the native wrap amount as U512.
  return { amount: { clType: 'U512', value: p.amountMotes } };
}

// ---------------------------------------------------------------------------
// Live adapter (casper-js-sdk). Maps the descriptors above to real CLValues.
// ---------------------------------------------------------------------------

// Runtime-only type for the casper-js-sdk pieces we call (transitive dep — no direct type import).
// Superset of the odra-anchorer surface, adding the TYPED CLValue + Key constructors.
type CasperSdk = {
  RpcClient: new (handler: unknown) => {
    putTransaction(t: unknown): Promise<{ transactionHash: { toHex(): string } }>;
  };
  HttpHandler: new (endpoint: string) => unknown;
  PrivateKey: {
    fromPem(content: string, algorithm: number): { publicKey: unknown };
  };
  KeyAlgorithm: { ED25519: 1; SECP256K1: 2 };
  Args: { fromMap(map: Record<string, unknown>): unknown };
  CLValue: {
    newCLKey(key: unknown): unknown;
    newCLUInt256(val: string): unknown;
    newCLUInt512(val: string): unknown;
  };
  Key: { newKey(s: string): unknown };
  ContractCallBuilder: new () => {
    byPackageHash(hash: string): {
      entryPoint(name: string): {
        runtimeArgs(args: unknown): {
          from(publicKey: unknown): {
            chainName(name: string): {
              payment(amount: number): {
                build(): { sign(privateKey: unknown): void; hash: { toHex(): string } };
              };
            };
          };
        };
      };
    };
  };
};

const importSdkDefault = async (): Promise<CasperSdk> => {
  // casper-js-sdk ships as CJS, so ESM dynamic import wraps it under .default.
  const mod = (await import(/* @vite-ignore */ 'casper-js-sdk')) as { default?: CasperSdk } & CasperSdk;
  return (mod.default ?? mod) as CasperSdk;
};

function toClValue(sdk: CasperSdk, arg: ClTypedArg): unknown {
  if ('kind' in arg) {
    return sdk.CLValue.newCLKey(sdk.Key.newKey('account-hash-' + arg.rawHash));
  }
  if (arg.clType === 'U256') return sdk.CLValue.newCLUInt256(arg.value);
  return sdk.CLValue.newCLUInt512(arg.value);
}

/**
 * Live operator-signed CEP-18 contract-call submitter (typed CLValues).
 *
 * Mirrors `createLiveCasperDeploySubmitter` (odra-anchorer.ts) — same SDK-load + sign +
 * putTransaction skeleton — but maps `Cep18TypedArgs` to TYPED CLValues (Key / U256 / U512).
 * `importSdk` / `readFileSync` are injectable so unit tests never load casper-js-sdk or read disk.
 */
export function createLiveCep18CallSubmitter(cfg: {
  rpcUrl: string;
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  chainName?: string;
  importSdk?: () => Promise<CasperSdk>;
  readFileSync?: (path: string, encoding: 'utf8') => string;
}): Cep18CallSubmitter {
  const loadSdk = cfg.importSdk ?? importSdkDefault;
  const readFile = cfg.readFileSync ?? nodeReadFileSync;
  return {
    async call({ packageHash, entryPoint, args, paymentMotes }) {
      const sdk = await loadSdk();

      const pemContent = readFile(cfg.pemPath, 'utf8');
      const sdkAlgorithm =
        CASPER_KEY_ALGORITHM[cfg.algorithm] === 1 ? sdk.KeyAlgorithm.ED25519 : sdk.KeyAlgorithm.SECP256K1;
      const privateKey = sdk.PrivateKey.fromPem(pemContent, sdkAlgorithm);

      const namedArgs = sdk.Args.fromMap(
        Object.fromEntries(Object.entries(args).map(([k, v]) => [k, toClValue(sdk, v)])),
      );

      const transaction = new sdk.ContractCallBuilder()
        .byPackageHash(packageHash)
        .entryPoint(entryPoint)
        .runtimeArgs(namedArgs)
        .from(privateKey.publicKey)
        .chainName(cfg.chainName ?? 'casper-test')
        .payment(paymentMotes)
        .build();
      transaction.sign(privateKey);

      const client = new sdk.RpcClient(new sdk.HttpHandler(cfg.rpcUrl));
      const result = await client.putTransaction(transaction);
      return { txHash: result.transactionHash.toHex() };
    },
  };
}
