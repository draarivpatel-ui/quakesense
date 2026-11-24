import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { serve } from '../scripts/serve.mjs';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const src = await readdir(new URL('src/', root));
const shipped = await Promise.all(['index.html', 'styles.css', 'package.json', 'README.md', ...src.map(name => `src/${name}`)]
  .map(async path => [path, await read(path)]));
const html = shipped[0][1];
const css = shipped[1][1];

test('ships no dependencies, remote asset requests, or smooth scroll rules', () => {
  const pkg = JSON.parse(shipped[2][1]);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  assert.doesNotMatch(css, /@import|scroll-behavior\s*:\s*smooth/i);
});

test('document CSP starts closed, bans network connections and inline scripts, and allows only local assets', () => {
  const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(policy);
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'",
    "base-uri 'none'", "object-src 'none'", "form-action 'none'"]) assert.ok(policy.includes(directive));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /\s+on[a-z]+\s*=|javascript:/i);
});

test('DOM rendering does not treat dynamic text as markup', () => {
  for (const [path, code] of shipped.filter(([name]) => name.startsWith('src/'))) {
    assert.doesNotMatch(code, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|\beval\s*\(/, path);
  }
});

test('single-key shortcut is opt-in and CSS provides an offset keyboard focus ring', () => {
  assert.doesNotMatch(html.match(/<input\b[^>]*\bid="shortcuts"[^>]*>/)?.[0] ?? 'checked', /\bchecked\b/);
  assert.match(css, /:focus-visible\s*[{,]/);
  assert.match(css, /outline-offset:\s*[2-9]px/);
});

test('shipped source and docs avoid long dashes and authoring-tool copy', () => {
  for (const [path, text] of shipped) {
    assert.doesNotMatch(text, /[\u2013\u2014]/, path);
    assert.doesNotMatch(text, /\b(?:A[I]|ChatG[P]T|OpenA[I]|Copilo[t])\b/i, path);
  }
});

test('mode and self-test results are exposed as status messages', () => {
  for (const id of ['mode-status', 'selftest-status']) {
    const tag = html.match(new RegExp(`<p\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
    assert.match(tag, /\brole="status"/, `${id} is not a polite status region`);
  }
});

test('local server serves only application assets and refuses sensitive paths', async t => {
  const server = serve().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const module = await fetch(`${origin}/src/seismology.js`);
  assert.match(module.headers.get('content-type'), /^text\/javascript/);
  for (const path of ['/.git/config', '/%2E%2E/index.html', '/src%2fpicker.js', '/scripts/serve.mjs', '/package.json']) {
    if (path === '/%2E%2E/index.html') continue; // WHATWG URL normalization makes this a legitimate /index.html.
    assert.equal((await fetch(origin + path)).status, 404);
  }
});
