import { songText } from './core.js';
import { migrateConfig, migrateSettings, validateConfig, validateTarget, targetOrigin, targetBody, sendRequest, SAMPLE } from './targets.js';

const read = keys => chrome.storage.local.get(keys);
const write = data => chrome.storage.local.set(data);
let transactions = Promise.resolve(), pumping = null, requested = false;
function serial(fn) { const task = transactions.then(fn); transactions = task.catch(() => {}); return task; }
async function status(message) { await write({ status: { message, at: Date.now() } }); }
async function permitted(target) {
  if (!await chrome.permissions.contains({ origins: [targetOrigin(target)] })) throw new Error('送信先への接続権限がありません。設定画面で保存し直してください。');
}
function keyOf(song) { return JSON.stringify([song.title.trim(), song.artist.trim()]); }
function makeJob(song, revision) { return { song, key: keyOf(song), revision, token: crypto.randomUUID(), attempts: 0 }; }
async function mutateDelivery(id, fn) {
  return serial(async () => {
    const { deliveries = {} } = await read('deliveries');
    const next = fn(deliveries[id] || {});
    if (next === null) delete deliveries[id]; else deliveries[id] = next;
    await write({ deliveries });
  });
}
const ready = serial(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const old = await read(['config', 'settings', 'deliveries', 'active', 'pending', 'inflight']);
  const config = migrateConfig(old.config) || { ...migrateSettings(old.settings), revision: crypto.randomUUID() };
  const deliveries = old.deliveries || {};
  for (const state of Object.values(deliveries)) {
    delete state.active;
    delete state.cleanupAttempts;
    delete state.retryAt;
    if (!state.inflight) continue;
    if (state.pending?.token === state.inflight.token) state.pending = null;
    state.inflight = null;
    state.status = { message: '前回の送信結果が不明のため自動再送しません。受信側の状態を確認してください。', at: Date.now() };
  }
  // Legacy POST may have completed without its ID. Do not recreate that delivery.
  if (!old.config && old.inflight) await status('旧バージョンのPOST結果が不明です。LaMetric側の表示を確認してください。');
  await write({ config, deliveries });
  await chrome.storage.local.remove(['settings', 'active', 'pending', 'inflight', 'lastSent', 'observed']);
});
async function clearJob(id, job, patch = {}) {
  await mutateDelivery(id, state => ({ ...state, ...patch, pending: state.pending?.token === job.token ? null : state.pending }));
}
async function deliveryStatus(id, message) {
  await mutateDelivery(id, state => ({ ...state, status: { message, at: Date.now() } }));
}
function kick() {
  requested = true;
  if (pumping) return;
  pumping = drain().catch(error => status(error.message)).finally(() => { pumping = null; if (requested) kick(); });
}
async function drain() {
  await ready;
  if (!await chrome.alarms.get('recover')) await chrome.alarms.create('recover', { periodInMinutes: 0.5 });
  do {
    requested = false;
    const { config, deliveries = {} } = await read(['config', 'deliveries']);
    const ids = new Set([...config.targets.map(target => target.id), ...Object.keys(deliveries)]);
    for (const id of ids) await processTarget(id);
  } while (requested);
}
async function processTarget(id) {
  const { config, deliveries = {} } = await read(['config', 'deliveries']);
  const target = config.targets.find(item => item.id === id), state = deliveries[id] || {};
  if (!target) { await mutateDelivery(id, () => null); return; }
  const job = state.pending;
  if (!config.enabled || !target.enabled || !job || job.retryAt > Date.now()) return;
  if (job.revision !== config.revision) { await clearJob(id, job); return; }
  if (state.lastKey === job.key && state.lastRevision === job.revision) { await clearJob(id, job); return; }
  try {
    await permitted(target);
    const fresh = await read(['config', 'deliveries']);
    const current = fresh.config.targets.find(item => item.id === id);
    if (!fresh.config.enabled || !current?.enabled || fresh.config.revision !== job.revision || fresh.deliveries[id]?.pending?.token !== job.token) { requested = true; return; }
    await mutateDelivery(id, latest => ({ ...latest, inflight: { token: job.token } }));
    await sendRequest(target, target.method ?? 'POST', { body: targetBody(target, job.song) });
    await clearJob(id, job, { inflight: null, lastKey: job.key, lastRevision: job.revision });
    await deliveryStatus(id, `送信済み：${songText(job.song)}`);
  } catch (error) {
    await deliveryStatus(id, error.message + (error.ambiguous ? ' 配信結果が不明のため自動再送しません。' : ''));
    await mutateDelivery(id, latest => {
      if (latest.pending?.token !== job.token) return { ...latest, inflight: null };
      const attempts = (job.attempts || 0) + 1;
      return { ...latest, inflight: null, pending: error.ambiguous || attempts >= 3 ? null : { ...job, attempts, retryAt: Date.now() + 30000 } };
    });
  }
}
async function acceptSong(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url?.startsWith('https://music.youtube.com/')) throw new Error('許可されていない送信元です。');
  if (!songText(message.song)) throw new Error('曲名とアーティスト名が必要です。');
  const { source, config, observedSong, deliveries = {} } = await read(['source', 'config', 'observedSong', 'deliveries']);
  const now = Date.now();
  if (source && source.tabId !== sender.tab.id && now - source.at < 10000) {
    let exists = true;
    try { await chrome.tabs.get(source.tabId); } catch { exists = false; }
    if (exists && (source.playing || !message.song.playing)) return;
  }
  await write({ source: { tabId: sender.tab.id, playing: !!message.song.playing, at: now } });
  const song = { title: message.song.title.trim(), artist: message.song.artist.trim() };
  if (observedSong && keyOf(observedSong) === keyOf(song)) return;
  for (const target of config.targets) {
    deliveries[target.id] = { ...deliveries[target.id], pending: config.enabled && target.enabled ? makeJob(song, config.revision) : null };
  }
  await write({ observedSong: song, deliveries });
}
async function saveConfig(value) {
  const config = { ...validateConfig(value), revision: crypto.randomUUID() };
  for (const target of config.targets) await permitted(target);
  const { observedSong, deliveries = {} } = await read(['observedSong', 'deliveries']);
  for (const [id, state] of Object.entries(deliveries)) deliveries[id] = { ...state, pending: null };
  for (const target of config.targets) {
    deliveries[target.id] = { ...deliveries[target.id], pending: config.enabled && target.enabled && observedSong ? makeJob(observedSong, config.revision) : null };
  }
  await write({ config, deliveries });
  await status('設定を保存しました。');
}
const optionsSender = sender => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Tests perform network I/O outside the state queue so song ingestion stays responsive.
  const task = serial(async () => {
    if (message?.type === 'song') return acceptSong(message, sender);
    if (!optionsSender(sender)) throw new Error('設定ページから実行してください。');
    if (message?.type === 'save') return saveConfig(message.config);
    if (message?.type === 'test') { const target = validateTarget(message.target); await permitted(target); return target; }
    throw new Error('不明な操作です。');
  }).then(async target => {
    if (message.type === 'test') await sendRequest(target, target.method ?? 'POST', { body: targetBody(target, SAMPLE) });
  });
  task.then(() => { respond({ ok: true }); kick(); }, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'recover') kick(); });
chrome.runtime.onStartup.addListener(kick);
chrome.runtime.onInstalled.addListener(kick);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void ready.then(kick, error => status(error.message));

