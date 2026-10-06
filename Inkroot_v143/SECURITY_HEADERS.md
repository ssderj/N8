# Security headers (audit #22)

Files: `public/_headers` (Netlify, Cloudflare Pages — Vite copies it into the build) and `vercel.json` (Vercel).
They hold the same set. If you host somewhere else (nginx, Apache, Firebase, an S3/CloudFront setup), copy the
header names and values from `public/_headers` into that host's header configuration. GitHub Pages cannot set
response headers at all.

## What is on
| Header | Enforced now? | Why |
|---|---|---|
| X-Content-Type-Options: nosniff | yes | stops browsers guessing file types |
| Referrer-Policy: strict-origin-when-cross-origin | yes | no full URLs sent to other sites |
| X-Frame-Options: DENY | yes | the app cannot be put in someone else's frame (clickjacking) |
| Permissions-Policy | yes | camera, microphone, location, USB off |
| Strict-Transport-Security (1 year) | yes | HTTPS only. Remove if your site is ever served over plain HTTP |
| Content-Security-Policy | **REPORT-ONLY** | the big one: only your own files, Supabase, Paystack, Google Fonts and cdnjs (d3) may run or load |

The policy was written from what the code loads and could not be run against the real site here (no browser, no build).
Paystack's own documentation was not available, and third-party guides disagree on which Paystack
hostnames the checkout uses, so the policy allows `*.paystack.co` and `*.paystack.com`.
That is why the CSP ships in report-only mode: it blocks nothing yet, and the browser console lists anything it would block.

## Before you enforce it (15 minutes)
1. Deploy. Open the site with DevTools → Console open.
2. Use everything once: sign in with Google and with a passkey, write, import and export a PDF, EPUB and DOCX,
   upload an avatar and a book cover, open the relationship web (loads d3), open a guild, **buy a book and tip
   with a Paystack test payment**, request a withdrawal, open the admin and moderation screens.
3. Look for console lines starting `[Report Only] Refused to ...`. Each one names the blocked address and the
   directive. Add that address to the matching directive in BOTH files, redeploy, repeat.
4. When a full pass is clean, enforce: in both files rename `Content-Security-Policy-Report-Only` to
   `Content-Security-Policy`. Redeploy and repeat step 2 once more, paying special attention to checkout.
5. Keep the previous deploy handy; reverting is just a rename back.

`node scripts/check-csp-origins.mjs` lists every external address in the code and whether the policy covers it. Run it
whenever you add a new external service.

## Things the policy deliberately allows, and why
- `style-src 'unsafe-inline'`: the app styles elements with inline `style` attributes everywhere. This weakens the
  style protection only; scripts stay locked to your own files plus the three named hosts.
- `'wasm-unsafe-eval'`: the PDF reader may use WebAssembly for some image types. It does not allow `eval`.
- `data:` and `blob:` in images and connections: exports, downloads and in-manuscript images use them.
- Supabase is pinned to this project (`cfabvlgpsemixhbedvzt.supabase.co`). If you use a different project for staging,
  or a custom domain for Supabase, update both files.

## Not covered
Headers do not replace fixing script-injection bugs (#2 is fixed); they limit the damage of the next one.
The dev server (`npm run dev`) does not send these headers.
