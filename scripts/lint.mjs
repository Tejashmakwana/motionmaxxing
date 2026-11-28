#!/usr/bin/env node
// lint.mjs - gate G5 "no page chrome": a DOM-level lint for HUD / slide-deck / vibe-coded-UI patterns in a film's index.html.
//
// Usage:  node lint.mjs <index.html> [--times 0.5,2,4.2] [--samples N] [--json] [--width W --height H] [--duration S]
//
// Loads the page in headless Chrome (scripts/_cdp.mjs), seeks it with the same contract as render.mjs (__seek / __timelines /
// gsap), and at every sample time reads every VISIBLE text block (box = real ink box of the text, font size, tracking, case,
// colour, alignment) plus the non-text shapes (bars, rules, dots, media). Each position rule is read twice (t and t+0.1 s) and
// only counts when the element is HELD (not flying through a corner mid-transition). Text INSIDE a UI surface (an ancestor with a
// background + border-radius that is at least ~2.5% of the frame, or any [data-ui] element) is exempt from the chrome/deck
// rules, but never from the vibe-coded-UI rules (greeting, "label . $value", cluster).
//
//   Samples:  --times lists them; otherwise N evenly spaced (default clamp(round(1.5 x duration), 12, 36)). Duration comes from
//             --duration | window.__duration | [data-composition-id=main][data-duration] | __timelines.main | gsap.
//   Rules (FAIL = hard, gate G5 fails; WARN = a lead, look at it):
//     C1 corner/edge label      small text (<=4% H) in a corner zone (x<.2|>.8 and y<.14|>.86) or a top/bottom/side strip     FAIL
//     C2 tracked-caps label     uppercase, letter-spacing >= 0.05em, <=4.5% H (brand / metadata / kicker labels)              FAIL
//     C3 chapter counter        "02 / SPEAK", "01 - THE WAIT", "N/M", "Chapter 3", "FILM 01", bare "01"                      FAIL
//     C4 production metadata    BPM, FPS, FRAME n, 1920x1080, T+1.6s, TC, hh:mm:ss, v1.2, (c)                                FAIL
//     C5 mono micro-label       monospace text <= 4% H outside a UI surface                                                  WARN
//     C6 header/footer bar      a full-width bar / hairline in the top or bottom band, or a left+right small-text row        FAIL
//     C7 kicker over headline   small line directly above a headline (>= 2x larger), left- or centre-aligned                 FAIL
//     D1 deck layout            left-anchored headline block (x0<.2): FAIL with media on the right, a sub-line or kicker or
//                               2+ lines; WARN alone (allowed only as a one-line split phrase under ~1.2 s)
//     P1 progress bar           a thin element that GROWS over time (outside a UI surface)                                   FAIL
//     T1 letter-typed headline  headline-size text (>= 5% H) that grows by letters (mid-word) over 0.1 s, or has a caret      FAIL (growth) / WARN (caret only)
//     V1 greeting header        "Good morning", "Welcome back", "Hi Name"                                                    FAIL
//     V2 label . value          "Revenue . $12,400"                                                                          FAIL
//     V3 status dot             6-14 px filled circle right before a text                                                    WARN
//     V4 zinc grey text         colour within 10 of Tailwind zinc 300/400/500/600 (#d4d4d8 #a1a1aa #71717a #52525b)            WARN
//     V5 vibe-coded UI card     one surface (or the page) holds >= 2 of: greeting, label.value, status dot, zinc text         FAIL
//   [data-ui="captured"] marks a faithful rebuild of a captured product screen: V5 is skipped inside it (the exemption is printed).
//
// Output: PASS / WARN / FAIL per rule with the sample times, an element snippet and the bbox [x0,y0,x1,y1] (0-1 of the frame),
// then "GATE G5: PASS|FAIL". --json prints the same as JSON. Text drawn into <canvas>/<img> is invisible to it; lint is a lead,
// not a verdict (a PASS is not good taste).
// Exit: 0 gate PASS (warnings allowed), 1 gate FAIL, 2 bad usage / page failure.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { launchChrome, parseArgs, helpFrom } from './_cdp.mjs';

const fail2 = (m) => { console.error('error: ' + m); process.exit(2); };
const { pos, opt } = parseArgs(process.argv.slice(2), { help: 'bool', times: 's', samples: 's', json: 'bool', width: 's', height: 's', duration: 's' });
if (opt.help || !pos[0]) { console.log(helpFrom(import.meta.url)); process.exit(opt.help ? 0 : 2); }
const src = pos[0];
const url = /^(https?|file):/i.test(src) ? src : (fs.existsSync(src) ? pathToFileURL(path.resolve(src)).href : fail2(`input not found: ${src}`));
let userTimes = null;
if (opt.times !== undefined) {
  userTimes = opt.times.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  if (!userTimes.length) fail2('--times needs numbers like 0.5,2,4.2');
}
const numOpt = (v, name) => { if (v === undefined) return null; const n = Number(v); if (!Number.isFinite(n) || n <= 0) fail2(`--${name} must be a positive number`); return n; };

// ---------------------------------------------------------------- page side
const PAGE_LIB = String.raw`(() => {
  const ids = new WeakMap(); let nid = 0;
  const id = (e) => { let v = ids.get(e); if (!v) { v = ++nid; ids.set(e, v); } return v; };
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__lintInfo = () => {
    const main = document.querySelector('[data-composition-id="main"]');
    const tls = window.__timelines && typeof window.__timelines === 'object' ? window.__timelines : null;
    let d = null;
    if (typeof window.__duration === 'number') d = window.__duration;
    else if (main && parseFloat(main.getAttribute('data-duration')) > 0) d = parseFloat(main.getAttribute('data-duration'));
    else if (tls && tls.main && typeof tls.main.duration === 'function') d = tls.main.duration();
    else if (window.gsap && gsap.globalTimeline) d = gsap.globalTimeline.duration();
    return { duration: d, width: main ? parseInt(main.getAttribute('data-width')) || null : null, height: main ? parseInt(main.getAttribute('data-height')) || null : null,
      seek: typeof window.__seek === 'function' ? '__seek' : (tls && Object.keys(tls).length ? '__timelines' : (window.gsap ? 'gsap' : 'none')) };
  };
  window.__lintPrepare = async () => {
    try { await document.fonts.ready; } catch (e) {}
    await Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => 0) : 0)));
    if (window.__ready && typeof window.__ready.then === 'function') await window.__ready;
    else if (typeof window.__ready === 'function') await window.__ready();
    return 1;
  };
  window.__lintSeek = async (t) => {
    if (typeof window.__seek === 'function') await window.__seek(t);
    else if (window.__timelines && typeof window.__timelines === 'object' && Object.keys(window.__timelines).length) {
      const names = Object.keys(window.__timelines).sort((a, b) => (a === 'main') - (b === 'main'));
      for (const n of names) { const tl = window.__timelines[n]; if (tl && typeof tl.seek === 'function') { if (tl.pause) tl.pause(); tl.seek(t, false); } }
    } else if (window.gsap && gsap.globalTimeline) { gsap.globalTimeline.pause(); gsap.globalTimeline.seek(t, false); }
    for (const a of document.getAnimations ? document.getAnimations() : []) {
      if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) continue;
      try { a.pause(); a.currentTime = t * 1000; } catch (e) {}
    }
    await Promise.all([...document.querySelectorAll('video')].map(async (v) => {
      v.muted = true; try { v.pause(); } catch (e) {}
      const dur = isFinite(v.duration) ? v.duration : 1e9;
      const target = Math.min(Math.max(0, t - (parseFloat(v.dataset.start) || 0) + (parseFloat(v.dataset.mediaStart) || 0)), Math.max(0, dur - 0.001));
      if (Math.abs(v.currentTime - target) < 0.0005 && !v.seeking) return;
      await new Promise((res) => { const to = setTimeout(res, 2500); v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true }); v.currentTime = target; });
    }));
    await raf2();
    return 1;
  };
  window.__lintScan = () => {
    const W = innerWidth, H = innerHeight;
    const cs = (e) => getComputedStyle(e);
    const rgba = (c) => {
      let m = /^rgba?\(([^)]+)\)/.exec(c || '');
      if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
      m = /^color\(srgb ([^)]+)\)/.exec(c || '');
      if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(parseFloat); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
      return [0, 0, 0, 0];
    };
    const snip = (e, txt) => {
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return '<' + e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : '') + '>' + (txt ? ' ' + JSON.stringify(txt.slice(0, 40)) : '');
    };
    const hidden = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const s = cs(n); if (s.display === 'none') return true; } return false; };
    const opacity = (e) => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(cs(n).opacity); return o; };
    // fraction of a rect that survives the overflow clipping of its ancestors
    const visFrac = (e, r) => {
      let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom; const a0 = Math.max(1, (x1 - x0) * (y1 - y0));
      x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, W); y1 = Math.min(y1, H);
      for (let n = e.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const s = cs(n); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const q = n.getBoundingClientRect(); x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
      }
      return x1 <= x0 || y1 <= y0 ? 0 : ((x1 - x0) * (y1 - y0)) / a0;
    };
    // a "UI surface" is a card-sized thing with a fill and rounded corners (or anything marked data-ui)
    const surfCache = new Map();
    const isSurface = (a) => {
      if (surfCache.has(a)) return surfCache.get(a);
      let res = false;
      if (a.hasAttribute && a.hasAttribute('data-ui')) res = true;
      else if (a !== document.body && a !== document.documentElement) {
        const s = cs(a), c = rgba(s.backgroundColor);
        const filled = c[3] >= 0.3 || (s.backgroundImage && s.backgroundImage !== 'none');
        const rad = s.borderTopLeftRadius || '0px'; const radius = rad.endsWith('%') ? parseFloat(rad) * 3 : parseFloat(rad);
        if (filled && radius >= 6) {
          const r = a.getBoundingClientRect(), area = (r.width * r.height) / (W * H);
          const full = r.width >= 0.9 * W && r.height >= 0.9 * H;
          const cy = (r.top + r.bottom) / 2 / H;
          const bar = r.width >= 0.6 * W && r.height <= 0.14 * H && (cy < 0.12 || cy > 0.88);
          res = area >= 0.025 && !full && !bar;
        }
      }
      surfCache.set(a, res); return res;
    };
    const surfaceOf = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) if (isSurface(n)) return n; return null; };
    const blocks = [], shapes = [], surfaces = [];
    // ---- text blocks: group visible text nodes by their nearest block-level ancestor
    const groups = new Map();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(p.tagName)) continue;
      const txt = n.textContent.replace(/\s+/g, ' ').trim(); if (!txt) continue;
      if (hidden(p) || cs(p).visibility === 'hidden' || opacity(p) < 0.05) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      const rs = [...rg.getClientRects()].filter((q) => q.width > 0.5 && q.height > 0.5);
      if (!rs.length) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const q of rs) { x0 = Math.min(x0, q.left); y0 = Math.min(y0, q.top); x1 = Math.max(x1, q.right); y1 = Math.max(y1, q.bottom); }
      if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) continue;
      if (visFrac(p, { left: x0, top: y0, right: x1, bottom: y1 }) < 0.5) continue;
      let c = p; while (c.parentElement && c !== document.body && /^(inline|contents)/.test(cs(c).display)) c = c.parentElement;
      const g = groups.get(c) || { c, parts: [], x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, tops: new Set(), best: null };
      g.parts.push(txt); g.x0 = Math.min(g.x0, x0); g.y0 = Math.min(g.y0, y0); g.x1 = Math.max(g.x1, x1); g.y1 = Math.max(g.y1, y1);
      for (const q of rs) g.tops.add(Math.round(q.top / 4));
      if (!g.best || txt.length > g.best.len) g.best = { len: txt.length, p };
      groups.set(c, g);
    }
    for (const g of groups.values()) {
      const text = g.parts.join(' ').replace(/\s+([.,;:!?])/g, '$1').trim(); if (!text) continue;
      const p = g.best.p, s = cs(p), fs = parseFloat(s.fontSize) || 16, cont = cs(g.c);
      const lsRaw = s.letterSpacing === 'normal' ? 0 : parseFloat(s.letterSpacing) || 0;
      const letters = text.replace(/[^A-Za-z]/g, '');
      const sf = surfaceOf(g.c);
      blocks.push({ id: id(g.c), text: text.slice(0, 120), x0: g.x0 / W, y0: g.y0 / H, x1: g.x1 / W, y1: g.y1 / H, fs: fs / H, ls: lsRaw / fs,
        up: s.textTransform === 'uppercase' || (letters.length >= 3 && letters === letters.toUpperCase()),
        mono: /mono|menlo|courier|consolas/i.test(s.fontFamily), w: +s.fontWeight || 400, color: rgba(s.color).map((v, i) => (i < 3 ? Math.round(v) : +(v * opacity(p)).toFixed(2))),
        ta: cont.textAlign, lines: g.tops.size, ui: sf ? id(sf) : 0, uiCaptured: !!(sf && sf.getAttribute && sf.closest('[data-ui="captured"]')), snip: snip(g.c, text) });
    }
    // ---- shapes: filled / bordered boxes, media, dots
    for (const e of document.body.querySelectorAll('*')) {
      if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
      const tag = e.tagName.toLowerCase(); if (/^(script|style|noscript|template|br|source|track|link|meta)$/.test(tag)) continue;
      if (hidden(e)) continue; const s = cs(e); if (s.visibility === 'hidden' && !/^(svg|img|video|canvas)$/.test(tag)) continue;
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.right < 0 || r.left > W || r.bottom < 0 || r.top > H) continue;
      const op = opacity(e); if (op < 0.05) continue;
      const bg = rgba(s.backgroundColor), media = /^(img|video|canvas|svg|picture|iframe)$/.test(tag) || (s.backgroundImage && /url\(/.test(s.backgroundImage));
      const bw = [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderRightWidth].map((v) => parseFloat(v) || 0);
      const bcol = rgba(s.borderTopColor);
      const fill = bg[3] * op >= 0.05 || (s.backgroundImage && s.backgroundImage !== 'none');
      const border = (bw[0] >= 1 || bw[1] >= 1) && bcol[3] > 0.05;
      if (!fill && !media && !border) continue;
      const rad = s.borderTopLeftRadius || '0px'; const radius = rad.endsWith('%') ? parseFloat(rad) : parseFloat(rad) / Math.max(1, Math.min(r.width, r.height)) * 100;
      shapes.push({ id: id(e), tag, snip: snip(e), x0: r.left / W, y0: r.top / H, x1: r.right / W, y1: r.bottom / H, w: r.width, h: r.height,
        fill: !!fill, alpha: +(bg[3] * op).toFixed(2), bg: bg.slice(0, 3).map(Math.round), border, media: !!media, radiusPct: Math.round(radius), ui: (() => { const sf = surfaceOf(e.parentElement || e); return sf ? id(sf) : 0; })(), selfSurface: isSurface(e) });
      if (isSurface(e)) surfaces.push({ id: id(e), x0: r.left / W, y0: r.top / H, x1: r.right / W, y1: r.bottom / H });
      if (shapes.length > 2500) break;
    }
    return { blocks, shapes, surfaces };
  };
  return true;
})()`;

// ---------------------------------------------------------------- node side: rules
const R = [
  ['C1', 'corner/edge micro-label', 'FAIL'], ['C2', 'tracked uppercase label', 'FAIL'], ['C3', 'chapter / counter index', 'FAIL'],
  ['C4', 'production metadata (BPM/FPS/timecode/version)', 'FAIL'], ['C5', 'mono micro-label', 'WARN'], ['C6', 'header/footer bar or row', 'FAIL'],
  ['C7', 'kicker above headline', 'FAIL'], ['D1', 'deck layout (left-anchored headline block)', 'FAIL'], ['P1', 'progress bar', 'FAIL'],
  ['T1', 'letter-typed headline', 'FAIL'], ['V1', 'greeting header', 'FAIL'], ['V2', 'label . value line', 'FAIL'],
  ['V3', 'status dot beside text', 'WARN'], ['V4', 'zinc-grey text', 'WARN'], ['V5', 'vibe-coded UI card (cluster)', 'FAIL'],
];
const RULE = Object.fromEntries(R.map(([id, name, sev]) => [id, { id, name, sev, hits: new Map() }]));
const addHit = (rule, t, key, d) => {
  const r = RULE[rule]; const h = r.hits.get(key) || { ...d, times: [], sev: d.sev || r.sev }; if (!h.times.includes(t)) h.times.push(t);
  if (d.sev === 'FAIL') h.sev = 'FAIL'; r.hits.set(key, h);
};
const r2 = (v) => +v.toFixed(3);
const bb = (b) => [r2(b.x0), r2(b.y0), r2(b.x1), r2(b.y1)];
const fsPct = (b) => +(b.fs * 100).toFixed(1);
const ZINC = [[0xd4, 0xd4, 0xd8], [0xa1, 0xa1, 0xaa], [0x71, 0x71, 0x7a], [0x52, 0x52, 0x5b]];
const near = (c, k, d) => Math.hypot(c[0] - k[0], c[1] - k[1], c[2] - k[2]) <= d;
const RX = {
  counterNum: /^\s*0?[\d٠-٩]{1,2}\s*(?:[\/—–·]|-(?=\s*[\p{L}]{2,}))\s*(?:0?[\d٠-٩]{1,2}\b|[\p{L}]{2,})/u,
  counterWord: /(?:^|\s)(chapter|scene|act|step|part|film|episode|shot|take|bar|beat|الفصل|المشهد|الخطوة|خطوة|القسم|الجزء|اللقطة)\s*0?[\d٠-٩]/iu,
  counterBare: /^\s*0[\d٠-٩]\s*$/u,
  meta: /\bBPM\b|\bFPS\b|\bFRAME\s*\d|\b(1920|3840|1280)\s*[x×]\s*(1080|2160|720)\b|\bT\s*[+]\s*\d|\bTC\b|\b\d{1,2}:\d{2}:\d{2}(?:[.:]\d+)?\b|\b\d{1,2}:\d{2}\.\d{1,3}\b|\bREC\b/,
  ver: /\bv\d+\.\d+(?:\.\d+)?\b|©/i,
  greeting: /\bgood\s+(morning|afternoon|evening)\b|\bwelcome back\b|^(hi|hey|hello)\b[^.,]{0,24}(!|\u{1F44B}|\u{1F31E}|\u2600)|(?:صباح|مساء)\s+(?:الخير|النور)|مرحبا[ً]?\s+بعودتك|أهلا[ً]?\s+بك/iu,
  labelValue: /^[\p{L}][\p{L} ]{1,28}\s*[·•]\s*[$€£﷼]?\s?[\d٠-٩][\d٠-٩,.]*\s?(?:[kKmMbB%]|ألف|مليون|ريال|درهم|دولار)?/u,
  bidi: /[\u202a-\u202e\u2066-\u2069]/,
};

function evalSample(t, A, B, hits) {
  const blocks = A.blocks, shapes = A.shapes;
  const stable = (b) => B.blocks.some((c) => c.text === b.text && Math.abs(c.x0 - b.x0) < 0.006 && Math.abs(c.y0 - b.y0) < 0.006);
  const free = blocks.filter((b) => !b.ui);                       // outside any UI surface
  const maxFs = free.reduce((m, b) => Math.max(m, b.fs), 0);
  const clusterKinds = new Map();                                  // surface id (0 = page) -> {kinds:Set, ex:[], captured}
  const kind = (b, k, ex) => { const key = b.ui || 0; if (k === 'zinc' && !key) return; const c = clusterKinds.get(key) || { kinds: new Set(), ex: [], captured: false }; c.kinds.add(k); c.ex.push(ex); if (b.uiCaptured) c.captured = true; clusterKinds.set(key, c); };
  for (const b of blocks) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, small = b.fs <= 0.04, d = { text: b.text, snippet: b.snip, bbox: bb(b), fs: fsPct(b) };
    // vibe-coded UI patterns (apply everywhere, also inside UI cards)
    if (RX.greeting.test(b.text)) { addHit('V1', t, b.text, d); kind(b, 'greeting', b.text); }
    if (RX.labelValue.test(b.text) && !RX.meta.test(b.text)) { addHit('V2', t, b.text, d); kind(b, 'label.value', b.text); }
    if (ZINC.some((k) => near(b.color, k, 10)) && b.color[3] >= 0.5) { addHit('V4', t, '#' + b.color.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''), { ...d, text: b.text }); kind(b, 'zinc', b.text); }
    if (b.ui) continue;
    // page chrome
    const stab = stable(b);
    const corner = (cx < 0.2 || cx > 0.8) && (cy < 0.14 || cy > 0.86), edge = b.y1 < 0.07 || b.y0 > 0.93 || b.x1 < 0.05 || b.x0 > 0.95;
    if (small && stab && (corner || edge)) addHit('C1', t, b.text, d);
    if ((b.up && b.ls >= 0.05 && b.fs <= 0.045 && b.text.replace(/[^A-Za-z]/g, '').length >= 2) || (b.ls > 0.01 && /[\u0600-\u06FF]/.test(b.text))) addHit('C2', t, b.text, { ...d, note: 'letter-spacing ' + b.ls.toFixed(2) + 'em' });
    if (b.fs <= 0.06 && (RX.counterNum.test(b.text) || RX.counterWord.test(b.text) || (b.fs <= 0.05 && RX.counterBare.test(b.text))) && !/^\s*24\s*\/\s*7\b/.test(b.text)) addHit('C3', t, b.text, d);
    if ((RX.meta.test(b.text) && b.fs <= 0.06) || (RX.ver.test(b.text) && b.fs <= 0.04)) addHit('C4', t, b.text, d);
    if (b.mono && small) addHit('C5', t, b.text, d);
  }
  // C6: bars / hairlines / left+right small-text rows in the outer bands
  for (const s of shapes) {
    if (s.media || s.ui || s.selfSurface) continue;
    const w = s.x1 - s.x0, h = s.y1 - s.y0, cy = (s.y0 + s.y1) / 2;
    const band = cy < 0.12 || cy > 0.88, bandR = cy < 0.14 || cy > 0.86;
    if (w >= 0.6 && h <= 0.14 && band && (s.alpha >= 0.1 || s.border) && !(w >= 0.9 && h >= 0.9))
      addHit('C6', t, 'bar ' + s.snip + ' ' + bb(s).join(','), { text: '', snippet: s.snip, bbox: bb(s), note: 'full-width bar in the ' + (cy < 0.5 ? 'top' : 'bottom') + ' band' + (s.alpha >= 0.1 ? ' (filled)' : ' (border)') });
    else if (w >= 0.5 && s.h <= 4 && bandR) addHit('C6', t, 'rule ' + s.snip + ' ' + bb(s).join(','), { text: '', snippet: s.snip, bbox: bb(s), note: 'hairline rule in the ' + (cy < 0.5 ? 'top' : 'bottom') + ' band' });
  }
  for (const band of ['top', 'bottom']) {
    const row = free.filter((b) => b.fs <= 0.045 && (band === 'top' ? (b.y0 + b.y1) / 2 < 0.12 : (b.y0 + b.y1) / 2 > 0.88));
    const L = row.filter((b) => (b.x0 + b.x1) / 2 < 0.35), Rr = row.filter((b) => (b.x0 + b.x1) / 2 > 0.65);
    for (const a of L) for (const c of Rr) if (Math.abs((a.y0 + a.y1) / 2 - (c.y0 + c.y1) / 2) < 0.03 && stable(a) && stable(c))
      addHit('C6', t, 'row ' + a.text + '|' + c.text, { text: a.text + '  ...  ' + c.text, snippet: a.snip + ' + ' + c.snip, bbox: bb({ x0: a.x0, y0: Math.min(a.y0, c.y0), x1: c.x1, y1: Math.max(a.y1, c.y1) }), note: band + ' row: left and right small labels on one line' });
  }
  // C7 kicker, D1 deck
  const kickers = new Map();
  for (const a of free) for (const b of free) {
    if (a === b || !(a.fs <= 0.04) || !(b.fs >= a.fs * 2 && b.fs >= 0.05)) continue;
    const gap = b.y0 - a.y1; if (!(gap < 0.06 && gap > -0.01)) continue;
    const ax = (a.x0 + a.x1) / 2, bx = (b.x0 + b.x1) / 2;
    if (!(Math.abs(a.x0 - b.x0) < 0.02 || Math.abs(a.x1 - b.x1) < 0.02 || Math.abs(ax - bx) < 0.02) || !stable(a) || !stable(b)) continue;
    kickers.set(b.id, a);
    addHit('C7', t, a.text + '>' + b.text, { text: a.text + '  over  ' + b.text, snippet: a.snip + ' over ' + b.snip, bbox: bb({ x0: Math.min(a.x0, b.x0), y0: a.y0, x1: Math.max(a.x1, b.x1), y1: b.y1 }), fs: fsPct(b) });
  }
  const mediaR = (h) => shapes.find((s) => { const ar = (s.x1 - s.x0) * (s.y1 - s.y0), cx = (s.x0 + s.x1) / 2; return (s.media || s.selfSurface) && ar >= 0.04 && ar <= 0.7 && cx > 0.5 && s.x0 > h.x1 - 0.05 && s.y1 > h.y0 && s.y0 < h.y1 + 0.2; });
  const mediaL = (h) => shapes.find((s) => { const ar = (s.x1 - s.x0) * (s.y1 - s.y0), cx = (s.x0 + s.x1) / 2; return (s.media || s.selfSurface) && ar >= 0.04 && ar <= 0.7 && cx < 0.5 && s.x1 < h.x0 + 0.05 && s.y1 > h.y0 && s.y0 < h.y1 + 0.2; });
  for (const b of free) {
    const isLeftDeck = b.x0 < 0.2 && b.x0 >= 0.02 && b.x1 < 0.78;
    const isRightDeck = b.x1 > 0.8 && b.x1 <= 0.98 && b.x0 > 0.22 && /[\u0600-\u06FF]/.test(b.text);
    if (!(b.fs >= 0.05 && b.fs >= 0.85 * maxFs && (isLeftDeck || isRightDeck) && b.ta !== 'center' && Math.abs((b.x0 + b.x1) / 2 - 0.5) > 0.06 && stable(b))) continue;
    const ev = [];
    const sub = free.find((c) => c !== b && c.fs >= 0.02 && c.fs <= 0.6 * b.fs && c.y0 - b.y1 > -0.005 && c.y0 - b.y1 < 0.08 && (Math.abs(c.x0 - b.x0) < 0.03 || Math.abs(c.x1 - b.x1) < 0.03));
    if (sub) ev.push('sub-line "' + sub.text.slice(0, 30) + '"');
    if (kickers.has(b.id)) ev.push('kicker "' + kickers.get(b.id).text.slice(0, 30) + '"');
    const m = isLeftDeck ? mediaR(b) : mediaL(b); if (m) ev.push((isLeftDeck ? 'media on the right ' : 'media on the left ') + m.snip);
    if (b.lines >= 2) ev.push(b.lines + ' lines');
    const sideLabel = isRightDeck ? 'right-anchored RTL' : 'left-anchored';
    addHit('D1', t, b.text, { text: b.text, snippet: b.snip, bbox: bb(b), fs: fsPct(b), sev: ev.length ? 'FAIL' : 'WARN', note: ev.length ? sideLabel + ' headline with ' + ev.join(', ') : sideLabel + ' single-line headline (ok only as a split phrase under ~1.2 s)' });
  }
  // V3 status dots: a filled circle 6-14 px (at 1080p) with text right after it
  for (const s of shapes) {
    const w = s.x1 - s.x0, h = s.y1 - s.y0, px = s.h * (1080 / 1080);
    if (!(s.h >= 5 && s.h <= 15 && Math.abs(s.w - s.h) <= 2 && s.radiusPct >= 45 && s.alpha >= 0.5 && !s.media)) continue;
    const nb = blocks.find((b) => Math.abs((b.y0 + b.y1) / 2 - (s.y0 + s.y1) / 2) < 0.012 && b.x0 - s.x1 > -0.002 && b.x0 - s.x1 < 0.02);
    if (!nb) continue;
    const key = 'dot ' + nb.text;
    addHit('V3', t, key, { text: nb.text, snippet: s.snip + ' + ' + nb.snip, bbox: bb({ x0: s.x0, y0: Math.min(s.y0, nb.y0), x1: nb.x1, y1: Math.max(s.y1, nb.y1) }) });
    const c = clusterKinds.get(s.ui || 0) || { kinds: new Set(), ex: [], captured: false }; c.kinds.add('status dot'); c.ex.push('dot + ' + nb.text); if (nb.uiCaptured) c.captured = true; clusterKinds.set(s.ui || 0, c);
  }
  for (const [uid, c] of clusterKinds) if (c.kinds.size >= 2 && !c.captured)
    addHit('V5', t, (uid ? 'surface ' + uid : 'page') + [...c.kinds].sort().join('+'), { text: [...new Set(c.ex)].slice(0, 4).join('  |  '), snippet: uid ? 'UI surface #' + uid : 'page level', bbox: (() => { const sf = A.surfaces.find((q) => q.id === uid); return sf ? bb(sf) : [0, 0, 1, 1]; })(), note: 'kinds: ' + [...c.kinds].sort().join(', ') });
  else if (c.kinds.size >= 2 && c.captured) hits.exempt.add('V5 skipped in a [data-ui="captured"] surface (' + [...c.kinds].sort().join(', ') + ')');
}

// T1 letter-typed headlines: pair readings, mid-word growth; plus caret next to a headline-size block
function evalTyping(t, A, B) {
  const head = A.blocks.filter((b) => !b.ui && b.fs >= 0.05);
  for (const b of head) {
    const g = B.blocks.find((c) => !c.ui && Math.abs(c.y0 - b.y0) < 0.02 && (Math.abs(c.x0 - b.x0) < 0.03 || Math.abs((c.x0 + c.x1) / 2 - (b.x0 + b.x1) / 2) < 0.03) && c.text.length > b.text.length && c.text.startsWith(b.text));
    if (g) {
      const rest = g.text.slice(b.text.length), lastTok = b.text.split(/\s+/).pop(), tok2 = g.text.split(/\s+/)[b.text.split(/\s+/).length - 1] || '';
      const midWord = !/^\s/.test(rest) && tok2.length > lastTok.length && b.text.length >= 1;
      if (midWord) addHit('T1', t, b.text.slice(0, 20), { text: b.text + '  ->  ' + g.text, snippet: b.snip, bbox: bb(b), fs: fsPct(b), sev: 'FAIL', note: 'text grew by letters (' + b.text.length + ' -> ' + g.text.length + ' chars in 0.1 s)' });
    }
    const caret = A.shapes.find((s) => !s.media && !s.ui && s.w <= 0.012 * 1920 && s.h >= b.fs * 1080 * 0.6 && s.h <= b.fs * 1080 * 2.4 && s.x0 - b.x1 > -0.006 && s.x0 - b.x1 < 0.03 && s.y0 < b.y1 && s.y1 > b.y0 && s.alpha >= 0.3);
    if (caret || /[|▌█▍_]$/.test(b.text)) addHit('T1', t, 'caret ' + b.text.slice(0, 20), { text: b.text, snippet: b.snip, bbox: bb(b), fs: fsPct(b), sev: 'WARN', note: 'caret next to headline-size text (FAIL when the text also grows by letters)' });
  }
}

// ---------------------------------------------------------------- main
let br, exitCode = 0;
(async () => {
  br = await launchChrome({ args: ['--allow-file-access-from-files'] });
  let W = numOpt(opt.width, 'width'), H = numOpt(opt.height, 'height');
  const page = await br.newPage({ width: W || 1920, height: H || 1080, scale: 1 });
  const loaded = await page.goto(url, { timeout: 45000 });
  if (!loaded) console.error('warn: load event timed out, continuing');
  await page.eval(PAGE_LIB);
  await page.eval('window.__lintPrepare()', { timeout: 60000 });
  const info = await page.eval('window.__lintInfo()');
  W = W || info.width || 1920; H = H || info.height || 1080;
  await page.setViewport(W, H, 1);
  if (info.seek === 'none') console.error('warn: no seek mechanism found (__seek / __timelines / gsap): the page is read as a static frame');
  let dur = numOpt(opt.duration, 'duration') || info.duration;
  if (!(dur > 0)) { dur = 10; console.error('warn: duration unknown (set window.__duration or pass --duration); assuming 10 s'); }
  let times = userTimes;
  if (!times) {
    const n = numOpt(opt.samples, 'samples') || Math.max(12, Math.min(36, Math.round(dur * 1.5)));
    times = Array.from({ length: Math.round(n) }, (_, i) => +(((i + 0.5) * dur) / n).toFixed(2));
  }
  const hits = { exempt: new Set() };
  const barSeries = new Map();                                      // shape id -> [{t, w, snip, bbox}]
  for (const t of times) {
    await page.eval(`window.__lintSeek(${t})`, { timeout: 40000 });
    const A = JSON.parse(await page.eval('JSON.stringify(window.__lintScan())', { timeout: 30000 }));
    const t2 = t + 0.1 <= dur ? t + 0.1 : Math.max(0, t - 0.1);
    await page.eval(`window.__lintSeek(${t2})`, { timeout: 40000 });
    const B = JSON.parse(await page.eval('JSON.stringify(window.__lintScan())', { timeout: 30000 }));
    // order the pair so A is earlier (growth direction)
    const [P, Q] = t2 >= t ? [A, B] : [B, A];
    evalSample(t, A, t2 >= t ? B : A, hits);
    evalTyping(t, P, Q);
    for (const s of A.shapes) if (!s.media && !s.ui && !s.selfSurface && (s.h <= 0.016 * H) && s.w >= 2 && (s.alpha >= 0.2 || s.border)) {
      const a = barSeries.get(s.id) || []; a.push({ t, w: s.x1 - s.x0, snip: s.snip, bbox: bb(s) }); barSeries.set(s.id, a);
    }
  }
  // P1: a thin non-UI bar whose width grows (mostly non-decreasing, >= 0.08 W total) across >= 3 samples
  for (const [, a] of barSeries) {
    if (a.length < 3) continue;
    const ws = a.map((x) => x.w), grow = Math.max(...ws) - Math.min(...ws);
    let up = 0, dn = 0; for (let i = 1; i < ws.length; i++) { if (ws[i] > ws[i - 1] + 0.002) up++; else if (ws[i] < ws[i - 1] - 0.002) dn++; }
    if (grow >= 0.08 && up >= 2 && dn <= Math.max(0, Math.floor(up / 3)))
      for (const x of a) addHit('P1', x.t, a[0].snip, { text: '', snippet: a[0].snip, bbox: x.bbox, note: 'thin bar grows ' + r2(Math.min(...ws)) + ' -> ' + r2(Math.max(...ws)) + ' of W over t=' + a[0].t + '..' + a[a.length - 1].t });
  }
  await page.close();

  // ---------- report
  const out = { file: path.resolve(src.replace(/^file:\/\//, '')), width: W, height: H, duration: dur, samples: times, rules: [], exemptions: [...hits.exempt] };
  let failed = [];
  for (const r of Object.values(RULE)) {
    const hs = [...r.hits.values()].map((h) => ({ ...h, times: h.times.sort((a, b) => a - b) })).sort((a, b) => a.times[0] - b.times[0]);
    const status = !hs.length ? 'PASS' : hs.some((h) => h.sev === 'FAIL') ? 'FAIL' : 'WARN';
    if (status === 'FAIL') failed.push(r.id);
    out.rules.push({ id: r.id, name: r.name, status, hits: hs });
  }
  out.gate = failed.length ? 'FAIL' : 'PASS'; out.failed = failed;
  if (opt.json) console.log(JSON.stringify(out, null, 1));
  else {
    console.log(`lint.mjs ${out.file}  ${W}x${H}  duration ${dur}s  ${times.length} samples (${times.slice(0, 8).join(', ')}${times.length > 8 ? ', ...' : ''})`);
    for (const r of out.rules) {
      console.log(`${r.id} ${r.name.padEnd(46, '.')} ${r.status}${r.hits.length ? '  (' + r.hits.length + ' distinct)' : ''}`);
      for (const h of r.hits.slice(0, 6)) {
        const ts = h.times.length > 6 ? h.times.slice(0, 6).join(',') + ',... (' + h.times.length + ' samples)' : h.times.join(',') + 's';
        console.log(`    ${h.sev === 'WARN' && r.status === 'FAIL' ? '[warn] ' : ''}t=${ts}  ${h.text ? JSON.stringify(h.text.slice(0, 70)) + '  ' : ''}${h.snippet}  bbox=[${h.bbox.join(',')}]${h.fs ? '  fs=' + h.fs + '%H' : ''}${h.note ? '\n      ' + h.note : ''}`);
      }
      if (r.hits.length > 6) console.log(`    ... ${r.hits.length - 6} more (use --json)`);
    }
    for (const e of out.exemptions) console.log('note: ' + e);
    console.log(`GATE G5: ${out.gate}${failed.length ? '  (' + failed.join(', ') + ')' : ''}   (a lead, not a verdict: text inside images/canvas is not seen)`);
  }
  exitCode = out.gate === 'FAIL' ? 1 : 0;
})().catch((e) => { console.error('error: ' + e.message); exitCode = 2; })
  .finally(async () => { try { await br?.close(); } catch {} process.exit(exitCode); });
