import type { Address, Hex } from 'viem';
import type { TransferAuthorization } from '../../lib/eip712/eip3009.js';

/**
 * The x402 `X-PAYMENT` header (policy-engine-FINAL.md:205-208). It is the base64url(JSON) encoding of
 * the x402 payment payload that the agent re-submits to the resource server VERBATIM — it is opaque to
 * the agent and to us once minted. agentOps never broadcasts; this header IS the custody transfer
 * (BROADCASTING boundary, BUG-41).
 *
 * `scheme`/`network` are echoed from the server's original `accepts` entry (carried on the Quote), never
 * reconstructed from our internal rail. uint256 fields are stringified — JSON has no bigint and the x402
 * wire represents amounts/timestamps as decimal strings. The header carries the signature (that is the
 * payment) but no raw KEY material, and is never logged (policy-engine-FINAL.md:210).
 */

const X402_VERSION = 1;

export interface XPaymentEnvelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
}

export function encodeXPayment(params: {
  scheme: string;
  network: string;
  authorization: TransferAuthorization;
  signature: Hex;
}): string {
  const { scheme, network, authorization, signature } = params;
  const envelope: XPaymentEnvelope = {
    x402Version: X402_VERSION,
    scheme,
    network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

/** Inverse of {@link encodeXPayment} — used by tests and the L8 live-settle round-trip. */
export function decodeXPayment(header: string): XPaymentEnvelope {
  const json = Buffer.from(header, 'base64url').toString('utf8');
  return JSON.parse(json) as XPaymentEnvelope;
}
