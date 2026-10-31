(() => {
  let timer, previous = '', candidate = '', candidateAt = 0;
  function read() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    const title = bar.querySelector('yt-formatted-string.title')?.textContent?.trim();
    const byline = bar.querySelector('yt-formatted-string.byline');
    // Album and metadata use separate links; the first byline link is the artist.
    const artist = byline?.querySelector('a')?.textContent?.trim();
    if (!title || !artist) return null;
    const video = document.querySelector('video');
    return { title, artist, playing: video ? !video.paused : false };
  }
  async function check() {
    const song = read();
    if (!song) { candidate = ''; return; }
    const key = JSON.stringify([song.title, song.artist, song.playing]);
    // Require a stable snapshot across two reads, avoiding intermediate DOM updates.
    if (key !== candidate) { candidate = key; candidateAt = Date.now(); schedule(); return; }
    if (Date.now() - candidateAt < 450) { schedule(); return; }
    const heartbeat = Date.now() - Number(previous.split('\n')[1] || 0) >= 3000;
    if (previous.split('\n')[0] === key && !heartbeat) return;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'song', song });
      if (result?.ok) previous = `${key}\n${Date.now()}`;
    } catch { /* Extension reloaded: refresh the tab to install the new script. */ }
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = undefined; check(); }, 500); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('play', schedule, true);
  document.addEventListener('pause', schedule, true);
  setInterval(check, 3000); // Renew the 10-second source lease; visibility is deliberately ignored.
  schedule();
})();
