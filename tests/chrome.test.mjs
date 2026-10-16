import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, chromeFlags } from '../scripts/_chrome.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'motionmaxxing-discovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, applications: path.join(home, 'Applications'), platform: 'darwin', env: {} };
  const binary = (relative, mode = 0o755) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
    return file;
  };
  const cached = (revision, mode) => binary(`Library/Caches/ms-playwright/chromium-${revision}/chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, mode);
  return { home, options, binary, cached };
}

test('explicit executable CHROME_PATH wins; invalid overrides fail instead of silently falling back', (t) => {
  const f = fixture(t); f.cached(100);
  const custom = f.binary('custom chrome');
  assert.equal(findChrome({ ...f.options, env: { CHROME_PATH: custom } }), custom);
  assert.throws(() => findChrome({ ...f.options, env: { CHROME_PATH: f.home + '/missing' } }), /CHROME_PATH/);
  const notExecutable = f.binary('not-executable', 0o644);
  assert.throws(() => findChrome({ ...f.options, env: { CHROME_PATH: notExecutable } }), /CHROME_PATH/);
});

test('installed Chrome for Testing takes precedence over system Chrome', (t) => {
  const f = fixture(t);
  f.binary('Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const testing = f.binary('Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  assert.equal(findChrome(f.options), testing);
});

test('newest executable Playwright build wins numerically; incomplete installs are skipped', (t) => {
  const f = fixture(t); f.cached(99); const newest = f.cached(100); f.cached(101, 0o644);
  f.binary('Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(findChrome(f.options), newest);
});

test('custom Playwright cache root is honored', (t) => {
  const f = fixture(t); f.cached(1000);
  const custom = f.binary(`custom-cache/chromium-2/chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
  assert.equal(findChrome({ ...f.options, env: { PLAYWRIGHT_BROWSERS_PATH: f.home + '/custom-cache' } }), custom);
});

test('system Chrome remains a fallback when no testing build is installed', (t) => {
  const f = fixture(t);
  const chrome = f.binary('Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(findChrome(f.options), chrome);
});

test('Linux selects the Linux executable rather than a cached macOS binary', (t) => {
  const f = fixture(t); f.cached(1000);
  const linux = f.binary('.cache/ms-playwright/chromium-100/chrome-linux64/chrome');
  assert.equal(findChrome({ ...f.options, platform: 'linux' }), linux);
});

test('macOS clone prevention preserves and combines default and caller-disabled features', () => {
  const args = chromeFlags(['--headless=new', '--disable-features=Translate,MediaRouter', '--disable-features=OtherFeature', '--enable-features=SomeFeature'], 'darwin');
  assert.equal(args.filter((a) => a.startsWith('--disable-features=')).length, 1);
  assert.deepEqual(new Set(args.at(-1).split('=')[1].split(',')), new Set(['Translate', 'MediaRouter', 'OtherFeature', 'MacAppCodeSignClone']));
  assert.ok(args.includes('--enable-features=SomeFeature'));
  assert.deepEqual(chromeFlags(['--headless=new'], 'linux'), ['--headless=new']);
});
