/**
 * Typed CEP-18 token contract-call client for WCSPR.
 *
 * The existing string-only submitter (`createLiveCasperDeploySubmitter` in odra-anchorer.ts)
 * builds every runtime arg with `CLValue.newCLString`, which cannot express the TYPED args
 * (Key / U256 / U512) that WCSPR `transfer` / `deposit` require. This module adds:
 *   - pure arg descriptors (what unit tests assert),
 *   - an injectable submitter interface (`Cep18CallSubmitter`) mirroring `CasperDeploySubmitter`,
 *   - a live adapter that maps descriptors → real casper-js-sdk CLValues (added in Task 2).
 *
 * We only CALL the third-party WCSPR contract; we never deploy or update it.
 */

// A submitter that performs an operator-signed typed contract call. Live impl uses casper-js-sdk;
// tests inject a fake. Mirrors CasperDeploySubmitter but with TYPED args (Key / U256 / U512) that
// the string-only anchorer submitter cannot express.
export interface Cep18CallSubmitter {
  call(input: {
    packageHash: string;
    entryPoint: string;
    args: Cep18TypedArgs;
    paymentMotes: number;
  }): Promise<{ txHash: string }>;
}

// Descriptor form is what tests assert; the live adapter maps these to real CLValues.
export type ClTypedArg =
  | { clType: 'U256'; value: string }
  | { clType: 'U512'; value: string }
  | { kind: 'account-hash-key'; rawHash: string };
export type Cep18TypedArgs = Record<string, ClTypedArg>;

export function buildCep18TransferArgs(p: {
  recipientAccountHash: string;
  amountMotes: string;
}): { recipient: ClTypedArg; amount: ClTypedArg } {
  // Repo stores account hashes as `00`+64hex; Key.newKey("account-hash-"+…) wants the RAW 64 hex.
  const rawHash = p.recipientAccountHash.startsWith('00')
    ? p.recipientAccountHash.slice(2)
    : p.recipientAccountHash;
  return {
    recipient: { kind: 'account-hash-key', rawHash },
    amount: { clType: 'U256', value: p.amountMotes },
  };
}

export function buildWcsprDepositArgs(p: { amountMotes: string }): { amount: ClTypedArg } {
  // WCSPR `deposit` is payable and takes the native wrap amount as U512.
  return { amount: { clType: 'U512', value: p.amountMotes } };
}
