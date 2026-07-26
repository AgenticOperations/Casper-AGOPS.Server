#![no_std]
#![no_main]

// Grants a bounded delegated key to an account (D-1, D-2①).
//
// Adapted from the Casper reference two-party-multi-sig session code
// (github.com/casper-ecosystem/two-party-multi-sig), which Casper's own docs note "is not a
// general-purpose program and needs to be modified for each use case." That reference implements
// a balanced 2-of-2 scheme (both keys end up equal weight, both thresholds raised to the same
// value, reachable only by both keys together).
//
// This is deliberately NOT that scheme. D-2① wants asymmetric delegation: the agent gets a
// bounded key that can transact ALONE (deploy threshold stays low), but can NEVER alone perform
// key-management (add/remove/reweight keys, change thresholds) — that stays exclusive to the
// master. Naively raising the key-management threshold without also raising the master's own
// weight would brick the account (verified against a real testnet account before writing this:
// master starts at weight 1; agent added at weight 1; if key-management threshold is raised to 3,
// no combination of existing keys could ever reach 3 again — the account's key-management would
// be permanently locked). So this contract ALSO bumps the master's own weight in the same deploy,
// via `update_associated_key` (distinct from `add_associated_key` — used because the master's key
// already exists), so the master alone still satisfies the raised key-management threshold.

use casper_contract::contract_api::{account, runtime};
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::account::{AccountHash, ActionType, Weight};

const ARG_AGENT_ACCOUNT: &str = "agent_account_hash";
const ARG_MASTER_WEIGHT: &str = "master_weight";
const ARG_KEY_MANAGEMENT_THRESHOLD: &str = "key_management_threshold";
const ARG_DEPLOYMENT_THRESHOLD: &str = "deployment_threshold";

#[no_mangle]
pub extern "C" fn call() {
    let agent_account: AccountHash = runtime::get_named_arg(ARG_AGENT_ACCOUNT);
    let master_weight: u8 = runtime::get_named_arg(ARG_MASTER_WEIGHT);
    let key_management_threshold: u8 = runtime::get_named_arg(ARG_KEY_MANAGEMENT_THRESHOLD);
    let deployment_threshold: u8 = runtime::get_named_arg(ARG_DEPLOYMENT_THRESHOLD);

    // The account executing this deploy IS the master account — no need to pass its hash in.
    let master_account = runtime::get_caller();

    // 1. Add the agent as a new associated key at weight 1 (the bounded delegated key, D-2①).
    account::add_associated_key(agent_account, Weight::new(1)).unwrap_or_revert();

    // 2. Raise the master's OWN weight so it alone still satisfies the raised key-management
    //    threshold set in step 3 below. Must happen before step 3, or step 3 could lock everyone
    //    out if the master's current weight doesn't already satisfy the new threshold.
    account::update_associated_key(master_account, Weight::new(master_weight)).unwrap_or_revert();

    // 3. Raise the key-management threshold. Casper requires deployment threshold <= key-management
    //    threshold at all times, so this must be set (or already be higher) before/at the same time
    //    as step 4.
    account::set_action_threshold(ActionType::KeyManagement, Weight::new(key_management_threshold))
        .unwrap_or_revert();

    // 4. Set the deployment threshold. Low enough (1) that the agent's weight-1 key alone can
    //    still transact without needing the master's cooperation for every deploy.
    account::set_action_threshold(ActionType::Deployment, Weight::new(deployment_threshold))
        .unwrap_or_revert();
}
