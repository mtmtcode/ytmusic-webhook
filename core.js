// Accept a host only, never a URL, port, credentials, path or wildcard.
export function normalizeHost(input) {
  const host = String(input ?? '').trim().toLowerCase();
  if (!host || host.length > 253) throw new Error('ホスト名またはIPアドレスを入力してください。');
  if (/^\[[0-9a-f:]+\]$/.test(host)) {
    try { return new URL(`http://${host}:8080`).hostname; } catch { /* rejected below */ }
  }
  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    if (parts.length === 4 && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && +p <= 255)) return host;
    throw new Error('IPv4アドレスが正しくありません。');
  }
  if (host.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) {
    try { if (new URL(`http://${host}:8080`).hostname === host) return host; } catch { /* Reject numeric aliases and invalid URL hosts. */ }
  }
  throw new Error('URLやポートを含めずホストだけを入力してください。IPv6は角括弧で囲んでください。');
}
export function songText(song) {
  if (!song || typeof song.title !== 'string' || typeof song.artist !== 'string') return null;
  const title = song.title.trim(), artist = song.artist.trim();
  if (!title || !artist || title.length > 500 || artist.length > 500) return null;
  return `${title} / ${artist}`;
}
export class ApiError extends Error {
  constructor(message, ambiguous = false) { super(message); this.ambiguous = ambiguous; }
}
