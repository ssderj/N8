// Builds public/privacy.html and public/terms.html from legal/*.md, filling the {{FIELDS}} from
// legal/legal-details.json. No dependencies. Run:  node scripts/build-legal.mjs
//   --strict   exit with an error if any field is still empty (use before a public launch)
// Empty fields stay visible in the page as highlighted {{FIELD}} so they can't be missed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const details = JSON.parse(readFileSync(join(root, 'legal/legal-details.json'), 'utf8'));
const strict = process.argv.includes('--strict');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const missing = new Set();

function inline(s) {
  let out = esc(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // fill after escaping: values are escaped inside fill()
  out = out.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    const v = (details[k] ?? '').trim();
    if (!v) { missing.add(k); return `<mark>{{${k}}}</mark>`; }
    return esc(v);
  });
  return out;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,3}) (.*)$/))) { html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i++; }
      html.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        let li = inline(lines[i].replace(/^\d+\. /, '')); i++;
        const nested = [];
        while (i < lines.length && /^\s+- /.test(lines[i])) { nested.push(`<li>${inline(lines[i].replace(/^\s+- /, ''))}</li>`); i++; }
        if (nested.length) li += `<ul>${nested.join('')}</ul>`;
        items.push(`<li>${li}</li>`);
      }
      html.push(`<ol>${items.join('')}</ol>`); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |- |\d+\. )/.test(lines[i])) { para.push(inline(lines[i])); i++; }
    html.push(`<p>${para.join('<br>')}</p>`);
  }
  return html.join('\n');
}

const page = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#17171B" />
<title>${title} — Inkroot</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #17171B; color: #EFE7D2; font: 16px/1.65 Georgia, 'Times New Roman', serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; }
  a { color: #D9A15A; }
  h1 { font-size: 30px; margin: 8px 0 4px; }
  h2 { font-size: 20px; margin: 32px 0 6px; color: #F3EBD6; }
  p, li { color: #D8D0BC; }
  li { margin: 4px 0; }
  mark { background: #D98A8A; color: #17171B; padding: 0 3px; border-radius: 3px; }
  .back { font: 14px system-ui, sans-serif; }
</style>
</head>
<body>
<main>
<p class="back"><a href="/">← Back to Inkroot</a></p>
${body}
</main>
</body>
</html>
`;

mkdirSync(join(root, 'public'), { recursive: true });
for (const [src, out, title] of [
  ['legal/privacy-policy.md', 'public/privacy.html', 'Privacy Policy'],
  ['legal/terms-of-service.md', 'public/terms.html', 'Terms of Service'],
]) {
  writeFileSync(join(root, out), page(title, mdToHtml(readFileSync(join(root, src), 'utf8'))));
  console.log('wrote', out);
}
if (missing.size) {
  console.warn(`\nStill empty in legal/legal-details.json: ${[...missing].join(', ')}`);
  if (strict) process.exit(1);
} else console.log('\nAll fields filled.');
