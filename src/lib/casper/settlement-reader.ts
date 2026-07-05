import type {
  CasperGuardSettlementRead,
  CasperGuardSettlementReader,
} from '../../engines/casper-guard/reconcile-worker.js';
import type { CasperGuardDecisionRecord } from '../../engines/casper-guard/store.js';
import type { CasperFacilitator } from './facilitator.js';
import type { CsprTradeClient, CsprTradeIntent } from './cspr-trade.js';
import { decodeCasperX402PaymentHeader } from './x402.js';

/** On-chain finality for a single deploy/tx, normalized away from RPC wire shapes. */
export interface DeployFinality {
  found: boolean;
  finalized?: boolean;
  success?: boolean;
  txHash?: string | null;
  error?: string | null;
}

/** Injectable port — the live impl (createLiveDeployReader) hits the node RPC; tests inject a fake. */
export interface DeployReader {
  getDeploy(hash: string): Promise<DeployFinality>;
}

/**
 * Reads settlement finality for a AgentOps decision off-chain via the node RPC.
 *
 * Fail-closed: an unreadable / not-yet-finalized / not-found deploy is `pending`, never `settled`.
 * Expiry is NOT decided here — the reconcile FSM owns expiry (markCasperGuardDecisionExpiryCheck),
 * and the decision record exposes no absolute deadline to this reader.
 */
export function createCasperRpcSettlementReader(port: DeployReader): CasperGuardSettlementReader {
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      const hash = decision.deployHash ?? decision.txHash;
      const source = 'casper-rpc' as const;
      // No hash to chase yet: the agent has not broadcast — pending, never settled.
      if (!hash) {
        return { status: 'pending', source, evidence: { reason: 'no_deploy_hash' }, errorCode: null };
      }

      const fin = await port.getDeploy(hash);
      if (!fin.found) {
        return { status: 'pending', source, evidence: { hash, reason: 'not_found_yet' }, errorCode: null };
      }
      if (!fin.finalized) {
        return { status: 'pending', source, evidence: { hash, reason: 'not_finalized' }, errorCode: null };
      }
      if (fin.success) {
        return {
          status: 'settled',
          source,
          evidence: { hash },
          txHash: fin.txHash ?? hash,
          deployHash: decision.deployHash ?? null,
        };
      }
      return {
        status: 'failed',
        source,
        evidence: { hash, error: fin.error ?? 'execution_error' },
        errorCode: 'execution_error',
      };
    },
  };
}

/**
 * Live DeployReader backed by the Casper node JSON-RPC (`info_get_deploy`).
 *
 * Normalizes the wire `execution_results[].result` ({ Success } | { Failure }) into {@link DeployFinality}.
 * Network/HTTP failures fail-closed to `found: false` → the reader reports `pending` (never `settled`).
 */
export function createLiveDeployReader(cfg: { rpcUrl: string }): DeployReader {
  return {
    async getDeploy(hash: string): Promise<DeployFinality> {
      const cleaned = hash.startsWith('0x') ? hash.slice(2) : hash;
      let res: Response;
      try {
        res = await fetch(cfg.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info_get_deploy', params: { deploy_hash: cleaned } }),
        });
      } catch {
        return { found: false };
      }
      if (!res.ok) return { found: false };
      const body = (await res.json()) as { result?: { execution_results?: unknown[] } };
      const execs = body.result?.execution_results ?? [];
      // A deploy known to the node but not yet executed reports an empty execution_results array.
      if (execs.length === 0) return { found: true, finalized: false, success: false };
      const result =
        (execs[0] as { result?: { Success?: unknown; Failure?: { error_message?: string } } }).result ?? {};
      if ('Success' in result && result.Success) {
        return { found: true, finalized: true, success: true, txHash: cleaned };
      }
      const error = (result as { Failure?: { error_message?: string } }).Failure?.error_message ?? 'execution_error';
      return { found: true, finalized: true, success: false, error };
    },
  };
}

/**
 * Settlement reader for x402-payment decisions that calls the hosted CSPR.cloud facilitator
 * (POST /settle) to submit the transfer_from on-chain, then delegates finality polling to the
 * existing RPC reader.
 *
 * Decision routing:
 * - deploy/tx hash already set → skip facilitator, delegate to RPC reader (idempotent)
 * - actionKind !== 'x402-payment' → skip facilitator, delegate to RPC reader
 * - no hash + x402 → call facilitator.settle(), return result with deployHash
 */
export function createFacilitatorSettlementReader(
  facilitator: CasperFacilitator,
  deployReader: DeployReader,
): CasperGuardSettlementReader {
  const rpcReader = createCasperRpcSettlementReader(deployReader);
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      // Already has a hash — facilitator already ran or operator submitted manually. Poll RPC.
      if (decision.deployHash ?? decision.txHash) {
        return rpcReader.read(decision);
      }
      // Non-x402 actions (casper-deploy, cspr-trade) settle via RPC or operator-wallet, not facilitator.
      if (decision.actionKind !== 'x402-payment') {
        return rpcReader.read(decision);
      }

      // x402 with no hash: call facilitator to submit transfer_from on-chain.
      // Decode the stored PAYMENT-SIGNATURE base64 JWT to get the full x402 payload.
      const headerValue = decision.signedHeaderValue;
      if (!headerValue) {
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason: 'no_signed_header_value' },
          errorCode: 'facilitator_no_header',
        };
      }
      // Decode the Casper x402 PAYMENT-SIGNATURE header using the correct x402 decoder.
      // The header is a structured JWT-style token produced by @make-software/casper-x402,
      // NOT a raw base64(JSON) blob — Buffer.from(value, 'base64') would always throw here.
      let x402Payload: ReturnType<typeof decodeCasperX402PaymentHeader>;
      try {
        x402Payload = decodeCasperX402PaymentHeader(headerValue);
      } catch {
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason: 'header_decode_failed' },
          errorCode: 'facilitator_no_header',
        };
      }
      // `accepted` is the single PaymentRequirements object the client committed to (not an array).
      const accepted = x402Payload.accepted;
      let result: Awaited<ReturnType<CasperFacilitator['settle']>>;
      try {
        console.log('[facilitator-reader] calling settle, decisionId:', decision.decisionId, 'network:', (accepted as Record<string, unknown>)?.network, 'amount:', (accepted as Record<string, unknown>)?.amount);
        result = await facilitator.settle({ payload: x402Payload, requirements: accepted });
        console.log('[facilitator-reader] settle result:', JSON.stringify(result));
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('[facilitator-reader] settle threw:', reason);
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason },
          errorCode: 'facilitator_error',
        };
      }

      if (!result.success) {
        console.error('[facilitator-reader] facilitator returned failure:', result.reason);
        return {
          status: 'failed',
          source: 'facilitator',
          evidence: { reason: result.reason ?? 'unknown' },
          errorCode: result.reason ?? 'facilitator_settle_failed',
        };
      }

      // Facilitator submitted on-chain. Return settled with the deploy hash so the reconcile
      // worker's settleSignedDecision() can write it to the DB.
      return {
        status: 'settled',
        source: 'facilitator',
        evidence: { facilitator_tx: result.txHash },
        deployHash: result.txHash ?? null,
        txHash: result.txHash ?? null,
      };
    },
  };
}

/**
 * Settlement reader for cspr-trade decisions.
 *
 * When no deploy hash is present, calls CsprTradeClient.submit() to execute the swap on-chain
 * and returns the resulting deploy hash as settled. Subsequent reconcile calls (hash already set)
 * delegate to the RPC reader to confirm finality.
 */
export function createCsprTradeSettlementReader(
  client: CsprTradeClient,
  deployReader: DeployReader,
): CasperGuardSettlementReader {
  const rpcReader = createCasperRpcSettlementReader(deployReader);
  return {
    async read(decision: CasperGuardDecisionRecord): Promise<CasperGuardSettlementRead> {
      // Already has a hash — swap was submitted, poll RPC for finality.
      if (decision.deployHash ?? decision.txHash) {
        return rpcReader.read(decision);
      }
      // Only handle cspr-trade; fall through to RPC for anything else.
      if (decision.actionKind !== 'cspr-trade') {
        return rpcReader.read(decision);
      }

      // Extract trade intent stored on the decision to reconstruct the pair/amount.
      // Guard stores the raw intent object with from_asset/to_asset/route_id fields.
      const intentRecord = decision.intent as {
        trade_pair?: string;
        pair?: string;
        route_id?: string;
        from_asset?: { symbol?: string; name?: string };
        to_asset?: { symbol?: string; name?: string };
        amount?: string;
      } | null;
      // Prefer explicit pair fields; fall back to from_asset/to_asset symbols; then route_id.
      let pair: string;
      if (intentRecord?.trade_pair) {
        pair = intentRecord.trade_pair;
      } else if (intentRecord?.pair) {
        pair = intentRecord.pair;
      } else if (intentRecord?.from_asset && intentRecord?.to_asset) {
        const from = intentRecord.from_asset.symbol ?? intentRecord.from_asset.name ?? 'CSPR';
        const to = intentRecord.to_asset.symbol ?? intentRecord.to_asset.name ?? 'sCSPR';
        pair = `${from}/${to}`;
      } else if (intentRecord?.route_id) {
        // route_id format: "CSPR-sCSPR" → "CSPR/sCSPR"
        pair = intentRecord.route_id.replace('-', '/');
      } else {
        pair = 'CSPR/sCSPR';
      }
      const amount = intentRecord?.amount ?? decision.amount;
      const tradeIntent: CsprTradeIntent = { pair, amount };

      let txHash: string;
      let deployHash: string | undefined;
      try {
        console.log('[cspr-trade-reader] calling quote with', JSON.stringify(tradeIntent));
        const quote = await client.quote(tradeIntent);
        console.log('[cspr-trade-reader] quote result:', JSON.stringify(quote));
        const submitted = await client.submit({ quoteId: quote.quoteId });
        console.log('[cspr-trade-reader] submit result:', JSON.stringify(submitted));
        txHash = submitted.txHash;
        deployHash = submitted.deployHash;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('[cspr-trade-reader] quote/submit error:', reason);
        return {
          status: 'failed',
          source: 'operator-wallet',
          evidence: { reason },
          errorCode: 'cspr_trade_submit_failed',
        };
      }

      return {
        status: 'settled',
        source: 'operator-wallet',
        evidence: { tx: txHash },
        txHash,
        deployHash: deployHash ?? txHash,
      };
    },
  };
}

/**
 * Compose a live reader with an operator-supplied body fallback (non-breaking).
 *
 * The live result wins when it is conclusive (settled / failed / expired). A still-`pending` or
 * `ambiguous` live read defers to the operator-supplied body so manual reconcile keeps working.
 */
export function composeSettlementReader(
  live: CasperGuardSettlementReader,
  bodyFallback: () => CasperGuardSettlementRead,
): CasperGuardSettlementReader {
  return {
    async read(decision) {
      const r = await live.read(decision);
      if (r.status === 'pending' || r.status === 'ambiguous') return bodyFallback();
      return r;
    },
  };
}
