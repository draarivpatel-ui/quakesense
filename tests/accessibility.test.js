import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('scenario and map mode buttons use high contrast control borders', () => {
  assert.match(css, /--control-line: #657260;/);
  assert.match(css, /\.mode-btn \{[^}]*border: 1px solid var\(--control-line\)/);
  assert.match(css, /\.preset-btn \{[^}]*border: 1\.5px solid var\(--control-line\)/);
});

test('mobile interactive controls reserve a 44px touch height', () => {
  const start = css.indexOf('@media (max-width: 720px)');
  assert.notEqual(start, -1);
  const mobile = css.slice(start, css.indexOf('@media (max-width: 430px)'));
  assert.match(mobile, /\.btn, \.mode-btn \{ min-height: 44px; \}/);
  assert.match(mobile, /input\[type="number"\], select \{ min-height: 44px; \}/);
  assert.match(mobile, /input\[type="range"\] \{ min-height: 44px; \}/);
  assert.match(mobile, /\.check \{ min-height: 44px; \}/);
});
