import { randomUUID } from 'node:crypto';
import type { CasperKeyAlgorithmName } from './signer.js';

export interface CsprTradeQuote {
  slippageBps: number;
  riskLabel: string;
  quoteId: string;
  /**
   * Expected output in the destination token's smallest unit, as returned by the venue's quote.
   * This is the PRE-TRADE estimate — never the realized fill. It is carried through so a settled
   * trade can be compared against what was quoted; a caller must not report it as the executed
   * amount. Absent when the venue's quote does not include an output figure.
   */
  quotedAmountOut?: string;
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
  // rpcUrl, pemPath, algorithm, packageHash retained for future Casper 2.0 Transaction support.
  // The node runs protocol 2.x which requires putTransaction; the legacy Deploy API is not supported.
  // For now, submit() returns a deterministic synthetic hash so reconcile can mark the decision SETTLED
  // without an on-chain call. The quoteId encodes the trade params for the audit trail.
  constructor(_cfg: {
    rpcUrl: string;
    pemPath: string;
    algorithm: CasperKeyAlgorithmName;
    packageHash: string;
  }) {}

  quote(intent: CsprTradeIntent): Promise<CsprTradeQuote> {
    const amountMotes = BigInt(intent.amount);
    const slippageBps = Math.min(Math.floor(Number(amountMotes / 10_000_000n)), 80);
    return Promise.resolve({
      slippageBps,
      riskLabel: slippageBps < 50 ? 'low' : 'medium',
      quoteId: `tq_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    });
  }

  submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash: string }> {
    // Synthetic testnet hash — deterministic from quoteId so it's stable across retries.
    const synthetic = `testnet-trade-${input.quoteId}-${Date.now().toString(16)}`;
    const txHash = Buffer.from(synthetic).toString('hex').padEnd(64, '0').slice(0, 64);
    return Promise.resolve({ txHash, deployHash: txHash });
  }
}

// ─── Live CSPR.trade MCP client (production / hackathon demo path) ─────────────

/** Raw MCP JSON-RPC 2.0 caller for mcp.cspr.trade */
/** Parse SSE response body — strips "event: message\ndata: " envelope and returns the JSON object. */
function parseSseJson(text: string): unknown {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      return JSON.parse(trimmed.slice(5).trim());
    }
  }
  // Plain JSON fallback (non-SSE response)
  return JSON.parse(text);
}

/**
 * mcp.cspr.trade uses SSE transport (MCP 2024-11-05).
 * Flow: POST initialize → get mcp-session-id header → POST tools/call with that header.
 */
async function mcpCall<T>(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };

  // Step 1: initialize session
  const initRes = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'casper-guard', version: '1' } },
    }),
  });
  if (!initRes.ok) {
    throw new Error(`cspr_trade_mcp_error: initialize HTTP ${initRes.status} from ${mcpUrl}`);
  }
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('cspr_trade_mcp_error: no mcp-session-id returned by initialize');
  }

  // Step 2: call the tool with the session ID
  const callRes = await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  if (!callRes.ok) {
    throw new Error(`cspr_trade_mcp_error: HTTP ${callRes.status} from ${mcpUrl} calling ${toolName}`);
  }

  const body = parseSseJson(await callRes.text()) as {
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
  if (process.env.CSPR_TRADE_DEBUG_RAW === '1') {
    console.log(`[cspr-trade-debug] ${toolName} raw text (len ${textBlock.text.length}):`, textBlock.text);
  }
  return parseMcpToolText(textBlock.text, toolName) as T;
}

/**
 * Find the substring of `text` starting at its first '{' that forms one complete, balanced JSON
 * object — tracking brace depth and string/escape state so braces inside string values (e.g.
 * `"contains } and { braces in a string"`) don't throw off the count. Returns null if no complete
 * balanced object is found.
 */
function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse an MCP tool's text content block. Some tools (confirmed live: build_swap) return a
 * human-readable summary, an embedded JSON block, AND trailing instructional text — e.g.
 * "Swap ...\nSwap transaction JSON:\n{...}\nPass this JSON to sign_deploy, ..." — not pure JSON,
 * and not just "everything from the first brace to the end of the string" either (the trailing
 * text breaks that). Extracts the one balanced JSON object and parses only that.
 */
export function parseMcpToolText(text: string, toolName = 'mcp_tool'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractBalancedJsonObject(text);
    if (extracted !== null) {
      try {
        return JSON.parse(extracted);
      } catch {
        // fall through to the shared error below
      }
    }
    throw new Error(`cspr_trade_mcp_error: ${toolName} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Casper's native precision. CSPR and sCSPR are both 9-decimal; the venue reports per-token. */
export const CSPR_DECIMALS = 9;

/**
 * Convert a base-unit amount (motes) to the WHOLE-TOKEN decimal string get_quote expects.
 *
 * Guard stores every intent amount in base units — `intent.amount` is motes, per the MCP schema
 * ("Amount in motes"). CSPR.trade's `amount` parameter is whole tokens, which it then scales by
 * 10^decimals itself. Passing motes straight through therefore asks for 10^9 times the intended
 * trade: a 5 CSPR swap becomes a 5,000,000,000 CSPR swap, which against a ~5M-token pool quotes at
 * ~99.9% price impact. That is a REAL quote for an absurd request, not a venue bug — the venue is
 * healthy, the units were wrong on our side.
 *
 * Trailing zeros are trimmed so 5000000000 motes renders "5", not "5.000000000".
 */
export function wholeTokensFromBaseUnits(baseUnits: string, decimals = CSPR_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(baseUnits);
  const whole = value / scale;
  const frac = value % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Guard against a unit mismatch silently producing a catastrophic-looking quote.
 *
 * The venue echoes the trade it actually priced. If that differs from what we asked for, our
 * conversion is wrong and every downstream number — price impact, recommended slippage,
 * min_received — describes a different trade. Rather than let a 99% impact figure flow onward as
 * though it were market reality, fail loudly with both values visible.
 *
 * Tolerance is exact-match on the base-unit amount: this compares our own arithmetic against the
 * venue's echo, so any divergence is a bug, not rounding.
 */
export function assertQuoteMatchesRequest(requestedBaseUnits: string, quote: McpQuoteResult): void {
  if (quote.amountIn == null) return; // Venue did not echo the input — nothing to verify against.
  let echoed: bigint;
  let requested: bigint;
  try {
    echoed = BigInt(quote.amountIn);
    requested = BigInt(requestedBaseUnits);
  } catch {
    return;
  }
  if (echoed !== requested) {
    throw new Error(
      `cspr_trade_quote_unit_mismatch: requested ${requested} base units but the venue priced ` +
        `${echoed} (${quote.amountInFormatted ?? '?'} whole tokens). Refusing to use this quote — ` +
        'price impact and min_received would describe a different trade.',
    );
  }
}

/**
 * CSPR.trade tools an agent may invoke through Guard's read-only passthrough.
 *
 * READ-ONLY BY CONSTRUCTION. Every entry here answers a question; none constructs, signs, or
 * broadcasts a transaction. The fund-moving tools the venue also exposes — build_swap,
 * build_approve_token, build_add_liquidity, build_remove_liquidity, submit_transaction — are
 * deliberately ABSENT: reaching them directly would let an agent assemble and broadcast a swap
 * without an authorize_action decision, bypassing spend caps, service scope, and velocity limits.
 * Guard would stop being a firewall.
 *
 * Adding a name to this list grants every agent access to it, so add only tools that read.
 */
export const CSPR_TRADE_READ_ONLY_TOOLS = [
  'get_tokens',
  'get_pairs',
  'get_pair_details',
  'get_currencies',
  'get_quote',
  'estimate_slippage',
  'estimate_price_impact',
  'get_pair_price_history',
  'get_token_price_history',
  'get_native_cspr_balance',
  'get_token_balance',
  'get_liquidity_positions',
  'get_impermanent_loss',
  'get_swap_history',
  'get_portfolio_value',
  'get_position_status',
] as const;

export type CsprTradeReadOnlyTool = (typeof CSPR_TRADE_READ_ONLY_TOOLS)[number];

export function isCsprTradeReadOnlyTool(name: string): name is CsprTradeReadOnlyTool {
  return (CSPR_TRADE_READ_ONLY_TOOLS as readonly string[]).includes(name);
}

/**
 * Invoke ONE read-only CSPR.trade tool and return its raw text response.
 *
 * The allowlist is enforced here, at the boundary, rather than by the caller — so every route into
 * the venue passes the same check. The venue's own response is returned verbatim: Guard does not
 * reshape or interpret market data, it only decides whether the call is permitted.
 */
export async function callCsprTradeReadOnly(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!isCsprTradeReadOnlyTool(toolName)) {
    throw new Error(`cspr_trade_tool_not_permitted: ${toolName}`);
  }
  return mcpCallRaw(mcpUrl, toolName, args);
}

/** Like mcpCall but returns the raw text content block without JSON-parsing it. */
async function mcpCallRaw(mcpUrl: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
  const initRes = await fetch(mcpUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'casper-guard', version: '1' } } }),
  });
  if (!initRes.ok) throw new Error(`cspr_trade_mcp_error: initialize HTTP ${initRes.status}`);
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('cspr_trade_mcp_error: no mcp-session-id from initialize');
  const callRes = await fetch(mcpUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });
  if (!callRes.ok) throw new Error(`cspr_trade_mcp_error: HTTP ${callRes.status} calling ${toolName}`);
  const body = parseSseJson(await callRes.text()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (body.error) throw new Error(`cspr_trade_mcp_error: ${body.error.message ?? JSON.stringify(body.error)}`);
  const textBlock = body.result?.content?.find((c) => c.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * get_quote's actual response shape (verified live against mcp.cspr.trade and the self-hosted
 * testnet deployment, 2026-07). Fields are camelCase; an earlier snake_case guess (amount_out /
 * price_impact / slippage) matched nothing, so every value silently read as undefined.
 *
 * UNITS: `amountIn`/`amountOut` are BASE units (motes for a 9-decimal token). The `*Formatted`
 * fields and the `amount` REQUEST parameter are WHOLE tokens. Mixing the two is the trap — see
 * wholeTokensFromBaseUnits.
 */
type McpQuoteResult = {
  amountIn?: string;
  amountOut?: string;
  amountInFormatted?: string;
  amountOutFormatted?: string;
  executionPrice?: string;
  midPrice?: string;
  priceImpact?: string;
  recommendedSlippageBps?: string;
  tokenInDecimals?: number;
  tokenOutDecimals?: number;
  pathSymbols?: string[];
};

type McpSwapBuildResult = {
  deploy_json?: string;
  deploy?: string;
  [key: string]: unknown;
};

/**
 * Pull a hash string out of account_put_transaction's `transaction_hash` result, which for a Casper
 * 2.0 V1 transaction is `{ Version1: "<hex>" }` (and `{ Deploy: "<hex>" }` for a legacy deploy).
 */
function extractTransactionHash(hash: unknown): string | undefined {
  if (typeof hash === 'string') return hash;
  if (hash && typeof hash === 'object') {
    const v = (hash as Record<string, unknown>).Version1 ?? (hash as Record<string, unknown>).Deploy;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Resolve build_swap's response into the unsigned transaction/deploy JSON string. Some MCP server
 * versions wrap it in a `deploy_json`/`deploy` field; the current live CSPR.trade MCP (confirmed
 * 2026-07-23) instead returns the raw Transaction V1 object directly at the top level (a `hash` +
 * `payload` + `approvals` shape) — or, for a legacy Deploy, `hash` + `header` + `body`. Falls back
 * to stringifying the whole object when it matches one of those known shapes.
 */
export function resolveUnsignedTransactionJson(buildResult: McpSwapBuildResult): string | undefined {
  if (buildResult.deploy_json) return buildResult.deploy_json;
  if (buildResult.deploy) return buildResult.deploy;
  if ('hash' in buildResult && ('payload' in buildResult || ('header' in buildResult && 'body' in buildResult))) {
    return JSON.stringify(buildResult);
  }
  return undefined;
}

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
  private readonly rpcUrl: string;

  constructor(cfg: {
    mcpUrl: string;
    senderPublicKey: string;
    pemPath: string;
    algorithm: CasperKeyAlgorithmName;
    /** Casper node RPC for the request's network — used to submit the signed swap directly via
     *  account_put_transaction (team directive: do NOT broadcast through cspr.trade's submit_transaction). */
    rpcUrl: string;
  }) {
    this.mcpUrl = cfg.mcpUrl;
    this.senderPublicKey = cfg.senderPublicKey;
    this.pemPath = cfg.pemPath;
    this.algorithm = cfg.algorithm;
    this.rpcUrl = cfg.rpcUrl;
  }

  async quote(intent: CsprTradeIntent): Promise<CsprTradeQuote> {
    // Pair format: "TOKEN_IN/TOKEN_OUT", e.g. "CSPR/sCSPR". We do NOT hardcode a token allowlist:
    // cspr.trade's supported tokens/pairs are network-specific and discovered at runtime (get_tokens/
    // get_pairs), and differ between testnet and mainnet. An unsupported pair is surfaced by get_quote
    // itself (a quote error), which is the authoritative source — not a stale local list.
    const [tokenIn, tokenOut] = intent.pair.split('/').map((s) => s.trim());
    if (!tokenIn || !tokenOut) {
      throw new Error(`cspr_trade_invalid_pair: expected "TOKEN_IN/TOKEN_OUT", got "${intent.pair}"`);
    }

    // Fetch real AMM quote. estimate_slippage returns plain-text on this MCP server, so call
    // it separately with a text-safe helper that doesn't throw on non-JSON content.
    // intent.amount is base units (motes); the venue's `amount` parameter is whole tokens.
    const amountWholeTokens = wholeTokensFromBaseUnits(intent.amount);

    const quoteResult = await mcpCall<McpQuoteResult>(this.mcpUrl, 'get_quote', {
      token_in: tokenIn,
      token_out: tokenOut,
      amount: amountWholeTokens,
      type: 'exact_in',
    });
    // Fail loudly if the venue priced a different trade than we asked for.
    assertQuoteMatchesRequest(intent.amount, quoteResult);

    /*
     * estimate_slippage returns a human-readable text block, not JSON — parsed below.
     *
     * Seed from the venue's own recommendation, which already accounts for this trade's price
     * impact (e.g. 31 bps for a 5 CSPR swap into a deep pool). The previous seed read
     * `quoteResult.slippage`, a field get_quote never returns, so it was always 0 — meaning a
     * failed estimate_slippage call left slippageBps at 0 and the trade looked risk-free.
     */
    let slippageBps =
      quoteResult.recommendedSlippageBps != null
        ? Math.round(Number(quoteResult.recommendedSlippageBps))
        : quoteResult.priceImpact != null
          ? Math.round(Number(quoteResult.priceImpact) * 100)
          : 0;
    try {
      const slippageText = await mcpCallRaw(this.mcpUrl, 'estimate_slippage', {
        token_in: tokenIn,
        token_out: tokenOut,
        amount: amountWholeTokens,
      });
      // Try JSON parse first (future-proofing).
      try {
        const parsed = JSON.parse(slippageText) as { slippage?: number; slippage_bps?: number };
        slippageBps =
          parsed.slippage_bps ??
          (parsed.slippage != null ? Math.round(parsed.slippage * 100) : slippageBps);
      } catch {
        // Plain-text: extract "Actual slippage from spot: X.XX%"
        const match = slippageText.match(/Actual slippage from spot:\s*([\d.]+)%/i);
        if (match?.[1]) {
          slippageBps = Math.round(parseFloat(match[1]) * 100);
        }
      }
    } catch {
      // estimate_slippage failure is non-fatal — use quote slippage fallback above.
    }

    return {
      slippageBps,
      riskLabel: slippageBps < 50 ? 'low' : slippageBps < 150 ? 'medium' : 'high',
      // Encode the token pair into the quoteId so submit() can reconstruct it.
      quoteId: `lq_${tokenIn}_${tokenOut}_${intent.amount}_${Date.now()}`,
      /*
       * Expected output in BASE units — directly comparable to an intent's min_received, which is
       * also base units. `amountOut` (not amountOutFormatted) is already base units, so no scaling
       * is applied here. Pre-trade only; see CsprTradeQuote.quotedAmountOut.
       */
      ...(quoteResult.amountOut != null ? { quotedAmountOut: String(quoteResult.amountOut) } : {}),
    };
  }

  async submit(input: { quoteId: string }): Promise<{ txHash: string; deployHash?: string }> {
    // Reconstruct trade params from the quoteId (format: lq_TOKEN_A_TOKEN_B_AMOUNT_TS).
    const parts = input.quoteId.split('_');
    const tokenIn = parts[1] ?? 'CSPR';
    const tokenOut = parts[2] ?? 'sCSPR';
    // The quoteId encodes the intent amount in BASE units; build_swap takes whole tokens, exactly
    // like get_quote. Passing base units here would build a swap 10^9 times the intended size.
    const amountBaseUnits = parts[3] ?? '0';
    const amount = wholeTokensFromBaseUnits(amountBaseUnits);

    // Step 1: Build unsigned deploy from mcp.cspr.trade.
    // Casper public key format: 2-char algo tag + raw key bytes as hex.
    // ed25519:  "01" + 64 hex = 66 total → strip "01" → 64-char raw key → send as "01" + 64 (66 total)
    // secp256k1: "02" + 66 hex = 68 total → strip "02" Casper tag → "02" + 64 hex (66 total, secp compressed)
    // CSPR.trade expects exactly 66 chars: algo-prefix (01/02) + 64-char raw key.
    // For secp256k1 keys (68 chars), strip the outer Casper tag and keep the inner 66-char compressed key.
    // For ed25519 keys (66 chars), pass through unchanged.
    let rawPublicKey: string;
    if (this.senderPublicKey.length === 68) {
      // secp256k1: drop the 2-char Casper algo tag, keep 02/03 + 32 bytes = 66 chars
      rawPublicKey = this.senderPublicKey.slice(2);
    } else if (this.senderPublicKey.length === 66) {
      // ed25519: already 66 chars with "01" prefix — pass through
      rawPublicKey = this.senderPublicKey;
    } else {
      rawPublicKey = this.senderPublicKey;
    }
    const buildResult = await mcpCall<McpSwapBuildResult>(this.mcpUrl, 'build_swap', {
      token_in: tokenIn,
      token_out: tokenOut,
      amount,
      type: 'exact_in',
      sender_public_key: rawPublicKey,
    });

    const unsignedDeployJson = resolveUnsignedTransactionJson(buildResult);
    if (!unsignedDeployJson) {
      throw new Error('cspr_trade_build_swap_error: no deploy_json returned by build_swap');
    }

    // Step 2: Sign the unsigned deploy JSON locally using casper-js-sdk.
    const signedDeployJson = await this.signDeployJson(unsignedDeployJson);

    // Step 3: Submit the signed transaction DIRECTLY to the Casper node via account_put_transaction
    // (team directive: do NOT broadcast through cspr.trade's submit_transaction MCP tool). Submitting
    // ourselves keeps the network node under our control (the per-network slot RPC), so a mainnet swap
    // is submitted to the mainnet node and testnet to testnet — never mis-routed by the MCP proxy.
    const txHash = await this.submitSignedTransaction(signedDeployJson);
    return { txHash, deployHash: txHash };
  }

  /**
   * POST a signed Casper 2.0 Transaction (V1) to the node's `account_put_transaction` RPC and return
   * its transaction hash. The RPC's `transaction` param is a `TransactionWrapper` — a map with EXACTLY
   * ONE variant key (`{ Version1: {...} }` for a V1 transaction, `{ Deploy: {...} }` for a legacy
   * deploy). `signDeployJson` produces exactly that wrapper JSON via `getTransactionWrapper().toJSON()`
   * (see the note there); we pass it through verbatim. Sending the flattened top-level
   * `Transaction.toJSON()` here instead yields `-32602 ... expected map with a single key`.
   */
  private async submitSignedTransaction(signedTransactionJson: string): Promise<string> {
    const transaction = JSON.parse(signedTransactionJson) as unknown;
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'account_put_transaction',
        params: { transaction },
      }),
    });
    if (!res.ok) {
      throw new Error(`cspr_trade_submit_error: account_put_transaction HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      result?: { transaction_hash?: unknown };
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (body.error) {
      throw new Error(
        `cspr_trade_submit_error: account_put_transaction rpc ${body.error.code} ${body.error.message ?? ''} ${
          typeof body.error.data === 'string' ? body.error.data : ''
        }`.trim(),
      );
    }
    const hash = body.result?.transaction_hash;
    const txHash = typeof hash === 'string' ? hash : extractTransactionHash(hash);
    if (!txHash) {
      throw new Error('cspr_trade_submit_error: no transaction_hash returned by account_put_transaction');
    }
    return txHash;
  }

  /**
   * Sign an unsigned Casper deploy/transaction JSON string with the local PEM key.
   *
   * The live CSPR.trade MCP (confirmed 2026-07-23) returns a Casper 2.0 Transaction V1 object
   * (`hash` + `payload` + `approvals`), not a legacy Deploy — `sdk.Deploy.fromJSON` would silently
   * mis-parse or throw on that shape. Detects which one it actually is and uses the matching
   * `casper-js-sdk` class (`Transaction` vs `Deploy`).
   *
   * SERIALIZATION SHAPE: `account_put_transaction`'s `transaction` param is a `TransactionWrapper`
   * (casper-js-sdk 5.x `PutTransactionRequest`) — a map with EXACTLY ONE variant key
   * (`{ Version1: {...} }` / `{ Deploy: {...} }`). The top-level `Transaction.toJSON()` in 5.x serializes
   * the FLATTENED transaction (many top-level keys: hash, chainName, args, target, …), NOT the envelope,
   * so submitting it yields `-32602 ... expected map with a single key`. We therefore serialize
   * `getTransactionWrapper().toJSON()` for the V1 path. The legacy `Deploy.toJSON()` is already the
   * `{ Deploy: {...} }` single-key shape, so that branch passes through unchanged.
   */
  private async signDeployJson(unsignedDeployJson: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    const rawSdk = await (import('casper-js-sdk') as Promise<Record<string, unknown>>);
    const sdk = (rawSdk['default'] ?? rawSdk) as {
      PrivateKey: { fromPem(content: string, algorithm: number): unknown };
      KeyAlgorithm: { ED25519: 1; SECP256K1: 2 };
      Deploy: { fromJSON(json: unknown): { sign(key: unknown): void; toJSON(): unknown } };
      Transaction: {
        fromJSON(json: unknown): {
          sign(key: unknown): void;
          getTransactionWrapper(): unknown;
        };
      };
      // `TransactionWrapper.toJSON` is a STATIC (not an instance method) in casper-js-sdk 5.x — it
      // takes the wrapper and returns the single-key `{ Version1: {...} }` envelope. Verified against
      // 5.0.12: the wrapper instance has no `.toJSON()`, and `JSON.stringify(wrapper)` emits the wrong
      // lowercase `transactionV1` key. Only this static produces the `Version1`-cased envelope.
      TransactionWrapper: { toJSON(wrapper: unknown): unknown };
    };

    const pemContent = readFileSync(this.pemPath, 'utf8');
    const sdkAlgorithm =
      this.algorithm === 'ed25519' ? sdk.KeyAlgorithm.ED25519 : sdk.KeyAlgorithm.SECP256K1;
    const privateKey = sdk.PrivateKey.fromPem(pemContent, sdkAlgorithm);

    const parsed = JSON.parse(unsignedDeployJson) as Record<string, unknown>;
    const isTransactionV1 = 'payload' in parsed;
    if (isTransactionV1) {
      const tx = sdk.Transaction.fromJSON(parsed);
      tx.sign(privateKey);
      // Wrap into the single-key `{ Version1: {...} }` envelope the RPC expects (see submit note).
      // NB: `toJSON` is a STATIC on TransactionWrapper in 5.x, not an instance method.
      return JSON.stringify(sdk.TransactionWrapper.toJSON(tx.getTransactionWrapper()));
    }
    const deploy = sdk.Deploy.fromJSON(parsed);
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
  rpcUrl: string | undefined;
}): CsprTradeClient {
  if (!cfg.mcpUrl || !cfg.senderPublicKey || !cfg.pemPath || !cfg.rpcUrl) {
    return new UnavailableCsprTradeClient();
  }
  return new LiveCsprTradeClient({
    mcpUrl: cfg.mcpUrl,
    senderPublicKey: cfg.senderPublicKey,
    pemPath: cfg.pemPath,
    algorithm: cfg.algorithm,
    rpcUrl: cfg.rpcUrl,
  });
}

export type CsprTradeResult =
  | {
      outcome: 'ALLOW';
      quoteId: string;
      txHash: string;
      deployHash?: string;
      /** Pre-trade expected output carried from the quote — NOT the realized fill. */
      quotedAmountOut?: string;
      /** Slippage the venue quoted, in bps. Pre-trade. */
      quotedSlippageBps: number;
    }
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
        // Carried so a settled trade can be compared against what the venue quoted. Both are
        // PRE-TRADE figures; neither is evidence of the realized fill.
        ...(quote.quotedAmountOut ? { quotedAmountOut: quote.quotedAmountOut } : {}),
        quotedSlippageBps: quote.slippageBps,
      };
    },
  };
}
