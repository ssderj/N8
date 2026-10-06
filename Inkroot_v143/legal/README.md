# Legal pages

`privacy-policy.md` and `terms-of-service.md` are the source. They are built into `public/privacy.html` and
`public/terms.html` (served at /privacy.html and /terms.html) and linked from the sign-in / account panel.

## Before launch
1. Fill the six fields in `legal-details.json`: LEGAL_ENTITY, ADDRESS, CONTACT_EMAIL, EFFECTIVE_DATE, MIN_AGE,
   GOVERNING_LAW. Only you can supply these.
2. Run `node scripts/build-legal.mjs --strict` (it fails while any field is empty; without `--strict` empty fields
   show as red {{FIELD}} marks in the page so they cannot be missed).
3. Have a lawyer review both documents. Nigerian data-protection law probably applies. I am not a lawyer.
4. Re-read the "Keeping and deleting your data" section whenever the purge function (migration 205) changes: the
   policy describes exactly what it does. It also assumes `purge-storage-queue` is deployed.

## Facts in the documents that come from the app, and must stay true
Supabase hosting region (Ireland, eu-west-1); Paystack checkout script and Google Fonts loaded on every page;
the random device identifier shown to moderators; 30-day deletion grace; 7-day earnings hold, new bank account
waiting period, ₦100 minimum withdrawal, manual withdrawal review; platform fee shown in the app.
Business choices the documents make that you may want to change: refunds handled by email case by case,
liability limited to what the user paid in the last 12 months, copyright complaints through the Report button or email
(no US DMCA agent).

## Not done here
A checkbox or stored acceptance (timestamp) at sign-up, and links in an app-wide footer (links are in the
sign-in / account panel only).
