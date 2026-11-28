#!/usr/bin/env node
// fetch_logo.mjs - fetch the OFFICIAL mark of a brand as clean SVG (never draws or recolours one).
//
// Usage:  node fetch_logo.mjs "<brand name>" [domain] [--out assets/logo] [--slug simple-icons-slug] [--json]
//
// Use it when the brand is known only by name, or for THIRD-PARTY marks in an integrations beat. For the user's own brand, brand.mjs's
// captured logo stays primary (it is the one on their live site).
// Sources, in order, until a mark is found:
//   1. SVGL (api.svgl.app): mark + wordmark, light and dark variants          -> logo.svg, wordmark.svg, logo-light.svg
//   2. Simple Icons (jsDelivr CDN): single-colour mark + the official hex     -> logo.svg (if still free) or logo-simpleicons.svg
//   3. the brand's own site (domain or the SVGL site): <link rel=icon> .svg, then an inline header/nav <svg>, then the
//      site's PNG icon (apple-touch-icon / icon link / favicon.ico, fetched from the site itself)   -> logo.svg | logo-site*.svg | logo-icon.png
// Writes <out>/logo.json: source and URL of every file, official colour, guidelines link, trademark note. Prints the same JSON
// (with --json only the JSON) and a final line saying what to look at.
// Rules: LOOK at logo.svg once (render it) before using it; nominative use only (the brand's name/mark identifying the brand),
// unmodified: never recolour (use the brand's own light/dark variant), redraw, or animate its shape beyond a reveal. If nothing is
// found the script says so: set the name in type or ask for the asset; do NOT draw one.
// Exit: 0 an SVG mark was saved, 1 only a PNG icon or nothing was found, 2 bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, helpFrom } from './_cdp.mjs';

const { pos, opt } = parseArgs(process.argv.slice(2), { help: 'bool', out: 's', slug: 's', json: 'bool' });
if (opt.help || !pos[0]) { console.log(helpFrom(import.meta.url)); process.exit(opt.help ? 0 : 2); }
const brand = pos[0];
const domain = pos[1] ? pos[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
const out = path.resolve(opt.out || 'assets/logo');
fs.mkdirSync(out, { recursive: true });
const say = (...a) => { if (!opt.json) console.error(...a); };

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
async function get(url, kind = 'text') {
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return kind === 'json' ? await r.json() : kind === 'buf' ? Buffer.from(await r.arrayBuffer()) : await r.text();
  } catch { return null; }
}
const norm = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
const normAscii = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const validSvg = (s) => typeof s === 'string' && /<svg[\s>]/i.test(s) && !/<image[\s>]/i.test(s) && (/viewBox=/i.test(s) || /width=/i.test(s)) && s.length < 400000;
const found = { brand, domain, files: [], note: 'Trademark: nominative use only (identify the brand), unmodified official artwork, never recoloured, redrawn or presented as the film\'s own mark.' };
const has = (f) => fs.existsSync(path.join(out, f));
const save = (file, svg, meta) => { fs.writeFileSync(path.join(out, file), svg.trim() + '\n'); found.files.push({ file, ...meta }); say('saved ' + file + '  (' + meta.source + ')'); };

// 1. SVGL
async function svgl() {
  const nb = norm(brand);
  if (!nb) return false;
  const res = await get(`https://api.svgl.app?search=${encodeURIComponent(brand)}`, 'json');
  if (!Array.isArray(res) || !res.length) return false;
  const pick = res.find((r) => norm(r.title) && norm(r.title) === nb) || res.find((r) => norm(r.title) && norm(r.title).includes(nb)) || null;
  if (!pick) return false;                                            // never guess: a loose first hit can be a different company
  const pickUrl = (x, dark) => (typeof x === 'string' ? x : x && ((dark ? x.dark : x.light) || x.light || x.dark));
  const markUrl = pickUrl(pick.route, true), wordUrl = pickUrl(pick.wordmark, true), lightUrl = pickUrl(pick.route, false);
  let ok = false;
  const m = markUrl && await get(markUrl); if (validSvg(m)) { save('logo.svg', m, { kind: 'mark', source: 'svgl', url: markUrl, title: pick.title }); ok = true; }
  const w = wordUrl && await get(wordUrl); if (validSvg(w)) save('wordmark.svg', w, { kind: 'wordmark', source: 'svgl', url: wordUrl, title: pick.title });
  if (lightUrl && lightUrl !== markUrl) { const l = await get(lightUrl); if (validSvg(l)) save('logo-light.svg', l, { kind: 'mark-for-light-bg', source: 'svgl', url: lightUrl }); }
  if (pick.url) found.site = pick.url;
  return ok;
}
// 2. Simple Icons (single-colour mark + official brand hex)
async function simpleIcons() {
  const nb = normAscii(brand);
  if (!nb && !opt.slug) return false;
  const slugs = [opt.slug, nb, normAscii(brand.replace(/\s+(ai|inc|labs?|app)$/i, '')), normAscii(brand.split(' ')[0])].filter(Boolean);
  const data = await get('https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json', 'json')
            || await get('https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json', 'json');
  const list = Array.isArray(data) ? data : data?.icons || [];
  const entry = list.find((e) => nb && normAscii(e.title) === nb) || list.find((e) => slugs.includes(e.slug || normAscii(e.title)));
  if (entry?.hex) found.color = '#' + entry.hex;
  if (entry?.guidelines) found.guidelines = entry.guidelines;
  for (const s of [entry?.slug, ...slugs].filter(Boolean)) {
    const svg = await get(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${s}.svg`);
    if (validSvg(svg)) {
      const colored = found.color ? svg.replace('<svg ', `<svg fill="${found.color}" `) : svg;
      save(has('logo.svg') ? 'logo-simpleicons.svg' : 'logo.svg', colored, { kind: 'mark', source: 'simple-icons', url: `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${s}.svg`, note: 'single-colour mark, official hex ' + (found.color || 'unknown') });
      return true;
    }
  }
  return false;
}
// 3. the brand's own site
async function site() {
  const d = domain || found.site?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return false;
  const base = `https://${d}`;
  const html = await get(base);
  if (!html) { found.blocked = base; say('site not readable (blocked or down): ' + base); return false; }
  const links = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)].map((m) => m[0]);
  const hrefOf = (l) => { const h = l.match(/href=["']([^"']+)["']/i)?.[1]; return h ? new URL(h, base).href : null; };
  const svgLink = links.map((l) => ({ l, h: hrefOf(l) })).find((x) => x.h && /\.svg(\?|$)/i.test(x.h));
  let ok = false;
  if (svgLink) { const svg = await get(svgLink.h); if (validSvg(svg)) { save(has('logo.svg') ? 'logo-site.svg' : 'logo.svg', svg, { kind: 'mark', source: 'site-icon', url: svgLink.h }); ok = true; } }
  if (!has('logo.svg')) {
    const hdr = html.match(/<(header|nav)[\s\S]{0,20000}?(<svg[\s\S]*?<\/svg>)/i);
    if (hdr && validSvg(hdr[2]) && hdr[2].length > 300) { save('logo-site-header.svg', hdr[2], { kind: 'header-svg', source: 'site-header', url: base, note: 'first big inline <svg> in the site header: LOOK, it may be the wordmark or an icon' }); ok = true; }
  }
  if (!ok && !has('logo.svg')) {
    const cands = [...links.map(hrefOf).filter(Boolean).sort((a, b) => (/apple-touch/i.test(b) ? 1 : 0) - (/apple-touch/i.test(a) ? 1 : 0)), `${base}/apple-touch-icon.png`, `${base}/favicon.ico`];
    for (const u of cands) {
      const buf = await get(u, 'buf');
      if (buf && buf.length > 200) {
        const ext = /\.ico(\?|$)/i.test(u) ? 'ico' : /\.svg/i.test(u) ? null : 'png';
        if (!ext) continue;
        fs.writeFileSync(path.join(out, `logo-icon.${ext}`), buf);
        found.files.push({ file: `logo-icon.${ext}`, kind: 'raster-icon', source: 'site-icon-raster', url: u, note: 'raster only: do not enlarge past its size; prefer typesetting the name' });
        say(`saved logo-icon.${ext}  (raster, ${u})`);
        break;
      }
    }
  }
  return ok;
}

await svgl();
await simpleIcons();
await site();
found.ok = has('logo.svg') || has('logo-site-header.svg');
fs.writeFileSync(path.join(out, 'logo.json'), JSON.stringify(found, null, 1) + '\n');
if (opt.json) console.log(JSON.stringify(found, null, 1));
else {
  console.log(JSON.stringify(found, null, 1));
  console.log(found.ok
    ? `\nSaved ${found.files.map((c) => c.file).join(', ')} in ${out}/. LOOK at logo.svg (render it once) before using it; use the brand's own light/dark variant, never recolour.`
    : `\nNo official SVG found for "${brand}". Do NOT draw one: set the name in type, or ask the user for the asset.`);
}
process.exit(has('logo.svg') ? 0 : 1);
