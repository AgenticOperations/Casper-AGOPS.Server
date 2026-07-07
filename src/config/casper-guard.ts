import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentRequired } from '@x402/core/types';
import type { Env } from './env.js';
import { CasperSignerProvider, type CasperSignerMode } from '../lib/casper/signer.js';
import {
  CASPER_X402_TESTNET_NETWORK,
  CASPER_X402_VERSION,
  createCasperX402PaymentHeader,
  type CasperClientSigner,
  type CasperNetwork,
} from '../lib/casper/x402.js';
import type { CasperGuardDeps } from '../engines/casper-guard/routes.js';
import {
  createCasperRpcSettlementReader,
  createCsprTradeSettlementReader,
  createFacilitatorSettlementReader,
  createLiveDeployReader,
  type DeployReader,
} from '../lib/casper/settlement-reader.js';
import { buildHttpCasperFacilitator } from '../lib/casper/facilitator.js';
import {
  createLiveCasperDeploySubmitter,
  createOdraGuardRegistryAnchorer,
} from '../lib/casper/odra-anchorer.js';
import {
  createCsprTradeExecutor,
  createLiveCsprTradeClient,
} from '../lib/casper/cspr-trade.js';
import type { CasperGuardSigner } from '../engines/casper-guard/policy.js';
import type { CasperGuardIntent, CasperGuardNetwork } from '../engines/casper-guard/types.js';

export interface CasperClientSignerProvider {
  mode: CasperSignerMode;
  getClientSigner(input: { network: CasperNetwork }): Promise<CasperClientSigner>;
}

export function buildCasperGuardDeps(env: Env): CasperGuardDeps {
  const signer = buildSigner(env);
  const odraConfigured =
    env.CASPER_GUARD_ODRA_PACKAGE_HASH !== '' && env.CASPER_GUARD_ODRA_RPC_URL !== '';
  const serviceDestinations = parseServiceDestinations(env.CASPER_GUARD_SERVICE_DESTINATIONS);
  return {
    ...(signer ? { signer } : {}),
    networks: parseNetworks(env.CASPER_GUARD_NETWORKS),
    ...(serviceDestinations ? { serviceDestinations } : {}),
    mcpUrl: env.CASPER_GUARD_MCP_URL,
    liveSettlement:
      env.CASPER_GUARD_FACILITATOR_RPC_URL !== ''
        ? { configured: true }
        : { configured: false, reason: 'casper_facilitator_not_configured' },
    ...(env.CASPER_GUARD_FACILITATOR_RPC_URL !== ''
      ? {
          settlementReaderFactory: () => {
            const deployReader = createLiveDeployReader({ rpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL });
            const tradeClient = createLiveCsprTradeClient({
              mcpUrl: env.CSPR_TRADE_MCP_URL !== '' ? env.CSPR_TRADE_MCP_URL : undefined,
              senderPublicKey: (env.CSPR_TRADE_SENDER_PUBLIC_KEY || env.CASPER_GUARD_SENDER_PUBLIC_KEY) || undefined,
              pemPath: (resolveTradePemPath(env) || resolvePemPath(env)) || undefined,
              algorithm: env.CSPR_TRADE_SIGNER_PEM_PATH !== '' ? env.CSPR_TRADE_SIGNER_ALGORITHM : env.CASPER_GUARD_SIGNER_ALGORITHM,
            });
            const csprTradeReader = createCsprTradeSettlementReader(tradeClient, deployReader);
            // When the hosted facilitator URL is configured, use it to submit transfer_from on-chain.
            // Falls back to passive RPC polling when only the node URL is set (backwards compat).
            const baseReader = env.CASPER_GUARD_FACILITATOR_URL !== ''
              ? createFacilitatorSettlementReaderFromConfig(
                  env.CASPER_GUARD_FACILITATOR_URL,
                  env.CSPR_CLOUD_ACCESS_TOKEN,
                  deployReader,
                )
              : createCasperRpcSettlementReader(deployReader);
            // Route cspr-trade decisions through the trade client; all others through facilitator/RPC.
            return {
              read(decision) {
                if (decision.actionKind === 'cspr-trade') return csprTradeReader.read(decision);
                return baseReader.read(decision);
              },
            };
          },
        }
      : {}),
    odra: odraConfigured
      ? { configured: true }
      : { configured: false, reason: 'odra_contract_not_bound' },
    ...(odraConfigured
      ? {
          anchorer: createOdraGuardRegistryAnchorer({
            packageHash: env.CASPER_GUARD_ODRA_PACKAGE_HASH,
            entryPoint: env.CASPER_GUARD_ODRA_ENTRY_POINT,
            // SEAM: swap createLiveCasperDeploySubmitter for a real client once contract is deployed
            submitter: createLiveCasperDeploySubmitter({
              rpcUrl: env.CASPER_GUARD_ODRA_RPC_URL,
              pemPath: resolvePemPath(env) ?? '',
              algorithm: env.CASPER_GUARD_ODRA_ALGORITHM,
              chainName: 'casper-test',
            }),
          }),
        }
      : {}),
    trade: {
      maxSlippageBps: env.CSPR_TRADE_MAX_SLIPPAGE_BPS,
      allowedRiskLabels: parseCsv(env.CSPR_TRADE_ALLOWED_RISK_LABELS),
    },
    // LiveCsprTradeClient: real mcp.cspr.trade quote + sign + submit (MCP SSE session now handled).
    // Falls back to UnavailableCsprTradeClient when required config is absent.
    tradeExecutor: (() => {
      const tradePubKey = env.CSPR_TRADE_SENDER_PUBLIC_KEY || env.CASPER_GUARD_SENDER_PUBLIC_KEY;
      const tradePemPath = resolveTradePemPath(env) || resolvePemPath(env) || '';
      const tradeAvailable = env.CSPR_TRADE_MCP_URL !== '' && tradePubKey !== '' && tradePemPath !== '';
      const client = createLiveCsprTradeClient({
            mcpUrl: env.CSPR_TRADE_MCP_URL !== '' ? env.CSPR_TRADE_MCP_URL : undefined,
            senderPublicKey: tradePubKey || undefined,
            pemPath: tradePemPath || undefined,
            algorithm: env.CSPR_TRADE_SIGNER_PEM_PATH !== '' ? env.CSPR_TRADE_SIGNER_ALGORITHM : env.CASPER_GUARD_SIGNER_ALGORITHM,
          });
      const executor = createCsprTradeExecutor({
        policy: {
          maxSlippageBps: env.CSPR_TRADE_MAX_SLIPPAGE_BPS,
          allowedRiskLabels: parseCsv(env.CSPR_TRADE_ALLOWED_RISK_LABELS),
        },
        client,
      });
      return { available: tradeAvailable, ...executor };
    })(),
  };
}

export function createCasperGuardRuntimeSigner(
  provider: CasperClientSignerProvider,
): CasperGuardSigner {
  return {
    kind: provider.mode,
    async sign(input) {
      const signer = await provider.getClientSigner({ network: input.intent.network });
      if (input.intent.kind === 'x402-payment') {
        const signed = await createCasperX402PaymentHeader({
          signer,
          paymentRequired: paymentRequiredFromIntent(input.intent),
        });
        return {
          signedHeaderHash: `sha256:${sha256(signed.headerValue)}`,
          headers: signed.headers,
        };
      }

      const canonical = stableJson({
        product: 'AgentOps',
        decisionId: input.decisionId,
        intent: input.intent,
      });
      const digest = createHash('sha256').update(canonical).digest();
      const signature = await signer.signEIP712(digest);
      return { signedHeaderHash: `sha256:${sha256(bytesToHex(signature))}` };
    },
  };
}

function resolvePemPath(env: Env): string | undefined {
  if (env.CASPER_GUARD_SIGNER_PEM_PATH !== '') return env.CASPER_GUARD_SIGNER_PEM_PATH;
  if (env.CASPER_GUARD_SIGNER_PEM_INLINE !== '') {
    const pemContent = Buffer.from(env.CASPER_GUARD_SIGNER_PEM_INLINE, 'base64').toString('utf8');
    const tmpPath = join(tmpdir(), 'casper_guard_signer.pem');
    writeFileSync(tmpPath, pemContent, { mode: 0o600 });
    return tmpPath;
  }
  return undefined;
}

function resolveTradePemPath(env: Env): string | undefined {
  if (env.CSPR_TRADE_SIGNER_PEM_PATH !== '') return env.CSPR_TRADE_SIGNER_PEM_PATH;
  if (env.CSPR_TRADE_SIGNER_PEM_INLINE !== '') {
    const pemContent = Buffer.from(env.CSPR_TRADE_SIGNER_PEM_INLINE, 'base64').toString('utf8');
    const tmpPath = join(tmpdir(), 'cspr_trade_signer.pem');
    writeFileSync(tmpPath, pemContent, { mode: 0o600 });
    return tmpPath;
  }
  return undefined;
}

function buildSigner(env: Env): CasperGuardSigner | undefined {
  switch (env.CASPER_GUARD_SIGNER_MODE) {
    case 'disabled':
      return undefined;
    case 'local-testnet': {
      const pemPath = resolvePemPath(env);
      if (!pemPath) return undefined;
      return createCasperGuardRuntimeSigner(
        CasperSignerProvider.localTestnet({
          pemPath,
          algorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
        }),
      );
    }
    case 'operator-wallet':
      return undefined;
    case 'enterprise-custody':
      return undefined;
  }
}

function paymentRequiredFromIntent(intent: Extract<CasperGuardIntent, { kind: 'x402-payment' }>): PaymentRequired {
  if (intent.asset.kind !== 'cep18') {
    throw new Error('casper_guard_x402_requires_cep18_asset');
  }
  return {
    x402Version: CASPER_X402_VERSION,
    resource: { url: intent.resourceId, serviceName: 'AgentOps' },
    accepts: [
      {
        scheme: 'exact',
        network: intent.network,
        amount: intent.amount,
        asset: intent.asset.packageHash,
        payTo: intent.destination,
        maxTimeoutSeconds: intent.maxTimeoutSeconds,
        extra: { name: intent.asset.name, version: intent.asset.version },
      },
    ],
  };
}

/**
 * Synchronous wrapper that creates a facilitator settlement reader.
 * buildCasperFacilitator is async (dynamic import), so we return a reader whose read()
 * lazily resolves the facilitator on first call and caches it.
 */
function createFacilitatorSettlementReaderFromConfig(
  facilitatorUrl: string,
  accessToken: string,
  deployReader: DeployReader,
): import('../engines/casper-guard/reconcile-worker.js').CasperGuardSettlementReader {
  const facilitator = buildHttpCasperFacilitator({ facilitatorUrl, accessToken });
  return {
    async read(decision) {
      if (!facilitator) {
        return createCasperRpcSettlementReader(deployReader).read(decision);
      }
      return createFacilitatorSettlementReader(facilitator, deployReader).read(decision);
    },
  };
}

function parseServiceDestinations(value: string): Record<string, string> | null {
  if (value.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) result[k] = v;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function parseNetworks(value: string): CasperGuardNetwork[] {
  const networks = parseCsv(value).filter(isCasperGuardNetwork);
  return networks.length > 0 ? networks : [CASPER_X402_TESTNET_NETWORK];
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isCasperGuardNetwork(value: string): value is CasperGuardNetwork {
  return (
    value === 'casper:casper-test' ||
    value === 'casper:casper' ||
    value === 'evm:sepolia' ||
    value === 'evm:base-sepolia'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(stabilize(value));
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stabilize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stabilize(item)]),
  );
}
