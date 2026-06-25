import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueAdminKey, newApiKeyId, newMembershipId, newOrgId } from '../../../lib/ids.js';
import { resolveSessionUserId } from '../account/session-store.js';
import { authForRoute } from '../access/route-guard.js';
import { seedDefaultOrgPolicies } from '../../control/default-policies.js';

/**
 * Org creation — the one place a human bootstraps a tenant. The caller authenticates with a SESSION
 * cookie only (org creation is a human action, never a machine key). Critically, a brand-new user has
 * ZERO memberships, so we use the `resolveSessionUserId` bootstrap seam rather than
 * `authenticatePrincipal` (which 403s a member-less session). We then, in ONE transaction:
 *   1. createOrg with admin_key_hash = sha256(sk_)            (the legacy single-key column)
 *   2. insert the SAME hash into api_keys (label 'default')   (the new rotatable home)
 *   3. make the caller OWNER
 * The api_keys row and orgs.admin_key_hash carry the IDENTICAL key_hash, so there is exactly ONE logical
 * credential: the P1c resolver finds it via api_keys; if it is later revoked, the legacy fallback never
 * re-authenticates it (the revocation gate in principal.ts). The raw sk_ is returned exactly once here
 * and never again. The transaction guarantees no half-created org can exist without its owner + key.
 *
 * After the org commits we seed a DEFAULT policy baseline (one org-scoped spend + allocation layer) so
 * the effective-policy compiler always has a layer to intersect — without it a self-serve org's agents
 * fail closed with 500 on every policy read / float provision / authorize. This is post-commit (it locks
 * the org row FOR UPDATE, which must already be visible); a seeding failure surfaces as 500 but the org
 * is recoverable.
 */
const CreateOrgBody = z.object({ name: z.string().min(1).max(200) });

export function registerOrgRoutes(app: FastifyInstance): void {
  app.post('/v1/orgs', async (request, reply) => {
    const { pg: pool, env, redis } = app.deps;

    // Authenticate the session WITHOUT a membership requirement (first-org bootstrap).
    const userId = await resolveSessionUserId(pool, request.headers.cookie, env.SESSION_COOKIE_NAME);
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });

    const parsed = CreateOrgBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    // Mint the org's single admin key ONCE. Its hash is the single logical credential, stored in BOTH
    // orgs.admin_key_hash and api_keys.key_hash. The plaintext is returned once below, never persisted.
    const adminKey = issueAdminKey();
    const orgId = newOrgId();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO orgs (id, name, admin_key_hash) VALUES ($1, $2, $3)', [
        orgId,
        parsed.data.name,
        adminKey.hash,
      ]);
      await client.query('INSERT INTO memberships (id, user_id, org_id, role) VALUES ($1,$2,$3,$4)', [
        newMembershipId(),
        userId,
        orgId,
        'owner',
      ]);
      // Same key_hash as orgs.admin_key_hash → one logical key, revocable in the new model.
      await client.query(
        `INSERT INTO api_keys (id, org_id, key_hash, label, prefix, created_by)
         VALUES ($1,$2,$3,'default','sk_live',$4)`,
        [newApiKeyId(), orgId, adminKey.hash, userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Working default policy baseline (post-commit; needs the org row visible). Without it every
    // downstream policy/provision/authorize for this org's agents fails closed at the compiler.
    // Use Casper operator account hash as the float destination fence. Falls back to the legacy EVM
    // agent-float address if the Casper hash is not configured, so the Arc rail still works.
    const floatDestination =
      env.CASPER_OPERATOR_ACCOUNT_HASH !== ''
        ? env.CASPER_OPERATOR_ACCOUNT_HASH
        : env.AGENT_FLOAT_PRIVATE_KEY;
    await seedDefaultOrgPolicies(pool, redis, {
      orgId,
      operatorAccountHash: floatDestination,
    });

    return reply
      .code(201)
      .send({ org: { id: orgId, name: parsed.data.name }, role: 'owner', api_key: adminKey.token });
  });

  // Reseed the org's default policies with the current env values (Casper mote units + operator
  // account hash). Needed when an org was created before the Casper migration. Admin+ only.
  app.post('/v1/orgs/reseed-policies', async (request, reply) => {
    const { pg: pool, env, redis } = app.deps;
    const auth = await authForRoute(app, request, 'admin');
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.reason });

    const floatDestination =
      env.CASPER_OPERATOR_ACCOUNT_HASH !== ''
        ? env.CASPER_OPERATOR_ACCOUNT_HASH
        : env.AGENT_FLOAT_PRIVATE_KEY;
    await seedDefaultOrgPolicies(pool, redis, {
      orgId: auth.principal.orgId,
      operatorAccountHash: floatDestination,
    });
    return reply.code(200).send({ reseeded: true, destination: floatDestination });
  });
}
