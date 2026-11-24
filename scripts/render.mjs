#!/usr/bin/env node
// render.mjs - deterministic frame-by-frame render of an HTML composition via Chrome DevTools -> ffmpeg.
//
// Usage:
//   node render.mjs <index.html|url> <out.mp4> [options]
//   node render.mjs <index.html|url> --still 0.5,2,4.2 [outDir=stills]      (PNG stills only)
//
// Options:
//   --fps 30            --width 1920 --height 1080   (default: data-width/height of main composition, else 1920x1080)
//   --from S --to S     render only this time range (seconds)    --duration S  override total duration
//   --audio FILE        mux audio (trimmed to the range, -shortest)
//   --crf 18            x264 quality      --preset medium
//   --scale 0.5         render at 0.5x pixels (layout unchanged) for fast drafts
//   --format jpeg|png   frame transport (default jpeg q92; png = lossless, slower)
//   --still t,t,t       write PNG stills at those times instead of a video
//   --shutter 180       SHUTTER BLUR, single pass: instead of one seek per frame, seek --subframes times across the open shutter
//                       (angle in degrees, 0-360; 180 = open for half the frame time) and average them with ffmpeg tmix inside the
//                       same encode (no intermediate files). The shutter opens AT the frame time and closes before the next frame,
//                       so a hard cut on a frame boundary never ghosts the previous shot. Stepped content (typing, counters,
//                       clock:'twos' holds, 1-frame kf steps) stays crisp because every sample lands in the same frame; only smooth
//                       motion blurs. Cost = --subframes x the render time: use --from/--to for hero ranges. Pick ONE blur grammar
//                       per film: shutter OR per-element smear OR crisp steps, never shutter on top of smear (double blur).
//   --subframes 8       sub-frame seeks per output frame when --shutter is set (default 8; 4 at 180 deg averages only 2 and
//                       double-outlines fast moves; max 32)
//   --grain 0.03        film grain after the average: deterministic seeded luma noise (0-0.2; 0.03-0.06 only on gradient / photo / 3D
//                       films, it kills banding; ffmpeg noise strength = grain x 100, same seed => same bytes). Works without --shutter.
//   --grain-seed 7      seed for --grain (default 7)
//   --no-skip-hidden    seek <video>s that are hidden too (needed only when a hidden one feeds a canvas/WebGL texture)
//
// Events: if the page exposes window.__events = [{t, frame, type, label}, ...] (cuts, shows, hides, hits - filled by the
// composition while it is seeked, or up front), it is read AFTER rendering and written to <out>.events.json beside the MP4
// (e.g. final.mp4.events.json); in --still mode to <outDir>/events.json. look.py and sync.mjs pick it up automatically
// (type cut/show/hide = authoritative cut times for look.py). The path is printed.
//
// Seek contract (first match wins, evaluated in the page for every frame at time t, in seconds):
//   1. window.__seek(t)                      (may be async)
//   2. window.__timelines = {name: tl, ...}  paused GSAP timelines; each is seeked, "main" last
//   3. gsap.globalTimeline                   paused + seeked
//   Always also: CSS/WAAPI animations (document.getAnimations) are paused and set to t*1000 ms,
//   <video> gets currentTime = t - data-start (+ data-media-start) and we await 'seeked' and the next presented
//   frame; <audio>/<video> are muted. A <video> hidden by display/visibility/opacity/content-visibility is NOT
//   seeked: it cannot paint, so it cannot change the frame - unless it is only a pixel source for a canvas or a
//   WebGL texture, which --no-skip-hidden is for. REQUIRES that __seek has applied visibility by the time it
//   resolves (a __seek that defers its DOM commit to a rAF or a framework render would be read one frame late).
// Duration: --duration | window.__duration | [data-composition-id=main][data-duration] | __timelines.main.duration() | gsap global.
// Before the first frame we wait for: load, document.fonts.ready, <img> decode, video metadata, window.__ready (promise).
// Exit codes: 0 ok, 1 failure. Console errors from the page are listed at the end (they do not fail the render).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome, parseArgs, die, helpFrom } from './_cdp.mjs';

const HELP = helpFrom(import.meta.url);
const { pos, opt } = parseArgs(process.argv.slice(2), {
  help: 'bool', fps: 's', width: 's', height: 's', from: 's', to: 's', duration: 's', audio: 's', crf: 's',
  preset: 's', scale: 's', format: 's', still: 's', shutter: 's', subframes: 's', grain: 's', 'grain-seed': 's',
  'no-skip-hidden': 'bool',
});
if (opt.help || pos.length < 1) { console.log(HELP); process.exit(opt.help ? 0 : 1); }

const num = (v, d, name) => { if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n)) die(`--${name} must be a number`); return n; };
const fps = num(opt.fps, 30, 'fps'), scale = num(opt.scale, 1, 'scale'), crf = num(opt.crf, 18, 'crf');
if (fps <= 0 || scale <= 0 || scale > 4) die('bad --fps/--scale');
const format = opt.format || 'jpeg';
if (!['jpeg', 'png'].includes(format)) die('--format must be jpeg or png');
const shutterOn = opt.shutter !== undefined;
const shutter = shutterOn ? num(opt.shutter, 180, 'shutter') : 0;
if (shutterOn && !(shutter > 0 && shutter <= 360)) die('--shutter is an angle in degrees, 0 < angle <= 360 (180 is the film default)');
if (opt.subframes !== undefined && !shutterOn) die('--subframes needs --shutter');
const subframes = shutterOn ? Math.round(num(opt.subframes, 8, 'subframes')) : 1;
if (shutterOn && (subframes < 2 || subframes > 32)) die('--subframes must be 2..32 (8 recommended)');
const grain = opt.grain !== undefined ? num(opt.grain, 0, 'grain') : 0;
if (grain < 0 || grain > 0.2) die('--grain must be 0..0.2 (0.03-0.06 typical)');
const grainSeed = Math.round(num(opt['grain-seed'], 7, 'grain-seed'));
const stillMode = opt.still !== undefined;
if (stillMode && (shutterOn || grain)) console.error('warn: --shutter/--grain apply to video output only; stills are single sharp frames');
const src = pos[0];
const url = /^(https?|file):/i.test(src) ? src : (fs.existsSync(src) ? pathToFileURL(path.resolve(src)).href : die(`input not found: ${src}`));
let outFile = null, stillDir = null;
if (stillMode) stillDir = path.resolve(pos[1] || 'stills'); else { outFile = pos[1] ? path.resolve(pos[1]) : die('missing <out.mp4> (or use --still)'); }
if (opt.audio && !fs.existsSync(opt.audio)) die(`audio not found: ${opt.audio}`);
const stillTimes = stillMode ? opt.still.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0) : [];
if (stillMode && !stillTimes.length) die('--still needs times like 0.5,2,4');

// ---- page-side helpers (installed after load) -----------------------------------------------
const PAGE_LIB = `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const vids = () => [...document.querySelectorAll('video')];
  window.__mdPrepare = async () => {
    const out = [];
    try { await document.fonts.ready; } catch (e) {}
    await Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => out.push('image failed: ' + (i.currentSrc || i.src))) : null)));
    await Promise.all(vids().map((v) => v.readyState >= 2 ? 0 : new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', () => { out.push('video failed: ' + v.currentSrc); r(); }, { once: true }); setTimeout(r, 8000); })));
    if (window.__ready && typeof window.__ready.then === 'function') await window.__ready;
    else if (typeof window.__ready === 'function') await window.__ready();
    for (const m of document.querySelectorAll('video,audio')) { m.muted = true; m.volume = 0; try { m.pause(); } catch (e) {} }
    return out;
  };
  window.__mdInfo = () => {
    const main = document.querySelector('[data-composition-id="main"]');
    const tls = window.__timelines && typeof window.__timelines === 'object' ? window.__timelines : null;
    let d = null, how = null;
    if (typeof window.__duration === 'number') { d = window.__duration; how = 'window.__duration'; }
    else if (main && parseFloat(main.getAttribute('data-duration')) > 0) { d = parseFloat(main.getAttribute('data-duration')); how = 'data-duration'; }
    else if (tls && tls.main && typeof tls.main.duration === 'function') { d = tls.main.duration(); how = '__timelines.main.duration()'; }
    else if (window.gsap && gsap.globalTimeline) { d = gsap.globalTimeline.duration(); how = 'gsap.globalTimeline.duration()'; }
    const strat = typeof window.__seek === 'function' ? '__seek' : (tls && Object.keys(tls).length ? '__timelines' : (window.gsap && gsap.globalTimeline ? 'gsap.globalTimeline' : 'none'));
    return { duration: d, durationFrom: how, strategy: strat, timelines: tls ? Object.keys(tls) : [],
      width: main ? parseInt(main.getAttribute('data-width')) || null : null, height: main ? parseInt(main.getAttribute('data-height')) || null : null,
      videos: vids().length };
  };
  window.__mdSkipped = 0;
  if (window.__mdSkipHidden === undefined) window.__mdSkipHidden = true;
  const skipTally = new Map();
  window.__mdSkipTally = (v, skipped) => {
    const k = v.id || v.currentSrc || v.src || '<video>';
    const e = skipTally.get(k) || { seen: 0, skipped: 0 };
    e.seen++; if (skipped) e.skipped++; skipTally.set(k, e);
  };
  // every capture skipped => the video never appeared (harmless) or it is a pixel source (broken render)
  window.__mdAlwaysSkipped = () => [...skipTally].filter(([, e]) => e.seen > 0 && e.skipped === e.seen).map(([k]) => k);
  window.__mdFrame = async (t) => {
    if (typeof window.__seek === 'function') { await window.__seek(t); }
    else if (window.__timelines && typeof window.__timelines === 'object' && Object.keys(window.__timelines).length) {
      const names = Object.keys(window.__timelines).sort((a, b) => (a === 'main') - (b === 'main'));
      for (const n of names) { const tl = window.__timelines[n]; if (tl && typeof tl.seek === 'function') { if (tl.pause) tl.pause(); tl.seek(t, false); } }
    } else if (window.gsap && gsap.globalTimeline) { gsap.globalTimeline.pause(); gsap.globalTimeline.seek(t, false); }
    for (const a of document.getAnimations ? document.getAnimations() : []) {
      if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) continue;
      try { a.pause(); a.currentTime = t * 1000; } catch (e) {}
    }
    for (const m of document.querySelectorAll('audio')) { m.muted = true; try { m.pause(); } catch (e) {} }
    await Promise.all(vids().map(async (v) => {
      v.muted = true; try { v.pause(); } catch (e) {}
      const dur = isFinite(v.duration) ? v.duration : 1e9;
      const target = Math.min(Math.max(0, t - (parseFloat(v.dataset.start) || 0) + (parseFloat(v.dataset.mediaStart) || 0)), Math.max(0, dur - 0.001));
      if (Math.abs(v.currentTime - target) < 0.0005 && !v.seeking) return;
      // A video that cannot be seen cannot paint, so skip its seek while display/visibility/opacity (or
      // content-visibility, which checkVisibility always applies) hides it on itself or an ancestor. It seeks
      // normally on the frame it reappears: currentTime is stale by then, so the early return above does not fire.
      // Films that cross-cut between tracks seek far less for it. The legacy option spellings are passed too, so
      // this still works on the Chromes that shipped checkVisibility before the options were renamed.
      // NOT safe for a hidden video that is only a PIXEL SOURCE (canvas drawImage, a WebGL/VideoTexture upload):
      // it paints nothing itself, so it would freeze at frame 0. Pass --no-skip-hidden for those; a video skipped
      // on every single capture is reported at the end, because that is what this mistake looks like.
      if (window.__mdSkipHidden && v.checkVisibility && !v.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) {
        window.__mdSkipped++; window.__mdSkipTally(v, true); return;
      }
      window.__mdSkipTally(v, false);
      // Register the frame callback BEFORE the seek, so the presentation the seek itself causes is not missed.
      // Registered after 'seeked' (as this was) that presentation has usually already happened, the callback never
      // fires, and only the fallback timer ends the wait - which is why the fallback was reached on most captures
      // instead of being the rare safety net it reads as.
      let rvfcFired = false, rvfcId = null;
      const presented = v.requestVideoFrameCallback
        ? new Promise((r) => { rvfcId = v.requestVideoFrameCallback(() => { rvfcFired = true; r(); }); })
        : null;
      await new Promise((res) => { const to = setTimeout(res, 3000); v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true }); v.currentTime = target; });
      // The 150ms budget starts HERE, after 'seeked', exactly as it did before: it is correctness margin for a
      // frame that really is late, not a frame budget, so it must not scale with --fps and must not be spent on
      // the seek itself. Starting it before the seek would leave a seek slower than 150ms with no margin at all -
      // and skipping hidden videos makes multi-second jump-seeks normal on the frame a track reappears, which is
      // the one frame where a stale video reads as a bad cut. Cancel on timeout: a presentation arriving later
      // would otherwise resolve the NEXT capture's wait early, before its own seek had finished.
      if (presented) await Promise.race([presented, new Promise((r) => setTimeout(() => {
        if (!rvfcFired && rvfcId != null) { try { v.cancelVideoFrameCallback(rvfcId); } catch (e) {} }
        r();
      }, 150))]);
    }));
    await raf2();
    return true;
  };
  return true;
})()`;

// ---- main ----------------------------------------------------------------------------------
const errors = new Map();
const addErr = (s) => { s = String(s).slice(0, 300); errors.set(s, (errors.get(s) || 0) + 1); };
let browser, ff, page;
const cleanup = async () => { try { await browser?.close(); } catch {} };

(async () => {
  browser = await launchChrome({ args: ['--allow-file-access-from-files'] });
  // Probe size with a first load at 1920x1080 only if user gave none and page declares data-width/height.
  let W = opt.width ? num(opt.width, 0, 'width') : null, H = opt.height ? num(opt.height, 0, 'height') : null;
  page = await browser.newPage({ width: W || 1920, height: H || 1080, scale });
  await page.send('Log.enable');
  page.on('Runtime.exceptionThrown', (p) => addErr('exception: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').split('\n')[0]));
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') addErr('console.error: ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')); });
  page.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') addErr(`${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}`); });
  page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));

  // Prove once that this Chrome honours the checkVisibility options the hidden-video skip relies on. WebIDL drops
  // an unknown dictionary member silently, so a typo or an older Chrome would disable the skip for ever without a
  // word. Done HERE, on the about:blank this page still holds: the navigation below replaces this document, so the
  // film is never touched (appending even an opacity:0 div to the film's own body changed one rendered frame), and
  // it needs no second target. A failure here only costs the optimization, so it must never fail the render.
  let skipHidden = !opt['no-skip-hidden'];
  if (skipHidden) {
    try {
      skipHidden = await page.eval(`(() => { const d = document.createElement('div'); d.style.opacity = '0';
        const h = document.createElement('div'); h.style.visibility = 'hidden';
        document.body.append(d, h);
        return !!(d.checkVisibility && !d.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })
                               && !h.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })); })()`, { timeout: 10000 });
    } catch { skipHidden = false; }
    if (!skipHidden) console.error("warn: this Chrome ignores checkVisibility's opacity/visibility options; seeking hidden videos too");
  }

  const loaded = await page.goto(url, { timeout: 45000 });
  if (!loaded) console.error('warn: load event timed out, continuing');
  await page.eval(PAGE_LIB);
  if (!skipHidden) await page.eval('window.__mdSkipHidden = false');
  const prep = await page.eval('window.__mdPrepare()', { timeout: 60000 });
  for (const p of prep) addErr(p);
  const info = await page.eval('window.__mdInfo()');
  W = W || info.width || 1920; H = H || info.height || 1080;
  await page.setViewport(W, H, scale);
  console.error(`page: ${W}x${H} @${scale}x  seek=${info.strategy}${info.timelines.length ? ' [' + info.timelines.join(',') + ']' : ''}  videos=${info.videos}  duration=${info.duration ?? '?'} (${info.durationFrom || 'none'})`);
  if (info.strategy === 'none') console.error('warn: no seek mechanism found (__seek / __timelines / gsap) - frames will be a static page');
  await page.eval('window.__mdFrame(0)'); // settle at t=0 once

  const grab = async (t) => { await page.eval(`window.__mdFrame(${t})`, { timeout: 30000 }); return page.shot({ format: stillMode ? 'png' : format, quality: 92 }); };

  // window.__events -> JSON file (read after seeking, so events registered lazily by the timeline are included)
  const saveEvents = async (file) => {
    let ev = null;
    try { ev = await page.eval('(() => { const e = window.__events; if (typeof e === "function") return JSON.stringify(e()); return Array.isArray(e) ? JSON.stringify(e) : null; })()'); } catch (e) { addErr('could not read window.__events: ' + e.message); }
    if (!ev) return;
    let arr = JSON.parse(ev);
    if (!Array.isArray(arr)) return;
    arr = arr.map((e) => (e && typeof e === 'object' ? { ...e, ...(e.frame === undefined && typeof e.t === 'number' ? { frame: Math.round(e.t * fps) } : {}) } : e))
      .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(arr, null, 1) + '\n');
    console.log(file);
    console.error(`events: ${arr.length} written (${[...new Set(arr.map((e) => e?.type))].join(',')})`);
  };

  if (stillMode) {
    fs.mkdirSync(stillDir, { recursive: true });
    for (const t of stillTimes) {
      const f = path.join(stillDir, `still_${t.toFixed(2)}s.png`);
      fs.writeFileSync(f, await grab(t)); console.log(f);
    }
    await saveEvents(path.join(stillDir, 'events.json'));
    return;
  }

  let total = opt.duration !== undefined ? num(opt.duration, 0, 'duration') : info.duration;
  if (!(total > 0) || !Number.isFinite(total)) die('cannot determine duration: pass --duration, or set window.__duration / data-duration on [data-composition-id=main] / __timelines.main');
  const t0 = num(opt.from, 0, 'from'), t1 = Math.min(num(opt.to, total, 'to'), total);
  if (!(t1 > t0)) die(`empty range: from=${t0} to=${t1}`);
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps * subframes), '-c:v', format === 'png' ? 'png' : 'mjpeg', '-i', '-'];
  if (opt.audio) args.push('-ss', String(t0), '-t', String(n / fps), '-i', opt.audio);
  // jpeg/png -> rgb -> bt709 limited-range yuv420p (correct colours in players), even dimensions
  // shutter: N sub-frames per output frame -> 16-bit rgb -> tmix averages N consecutive frames -> keep every Nth (the one that has all N)
  const head = shutterOn ? `format=gbrp16le,tmix=frames=${subframes},select=eq(mod(n\\,${subframes})\\,${subframes - 1}),setpts=PTS-STARTPTS` : 'format=gbrp';
  const tail = grain > 0 ? `,noise=c0s=${Math.max(1, Math.round(grain * 100))}:c0f=t+u:c0_seed=${grainSeed}` : '';
  args.push('-vf', head + ',scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p' + tail,
    '-c:v', 'libx264', '-preset', opt.preset || 'medium', '-crf', String(crf), '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart');
  if (opt.audio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest');
  args.push(outFile);
  ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '', ffDone = null;
  ff.stderr.on('data', (d) => { ffErr += d; });
  const ffExit = new Promise((r) => ff.on('close', (c) => { ffDone = c; r(c); }));
  ff.stdin.on('error', () => {});

  console.error(`render: ${n} frames (${(n / fps).toFixed(2)}s, ${t0}s..${t1}s) -> ${outFile}` + (shutterOn ? `  shutter ${shutter} deg x ${subframes} sub-frames (${n * subframes} captures)` : '') + (grain ? `  grain ${grain} seed ${grainSeed}` : ''));
  const shutterSpan = shutterOn ? shutter / 360 / fps : 0;
  const start = Date.now(); let lastLog = 0;
  for (let i = 0; i < n; i++) {
    if (ffDone !== null) throw new Error('ffmpeg exited early:\n' + ffErr.slice(-800));
    for (let k = 0; k < subframes; k++) {
      const tt = t0 + i / fps + (shutterOn ? ((k + 0.5) / subframes) * shutterSpan : 0);   // midpoints of the open shutter, forward from the frame time
      const buf = await grab(Math.min(tt, total));
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    if (Math.floor((i + 1) / fps) > lastLog) {
      lastLog = Math.floor((i + 1) / fps);
      const el = (Date.now() - start) / 1000;
      console.error(`  t=${((i + 1) / fps).toFixed(0)}s/${(n / fps).toFixed(0)}s  frame ${i + 1}/${n}  ${((i + 1) / el).toFixed(1)} fps render speed`);
    }
  }
  ff.stdin.end();
  const code = await ffExit;
  if (code !== 0) throw new Error('ffmpeg failed (' + code + '):\n' + ffErr.slice(-800));
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,avg_frame_rate', '-of', 'default=nw=1', outFile], { encoding: 'utf8' });
  console.error(pr.stdout.trim().split('\n').join('  '));
  const m = /duration=([\d.]+)/.exec(pr.stdout);
  if (opt.audio && m && Number(m[1]) < n / fps - 0.15) console.error(`warn: output (${m[1]}s) shorter than picture (${(n / fps).toFixed(2)}s): audio is shorter than the range (-shortest)`);
  console.log(outFile);
  await saveEvents(outFile + '.events.json');
})().catch((e) => { console.error('error: ' + e.message); process.exitCode = 1; })
  .finally(async () => {
    try {
      const n = await page?.eval('window.__mdSkipped|0', { timeout: 2000 });
      if (n > 0) console.error(`skipped ${n} seeks of hidden videos (--no-skip-hidden to seek them anyway)`);
      const always = await page?.eval('JSON.stringify(window.__mdAlwaysSkipped ? window.__mdAlwaysSkipped() : [])', { timeout: 2000 });
      const list = always ? JSON.parse(always) : [];
      if (list.length) console.error(`warn: never seeked (hidden on every capture): ${list.join(', ')}\n`
        + '      harmless if it never appears; if it feeds a canvas or a WebGL texture it froze at frame 0 - use --no-skip-hidden');
    } catch {}
    if (errors.size) { console.error(`\npage console errors (${errors.size} distinct):`); [...errors].slice(0, 20).forEach(([k, v]) => console.error(`  ${v > 1 ? `[x${v}] ` : ''}${k}`)); }
    try { ff?.kill(); } catch {}
    await cleanup();
    process.exit(process.exitCode || 0);
  });
