-- 0010_casper_guard_signed_header_value — Store the raw PAYMENT-SIGNATURE header value so the
-- settlement reader can decode and forward it to the facilitator at reconcile time.
-- The existing signed_header_hash remains as an integrity check; this column stores the plaintext.
ALTER TABLE casper_guard_decisions
  ADD COLUMN IF NOT EXISTS signed_header_value text;
