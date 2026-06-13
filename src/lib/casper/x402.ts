import { x402Version } from '@x402/core';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
  VerifyResponse,
} from '@x402/core/types';

const importRuntime = (specifier: string): Promise<unknown> =>
  import(/* @vite-ignore */ specifier) as Promise<unknown>;

export type CasperNetwork = Network;
export type CasperNetworkConfig = {
  chainName: string;
  rpcUrl: string;
};
export type CasperClientSigner = {
  accountAddress(): string;
  publicKey(): string;
  signEIP712(digest: Uint8Array): Promise<Uint8Array>;
};
export type CasperFacilitatorSigner = {
  getNetworkConfig(network: CasperNetwork): Promise<CasperNetworkConfig>;
  getAddresses(network: CasperNetwork): string[];
  getPublicKeyHex(network: CasperNetwork): string;
  signTransaction(transaction: unknown, network: CasperNetwork): Promise<void>;
  putTransaction(network: CasperNetwork, transaction: unknown): Promise<string>;
  waitForTransaction(network: CasperNetwork, transactionHash: string): Promise<void>;
};

type CasperX402Runtime = {
  getNetworkConfig(network: CasperNetwork): CasperNetworkConfig;
};
type ExactCasperClientRuntime = {
  ExactCasperScheme: new (signer: CasperClientSigner) => SchemeNetworkClient;
};
type ExactCasperFacilitatorRuntime = {
  ExactCasperScheme: new (signer: CasperFacilitatorSigner) => {
    verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  };
};

export const CASPER_X402_HEADER_NAME = 'PAYMENT-SIGNATURE' as const;
export const CASPER_X402_VERSION = x402Version;
export const CASPER_X402_TESTNET_NETWORK = 'casper:casper-test' as const;
export type CasperX402PaymentRequirements = PaymentRequirements;

export class CasperX402ValidationError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'CasperX402ValidationError';
    if (field !== undefined) {
      this.field = field;
    }
  }
}

export type CasperX402SignedHeader = {
  headerName: typeof CASPER_X402_HEADER_NAME;
  headerValue: string;
  headers: Record<typeof CASPER_X402_HEADER_NAME, string>;
  payload: PaymentPayload;
};

export async function createCasperX402PaymentHeader(input: {
  signer: CasperClientSigner;
  paymentRequired: PaymentRequired;
}): Promise<CasperX402SignedHeader> {
  validateCasperPaymentRequired(input.paymentRequired);
  const { ExactCasperScheme } = (await importRuntime(
    '@make-software/casper-x402/exact/client',
  )) as ExactCasperClientRuntime;

  const client = new x402Client().register(
    CASPER_X402_TESTNET_NETWORK,
    new ExactCasperScheme(input.signer),
  );
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload(input.paymentRequired);
  const headers = http.encodePaymentSignatureHeader(payload);
  const headerValue = headers[CASPER_X402_HEADER_NAME];

  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    throw new CasperX402ValidationError('Casper x402 header encoding did not return PAYMENT-SIGNATURE');
  }

  return {
    headerName: CASPER_X402_HEADER_NAME,
    headerValue,
    headers: { [CASPER_X402_HEADER_NAME]: headerValue },
    payload,
  };
}

export function decodeCasperX402PaymentHeader(headerValue: string): PaymentPayload {
  return decodePaymentSignatureHeader(headerValue);
}

export async function verifyCasperX402Payment(input: {
  paymentPayload: PaymentPayload;
  requirements: CasperX402PaymentRequirements;
  facilitatorSigner: CasperFacilitatorSigner;
}): Promise<VerifyResponse> {
  validateCasperPaymentRequirements(input.requirements);
  if (input.paymentPayload.x402Version !== CASPER_X402_VERSION) {
    throw new CasperX402ValidationError('Unsupported Casper x402 payload version', 'x402Version');
  }
  const { ExactCasperScheme } = (await importRuntime(
    '@make-software/casper-x402/exact/facilitator',
  )) as ExactCasperFacilitatorRuntime;

  return new ExactCasperScheme(input.facilitatorSigner).verify(
    input.paymentPayload,
    input.requirements,
  );
}

export async function getCasperX402NetworkConfig(network: CasperNetwork): Promise<CasperNetworkConfig> {
  const casperX402 = (await importRuntime('@make-software/casper-x402')) as CasperX402Runtime;
  return casperX402.getNetworkConfig(network);
}

export function validateCasperPaymentRequired(paymentRequired: PaymentRequired): void {
  if (!isRecord(paymentRequired)) {
    throw new CasperX402ValidationError('Casper x402 payment requirements are required');
  }

  if (paymentRequired.x402Version !== CASPER_X402_VERSION) {
    throw new CasperX402ValidationError('Unsupported Casper x402 version', 'x402Version');
  }

  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length === 0) {
    throw new CasperX402ValidationError('Casper x402 payment requirements are required', 'accepts');
  }

  for (const requirements of paymentRequired.accepts) {
    validateCasperPaymentRequirements(requirements);
  }
}

export function validateCasperPaymentRequirements(requirements: PaymentRequirements): void {
  if (!isRecord(requirements)) {
    throw new CasperX402ValidationError('Casper x402 payment requirements are required');
  }

  if (requirements.scheme !== 'exact') {
    throw new CasperX402ValidationError('Unsupported Casper x402 scheme', 'scheme');
  }

  if (requirements.network !== CASPER_X402_TESTNET_NETWORK) {
    throw new CasperX402ValidationError('Unsupported Casper x402 network', 'network');
  }

  if (typeof requirements.asset !== 'string' || !isContractPackageHash(requirements.asset)) {
    throw new CasperX402ValidationError('Invalid Casper CEP-18 contract package hash', 'asset');
  }

  if (typeof requirements.payTo !== 'string' || !isAccountHashAddress(requirements.payTo)) {
    throw new CasperX402ValidationError('Invalid Casper pay-to account address', 'payTo');
  }

  if (typeof requirements.amount !== 'string' || !isPositiveIntegerString(requirements.amount)) {
    throw new CasperX402ValidationError('Casper x402 amount must be a positive integer', 'amount');
  }

  if (
    typeof requirements.maxTimeoutSeconds !== 'number' ||
    !Number.isInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds <= 0
  ) {
    throw new CasperX402ValidationError(
      'Casper x402 max timeout must be a positive integer',
      'maxTimeoutSeconds',
    );
  }

  if (!hasTokenMetadata(requirements.extra)) {
    throw new CasperX402ValidationError(
      'Casper x402 token metadata requires non-empty name and version',
      'extra',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAccountHashAddress(value: string): boolean {
  return /^00[0-9a-fA-F]{64}$/.test(value);
}

function isContractPackageHash(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function isPositiveIntegerString(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) {
    return false;
  }

  return BigInt(value) > 0n;
}

function hasTokenMetadata(extra: unknown): boolean {
  if (!isRecord(extra)) {
    return false;
  }

  return isNonEmptyString(extra.name) && isNonEmptyString(extra.version);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
