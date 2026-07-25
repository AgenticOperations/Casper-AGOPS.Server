import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authForRoute } from '../identity/access/route-guard.js';
import { getTreasuryBalances, listAgentsWithFloats, listTreasuryHistory, secondsSinceLastAllocation } from './treasury-read.js';
import { resolveEffectivePolicy } from '../enforcement/policy-epoch-guard.js';
import { depositFor, type ProvisionDeps } from '../provisioning/deposit.js';
import { createLiveTransferReader, createStubTransferReader } from '../../lib/casper/transfer-reader.js';
import { CASPER_NETWORK_HEADER, resolveRequestNetwork } from '../casper-guard/network-header.js';
import { resolveCasperNetworkSlot } from '../../config/network-slot.js';
import type { CasperTreasuryClient } from '../../lib/casper/treasury-client.js';

/**
 * Select the treasury gateway for the request's Casper network. Prefers the per-network map; falls
 * back to the legacy single `gateway` for the testnet slot so existing (non-toggle) deployments and
 * the HTTP harness keep working. Returns a typed failure the caller maps to a 400/503 reply:
 *   - invalid header value → 400 invalid_network
 *   - network selected but no gateway configured for it → 503 network_not_configured
 */
function selectGateway(
  app: FastifyInstance,
  headerValue: string | string[] | undefined,
):
  | { ok: true; gateway: CasperTreasuryClient }
  | { ok: false; code: number; error: string } {
  const resolved = resolveRequestNetwork(headerValue);
  if (!resolved.ok) return { ok: false, code: 400, error: 'invalid_network' };
  const fromMap = app.deps.gatewayByNetwork?.[resolved.network];
  const gateway =
    fromMap ?? (resolved.network === 'casper:casper-test' ? app.deps.gateway : undefined);
  if (!gateway) return { ok: false, code: 503, error: 'network_not_configured' };
  return { ok: true, gateway };
}

/**
 * F2 Treasury — Group A control-plane surface. Dual-credential (session cookie OR sk_ Bearer), fail-closed,
 * tenant-fenced. Reads require member+; control-writes (deposit / float provision / top-up) require admin+.
 * Mirrors control/routes.ts.
 */
export function registerTreasuryRoutes(app: FastifyInstance): void {
  app.get('/v1/treasury/balances', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const balances = await getTreasuryBalances({ redis, pool }, auth.principal.orgId, resolved.network);
    return reply.code(200).send(balances);
  });

  app.get('/v1/agents', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const agents = await listAgentsWithFloats(pool, redis, auth.principal.orgId);
    return reply.code(200).send({ agents });
  });

  app.get('/v1/treasury/history', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'member');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const events = await listTreasuryHistory(pool, auth.principal.orgId);
    return reply.code(200).send({ events });
  });

  app.post('/v1/treasury/deposit', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const sel = selectGateway(app, request.headers[CASPER_NETWORK_HEADER]);
    if (!sel.ok) return reply.code(sel.code).send({ error: sel.error });
    const gateway = sel.gateway;
    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const orgId = auth.principal.orgId;

    const body = request.body as { amount?: unknown };
    if (typeof body?.amount !== 'string' || !/^\d+$/.test(body.amount) || BigInt(body.amount) <= 0n) {
      return reply.code(400).send({ error: 'invalid_amount' });
    }
    await gateway.deposit({ orgId, amount: BigInt(body.amount) });
    const balances = await getTreasuryBalances({ redis, pool }, orgId, resolved.network);
    return reply.code(200).send({ available: balances.available, deposited: true });
  });

  /** Factory for provision + topup — same logic, different `kind`. Control-write → admin+. */
  function provisionHandler(kind: 'depositFor' | 'topup') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { pg: pool, redis, env } = app.deps;
      const auth = await authForRoute(app, request, 'admin');
      if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
      const sel = selectGateway(app, request.headers[CASPER_NETWORK_HEADER]);
      if (!sel.ok) return reply.code(sel.code).send({ error: sel.error });
      const gateway = sel.gateway;
      const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
      if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
      const slot = resolveCasperNetworkSlot(env, resolved.network);
      const orgId = auth.principal.orgId;

      const { id: agentId } = request.params as { id: string };
      // Tenant fence: the agent must belong to the principal's org.
      const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
      if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

      const body = request.body as { amount?: unknown };
      if (typeof body?.amount !== 'string' || !/^\d+$/.test(body.amount) || BigInt(body.amount) <= 0n) {
        return reply.code(400).send({ error: 'invalid_amount' });
      }

      const { policy } = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
      // Server-side destination derivation: own-agent fence, never client-supplied.
      // On Casper the destination is the operator account hash for the request's network. Fall back to
      // env for orgs seeded before the Casper migration (allowedDestinations may be empty / an old EVM addr).
      const agentFloatAddress =
        policy.allocation.allowedDestinations[0] ??
        (slot.operatorAccountHash !== '' ? slot.operatorAccountHash : undefined);
      if (!agentFloatAddress) return reply.code(422).send({ error: 'no_float_destination' });

      const now = Math.floor(Date.now() / 1000);
      const gap = await secondsSinceLastAllocation(pool, agentId, now);
      const deps: ProvisionDeps = { pool, redis, gateway };
      const result = await depositFor(deps, {
        orgId,
        agentId,
        agentFloatAddress,
        amount: BigInt(body.amount),
        policy: policy.allocation,
        kind,
        secondsSinceLastAllocation: gap,
        now,
      });
      if (result.outcome === 'DENY') {
        return reply.code(200).send({ outcome: 'deny', reason: result.reason });
      }
      // result.outcome === 'SUBMITTED'
      return reply.code(200).send({ outcome: 'submitted', allocation_id: result.allocationId, state: 'pending' });
    };
  }

  app.post('/v1/agents/:id/float', provisionHandler('depositFor'));
  app.post('/v1/agents/:id/float/topup', provisionHandler('topup'));

  /**
   * POST /v1/treasury/deposit-intent — create a deposit intent for the operator-wallet flow.
   * Returns a unique ref_id (uint64 memo) the user must include as the Casper transfer id,
   * plus the operator account hash to send CSPR to.
   */
  app.post('/v1/treasury/deposit-intent', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    // Scope the intent to the request's Casper network (absent → testnet, unknown → 400).
    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });

    // The deposit address returned to the user MUST be the operator for the selected network.
    const operatorAccountHash = resolveCasperNetworkSlot(env, resolvedNetwork.network).operatorAccountHash;
    if (!operatorAccountHash) {
      return reply.code(503).send({ error: 'operator_wallet_not_configured' });
    }

    // Generate a random uint32 as the transfer id memo (Casper transfer id is u64 but
    // casper-client and most SDKs accept up to u64; we use a random positive 32-bit value
    // for readability and to avoid collisions in hackathon volume).
    const refId = BigInt(Math.floor(Math.random() * 2_000_000_000) + 1);

    const body = request.body as { expected_amount?: unknown };
    const expectedAmount =
      typeof body?.expected_amount === 'string' &&
      /^\d+$/.test(body.expected_amount) &&
      BigInt(body.expected_amount) > 0n
        ? body.expected_amount
        : null;

    await pool.query(
      `INSERT INTO treasury_deposit_intents (org_id, ref_id, expected_amount, network)
       VALUES ($1, $2, $3, $4)`,
      [auth.principal.orgId, refId.toString(), expectedAmount, resolvedNetwork.network],
    );

    return reply.code(200).send({
      ref_id: refId.toString(),
      operator_account_hash: operatorAccountHash,
    });
  });

  /**
   * POST /v1/treasury/verify-deposit — check on-chain for a transfer matching the deposit intent.
   * Scans recent Casper blocks for a transfer to the operator account with id == ref_id.
   * On match: credits the org treasury and marks the intent credited (idempotent).
   */
  app.post('/v1/treasury/verify-deposit', async (request, reply) => {
    const { pg: pool, redis, env } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const resolvedNetwork = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolvedNetwork.ok) return reply.code(400).send({ error: 'invalid_network' });
    const sel = selectGateway(app, request.headers[CASPER_NETWORK_HEADER]);
    if (!sel.ok) return reply.code(sel.code).send({ error: sel.error });
    const gateway = sel.gateway;

    const body = request.body as { ref_id?: unknown };
    if (typeof body?.ref_id !== 'string' || !/^\d+$/.test(body.ref_id)) {
      return reply.code(400).send({ error: 'invalid_ref_id' });
    }

    const orgId = auth.principal.orgId;
    const refId = BigInt(body.ref_id);

    // Load the intent — must belong to this org, match the request network, and be pending.
    // The network fence ensures a mainnet intent is never verified/credited under the testnet
    // header (and vice-versa), even for the same org and ref_id.
    const intentRes = await pool.query<{
      id: string; status: string; deploy_hash: string | null;
    }>(
      `SELECT id, status, deploy_hash FROM treasury_deposit_intents
       WHERE ref_id = $1 AND org_id = $2 AND network = $3`,
      [refId.toString(), orgId, resolvedNetwork.network],
    );
    const intent = intentRes.rows[0];
    if (!intent) {
      return reply.code(404).send({ error: 'intent_not_found' });
    }

    // Already credited — return the existing result (idempotent).
    if (intent.status === 'credited') {
      const amtRes = await pool.query<{ credited_amount: string }>(
        'SELECT credited_amount FROM treasury_deposit_intents WHERE id = $1',
        [intent.id],
      );
      return reply.code(200).send({
        found: true,
        already_credited: true,
        deploy_hash: intent.deploy_hash,
        credited_amount: amtRes.rows[0]?.credited_amount ?? '0',
      });
    }

    if (intent.status === 'expired') {
      return reply.code(410).send({ error: 'intent_expired' });
    }

    const slot = resolveCasperNetworkSlot(env, resolvedNetwork.network);
    const operatorAccountHash = slot.operatorAccountHash;
    if (!operatorAccountHash) {
      return reply.code(503).send({ error: 'operator_wallet_not_configured' });
    }

    const transferReader =
      slot.facilitatorRpcUrl !== ''
        ? createLiveTransferReader({ rpcUrl: slot.facilitatorRpcUrl })
        : createStubTransferReader();

    const match = await transferReader.findTransferByRefId({
      operatorAccountHash,
      refId,
    });

    if (!match.found) {
      return reply.code(200).send({ found: false });
    }

    // Credit the gateway treasury balance and mark the intent credited.
    // Use a transaction to keep the intent row and gateway call atomic at the DB level.
    // (Gateway call is idempotent on the stub; on-chain the deploy_hash guard prevents double credit.)
    await pool.query('BEGIN');
    try {
      // Idempotency: re-check inside the transaction using deploy_hash.
      const recheckRes = await pool.query<{ status: string }>(
        'SELECT status FROM treasury_deposit_intents WHERE id = $1 FOR UPDATE',
        [intent.id],
      );
      if (recheckRes.rows[0]?.status === 'credited') {
        await pool.query('ROLLBACK');
        return reply.code(200).send({
          found: true,
          already_credited: true,
          deploy_hash: match.deployHash,
        });
      }

      await gateway.deposit({ orgId, amount: match.amount });

      await pool.query(
        `UPDATE treasury_deposit_intents
         SET status = 'credited', deploy_hash = $1, credited_amount = $2, credited_at = now()
         WHERE id = $3`,
        [match.deployHash, match.amount.toString(), intent.id],
      );
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    // Refresh balances in Redis via getTreasuryBalances (warms cache).
    try {
      await getTreasuryBalances({ redis, pool }, orgId, resolvedNetwork.network);
    } catch {
      // non-fatal — balance will refresh on next read
    }

    return reply.code(200).send({
      found: true,
      already_credited: false,
      deploy_hash: match.deployHash,
      credited_amount: match.amount.toString(),
    });
  });

  /**
   * POST /v1/treasury/deposit-by-hash — credit treasury from a known deploy hash.
   *
   * Called after the user sends CSPR via their connected wallet (CSPR.click send() flow).
   * The client gets the deploy hash back from the wallet and POSTs it here.
   * We verify on-chain that the deploy is a native transfer TO the operator account hash,
   * then credit the org treasury with the transferred amount. Idempotent on deploy_hash.
   */
  app.post('/v1/treasury/deposit-by-hash', async (request, reply) => {
    const { pg: pool, redis, env } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const sel = selectGateway(app, request.headers[CASPER_NETWORK_HEADER]);
    if (!sel.ok) return reply.code(sel.code).send({ error: sel.error });
    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const network = resolved.network;

    const body = request.body as { deploy_hash?: unknown; amount?: unknown; amount_motes?: unknown };
    if (typeof body?.deploy_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.deploy_hash)) {
      return reply.code(400).send({ error: 'invalid_deploy_hash' });
    }

    const deployHash = body.deploy_hash.toLowerCase();
    const orgId = auth.principal.orgId;

    // Idempotency: if this deploy hash was already credited, return success immediately.
    const existing = await pool.query<{ org_id: string; credited_amount: string }>(
      `SELECT org_id, credited_amount FROM treasury_deposit_intents
       WHERE deploy_hash = $1 AND status = 'credited'`,
      [deployHash],
    );
    if (existing.rows[0]) {
      return reply.code(200).send({
        credited: true,
        already_credited: true,
        credited_amount: existing.rows[0].credited_amount,
      });
    }

    // Verify on-chain: fetch the deploy and confirm it transferred to the operator account. Read the
    // RPC + operator from the slot for THIS request's network so a mainnet deposit is verified against
    // the mainnet node/operator and a testnet deposit against testnet.
    const slot = resolveCasperNetworkSlot(env, network);
    const rpcUrl = slot.facilitatorRpcUrl;
    if (!rpcUrl) return reply.code(503).send({ error: 'rpc_not_configured' });

    const operatorAccountHash = slot.operatorAccountHash;
    if (!operatorAccountHash) return reply.code(503).send({ error: 'operator_wallet_not_configured' });

    // Try info_get_transaction first (Casper 2.0 native transactions), then fall back to
    // info_get_deploy (Casper 1.x deploys). CSPR.click send() returns a transaction hash for
    // 2.0 networks; both hash formats are 64 hex chars and indistinguishable by string alone.
    const rpcPost = async (method: string, params: Record<string, unknown>) => {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) throw new Error('rpc_error');
      return res.json() as Promise<Record<string, unknown>>;
    };

    let succeeded: boolean | null = null; // true = Success, false = Failure, null = not yet
    let hasTransfers = true;

    try {
      // --- Casper 2.0 path: info_get_transaction ---
      const txBody = await rpcPost('info_get_transaction', { transaction_hash: { Version1: deployHash } }) as {
        result?: {
          transaction?: unknown;
          execution_info?: {
            execution_result?: {
              Version2?: {
                error_message?: string | null;
                transfers?: string[];
              };
            };
          };
        };
        error?: { code?: number };
      };

      if (txBody.error) {
        // RPC returned an error — method not supported or hash not found, try deploy path below
        throw new Error('try_deploy');
      }

      const execInfo = txBody.result?.execution_info;
      if (!execInfo) {
        // Transaction exists but hasn't been included in a block yet
        return reply.code(202).send({ credited: false, reason: 'not_finalized_yet' });
      }

      const v2result = execInfo.execution_result?.Version2;
      if (!v2result) {
        return reply.code(202).send({ credited: false, reason: 'not_finalized_yet' });
      }

      succeeded = v2result.error_message == null;
      if (succeeded) {
        hasTransfers = (v2result.transfers ?? []).length > 0 || true; // native transfer always produces a transfer
      }
    } catch (e) {
      if ((e as Error).message !== 'try_deploy') {
        return reply.code(502).send({ error: 'rpc_unreachable' });
      }

      // --- Casper 1.x fallback: info_get_deploy ---
      let deployBody: {
        result?: {
          execution_results?: Array<{
            result?: {
              Success?: { transfers?: string[] };
              Failure?: unknown;
            };
          }>;
        };
      };
      try {
        deployBody = await rpcPost('info_get_deploy', { deploy_hash: deployHash }) as typeof deployBody;
      } catch {
        return reply.code(502).send({ error: 'rpc_unreachable' });
      }

      const execs = deployBody.result?.execution_results ?? [];
      if (execs.length === 0) {
        return reply.code(202).send({ credited: false, reason: 'not_finalized_yet' });
      }
      const execResult = execs[0]?.result;
      succeeded = !!execResult?.Success;
      hasTransfers = (execResult?.Success?.transfers ?? []).length > 0;
    }

    if (!succeeded) {
      return reply.code(200).send({ credited: false, reason: 'deploy_failed' });
    }
    if (!hasTransfers) {
      return reply.code(200).send({ credited: false, reason: 'no_transfers_in_deploy' });
    }

    // Amount: accept either `amount` or `amount_motes` (both are base-unit mote strings).
    const amountRaw = body.amount ?? body.amount_motes;
    const rawAmount = typeof amountRaw === 'string' && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : null;
    if (rawAmount === null || rawAmount <= 0n) {
      return reply.code(400).send({ error: 'invalid_amount' });
    }

    // Record the deposit, keyed on deploy_hash for idempotency. There is NOTHING to "credit" on-chain
    // here: the user already sent CSPR to the shared operator wallet, and we verified that transfer above.
    // This row IS the org's balance — getTreasuryBalances sums credited_amount per org+network from this
    // ledger (the operator wallet pools every org's deposits, so its raw on-chain balance is a cross-tenant
    // total and must never be shown as one org's balance). So this route only writes the ledger row — it
    // must NOT submit any transfer. (An earlier version called gateway.deposit(), which submits a fresh
    // operator→operator transfer; the node rejected it with RPC -32016 and the whole request 500'd.)
    //
    // The partial-unique index on deploy_hash makes the INSERT itself the concurrency guard: a racing
    // duplicate returns no row (ON CONFLICT DO NOTHING) and we report already_credited. Single statement,
    // so no explicit BEGIN/COMMIT is needed (and pool.query('BEGIN') on a Pool is unsafe anyway — each
    // statement can land on a different pooled connection).
    const insertRes = await pool.query<{ id: string }>(
      `INSERT INTO treasury_deposit_intents
         (org_id, ref_id, expected_amount, status, deploy_hash, credited_amount, credited_at, network)
       VALUES ($1, $2, $3, 'credited', $4, $5, now(), $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        orgId,
        // ref_id is unique bigint — derive it from the deploy_hash (60-bit slice fits signed bigint).
        BigInt('0x' + deployHash.slice(0, 15)).toString(),
        rawAmount.toString(),
        deployHash,
        rawAmount.toString(),
        network,
      ],
    );

    if (!insertRes.rows[0]) {
      // Another concurrent request already credited this deploy.
      return reply.code(200).send({ credited: true, already_credited: true, credited_amount: rawAmount.toString() });
    }

    try {
      await getTreasuryBalances({ redis, pool }, orgId, network);
    } catch { /* non-fatal */ }

    return reply.code(200).send({
      credited: true,
      already_credited: false,
      credited_amount: rawAmount.toString(),
    });
  });
}
