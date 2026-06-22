import casperSdk from 'casper-js-sdk';
import {
  NETWORK_CASPER_TESTNET,
  getNetworkConfig,
  toClientCasperSigner,
} from '@make-software/casper-x402';
import { ExactCasperScheme as ClientScheme } from '@make-software/casper-x402/exact/client';
import { ExactCasperScheme as FacilitatorScheme } from '@make-software/casper-x402/exact/facilitator';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentSignatureHeader } from '@x402/core/http';

const payerKey = casperSdk.PrivateKey.generate(casperSdk.KeyAlgorithm.ED25519);
const payer = toClientCasperSigner(payerKey);
const client = new x402Client().register(NETWORK_CASPER_TESTNET, new ClientScheme(payer));
const http = new x402HTTPClient(client);

const requirements = {
  scheme: 'exact',
  network: NETWORK_CASPER_TESTNET,
  amount: '1',
  asset: 'a'.repeat(64),
  payTo: payer.accountAddress(),
  maxTimeoutSeconds: 900,
  extra: { name: 'Test CEP18', version: '1' },
};

const paymentRequired = {
  x402Version: 2,
  resource: { url: 'https://paid.example/casper', serviceName: 'CasperGuard' },
  accepts: [requirements],
};

const payload = await http.createPaymentPayload(paymentRequired);
const headers = http.encodePaymentSignatureHeader(payload);
const decoded = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']);

const facilitatorSigner = {
  async getNetworkConfig(network) {
    return getNetworkConfig(network);
  },
  getAddresses() {
    return [payer.accountAddress()];
  },
  getPublicKeyHex() {
    return payer.publicKey();
  },
  async signTransaction() {},
  async putTransaction() {
    return 'not-used-by-verify';
  },
  async waitForTransaction() {},
};

const verification = await new FacilitatorScheme(facilitatorSigner).verify(decoded, requirements);

console.log(
  JSON.stringify(
    {
      headerNames: Object.keys(headers),
      payloadVersion: payload.x402Version,
      network: payload.accepted.network,
      amount: payload.accepted.amount,
      assetSemantics: 'CEP-18 contract package hash',
      signatureLength: payload.payload.signature.length,
      nonceLength: payload.payload.authorization.nonce.length,
      verification,
    },
    null,
    2,
  ),
);
