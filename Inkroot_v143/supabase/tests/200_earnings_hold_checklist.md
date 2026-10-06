# F10 checklist — run on a Supabase BRANCH first (migration 200 was never executed)
Setup: a test writer W with a bank account older than the cooldown; run SQL as postgres.
1. Apply 195, then 200. `select earnings_hold_days from payout_security_config;` -> 7.
2. W has only a sale paid today (author share ₦900): request ₦100 via manual-withdraw -> refused, message ends "You can withdraw up to ₦0.00 right now."
3. Age it: `update purchases set paid_at = now() - interval '8 days' where paystack_reference = '<ref>';` -> same request succeeds (pending withdrawal).
4. Mixed: W has an old ₦1,000 sale and a new ₦500 sale. Request ₦1,200 -> refused "up to ₦1,000.00"; request ₦1,000 -> succeeds.
5. Non-purchase earnings are not held: give W a referral/achievement grant; it is withdrawable immediately.
6. Over-balance still gives the old message "Amount is more than your available balance."
7. Idempotent replay of an earlier successful request still returns the same row (replay returns before the hold check).
8. `update payout_security_config set earnings_hold_days = 0;` -> new sales withdrawable at once; set back to 7.
9. A secondary linked profile still cannot withdraw (F6); its sales count toward the main account's held amount.
10. Admin queue shows the "Check before paying" line on a pending row.
