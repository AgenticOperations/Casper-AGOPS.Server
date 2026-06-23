/**
 * Thin facilitator wrapper around `@make-software/casper-x402`'s ExactCasperScheme.
 *
 * Builds a FacilitatorCasperSigner from the funded PEM and exposes a narrow verify/settle
 * surface normalized away from the raw `@x402/core` VerifyResponse/SettleResponse shapes.
 * Honest-blocked: with no rpcUrl or no pemPath this returns `undefined` — never a fake facilitator.
 */

const importRuntime = (s: string): Promise<unknown> => import(/* @vite-ignore */ s) as Promise<unknown>;

/**
 * casper-js-sdk `KeyAlgorithm`: ED25519 = 1, SECP256K1 = 2. The facilitator signer must load the PEM
 * under the SAME algorithm it was generated with (see {@link CASPER_KEY_ALGORITHM} in ./signer.ts).
 */
const KEY_ALGORITHM = { ed25519: 1, secp256k1: 2 } as const;
export type CasperKeyAlgorithmName = keyof typeof KEY_ALGORITHM;

type FacilitatorRuntime = {
  createFacilitatorCasperSigner(pemPath: string, algorithm: number | undefined, rpcUrl: string): Promise<unknown>;
};

type FacilitatorSchemeRuntime = {
  ExactCasperScheme: new (signer: unknown) => {
    verify(payload: unknown, requirements: unknown): Promise<{ isValid: boolean; invalidReason?: string }>;
    settle(payload: unknown, requirements: unknown): Promise<{ success: boolean; transaction?: string; errorReason?: string }>;
  };
};

export interface CasperFacilitator {
  verify(input: { payload: unknown; requirements: unknown }): Promise<{ isValid: boolean; reason?: string }>;
  settle(input: { payload: unknown; requirements: unknown }): Promise<{ success: boolean; txHash?: string; reason?: string }>;
}

export async function buildCasperFacilitator(cfg: {
  pemPath: string;
  algorithm: CasperKeyAlgorithmName;
  rpcUrl: string;
}): Promise<CasperFacilitator | undefined> {
  if (cfg.rpcUrl === '' || cfg.pemPath === '') return undefined;

  const sdk = (await importRuntime('@make-software/casper-x402')) as FacilitatorRuntime;
  const signer = await sdk.createFacilitatorCasperSigner(cfg.pemPath, KEY_ALGORITHM[cfg.algorithm], cfg.rpcUrl);
  const facMod = (await importRuntime('@make-software/casper-x402/exact/facilitator')) as FacilitatorSchemeRuntime;
  const scheme = new facMod.ExactCasperScheme(signer);

  return {
    async verify({ payload, requirements }) {
      const r = await scheme.verify(payload, requirements);
      return r.isValid ? { isValid: true } : { isValid: false, reason: r.invalidReason ?? 'casper_verify_failed' };
    },
    async settle({ payload, requirements }) {
      const r = await scheme.settle(payload, requirements);
      return r.success
        ? { success: true, ...(r.transaction ? { txHash: r.transaction } : {}) }
        : { success: false, reason: r.errorReason ?? 'casper_settle_failed' };
    },
  };
}
