import { z } from 'zod';
import type { CasperGuardAsset } from '../../contracts/index.js';

export type { CasperGuardActionKind, CasperGuardAsset } from '../../contracts/index.js';

export const CASPER_GUARD_NETWORKS = ['casper:casper-test', 'casper:casper'] as const;
export const CASPER_GUARD_ACTION_KINDS = ['x402-payment', 'cspr-trade', 'casper-deploy'] as const;

export type CasperGuardNetwork = (typeof CASPER_GUARD_NETWORKS)[number];
type CasperGuardCep18Asset = Extract<CasperGuardAsset, { kind: 'cep18' }>;

export type CasperGuardIntent =
  | {
      kind: 'x402-payment';
      network: CasperGuardNetwork;
      resourceId: string;
      amount: string;
      asset: CasperGuardAsset;
      destination: string;
      maxTimeoutSeconds: number;
      rawRequirementHash?: string;
    }
  | {
      kind: 'cspr-trade';
      network: CasperGuardNetwork;
      resourceId: string;
      amount: string;
      fromAsset: CasperGuardAsset;
      toAsset: CasperGuardAsset;
      minReceived: string;
      slippageBps: number;
      routeId: string;
      riskLabel?: string;
    }
  | {
      kind: 'casper-deploy';
      network: CasperGuardNetwork;
      resourceId: string;
      amount: string;
      asset: CasperGuardAsset;
      deployKind: 'transfer' | 'contract-call' | 'contract-install';
      target: string;
      entryPoint?: string;
      argsHash?: string;
    };

export type CasperGuardDecisionStatus =
  | 'QUOTED'
  | 'RESERVED'
  | 'SIGNED'
  | 'BROADCASTING'
  | 'EXPIRY_CHECK'
  | 'SETTLED'
  | 'DENIED'
  | 'FAILED_TERMINAL'
  | 'EXPIRED';

const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);
const networkSchema = z.enum(CASPER_GUARD_NETWORKS);
const packageHashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const accountHashSchema = z.string().regex(/^00[0-9a-fA-F]{64}$/);

const cep18AssetInput = z
  .object({
    kind: z.literal('cep18'),
    package_hash: packageHashSchema,
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .transform((asset): CasperGuardCep18Asset => ({
    kind: 'cep18',
    packageHash: asset.package_hash,
    name: asset.name,
    version: asset.version,
  }));

const nativeAssetInput = z
  .object({
    kind: z.literal('native'),
    symbol: z.literal('CSPR'),
  })
  .transform((asset): CasperGuardAsset => asset);

const assetInput = z.union([cep18AssetInput, nativeAssetInput]);

const x402PaymentIntentInput = z
  .object({
    kind: z.literal('x402-payment'),
    network: networkSchema,
    resource_id: z.string().trim().min(1),
    amount: positiveIntegerString,
    asset: assetInput,
    pay_to: accountHashSchema,
    max_timeout_seconds: z.number().int().positive(),
    raw_requirement_hash: z.string().trim().min(1).optional(),
  })
  .transform(
    (intent): CasperGuardIntent => ({
      kind: 'x402-payment',
      network: intent.network,
      resourceId: intent.resource_id,
      amount: intent.amount,
      asset: intent.asset,
      destination: intent.pay_to,
      maxTimeoutSeconds: intent.max_timeout_seconds,
      ...(intent.raw_requirement_hash ? { rawRequirementHash: intent.raw_requirement_hash } : {}),
    }),
  );

const csprTradeIntentInput = z
  .object({
    kind: z.literal('cspr-trade'),
    network: networkSchema,
    resource_id: z.string().trim().min(1),
    amount: positiveIntegerString,
    from_asset: assetInput,
    to_asset: assetInput,
    min_received: positiveIntegerString,
    slippage_bps: z.number().int().min(0).max(10_000),
    route_id: z.string().trim().min(1),
    risk_label: z.string().trim().min(1).optional(),
  })
  .transform(
    (intent): CasperGuardIntent => ({
      kind: 'cspr-trade',
      network: intent.network,
      resourceId: intent.resource_id,
      amount: intent.amount,
      fromAsset: intent.from_asset,
      toAsset: intent.to_asset,
      minReceived: intent.min_received,
      slippageBps: intent.slippage_bps,
      routeId: intent.route_id,
      ...(intent.risk_label ? { riskLabel: intent.risk_label } : {}),
    }),
  );

const casperDeployIntentInput = z
  .object({
    kind: z.literal('casper-deploy'),
    network: networkSchema,
    resource_id: z.string().trim().min(1),
    amount: positiveIntegerString,
    asset: assetInput,
    deploy_kind: z.enum(['transfer', 'contract-call', 'contract-install']),
    target: z.string().trim().min(1),
    entry_point: z.string().trim().min(1).optional(),
    args_hash: z.string().trim().min(1).optional(),
  })
  .transform(
    (intent): CasperGuardIntent => ({
      kind: 'casper-deploy',
      network: intent.network,
      resourceId: intent.resource_id,
      amount: intent.amount,
      asset: intent.asset,
      deployKind: intent.deploy_kind,
      target: intent.target,
      ...(intent.entry_point ? { entryPoint: intent.entry_point } : {}),
      ...(intent.args_hash ? { argsHash: intent.args_hash } : {}),
    }),
  );

const intentInput = z.union([x402PaymentIntentInput, csprTradeIntentInput, casperDeployIntentInput]);

export class CasperGuardIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasperGuardIntentError';
  }
}

export function normalizeCasperGuardIntent(input: unknown): CasperGuardIntent {
  const parsed = intentInput.safeParse(input);
  if (!parsed.success) {
    throw new CasperGuardIntentError(`invalid_casper_guard_intent: ${parsed.error.issues[0]?.message ?? 'invalid input'}`);
  }
  return parsed.data;
}

export function casperGuardIntentPrimaryAsset(intent: CasperGuardIntent): CasperGuardAsset {
  switch (intent.kind) {
    case 'x402-payment':
    case 'casper-deploy':
      return intent.asset;
    case 'cspr-trade':
      return intent.fromAsset;
  }
}

export function casperGuardAssetRef(asset: CasperGuardAsset): string {
  return asset.kind === 'cep18' ? asset.packageHash : asset.symbol;
}

export function casperGuardIntentDestination(intent: CasperGuardIntent): string | null {
  switch (intent.kind) {
    case 'x402-payment':
      return intent.destination;
    case 'cspr-trade':
      return intent.routeId;
    case 'casper-deploy':
      return intent.target;
  }
}
