import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Address, TypedDataDomain } from 'viem';
import type { DenyReason, Quote } from '../../contracts/index.js';
import { keys, type SpendWindow } from '../../redis/keyspace.js';
import {
  resolveTokenDomain,
  type KnownTokenRegistry,
  type TokenDomainSource,
} from '../../lib/eip712/domain.js';
import type { KmsSigner } from '../../lib/kms/signer.js';
import { claimGrant } from '../ledger/grant.js';
import { recordDecision } from '../ledger/events.js';
import { releaseHold, reserveHold, snapshotWindows, windowSum } from '../ledger/window.js';
import { resolveEffectivePolicy } from './policy-epoch-guard.js';
import { evaluateSpend } from './spend-eval.js';
import { verifyDomainBinding, type DomainRegistry } from '../identity/domain-binding.js';
import { signAuthorization } from './sign.js';
import { encodeXPayment } from './x-payment.js';

/**
 * E3 enforcement orchestrator — the agent-egress hot-path spine (policy-engine-FINAL.md §4 steps 2-8,
 * engine-specs-FINAL.md:119-140). It runs the 11-step flow's critical section:
 *
 *   1. org `deny_all` kill-switch (BUG-36) — short-circuit before any policy work.
 *   2. resolve the effective policy (capture-at-entry: epoch + immutable version snapshot, NFR-03).
 *   3. read hold-inclusive window utilization + velocity at the QUOTED snapshot.
 *   4. evaluate SpendPolicy deny-by-default; a DENY writes a payment_events audit row and returns.
 *   4b. domain binding (BUG-17) — the vendor domain must publish the quote's payTo (.well-known); a
 *       mismatch is a `destination_unverified` DENY, fail-closed, before any reserve.
 *   5. GRANT CLAIM — atomic NX on (paymentId, resourceId) BEFORE reserving; a lost claim is an
 *      already-authorized replay (DUPLICATE) and never places a second hold.
 *   6. RESERVED — place the hold-inclusive reserve.
 *   7. SIGNED — resolve the EIP-712 domain per rail, sign via agent-float (verify-before-submit), and
 *      encode the X-PAYMENT.
 *   8. BROADCASTING — persist the in-flight record (the nonce leaves in the X-PAYMENT; it must be
 *      remembered so EXPIRY_CHECK can reconcile by on-chain nonce consumption) and return ALLOW.
 *
 * agentOps SIGNS ONLY — custody of the signed header transfers to the agent at the response (BUG-41).
 * Fail-closed throughout: no quote → no spend; the deny path moves no money.
 */

export interface EnforceDeps {
  pool: pg.Pool;
  redis: Redis;
  signer: KmsSigner;
  /** EIP-5267 read seam for raw-x402 domain resolution (viem-backed in L8; stubbed under Docker). */
  tokenDomainSource: TokenDomainSource;
  /** E7 recipient binding (BUG-17): resolves the vendor's published payTo (.well-known); stubbed in tests. */
  domainRegistry: DomainRegistry;
  /** Phase-1 settlement chain id (Arc). circle-nano and raw-x402 both settle on Arc here. */
  chainId: number;
  /** Optional static fallback for tokens that do not implement EIP-5267. */
  knownTokens?: KnownTokenRegistry;
}

export interface EnforceParams {
  agentId: string;
  orgId: string;
  quote: Quote;
  /** The agent-float address holding the float; the EIP-3009 `from`. */
  fromAddress: Address;
  /** Oracle-minted payment id (`pay_…`); the FSM + grant + reserve + audit key. */
  paymentId: string;
  /** QUOTED enforcement time, integer Unix seconds. */
  now: number;
}

export type EnforceResult =
  | { outcome: 'ALLOW'; paymentId: string; xPayment: string }
  | { outcome: 'DENY'; reason: DenyReason }
  | { outcome: 'DUPLICATE'; paymentId: string };

// circle-nano signs against the Circle Gateway with this fixed protocol domain (policy-engine §5); the
// verifyingContract comes from the quote, never hardcoded. The recipient (payTo) is bound to the vendor
// domain by the step-4b Domain Binding Verifier (BUG-17); the token allowlist is a designed-for harden
// item (the EIP-5267 ladder already fails closed on an unresolvable token).
const GATEWAY_DOMAIN_NAME = 'GatewayWalletBatched';
const GATEWAY_DOMAIN_VERSION = '1';

// Sentinel for the audit row of a deny that short-circuits BEFORE the policy is resolved (org_suspended).
const UNRESOLVED_POLICY_REF = 'policy_unresolved@v0';

/** Resolve the EIP-712 domain to sign against, per rail (raw-x402 via EIP-5267 ladder; circle-nano fixed). */
async function resolveQuoteDomain(quote: Quote, deps: EnforceDeps): Promise<TypedDataDomain> {
  if (quote.rail.chain !== 'arc') {
    // Phase-1 settles on Arc only; SPL (Solana) signing is the designed-for seam, not yet wired.
    throw new Error(`unsupported settlement chain for Phase-1 signing: ${quote.rail.chain}`);
  }
  if (quote.rail.scheme === 'circle-nano') {
    return {
      name: GATEWAY_DOMAIN_NAME,
      version: GATEWAY_DOMAIN_VERSION,
      chainId: deps.chainId,
      verifyingContract: quote.verifyingContract as Address,
    };
  }
  // raw-x402: the token's own EIP-712 domain via the EIP-5267 ladder (never hardcoded).
  return resolveTokenDomain(deps.tokenDomainSource, {
    chainId: deps.chainId,
    tokenAddress: quote.verifyingContract as Address,
    ...(deps.knownTokens ? { registry: deps.knownTokens } : {}),
  });
}

export async function enforceSpend(deps: EnforceDeps, params: EnforceParams): Promise<EnforceResult> {
  const { pool, redis, signer } = deps;
  const { agentId, orgId, quote, fromAddress, paymentId } = params;
  const enforcementTs = Math.trunc(params.now);
  const enforcedAt = new Date(enforcementTs * 1000);

  // 1. Kill-switch (BUG-36): a suspended org authorizes nothing — reserve nothing, sign nothing.
  if ((await redis.exists(keys.denyAll(orgId))) === 1) {
    await recordDecision(pool, {
      paymentId,
      agentId,
      orgId,
      rail: quote.rail,
      resourceId: quote.resourceId,
      requested: quote.amount,
      policyRef: UNRESOLVED_POLICY_REF,
      state: 'QUOTED',
      result: 'DENY',
      reasonCode: 'org_suspended',
      enforcementTimestamp: enforcedAt,
    });
    return { outcome: 'DENY', reason: 'org_suspended' };
  }

  // 2. Capture-at-entry: the effective policy snapshot (stale-cache guard self-heals inline, NFR-03).
  const { policy } = await resolveEffectivePolicy(pool, redis, { agentId, orgId });
  const policyRef = policy.policyId;

  // 3. Hold-inclusive window utilization + velocity, at the QUOTED window snapshot (BUG-14).
  const snapshot = snapshotWindows(enforcementTs);
  const [u1h, u1d, u7d, u30d, velocityCount] = await Promise.all([
    windowSum(redis, agentId, '1h', snapshot['1h']),
    windowSum(redis, agentId, '1d', snapshot['1d']),
    windowSum(redis, agentId, '7d', snapshot['7d']),
    windowSum(redis, agentId, '30d', snapshot['30d']),
    redis.zcount(keys.spendWindow(agentId, '1h'), snapshot['1h'], '+inf'),
  ]);
  const windowUtil: Record<SpendWindow, bigint> = { '1h': u1h, '1d': u1d, '7d': u7d, '30d': u30d };

  // 4. SpendPolicy deny-by-default on the captured snapshot. A DENY writes one audit row, moves nothing.
  const decision = evaluateSpend({
    policy: policy.spend,
    amount: quote.amount,
    railScheme: quote.rail.scheme,
    resourceId: quote.resourceId,
    windowUtil,
    velocityCount: Number(velocityCount),
  });
  if (!decision.allow) {
    await recordDecision(pool, {
      paymentId,
      agentId,
      orgId,
      rail: quote.rail,
      resourceId: quote.resourceId,
      requested: quote.amount,
      policyRef,
      state: 'QUOTED',
      result: 'DENY',
      reasonCode: decision.reason,
      enforcementTimestamp: enforcedAt,
    });
    return { outcome: 'DENY', reason: decision.reason };
  }

  // 4b. Domain binding (BUG-17): the vendor domain must publish this payTo. A compromised agent must
  //     not redirect a policy-valid spend to an attacker address. Runs AFTER the cheap SpendPolicy
  //     checks (a denied spend never incurs the registry fetch) and BEFORE any reserve, so the deny
  //     path still moves no money. Fail-closed: an unverifiable destination is DENIED.
  const binding = await verifyDomainBinding(redis, deps.domainRegistry, {
    host: quote.originHost,
    payTo: quote.destination,
  });
  if (!binding.bound) {
    await recordDecision(pool, {
      paymentId,
      agentId,
      orgId,
      rail: quote.rail,
      resourceId: quote.resourceId,
      requested: quote.amount,
      policyRef,
      state: 'QUOTED',
      result: 'DENY',
      reasonCode: binding.reason,
      enforcementTimestamp: enforcedAt,
    });
    return { outcome: 'DENY', reason: binding.reason };
  }

  // 5. GRANT CLAIM (atomic NX), BEFORE the reserve. A lost claim = already authorized → no 2nd hold.
  //    TTL bounds the claim to the quote's validity window.
  const ttl = Math.max(1, quote.validBefore - enforcementTs);
  const won = await claimGrant(redis, paymentId, quote.resourceId, ttl);
  if (!won) return { outcome: 'DUPLICATE', paymentId };

  // 6-8 run AFTER the reserve, so a failure in signing or persistence must roll the hold + grant back —
  // otherwise step 8 never persists the BROADCASTING record, EXPIRY_CHECK can never find the payment to
  // reconcile, and the hold leaks against the cap forever (orphaned budget). Releasing here is correct
  // because no spendable authorization ever leaves the function on a throw (signing failed, or its
  // output never returned), so the payment provably never happened — unlike EXPIRY_CHECK, where a signed
  // header already left and only an on-chain nonce read may free the hold.
  try {
    // 6. RESERVED: hold-inclusive reserve (idempotent; the grant claim already deduped this payment).
    await reserveHold(redis, { agentId, paymentId, amount: quote.amount, enforcementTs });

    // 7. SIGNED: resolve the domain per rail, sign via agent-float, verify-before-submit (BUG-27).
    const domain = await resolveQuoteDomain(quote, deps);
    const { authorization, signature } = await signAuthorization({ signer, quote, fromAddress, domain });
    const xPayment = encodeXPayment({
      scheme: quote.x402Scheme,
      network: quote.x402Network,
      authorization,
      signature,
    });

    // 8. BROADCASTING: persist the in-flight record so EXPIRY_CHECK can reconcile by on-chain nonce.
    //    The nonce exists only here (it left in the X-PAYMENT); it MUST be remembered to settle/expire.
    await redis.hset(keys.payment(paymentId), {
      agent_id: agentId,
      org_id: orgId,
      rail_scheme: quote.rail.scheme,
      rail_chain: quote.rail.chain,
      resource_id: quote.resourceId,
      destination: quote.destination,
      from_address: fromAddress,
      nonce: authorization.nonce,
      requested: quote.amount.toString(),
      policy_ref: policyRef,
      verifying_contract: quote.verifyingContract,
      valid_before: String(quote.validBefore),
      enforcement_ts: String(enforcementTs),
      state: 'BROADCASTING',
    });

    return { outcome: 'ALLOW', paymentId, xPayment };
  } catch (err) {
    // Compensate the reserve + claim so no orphaned budget survives a post-reserve failure.
    await releaseHold(redis, agentId, paymentId);
    await redis.del(keys.grantClaim(paymentId, quote.resourceId));
    throw err;
  }
}
