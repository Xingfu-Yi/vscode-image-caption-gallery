const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHost } = require('./helpers/host');
const { VIDEO_EXTENSIONS, MEDIA_EXTENSIONS, isVideo } = require('../dist/imageFormats');
const manifest = require('../package.json');

test('video suffixes are discovered and registered in image/folder context menus', () => {
  for (const extension of VIDEO_EXTENSIONS) {
    assert.equal(MEDIA_EXTENSIONS.has(extension), true);
    assert.equal(isVideo(`vscode-remote://ssh/photos/clip${extension.toUpperCase()}?v=1`), true);
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items.filter((item) => item.when.includes('resourceExtname'))) {
        assert.ok(new RegExp(item.when.match(/=~ \/(.+)\/i$/)[1], 'i').test(extension));
      }
    }
  }
  assert.equal(isVideo('frame.png'), false);
});

test('mixed remote galleries expose private video streams without reading them or invoking the image Worker', async (t) => {
  const host = await createHost(t, {}, true);
  await fs.writeFile(path.join(host.dataset, 'a.png'), 'fixture image');
  await fs.writeFile(path.join(host.dataset, 'clip.MP4'), 'fixture video; bytes need not be decoded by extension host');
  await fs.writeFile(path.join(host.dataset, 'clip.txt'), 'a video caption');
  await host.panel.receive({ type: 'ready' });
  const records = host.sent.find((m) => m.type === 'images').images;
  assert.equal(records.length, 2);
  const video = records.find((m) => m.kind === 'video');
  assert.equal(video.name, 'clip.MP4');
  assert.equal(host.reads.length, 0);
  assert.match(host.panel.webview.html, /media-src https:\/\/resources\.test http:\/\/127\.0\.0\.1:\d+ blob:/);
  await host.panel.receive({ type: 'loadVideo', id: video.id, requestId: 'video1' });
  assert.equal(host.sent.at(-1).type, 'video');
  assert.match(host.sent.at(-1).source, /^http:\/\/127\.0\.0\.1:\d+\/v1\/[a-f0-9]{64}\/original$/);
  const count = host.sent.length;
  await host.panel.receive({ type: 'loadPreview', id: video.id, requestId: 'wrong-request' });
  await host.panel.receive({ type: 'loadVideo', id: 'vscode-remote://ssh/outside/secret.mp4', requestId: 'outside' });
  assert.equal(host.sent.length, count);
  assert.equal(host.reads.length, 0);
  await host.panel.receive({ type: 'loadCaption', id: video.id, requestId: 'video-caption' });
  const caption = host.sent.at(-1);
  assert.equal(caption.caption, 'a video caption');
  await host.panel.receive({ type: 'saveCaption', id: video.id, caption: 'edited video caption', baseRevision: caption.revision });
  assert.equal(await fs.readFile(path.join(host.dataset, 'clip.txt'), 'utf8'), 'edited video caption');
  host.panel.changeVisibility(false);
  assert.deepEqual(host.sent.at(-1), { type: 'panelVisibility', visible: false });
});

test('opening a selected video jumps to its detail record before the directory scan', async (t) => {
  const host = await createHost(t);
  await fs.writeFile(path.join(host.dataset, 'clip.webm'), 'fixture video');
  const panel = await host.openMedia('clip.webm');
  await panel.receive({ type: 'ready' });
  const initial = host.sent.find((m) => m.type === 'initialImage');
  assert.equal(initial.image.kind, 'video');
  assert.equal(initial.image.name, 'clip.webm');
  assert.equal(host.reads.length, 0);
});

test('automatic playback exposes on-demand compatibility fragments and leaves images out of video processing', { skip: require('node:child_process').spawnSync('ffmpeg', ['-version']).status !== 0 }, async (t) => {
  const host = await createHost(t, { videoCompatibility: 'auto' });
  await fs.copyFile(path.join(__dirname, 'fixtures/video-aac.mp4'), path.join(host.dataset, 'clip.mp4'));
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  await host.panel.receive({ type: 'loadVideo', id, requestId: 'converted' });
  const result = host.sent.at(-1);
  assert.equal(result.type, 'video'); assert.equal(result.converted, true);
  assert.ok(result.stream); assert.equal(result.stream.segmentSeconds, 4);
  assert.match(result.stream.mime, /vp8,vorbis/);
  assert.equal(host.reads.length, 0);
  const service = host.context.subscriptions.find(x => x.constructor.name === 'VideoService');
  assert.equal(service.stats.segments, 0, 'opening details only probes metadata; no whole-file conversion');
  host.configurationListeners.forEach((listener) => listener({ affectsConfiguration: (key) => key.endsWith('maxPreviewResolution') }));
  assert.equal(host.sent.at(-1).type, 'previewConfigurationChanged');
  host.configurationListeners.forEach((listener) => listener({ affectsConfiguration: (key) => key.endsWith('videoCompatibility') }));
  assert.equal(host.sent.at(-1).type, 'videoConfigurationChanged');
  await host.panel.receive({ type: 'loadVideo', id, requestId: 'again' });
  assert.notEqual(host.sent.at(-1).source, result.source, 'each owner gets a revocable private token');
  assert.equal(service.stats.segments, 0);
  await host.panel.receive({ type: 'releasePreview', requestId: 'again' });
});


test('remote forwarding preserves a tunnel prefix and query; bundled assets arrive in the initial HTML', async t => {
  const host = await createHost(t, { externalVideoBase: 'https://private-tunnel.test/session/prefix/?key=owned' }, true);
  await fs.writeFile(path.join(host.dataset, 'clip.mp4'), 'fixture');
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find(m => m.type === 'images').images[0].id;
  await host.panel.receive({ type: 'loadVideo', id, requestId: 'tunnel' });
  const result = host.sent.at(-1), source = new URL(result.source);
  assert.equal(source.origin, 'https://private-tunnel.test');
  assert.match(source.pathname, /^\/session\/prefix\/v1\/[a-f0-9]{64}\/original$/);
  assert.equal(source.searchParams.get('key'), 'owned');
  const html = host.panel.webview.html;
  assert.match(html, /connect-src https:\/\/private-tunnel\.test;/);
  assert.match(html, /<style nonce="[^"]+">/);
  assert.match(html, /class GalleryVideoStream/);
  assert.match(html, /\.detail-video/);
  assert.equal(/<link[^>]+stylesheet|<script[^>]+src=/.test(html), false);
});

test('full-screen action invokes the fixed VS Code command only while its panel is visible',async t=>{
 const host=await createHost(t);
 await host.panel.receive({type:'toggleWindowFullscreen',command:'untrusted.command'});
 assert.equal(host.commandsCalled.at(-1).command,'workbench.action.toggleFullScreen');
 assert.deepEqual(host.sent.at(-1),{type:'windowFullscreenToggled',error:undefined});
 const count=host.commandsCalled.length;host.panel.changeVisibility(false);await host.panel.receive({type:'toggleWindowFullscreen'});assert.equal(host.commandsCalled.length,count);
});

test('remote poster replies embed the JPEG and report errors instead of requiring another remote resource fetch', {skip:require('node:child_process').spawnSync('ffmpeg',['-version']).status!==0},async t=>{
 const host=await createHost(t,{},true);const file=path.join(host.dataset,'clip.mp4');await fs.copyFile(path.join(__dirname,'fixtures/video-aac.mp4'),file);
 const service=host.context.subscriptions.find(item=>item.constructor.name==='VideoService');service.source=async()=>{const stat=await fs.stat(file);return{filePath:file,size:stat.size,mtime:stat.mtimeMs}};
 await host.panel.receive({type:'ready'});const id=host.sent.find(m=>m.type==='images').images[0].id;
 await host.panel.receive({type:'loadVideoPoster',id,requestId:'poster-inline'});const response=host.sent.at(-1);assert.equal(response.type,'videoPoster');assert.match(response.source,/^data:image\/jpeg;base64,/);assert.equal(response.id,id);assert.ok(response.timing.bytes>0);assert.equal(host.reads.length,0);assert.equal(service.stats.segments,0);
 await fs.writeFile(file,'damaged');await host.panel.receive({type:'loadVideoPoster',id,requestId:'broken'});assert.equal(host.sent.at(-1).type,'videoPosterError');assert.match(host.sent.at(-1).message,/Video request failed/);
});

test('browser handoff validates gallery IDs, preserves state and survives Gallery disposal',async t=>{
 const host=await createHost(t,{videoCompatibility:'native'});await fs.copyFile(path.join(__dirname,'fixtures/streaming-timeline.mp4'),path.join(host.dataset,'clip.mp4'));await host.panel.receive({type:'ready'});const image=host.sent.find(m=>m.type==='images').images[0];
 await host.panel.receive({type:'openVideoInBrowser',id:'file:///outside-root/private.mp4',requestId:'untrusted',playback:{}});assert.equal(host.openedUrls.length,0);
 await host.panel.receive({type:'openVideoInBrowser',id:image.id,requestId:'browser-test',playback:{time:17,rate:1.75,volume:.3,muted:true,quality:720}});assert.equal(host.openedUrls.length,1);assert.equal(host.sent.at(-1).opened,true);const source=host.openedUrls[0];assert.match(source,/\/player\?quality=720$/);
 host.panel.close();const response=await fetch(source.replace('/player?quality=720','/state?quality=720'));assert.equal(response.status,200);const data=await response.json();assert.equal(data.state.time,17);assert.equal(data.state.rate,1.75);assert.equal(data.state.volume,.3);assert.equal(data.state.quality,720);
});
