import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface BrowserPlaybackState { time: number; rate: number; volume: number; muted: boolean; quality: number }
export function normalizePlaybackState(input: Partial<BrowserPlaybackState>): BrowserPlaybackState {
  const finite = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { time: finite(input.time, 0, 0, Number.MAX_SAFE_INTEGER), rate: finite(input.rate, 1, .25, 4), volume: finite(input.volume, 1, 0, 1), muted: input.muted === true, quality: [0, 720, 1080, 1440].includes(input.quality!) ? input.quality! : 1440 };
}
export function browserPlayerHtml(search: string): string {
  const query = search.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery Video</title><link rel="stylesheet" href="player.css${query}"><script defer src="hls.js${query}"></script><script defer src="player.js${query}"></script></head><body>
<main id="player"><video id="video" controls preload="metadata" playsinline></video><div id="controls"><span id="title"></span><label><span data-en="Quality" data-zh="画质">Quality</span><select id="quality"><option value="0" data-en="Original" data-zh="原画">Original</option><option value="1440">2K</option><option value="1080">1080p</option><option value="720">720p</option></select></label><label><span data-en="Speed" data-zh="倍速">Speed</span><select id="rate">${[.25,.5,.75,1,1.25,1.5,1.75,2,3,4].map(rate => `<option value="${rate}">${rate}×</option>`).join('')}</select></label><button id="fullscreen" type="button" data-en="Continue and full screen" data-zh="继续播放并全屏">Continue and full screen</button><button id="original" type="button" hidden data-en="Try original" data-zh="尝试原画">Try original</button><span id="status" role="status" aria-live="polite"></span><span id="dimensions"></span></div></main></body></html>`;
}
const assets = new Map<string, Promise<Buffer>>();
export function browserPlayerAsset(name: string): Promise<Buffer> {
  const file = name === 'hls.js' ? path.join(__dirname, 'vendor', 'hls.min.js') : path.join(__dirname, '..', 'media', name === 'player.js' ? 'browserPlayer.js' : 'browserPlayer.css');
  let cached = assets.get(file); if (!cached) { cached = fs.readFile(file); assets.set(file, cached); void cached.catch(() => assets.delete(file)); }
  return cached;
}
