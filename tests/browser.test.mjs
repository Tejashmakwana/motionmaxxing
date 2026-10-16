// Opt-in, real-browser regression: no network or paid APIs. All artifacts stay in a disposable directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, findChrome } from '../scripts/_cdp.mjs';

const run = promisify(execFile);
const enabled = process.env.MOTIONMAXXING_BROWSER_TESTS === '1';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('md-chrome-')));
function clones() {
  if (process.platform !== 'darwin') return [];
  const temp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
  const root = path.join(path.dirname(fs.realpathSync(temp)), 'X');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => n.endsWith('.code_sign_clone')).flatMap((n) => fs.readdirSync(path.join(root, n)).map((child) => `${n}/${child}`)).sort();
}

test('repeated captures, lint and render leave no new clones, profiles, live children or signal hooks', { skip: !enabled, timeout: 180000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'motionmaxxing-browser-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const source = path.join(scratch, 'index.html');
  fs.writeFileSync(source, `<!doctype html><html><style>html,body{margin:0;background:#142536;width:320px;height:240px}#dot{position:absolute;width:60px;height:60px;top:90px;background:#ef9933;border-radius:50%}</style><div id="dot"></div><script>window.__duration=1;window.__seek=t=>{document.getElementById('dot').style.left=(20+t*200)+'px'};</script></html>`);
  const initialClones = clones(), initialProfiles = profiles();
  const signals = ['exit', 'SIGINT', 'SIGTERM'];
  const initialHooks = signals.map((s) => process.listenerCount(s));
  const browsers = [];
  const selected = findChrome();
  const targets = [selected];
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && fs.existsSync(systemChrome) && selected !== systemChrome) targets.push(systemChrome);
  const originalOverride = process.env.CHROME_PATH;
  try {
    for (const exe of targets) {
      process.env.CHROME_PATH = exe;
      for (let i = 0; i < 10; i++) {
        const br = await launchChrome({ width: 320, height: 240 }); browsers.push(br);
        try {
          const page = await br.newPage();
          assert.equal(await page.goto(pathToFileURL(source).href), true);
          await page.eval('window.__seek(0.5)');
          const png = await page.shot({ format: 'png' });
          assert.equal(png.subarray(1, 4).toString(), 'PNG');
        } finally { await Promise.all([br.close(), br.close()]); }
        assert.equal(br.proc.exitCode, 0, 'normal close should exit without a termination signal');
        assert.equal(br.proc.signalCode, null);
        assert.equal(fs.existsSync(br.proc.spawnargs.find((a) => a.startsWith('--user-data-dir=')).split('=')[1]), false);
      }
      t.diagnostic(`10 capture sessions: ${exe}`);
    }
  } finally {
    if (originalOverride === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = originalOverride;
    await Promise.all(browsers.map((br) => br.close()));
  }
  for (let i = 0; i < 7; i++) {
    const { stdout } = await run(process.execPath, [path.join(repo, 'scripts/lint.mjs'), source, '--times', '0.2,0.7', '--width', '320', '--height', '240']);
    assert.match(stdout, /GATE G5: PASS/);
  }
  t.diagnostic('7 complete lint CLI runs: PASS');
  for (let i = 0; i < 3; i++) {
    const output = path.join(scratch, `render-${i}.mp4`);
    await run(process.execPath, [path.join(repo, 'scripts/render.mjs'), source, output, '--width', '320', '--height', '240', '--fps', '10', '--duration', '1']);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', output]);
    const video = JSON.parse(stdout).streams[0];
    assert.deepEqual([video.width, video.height, Number(video.nb_read_frames)], [320, 240, 10]);
  }
  t.diagnostic('3 video renders: 320x240, 10 decoded frames each');
  assert.deepEqual(clones(), initialClones, 'clone inventory must be unchanged');
  assert.deepEqual(profiles(), initialProfiles, 'temporary browser profiles must be removed');
  assert.deepEqual(signals.map((s) => process.listenerCount(s)), initialHooks, 'signal hooks must not accumulate');
  for (const br of browsers) assert.throws(() => process.kill(br.proc.pid, 0), { code: 'ESRCH' });
  t.diagnostic(`Clone count: ${initialClones.length} -> ${clones().length}; temporary profiles and hooks unchanged`);
});

test('startup failures terminate the child and remove its profile and hooks', { skip: !enabled, timeout: 60000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'motionmaxxing-startup-test-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const fake = path.join(scratch, 'fake-chrome');
  const pidFile = path.join(scratch, 'pid');
  const before = profiles();
  const events = ['exit', 'SIGINT', 'SIGTERM'], hooks = events.map((s) => process.listenerCount(s));
  const previous = process.env.CHROME_PATH;
  try {
    process.env.CHROME_PATH = fake;
    // This executable passes discovery but cannot spawn: ENOENT from its missing interpreter.
    fs.writeFileSync(fake, '#!/motionmaxxing-missing-interpreter\n', { mode: 0o755 });
    await assert.rejects(launchChrome({ timeout: 300 }), /ENOENT/);
    // A process that never advertises a DevTools URL exercises timeout and SIGTERM fallback.
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
    await assert.rejects(launchChrome({ timeout: 300 }), /did not report a DevTools URL/);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    // A bad DevTools endpoint exercises cleanup after browser spawn, before CDP connects.
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/test');setInterval(()=>{},1000);\n`, { mode: 0o755 });
    await assert.rejects(launchChrome({ timeout: 300 }), /cannot connect/);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    // A TCP server that never completes the WebSocket handshake must not hang startup forever.
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const s=require('node:net').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.error('DevTools listening on ws://127.0.0.1:'+s.address().port+'/devtools/browser/test'));\n`, { mode: 0o755 });
    await assert.rejects(launchChrome({ timeout: 300 }), /CDP connection timed out/);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
    // SIGKILL is only used after a timed-out child also ignores SIGTERM.
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o755 });
    await assert.rejects(launchChrome({ timeout: 300 }), /did not report a DevTools URL/);
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
  } finally { if (previous === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = previous; }
  assert.deepEqual(profiles(), before);
  assert.deepEqual(events.map((s) => process.listenerCount(s)), hooks);
});


test('SIGINT and SIGTERM await browser cleanup before the launcher exits', { skip: !enabled, timeout: 30000 }, async () => {
  const before = profiles(), beforeClones = clones();
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const script = `import {launchChrome} from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/_cdp.mjs')).href)}; const br=await launchChrome(); console.log(JSON.stringify({pid:br.proc.pid})); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, receivedSignal) => resolve({ code, receivedSignal })); });
    try {
      const info = await new Promise((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => reject(new Error('launcher did not become ready: ' + stderr)), 12000);
        child.stdout.on('data', (data) => { stdout += data; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.trim())); } });
        exited.then(() => { clearTimeout(timer); reject(new Error('launcher exited before ready: ' + stderr)); });
      });
      child.kill(signal);
      assert.deepEqual(await exited, { code: expectedCode, receivedSignal: null });
      assert.throws(() => process.kill(info.pid, 0), { code: 'ESRCH' });
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } }
  }
  assert.deepEqual(profiles(), before);
  assert.deepEqual(clones(), beforeClones);
});
