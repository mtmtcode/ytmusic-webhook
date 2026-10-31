import { newTarget, migrateConfig, migrateSettings, validateTarget, validateConfig, targetOrigin, renderTemplate, SAMPLE } from './targets.js';
const $ = id => document.getElementById(id);
let busy = false;
const field = (card, key) => card.querySelector(`[data-field="${key}"]`);
function rawTarget(card) {
  const get = key => field(card, key).value;
  return { id: card.dataset.id, name: get('name'), preset: card.dataset.preset, enabled: field(card, 'enabled').checked,
    url: get('url'), template: get('template'),
    auth: { type: get('authType'), username: get('username'), password: get('password'), token: get('token') } };
}
function refresh(card) {
  const value = rawTarget(card), lametric = ['lametric', 'lametric-diy'].includes(value.preset);
  card.querySelector('.basic-fields').hidden = value.auth.type !== 'basic';
  card.querySelector('.bearer-fields').hidden = value.auth.type !== 'bearer';
  card.querySelector('.lametric-hint').hidden = value.preset !== 'lametric';
  card.querySelector('.lametric-diy-hint').hidden = value.preset !== 'lametric-diy';
  field(card, 'authType').disabled = lametric || busy;
  field(card, 'username').readOnly = lametric;
  card.querySelector('.password-label span').textContent = lametric ? 'LaMetric APIキー' : 'パスワード';
  card.querySelector('.test-hint').textContent = 'サンプル曲のJSONを実際にPOSTします。受信側の処理が実行されます。';
  try { card.querySelector('.preview').textContent = JSON.stringify(renderTemplate(value.template, SAMPLE), null, 2); }
  catch (error) { card.querySelector('.preview').textContent = error.message; }
}
function fill(card, target) {
  card.dataset.id = target.id;
  card.dataset.preset = target.preset;
  for (const key of ['name', 'url', 'template']) field(card, key).value = target[key];
  field(card, 'enabled').checked = target.enabled;
  field(card, 'authType').value = target.auth.type;
  for (const key of ['username', 'password', 'token']) field(card, key).value = target.auth[key] || '';
  refresh(card);
}
function addTarget(target) {
  const card = $('target-card').content.firstElementChild.cloneNode(true);
  fill(card, target);
  card.addEventListener('input', () => refresh(card));
  card.querySelector('.remove').addEventListener('click', () => { card.remove(); });
  card.querySelector('.test').addEventListener('click', () => { void perform('test', card); });
  $('targets').append(card);
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = value; });
  document.querySelectorAll('.target').forEach(refresh);
}
async function perform(type, card) {
  if (busy) return;
  const result = card ? card.querySelector('.test-result') : $('result');
  try {
    const config = type === 'save' ? validateConfig({ enabled: $('enabled').checked, targets: [...document.querySelectorAll('.target')].map(rawTarget) }) : null;
    const target = card ? validateTarget(rawTarget(card)) : null;
    const origins = [...new Set((config ? config.targets : [target]).map(targetOrigin))];
    // Keep permissions.request in the original user gesture, before any awaited work.
    const permission = origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
    setBusy(true);
    if (!await permission) throw new Error('送信先への接続権限が許可されませんでした。');
    result.textContent = '処理中…';
    const response = await chrome.runtime.sendMessage(type === 'save' ? { type, config } : { type, target });
    if (!response?.ok) throw new Error(response?.error || 'Service Workerから応答がありません。');
    result.dataset.error = 'false';
    result.textContent = type === 'save' ? 'すべての設定を保存しました。' : '接続成功：サンプルJSONをPOSTしました。入力値は未保存です。';
  } catch (error) { result.dataset.error = 'true'; result.textContent = error.message; }
  finally { setBusy(false); }
}
$('settings').addEventListener('submit', event => { event.preventDefault(); void perform('save'); });
$('add-webhook').addEventListener('click', () => addTarget(newTarget('webhook')));
$('add-lametric').addEventListener('click', () => addTarget(newTarget('lametric')));
$('add-lametric-diy').addEventListener('click', () => addTarget(newTarget('lametric-diy')));
const stored = await chrome.storage.local.get(['config', 'settings']);
const config = migrateConfig(stored.config) || migrateSettings(stored.settings);
$('enabled').checked = config.enabled;
config.targets.forEach(addTarget);
function showDeliveries(deliveries = {}, status) {
  $('delivery').replaceChildren();
  for (const [id, state] of Object.entries(deliveries)) {
    if (!state.status) continue;
    const card = [...document.querySelectorAll('.target')].find(item => item.dataset.id === id);
    const line = document.createElement('p');
    line.textContent = `${card ? field(card, 'name').value : '削除済みの送信先'}：${new Date(state.status.at).toLocaleString()} ${state.status.message}`;
    $('delivery').append(line);
  }
  if (status) { const line = document.createElement('p'); line.textContent = status.message; $('delivery').append(line); }
}
let deliveryState = await chrome.storage.local.get(['deliveries', 'status']);
showDeliveries(deliveryState.deliveries, deliveryState.status);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['deliveries', 'status']) if (changes[key]) deliveryState[key] = changes[key].newValue;
  showDeliveries(deliveryState.deliveries, deliveryState.status);
});

