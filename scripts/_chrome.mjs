// Shared browser discovery for the CDP launcher and providers.sh. Never downloads a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function executable(file) {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); }
  catch { return false; }
}

export function findChrome({ env = process.env, platform = process.platform, home = os.homedir(), applications = '/Applications' } = {}) {
  if (env.CHROME_PATH) {
    if (!executable(env.CHROME_PATH)) throw new Error(`CHROME_PATH is not an executable file: ${env.CHROME_PATH}`);
    return env.CHROME_PATH;
  }
  const mac = platform === 'darwin';
  const candidates = mac ? [path.join(applications, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')] : [];
  // Playwright's full Chromium builds are Chrome for Testing. Prefer the newest installed revision.
  const cache = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? env.PLAYWRIGHT_BROWSERS_PATH
    : mac ? path.join(home, 'Library/Caches/ms-playwright') : path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
  let builds = [];
  try { builds = fs.readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))); } catch {}
  for (const build of builds) {
    const root = path.join(cache, build);
    if (mac) {
      for (const arch of [process.arch, process.arch === 'arm64' ? 'x64' : 'arm64']) candidates.push(path.join(root, `chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`));
    } else candidates.push(path.join(root, 'chrome-linux64/chrome'), path.join(root, 'chrome-linux/chrome'));
  }
  if (mac) candidates.push(...['Google Chrome', 'Chromium', 'Google Chrome Canary'].map((name) => path.join(applications, `${name}.app/Contents/MacOS/${name}`)));
  else candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  const found = candidates.find(executable);
  if (!found) throw new Error('Chrome not found (install Chrome for Testing or set CHROME_PATH)');
  return found;
}

export function chromeFlags(args, platform = process.platform) {
  const features = new Set();
  const rest = args.filter((arg) => {
    if (!arg.startsWith('--disable-features=')) return true;
    for (const feature of arg.slice('--disable-features='.length).split(',')) if (feature) features.add(feature);
    return false;
  });
  // Regular macOS Chrome clones its app bundle per launch. These short-lived automation
  // sessions do not need the update-signature snapshot, including when CHROME_PATH overrides discovery.
  if (platform === 'darwin') features.add('MacAppCodeSignClone');
  if (features.size) rest.push(`--disable-features=${[...features].join(',')}`);
  return rest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(findChrome()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
