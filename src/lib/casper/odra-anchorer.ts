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

// Runtime-only type for the casper-js-sdk pieces we call (transitive dep — no direct type import).
type CasperSdk = {
  RpcClient: new (handler: unknown) => { putDeploy(d: unknown): Promise<{ deployHash: { toHex(): string } }> };
  HttpHandler: new (endpoint: string) => unknown;
  PrivateKey: {
    fromPem(content: string, algorithm: number): { publicKey: unknown; sign(msg: Uint8Array): Uint8Array };
  };
  KeyAlgorithm: { ED25519: 1; SECP256K1: 2 };
  DeployHeader: { default(): { chainName: string; account: unknown } };
  ExecutableDeployItem: {
    new(): { storedVersionedContractByHash?: unknown };
    standardPayment(amount: string): unknown;
  };
  StoredVersionedContractByHash: new (hash: unknown, entryPoint: string, args: unknown) => unknown;
  Args: { fromMap(record: Record<string, unknown>): unknown };
  CLValue: { newCLString(val: string): unknown };
  ContractHash: { fromHex(hex: string): unknown };
  Deploy: { makeDeploy(header: unknown, payment: unknown, session: unknown): { sign(key: unknown): void } };
};

const importRuntime = (s: string): Promise<unknown> => import(/* @vite-ignore */ s) as Promise<unknown>;
const importSdk = (): Promise<CasperSdk> => importRuntime('casper-js-sdk') as Promise<CasperSdk>;

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
      const contractHash = sdk.ContractHash.fromHex(packageHash);
      const session = new sdk.ExecutableDeployItem();
      session.storedVersionedContractByHash = new sdk.StoredVersionedContractByHash(
        contractHash,
        entryPoint,
        namedArgs,
      );

      const header = sdk.DeployHeader.default();
      header.chainName = cfg.chainName ?? 'casper-test';
      header.account = privateKey.publicKey;

      const payment = sdk.ExecutableDeployItem.standardPayment('3000000000'); // 3 CSPR gas cap
      const deploy = sdk.Deploy.makeDeploy(header, payment, session);
      deploy.sign(privateKey);

      const client = new sdk.RpcClient(new sdk.HttpHandler(cfg.rpcUrl));
      const result = await client.putDeploy(deploy);
      return { txHash: result.deployHash.toHex() };
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
