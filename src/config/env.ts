import { z } from 'zod';
import { DEFAULT_GRAPH_MODEL } from '../engines/control/graph-builder/prompt-to-graph.js';

/**
 * Single source of truth for runtime configuration.
 *
 * Validated once at boot (see {@link loadEnv}); a malformed environment is a fail-fast
 * condition, never a silent default. Nothing else in the codebase reads `process.env`
 * directly — engines receive the parsed, typed {@link Env}.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url().or(z.literal('')).default(''),

  KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
  KMS_TREASURY_KEY_ID: z.string().default(''),
  KMS_AGENT_FLOAT_KEY_ID: z.string().default(''),

  // CasperHacks product surface. Defaults are honest-blocked: routes boot, report what is missing, and
  // signing/settlement fail closed until a real testnet key or live integration is supplied.
  CASPER_GUARD_SIGNER_MODE: z
    .enum(['disabled', 'local-testnet', 'operator-wallet', 'enterprise-custody'])
    .default('disabled'),
  CASPER_GUARD_SIGNER_PEM_PATH: z.string().default(''),
  // Base64-encoded PEM content — use this on Railway/cloud instead of PEM_PATH.
  // Set to the output of: base64 -i secret_key.pem | tr -d '\n'
  CASPER_GUARD_SIGNER_PEM_INLINE: z.string().default(''),
  // Algorithm the local-testnet PEM was generated under. casper-client keygen defaults to ed25519;
  // a key exported from Casper Wallet / an EC PEM is secp256k1. Must match the PEM or signing is invalid.
  CASPER_GUARD_SIGNER_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('ed25519'),
  CASPER_GUARD_NETWORKS: z.string().min(1).default('casper:casper-test'),
  CASPER_GUARD_MCP_URL: z.string().min(1).default('/v1/casper-guard/mcp'),
  // Milestone B (D-3): master secret the EncryptedStoreVault derives its AES-256-GCM key from.
  // Empty = per-agent delegated signing is unavailable; every authorize falls back to the
  // existing custodial CasperSignerProvider (unchanged behavior for agents with no delegated key).
  CASPER_GUARD_VAULT_MASTER_SECRET: z.string().default(''),
  CASPER_GUARD_FACILITATOR_RPC_URL: z.string().url().or(z.literal('')).default(''),
  CASPER_GUARD_FACILITATOR_URL: z.string().url().or(z.literal('')).default(''),
  CSPR_CLOUD_ACCESS_TOKEN: z.string().default(''),
  CASPER_GUARD_ODRA_PACKAGE_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .or(z.literal(''))
    .default(''),
  CASPER_GUARD_ODRA_RPC_URL: z.string().url().or(z.literal('')).default(''),
  CASPER_GUARD_ODRA_ENTRY_POINT: z.string().min(1).default('anchor_decision'),
  CASPER_GUARD_ODRA_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('secp256k1'),
  // Chain name for the Odra anchor deploy. 'casper-test' = testnet, 'casper' = mainnet.
  CASPER_GUARD_ODRA_CHAIN_NAME: z.enum(['casper-test', 'casper']).default('casper-test'),

  // --- Mainnet-slot siblings. Empty = mainnet not configured (mainnet toggle 503s honestly). ---
  CASPER_GUARD_MAINNET_SIGNER_PEM_PATH: z.string().default(''),
  CASPER_GUARD_MAINNET_SIGNER_PEM_INLINE: z.string().default(''),
  CASPER_GUARD_MAINNET_SIGNER_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('ed25519'),
  CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH: z.string().regex(/^[0-9a-fA-F]{64}$/).or(z.literal('')).default(''),
  CASPER_GUARD_MAINNET_ODRA_RPC_URL: z.string().url().or(z.literal('')).default(''),
  CASPER_GUARD_MAINNET_ODRA_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('ed25519'),
  CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL: z.string().url().or(z.literal('')).default(''),
  CASPER_GUARD_MAINNET_FACILITATOR_URL: z.string().url().or(z.literal('')).default(''),
  // MAINNET trade venue — the public https://mcp.cspr.trade/mcp. Real funds, real liquidity.
  // Boot fails if this points anywhere else (a self-hosted/testnet venue would silently execute
  // mainnet-intended swaps against a testnet pool).
  CSPR_TRADE_MAINNET_MCP_URL: z.string().url().or(z.literal('')).default(''),
  CSPR_TRADE_MAINNET_SENDER_PUBLIC_KEY: z.string().default(''),
  CSPR_TRADE_MAINNET_SIGNER_PEM_PATH: z.string().default(''),
  CSPR_TRADE_MAINNET_SIGNER_PEM_INLINE: z.string().default(''),
  CSPR_TRADE_MAINNET_SIGNER_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('ed25519'),

  // Casper operator account hash (64 hex, no prefix). Used as the AllocationPolicy allowedDestinations
  // float fence on Casper — replaces the EVM agent-float address that Arc used.
  CASPER_OPERATOR_ACCOUNT_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .or(z.literal(''))
    .default(''),
  // Mainnet-slot operator account the mainnet treasury gateway reads on-chain balances from (and the
  // mainnet float-destination fence). Empty = mainnet treasury not configured (the mainnet toggle's
  // /v1/treasury/* calls 503 honestly). Distinct account from testnet — real mainnet funds.
  CASPER_MAINNET_OPERATOR_ACCOUNT_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .or(z.literal(''))
    .default(''),
  CSPR_TRADE_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  CSPR_TRADE_ALLOWED_RISK_LABELS: z.string().min(1).default('low,medium'),
  // TESTNET trade venue. Defaults empty (UnavailableCsprTradeClient). Must be the SELF-HOSTED
  // testnet MCP (Casper-AGOPS.TradeMCP — @make-software/cspr-trade-mcp run against casper-test).
  // NOT https://mcp.cspr.trade/mcp: that is the public MAINNET venue and trades real mainnet
  // liquidity. Boot fails (assertTradeVenueMatchesNetwork) if this points at mcp.cspr.trade.
  CSPR_TRADE_MCP_URL: z.string().url().or(z.literal('')).default(''),
  // Casper public key (hex, 66 chars with 01/02 prefix) for the sender_public_key field in build_swap.
  // Typically the same public key as the Guard signer PEM. Required for LiveCsprTradeClient.
  CASPER_GUARD_SENDER_PUBLIC_KEY: z.string().default(''),
  // Ed25519 key used exclusively for CSPR.trade build_swap (MCP only accepts 01-prefix Ed25519 keys).
  // When set, overrides CASPER_GUARD_SENDER_PUBLIC_KEY / CASPER_GUARD_SIGNER_PEM_PATH for trade signing.
  CSPR_TRADE_SENDER_PUBLIC_KEY: z.string().default(''),
  CSPR_TRADE_SIGNER_PEM_PATH: z.string().default(''),
  // Base64-encoded PEM — use on Railway instead of CSPR_TRADE_SIGNER_PEM_PATH.
  // Set to: base64 -i secret_key.pem | tr -d '\n'
  CSPR_TRADE_SIGNER_PEM_INLINE: z.string().default(''),
  CSPR_TRADE_SIGNER_ALGORITHM: z.enum(['ed25519', 'secp256k1']).default('ed25519'),
  // JSON-encoded map of resourceId → expected payTo address for x402-payment destination binding.
  // Example: '{"svc:casper-paid-api":"00abc...def","svc:other":"00111...222"}'
  // When a resourceId appears here, authorize_payment rejects any intent whose payTo does not match.
  // Leave empty to skip destination binding (fail-open, backwards-compatible default).
  CASPER_GUARD_SERVICE_DESTINATIONS: z.string().default(''),


  // Hot-path signer keys. DEFAULTS ARE WELL-KNOWN PUBLIC ANVIL TEST KEYS — NOT SECRETS, demo/dev only.
  // Production overrides with KMS-isolated keys behind the same LocalKmsSigner seam.
  AGENT_FLOAT_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .default('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
  TREASURY_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .default('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'),
  // Demo orchestration surface. OFF by default; `true` exposes /v1/demo/* (dev/demo only, self-bootstraps).
  DEMO_ENABLED: z.enum(['true', 'false']).default('false'),
  DEMO_VENDOR_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x4444444444444444444444444444444444444444'),
  DEMO_VENDOR_HOST: z.string().min(1).default('api.weather.example'),
  DEMO_RESOURCE: z.string().min(1).default('svc:weather'),
  // Casper demo payment target. DEMO_CSPR_PAY_TO is the operator account hash with 00 prefix.
  // DEMO_CSPR_TOKEN_PACKAGE_HASH is a deployed CEP-18 token on casper-test (e.g. wCSPR/CSPRX).
  DEMO_CSPR_PAY_TO: z
    .string()
    .regex(/^00[0-9a-fA-F]{64}$/)
    .default('0060854d9ea1bf41a111b3a60a46252ecf5c5a2f626fe4eec199b23c7d84fb4267'),
  DEMO_CSPR_TOKEN_PACKAGE_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .or(z.literal(''))
    .default(''),
  /**
   * MAINNET WCSPR package hash. A DIFFERENT contract from the testnet one — funding an agent on
   * mainnet with the testnet hash would target a contract that does not exist there. Empty means
   * mainnet agent funding stays disabled (the route reports it rather than crashing).
   */
  DEMO_CSPR_MAINNET_TOKEN_PACKAGE_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .or(z.literal(''))
    .default(''),
  DEMO_CSPR_TOKEN_NAME: z.string().min(1).default('CSPRX'),
  DEMO_CSPR_TOKEN_VERSION: z.string().min(1).default('1'),

  // Identity / session layer (P1). All optional with dev-safe defaults — the server boots without them.
  SESSION_COOKIE_NAME: z.string().min(1).default('agentops_session'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().default(''),
  // Google OAuth (OIDC) — endpoints stay live but return "not configured" until all three are set.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().url().or(z.literal('')).default(''),

  // Auth-route abuse control (P1i). Per-IP fixed-window limiter over Redis. The default of 10/60s is a
  // sane production ceiling that clears the test suite's per-file call volume; tests that need to TRIP
  // the limiter set a tiny AUTH_RATE_LIMIT via envOverride.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // Milestone H (visual/prompt workflow builder) — prompt -> graph generation only. The LLM here
  // PROPOSES config; this key is never read by any signer/deploy/vault path (see
  // graph-builder/prompt-to-graph.ts header). Empty = the endpoint 503s honestly.
  // Note: pro-tier Gemini models are quota-0 on free API keys — keep the default on a flash model.
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_GRAPH_MODEL: z.string().min(1).default(DEFAULT_GRAPH_MODEL),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate the process environment. Throws a readable aggregated error
 * (never a partial config) when anything is missing or malformed.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
