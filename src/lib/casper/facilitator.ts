/**
 * Option B: HTTP facilitator client that delegates to a hosted x402 facilitator service
 * (e.g. https://x402-facilitator.cspr.cloud). The facilitator runs ExactCasperScheme on
 * its own funded key — we only POST the payload and get back a deploy hash. No PEM needed here.
 *
 * Wire shape mirrors the reference facilitator (js/examples/facilitator/index.ts):
 *   POST /verify  { paymentPayload, paymentRequirements } → { isValid, invalidReason? }
 *   POST /settle  { paymentPayload, paymentRequirements } → { success, transaction?, errorReason?, errorMessage? }
 */

export interface CasperFacilitator {
  verify(input: { payload: unknown; requirements: unknown }): Promise<{ isValid: boolean; reason?: string }>;
  settle(input: { payload: unknown; requirements: unknown }): Promise<{ success: boolean; txHash?: string; reason?: string }>;
}

type VerifyWire = { isValid: boolean; invalidReason?: string };
type SettleWire = { success: boolean; transaction?: string; errorReason?: string; errorMessage?: string };

/**
 * Build an HTTP facilitator client that calls the hosted CSPR.cloud facilitator.
 * Returns undefined when facilitatorUrl is empty (honest-blocked).
 */
export function buildHttpCasperFacilitator(cfg: {
  facilitatorUrl: string;
  accessToken: string;
}): CasperFacilitator | undefined {
  if (cfg.facilitatorUrl === '') return undefined;
  const base = cfg.facilitatorUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json',
    ...(cfg.accessToken !== '' ? { 'authorization': cfg.accessToken } : {}),
  };

  return {
    async verify({ payload, requirements }) {
      let res: Response;
      try {
        res = await fetch(`${base}/verify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
        });
      } catch (err) {
        return { isValid: false, reason: err instanceof Error ? err.message : 'http_error' };
      }
      if (!res.ok) return { isValid: false, reason: `http_${res.status}` };
      const wire = (await res.json()) as VerifyWire;
      return wire.isValid ? { isValid: true } : { isValid: false, reason: wire.invalidReason ?? 'casper_verify_failed' };
    },

    async settle({ payload, requirements }) {
      let res: Response;
      try {
        res = await fetch(`${base}/settle`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
        });
      } catch (err) {
        return { success: false, reason: err instanceof Error ? err.message : 'http_error' };
      }
      if (!res.ok) return { success: false, reason: `http_${res.status}` };
      const wire = (await res.json()) as SettleWire;
      return wire.success
        ? { success: true, ...(wire.transaction ? { txHash: wire.transaction } : {}) }
        : { success: false, reason: wire.errorMessage ? `${wire.errorReason ?? 'casper_settle_failed'}: ${wire.errorMessage}` : (wire.errorReason ?? 'casper_settle_failed') };
    },
  };
}
