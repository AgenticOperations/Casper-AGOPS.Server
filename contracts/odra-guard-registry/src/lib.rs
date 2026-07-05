#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
extern crate alloc;

use odra::prelude::*;

/// Guard registry: an append-only anchor of AgentOps decisions.
///
/// Stores the decision hash (sha256:...) keyed by decision_id with a counter for audit.
/// Anchors are immutable: re-anchoring the same id with a DIFFERENT hash reverts.
#[odra::module]
pub struct GuardRegistry {
    anchors: Mapping<String, String>, // decision_id -> decision_hash
    count: Var<u64>,
}

#[odra::module]
impl GuardRegistry {
    pub fn init(&mut self) {
        self.count.set(0);
    }

    /// Anchor a decision. Idempotent on decision_id: re-anchoring the SAME hash is a no-op;
    /// a DIFFERENT hash for an existing id reverts (an anchor is immutable).
    pub fn anchor_decision(&mut self, decision_id: String, decision_hash: String) {
        if let Some(existing) = self.anchors.get(&decision_id) {
            if existing != decision_hash {
                self.env().revert(Error::AnchorImmutable);
            }
            return; // idempotent no-op
        }
        self.anchors.set(&decision_id, decision_hash.clone());
        self.count.set(self.count.get_or_default() + 1);
        self.env().emit_event(DecisionAnchored { decision_id, decision_hash });
    }

    pub fn get_anchor(&self, decision_id: String) -> Option<String> {
        self.anchors.get(&decision_id)
    }

    pub fn total_anchored(&self) -> u64 {
        self.count.get_or_default()
    }
}

#[odra::event]
pub struct DecisionAnchored {
    pub decision_id: String,
    pub decision_hash: String,
}

#[odra::odra_error]
pub enum Error {
    AnchorImmutable = 1,
}
