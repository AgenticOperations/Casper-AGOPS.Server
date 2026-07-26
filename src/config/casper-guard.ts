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
import type { CasperGuardDeps, CasperGuardNetworkSlot } from '../engines/casper-guard/routes.js';
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
import type pg from 'pg';
import { EncryptedStoreVault, type KeyVault } from '../engines/custody/key-vault.js';
import { createPgVaultBlobStore } from '../engines/custody/pg-vault-blob-store.js';
import { createDelegationAwareSignerProvider } from '../engines/custody/vault-signer.js';

export interface CasperGuardVaultContext {
  pool: pg.Pool;
  vault: KeyVault;
}

export interface CasperClientSignerProvider {
  mode: CasperSignerMode;
  getClientSigner(input: { network: CasperNetwork; agentId?: string }): Promise<CasperClientSigner>;
}

interface NetworkSlotEnvFields {
  chainName: 'casper-test' | 'casper';
  signerMode: Env['CASPER_GUARD_SIGNER_MODE'];
  signerPemPath: string;
  signerPemInline: string;
  signerAlgorithm: 'ed25519' | 'secp256k1';
  odraPackageHash: string;
  odraRpcUrl: string;
  odraAlgorithm: 'ed25519' | 'secp256k1';
  facilitatorRpcUrl: string;
  facilitatorUrl: string;
  tradeMcpUrl: string;
  tradeSenderPublicKey: string;
  tradeSignerPemPath: string;
  tradeSignerPemInline: string;
  tradeSignerAlgorithm: 'ed25519' | 'secp256k1';
}

function testnetSlotEnvFields(env: Env): NetworkSlotEnvFields {
  return {
    chainName: 'casper-test',
    signerMode: env.CASPER_GUARD_SIGNER_MODE,
    signerPemPath: env.CASPER_GUARD_SIGNER_PEM_PATH,
    signerPemInline: env.CASPER_GUARD_SIGNER_PEM_INLINE,
    signerAlgorithm: env.CASPER_GUARD_SIGNER_ALGORITHM,
    odraPackageHash: env.CASPER_GUARD_ODRA_PACKAGE_HASH,
    odraRpcUrl: env.CASPER_GUARD_ODRA_RPC_URL,
    odraAlgorithm: env.CASPER_GUARD_ODRA_ALGORITHM,
    facilitatorRpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL,
    facilitatorUrl: env.CASPER_GUARD_FACILITATOR_URL,
    tradeMcpUrl: env.CSPR_TRADE_MCP_URL,
    tradeSenderPublicKey: env.CSPR_TRADE_SENDER_PUBLIC_KEY || env.CASPER_GUARD_SENDER_PUBLIC_KEY,
    tradeSignerPemPath: env.CSPR_TRADE_SIGNER_PEM_PATH,
    tradeSignerPemInline: env.CSPR_TRADE_SIGNER_PEM_INLINE,
    tradeSignerAlgorithm: env.CSPR_TRADE_SIGNER_ALGORITHM,
  };
}

function mainnetSlotEnvFields(env: Env): NetworkSlotEnvFields {
  return {
    chainName: 'casper',
    // Mainnet reuses the same signer-mode gate as testnet (disabled/local-testnet/etc.) — only
    // the key material and network-specific endpoints differ per slot.
    signerMode: env.CASPER_GUARD_SIGNER_MODE,
    signerPemPath: env.CASPER_GUARD_MAINNET_SIGNER_PEM_PATH,
    signerPemInline: env.CASPER_GUARD_MAINNET_SIGNER_PEM_INLINE,
    signerAlgorithm: env.CASPER_GUARD_MAINNET_SIGNER_ALGORITHM,
    odraPackageHash: env.CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH,
    odraRpcUrl: env.CASPER_GUARD_MAINNET_ODRA_RPC_URL,
    odraAlgorithm: env.CASPER_GUARD_MAINNET_ODRA_ALGORITHM,
    facilitatorRpcUrl: env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL,
    facilitatorUrl: env.CASPER_GUARD_MAINNET_FACILITATOR_URL,
    tradeMcpUrl: env.CSPR_TRADE_MAINNET_MCP_URL,
    tradeSenderPublicKey: env.CSPR_TRADE_MAINNET_SENDER_PUBLIC_KEY,
    tradeSignerPemPath: env.CSPR_TRADE_MAINNET_SIGNER_PEM_PATH,
    tradeSignerPemInline: env.CSPR_TRADE_MAINNET_SIGNER_PEM_INLINE,
    tradeSignerAlgorithm: env.CSPR_TRADE_MAINNET_SIGNER_ALGORITHM,
  };
}

function resolveSlotPemPath(pemPath: string, pemInline: string, tmpFileName: string): string | undefined {
  if (pemPath !== '') return pemPath;
  if (pemInline !== '') {
    const pemContent = Buffer.from(pemInline, 'base64').toString('utf8');
    const tmpPath = join(tmpdir(), tmpFileName);
    writeFileSync(tmpPath, pemContent, { mode: 0o600 });
    return tmpPath;
  }
  return undefined;
}

/**
 * The public CSPR.trade venue. It trades against Casper MAINNET liquidity — there is no testnet
 * pool behind it. Testnet must instead point at the self-hosted `Casper-AGOPS.TradeMCP` deployment
 * (`@make-software/cspr-trade-mcp` run against casper-test).
 */
const PUBLIC_MAINNET_TRADE_MCP_HOST = 'mcp.cspr.trade';

/**
 * Reject a trade-venue URL that belongs to the other network's slot.
 *
 * A swap routed to the wrong venue does not fail loudly — it quotes and executes against real
 * liquidity on the wrong chain. Pointing the testnet slot at the public mainnet venue means an
 * agent's "testnet" swap spends mainnet funds; the reverse silently trades mainnet intent against a
 * testnet pool. Neither is recoverable after the deploy lands, so this fails at boot instead.
 */
function assertTradeVenueMatchesNetwork(chainName: string, tradeMcpUrl: string): void {
  if (tradeMcpUrl === '') return;
  let host: string;
  try {
    host = new URL(tradeMcpUrl).host.toLowerCase();
  } catch {
    throw new Error(`Invalid trade MCP URL for chain "${chainName}": ${tradeMcpUrl}`);
  }
  const isPublicMainnetVenue = host === PUBLIC_MAINNET_TRADE_MCP_HOST;
  if (chainName === 'casper-test' && isPublicMainnetVenue) {
    throw new Error(
      `CSPR_TRADE_MCP_URL (testnet) points at the public MAINNET venue ${PUBLIC_MAINNET_TRADE_MCP_HOST}. ` +
        'Testnet swaps must use the self-hosted testnet MCP (Casper-AGOPS.TradeMCP). ' +
        `Set CSPR_TRADE_MCP_URL to the self-hosted testnet endpoint, and ${PUBLIC_MAINNET_TRADE_MCP_HOST} only on CSPR_TRADE_MAINNET_MCP_URL.`,
    );
  }
  if (chainName === 'casper' && !isPublicMainnetVenue) {
    throw new Error(
      `CSPR_TRADE_MAINNET_MCP_URL points at "${host}", which is not the public mainnet venue ` +
        `${PUBLIC_MAINNET_TRADE_MCP_HOST}. Mainnet swaps must not be routed to a testnet or self-hosted venue.`,
    );
  }
}

function buildNetworkSlot(
  fields: NetworkSlotEnvFields,
  env: Env,
  vaultCtx?: CasperGuardVaultContext,
): CasperGuardNetworkSlot {
  assertTradeVenueMatchesNetwork(fields.chainName, fields.tradeMcpUrl);
  const signerPemPath = resolveSlotPemPath(
    fields.signerPemPath,
    fields.signerPemInline,
    `casper_guard_signer_${fields.chainName}.pem`,
  );
  const signer = (() => {
    switch (fields.signerMode) {
      case 'disabled':
        return undefined;
      case 'local-testnet': {
        if (!signerPemPath) return undefined;
        const fallbackProvider = CasperSignerProvider.localTestnet({
          pemPath: signerPemPath,
          algorithm: fields.signerAlgorithm,
        });
        const provider = vaultCtx
          ? createDelegationAwareSignerProvider({ pool: vaultCtx.pool, vault: vaultCtx.vault, fallbackProvider })
          : fallbackProvider;
        return createCasperGuardRuntimeSigner(provider);
      }
      case 'operator-wallet':
        return undefined;
      case 'enterprise-custody':
        return undefined;
    }
  })();

  const odraConfigured = fields.odraPackageHash !== '' && fields.odraRpcUrl !== '';
  const tradePubKey = fields.tradeSenderPublicKey;
  const tradePemPath =
    resolveSlotPemPath(fields.tradeSignerPemPath, fields.tradeSignerPemInline, `cspr_trade_signer_${fields.chainName}.pem`) ||
    signerPemPath ||
    '';
  const tradeAvailable = fields.tradeMcpUrl !== '' && tradePubKey !== '' && tradePemPath !== '';
  // A dedicated trade key can be supplied by EITHER path or inline. Use the trade signer's own
  // algorithm whenever a trade key is present (either way); only fall back to the operator signer's
  // algorithm when NO trade key was configured and tradePemPath resolved to signerPemPath. Gating on
  // `tradeSignerPemPath !== ''` alone missed the inline case: an ed25519 inline trade key was parsed
  // under the operator's secp256k1 algorithm → `Failed to match tag: "octstr" at ["privateKey"]`.
  const tradeKeyProvided = fields.tradeSignerPemPath !== '' || fields.tradeSignerPemInline !== '';
  const tradeAlgorithm = tradeKeyProvided ? fields.tradeSignerAlgorithm : fields.signerAlgorithm;

  return {
    ...(signer ? { signer } : {}),
    liveSettlement:
      fields.facilitatorRpcUrl !== ''
        ? { configured: true }
        : { configured: false, reason: 'casper_facilitator_not_configured' },
    ...(fields.facilitatorRpcUrl !== ''
      ? {
          settlementReaderFactory: () => {
            const deployReader = createLiveDeployReader({ rpcUrl: fields.facilitatorRpcUrl });
            const tradeClient = createLiveCsprTradeClient({
              mcpUrl: fields.tradeMcpUrl !== '' ? fields.tradeMcpUrl : undefined,
              senderPublicKey: tradePubKey || undefined,
              pemPath: tradePemPath || undefined,
              algorithm: tradeAlgorithm,
              rpcUrl: fields.facilitatorRpcUrl || undefined,
            });
            const csprTradeReader = createCsprTradeSettlementReader(tradeClient, deployReader);
            // When the hosted facilitator URL is configured, use it to submit transfer_from on-chain.
            // Falls back to passive RPC polling when only the node URL is set (backwards compat).
            const baseReader = fields.facilitatorUrl !== ''
              ? createFacilitatorSettlementReaderFromConfig(
                  fields.facilitatorUrl,
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
      ? { configured: true, contractPackage: fields.odraPackageHash }
      : { configured: false, reason: 'odra_contract_not_bound' },
    ...(odraConfigured
      ? {
          anchorer: createOdraGuardRegistryAnchorer({
            packageHash: fields.odraPackageHash,
            entryPoint: env.CASPER_GUARD_ODRA_ENTRY_POINT,
            // SEAM: swap createLiveCasperDeploySubmitter for a real client once contract is deployed
            submitter: createLiveCasperDeploySubmitter({
              rpcUrl: fields.odraRpcUrl,
              pemPath: signerPemPath ?? '',
              algorithm: fields.odraAlgorithm,
              chainName: fields.chainName,
            }),
          }),
        }
      : {}),
    tradeExecutor: (() => {
      const client = createLiveCsprTradeClient({
        mcpUrl: fields.tradeMcpUrl !== '' ? fields.tradeMcpUrl : undefined,
        senderPublicKey: tradePubKey || undefined,
        pemPath: tradePemPath || undefined,
        algorithm: tradeAlgorithm,
        rpcUrl: fields.facilitatorRpcUrl || undefined,
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

export function buildCasperGuardDeps(
  env: Env,
  ctx?: { pool?: pg.Pool; vault?: KeyVault },
): CasperGuardDeps {
  const serviceDestinations = parseServiceDestinations(env.CASPER_GUARD_SERVICE_DESTINATIONS);
  const enabledNetworks = parseNetworks(env.CASPER_GUARD_NETWORKS);

  // Milestone B (D-3): per-agent delegated signing is only wired in when BOTH a pool (to look up
  // delegated_keys / agent_vault_keys) and a vault master secret are available. Either missing =
  // every network slot's signer stays the plain custodial provider (today's behavior, unchanged).
  // Prefer a pre-built vault passed in by the caller (server.ts builds ONE vault and shares it with
  // both AppDeps.vault and here, so agent-create grants and the runtime signer use the same store).
  // When none is passed, build our own so the existing test harness (which calls this without a
  // vault) is unchanged.
  const vaultCtx: CasperGuardVaultContext | undefined =
    ctx?.pool && env.CASPER_GUARD_VAULT_MASTER_SECRET !== ''
      ? {
          pool: ctx.pool,
          vault:
            ctx.vault ??
            new EncryptedStoreVault({
              masterSecretHex: env.CASPER_GUARD_VAULT_MASTER_SECRET,
              store: createPgVaultBlobStore(ctx.pool),
            }),
        }
      : undefined;

  const testnetFields = testnetSlotEnvFields(env);
  const testnetSlot = buildNetworkSlot(testnetFields, env, vaultCtx);

  const byNetwork: CasperGuardDeps['byNetwork'] = {
    'casper:casper-test': testnetSlot,
  };
  if (enabledNetworks.includes('casper:casper')) {
    const mainnetFields = mainnetSlotEnvFields(env);
    const mainnetOdraConfigured = mainnetFields.odraPackageHash !== '' && mainnetFields.odraRpcUrl !== '';
    const mainnetSignerConfigured =
      mainnetFields.signerMode !== 'disabled' &&
      (mainnetFields.signerPemPath !== '' || mainnetFields.signerPemInline !== '');
    if (mainnetOdraConfigured || mainnetSignerConfigured) {
      byNetwork['casper:casper'] = buildNetworkSlot(mainnetFields, env, vaultCtx);
    }
  }

  /*
   * Read-only venue URLs, independent of whether that network can EXECUTE. Both slots are populated
   * whenever a URL is configured — mainnet market data is readable even on a testnet-only execution
   * deployment, because reading a quote moves no funds. assertTradeVenueMatchesNetwork has already
   * verified each URL belongs to its own network.
   */
  const tradeDataUrls: Partial<Record<'casper:casper-test' | 'casper:casper', string>> = {};
  if (env.CSPR_TRADE_MCP_URL !== '') tradeDataUrls['casper:casper-test'] = env.CSPR_TRADE_MCP_URL;
  if (env.CSPR_TRADE_MAINNET_MCP_URL !== '') tradeDataUrls['casper:casper'] = env.CSPR_TRADE_MAINNET_MCP_URL;

  return {
    networks: enabledNetworks,
    ...(serviceDestinations ? { serviceDestinations } : {}),
    ...(Object.keys(tradeDataUrls).length > 0 ? { tradeDataUrls } : {}),
    mcpUrl: env.CASPER_GUARD_MCP_URL,
    trade: {
      maxSlippageBps: env.CSPR_TRADE_MAX_SLIPPAGE_BPS,
      allowedRiskLabels: parseCsv(env.CSPR_TRADE_ALLOWED_RISK_LABELS),
    },
    byNetwork,
    // legacy top-level fields mirror the testnet slot — kept until all route call sites migrate
    ...(testnetSlot.signer ? { signer: testnetSlot.signer } : {}),
    liveSettlement: testnetSlot.liveSettlement ?? { configured: false, reason: 'casper_facilitator_not_configured' },
    ...(testnetSlot.settlementReaderFactory
      ? { settlementReaderFactory: testnetSlot.settlementReaderFactory }
      : {}),
    odra: testnetSlot.odra ?? { configured: false, reason: 'odra_contract_not_bound' },
    ...(testnetSlot.anchorer ? { anchorer: testnetSlot.anchorer } : {}),
    tradeExecutor: testnetSlot.tradeExecutor!,
  };
}

export function createCasperGuardRuntimeSigner(
  provider: CasperClientSignerProvider,
): CasperGuardSigner {
  return {
    kind: provider.mode,
    async sign(input) {
      const signer = await provider.getClientSigner({
        network: input.intent.network,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
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
