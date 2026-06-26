import { randomUUID } from 'node:crypto';
import { createLiveCasperDeploySubmitter } from './odra-anchorer.js';
import type { CasperKeyAlgorithmName } from './signer.js';

export interface CsprTradeQuote {
  slippageBps: number;
  riskLabel: string;
  quoteId: string;
}

export interface CsprTradeIntent {
  pair: string;
  amount: string;
}

export interface CsprTradeClient {
  quote(intent: CsprTradeIntent): Promise<CsprTradeQuote>;
  submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash?: string }>;
}

export class CsprTradeUnavailableError extends Error {
  constructor() {
    super('cspr_trade_not_configured');
    this.name = 'CsprTradeUnavailableError';
  }
}

/** Honest-blocked default until real CSPR.trade access exists. NEVER mocks a fill. */
export class UnavailableCsprTradeClient implements CsprTradeClient {
  quote(_intent: CsprTradeIntent): Promise<CsprTradeQuote> {
    return Promise.reject(new CsprTradeUnavailableError());
  }
  submit(_input: { quoteId: string }): Promise<{ txHash: string }> {
    return Promise.reject(new CsprTradeUnavailableError());
  }
}

/**
 * Self-hosted testnet CSPR.trade route builder (retained for offline testing only).
 *
 * `quote` builds a deterministic route from the intent pair/amount and returns it immediately —
 * no external CSPR.trade API is called.
 * `submit` records the route as a real Casper testnet deploy via the GuardRegistry contract's
 * `record_trade_route` entry point.
 *
 * NOTE: for the live demo use LiveCsprTradeClient which calls the real mcp.cspr.trade endpoint.
 */
export class TestnetCsprTradeClient implements CsprTradeClient {
  private readonly submitter: ReturnType<typeof createLiveCasperDeploySubmitter>;
  private readonly packageHash: string;

  constructor(cfg: {
    rpcUrl: string;
    pemPath: string;
    algorithm: CasperKeyAlgorithmName;
    packageHash: string;
  }) {
    this.packageHash = cfg.packageHash;
    this.submitter = createLiveCasperDeploySubmitter({
      rpcUrl: cfg.rpcUrl,
      pemPath: cfg.pemPath,
      algorithm: cfg.algorithm,
    });
  }

  quote(intent: CsprTradeIntent): Promise<CsprTradeQuote> {
    // Build a deterministic local route — slippage scales linearly with amount, capped at 80 bps.
    const amountMotes = BigInt(intent.amount);
    const slippageBps = Math.min(Math.floor(Number(amountMotes / 10_000_000n)), 80);
    return Promise.resolve({
      slippageBps,
      riskLabel: slippageBps < 50 ? 'low' : 'medium',
      quoteId: `tq_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    });
  }

  async submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash: string }> {
    const { txHash } = await this.submitter.submit({
      packageHash: this.packageHash,
      entryPoint: 'record_trade_route',
      args: { quote_id: input.quoteId, route_builder: 'testnet-self-hosted' },
    });
    return { txHash, deployHash: txHash };
  }
}

// ─── Live CSPR.trade MCP client (production / hackathon demo path) ─────────────

/** Raw MCP JSON-RPC 2.0 caller for mcp.cspr.trade */
async function mcpCall<T>(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`cspr_trade_mcp_error: HTTP ${res.status} from ${mcpUrl} calling ${toolName}`);
  }
  const body = (await res.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`cspr_trade_mcp_error: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  const textBlock = body.result?.content?.find((c) => c.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`cspr_trade_mcp_error: empty content from ${toolName}`);
  }
  return JSON.parse(textBlock.text) as T;
}

type McpQuoteResult = {
  amount_out?: string;
  price_impact?: number;
  slippage?: number;
  route?: string;
};

type McpSwapBuildResult = {
  deploy_json?: string;
  deploy?: string;
};

type McpSubmitResult = {
  deploy_hash?: string;
  transaction_hash?: string;
};

/**
 * Live CSPR.trade MCP client — the real production / hackathon demo path.
 *
 * Flow: get_quote + estimate_slippage → build_swap → sign locally → submit_transaction.
 *
 * - get_quote and estimate_slippage call https://mcp.cspr.trade/mcp (no API key required).
 * - build_swap returns an unsigned Casper deploy JSON.
 * - Signing uses the local PEM key (same key the Odra anchorer already uses).
 * - submit_transaction broadcasts the signed deploy and returns a real testnet deploy hash.
 *
 * Guard policy evaluation (slippage cap, risk label) runs before submit() is called.
 * The resulting txHash feeds into the reconcile-worker which anchors the decision on GuardRegistry.
 */
export class LiveCsprTradeClient implements CsprTradeClient {
  private readonly mcpUrl: string;
  private readonly senderPublicKey: string;
  private readonly pemPath: string;
  private readonly algorithm: CasperKeyAlgorithmName;

  constructor(cfg: {
    mcpUrl: string;
    senderPublicKey: string;
    pemPath: string;
    algorithm: CasperKeyAlgorithmName;
  }) {
    this.mcpUrl = cfg.mcpUrl;
    this.senderPublicKey = cfg.senderPublicKey;
    this.pemPath = cfg.pemPath;
    this.algorithm = cfg.algorithm;
  }

  async quote(intent: CsprTradeIntent): Promise<CsprTradeQuote> {
    // Pair format: "CSPR/USDT" → tokenIn = "CSPR", tokenOut = "USDT"
    const [tokenIn, tokenOut] = intent.pair.split('/').map((s) => s.trim());
    if (!tokenIn || !tokenOut) {
      throw new Error(`cspr_trade_invalid_pair: expected "TOKEN_A/TOKEN_B", got "${intent.pair}"`);
    }

    // Fetch real AMM quote and real slippage in parallel.
    const [quoteResult, slippageResult] = await Promise.all([
      mcpCall<McpQuoteResult>(this.mcpUrl, 'get_quote', {
        token_in: tokenIn,
        token_out: tokenOut,
        amount: intent.amount,
        type: 'exact_in',
      }),
      mcpCall<{ slippage?: number; slippage_bps?: number }>(this.mcpUrl, 'estimate_slippage', {
        token_in: tokenIn,
        token_out: tokenOut,
        amount: intent.amount,
      }),
    ]);

    // Normalise to bps: the MCP tool may return a decimal fraction (e.g. 0.5 = 50 bps).
    const slippageRaw =
      slippageResult.slippage_bps ??
      (slippageResult.slippage != null ? Math.round(slippageResult.slippage * 100) : null) ??
      (quoteResult.slippage != null ? Math.round(quoteResult.slippage * 100) : 0);
    const slippageBps = Math.max(0, slippageRaw);

    return {
      slippageBps,
      riskLabel: slippageBps < 50 ? 'low' : slippageBps < 150 ? 'medium' : 'high',
      // Encode the token pair into the quoteId so submit() can reconstruct it.
      quoteId: `lq_${tokenIn}_${tokenOut}_${intent.amount}_${Date.now()}`,
    };
  }

  async submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash?: string }> {
    // Reconstruct trade params from the quoteId (format: lq_TOKEN_A_TOKEN_B_AMOUNT_TS).
    const parts = input.quoteId.split('_');
    const tokenIn = parts[1] ?? 'CSPR';
    const tokenOut = parts[2] ?? 'USDT';
    const amount = parts[3] ?? '0';

    // Step 1: Build unsigned deploy from mcp.cspr.trade.
    // CSPR.trade build_swap expects a 64-char raw compressed public key (no algo prefix).
    // Casper format is 66 chars: 2-char algo tag (01=ed25519, 02=secp256k1) + 64-char key.
    // Strip the leading 2-char prefix if present so both 66-char and 64-char inputs work.
    const rawPublicKey = this.senderPublicKey.length === 66
      ? this.senderPublicKey.slice(2)
      : this.senderPublicKey;
    const buildResult = await mcpCall<McpSwapBuildResult>(this.mcpUrl, 'build_swap', {
      token_in: tokenIn,
      token_out: tokenOut,
      amount,
      type: 'exact_in',
      sender_public_key: rawPublicKey,
    });

    const unsignedDeployJson = buildResult.deploy_json ?? buildResult.deploy;
    if (!unsignedDeployJson) {
      throw new Error('cspr_trade_build_swap_error: no deploy_json returned by build_swap');
    }

    // Step 2: Sign the unsigned deploy JSON locally using casper-js-sdk.
    const signedDeployJson = await this.signDeployJson(unsignedDeployJson);

    // Step 3: Submit signed deploy to mcp.cspr.trade → real on-chain testnet tx hash.
    const submitResult = await mcpCall<McpSubmitResult>(this.mcpUrl, 'submit_transaction', {
      signed_deploy_json: signedDeployJson,
    });

    const txHash = submitResult.deploy_hash ?? submitResult.transaction_hash;
    if (!txHash) {
      throw new Error('cspr_trade_submit_error: no deploy_hash returned by submit_transaction');
    }
    return { txHash, deployHash: txHash };
  }

  /**
   * Sign an unsigned Casper deploy JSON string with the local PEM key.
   * Uses casper-js-sdk Deploy.fromJSON / sign / toJSON — the same runtime used by odra-anchorer.
   */
  private async signDeployJson(unsignedDeployJson: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const rawSdk = await (import('casper-js-sdk') as Promise<Record<string, unknown>>);
    const sdk = (rawSdk['default'] ?? rawSdk) as {
      PrivateKey: { fromPem(content: string, algorithm: number): unknown };
      KeyAlgorithm: { ED25519: 1; SECP256K1: 2 };
      Deploy: { fromJSON(json: unknown): { sign(key: unknown): void; toJSON(): unknown } };
    };

    const pemContent = readFileSync(this.pemPath, 'utf8');
    const sdkAlgorithm =
      this.algorithm === 'ed25519' ? sdk.KeyAlgorithm.ED25519 : sdk.KeyAlgorithm.SECP256K1;
    const privateKey = sdk.PrivateKey.fromPem(pemContent, sdkAlgorithm);

    const deploy = sdk.Deploy.fromJSON(JSON.parse(unsignedDeployJson));
    deploy.sign(privateKey);
    return JSON.stringify(deploy.toJSON());
  }
}

/**
 * Factory — returns LiveCsprTradeClient when all required config is present,
 * UnavailableCsprTradeClient otherwise. Injected into createCsprTradeExecutor at boot.
 */
export function createLiveCsprTradeClient(cfg: {
  mcpUrl: string | undefined;
  senderPublicKey: string | undefined;
  pemPath: string | undefined;
  algorithm: CasperKeyAlgorithmName;
}): CsprTradeClient {
  if (!cfg.mcpUrl || !cfg.senderPublicKey || !cfg.pemPath) {
    return new UnavailableCsprTradeClient();
  }
  return new LiveCsprTradeClient({
    mcpUrl: cfg.mcpUrl,
    senderPublicKey: cfg.senderPublicKey,
    pemPath: cfg.pemPath,
    algorithm: cfg.algorithm,
  });
}

export type CsprTradeResult =
  | { outcome: 'ALLOW'; quoteId: string; txHash: string; deployHash?: string }
  | { outcome: 'DENY'; reason: 'slippage_exceeds_cap' | 'risk_label_not_allowed' };

export function createCsprTradeExecutor(cfg: {
  policy: { maxSlippageBps: number; allowedRiskLabels: string[] };
  client: CsprTradeClient;
}) {
  return {
    async execute({ intent }: { intent: CsprTradeIntent }): Promise<CsprTradeResult> {
      const quote = await cfg.client.quote(intent);
      if (quote.slippageBps > cfg.policy.maxSlippageBps) {
        return { outcome: 'DENY', reason: 'slippage_exceeds_cap' };
      }
      if (!cfg.policy.allowedRiskLabels.includes(quote.riskLabel)) {
        return { outcome: 'DENY', reason: 'risk_label_not_allowed' };
      }
      const { txHash, deployHash } = await cfg.client.submit({ quoteId: quote.quoteId });
      return {
        outcome: 'ALLOW',
        quoteId: quote.quoteId,
        txHash,
        ...(deployHash ? { deployHash } : {}),
      };
    },
  };
}
