-- 0005_identity — net-new human identity substrate (sits beside, never replaces, the sk_/ag_ key model).
--
-- Humans authenticate via opaque server-side sessions; agents/machines keep their bearer keys. A user
-- holds NO org binding here — org membership + role live in 0006 (memberships). Passwords are nullable so
-- an OAuth-only account is valid. We store only credential HASHES: a session token's sha256, a password's
-- scrypt digest, a verification/reset token's sha256. Plaintext is shown once (or in a link) and never
-- persisted. Email is citext so 'A@b.com' and 'a@b.com' are the same account (UNIQUE enforces it).

CREATE TABLE users (
  id             text PRIMARY KEY,
  email          citext NOT NULL UNIQUE,
  -- nullable: OAuth-only accounts have no password. scrypt digest string when set.
  password_hash  text,
  email_verified boolean NOT NULL DEFAULT false,
  name           text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- sha256 hex of the 256-bit opaque token; the plaintext lives only in the cookie.
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE oauth_accounts (
  id                  text PRIMARY KEY,
  provider            text NOT NULL CHECK (provider IN ('google')),
  provider_account_id text NOT NULL,
  user_id             text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);

CREATE TABLE email_verification_tokens (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_verification_tokens_hash_idx ON email_verification_tokens (token_hash);

CREATE TABLE password_reset_tokens (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX password_reset_tokens_hash_idx ON password_reset_tokens (token_hash);
