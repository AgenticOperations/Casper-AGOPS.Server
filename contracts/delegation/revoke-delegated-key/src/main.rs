#![no_std]
#![no_main]

// Revokes a delegated key (D-2④): removes the agent's associated key entirely. Uses
// `remove_associated_key`, not `update_associated_key(..., weight=0)` — removal is the
// unambiguous, standard revocation path; there is no need to rely on whether a weight of exactly
// zero is accepted by the execution engine (it is not exercised by Casper's own reference code).
// Does NOT touch the master's own weight or either threshold — those stay as the grant deploy set
// them, since revoking one delegated key shouldn't loosen the account's own security posture.

use casper_contract::contract_api::{account, runtime};
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::account::AccountHash;

const ARG_AGENT_ACCOUNT: &str = "agent_account_hash";

#[no_mangle]
pub extern "C" fn call() {
    let agent_account: AccountHash = runtime::get_named_arg(ARG_AGENT_ACCOUNT);
    account::remove_associated_key(agent_account).unwrap_or_revert();
}
