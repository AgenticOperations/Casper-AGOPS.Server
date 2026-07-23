import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import { pingPg } from './db/client.js';
import { pingRedis } from './redis/client.js';
import type { GatewayClient } from './lib/circle/gateway.js';
import { registerMonitoringRoutes } from './engines/monitoring/routes.js';
import { registerControlRoutes } from './engines/control/routes.js';
import { registerTreasuryRoutes } from './engines/control/treasury-routes.js';
import { registerPolicyRoutes } from './engines/control/policy-routes.js';
import { registerReportsRoutes } from './engines/reports/routes.js';
import { registerAuthRoutes } from './engines/identity/account/auth-routes.js';
import { registerMeRoutes } from './engines/identity/account/me-routes.js';
import { registerOrgRoutes } from './engines/identity/org/org-routes.js';
import { registerMembersRoutes } from './engines/identity/org/members-routes.js';
import { registerAgentLifecycleRoutes } from './engines/identity/org/agent-routes.js';
import { registerApiKeyRoutes } from './engines/identity/access/api-key-routes.js';
import { registerEmailRoutes } from './engines/identity/account/email-routes.js';
import { registerOAuthRoutes } from './engines/identity/oauth/oauth-routes.js';
import {
  createGoogleClient,
  googleConfigFromEnv,
  type GoogleClient,
} from './engines/identity/oauth/google.js';
import { DevLogEmailTransport, type EmailTransport } from './lib/email/transport.js';
import { registerDemoRoutes } from './engines/demo/routes.js';
import {
  registerCasperGuardRoutes,
  type CasperGuardDeps,
} from './engines/casper-guard/routes.js';
import { registerCasperGuardMcpRoute } from './engines/casper-guard/mcp.js';

export interface AppDeps {
  env: Env;
  pg: pg.Pool;
  redis: Redis;
  /** E5/E6 treasury surface (F2). Absent in unit/HTTP harness → treasury routes fail closed 503. Live Circle wired in server.ts at M9. */
  gateway?: GatewayClient;
  /** P1 email seam. Optional — buildApp defaults a dev log transport; tests inject a capturing one. */
  email?: EmailTransport;
  /**
   * P1 Google OAuth client (the injectable seam). Optional — buildApp defaults the live fetch-backed
   * client from env (which reports `configured:false`, and the routes answer 501, when GOOGLE_* is
   * unset). Tests inject a fake so the OAuth flow never touches the network.
   */
  googleOAuth?: GoogleClient;
  /** CasperHacks product surface. Absent means routes report explicit unconfigured status/fail closed. */
  casperGuard?: CasperGuardDeps;
  /** Optional log destination; tests inject a capturing stream to assert redaction. */
  logStream?: { write(msg: string): void };
}

/**
 * Build the Fastify application with its dependencies injected.
 *
 * Kept separate from {@link import('./server.js')} so tests can drive the full HTTP
 * surface with `app.inject(...)` against Testcontainers-backed Postgres and Redis,
 * with no network listener.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      // Never serialize raw signature bytes or secrets into logs (doc 01 §6).
      redact: {
        paths: ['req.headers.authorization', '*.signature', '*.x_payment', '*.privateKey'],
        censor: '[redacted]',
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // Fastify generates a request id; we surface it for the audit trail.
    disableRequestLogging: false,
  });

  app.decorate('deps', deps);

  // P1 email seam: default to a dev transport that LOGS the verify/reset link (no provider needed) so
  // the flows work end to end locally. Production swaps in a real SMTP/provider transport via deps.email.
  if (!deps.email) deps.email = new DevLogEmailTransport(app.log);

  // P1 Google OAuth seam: default the live fetch-backed client from env. When GOOGLE_* is unconfigured
  // this client reports `configured:false` and the routes answer 501 (feature off) — never a crash, and
  // email+password auth is unaffected. Tests inject a fake client to drive the flow without a network.
  if (!deps.googleOAuth) deps.googleOAuth = createGoogleClient(googleConfigFromEnv(deps.env));

  // Centralized error handler — a thrown/propagated error must NEVER serialize its message into the
  // response body (a pg error message can leak schema, SQL, or connection internals). For any 5xx we
  // log the full error server-side (pino) and return a generic body. Errors that carry an explicit
  // sub-500 statusCode (Fastify validation → 400; route-thrown 4xx) keep their intended status and the
  // standard Fastify/route body — only 5xx bodies are genericized.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      // Full detail stays server-side only; redaction config (above) keeps secrets out of the line.
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error' });
    }
    // Sub-500: preserve the existing contract (validation errors, explicit 4xx) — let Fastify
    // serialize the error as it would by default.
    return reply.send(err);
  });

  // Liveness + readiness. /healthz is liveness (process up); /readyz proves the
  // hot-path stores are reachable. Orchestrators distinguish the two.
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const [db, redis] = await Promise.allSettled([pingPg(deps.pg), pingRedis(deps.redis)]);
    const dbOk = db.status === 'fulfilled' && db.value;
    const redisOk = redis.status === 'fulfilled' && redis.value;
    const ready = dbOk && redisOk;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      checks: { postgres: dbOk, redis: redisOk },
    });
  });

  // E8 Monitoring — read-side decision feed + the P1-actuated graded brakes (off the hot path).
  registerMonitoringRoutes(app);
  // E1 Control — Group A read surface (org summary). Off the hot path; admin-key authed.
  registerControlRoutes(app);
  // E5/E6 Treasury — Group A admin surface (fund org, provision/top up floats, account). Off the hot path.
  registerTreasuryRoutes(app);
  // E1/Control — Policy read/write surface (A1: GET effective policy; A2/A3 added in later tasks).
  registerPolicyRoutes(app);
  // E4/Ledger — Group C reports read surface (statements + immutable audit export). Off the hot path; admin-key authed.
  registerReportsRoutes(app);
  // P1 Identity — human self-serve auth (register/login/logout). Sessions are httpOnly cookies.
  registerAuthRoutes(app);
  // P1 Identity — current-user + memberships (org switcher) and org bootstrap (first-org create).
  registerMeRoutes(app);
  registerOrgRoutes(app);
  // P1 Identity — member management (Members & RBAC): list, invite (OWNER), accept (session), role/remove
  // (OWNER, last-owner protected). Tenant-fenced; invitations are single-use TTL'd sha256 tokens.
  registerMembersRoutes(app);
  // P1 Identity — rotatable org API-key lifecycle (issue/list/revoke, admin+, tenant-fenced).
  registerApiKeyRoutes(app);
  // P1 Identity — email verification + password reset (single-use TTL'd tokens; reset revokes sessions).
  registerEmailRoutes(app);
  // P1 Identity — Google OAuth (OIDC code flow, state CSRF, credential-gated; 501 when GOOGLE_* unset).
  registerOAuthRoutes(app);
  // P1 Identity — agent lifecycle (create/rename/retire/rotate-key, admin+, tenant-fenced). ag_ shown once.
  registerAgentLifecycleRoutes(app);
  // CasperHacks — AgentOps policy/firewall/audit product surface.
  registerCasperGuardRoutes(app);
  registerCasperGuardMcpRoute(app);
  // Demo orchestration surface (M9, doc 04 §5). Env-gated — never registered in production.
  if (deps.env.DEMO_ENABLED === 'true') registerDemoRoutes(app);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
