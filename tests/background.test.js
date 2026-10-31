import test from 'node:test';
import assert from 'node:assert/strict';
import { newTarget, validateTarget, renderTemplate, SAMPLE } from '../targets.js';
const lametric = () => validateTarget({ ...newTarget('lametric'), id: 'clock', auth: { type: 'basic', username: 'dev', password: 'test-key' } });
const webhook = () => ({ ...newTarget('webhook'), id: 'pi' });
const config = targets => ({ version: 4, revision: 'r1', enabled: true, targets });
const job = title => ({ song: { title, artist: 'Artist' }, key: JSON.stringify([title, 'Artist']), revision: 'r1', token: title, attempts: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await tick(); } throw new Error('Worker did not settle'); }
let instance = 0;
async function worker(initial = {}, fetcher = async () => Response.json({ success: { id: 'new-id' } })) {
  const data = structuredClone({ config: config([lametric()]), ...initial });
  const events = {};
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  globalThis.chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed'), openOptionsPage() {} },
    storage: { local: {
      async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]]))); },
      async set(value) { Object.assign(data, structuredClone(value)); }, async remove(keys) { keys.forEach(key => delete data[key]); }, async setAccessLevel() {}
    } },
    permissions: { async contains() { return true; } }, alarms: { async get() { return {}; }, async create() {}, onAlarm: event('alarm') },
    action: { onClicked: event('action') }, tabs: { async get(id) { return { id }; } }
  };
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return fetcher(url, options); };
  await import(`../background.js?test=${instance++}`);
  const sender = tabId => ({ id: 'extension', url: 'https://music.youtube.com/watch?v=1', tab: { id: tabId } });
  const send = (message, from) => new Promise(resolve => events.message(message, from, resolve));
  const options = { id: 'extension', url: 'chrome-extension://extension/options.html' };
  return { data, calls, events, send, song: (title, tabId = 1, playing = true) => send({ type: 'song', song: { title, artist: 'Artist', playing } }, sender(tabId)), save: value => send({ type: 'save', config: value }, options), test: target => send({ type: 'test', target }, options) };
}
test('worker lifecycle, multi-destination delivery and concurrency', async t => {
  await t.test('deduplicate reports and tabs; LaMetric only POSTs', async () => {
    const w = await worker();
    await w.song('A'); await until(() => w.data.deliveries.clock?.lastKey === job('A').key && !w.data.deliveries.clock.pending); await settle();
    await w.song('A'); await w.song('Other', 2); await settle(); assert.equal(w.calls.length, 1);
    await w.song('B'); await until(() => w.data.deliveries.clock?.lastKey === job('B').key); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST', 'POST']);
  });
  await t.test('each destination gets its own JSON and success state', async () => {
    const pi = { ...webhook(), template: '{"track":"{{title}}","performer":"{{artist}}"}' };
    const w = await worker({ config: config([lametric(), pi]) });
    await w.song('A'); await until(() => w.data.deliveries.pi?.lastKey); await settle();
    assert.equal(w.calls.length, 2);
    assert.deepEqual(JSON.parse(w.calls.find(c => c.url === pi.url).body), { track: 'A', performer: 'Artist' });
    assert.equal(w.data.deliveries.clock.active, undefined); assert.equal(w.data.deliveries.pi.active, undefined);
  });
  await t.test('one destination failure does not block another destination', async () => {
    const pi = webhook();
    const w = await worker({ config: config([lametric(), pi]) }, async url => url === pi.url ? new Response(null, { status: 204 }) : new Response(null, { status: 401 }));
    await w.song('A'); await until(() => w.data.deliveries.pi?.lastKey); await settle();
    assert.equal(w.data.deliveries.clock.pending.attempts, 1);
    assert.equal(w.data.deliveries.pi.pending, null);
    await w.song('A'); await settle(); assert.equal(w.calls.length, 2); // Retry is rate limited.
  });
  await t.test('coalesce newer songs while a POST is slow', async () => {
    let release;
    const w = await worker({}, async () => {
      if (!release) return new Promise(resolve => { release = () => resolve(new Response(null, { status: 204 })); });
      return new Response(null, { status: 204 });
    });
    await w.song('A'); await until(() => release);
    await w.song('B'); await w.song('C'); release();
    await until(() => w.data.deliveries.clock?.lastKey === job('C').key); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST', 'POST']);
    assert.deepEqual(JSON.parse(w.calls.at(-1).body).model.frames, [{ icon: 'i1850', text: 'C' }, { icon: 'i1850', text: 'Artist' }]);
  });
  await t.test('OFF while POST is running prevents the following POST', async () => {
    let release;
    const w = await worker({}, async () => new Promise(resolve => { release = () => resolve(new Response(null, { status: 204 })); }));
    await w.song('A'); await until(() => release); await w.song('B');
    assert.deepEqual(await w.save({ ...config([lametric()]), enabled: false }), { ok: true });
    release(); await until(() => w.data.deliveries.clock.inflight === null); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST']);
  });
  await t.test('startup recovers pending work and forgets obsolete notification IDs', async () => {
    const w = await worker({ deliveries: { clock: { active: { target: lametric(), id: 'persisted' }, pending: job('Resume') } } });
    await until(() => w.data.deliveries.clock?.lastKey); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST']);
    assert.equal(w.data.deliveries.clock.active, undefined);
  });
  await t.test('uncertain POST at restart is not duplicated; newer work survives', async () => {
    const w = await worker({ deliveries: { clock: { inflight: { token: 'A' }, pending: job('A') }, pi: { inflight: { token: 'Old' }, pending: job('New') } }, config: config([lametric(), webhook()]) });
    await until(() => w.data.deliveries.pi?.lastKey); await settle();
    assert.equal(w.calls.length, 1); assert.ok(w.calls[0].url.includes('raspberrypi'));
    assert.match(w.data.deliveries.clock.status.message, /不明/);
  });
  await t.test('definite failures retry at most three times', async () => {
    const w = await worker({}, async () => new Response(null, { status: 401 }));
    await w.song('A'); await until(() => w.data.deliveries.clock?.pending?.attempts === 1); await settle();
    w.data.deliveries.clock.pending.retryAt = 0; w.events.alarm({ name: 'recover' }); await until(() => w.data.deliveries.clock.pending?.attempts === 2); await settle();
    w.data.deliveries.clock.pending.retryAt = 0; w.events.alarm({ name: 'recover' }); await until(() => w.data.deliveries.clock.pending === null); await settle();
    w.events.alarm({ name: 'recover' }); await settle(); assert.equal(w.calls.length, 3);
  });
  await t.test('test POSTs sample JSON to all presets even when OFF without changing config', async () => {
    const w = await worker({ config: { ...config([lametric()]), enabled: false } }); await settle(); const before = structuredClone(w.data.config);
    assert.deepEqual(await w.test(webhook()), { ok: true });
    assert.deepEqual(await w.test({ ...lametric(), enabled: false }), { ok: true }); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST', 'POST']);
    assert.deepEqual(w.calls.map(c => JSON.parse(c.body)), [webhook(), lametric()].map(target => renderTemplate(target.template, SAMPLE)));
    assert.equal(atob(w.calls[1].headers.Authorization.slice(6)), 'dev:test-key');
    assert.deepEqual(w.data.config, before);
  });
  await t.test('legacy settings and active ID migrate automatically', async () => {
    const w = await worker({ config: undefined, settings: { host: 'clock.local', apiKey: 'legacy-key', cycles: 0, enabled: true }, active: { id: 'legacy-id', host: 'clock.local', apiKey: 'legacy-key' } });
    await settle(); assert.equal(w.data.config.targets[0].auth.password, 'legacy-key');
    assert.equal(w.data.settings, undefined);
    await w.song('New'); await until(() => w.data.deliveries.lametric?.lastKey); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST']);
    assert.equal(JSON.parse(w.calls[0].body).model.cycles, 0);
    assert.equal(w.data.deliveries.lametric.active, undefined);
  });
  await t.test('removing destinations performs no HTTP requests, including old notifications', async () => {
    const w = await worker({ deliveries: { clock: { active: { target: lametric(), id: 'old' } } } }); await settle();
    await w.save(config([])); await until(() => !w.data.deliveries.clock); await settle();
    assert.equal(w.calls.length, 0);
  });
  await t.test('v2 cycles settings become JSON literals, with no old notification deletion', async () => {
    const clock = { ...lametric(), cycles: 7, template: '{"model":{"cycles":"{{cycles}}","frames":[{"text":"{{text}}"}]}}' };
    const w = await worker({ config: { ...config([clock]), version: 2 }, deliveries: { clock: { active: { target: clock, id: 'old' } } } }); await settle();
    assert.equal('cycles' in w.data.config.targets[0], false);
    await w.song('New'); await until(() => w.data.deliveries.clock?.lastKey); await settle();
    assert.deepEqual(w.calls.map(c => c.method), ['POST']);
    assert.equal(JSON.parse(w.calls[0].body).model.cycles, 7);
  });
  await t.test('disabled destinations never receive new songs', async () => {
    const w = await worker({ config: config([{ ...lametric(), enabled: false }, webhook()]) });
    await w.song('A'); await until(() => w.data.deliveries.pi?.lastKey); await settle();
    assert.equal(w.calls.length, 1); assert.ok(w.calls[0].url.includes('raspberrypi'));
  });
  await t.test('missing host permission rejects saving without modifying configuration', async () => {
    const w = await worker(); await settle();
    const before = structuredClone(w.data.config);
    chrome.permissions.contains = async () => false;
    const response = await w.save(config([webhook()])); await settle();
    assert.equal(response.ok, false); assert.match(response.error, /権限/);
    assert.deepEqual(w.data.config, before); assert.equal(w.calls.length, 0);
  });
  await t.test('reject untrusted options operations and invalid metadata', async () => {
    const w = await worker(); await settle();
    const response = await w.send({ type: 'save', config: config([]) }, { id: 'extension', url: 'https://music.youtube.com/', tab: { id: 1 } });
    assert.equal(response.ok, false);
    const incomplete = await w.send({ type: 'song', song: { title: 'A', artist: '' } }, { id: 'extension', url: 'https://music.youtube.com/', tab: { id: 1 } });
    assert.equal(incomplete.ok, false); await settle(); assert.equal(w.calls.length, 0);
  });
});
