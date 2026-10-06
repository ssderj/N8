# Audit fixes applied to this copy (Oct 2, 2026)

Nothing here has been applied to live Supabase. Live is unchanged.

1. `supabase/history/149, 152 (anon grant follow-up), 153 (default privileges), 180 (quiz revoke)` — restored from live.
2. `supabase/schema.sql` — brought back in line with live:
   - `is_inkroot_admin()` (the old repo copy treated a missing user as admin; live already fixed it), `guild_event_entry_count`, `guild_treasury_role`, `create_guild_event_draft` (13-arg), `update_guild_event_draft` (14-arg) and `guild_event_escrow_contribution_shares` now match live.
   - Missing read policy "signed-in readers read platform post comments" added.
   - The revokes from 149/152/153/180 are appended at the end.
   - `draw_guild_giveaway` updated to match the new migration 193 (this one is intentionally AHEAD of live).
   - Literal `\u2014` text in SQL strings replaced with the real em dash, as live has it (schema.sql and history 42, 43, 45, 69, 113).
3. `supabase/history/193_migration_draw_giveaway_client_role_check.sql` — NEW, not applied. Closes the null-uid skip in `draw_guild_giveaway` (apply once).
4. `supabase/functions/paystack-webhook/index.ts` — alert-only `PAYSTACK_AMOUNT_MISMATCH` check. Needs a redeploy to take effect.

Still to do outside this repo: redeploy `paystack-withdraw` (live is an old version), redeploy `download-book`, turn on leaked-password protection in Supabase Auth settings.

## Verification run against live (Oct 2, 2026)
- Functions: 309 of 310 live public functions match schema.sql body-for-body (comments ignored). The one difference is draw_guild_giveaway, which is ahead of live until 193 is applied.
- Tables 95/95, columns 745/745, triggers 62/62, cron jobs 7/7, storage buckets and policies: all match.
- Migrations 102 and up: 87 of 96 match live statement-for-statement. Not identical: 103, 104, 112, 124, 143 (second), 151 (file text differs from what ran live; end state matches schema.sql), 105 (live is only the policy drop, repo adds the guild function fix), 102b (cron schedule, covered by schema.sql). History files were left as they are.
- Not verified: function EXECUTE grants and table grants (no database to rebuild into), constraint names.

## F3: payment reconciliation and amount hold (Oct 3, 2026) — DB migrations 198/199 APPLIED to live Oct 3; Edge Functions still need deploying
Source: pre-launch audit F3. Written, syntax-checked only; never run against live Supabase or Paystack.
1. `supabase/history/198_migration_payment_amount_hold.sql` — NEW. Three nullable columns on `purchases`, `guild_event_entries`, `guild_event_hosting_fee_payments`: `amount_mismatch_at`, `amount_mismatch_paid_kobo`, `amount_mismatch_approved_at`. No new status value; a held row stays `pending`.
2. `supabase/functions/paystack-webhook/index.ts` — a `charge.success` whose amount (or currency, or missing amount) does not match the row is now HELD (flagged, `PAYSTACK_AMOUNT_MISMATCH_HELD` alert, 200 returned) instead of granted. Replaces the old alert-only `PAYSTACK_AMOUNT_MISMATCH` block. A human approves by setting `amount_mismatch_approved_at`.
3. `supabase/functions/paystack-reconcile/index.ts` — NEW. Verifies `pending` payments (5 min to 48 h old) with Paystack and replays any success as a signed `charge.success` to the webhook, so the grant logic is not duplicated. Alerts `PAYSTACK_RECONCILED_MISSED_WEBHOOK` when it rescues one.
4. `supabase/history/199_migration_payment_reconcile_cron.sql` — NEW. pg_cron every 15 min via pg_net; skipped with a NOTICE until the Vault secrets exist.
Deploy order: apply 198; redeploy `paystack-webhook`; `supabase secrets set RECONCILE_SECRET=...`; deploy `paystack-reconcile --no-verify-jwt`; create the two Vault secrets; apply 199. Redeploying the webhook BEFORE 198 would make every payment 5xx (the new columns would not exist).
Known limits: held guild entries are not given a slot guarantee (decision A: the existing 30-minute rule applies; if the event is then full, the late payment is refunded by hand). Rows older than 48 h that were never approved are not retried.

## F13: Paystack calls without a timeout (Oct 3, 2026) — NOT deployed (Edge Functions)
Static edit only; never run against live Paystack. Each function below needs a redeploy to take effect.
- The inlined `paystack()` helper in `paystack-init-purchase`, `paystack-init-pack-purchase`, `paystack-init-event-entry`, `paystack-init-hosting-fee`, `paystack-banks`, `paystack-resolve-account`, `paystack-save-bank-account` and `manual-withdraw` now aborts after 20 s (same limit as `_shared/payments.ts` and `paystack-withdraw`). A timeout shows the same "We couldn't reach Paystack…" message as any other Paystack failure. (`manual-withdraw` defines this helper but never calls it, so that edit is only for consistency.)
- The `/transaction/verify` call inside each of the four `paystack-init-*` functions now aborts after 15 s; the existing catch turns that into "We couldn't confirm your earlier payment attempt yet", so a timeout still fails closed (no second checkout).
- `manual-withdraw`: the Telegram notification now aborts after 5 s, so a slow Telegram cannot delay the writer's response.
- Not changed: `paystack-withdraw`, `paystack-webhook`, `paystack-reconcile`, `_shared/payments.ts` already had timeouts. The helper copies were NOT swapped for the shared import (the deploy path doesn't reliably resolve cross-function imports).

## F16: bank code not validated (Oct 3, 2026) — NOT deployed (Edge Functions)
`paystack-resolve-account` and `paystack-save-bank-account` now require `bankCode` to be a string of 3 to 6 digits (`^\d{3,6}$`) before it is put into Paystack's `/bank/resolve` URL; otherwise "Unrecognized bank". The audit named only save-bank-account, but resolve-account had the identical gap, so both were changed. Redeploy both. Not checked against Paystack's live bank list (no network here): if a listed bank ever has a code outside 3-6 digits it would be refused, so after deploying, open the add-bank screen and try a few banks (including OPay 999992 and PalmPay 999991, which are 6 digits).

## F10: earnings holding period + name check (Oct 3, 2026) — migration 200 APPLIED to live Oct 3; admin UI line still needs a frontend deploy
Never run: no Postgres was available here, so migration 200 is NOT even syntax-parsed. Apply it to a Supabase branch first.
1. `supabase/history/200_migration_earnings_hold.sql` — NEW. `payout_security_config.earnings_hold_days` (default 7, 0 = off, max 90). `earnings_held_kobo()` sums the writer's share of successful purchases (book sales, tips, packs) paid inside the window for the main account and its linked profiles. `assert_earnings_hold_clear()` refuses a withdrawal larger than balance minus held. Both `create_withdrawal_locked` and `create_manual_withdrawal_locked` call it right after the existing balance check. Achievement, referral and guild grants are not held. `author_balance_kobo()` is unchanged, so the writer still sees one balance; the hold shows only in the error ("...You can withdraw up to ₦X right now.").
2. The manual function body in 200 is migration 195's (keeps the F6 secondary-profile guard), so 200 supersedes 195. Apply 195 first, then 200.
3. `src/admin/manual-withdrawals-admin.jsx` — each queue row now shows "Check before paying: does "<bank account name>" match <writer>?" (the admin decides; no automatic matching, since pen names differ from legal names). Needs a frontend deploy.
Change the window anytime: `update payout_security_config set earnings_hold_days = 3;`
Note: schema.sql still lacks migrations 193-197 (they exist only as history files); 198-200 were appended after them, so schema.sql is not a complete rebuild until those are folded in.

## F11: rate limits on direct writes (Oct 3, 2026) — migration 201 APPLIED to live Oct 3
Never run: no Postgres was available here, so migration 201 is NOT syntax-parsed. Apply it to a Supabase branch first. No frontend or Edge Function change.
`supabase/history/201_migration_rate_limits_direct_writes.sql` — NEW.
- `check_and_bump_rate_limit()` (migration 178's body) gains six actions: `publish_listing` 30/h, `review` 20/h, `follow` 100/h, `post` 40/h, `reaction` 200/h, `report` 20/h.
- `rate_limit_new_row()` + `BEFORE INSERT` triggers on: published_books, published_packs, published_addons, published_templates (publish_listing); reviews (review); follows (follow); book_discussion_posts, fireside_posts, platform_post_comments (post); fireside_reactions, platform_post_reactions (reaction); content_reports (report).
- The app saves with upsert, which fires BEFORE INSERT even when it only updates. For listings, reviews and follows the trigger first checks the row exists and skips if so, so edits, republishing and changing a review never count. Writes with no signed-in user (service role, SQL editor) are skipped.
- `record_book_view()` (live body) gains an overall cap of 300 anonymous views a minute across all books (extra views dropped silently, as the per-book cap already does) plus a partial index `book_view_events_anon_created_idx`.
- Change any number: edit the `case` in `check_and_bump_rate_limit()` (that is the only place they live).
- Not covered: publishing to a Guild also upserts `published_books`, so it counts as a listing; platform_posts (admin posts), guild feedback and guild order tables have no new limit. Sign-up rate limits and captcha (F8) are Supabase dashboard settings, not in this repo.

## F19: guild stats could be looped up to the ceilings (Oct 3, 2026) — migration 202 APPLIED to live Oct 3
Never run: no Postgres was available here, so migration 202 is NOT syntax-parsed. Apply it to a Supabase branch first. DB only; no frontend change.
`supabase/history/202_migration_guild_stats_time_cap.sql` — NEW. Adds `created_at` to `guild_member_stats` and `founder_guild_member_stats` and replaces the shared `guard_guild_member_stats_delta()`. A stat can never exceed starting allowance + daily rate x days since the row was created: published 50 + 30/day, quests 10 + 1/day, quest XP 22,500 + 4,500/day, writing days 365 + 1/day, fireside posts 500 + 300/day. The old per-write caps and never-decreases clamp stay. `created_at` is forced on insert and immutable on update. Existing rows start their clock at migration time.
Limits: this bounds each account, not many fake accounts (see F8). The fireside count is not checked against real posts. The table ceilings (100,000 XP etc.) are unchanged and now moot.

## F17: 15 foreign keys without an index (Oct 3, 2026) — migration 203 APPLIED to live Oct 3
`supabase/history/203_migration_fk_indexes.sql` — NEW. One plain `create index if not exists` per foreign key, exactly the 15 a live query returned (table.column: guild_event_entries.refunded_by, guild_event_giveaway_draws.winner_id, guild_event_giveaway_ties.chosen_by, guild_event_judging_settings.updated_by, guild_event_tickets.user_id, guild_event_tournament_matches.winner_id, guild_event_tournaments.anthology_id / champion_id / runner_up_id / third_id, guild_events.quiz_anthology_id, guild_quiz_attempts.user_id, guild_quiz_questions.anthology_id / reviewed_by, linked_profiles.created_by). Additive, no behaviour change; tables are tiny so each builds in milliseconds. The re-check query is in the file's header and should return no rows afterwards.
Side note found while checking: `guild_event_giveaway_draws.winner_id` references auth.users with ON DELETE RESTRICT, so deleting the account of a past giveaway winner will be refused unless the account-deletion path handles it. Not changed here.

## Live apply log (Oct 3, 2026)
Applied through the Supabase connector, one migration at a time, each in its own transaction, after confirming the live bodies of the functions they replace matched the source they were built on (same logic; live copies carry no comments). All six returned success and a read-back confirmed: 0 unindexed foreign keys left, 9 mismatch columns, earnings_hold_days = 7, 12 rate-limit triggers, new limiter actions, stats created_at on both tables, time-cap guard, hold inside both withdrawal functions. Migrations 193-197 were already live (applied Oct 3, 02:37-02:41 UTC).
NOT done, still needed:
1. Edge Functions are not deployed (no deploy tool here): redeploy `paystack-webhook` (it needs migration 198, now live), `paystack-init-purchase`, `paystack-init-pack-purchase`, `paystack-init-event-entry`, `paystack-init-hosting-fee`, `paystack-banks`, `paystack-resolve-account`, `paystack-save-bank-account`, `manual-withdraw`, and deploy the NEW `paystack-reconcile` with --no-verify-jwt; plus the earlier `paystack-withdraw` and `download-book` redeploys.
2. The reconcile cron job is NOT scheduled yet: set secret RECONCILE_SECRET, create Vault secrets `inkroot_project_url` and `reconcile_secret`, then re-run migration 199's DO block.
3. Frontend deploy for the admin queue "Check before paying" line (F10).
4. schema.sql in this repo still lacks the content of 193-197 (they were applied from history files).
