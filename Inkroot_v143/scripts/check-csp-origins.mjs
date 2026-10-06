// Lists every external https:// origin that appears in src/ and index.html and says whether the
// Content-Security-Policy in public/_headers already covers it. Run before enforcing the policy and
// whenever you add a new external service:   node scripts/check-csp-origins.mjs
// (Namespace URLs such as w3.org / idpf.org inside generated EPUB/SVG markup are ignored: they are
// identifiers, not requests.)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const headers = readFileSync(join(root, 'public/_headers'), 'utf8');
const csp = (headers.match(/Content-Security-Policy(?:-Report-Only)?: (.*)/) || [])[1] || '';
const ignore = ['www.w3.org', 'www.idpf.org', 'www.daisy.org', 'purl.org', 'wa.me', 'placeholder.supabase.co'];

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules' || n.endsWith('.ttf')) continue;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const found = new Map();
for (const f of [...walk(join(root, 'src')), join(root, 'index.html')]) {
  for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)) {
    const host = m[0].replace(/^https?:\/\//, '');
    if (!found.has(host)) found.set(host, f.replace(root + '/', ''));
  }
}
const covered = (host) => csp.includes(host) || csp.split(/\s+/).some((t) => t.startsWith('https://*.') && host.endsWith(t.slice('https://*'.length)));
let bad = 0;
for (const [host, file] of found) {
  if (ignore.includes(host)) continue;
  const ok = covered(host);
  if (!ok) bad++;
  console.log(`${ok ? 'covered  ' : 'NOT IN CSP'}  ${host}   (${file})`);
}
if (bad) { console.error(`\n${bad} origin(s) not in the policy — add them to public/_headers and vercel.json, or they will be blocked once enforced.`); process.exit(1); }
console.log('\nAll external origins in the code are covered by the policy.');
