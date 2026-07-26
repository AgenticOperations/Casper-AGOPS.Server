import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authForRoute } from '../access/route-guard.js';
import { grantDelegatedKeyWithVault } from './grant-delegated-key-with-vault.js';
import { attachTradingFlow } from '../../control/attach-trading-flow.js';
import { createPolicyVersion, assignPolicy } from '../../control/store.js';
import { revokeAgentDelegation } from './revoke-agent-delegation.js';
import { suspendAgent } from '../../control/kill-switch.js';
import { revokeDelegatedKey, readActiveDelegatedKeyRow, grantDelegatedKey } from './delegated-keys-store.js';
import { buildGrantDeployForBrowserSigning, buildRevokeDeployForBrowserSigning, accountHashFromPublicKeyHex } from './associated-keys.js';
import { grantWasmBase64, revokeWasmBase64 } from './grant-wasm.js';
import { resolveRequestNetwork, CASPER_NETWORK_HEADER } from '../../casper-guard/network-header.js';
import { markDelegatedKeyGranted } from './delegated-keys-store.js';
import { createLiveAssociatedKeyVerifier } from './verify-associated-key.js';
import { createLiveAssociatedKeyRevokeVerifier } from './verify-associated-key-revoke.js';
import { revokeAgentInFlight } from '../../casper-guard/policy.js';
import type { CompiledTradingFlow } from '../../control/trading-flow.js';

/**
 * F.1: the two SDK/transport surface pieces not already covered by an existing route —
 * createAgent (POST /v1/agents, agent-routes.ts), authorize (casper-guard authorize-x402/
 * authorize-action), and getDecision (casper-guard decisions/:id/status) already exist. This adds
 * attachTradingFlow (Milestone D wiring) and the full delegated-key revoke (Milestones A+C,
 * distinct from the existing "retire" lifecycle flip in agent-routes.ts).
 */
const AttachFlowBody = z.object({
  flow: z.custom<CompiledTradingFlow>((v) => typeof v === 'object' && v !== null),
  role_assignments: z.record(z.string(), z.string()),
});

// Casper public keys are 01=ed25519 or 02=secp256k1 followed by hex.
const GrantInitBody = z.object({
  master_public_key: z.string().regex(/^0[12][0-9a-fA-F]+$/),
});

const GrantConfirmBody = z.object({
  deploy_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  master_public_key: z.string().regex(/^0[12][0-9a-fA-F]+$/).optional(),
});

export function registerDelegationRoutes(app: FastifyInstance): void {
  app.post('/v1/orgs/:id/trading-flows/attach', async (request, reply) => {
    const { pg: pool } = app.deps;
    const { id: orgId } = request.params as { id: string };
    const auth = await authForRoute(app, request, 'admin', orgId);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const parsed = AttachFlowBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    try {
      const result = await attachTradingFlow(
        { pool, createPolicyVersion, assignPolicy },
        { orgId, flow: parsed.data.flow, roleAssignments: parsed.data.role_assignments },
      );
      return reply.code(200).send({ role_assignments: result.roleAssignments });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'attach_failed' });
    }
  });

  app.post('/v1/agents/:id/revoke-delegation', async (request, reply) => {
    const { pg: pool, redis } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };

    const result = await revokeAgentDelegation(
      { pool, redis, suspendAgent, revokeDelegatedKey, revokeAgentInFlight },
      { agentId, orgId: auth.principal.orgId },
    );

    return reply.code(200).send({
      agent_id: agentId,
      agent_suspended: result.agentSuspended,
      aborted_decision_ids: result.abortedDecisionIds,
      committed_decision_ids: result.committedDecisionIds,
    });
  });

  // Task 8: read the agent's delegated-key grant state for the roster UI (badge + Activate/Revoke).
  // Read-only, admin-fenced, tenant-fenced. The delegated key is network-agnostic (SHARED across
  // networks — no network column); this returns only whether a key exists and its grant state.
  app.get('/v1/agents/:id/delegation', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };
    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, auth.principal.orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });
    const row = await readActiveDelegatedKeyRow(pool, agentId);
    if (!row) return reply.code(200).send({ has_key: false, public_key: null, grant_state: null });
    return reply.code(200).send({ has_key: true, public_key: row.publicKey, grant_state: row.grantState });
  });

  /**
   * Provision the proxy-side delegated keypair for an agent that has none.
   *
   * `POST /v1/agents` does this at creation time, but agents can exist without a key — created
   * while no vault was configured, created by an earlier graph deploy that skipped this step, or
   * left keyless by a vault outage. Those agents are otherwise stuck: every on-chain grant attempt
   * answers `no_delegated_key`, and nothing in the product could ever give them one.
   *
   * Idempotent: an agent that already has an ACTIVE key gets that key back rather than a second
   * one, so a double click cannot orphan the first keypair.
   *
   * This generates the AGENT's own keypair inside the vault. It is not a signer and never touches
   * the user's master key — that signs the on-chain grant later, in the browser.
   */
  app.post('/v1/agents/:id/provision-delegated-key', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };

    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [
      agentId,
      auth.principal.orgId,
    ]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const existing = await readActiveDelegatedKeyRow(pool, agentId);
    if (existing) {
      return reply
        .code(200)
        .send({ agent_id: agentId, public_key: existing.publicKey, grant_state: existing.grantState, created: false });
    }

    if (!app.deps.vault) return reply.code(503).send({ error: 'vault_not_configured' });

    try {
      const { publicKey } = await grantDelegatedKeyWithVault(
        { pool, vault: app.deps.vault, grantDelegatedKey },
        { id: `dk_${randomUUID()}`, agentId },
      );
      return reply.code(201).send({ agent_id: agentId, public_key: publicKey, grant_state: 'pending', created: true });
    } catch (err) {
      request.log.error({ err, agentId }, 'delegated-key provisioning failed');
      return reply.code(500).send({ error: 'provision_failed' });
    }
  });

  // D-2②(a): return the UNSIGNED grant deploy args + the WASM bytes (base64) for the browser/SDK
  // to sign. The server signs NOTHING and touches no private-key material — it only derives account
  // hashes from PUBLIC keys. GLOBAL RULE #1.
  app.post('/v1/agents/:id/grant-delegated-key/init', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };
    const orgId = auth.principal.orgId;

    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const parsed = GrantInitBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const chainName = resolved.network.split(':')[1];

    let masterAccountHash: string;
    try {
      masterAccountHash = accountHashFromPublicKeyHex(parsed.data.master_public_key);
    } catch {
      return reply.code(400).send({ error: 'invalid_master_public_key' });
    }

    const row = await readActiveDelegatedKeyRow(pool, agentId);
    if (!row) return reply.code(409).send({ error: 'no_delegated_key' });

    const unsigned = buildGrantDeployForBrowserSigning({
      masterAccountHash,
      agentAccountHash: accountHashFromPublicKeyHex(row.publicKey),
    });

    return reply.code(200).send({
      unsigned_grant: {
        master_account_hash: unsigned.masterAccountHash,
        agent_account_hash: unsigned.agentAccountHash,
        args: unsigned.args,
      },
      wasm_base64: grantWasmBase64(),
      chain_name: chainName,
    });
  });

  // Task 5: confirm the master-signed grant deploy landed on-chain, then promote the delegated key
  // to `granted`. The server signs NOTHING here — it VERIFIES an on-chain result (deploy executed
  // AND agent key associated at weight 1) and flips a DB flag. NO BLIND PROMOTE: a returned deploy
  // hash is NOT proof; promotion requires verifier.ok && weight===1.
  app.post('/v1/agents/:id/grant-delegated-key/confirm', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };
    const orgId = auth.principal.orgId;

    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const parsed = GrantConfirmBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const rpcUrl =
      resolved.network === 'casper:casper'
        ? env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL
        : env.CASPER_GUARD_FACILITATOR_RPC_URL;

    const row = await readActiveDelegatedKeyRow(pool, agentId);
    if (!row) return reply.code(409).send({ error: 'no_delegated_key' });
    // Idempotent: already promoted → return granted without re-verifying.
    if (row.grantState === 'granted') {
      return reply.code(200).send({ agent_id: agentId, grant_state: 'granted' });
    }

    const stubVerifier = app.deps.associatedKeyVerifier;
    if (!stubVerifier && !rpcUrl) return reply.code(503).send({ error: 'rpc_not_configured' });
    const verifier = stubVerifier ?? createLiveAssociatedKeyVerifier();

    const result = await verifier.verify({
      masterAccountHash: parsed.data.master_public_key
        ? accountHashFromPublicKeyHex(parsed.data.master_public_key)
        : '',
      agentAccountHash: accountHashFromPublicKeyHex(row.publicKey),
      deployHash: parsed.data.deploy_hash,
      rpcUrl,
    });

    if (result.ok && result.weight === 1) {
      await markDelegatedKeyGranted(pool, { agentId, deployHash: parsed.data.deploy_hash });
      return reply.code(200).send({ agent_id: agentId, grant_state: 'granted' });
    }
    if (!result.ok && result.reason === 'not_finalized_yet') {
      return reply.code(202).send({ grant_state: 'pending', reason: 'not_finalized_yet' });
    }
    return reply.code(422).send({ error: 'grant_not_confirmed' });
  });

  // D-2④(a): return the UNSIGNED revoke deploy args + the revoke WASM bytes (base64) for the
  // browser/SDK to sign. Mirrors grant-init exactly. The server signs NOTHING — it only derives
  // account hashes from PUBLIC keys. GLOBAL RULE #1.
  app.post('/v1/agents/:id/revoke-delegated-key/init', async (request, reply) => {
    const { pg: pool } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };
    const orgId = auth.principal.orgId;

    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const parsed = GrantInitBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const chainName = resolved.network.split(':')[1];

    let masterAccountHash: string;
    try {
      masterAccountHash = accountHashFromPublicKeyHex(parsed.data.master_public_key);
    } catch {
      return reply.code(400).send({ error: 'invalid_master_public_key' });
    }

    const row = await readActiveDelegatedKeyRow(pool, agentId);
    if (!row) return reply.code(409).send({ error: 'no_delegated_key' });

    const unsigned = buildRevokeDeployForBrowserSigning({
      masterAccountHash,
      agentAccountHash: accountHashFromPublicKeyHex(row.publicKey),
    });

    return reply.code(200).send({
      unsigned_revoke: {
        master_account_hash: unsigned.masterAccountHash,
        agent_account_hash: unsigned.agentAccountHash,
        args: unsigned.args,
      },
      wasm_base64: revokeWasmBase64(),
      chain_name: chainName,
    });
  });

  // D-2④(b): confirm the master-signed REVOKE deploy landed on-chain, then flip the delegated key to
  // REVOKED. The server signs NOTHING — it VERIFIES an on-chain result (deploy executed AND agent key
  // ABSENT from the master's associated_keys) and flips the DB. NO BLIND PROMOTE: a returned deploy
  // hash is NOT proof; revoking requires verifier.ok (key confirmed absent on-chain).
  app.post('/v1/agents/:id/revoke-delegated-key/confirm', async (request, reply) => {
    const { pg: pool, env } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });
    const { id: agentId } = request.params as { id: string };
    const orgId = auth.principal.orgId;

    const owns = await pool.query('SELECT 1 FROM agents WHERE id = $1 AND org_id = $2', [agentId, orgId]);
    if (owns.rowCount === 0) return reply.code(404).send({ error: 'agent_not_found' });

    const parsed = GrantConfirmBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const resolved = resolveRequestNetwork(request.headers[CASPER_NETWORK_HEADER]);
    if (!resolved.ok) return reply.code(400).send({ error: 'invalid_network' });
    const rpcUrl =
      resolved.network === 'casper:casper'
        ? env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL
        : env.CASPER_GUARD_FACILITATOR_RPC_URL;

    const row = await readActiveDelegatedKeyRow(pool, agentId);
    if (!row) return reply.code(409).send({ error: 'no_delegated_key' });

    const stubVerifier = app.deps.associatedKeyRevokeVerifier;
    if (!stubVerifier && !rpcUrl) return reply.code(503).send({ error: 'rpc_not_configured' });
    const verifier = stubVerifier ?? createLiveAssociatedKeyRevokeVerifier();

    const result = await verifier.verify({
      masterAccountHash: parsed.data.master_public_key
        ? accountHashFromPublicKeyHex(parsed.data.master_public_key)
        : '',
      agentAccountHash: accountHashFromPublicKeyHex(row.publicKey),
      deployHash: parsed.data.deploy_hash,
      rpcUrl,
    });

    if (result.ok) {
      await revokeDelegatedKey(pool, { agentId });
      return reply.code(200).send({ agent_id: agentId, status: 'REVOKED' });
    }
    if (!result.ok && result.reason === 'not_finalized_yet') {
      return reply.code(202).send({ status: 'pending', reason: 'not_finalized_yet' });
    }
    return reply.code(422).send({ error: 'revoke_not_confirmed' });
  });
}
