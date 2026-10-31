import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('DOM observer debounces, waits for complete/stable metadata, and survives replaced player', async () => {
  const code = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  let time = 0, timer, observer, present = true, title = '', artist = '';
  const sent = [];
  const bar = { querySelector(selector) {
    if (selector.includes('title')) return { textContent: title };
    return { querySelector() { return artist ? { textContent: artist } : null; } };
  } };
  const context = {
    document: { documentElement: {}, querySelector: selector => selector === 'video' ? { paused: false } : present ? bar : null, addEventListener() {} },
    chrome: { runtime: { async sendMessage(message) { sent.push(message); return { ok: true }; } } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    setTimeout(fn) { timer = fn; return 1; }, setInterval() {},
    Date: { now: () => time }
  };
  vm.runInNewContext(code, context);
  async function advance() { time += 500; const fn = timer; timer = null; fn?.(); await Promise.resolve(); await Promise.resolve(); }
  title = 'A'; observer(); observer();
  await advance(); assert.equal(sent.length, 0); // Artist has not arrived.
  artist = 'Artist'; observer(); await advance(); await advance();
  assert.equal(sent.length, 1);
  observer(); await advance(); assert.equal(sent.length, 1);
  title = 'Temporary'; observer(); await advance();
  title = 'B'; observer(); await advance(); await advance();
  assert.equal(sent.length, 2); assert.equal(sent[1].song.title, 'B');
  present = false; observer(); await advance();
  present = true; title = 'C'; observer(); await advance(); await advance();
  assert.equal(sent.length, 3); assert.equal(sent[2].song.title, 'C');
});
