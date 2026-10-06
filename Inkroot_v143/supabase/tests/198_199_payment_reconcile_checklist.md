# F3 checklist — run on a Supabase BRANCH or with Paystack TEST keys first
1. Apply 198. `select amount_mismatch_at from purchases limit 1;` works. Nothing else changes.
2. Redeploy paystack-webhook. Make a normal test purchase: it still goes pending -> success, no alert.
3. Hold: in the SQL editor, `update purchases set amount_kobo = amount_kobo + 100 where paystack_reference = '<a pending test ref>'`, then pay it. Expect: row stays `pending`, `amount_mismatch_at` set, one `PAYSTACK_AMOUNT_MISMATCH_HELD` alert, buyer has no access.
4. Approve: `update purchases set amount_mismatch_approved_at = now() where paystack_reference = '<ref>';` then run the reconciler (below). Expect `success` and access granted.
5. Missed webhook: pay a test purchase while the webhook URL is wrong/blocked. After 5+ minutes, run the reconciler. Expect `success`, a `PAYSTACK_RECONCILED_MISSED_WEBHOOK` alert, summary `applied: 1`.
6. Abandoned checkout (open, close the popup): reconciler leaves it `pending` (`not_success` count rises).
7. Auth: `curl -X POST <url>/functions/v1/paystack-reconcile` with no/wrong `x-reconcile-secret` -> 401.
8. Cron: after 199, `select * from cron.job where jobname='reconcile-paystack-payments';` and, 15 min later, `select status, return_message from cron.job_run_details order by start_time desc limit 3;` plus `select * from net._http_response order by created desc limit 3;` (expect 200).
Manual run: `curl -X POST <url>/functions/v1/paystack-reconcile -H "x-reconcile-secret: <secret>"`.
