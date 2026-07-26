import type { Env } from './env.js';
import type { CasperScopedNetwork } from '../engines/casper-guard/network-header.js';

/**
 * The per-network Casper config a route needs to (a) read the operator's on-chain balance / derive the
 * deposit address, and (b) verify a deposit transaction over RPC. The two-slot env design keeps testnet
 * values in the base keys and mainnet values in the CASPER_GUARD_MAINNET_* / CASPER_MAINNET_* siblings;
 * this resolver picks the right slot for the request's network so a route never hardcodes one network.
 */
export interface CasperNetworkSlot {
  facilitatorRpcUrl: string;
  operatorAccountHash: string;
  odraRpcUrl: string;
  odraPackageHash: string;
}

export function resolveCasperNetworkSlot(env: Env, network: CasperScopedNetwork): CasperNetworkSlot {
  if (network === 'casper:casper') {
    return {
      facilitatorRpcUrl: env.CASPER_GUARD_MAINNET_FACILITATOR_RPC_URL,
      operatorAccountHash: env.CASPER_MAINNET_OPERATOR_ACCOUNT_HASH,
      odraRpcUrl: env.CASPER_GUARD_MAINNET_ODRA_RPC_URL,
      odraPackageHash: env.CASPER_GUARD_MAINNET_ODRA_PACKAGE_HASH,
    };
  }
  return {
    facilitatorRpcUrl: env.CASPER_GUARD_FACILITATOR_RPC_URL,
    operatorAccountHash: env.CASPER_OPERATOR_ACCOUNT_HASH,
    odraRpcUrl: env.CASPER_GUARD_ODRA_RPC_URL,
    odraPackageHash: env.CASPER_GUARD_ODRA_PACKAGE_HASH,
  };
}
