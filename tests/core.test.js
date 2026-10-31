import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, songText } from '../core.js';
import { validateTarget, validateConfig, newTarget, migrateSettings, migrateConfig, parseEndpoint, targetOrigin, renderTemplate, sendRequest } from '../targets.js';
const lametric = () => validateTarget({ ...newTarget('lametric'), auth: { type: 'basic', username: 'dev', password: 'test-key' } });
const webhook = () => validateTarget(newTarget('webhook'));
test('accept unambiguous hosts, reject URLs, ports and numeric aliases', () => {
  for (const host of ['192.168.1.20', 'lametric.local', 'device', '[::1]']) assert.equal(normalizeHost(host), host);
  for (const host of ['', 'http://example.com', 'host:8080', 'user@host', '*.local', 'host/path', '127.1', '0x7f000001', '999.2.3.4', '[::::]']) assert.throws(() => normalizeHost(host));
});
test('webhook URLs support HTTP/HTTPS and ports, disallow credentials and unsafe schemes', () => {
  assert.equal(parseEndpoint('https://pi.local:4443/hooks/music?key=value').port, '4443');
  assert.equal(targetOrigin({ url: 'https://pi.local:4443/hooks/music' }), 'https://pi.local/*');
  for (const url of ['file:///etc/passwd', 'ftp://pi.local', 'http://a:b@pi.local/', 'http://pi.local/#x', 'http://*.local', 'http://pi.local/a b', 'http://pi.local\\evil']) assert.throws(() => parseEndpoint(url));
});
test('templates preserve JSON types, safely escape metadata and only expand once', () => {
  const song = { title: '"Quoted"\n{{artist}}', artist: 'Artist\\Name' };
  const template = '{"title":"{{title}}","nested":["{{artist}}",true,null,4],"message":"Now: {{title}} / {{artist}}","cycles":0}';
  const payload = renderTemplate(template, song);
  assert.equal(payload.title, song.title);
  assert.equal(payload.nested[0], song.artist);
  assert.equal(payload.cycles, 0);
  assert.equal(typeof payload.cycles, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.throws(() => renderTemplate('{"x":{{title}}}', song), /構文/);
  assert.throws(() => renderTemplate('{"x":"{{unknown}}"}', song), /未対応/);
  assert.throws(() => renderTemplate('{"{{title}}":1}', song), /キー/);
  assert.throws(() => renderTemplate('['.repeat(70) + '0' + ']'.repeat(70), song), /深すぎ/);
});
test('LaMetric preset and old settings migration retain credentials and cycles', () => {
  const target = lametric();
  assert.deepEqual(renderTemplate(target.template, { title: 'A', artist: 'B' }), { priority: 'info', model: { cycles: 1, frames: [{ icon: 'i1850', text: 'A' }, { icon: 'i1850', text: 'B' }] } });
  const migrated = migrateSettings({ host: 'clock.local', apiKey: 'secret', cycles: 0, enabled: true });
  assert.equal(migrated.targets[0].auth.password, 'secret');
  assert.equal(migrated.targets[0].url, 'http://clock.local:8080/api/v2/device/notifications');
  assert.equal(JSON.parse(validateConfig(migrated).targets[0].template).model.cycles, 0);
  assert.equal('cycles' in migrated.targets[0], false);
  const upgraded = migrateConfig({ version: 2, enabled: true, targets: [{ ...target, cycles: 4, template: '{"model":{"cycles":"{{cycles}}"},"text":"{{text}}"}' }] });
  assert.equal(JSON.parse(upgraded.targets[0].template).model.cycles, 4);
  assert.equal('cycles' in upgraded.targets[0], false);
  assert.throws(() => renderTemplate('{"cycles":"{{cycles}}"}', { title: 'A', artist: 'B' }), /未対応/);
  assert.throws(() => validateTarget({ ...target, url: 'https://clock.local/' }), /LaMetric/);
  assert.throws(() => validateConfig({ enabled: true, targets: [target, target] }), /重複/);
});
test('require both song fields and avoid ambiguous concatenated identity', () => {
  assert.equal(songText({ title: ' Song ', artist: ' Artist ' }), 'Song / Artist');
  assert.equal(songText({ title: 'Song', artist: '' }), null);
});
test('LaMetric POST uses dev Basic authentication and accepts an empty response', async () => {
  const target = lametric();
  assert.equal(await sendRequest(target, 'POST', { body: { a: 1 }, fetcher: async (url, options) => {
    assert.equal(url, target.url); assert.equal(atob(options.headers.Authorization.slice(6)), 'dev:test-key');
    assert.equal(options.redirect, 'error'); assert.equal(options.body, '{"a":1}');
    return new Response(null, { status: 204 });
  } }), null);
  await assert.rejects(sendRequest(target, 'DELETE'), /未対応/);
  assert.equal(await sendRequest(target, 'POST', { fetcher: async () => new Response('OK') }), null);
});
test('generic webhooks support empty 204, Bearer and UTF8 Basic credentials', async () => {
  const target = webhook();
  await sendRequest(target, 'POST', { body: {}, fetcher: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); return new Response(null, { status: 204 }); } });
  await sendRequest({ ...target, auth: { type: 'bearer', token: 'secret' } }, 'POST', { fetcher: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer secret'); return new Response('ok'); } });
  await sendRequest({ ...target, auth: { type: 'basic', username: 'user', password: '日本語' } }, 'POST', { fetcher: async (_url, options) => { assert.equal(Buffer.from(options.headers.Authorization.slice(6), 'base64').toString(), 'user:日本語'); return new Response('ok'); } });
});
test('authentication, HTTP errors, network errors and timeouts', async () => {
  const target = lametric();
  await assert.rejects(sendRequest(target, 'GET', { fetcher: async () => new Response(null, { status: 401 }) }), /認証/);
  await assert.rejects(sendRequest(target, 'POST', { fetcher: async () => new Response(null, { status: 500 }) }), e => e.ambiguous);
  await assert.rejects(sendRequest(target, 'GET', { fetcher: async () => { throw new TypeError('offline'); } }), /接続できません/);
  await assert.rejects(sendRequest(target, 'POST', { timeout: 5, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))) }), e => e.ambiguous && /タイムアウト/.test(e.message));
});

test('icon migration preserves custom frames and allows removing icons after upgrading', () => {
  const clock = lametric();
  const plain = { ...clock, template: JSON.stringify({ model: { cycles: 0, frames: [{ text: '{{title}}' }, { text: '{{artist}}' }] } }) };
  const custom = { ...clock, id: 'custom', template: JSON.stringify({ model: { frames: [{ icon: 'i123', text: '{{title}}' }, { text: '{{artist}}' }] } }) };
  const generic = { ...webhook(), template: plain.template };
  const migrated = migrateConfig({ version: 4, enabled: true, targets: [plain, custom, generic] });
  assert.deepEqual(JSON.parse(migrated.targets[0].template).model, { cycles: 0, frames: [{ icon: 'i1850', text: '{{title}}' }, { icon: 'i1850', text: '{{artist}}' }] });
  assert.deepEqual(JSON.parse(migrated.targets[1].template), JSON.parse(custom.template));
  assert.deepEqual(JSON.parse(migrated.targets[2].template), JSON.parse(generic.template));
  assert.deepEqual(migrateConfig(migrated), migrated);
  migrated.targets[0].template = plain.template;
  assert.equal(migrateConfig(migrated).targets[0].template, plain.template);
  assert.ok(JSON.parse(migrateSettings({ host: 'clock.local', apiKey: 'key' }).targets[0].template).model.frames.every(frame => frame.icon === 'i1850'));
});

test('removed text variable and redundant default field stay out of new presets', () => {
  const song = { title: 'Title', artist: 'Artist' };
  assert.throws(() => renderTemplate('{"message":"{{text}}"}', song), /未対応/);
  assert.deepEqual(renderTemplate(webhook().template, song), { source: 'youtube-music', title: 'Title', artist: 'Artist' });
});

test('upgrade splits default LaMetric frames and preserves custom templates and credentials', () => {
  const clock = lametric();
  const old = { ...clock, template: '{"priority":"info","model":{"cycles":0,"frames":[{"text":"{{text}}"}]}}' };
  const custom = { ...clock, id: 'custom', template: '{"model":{"frames":[{"icon":"i123","text":"Now: {{text}}"}]}}' };
  const generic = { ...webhook(), template: '{"source":"{{source}}","title":"{{title}}","artist":"{{artist}}","text":"{{text}}"}' };
  const migrated = migrateConfig({ version: 3, enabled: true, targets: [old, custom, generic] });
  assert.equal(migrated.version, 5);
  const model = JSON.parse(migrated.targets[0].template).model;
  assert.equal(model.cycles, 0);
  assert.deepEqual(model.frames, [{ icon: 'i1850', text: '{{title}}' }, { icon: 'i1850', text: '{{artist}}' }]);
  assert.deepEqual(migrated.targets[0].auth, old.auth);
  assert.equal(migrated.targets[0].url, old.url);
  assert.deepEqual(JSON.parse(migrated.targets[1].template).model.frames, [{ icon: 'i123', text: 'Now: {{title}} / {{artist}}' }]);
  assert.equal('text' in JSON.parse(migrated.targets[2].template), false);
  migrated.targets.forEach(validateTarget);
  assert.deepEqual(migrateConfig(migrated), migrated);
});

test('My Data DIY preset renders direct frames and retains edited configuration', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.match(await readFile(new URL('../options.html', import.meta.url), 'utf8'), /<option value="lametric-diy">LaMetric TIME - My Data DIY<\/option>/);
  const initial = newTarget('lametric-diy');
  assert.equal(initial.name, 'LaMetric TIME - My Data DIY');
  assert.equal(initial.url, 'http://<DEVICE_IP>:8080/api/v2/widget/update/com.lametric.diy.devwidget/<WIDGET_ID>');
  assert.deepEqual(initial.auth, { type: 'basic', username: 'dev', password: '' });
  const target = validateTarget({ ...initial, url: 'http://clock.local:8080/api/v2/widget/update/com.lametric.diy.devwidget/user-widget', auth: { ...initial.auth, password: 'device-key' } });
  const payload = renderTemplate(target.template, { title: '曲名 "A"', artist: '歌手' });
  assert.deepEqual(payload, { frames: [{ icon: 'i1850', text: '曲名 "A"' }, { icon: 'i1850', text: '歌手' }] });
  const config = validateConfig({ enabled: true, targets: [target] });
  assert.equal(config.version, 5);
  assert.deepEqual(validateConfig(migrateConfig(JSON.parse(JSON.stringify(config)))), config);
  for (const auth of [{ type: 'none' }, { type: 'basic', username: 'other', password: 'key' }]) assert.throws(() => validateTarget({ ...target, auth }), /Basic/);
  await sendRequest(target, 'POST', { body: payload, fetcher: async (url, options) => {
    assert.equal(url, target.url);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(atob(options.headers.Authorization.slice(6)), 'dev:device-key');
    assert.deepEqual(JSON.parse(options.body), payload);
    return new Response(null, { status: 204 });
  } });
});
