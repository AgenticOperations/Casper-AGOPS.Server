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
 * Self-hosted testnet CSPR.trade route builder.
 *
 * `quote` builds a deterministic route from the intent pair/amount and returns it immediately —
 * no external CSPR.trade API is called, so the demo works without an API key.
 * `submit` records the route as a real Casper testnet deploy via the GuardRegistry contract's
 * `record_trade_route` entry point, producing a genuine on-chain deploy hash.
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
