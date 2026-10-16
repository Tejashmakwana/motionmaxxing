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
import { findChrome, chromeFlags } from './_chrome.mjs';
export { findChrome } from './_chrome.mjs';

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
  static async connect(url, timeout = 25000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onError);
        if (error) { try { ws.close(); } catch {} reject(error); } else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error('cannot connect to ' + url));
      const timer = setTimeout(() => finish(new Error('CDP connection timed out: ' + url)), timeout);
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
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

export async function launchChrome({ args = [], width = 1920, height = 1080, headless = true, timeout = 25000 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Chrome startup timeout must be positive');
  const exe = findChrome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-chrome-'));
  const flags = chromeFlags([
    headless ? '--headless=new' : '', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-popup-blocking', ...args, 'about:blank',
  ].filter(Boolean));
  const proc = spawn(exe, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let dead = false, cdp, closePromise, errTail = '';
  const exited = new Promise((resolve) => {
    proc.once('exit', () => { dead = true; resolve(); });
    proc.on('error', () => { if (!proc.pid) { dead = true; resolve(); } });
  });
  async function waitForExit(ms) {
    if (dead) return true;
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  function removeHooks() {
    process.off('exit', onExit);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
  const close = () => closePromise ||= (async () => {
    try { if (!dead && cdp) await cdp.send('Browser.close', {}, undefined, 3000); } catch {}
    // A successful CDP reply does not mean Chrome has exited. Let its shutdown and
    // clone-cleanup helper finish before falling back to signals.
    if (!await waitForExit(5000)) {
      proc.kill('SIGTERM');
      if (!await waitForExit(2000)) { proc.kill('SIGKILL'); await waitForExit(2000); }
    }
    if (!dead) throw new Error(`Chrome did not exit (pid ${proc.pid}); temporary profile retained: ${dir}`);
    try { cdp?.ws.close(); } catch {}
    removeHooks();
    fs.rmSync(dir, { recursive: true, force: true });
  })();
  // Synchronous process exit cannot await CDP. Signal only this live child, and
  // leave its profile intact until it has stopped rather than deleting under it.
  const onExit = () => { if (!dead) { try { proc.kill('SIGTERM'); } catch {} } };
  const onInterrupt = () => { close().finally(() => process.exit(130)); };
  const onTerminate = () => { close().finally(() => process.exit(143)); };
  process.on('exit', onExit);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let version;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const finish = (error, url) => {
        clearTimeout(timer);
        proc.stderr.off('data', onData); proc.off('exit', onEarlyExit); proc.off('error', onError);
        if (error) reject(error); else resolve(url);
      };
      const onData = (data) => {
        errTail = (errTail + data).slice(-8192);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(errTail);
        if (match) finish(null, match[1]);
      };
      const onEarlyExit = (code, signal) => finish(new Error(`Chrome exited early (code ${code}, signal ${signal})\n${errTail.slice(-600)}`));
      const onError = (error) => finish(error);
      const timer = setTimeout(() => finish(new Error(`Chrome did not report a DevTools URL in ${timeout}ms\n${errTail.slice(-600)}`)), timeout);
      proc.stderr.on('data', onData); proc.once('exit', onEarlyExit); proc.once('error', onError);
    });
    cdp = await CDP.connect(wsUrl, timeout);
    version = (await cdp.send('Browser.getVersion', {}, undefined, timeout)).product;
  } catch (error) {
    try { await close(); } catch {}
    throw error;
  }

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
        // false = load event timed out (page may still be usable)
        let timer, off;
        const loaded = new Promise((res) => { off = page.on('Page.loadEventFired', () => res(true)); timer = setTimeout(() => res(false), timeout); });
        try {
          const r = await send('Page.navigate', { url });
          if (r.errorText) throw new Error(`navigation failed: ${r.errorText} (${url})`);
          return await loaded;
        } finally { clearTimeout(timer); off(); }
      },
      async shot({ format = 'png', quality = 90, clip, beyond = false } = {}) {
        const r = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}), ...(clip ? { clip } : {}), captureBeyondViewport: beyond }, 60000);
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
