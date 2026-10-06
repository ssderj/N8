# Inkroot pre-launch audit — status as of 3 Oct 2026 (build v126)

Numbers follow the audit doc (Inkroot_Audit_Findings_and_Fixes.docx), NOT the older F-numbers in migration headers
(F13 = #11, F19 = #10, F10 = #6, F11 = #9, F16 = #15; F17 FK indexes has no audit number).
"Live" = confirmed against the live Supabase project on 3 Oct 2026.

| # | Finding | Status |
|---|---------|--------|
| 1 | Real ₦100 payment test | MANUAL — not done (2 old pending payments still open) |
| 2 | Event link must be http(s) | DONE, live (migration 197 + judge panel + entry form) |
| 3 | Payment reconcile | CODED, NOT LIVE — deploy `paystack-reconcile`, set RECONCILE_SECRET + 2 Vault secrets, re-run cron block of 199 |
| 4 | package-lock.json | NOT DONE |
| 5 | Dashboard settings (leaked-password protection etc.) | MANUAL — not done |
| 6 | 7-day earnings hold | DONE, live (200) |
| 7 | New-account device rule | PARTIAL (earlier checks only) |
| 8 | Private profile fields | DONE, live (206, 208, 211). Ban reasons and admin/moderator flags are no longer readable by signed-in users or visitors; roles and ban status are read through helper functions. Any column added to profiles later needs `grant select (new_col) on public.profiles to anon, authenticated;` |
| 9 | Write rate limits | DONE, live (201). kv_store new-key cap DONE, live (210) |
| 10 | Guild stats time cap | DONE, live (202) |
| 11 | Paystack call timeouts | DONE in code — redeploy Paystack functions to be sure |
| 12 | TRUNCATE/REFERENCES/TRIGGER revoked | DONE, live (194) |
| 13 | Anon execute on money/moderation functions | DONE, live (204) |
| 14 | Treasurer lookup only for caller | DONE, live (204) |
| 15 | Bank code validation | DONE in code — redeploy |
| 16 | Linked profiles can't withdraw | DONE, live (195/200) |
| 17 | CORS `*` | NOT DONE (optional) |
| 18 | Fee comment says "1000 = 10%" | DONE in code (comments now say 500 = 5%) — goes live when the functions are redeployed |
| 19 | Legal pages | WRITTEN + LINKED, NOT LAUNCH-READY — finished policy and terms in legal/, built to public/privacy.html and public/terms.html, linked from the sign-in/account panel with "By continuing you agree…". Still needed: fill the 6 fields in legal/legal-details.json, run `node scripts/build-legal.mjs --strict`, lawyer review. No stored acceptance record or checkbox yet. |
| 20 | Account deletion purge | DONE, live (205) — deploy `purge-storage-queue` so queued files are actually removed |
| 21 | Activity feed cap | DONE, live (204) |
| 22 | Security headers | WRITTEN, NOT YET LIVE — public/_headers (Netlify, Cloudflare Pages) and vercel.json. 5 headers enforce as soon as deployed; the CSP is REPORT-ONLY until you test checkout and rename it (steps in SECURITY_HEADERS.md). Host not known: other hosts need the values copied in. |
| 23 | Speed | ACCESS RULES DONE, live (207: 181 public + 10 storage rules wrapped, advisor item cleared). NOT done: duplicate permissive rules (160), unused indexes (92), cached ranking functions, load test |
| 24 | is_guild_book_member revoked | DONE, live (204) |
| 25 | Download lookup filters kind='book' | DONE in code (download-book) — redeploy |

Deploy list (and before launch: fill legal/legal-details.json and rebuild the legal pages): paystack-reconcile (+ secrets), purge-storage-queue (+ PURGE_STORAGE_SECRET), download-book, and the
Paystack functions touched by #11 / #15.
