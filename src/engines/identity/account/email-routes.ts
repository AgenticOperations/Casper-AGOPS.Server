import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../../../lib/password.js';
import { findUserByEmail, markEmailVerified, setUserPassword } from './user-store.js';
import { revokeAllUserSessions } from './session-store.js';
import {
  consumeEmailVerificationToken,
  issuePasswordResetToken,
  consumePasswordResetToken,
} from './token-store.js';
import { authRateLimitOk } from './auth-routes.js';

const VerifyBody = z.object({ token: z.string().min(1) });
const RequestResetBody = z.object({ email: z.string().email() });
const ResetBody = z.object({ token: z.string().min(1), password: z.string().min(10).max(200) });

/**
 * Email verification + password reset. Tokens are single-use, TTL'd, hash-only. Reset request is ALWAYS
 * 202 regardless of whether the email exists (no user enumeration). Reset confirm rotates the password
 * AND revokes every existing session for the user (invalidate-on-reset): a previously stolen session
 * cookie must not survive a password reset.
 */
export function registerEmailRoutes(app: FastifyInstance): void {
  app.post('/v1/auth/verify-email', async (request, reply) => {
    const { pg: pool } = app.deps;
    const parsed = VerifyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const consumed = await consumeEmailVerificationToken(pool, parsed.data.token);
    if (!consumed) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    await markEmailVerified(pool, consumed.userId);
    return reply.code(200).send({ email_verified: true });
  });

  app.post('/v1/auth/request-password-reset', async (request, reply) => {
    if (!(await authRateLimitOk(app, request, reply, 'reset_request'))) return reply;
    const { pg: pool, email, env } = app.deps;
    const parsed = RequestResetBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const user = await findUserByEmail(pool, parsed.data.email);
    if (user) {
      const token = await issuePasswordResetToken(pool, user.id);
      await email!.send({
        to: user.email,
        subject: 'Reset your agentOps password',
        kind: 'password_reset',
        link: `${env.APP_BASE_URL}/reset-password?token=${token}`,
      });
    }
    // Always 202 — never reveal whether the email is registered (no user enumeration).
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/v1/auth/reset-password', async (request, reply) => {
    if (!(await authRateLimitOk(app, request, reply, 'reset_confirm'))) return reply;
    const { pg: pool } = app.deps;
    const parsed = ResetBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const consumed = await consumePasswordResetToken(pool, parsed.data.token);
    if (!consumed) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    await setUserPassword(pool, consumed.userId, hashPassword(parsed.data.password));
    // Invalidate-on-reset: kill ALL existing sessions so a stolen cookie can't outlive the reset.
    await revokeAllUserSessions(pool, consumed.userId);
    return reply.code(200).send({ status: 'reset' });
  });
}
