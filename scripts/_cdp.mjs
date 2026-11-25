// _cdp.mjs - shared zero-dependency Chrome DevTools Protocol helper (used by brand.mjs and render.mjs).
// Not a CLI. Exports: findChrome, launchChrome, CDP, parseArgs, die.
//
//   const br = await launchChrome({ args: [...extra flags] });
//   const page = await br.newPage({ width: 1920, height: 1080, scale: 1 });
//   await page.goto(url);  await page.eval('document.title');  await page.shot({format:'png'});
//   await br.close();
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }

// Leading '//' comment block of a script, used as --help text.
export function helpFrom(metaUrl) {
  const out = [];
  for (const l of fs.readFileSync(new URL(metaUrl), 'utf8').split('\n')) {
    if (l.startsWith('#!')) continue;
    if (l.startsWith('//')) out.push(l.replace(/^\/\/ ?/, '')); else break;
  }
  return out.join('\n');
}

export function findChrome() {
  const c = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const p = c.find((x) => x && fs.existsSync(x));
  if (!p) die('Google Chrome not found (set CHROME_PATH)');
  return p;
}

// Minimal argv parser: flags = {name: 'string'|'bool'}; returns {pos:[], opt:{}}
export function parseArgs(argv, flags) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (!(k in flags)) die(`unknown option --${k} (try --help)`);
      if (flags[k] === 'bool') opt[k] = true;
      else {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined) die(`--${k} needs a value`);
        opt[k] = v;
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result || {});
      } else for (const h of [...this.handlers]) if (h.method === m.method && (!h.sid || h.sid === m.sessionId)) h.fn(m.params || {}, m);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(new Error(`${p.method}: connection closed`)); }
      this.pending.clear(); this.closed = true;
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('cannot connect to ' + url)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId, timeout = 60000) {
    return new Promise((res, rej) => {
      if (this.closed) return rej(new Error(`${method}: connection closed`));
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method}: timeout after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { res, rej, method, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, fn, sid) { const h = { method, fn, sid }; this.handlers.push(h); return () => { this.handlers = this.handlers.filter((x) => x !== h); }; }
}

export async function launchChrome({ args = [], width = 1920, height = 1080, headless = true } = {}) {
  const exe = findChrome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-chrome-'));
  const flags = [
    headless ? '--headless=new' : '', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-popup-blocking', ...args, 'about:blank',
  ].filter(Boolean);
  const proc = spawn(exe, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let dead = false, errTail = '';
  proc.on('exit', () => { dead = true; });
  const wsUrl = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Chrome did not report a DevTools URL in 25s\n' + errTail.slice(-600))), 25000);
    proc.stderr.on('data', (d) => {
      errTail += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(errTail);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.on('exit', (c) => { clearTimeout(t); rej(new Error(`Chrome exited early (code ${c})\n${errTail.slice(-600)}`)); });
  });
  const cdp = await CDP.connect(wsUrl);
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await cdp.send('Browser.close', {}, undefined, 3000); } catch {}
    try { cdp.ws.close(); } catch {}
    if (!dead) { proc.kill('SIGTERM'); await new Promise((r) => { proc.once('exit', r); setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 2000); }); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { close().finally(() => process.exit(130)); });
  const version = (await cdp.send('Browser.getVersion')).product;

  async function newPage({ width: w = width, height: h = height, scale = 1 } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p, t) => cdp.send(m, p, sessionId, t);
    const page = {
      sessionId, targetId, send, cdp,
      on: (ev, fn) => cdp.on(ev, fn, sessionId),
      async setViewport(vw, vh, s = 1) {
        await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: s, mobile: false });
      },
      async eval(expression, { timeout = 60000 } = {}) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error('page eval: ' + (d.exception?.description || d.text || 'exception').split('\n')[0]);
        }
        return r.result.value;
      },
      async goto(url, { timeout = 30000 } = {}) {
        const loaded = new Promise((res) => { const off = page.on('Page.loadEventFired', () => { off(); res(true); }); setTimeout(() => { off(); res(false); }, timeout); });
        const r = await send('Page.navigate', { url });
        if (r.errorText) throw new Error(`navigation failed: ${r.errorText} (${url})`);
        return loaded; // false = load event timed out (page may still be usable)
      },
      // optimizeForSpeed trades the PNG encoder's compression effort for time: measured on a 1080p capture,
      // 217ms -> 85ms, for a file 1.6x larger. PNG is lossless either way, so the decoded pixels are identical
      // (verified: --format png renders byte-identical with and without it). A no-op for jpeg, which is the
      // default frame transport, so this only speeds up --format png. Passed only when the caller asks, which
      // the video-frame path does and the paths that WRITE a png - a still, a brand shot - do not: those are
      // kept, so their size matters and their encode time does not.
      async shot({ format = 'png', quality = 90, clip, beyond = false, fast = false } = {}) {
        const r = await send('Page.captureScreenshot', {
          format, ...(format === 'jpeg' ? { quality } : {}), ...(clip ? { clip } : {}),
          captureBeyondViewport: beyond, ...(fast && format === 'png' ? { optimizeForSpeed: true } : {}),
        }, 60000);
        return Buffer.from(r.data, 'base64');
      },
      close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => {}),
    };
    await send('Page.enable'); await send('Runtime.enable');
    await page.setViewport(w, h, scale);
    await send('Page.bringToFront').catch(() => {});
    return page;
  }
  return { cdp, proc, version, newPage, close, exe };
}
