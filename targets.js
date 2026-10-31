import { normalizeHost, songText, ApiError } from './core.js';

export const WEBHOOK_TEMPLATE = JSON.stringify({ source: '{{source}}', title: '{{title}}', artist: '{{artist}}', text: '{{text}}' }, null, 2);
export const LAMETRIC_TEMPLATE = JSON.stringify({ priority: 'info', model: { cycles: 1, frames: [{ text: '{{text}}' }] } }, null, 2);
export const SAMPLE = { title: '接続テスト', artist: 'YouTube Music' };
const VARIABLES = ['source', 'title', 'artist', 'text'];
export function newTarget(preset = 'webhook') {
  return { id: crypto.randomUUID(), name: preset === 'lametric' ? 'LaMetric TIME' : 'Webhook', preset, enabled: true,
    url: preset === 'lametric' ? 'http://192.168.1.20:8080/api/v2/device/notifications' : 'http://raspberrypi.local:3000/now-playing',
    auth: preset === 'lametric' ? { type: 'basic', username: 'dev', password: '' } : { type: 'none' },
    template: preset === 'lametric' ? LAMETRIC_TEMPLATE : WEBHOOK_TEMPLATE };
}
export function parseEndpoint(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 2048 || /[\s\\*]/.test(raw)) throw new Error('送信先には空白・ワイルドカードを含まないHTTP(S) URLを入力してください。');
  let url;
  try { url = new URL(raw); } catch { throw new Error('送信先URLが正しくありません。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) throw new Error('送信先は認証情報・フラグメントを含まないHTTP(S) URLにしてください。');
  normalizeHost(url.hostname);
  return url;
}
export function targetOrigin(target) { const url = parseEndpoint(target.url); return `${url.protocol}//${url.hostname}/*`; }
export function renderTemplate(template, song) {
  if (typeof template !== 'string' || template.length > 65536) throw new Error('JSONテンプレートは64KB以内にしてください。');
  let parsed;
  try { parsed = JSON.parse(template); } catch { throw new Error('JSONテンプレートの構文が正しくありません。変数も二重引用符で囲んでください。'); }
  const text = songText(song);
  if (!text) throw new Error('曲名とアーティスト名が必要です。');
  const values = { source: 'youtube-music', title: song.title.trim(), artist: song.artist.trim(), text };
  function walk(value, depth = 0) {
    if (depth > 64) throw new Error('JSONテンプレートの入れ子が深すぎます。');
    if (typeof value === 'string') {
      const entire = value.match(/^\{\{(\w+)\}\}$/);
      if (entire && VARIABLES.includes(entire[1])) return values[entire[1]];
      return value.replace(/\{\{([^{}]*)\}\}/g, (_match, key) => {
        if (!VARIABLES.includes(key)) throw new Error(`未対応のテンプレート変数：${key}`);
        return String(values[key]);
      });
    }
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key.includes('{{')) throw new Error('JSONのキーにはテンプレート変数を使用できません。');
      return [key, walk(item, depth + 1)];
    }));
    return value;
  }
  return walk(parsed);
}
export function validateTarget(value) {
  if (!value || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id)) throw new Error('送信先IDが不正です。');
  const name = String(value.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('送信先名は1〜80文字です。');
  if (!['webhook', 'lametric'].includes(value.preset)) throw new Error('プリセットが不正です。');
  const url = parseEndpoint(value.url);
  if (typeof value.enabled !== 'boolean') throw new Error('送信先のON/OFFが不正です。');
  const supplied = value.auth || { type: 'none' };
  let auth;
  if (supplied.type === 'none') auth = { type: 'none' };
  else if (supplied.type === 'basic') {
    const username = String(supplied.username ?? ''), password = String(supplied.password ?? '');
    if (!username || username.includes(':') || /[\r\n]/.test(username + password) || !password) throw new Error('Basic認証のユーザー名とパスワードを入力してください。');
    auth = { type: 'basic', username, password };
  } else if (supplied.type === 'bearer') {
    const token = String(supplied.token ?? '').trim();
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('Bearerトークンには空白を含まないASCII文字を入力してください。');
    auth = { type: 'bearer', token };
  } else throw new Error('認証方式が不正です。');
  if (value.preset === 'lametric') {
    if (url.protocol !== 'http:' || url.port !== '8080' || url.pathname !== '/api/v2/device/notifications' || url.search) throw new Error('LaMetricのURLは http://ホスト:8080/api/v2/device/notifications にしてください。');
    if (auth.type !== 'basic' || auth.username !== 'dev') throw new Error('LaMetricはBasic認証・ユーザー名devを使用します。');
  }
  renderTemplate(value.template, SAMPLE);
  return { id: value.id, name, preset: value.preset, enabled: value.enabled, url: url.href, auth, template: value.template };
}
export function validateConfig(value) {
  if (typeof value?.enabled !== 'boolean' || !Array.isArray(value.targets) || value.targets.length > 20) throw new Error('設定には最大20件の送信先を指定してください。');
  const targets = value.targets.map(validateTarget);
  if (new Set(targets.map(target => target.id)).size !== targets.length) throw new Error('送信先IDが重複しています。');
  return { version: 3, enabled: value.enabled, targets };
}
export function migrateSettings(settings) {
  if (!settings?.host) return { version: 3, enabled: false, targets: [] };
  return { version: 3, enabled: !!settings.enabled, targets: [{ ...newTarget('lametric'), id: 'lametric', url: `http://${normalizeHost(settings.host)}:8080/api/v2/device/notifications`, template: JSON.stringify({ priority: 'info', model: { cycles: settings.cycles ?? 1, frames: [{ text: '{{text}}' }] } }, null, 2), auth: { type: 'basic', username: 'dev', password: settings.apiKey } }] };
}
// Convert the retired cycles variable to a literal once when upgrading saved settings.
export function migrateConfig(config) {
  if (!config) return null;
  return { ...config, version: 3, targets: config.targets.map(target => {
    const { cycles, ...rest } = target;
    if (config.version >= 3 || !target.template.includes('{{cycles}}')) return rest;
    function inline(value) {
      if (typeof value === 'string') return value === '{{cycles}}' ? (cycles ?? 1) : value.replaceAll('{{cycles}}', String(cycles ?? 1));
      if (Array.isArray(value)) return value.map(inline);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inline(item)]));
      return value;
    }
    return { ...rest, template: JSON.stringify(inline(JSON.parse(target.template)), null, 2) };
  }) };
}
function utf8Base64(text) { return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')); }
export async function sendRequest(target, method, { body, fetcher = fetch, timeout = 8000 } = {}) {
  if (!['GET', 'POST'].includes(method)) throw new ApiError('未対応のHTTPメソッドです。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (target.auth.type === 'basic') headers.Authorization = `Basic ${utf8Base64(`${target.auth.username}:${target.auth.password}`)}`;
    if (target.auth.type === 'bearer') headers.Authorization = `Bearer ${target.auth.token}`;
    const response = await fetcher(target.url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new ApiError('認証エラー：認証情報を確認してください。');
      throw new ApiError(`HTTPエラー (${response.status})`, method === 'POST' && response.status >= 500);
    }
    // POST delivery needs no notification ID or response JSON, including for LaMetric.
    return null;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? '通信がタイムアウトしました。' : '接続できません。URL、接続権限、ネットワークを確認してください。', method === 'POST');
  } finally { clearTimeout(timer); }
}
