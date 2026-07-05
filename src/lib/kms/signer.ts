import type { Account, Address, Hex, TypedDataDomain } from 'viem';
import { EIP3009_TYPES, type TransferAuthorization } from '../eip712/eip3009.js';

/**
 * KMS signing seam (policy-engine-FINAL.md:189-210, engine-specs-FINAL.md:201,276-277).
 *
 * Signing authority lives EXCLUSIVELY behind this seam — an agent holds no private key and no funds
 * (control/types.ts invariant). The hot path hands the signer a typed-data message and a role; it never
 * sees key material. In production the implementation is a real KMS (HSM-isolated keys); in the demo it is
 * {@link LocalKmsSigner}, the SAME seam backed by local viem accounts so the flow runs hermetically.
 *
 * The ROLE FENCE is the security boundary: each role is provisioned for exactly one operation. The
 * `agent-float` role may ONLY `external-spend` (sign an outbound EIP-3009 transfer); `treasury-allocation`
 * may ONLY `internal-allocation`. A request whose (role, operation) pair is not provisioned is rejected
 * BEFORE a byte is signed — a compromised hot path cannot coerce the float key into an allocation, or the
 * treasury key into an external spend. Raw signature bytes ARE the payment and MUST NOT be logged
 * (policy-engine:210).
 */

/** The provisioned signing roles. One key (account) per role; never shared. */
export type SignerRole = 'agent-float' | 'treasury-allocation';

/** The operation a role is invoked for. The role fence binds each role to exactly one of these. */
export type SignerOperation = 'external-spend' | 'internal-allocation';

/** The single (role → operation) pair each role is permitted to perform. */
const ROLE_OPERATION: Record<SignerRole, SignerOperation> = {
  'agent-float': 'external-spend',
  'treasury-allocation': 'internal-allocation',
};

export interface SignTransferParams {
  /** Which provisioned key signs. */
  role: SignerRole;
  /** The operation being requested; rejected unless it matches the role's provisioned operation. */
  operation: SignerOperation;
  /** The EIP-712 domain (resolved upstream per rail — never hardcoded here). */
  domain: TypedDataDomain;
  /** The EIP-3009 `transferWithAuthorization` message to sign. */
  message: TransferAuthorization;
}

/**
 * The signing contract the hot path depends on. Implementations enforce the role fence, expose the
 * public address provisioned for a role, and return the raw EIP-712 signature for the typed-data message.
 */
export interface KmsSigner {
  /** The public address provisioned for a role (the EIP-3009 `from`); never exposes key material. */
  addressFor(role: SignerRole): Promise<Address>;
  signTransfer(params: SignTransferParams): Promise<Hex>;
}

/** The (role, operation) pair was not provisioned — the role fence rejected the request, fail-closed. */
export class SignerFenceViolation extends Error {
  constructor(
    public readonly role: SignerRole,
    public readonly operation: SignerOperation,
  ) {
    super(`role fence: role '${role}' is not provisioned for operation '${operation}'`);
    this.name = 'SignerFenceViolation';
  }
}

/** A signature was requested for a role with no provisioned key. */
export class UnknownRoleError extends Error {
  constructor(public readonly role: SignerRole) {
    super(`no signing key provisioned for role '${role}'`);
    this.name = 'UnknownRoleError';
  }
}

/**
 * Local-account-backed {@link KmsSigner} for the demo and tests — the SAME seam the production KMS
 * implements. Each role maps to a viem {@link Account} (e.g. `privateKeyToAccount(...)`). The role fence
 * is enforced here exactly as it would be in the KMS: a (role, operation) mismatch throws before signing.
 */
export class LocalKmsSigner implements KmsSigner {
  constructor(private readonly accounts: Partial<Record<SignerRole, Account>>) {}

  async addressFor(role: SignerRole): Promise<Address> {
    const account = this.accounts[role];
    if (!account) throw new UnknownRoleError(role);
    return account.address;
  }

  async signTransfer(params: SignTransferParams): Promise<Hex> {
    const { role, operation, domain, message } = params;

    // Role fence (security boundary): reject any operation the role is not provisioned for, before signing.
    if (ROLE_OPERATION[role] !== operation) {
      throw new SignerFenceViolation(role, operation);
    }

    const account = this.accounts[role];
    if (!account || !account.signTypedData) {
      throw new UnknownRoleError(role);
    }

    return account.signTypedData({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
    });
  }
}
