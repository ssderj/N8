-- 198_migration_payment_amount_hold.sql
-- F3 (part 1 of 2): hold a payment whose amount or currency does not match what we expected, instead
-- of granting access and only alerting. Additive only: three nullable columns on each payment table.
-- The row STAYS status = 'pending' while held, so every existing status filter, CHECK constraint and
-- author_balance_kobo() behaves exactly as before (no new status value).
--
--   amount_mismatch_at            when paystack-webhook held the payment (null = never held)
--   amount_mismatch_paid_kobo     what Paystack said was paid (null if it sent no usable amount)
--   amount_mismatch_approved_at   set by a human after checking the payment in Paystack; the next
--                                 reconcile run (within 15 min) then grants it normally
--
-- To approve a held payment (run as postgres in the SQL editor, after confirming it in Paystack):
--   update purchases set amount_mismatch_approved_at = now()
--   where paystack_reference = '<ref>' and amount_mismatch_at is not null;
--   (same column on guild_event_entries / guild_event_hosting_fee_payments)
-- To reject it: refund in the Paystack dashboard, then set that row's status = 'failed'.
-- No client write policy exists on these tables, so users cannot touch these columns.
-- Safe to re-run.

alter table purchases
  add column if not exists amount_mismatch_at timestamptz,
  add column if not exists amount_mismatch_paid_kobo bigint,
  add column if not exists amount_mismatch_approved_at timestamptz;

alter table guild_event_entries
  add column if not exists amount_mismatch_at timestamptz,
  add column if not exists amount_mismatch_paid_kobo bigint,
  add column if not exists amount_mismatch_approved_at timestamptz;

alter table guild_event_hosting_fee_payments
  add column if not exists amount_mismatch_at timestamptz,
  add column if not exists amount_mismatch_paid_kobo bigint,
  add column if not exists amount_mismatch_approved_at timestamptz;
