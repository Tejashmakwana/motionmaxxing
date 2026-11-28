/* motion.js - the Motion runtime. One global, plain <script>, needs only gsap.
 *
 * SEEK CONTRACT: every frame is a pure function of t. Two mechanisms, both seek-safe:
 *   1. GSAP tweens are always fromTo with explicit start values + immediateRender:false (never relative, never set-and-forget).
 *   2. Everything stepped or textual (visibility, typing, counters, smear, line re-centring) is a "renderer" - a function
 *      (t, frame) => void that writes the DOM from scratch. All renderers run from ONE clock tween whose property is a
 *      setter, so they fire on every seek even when GSAP suppresses callbacks.
 * Visibility is ONE track per element (every show/enter/exit/cut adds an on/off op; the last op at or before the frame wins).
 * transform-origin is a per-element track too: camera/snap/dive/cursor each claim an origin from their own start frame.
 * M.hero3d(canvas|container, {objects|build, state}) adds a Three.js layer that is redrawn by the same clock (module loaded from ./hero3d/, see README "3D").
 * Frames are the unit (fps default 30). On a clock:'twos' film onsets are quantised to even frames and __seek() holds each
 * pose for two frames. Eases are copied from the measured-ease library (12 curves fitted to 53 human-made films).
 */
(function (root) {
'use strict';
const SELF = (document.currentScript && document.currentScript.src) || '', PENDING = [];   // SELF: where runtime/ lives (hero3d is loaded relative to it); PENDING: promises Motion.loaded() must wait for

/* ---------- measured eases (math copied from measured-eases.js; every f(0)=0, f(1)=1) ---------- */
const powerOut = p => t => 1 - Math.pow(1 - t, p);
const powerIn = p => t => Math.pow(t, p);
const expoOut = k => { const d = 1 - Math.exp(-k); return t => (1 - Math.exp(-k * t)) / d; };
const snapRamp = (w, tau) => { const n = w * (1 - Math.exp(-1 / tau)) + (1 - w); return t => (w * (1 - Math.exp(-t / tau)) + (1 - w) * t) / n; };
const snapOver = (A, ta, td) => { const f = t => (1 + A * Math.exp(-t / td)) * (1 - Math.exp(-t / ta)); const n = f(1); return t => f(t) / n; };
const spring = (c, om) => { const f = t => 1 - Math.exp(-c * t) * (Math.cos(om * t) + (c / om) * Math.sin(om * t)); const n = f(1); return t => f(t) / n; };
const smoothP = p => t => { const a = Math.pow(t, p), b = Math.pow(1 - t, p); return a / (a + b); };
const guard = f => t => (t <= 0 ? 0 : t >= 1 ? 1 : f(t));
const EASE = {
  crashIn: guard(snapOver(2.0, 0.19, 0.218)),   // hits and slightly passes its mark at once (peak 1.18 at t~.27)
  popOver: guard(spring(2.67, 4.36)),           // slow late overshoot, 1.08 at t~.72
  bounceHard: guard(spring(1.34, 5.07)),        // big overshoot 1.48, use sparingly
  snapSettle: guard(snapRamp(0.942, 0.118)),    // default hero entry: 54% of travel in the first 10% of the time
  softLand: guard(expoOut(3.41)),               // firm decelerate, the workhorse for text and panels
  whip: guard(powerOut(2.52)),                  // hard decelerating big move
  glide: guard(powerOut(1.7)),                  // gentle ease-out for medium moves
  cruise: guard(t => t),                        // linear: fades, drifts, counters
  softInOut: guard(smoothP(1.42)),              // symmetric S for opacity / blur
  gentleIn: guard(powerIn(2.07)),               // mild acceleration
  accelExit: guard(powerIn(2.6)),               // the leaving curve
  crashOut: guard(powerIn(3.97)),               // hard acceleration into a cut
};
const EASE_FRAMES = { crashIn: 10, popOver: 15, bounceHard: 22, snapSettle: 11, softLand: 12, whip: 7, glide: 10, cruise: 9, softInOut: 9, gentleIn: 9, accelExit: 13, crashOut: 17 };
const E = e => (typeof e === 'function' ? e : EASE[e] || e || EASE.cruise);   // name | fn | any GSAP ease string

/* ---------- small helpers ---------- */
const NS = 'http://www.w3.org/2000/svg', EPS = 1e-4;
const NEUT = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, scaleX: 1, scaleY: 1 };
const PROPS = { blur: { p: '--b', fmt: v => v + 'px' } };                        // blur lives in a CSS var read by the element's filter
const els = x => (typeof x === 'string' ? Array.from(document.querySelectorAll(x)) : x instanceof Element ? [x] : Array.from(x || []).reduce((a, y) => a.concat(els(y)), []));
const one = x => { const a = els(x); if (!a.length) throw new Error('Motion: no element for ' + x); return a[0]; };
const need = (T, what) => { if (!T.length) throw new Error('Motion: no element for ' + what); return T; };
const G = s => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);   // graphemes
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const rng = seed => { let a = (typeof seed === 'string' ? hash(seed) : (seed >>> 0)) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
// text measurement needs the real font: only cache a measurement once fonts and page are fully loaded
const memo = fn => { let v; return () => { if (v) return v; const r = fn(); if (document.fonts.status === 'loaded' && document.readyState === 'complete') v = r; return r; }; };

/* ---------- authored typing rhythm (deterministic; rules from the corpus) ---------- */
// prompt = UI prompt, 1-3.4 chars/frame in bursts | compose = 1 char per 2-4 f, 4-10 f after spaces | fast = 1-3 chars/f
const STY = {
  prompt: { chunks: [[1, .3], [2, .4], [3, .26], [4, .04]], step: r => (r() < .75 ? 1 : 2), space: r => (r() < .55 ? 1 + ((r() * 3) | 0) : 0), punct: r => 3 + ((r() * 3) | 0), last: r => 2 + (r() < .5 ? 1 : 0), lastK: 1, lead2: .3 },
  compose: { chunks: [[1, .88], [2, .12]], step: r => 2 + ((r() * 3) | 0), space: r => 4 + ((r() * 7) | 0), punct: r => 8 + ((r() * 7) | 0), last: r => 3 + (r() < .5 ? 1 : 0), lastK: 1, lead2: .15 },
  fast: { chunks: [[1, .5], [2, .35], [3, .15]], step: () => 1, space: r => (r() < .5 ? 1 : 2), punct: () => 3, last: () => 2, lastK: 2, lead2: .4 },
};
// cadence(text, {style, seed, start, cps, fps}) -> [[frame, nGraphemesVisible], ...] ending exactly on the full text
function cadence(text, o) {
  o = o || {};
  const g = G(text), n = g.length, r = rng(o.seed == null ? 1 : o.seed), S = STY[o.style || 'prompt'] || STY.prompt;
  const lastWord = Math.max(g.lastIndexOf(' '), g.lastIndexOf('\n')) + 1, ev = [];
  let f = o.start || 0, i = 0;
  const pick = tbl => { const x = r(); let a = 0; for (const [k, w] of tbl) { a += w; if (x < a) return k; } return tbl[0][0]; };
  while (i < n) {
    const inLast = lastWord > 0 && i >= lastWord;
    let k = inLast ? (r() < .8 ? S.lastK : 2) : pick(S.chunks);
    if (i === 0 && r() < S.lead2) k = Math.max(k, 2);                       // sometimes no lone leading letter
    const s1 = g.indexOf(' ', i), s2 = g.indexOf('\n', i), sp = s1 < 0 ? s2 : s2 < 0 ? s1 : Math.min(s1, s2);   // a chunk never crosses a space or a line break
    if (sp >= 0) { k = Math.min(k, sp + 1 - i); if (sp - i === 2 && g[sp] === ' ' && !inLast && r() < .6) k = 3; }   // a 2-letter word lands whole with its space
    i = Math.min(n, i + Math.max(1, k));
    ev.push([f, i]);
    const c = g[i - 1];
    f += inLast ? S.last(r) : S.step(r);
    if (c === ' ') f += S.space(r); else if (c === '\n' || /[.,;:!?]/.test(c)) f += S.punct(r);
  }
  if (o.cps) {                                                               // rescale to a target average chars/second
    const s0 = o.start || 0, span = ev[ev.length - 1][0] - s0 || 1, k = (n / o.cps * (o.fps || 30)) / span;
    let prev = -1;
    ev.forEach(e => { e[0] = Math.max(s0 + Math.round((e[0] - s0) * k), prev + 1); prev = e[0]; });
  }
  return ev;
}

/* ---------- the film ---------- */
function film(cfg) {
  cfg = cfg || {};
  const fps = cfg.fps || 30, duration = cfg.duration || 15, W = cfg.width || 1920, H = cfg.height || 1080;
  const twosClock = cfg.clock === 'twos';
  const tl = gsap.timeline({ paused: true });
  const F = n => n / fps;                                    // frames -> seconds
  const q = f => (twosClock ? Math.round(f / 2) * 2 : f);    // quantise an onset (even frames on a twos film)
  const frameOf = t => Math.floor(t * fps + 1e-6);
  const R = [], events = [], VIS = new Map(), FX = new Map();
  let curT = 0, uid = 0, seeded = false, defs = null;

  /* renderer clock: a setter on a plain object, tweened over the whole film (fires even if GSAP suppresses onUpdate) */
  const renderAt = t => { curT = t; const fr = frameOf(t); for (let i = 0; i < R.length; i++) R[i](t, fr); };
  const clock = {};
  Object.defineProperty(clock, 't', { get: () => curT, set: renderAt });
  tl.fromTo(clock, { t: 0 }, { t: duration, duration, ease: 'none', immediateRender: false, lazy: false }, 0);

  /* seek contract + HyperFrames attributes */
  const seek = t => {
    t = Math.max(0, Math.min(duration, t));
    if (twosClock) { let fr = frameOf(t); fr -= fr % 2; t = fr / fps; }
    if (!seeded) { seeded = true; tl.pause(); tl.time(duration, false); renderAt(duration); }   // warm-up: GSAP has not rendered anything yet, so run the whole film once
    tl.pause(); tl.time(t, false); renderAt(t);
  };
  (root.__timelines = root.__timelines || {}).main = tl;
  root.__seek = seek; root.__duration = duration;
  Object.defineProperty(root, '__events', { configurable: true, get: () => events.slice().sort((a, b) => a.frame - b.frame) });
  const main = document.getElementById('main') || document.querySelector('[data-composition-id]');
  if (main) Object.entries({ 'data-composition-id': 'main', 'data-start': 0, 'data-duration': duration, 'data-width': W, 'data-height': H }).forEach(([k, v]) => main.setAttribute(k, v));
  // paint frame 0 for a human opening the file (a renderer's own first seek wins)
  root.addEventListener('load', () => document.fonts.ready.then(() => { if (!seeded) seek(0); }));

  const mark = (frame, type, label) => { events.push({ t: +(frame / fps).toFixed(4), frame, type, label: label == null ? '' : String(label) }); };
  const nm = e => (e.id ? '#' + e.id : e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : e.tagName.toLowerCase());

  /* core tween: explicit from + to; completes exactly ON frame b (a==b is a hard step that has landed by frame a) */
  const tw = (T, prop, va, vb, a, b, ease, fmt) => {
    fmt = fmt || (v => v);
    return tl.fromTo(T, { [prop]: fmt(va) }, { [prop]: fmt(vb), duration: Math.max(F(b - a), EPS), ease: E(ease), immediateRender: false, lazy: false }, Math.max(0, b === a ? F(a) - EPS : F(a)));
  };

  /* initial value of a (element, prop) pair = the `from` of its EARLIEST segment, set once at time 0 (several segments on one prop must not each reset it) */
  const INIT = new Map();
  const init = (T, prop, val, f) => T.forEach(e => {
    const m = INIT.get(e) || INIT.set(e, {}).get(e), c = m[prop];
    if (c && c.f <= f) return;
    if (c) c.tw.kill();
    m[prop] = { f, tw: tl.set(e, { [prop]: val, lazy: false }, 0) };
  });

  /* ---- M.kf: frame keyframes. keys [[frame, value, ease?]]; ease? belongs to the segment ENDING at that key ---- */
  function kf(target, prop, keys, o) {
    o = o || {};
    const T = need(els(target), prop), fmt = o.fmt || (v => v), step = o.step || 0;
    init(T, prop, fmt(keys[0][1]), q(keys[0][0]));
    for (let i = 1; i < keys.length; i++) {
      const a = q(keys[i - 1][0]), b = q(keys[i][0]), va = keys[i - 1][1], vb = keys[i][1];
      const e = E(keys[i][2] != null ? keys[i][2] : Array.isArray(o.ease) ? o.ease[Math.min(i - 1, o.ease.length - 1)] : o.ease);
      if (step && typeof va === 'number' && typeof vb === 'number' && b > a) {    // hold each pose `step` frames (cursor on twos)
        let prev = va;
        for (let k = a + step; k < b; k += step) { const v = va + (vb - va) * e((k - a) / (b - a)); tw(T, prop, prev, v, k, k, 'cruise', fmt); prev = v; }
        tw(T, prop, prev, vb, b, b, 'cruise', fmt);
      } else tw(T, prop, va, vb, a, b, e, fmt);
    }
  }

  /* ---- visibility: ONE track per element. show/enter/exit/cut/cursor/hide each add a hard on or off op at a frame; the state at frame f is the LAST op at or
        before f (same frame: authored later wins), so enter + show(a, b) = visible on [at, b) and an explicit later hide always wins.
        If the earliest op is an "off", the element is visible until it (an exit or cut-hide on something never shown). Before the first "on": hidden. ---- */
  const vis = el => {
    let r = VIS.get(el);
    if (!r) { r = { ops: [], n: 0, dirty: false, last: null }; VIS.set(el, r);
      R.push((t, fr) => {
        if (r.dirty) { r.ops.sort((a, b) => a.f - b.f || a.n - b.n); r.dirty = false; }
        let v = r.ops[0].on === false;
        for (let i = 0; i < r.ops.length && r.ops[i].f <= fr; i++) v = r.ops[i].on;
        if (v !== r.last) { r.last = v; el.style.visibility = v ? '' : 'hidden'; } }); }
    return r;
  };
  const vop = (T, f, on) => T.forEach(e => { const r = vis(e); r.ops.push({ f: q(f), on, n: r.n++ }); r.dirty = true; });
  const showQ = (T, on, off) => { vop(T, on, true); if (off != null && off !== Infinity) vop(T, off, false); };
  const hideQ = (T, f) => vop(T, f, false);
  const show = (el, on, off) => { const T = need(els(el), 'show'); showQ(T, on, off); mark(q(on), 'show', T.map(nm).join(',')); };
  const hide = (el, f, label) => { const T = need(els(el), 'hide'); hideQ(T, f); mark(q(f), 'hide', label || T.map(nm).join(',')); };
  const cut = (frame, o) => {
    o = o || {}; const h = els(o.hide || []), s = els(o.show || []);
    hideQ(h, frame); showQ(s, frame);
    mark(q(frame), 'cut', o.label || ((h.length ? 'hide ' + h.map(nm).join(',') : '') + (s.length ? ' show ' + s.map(nm).join(',') : '')).trim());
  };

  /* ---- transform-origin: a per-element track. Each camera/snap/dive/cursor call CLAIMS an origin from its own start frame (switching is seek-safe, driven by one renderer).
          Two claims with different origins that overlap in time, or a switch while the earlier claim ends scaled/rotated (the element would jump), warn on the console:
          put one of them on a parent (M.wrap) instead. ---- */
  const ORG = new Map(), warned = new Set();
  const orgStr = v => (Array.isArray(v) ? v.map(x => (typeof x === 'number' ? x + 'px' : x)).join(' ') : String(v)).trim().replace(/\s+/g, ' ');
  const warn = m => { if (!warned.has(m)) { warned.add(m); if (root.console) console.warn('[Motion] ' + m); } };
  const claimOrigin = (T, f, v, end, neutral, who) => T.forEach(e => {
    let r = ORG.get(e);
    if (!r) { r = { cl: [], last: null, dirty: false }; ORG.set(e, r);
      R.push((t, fr) => {
        if (r.dirty) { r.cl.sort((a, b) => a.f - b.f); r.dirty = false; }
        let o = r.cl[0].v; for (let i = 0; i < r.cl.length && r.cl[i].f <= fr; i++) o = r.cl[i].v;
        if (o !== r.last) { r.last = o; e.style.transformOrigin = o; } }); }
    v = orgStr(v);
    const c = { f, e: end, v, neutral, who };
    r.cl.forEach(p => {
      if (p.v === v) return;
      const a = p.f <= c.f ? p : c, b = a === p ? c : p;                      // a starts first
      if (a.e > b.f) warn(nm(e) + ': ' + a.who + ' (origin ' + a.v + ') and ' + b.who + ' (origin ' + b.v + ') overlap on one element; transform-origin is one value per element at a time. Put one on a parent: M.wrap(el).');
      else if (!a.neutral) warn(nm(e) + ': origin switches from ' + a.v + ' (' + a.who + ') to ' + b.v + ' (' + b.who + ') on frame ' + b.f + ' while the first leaves the element scaled/rotated, so it will jump. Return it to scale 1 / rotation 0 first, or put one on a parent: M.wrap(el).');
    });
    r.cl.push(c); r.dirty = true;
    if (r.cl.length === 1) e.style.transformOrigin = v;                       // page looks right before any seek
  });
  // M.wrap(el): put el inside a new <div class="mwrap"> that takes over its layout role and return the wrapper (animate el and the wrapper independently: nested wrappers = independent origins)
  const wrap = (el, o) => {
    o = o || {};
    const out = need(els(el), 'wrap').map(e => {
      const cs = getComputedStyle(e), w = document.createElement('div'); w.className = 'mwrap' + (o.className ? ' ' + o.className : '');
      const abs = /^(absolute|fixed)$/.test(cs.position);
      w.style.cssText = abs ? 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none' : 'display:' + (/^inline/.test(cs.display) ? 'inline-block' : 'block');
      if (cs.zIndex !== 'auto') w.style.zIndex = cs.zIndex;
      if (o.id) w.id = o.id;
      e.parentNode.insertBefore(w, e); w.appendChild(e);
      return w;
    });
    return out.length === 1 ? out[0] : out;
  };
  const isNeutral = (sc, ro) => Math.abs((sc == null ? 1 : sc) - 1) < 1e-3 && Math.abs(ro || 0) < 1e-3;

/* ---- per-element effects: CSS-var blur + a directional (smear) SVG blur, one filter per element ---- */
  const fxOf = el => {
    let r = FX.get(el);
    if (r) return r;
    if (!defs) { const s = document.createElementNS(NS, 'svg'); s.setAttribute('width', 0); s.setAttribute('height', 0); s.setAttribute('aria-hidden', 'true'); s.style.cssText = 'position:absolute;width:0;height:0'; defs = document.createElementNS(NS, 'defs'); s.appendChild(defs); document.body.appendChild(s); }
    const cf = getComputedStyle(el).filter;
    r = { id: 'mf' + (++uid), sm: [], blur: false, base: cf && cf !== 'none' ? cf : '', last: null };
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', r.id); f.setAttribute('x', '-50%'); f.setAttribute('y', '-50%'); f.setAttribute('width', '200%'); f.setAttribute('height', '200%'); f.setAttribute('color-interpolation-filters', 'sRGB');
    r.g = document.createElementNS(NS, 'feGaussianBlur'); r.g.setAttribute('stdDeviation', '0 0'); f.appendChild(r.g); defs.appendChild(f);
    FX.set(el, r);
    R.push((t, fr) => {                                           // smear: stdDeviation (= length/2) along the axis, per frame
      let sx = 0, sy = 0;
      for (const s of r.sm) {
        const i = fr - s.at; if (i < 0 || i >= s.N) continue;
        const v = s.px / 2 * Math.pow(s.peak === 'last' ? (i + 1) / s.N : 1 - i / s.N, 2.5);
        if (s.axis === 'y') sy = Math.max(sy, v); else sx = Math.max(sx, v);
      }
      const a = sx.toFixed(3) + ' ' + sy.toFixed(3);
      if (a !== r.last) { r.last = a; r.g.setAttribute('stdDeviation', a); }
    });
    return r;
  };
  const fxApply = (el, r) => { el.style.filter = [r.base, r.sm.length ? 'url(#' + r.id + ')' : '', r.blur ? 'blur(var(--b,0px))' : ''].filter(Boolean).join(' '); };
  const useBlur = e => { const r = fxOf(e); r.blur = true; fxApply(e, r); };
  const smear = (T, at, c, peak) => T.forEach(e => { const r = fxOf(e); r.sm.push({ at: q(at), N: c.frames || 3, px: c.px, axis: c.axis || 'x', peak }); fxApply(e, r); });

  /* ---- enter / exit: hard appearance on frame `at`, then travel; smear peaks on the first (enter) or last (exit) frame ---- */
  function travel(el, o, enter) {
    const T = need(els(el), 'enter/exit'), at = q(o.at || 0), frames = o.frames == null ? 12 : o.frames;
    const ease = o.ease || (enter ? 'softLand' : 'accelExit'), away = (enter ? o.from : o.to) || {}, rest = (enter ? o.to : o.from) || {};
    Object.keys(away).forEach(k => {
      const P = PROPS[k] || { p: k, fmt: v => v }, ra = away[k], rb = rest[k] != null ? rest[k] : NEUT[k];
      const isO = k === 'opacity', n = isO ? Math.min(frames, o.fadeFrames || 5) : frames, ez = isO ? (o.fadeEase || 'cruise') : ease;
      const s = enter || !isO ? at : at + frames - n;               // exit fades finish together with the move
      if (k === 'blur') T.forEach(useBlur);
      if (enter) { init(T, P.p, P.fmt(ra), s); tw(T, P.p, ra, rb, s, s + n, ez, P.fmt); }
      else tw(T, P.p, rb, ra, s, s + n, ez, P.fmt);
    });
    if (o.smear) {
      const c = o.smear === true ? {} : o.smear, dx = Math.abs(away.x || 0), dy = Math.abs(away.y || 0), d = Math.max(dx, dy, 60), N = c.frames || 3;
      smear(T, enter ? at : at + frames - N, { axis: c.axis || (dy > dx ? 'y' : 'x'), px: c.px == null ? Math.max(12, d * .25) : c.px, frames: N }, enter ? 'first' : 'last');
    }
    if (enter) showQ(T, at); else if (o.hide !== false) hideQ(T, at + frames);
    mark(at, enter ? 'enter' : 'exit', o.label || T.map(nm).join(','));
  }
  const enter = (el, o) => travel(el, o || {}, true), exit = (el, o) => travel(el, o || {}, false);

  /* ---- M.words: whole-word build; each word enters whole on its onset (never letter by letter) ---- */
  function words(el, o) {
    o = o || {};
    const host = one(el), text = host.textContent, mech = o.mech || 'rise', fixed = o.fixedSlots !== false;
    const toks = text.split(/(\s+)/).filter(s => s.length), at = q(o.at || 0);
    const wrap = document.createElement('span'); wrap.style.cssText = 'display:inline-block;position:relative;white-space:pre';
    const spans = [];
    host.textContent = '';
    toks.forEach(tk => {
      if (/^\s+$/.test(tk)) { (fixed ? host : wrap).appendChild(document.createTextNode(tk)); return; }
      const s = document.createElement('span'); s.className = 'mw'; s.textContent = tk; s.style.cssText = 'display:inline-block;white-space:pre';
      (fixed ? host : wrap).appendChild(s); spans.push(s);
    });
    if (!fixed) host.appendChild(wrap);
    const n = spans.length;
    let gaps = o.gaps;
    if (gaps == null) gaps = spans.map((_, i) => (i === 0 ? 4 : i === n - 2 ? 6 : 3));   // speech-like: quick middle, slower last word
    const on = []; let f = at;
    spans.forEach((_, i) => { on.push(f); f += q(Array.isArray(gaps) ? gaps[Math.min(i, gaps.length - 1)] : gaps) || 0; });
    const MECH = {
      rise: { f: d => ({ y: d == null ? 64 : d }), ease: 'softLand', ax: 'y' },
      slide: { f: d => ({ x: d == null ? 160 : d }), ease: 'softLand', ax: 'x' },
      pop: { f: d => ({ scale: d == null ? .5 : d }), ease: 'popOver' },
      shrink: { f: d => ({ scale: d == null ? 1.6 : d }), ease: 'softLand' },
      focus: { f: d => ({ blur: d == null ? 18 : d, opacity: 0 }), ease: 'softInOut' },
    }[mech];
    if (!MECH) throw new Error('Motion.words: unknown mech ' + mech);
    // per-word options: dist may be a number, an array (last value repeats) or (i, word) => number; `words` (array or (i, word) => object | null) can set
    // { dist, scale (start scale, any mech), from (explicit start pose), frames, ease, accent: true | colour | {color, frames} | false } for individual words
    const pick = (v, i, w) => (typeof v === 'function' ? v(i, w) : Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
    const ov = spans.map((sp, i) => pick(o.words, i, sp.textContent) || {});
    const pose = spans.map((sp, i) => {
      const d = ov[i].dist != null ? ov[i].dist : pick(o.dist, i, sp.textContent);
      return ov[i].from || Object.assign(MECH.f(d), ov[i].scale != null ? { scale: ov[i].scale } : {});
    });
    const ease = o.ease || MECH.ease, frames = o.frames || EASE_FRAMES[ease] || 12;
    const acc = o.accent && o.accent.color ? o.accent : null;
    const accIdx = acc ? (acc.word === 'all' ? spans.map((_, i) => i) : [].concat(acc.word == null ? -1 : acc.word).map(i => (i < 0 ? n + i : i))) : [];
    const accOf = i => {
      const a = ov[i].accent;
      if (a === false) return null;
      if (a == null) return accIdx.includes(i) ? acc : null;
      if (a === true) return acc || (o.accentColor ? { color: o.accentColor } : null);
      return typeof a === 'string' ? { color: a } : a;
    };
    spans.forEach((s, i) => {
      const fr = ov[i].frames || (ov[i].ease ? EASE_FRAMES[ov[i].ease] : 0) || frames, ez = ov[i].ease || ease, from = pose[i], sd = Math.abs(from.x || from.y || 0);
      enter(s, { at: on[i], frames: fr, ease: ez, from, label: s.textContent,
        smear: o.smear && MECH.ax ? Object.assign({ axis: MECH.ax, px: Math.max(14, sd * .3), frames: 3 }, o.smear === true ? {} : o.smear) : null });
      mark(on[i], 'word', s.textContent);
      const a = accOf(i);
      if (a && a.color) tw(s, 'color', a.color, getComputedStyle(s).color, on[i], on[i] + (a.frames || 20), 'softInOut');   // accent on arrival, settles to ink
    });
    if (!fixed && n > 1) {                                           // keep the visible line centred (LTR and RTL safe): measure once, glide the line x
      const set = gsap.quickSetter(wrap, 'x', 'px'), slide = o.recentreFrames || frames, ez = E('glide');
      const S = memo(() => {
        const lefts = spans.map(s => s.offsetLeft), rights = spans.map(s => s.offsetLeft + s.offsetWidth);
        const minL = Math.min(...lefts), maxR = Math.max(...rights), full = Math.max(1, maxR - minL);
        const isRtl = getComputedStyle(host).direction === 'rtl' || (spans[0].offsetLeft > spans[n - 1].offsetLeft);
        return spans.map((_, k) => {
          const curMin = Math.min(...lefts.slice(0, k + 1)), curMax = Math.max(...rights.slice(0, k + 1));
          const w = curMax - curMin;
          return isRtl ? -(full - w) / 2 : (full - w) / 2;
        });
      });
      R.push(t => {
        const s = S(), ft = t * fps; let k = 0;
        while (k + 1 < n && on[k + 1] <= ft) k++;
        set(k === 0 ? s[0] : s[k - 1] + (s[k] - s[k - 1]) * ez(clamp01((ft - on[k]) / slide)));
      });
    }
    return on;
  }

  /* ---- M.type: grapheme-safe typing from authored events; one renderer, so seek-safe.
          The host may hold plain text ("\n" = line break) or pre-styled children (<span class="k">const</span> ..., <br>): the text is revealed grapheme by grapheme across
          the children and every span keeps its own styling (syntax-highlighted code). The caret follows the last revealed glyph in 2D (x, and y on multi-line text). ---- */
  function type(el, o) {
    o = o || {};
    const host = one(el), at = q(o.at || 0);
    const tok = [], g = [];                                           // flatten the host once: open / close / void tags and graphemes (a <br> is one '\n')
    (function walk(nd) {
      nd.childNodes.forEach(c => {
        if (c.nodeType === 3) G(c.data).forEach(ch => { tok.push({ k: 'g', ch }); g.push(ch); });
        else if (c.nodeType !== 1) return;
        else if (c.tagName === 'BR') { tok.push({ k: 'g', ch: '\n' }); g.push('\n'); }
        else {
          const h = c.cloneNode(false).outerHTML, ci = h.lastIndexOf('</');
          if (ci < 0) { tok.push({ k: 'v', h }); return; }             // void element (img ...): shown once the text before it is
          const oi = tok.length; tok.push({ k: 'o', h: h.slice(0, ci), t: h.slice(ci) }); walk(c); tok.push({ k: 'c', t: h.slice(ci) }); tok[oi].end = tok.length - 1;
        }
      });
    })(host);
    const rel = o.events || cadence(g.join(''), { style: o.style || 'compose', seed: o.seed, cps: o.cps, fps });
    const ev = rel.map(e => [q(at + e[0]), e[1] === 'all' ? g.length : Math.min(g.length, e[1])]);
    const caret = o.caret ? one(o.caret) : null, gap = o.caretGap == null ? 4 : o.caretGap, acc = o.accentNewest;
    host.style.whiteSpace = 'pre';
    const html = (n, hot, mk) => {                                    // markup showing the first n graphemes; hot = [from, to) painted in the accent colour
      let out = '', cnt = 0, on = false; const st = [];
      const hotOff = () => { if (on) { out += '</span>'; on = false; } };
      for (let k = 0; k < tok.length; k++) {
        const t = tok[k];
        if (t.k === 'g') {
          if (cnt >= n) break;
          const isHot = hot && cnt >= hot[0] && cnt < hot[1];
          if (isHot && !on) { out += '<span style="color:' + acc.color + '">'; on = true; } else if (!isHot) hotOff();
          out += esc(t.ch); cnt++;
        } else if (t.k === 'o') { hotOff(); if (cnt >= n) { k = t.end; continue; } out += t.h; st.push(t.t); }
        else if (t.k === 'c') { hotOff(); out += st.pop(); }
        else if (cnt < n) { hotOff(); out += t.h; }
      }
      hotOff(); while (st.length) out += st.pop();
      return out + (mk || '');
    };
    const meas = memo(() => {                                         // full line width + the caret position (host-local px, untransformed) after every grapheme
      const keep = host.innerHTML, w0 = host.style.width, xs = [], ys = [];
      const mk = '<span data-mk style="display:inline-block;width:0;height:0;overflow:hidden"></span>';
      host.style.width = 'max-content'; host.innerHTML = html(g.length);
      const sc = host.offsetWidth ? host.getBoundingClientRect().width / host.offsetWidth : 1, full = host.getBoundingClientRect().width / sc;
      host.style.width = o.recenter ? 'max-content' : full.toFixed(2) + 'px';
      for (let i = 0; i <= g.length; i++) {
        host.innerHTML = html(i, null, mk);
        const m = host.querySelector('[data-mk]').getBoundingClientRect(), h = host.getBoundingClientRect();
        xs.push((m.left - h.left) / sc); ys.push((m.top - h.top) / sc);
      }
      host.innerHTML = keep; host.style.width = w0;
      return { full, xs, ys, multi: ys.some(v => Math.abs(v - ys[0]) > .5) };
    });
    let lastHtml = null, cTop = null;
    R.push((t, fr) => {
      let idx = -1; while (idx + 1 < ev.length && ev[idx + 1][0] <= fr) idx++;
      const n = idx < 0 ? 0 : ev[idx][1], prev = idx > 0 ? ev[idx - 1][1] : 0, m = meas();
      const h = html(n, acc && idx >= 0 && n > prev && fr - ev[idx][0] < (acc.frames || 2) ? [prev, n] : null);
      if (h !== lastHtml) { lastHtml = h; host.innerHTML = h; }
      host.style.width = o.recenter ? 'max-content' : m.full.toFixed(2) + 'px';   // recenter:false reserves the full line; true shrink-wraps (a centred host re-centres)
      if (caret) {
        if (cTop == null) cTop = caret.offsetTop;                     // the caret's authored top = the first line
        const isRtl = getComputedStyle(host).direction === 'rtl';
        const cw = caret.offsetWidth || 4;
        caret.style.visibility = fr >= ev[0][0] - 1 && (o.caretOff == null || fr < q(o.caretOff)) ? '' : 'hidden';
        caret.style.left = (host.offsetLeft + m.xs[n] + (isRtl ? -(gap + cw) : gap)) + 'px';
        if (m.multi) caret.style.top = (cTop + m.ys[n] - m.ys[0]) + 'px';
      }
    });
    mark(ev[0][0], 'type', 'start'); mark(ev[ev.length - 1][0], 'type', 'end');
    return ev.map(e => e[0]);
  }

  /* ---- cursor, press ---- */
  function cursor(el, o) {
    o = o || {};
    const T = need(els(el), 'cursor'), keys = o.keys, ez = o.ease || 'glide';
    claimOrigin(T, 0, '0 0', Infinity, false, 'M.cursor');            // art is drawn tip-at-origin: scale/rotate about the tip
    ['x', 'y', 'scale', 'rotation'].forEach((p, j) => {
      const ks = keys.filter(k => k[j + 1] != null).map(k => [k[0], k[j + 1]]);
      if (ks.length) kf(T, p, ks, { ease: ez, step: o.twos ? 2 : 0 });
    });
    showQ(T, keys[0][0], o.hideAt);
  }
  function press(cur, tgt, o) {
    o = o || {};
    const C = need(els(cur), 'press cursor'), Tg = need(els(tgt), 'press target'), at = q(o.at || 0);
    const down = o.frames || 3, up = o.releaseFrames || down + 1, lag = o.lag == null ? 1 : o.lag, hold = o.hold || 0;
    const squash = (T, base, depth, a) => {
      tw(T, 'scale', base, base * depth, a, a + down, 'softInOut');
      if (o.release !== false) tw(T, 'scale', base * depth, base, a + down + hold, a + down + hold + up, 'softLand');
    };
    squash(C, o.cursorBase || 1, o.cursorDepth == null ? .8 : o.cursorDepth, at);
    squash(Tg, o.targetBase || 1, o.targetDepth == null ? .8 : o.targetDepth, at + lag);
    if (o.targetStep) Object.entries(o.targetStep).forEach(([p, v]) => {   // hard colour step on the target (no tween), e.g. {backgroundColor:'#..'}
      const c0 = getComputedStyle(Tg[0])[p]; tw(Tg, p, c0, v, at + lag, at + lag);
      if (o.release !== false) tw(Tg, p, v, c0, at + lag + down + hold, at + lag + down + hold);
    });
    mark(at, 'press', o.label || nm(Tg[0]));
  }

  /* ---- camera family ---- */
  function camera(el, keys, o) {
    o = o || {};
    const T = need(els(el), 'camera');
    const last = keys[keys.length - 1][1], first = keys[0][0];
    claimOrigin(T, q(first), o.origin || '50% 50%', q(keys[keys.length - 1][0]), isNeutral(last.scale, last.rotation), 'M.camera');
    ['scale', 'x', 'y', 'rotation'].filter(p => keys.some(k => k[1][p] != null)).forEach(p => {
      let prev = NEUT[p];
      kf(T, p, keys.map(k => { if (k[1][p] != null) prev = k[1][p]; return [k[0], prev, k[2]]; }), { ease: o.ease || 'glide' });
    });
  }
  // one-frame snap: frame `at` = from, frame at+1 already `firstFrameShare` of the way, then a decelerating tail
  function snap(el, o) {
    const at = o.at, sh = o.firstFrameShare == null ? .6 : o.firstFrameShare, tail = o.tail == null ? 15 : o.tail, T = need(els(el), 'snap');
    if (o.origin) claimOrigin(T, q(at), o.origin, q(at) + 1 + tail, isNeutral(o.to && o.to.scale, o.to && o.to.rotation), 'M.snap');
    Object.keys(Object.assign({}, o.from, o.to)).forEach(p => {
      const a = o.from && o.from[p] != null ? o.from[p] : NEUT[p], b = o.to && o.to[p] != null ? o.to[p] : NEUT[p];
      kf(T, p, [[at, a], [at + 1, a + (b - a) * sh, 'cruise'], [at + 1 + tail, b, o.ease || 'softLand']]);
    });
    mark(q(at), 'snap', o.label || nm(T[0]));
  }
  function whip(el, o) {
    const T = need(els(el), 'whip'), at = q(o.at), fr = o.frames || 8, dx = o.dx || 0, dy = o.dy || 0, f0 = o.from || {};
    if (dx) tw(T, 'x', f0.x || 0, (f0.x || 0) + dx, at, at + fr, 'whip');
    if (dy) tw(T, 'y', f0.y || 0, (f0.y || 0) + dy, at, at + fr, 'whip');
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    smear(T, at, { axis: Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y', px: o.smearPx == null ? Math.min(90, Math.max(8, d * .15)) : o.smearPx, frames: Math.min(fr, 4) }, 'first');
    mark(at, 'whip', o.label || nm(T[0]));
  }
  // constant-octave dive: scale multiplies by perStep every frame (no ease: the zoom never slows)
  function dive(el, o) {
    const T = need(els(el), 'dive'), at = q(o.at || 0), frames = o.frames || 9, ps = o.perStep || 1.6, org = o.origin || [W / 2, H / 2];
    claimOrigin(T, at, org, at + frames, false, 'M.dive');
    const ks = []; for (let i = 0; i <= frames; i++) ks.push([at + i, Math.pow(ps, i)]);
    kf(T, 'scale', ks, { ease: 'cruise' });
    mark(at, 'dive', o.label || nm(T[0]));
  }
  // linear never-freeze drift
  const drift = (el, o) => kf(el, o.prop || 'scale', [[o.start || 0, o.from], [o.end == null ? duration * fps : o.end, o.to]], { ease: 'cruise' });

  /* ---- count: one value per frame, decaying step sizes, digits never eased; lands exactly on `to` ---- */
  function count(el, o) {
    const host = one(el), at = q(o.at || 0), N = Math.max(1, o.frames || 24), r = rng(o.seed == null ? 3 : o.seed), round = o.round !== false;
    const fmtf = o.format === 'comma' ? v => v.toLocaleString('en-US') : o.format === 'ar' ? v => Number(v).toLocaleString('ar-EG') : o.format || (v => String(v));
    const w = []; for (let i = 0; i < N; i++) { let x = Math.pow(1 - i / N, 1.6) + .12; if (o.skip && r() < o.skip) x *= 2.2; w.push(x); }
    const tot = w.reduce((a, b) => a + b, 0), span = o.to - o.from, sg = Math.sign(span); let acc = 0;
    const vals = [o.from];
    w.forEach((x, i) => {
      acc += x; let v = o.from + span * acc / tot;
      if (round) { v = Math.round(v); if (Math.abs(span) >= N) { const lo = vals[i] + sg, hi = o.to - sg * (N - 1 - i); v = sg > 0 ? Math.min(Math.max(v, lo), hi) : Math.max(Math.min(v, lo), hi); } }
      vals.push(v);
    });
    vals[N] = o.to;
    host.style.fontVariantNumeric = 'tabular-nums';
    let last = null;
    R.push((t, fr) => { const i = fr - at, s = fmtf(i <= 0 ? o.from : i >= N ? o.to : vals[i]); if (s !== last) { last = s; host.textContent = s; } });
    mark(at, 'count', 'start ' + o.from); mark(at + N, 'count', 'land ' + o.to);
    return vals;
  }
  function cascade(list, o) {
    const T = els(list), gaps = o.gaps == null ? 2 : o.gaps, out = []; let f = q(o.at || 0);
    T.forEach((e, i) => { out.push(f); o.fn(e, f, i); mark(f, 'cascade', nm(e)); f += Array.isArray(gaps) ? gaps[Math.min(i, gaps.length - 1)] : gaps; });
    return out;
  }

  /* ---- M.hero3d: a seek-safe Three.js layer driven by the film clock (module loaded lazily from runtime/hero3d/; no importmap, no build). state(t, objs, ctx) gets t in SECONDS
          quantised to the film frame (a twos film already holds even frames); it is a pure function (the harness resets every object, light and the camera first). ---- */
  function hero3d(target, o) {
    o = Object.assign({}, o);
    let cv = one(target);
    if (cv.tagName !== 'CANVAS') { const c = document.createElement('canvas'); c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block'; cv.appendChild(c); cv = c; }
    cv.width = o.width || W; cv.height = o.height || H;
    const api = { canvas: cv, hero: null, H: null, ready: null };
    let last = null, drawn = null;
    const draw = fr => { const tq = fr / fps; if (drawn === tq) return; drawn = tq; api.hero.renderAt(tq, undefined, fr); };
    R.push((t, fr) => { last = fr; if (api.hero && root.__mdSnap !== false) draw(fr); });   // __mdSnap===false: selfTest is stepping through frames it will not snapshot
    const url = o.module || (SELF ? new URL('hero3d/hero3d.js', SELF).href : '');
    delete o.module;
    api.ready = (url ? import(url) : Promise.reject(new Error('Motion.hero3d: runtime path unknown (motion.js was inlined). Pass { module: "<url of runtime/hero3d/hero3d.js>" }.'))).then(async H => {
      Object.assign(H.ease, EASE);                                    // key(t, [[0,a],[1.2,b,'softLand']]) takes the measured eases too
      api.H = H; api.THREE = H.THREE; api.key = H.key; api.pulse = H.pulse;
      api.hero = await H.createHero3D(cv, Object.assign(o, { width: cv.width, height: cv.height, pixelRatio: 1 }));
      drawn = null; if (last != null) draw(last);                     // the page seeked before the scene existed: paint where it is now
      return api;
    });
    PENDING.push(api.ready);
    if (root.__ready === undefined) root.__ready = root.Motion.loaded();
    return api;
  }

  return (root.Motion.last = { tl, fps, duration, width: W, height: H, clock: cfg.clock || 'smooth', ease: EASE, f: F, q, twos: f => f - (f % 2), mark, seek, kf, show, hide, cut, wrap, enter, exit,
    words, cadence: (s, o) => cadence(s, Object.assign({ fps }, o)), type, cursor, press, camera, snap, whip, dive, drift, count, cascade, hero3d });
}

/* ---------- self test: play sequentially, then jump around (incl. backwards); every element's state must be identical ---------- */
function selfTest(M, o) {
  M = M || root.Motion.last; o = o || {};
  const fps = M.fps, total = Math.floor(M.duration * fps), r = rng(o.seed == null ? 11 : o.seed), nS = Math.min(o.samples || 24, total);
  const pick = new Set([0, total - 1]); while (pick.size < nS) pick.add(Math.floor(r() * total));
  const frames = Array.from(pick).sort((a, b) => a - b);
  const styleOf = c => Array.from(c.style).filter(p => p !== 'transform').sort().map(p => p + ':' + c.style.getPropertyValue(p).replace(/\s+/g, ' ').trim() + (c.style.getPropertyPriority(p) ? '!important' : '')).join(';');
  const norm = e => { const c = e.cloneNode(false), st = styleOf(c);   // inline style compared as a parsed property map: authoring spelling ('visibility:hidden'), declaration order and 2D/3D transform spelling are not state; the computed matrix is
    if (st) c.setAttribute('style', st); else c.removeAttribute('style');
    return (c.outerHTML + '|' + getComputedStyle(e).transform).replace(/-?\d+\.\d+(e-?\d+)?/g, x => (+x).toFixed(3)); };   // float noise below 1e-3 is not state
  let scratch, nCv = 0;   // <canvas> content is state too (WebGL / 2D): hash its pixels (draw into a 2D scratch canvas, FNV over the RGBA words)
  const cvHash = c => { try { scratch = scratch || document.createElement('canvas'); scratch.width = c.width; scratch.height = c.height; const x = scratch.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0);
    const d = new Uint32Array(x.getImageData(0, 0, c.width, c.height).data.buffer); let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619); return (h >>> 0).toString(36); } catch (e) { return 'unreadable'; } };
  const snapAll = () => { nCv = 0; return Array.from(document.body.querySelectorAll('*')).filter(e => !/^(SCRIPT|STYLE)$/.test(e.tagName)).map(e =>
    norm(e) + '|' + Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.data).join('') + (e.tagName === 'CANVAS' ? (nCv++, '|canvas:' + cvHash(e)) : '')); };
  const seq = {}, jmp = {};
  for (let f = 0; f <= frames[frames.length - 1]; f++) { root.__mdSnap = pick.has(f); root.__seek(f / fps); if (pick.has(f)) seq[f] = snapAll(); }
  const order = frames.slice(); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
  order.forEach(f => { root.__mdSnap = false; root.__seek(Math.floor((f + total / 2) % total) / fps); root.__mdSnap = true; root.__seek(f / fps); jmp[f] = snapAll(); });   // detour first: every visit is a real jump
  const bad = [];
  frames.forEach(f => seq[f].forEach((s, i) => { if (s !== jmp[f][i] && bad.length < 20) bad.push({ frame: f, index: i, sequential: s.slice(0, 220), jumped: (jmp[f][i] || '').slice(0, 220) }); }));
  delete root.__mdSnap; root.__seek(0);
  const res = { ok: bad.length === 0, samples: frames.length, elements: seq[0].length, canvases: nCv, mismatches: bad };
  root.__seekcheck = res;
  if (root.console) console.log('[Motion.selfTest] ' + (res.ok ? 'PASS' : 'FAIL') + ' samples=' + res.samples + ' elements=' + res.elements + (nCv ? ' canvases=' + nCv : '') + ' mismatches=' + bad.length);
  return res;
}

// resolves once fonts AND the load event are done (text measurement is only cached then: run selfTest after this, or it is very slow)
const loaded = () => document.fonts.ready.then(() => new Promise(r => (document.readyState === 'complete' ? r() : root.addEventListener('load', r)))).then(() => Promise.all(PENDING));   // + M.hero3d scenes

root.Motion = { film, ease: EASE, easeFrames: EASE_FRAMES, cadence, selfTest, loaded };
})(typeof window !== 'undefined' ? window : this);
