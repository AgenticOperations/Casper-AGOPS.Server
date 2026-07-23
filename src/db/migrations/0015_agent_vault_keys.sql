-- 0015_agent_vault_keys — storage for the EncryptedStoreVault's ciphertext (Milestone B/C wiring).
--
-- Deliberately a SEPARATE table from delegated_keys, keyed only by agent_id (one row per agent,
-- upserted), rather than a column on delegated_keys. delegated_keys models the on-chain-visible
-- key LIFECYCLE (ACTIVE/ROTATED/REVOKED, one row per grant/rotation); the vault blob is the
-- proxy-side secret material for whichever key is currently ACTIVE. Coupling the blob to a
-- delegated_keys row would create an ordering dependency (row must exist before the blob can be
-- written, but the row's public_key isn't known until the vault generates it) — keeping them
-- separate means the vault can generate+persist a keypair first, then delegated_keys.grantDelegatedKey
-- inserts referencing the already-known public key. No transaction gymnastics needed.
--
-- The column holds AES-256-GCM ciphertext (iv.ciphertext.authTag, base64-joined by '.') produced
-- by EncryptedStoreVault.encrypt() — never plaintext key material.

CREATE TABLE agent_vault_keys (
  agent_id             text PRIMARY KEY REFERENCES agents (id),
  encrypted_private_key text NOT NULL
);
