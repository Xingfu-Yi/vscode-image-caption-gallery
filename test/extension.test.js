const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHost } = require('./helpers/host');
const { initializeProcessor } = require('../dist/previewProcessor');

test('Remote SSH resources become host-generated preview URIs, with metadata-only scans and caption request tokens', async (t) => {
  const host = await createHost(t, {}, true);
  const m = await initializeProcessor();
  const original = m.ImageMagick.read(m.MagickColors.Blue, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (bytes) => Uint8Array.from(bytes)));
  await fs.writeFile(path.join(host.dataset, 'test.jpg'), original);
  await fs.writeFile(path.join(host.dataset, 'test.txt'), 'remote caption');
  await host.panel.receive({ type: 'ready' });
  const images = host.sent.find((message) => message.type === 'images').images;
  assert.equal(images.length, 1);
  assert.match(images[0].id, /^vscode-remote:\/\/ssh-remote\+test/);
  assert.equal(images[0].source, undefined);
  assert.equal(host.reads.length, 0, 'scanning must not read image or caption contents');
  await host.panel.receive({ type: 'loadPreview', id: images[0].id, requestId: 'preview-1', detail: true });
  const preview = host.sent.find((message) => message.type === 'preview');
  const previewUri = new URL(new URL(preview.source).searchParams.get('uri'));
  assert.equal(previewUri.protocol, 'file:');
  assert.match(previewUri.pathname, /\/storage\/previews\/[a-f0-9]+\.webp$/);
  assert.equal(preview.originalWidth, 96);
  assert.equal(preview.originalHeight, 64);
  assert.ok(preview.width * preview.height <= 32 ** 2);
  assert.ok(host.panel.options.localResourceRoots.some((uri) => uri.path.endsWith('/previews')));
  assert.deepEqual(host.reads, [images[0].id]);
  const rendered = await fs.readFile(previewUri);
  m.ImageMagick.read(rendered, (image) => assert.equal(image.width, preview.width));
  await host.panel.receive({ type: 'loadCaption', id: images[0].id, requestId: 'caption-1' });
  const caption = host.sent.find((message) => message.type === 'caption');
  assert.equal(caption.requestId, 'caption-1');
  assert.equal(caption.caption, 'remote caption');
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(host.dataset, 'test.jpg'))), original);
  await host.panel.receive({ type: 'releasePreview', requestId: 'preview-1' });
});

test('disabled limits and explicit fallback send the original URI without decoding; configuration changes invalidate previews', async (t) => {
  const host = await createHost(t, { maxPreviewResolution: 0 });
  await fs.writeFile(path.join(host.dataset, 'test.jpg'), 'intentionally undecodable');
  await host.panel.receive({ type: 'ready' });
  const image = host.sent.find((message) => message.type === 'images').images[0];
  await host.panel.receive({ type: 'loadPreview', id: image.id, requestId: 'disabled', detail: true });
  assert.equal(new URL(host.sent.at(-1).source).searchParams.get('uri'), image.id);
  assert.equal(host.reads.length, 0);
  host.config.maxPreviewResolution = 32;
  for (const listener of host.configurationListeners) { listener({ affectsConfiguration: (section) => section === 'imageCaptionGallery.maxPreviewResolution' }); }
  assert.equal(host.sent.at(-1).type, 'previewConfigurationChanged');
  await host.panel.receive({ type: 'loadPreview', id: image.id, requestId: 'bad', detail: true });
  assert.equal(host.sent.at(-1).type, 'previewError');
  await host.panel.receive({ type: 'loadPreview', id: image.id, requestId: 'original', detail: true, original: true });
  assert.equal(new URL(host.sent.at(-1).source).searchParams.get('uri'), image.id);
  const count = host.sent.length;
  await host.panel.receive({ type: 'loadPreview', id: 'file:///outside-root/private.jpg', requestId: 'unknown' });
  assert.equal(host.sent.length, count, 'arbitrary client paths must not be served');
});

test('large scans publish at most 512 records per message and allow opening files before completion', async (t) => {
  const host = await createHost(t, { maxPreviewResolution: 0 }, true);
  const count = 10000;
  host.fileSystem.readDirectory = async () => Array.from({ length: count }, (_, i) => [`frame-${count - i}.jpg`, 1]);
  const post = host.panel.webview.postMessage;
  let openedEarly = false;
  host.panel.webview.postMessage = async (message) => {
    await post(message);
    if (message.type === 'imageBatch' && !openedEarly) {
      openedEarly = true;
      await host.panel.receive({ type: 'loadPreview', id: message.images[0].id, requestId: 'early', detail: true });
    }
    return true;
  };
  await host.panel.receive({ type: 'ready' });
  const batches = host.sent.filter((m) => m.type === 'imageBatch');
  assert.equal(batches.flatMap((m) => m.images).length, count);
  assert.ok(batches.every((m) => m.images.length <= 512));
  const done = host.sent.find((m) => m.type === 'images');
  assert.equal(done.images, undefined); assert.equal(done.order.length, count);
  const records = batches.flatMap((m) => m.images);
  const ordered = done.order.map((index) => records[index].relativePath);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a.localeCompare(b)));
  assert.ok(host.sent.findIndex((m) => m.type === 'preview') < host.sent.indexOf(done));
  assert.equal(host.reads.length, 0);
});

test('refresh and panel disposal cancel stale directory walks instead of finishing them in the background', async (t) => {
  const host = await createHost(t);
  let first = true, unblock, reached;
  const ready = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  host.fileSystem.readDirectory = async () => {
    if (first) { first = false; reached(); await gate; return [['old.jpg', 1]]; }
    return [['new.jpg', 1]];
  };
  const old = host.panel.receive({ type: 'ready' }); await ready;
  await host.panel.receive({ type: 'refresh' }); unblock(); await old;
  assert.equal(host.sent.filter((m) => m.type === 'images').length, 1);
  assert.equal(host.sent.find((m) => m.type === 'images').images[0].name, 'new.jpg');
  let reads = 0;
  host.fileSystem.readDirectory = async () => { reads++; host.panel.close(); return [['subdirectory', 2]]; };
  await host.panel.receive({ type: 'refresh' });
  assert.equal(reads, 1);
});

test('grid thumbnails are small static resources even with detail limits disabled', async (t) => {
  const host = await createHost(t, { maxPreviewResolution: 0 }, true);
  const m = await initializeProcessor();
  const bytes = m.ImageMagick.read(m.MagickColors.Red, 1600, 900, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  await fs.writeFile(path.join(host.dataset, 'large.jpg'), bytes);
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'thumb', detail: false });
  const thumbnail = host.sent.at(-1);
  assert.ok(thumbnail.width * thumbnail.height <= 512 ** 2);
  assert.notEqual(new URL(thumbnail.source).searchParams.get('uri'), id);
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'detail', detail: true });
  assert.equal(new URL(host.sent.at(-1).source).searchParams.get('uri'), id);
});

test('current-gallery resolution overrides are validated and do not change VS Code defaults', async (t) => {
  const host = await createHost(t, { maxPreviewResolution: 0 });
  await fs.writeFile(path.join(host.dataset, 'image.jpg'), 'invalid bytes');
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'invalid-setting', detail: true, resolution: -1 });
  assert.equal(host.sent.at(-1).type, 'preview'); assert.equal(host.reads.length, 0);
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'overridden', detail: true, resolution: 1024 });
  assert.equal(host.sent.at(-1).type, 'previewError'); assert.equal(host.config.maxPreviewResolution, 0);
  await host.panel.receive({ type: 'openDefaultSettings' });
  assert.deepEqual(host.commandsCalled.at(-1), { command: 'workbench.action.openSettings', text: '@ext:xingfu-yi.image-caption-gallery' });
});

test('Chinese VS Code settings labels and session video overrides are available without loading captions', async (t) => {
  const host = await createHost(t, { uiLanguage: 'zh-cn', videoCompatibility: 'auto' }, true);
  assert.match(host.panel.webview.html, /Gallery 设置/); assert.match(host.panel.webview.html, /显示 Caption 文本/);
  await fs.writeFile(path.join(host.dataset, 'video.avi'), 'video test metadata');
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  await host.panel.receive({ type: 'loadVideo', id, requestId: 'native', videoCompatibility: 'native', ffmpegPath: '/missing/tools/ffmpeg' });
  assert.equal(host.sent.at(-1).type, 'video'); assert.equal(host.sent.at(-1).converted, false);
  assert.equal(host.reads.length, 0); assert.equal(host.config.videoCompatibility, 'auto');
});

test('Remote SSH neighbour preloads reuse detail previews and honor animation memory limits', async (t) => {
  const host = await createHost(t, {}, true);
  await fs.writeFile(path.join(host.dataset, 'image.jpg'), 'fixture');
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  const service = host.context.subscriptions.find((item) => item.constructor.name === 'PreviewService');
  let calls = 0;
  service.options.process = async () => { calls++; return { originalWidth: 4096, originalHeight: 4096, width: 2048, height: 2048, frameCount: 1, bytes: new Uint8Array([1]) }; };
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'neighbour', detail: true, prefetch: true, resolution: 2048 });
  const neighbour = host.sent.at(-1);
  assert.equal(neighbour.type, 'preview'); assert.equal(neighbour.width, 2048);
  assert.match(new URL(new URL(neighbour.source).searchParams.get('uri')).pathname, /\/storage\/previews\//);
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'foreground', detail: true, resolution: 2048 });
  assert.equal(host.sent.at(-1).source, neighbour.source); assert.equal(calls, 1);
  service.options.process = async () => ({ originalWidth: 8192, originalHeight: 8192, width: 8192, height: 8192, frameCount: 1 });
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'large-original', detail: true, prefetch: true, resolution: 0 });
  assert.equal(host.sent.at(-1).type, 'previewSkipped'); assert.equal(host.sent.at(-1).source, undefined);
  service.options.process = async () => ({ originalWidth: 2048, originalHeight: 2048, width: 1024, height: 1024, frameCount: 30, bytes: new Uint8Array([1]) });
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'animation', detail: true, prefetch: true, resolution: 1024 });
  assert.equal(host.sent.at(-1).type, 'previewSkipped');
  await host.panel.receive({ type: 'loadPreview', id, requestId: 'opened-animation', detail: true, resolution: 1024 });
  assert.equal(host.sent.at(-1).type, 'preview', 'memory limit only applies to speculative loading');
});

test('cancelled caption preloads do not render or post after navigation or panel disposal', async (t) => {
  const host = await createHost(t, {}, true);
  await fs.writeFile(path.join(host.dataset, 'image.jpg'), 'fixture');
  await host.panel.receive({ type: 'ready' });
  const id = host.sent.find((m) => m.type === 'images').images[0].id;
  let unblock, started;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const reached = new Promise((resolve) => { started = resolve; });
  host.fileSystem.readFile = async () => { started(); await gate; return Buffer.from('late caption'); };
  const load = host.panel.receive({ type: 'loadCaption', id, requestId: 'cancelled' }); await reached;
  await host.panel.receive({ type: 'releaseCaption', requestId: 'cancelled' }); unblock(); await load;
  assert.equal(host.sent.some((m) => m.type === 'caption'), false);
  assert.equal(host.commandsCalled.some((m) => m.command === 'markdown.api.render'), false);
  const renderCommand = host.commandsCalled.length;
  // A second request also disappears when the panel closes.
  const second = host.panel.receive({ type: 'loadCaption', id, requestId: 'closed' });
  host.panel.close(); await second;
  assert.equal(host.sent.some((m) => m.type === 'caption'), false);
  assert.equal(host.commandsCalled.length, renderCommand);
});

test('warm validation checks only metadata and invalidates modified local or SSH images, including originals', async (t) => {
  for (const remote of [false, true]) {
    const host = await createHost(t, { maxPreviewResolution: 0 }, remote);
    const file = path.join(host.dataset, 'image.jpg'); await fs.writeFile(file, 'original');
    await host.panel.receive({ type: 'ready' }); const id = host.sent.find((m) => m.type === 'images').images[0].id;
    await host.panel.receive({ type: 'loadPreview', id, requestId: 'warm', detail: true });
    const count = host.sent.length;
    await host.panel.receive({ type: 'validatePreview', id, requestId: 'warm' });
    assert.equal(host.sent.length, count); assert.equal(host.reads.length, 0);
    await fs.writeFile(file, 'replaced image bytes');
    await host.panel.receive({ type: 'validatePreview', id, requestId: 'warm' });
    assert.equal(host.sent.at(-1).type, 'previewInvalidated'); assert.equal(host.reads.length, 0);
    await host.panel.receive({ type: 'releasePreview', requestId: 'warm' }); const after = host.sent.length;
    await host.panel.receive({ type: 'validatePreview', id, requestId: 'warm' }); assert.equal(host.sent.length, after);
  }
});

test('all Gallery panels share bounded session decoder settings without writing VS Code defaults', async (t) => {
  const host=await createHost(t,{previewConcurrency:1,previewExecutionMode:'process'});
  await fs.writeFile(path.join(host.dataset,'image.jpg'),'fixture');const second=await host.openMedia('image.jpg');
  await host.panel.receive({type:'setPreviewConcurrency',concurrency:2});
  const statuses=host.sent.filter(x=>x.type==='previewPoolStatus');assert.equal(statuses.length,2);
  assert.ok(statuses.every(x=>x.requested===2&&x.workers>=1&&x.workers<=2));
  await second.receive({type:'setPreviewExecutionMode',mode:'thread'});
  assert.equal(host.sent.at(-1).mode,'thread');assert.equal(host.config.previewConcurrency,1);assert.equal(host.config.previewExecutionMode,'process');
  const count=host.sent.length;await host.panel.receive({type:'setPreviewConcurrency',concurrency:100});await host.panel.receive({type:'setPreviewExecutionMode',mode:'arbitrary command'});assert.equal(host.sent.length,count);
  host.config.previewConcurrency=1;host.config.previewExecutionMode='process';
  for(const callback of host.configurationListeners){callback({affectsConfiguration:key=>['imageCaptionGallery.previewConcurrency','imageCaptionGallery.previewExecutionMode'].includes(key)});}
  await host.panel.receive({type:'getPreviewPool'});assert.equal(host.sent.at(-1).requested,1);assert.equal(host.sent.at(-1).mode,'process');
});

test('Remote SSH thumbnails carry a small inline WebP while details retain leased resource URIs',async t=>{
 const host=await createHost(t,{maxPreviewResolution:2048},true),m=await initializeProcessor();
 const bytes=m.ImageMagick.read(m.MagickColors.Blue,2000,1500,image=>image.write(m.MagickFormat.Jpeg,b=>Uint8Array.from(b)));const file=path.join(host.dataset,'large.jpg');await fs.writeFile(file,bytes);
 await host.panel.receive({type:'ready'});const id=host.sent.find(m=>m.type==='images').images[0].id;
 await host.panel.receive({type:'loadPreview',id,requestId:'inline-thumbnail',detail:false});const thumbnail=host.sent.at(-1);assert.equal(thumbnail.type,'preview');assert.match(thumbnail.source,/^data:image\/webp;base64,/);
 const decoded=Buffer.from(thumbnail.source.split(',')[1],'base64');assert.equal(decoded.length,thumbnail.inlineBytes);assert.ok(decoded.length<=256*1024);m.ImageMagick.read(decoded,image=>{assert.equal(image.width,thumbnail.width);assert.equal(image.height,thumbnail.height);});
 await host.panel.receive({type:'loadPreview',id,requestId:'detail-resource',detail:true,resolution:512});assert.match(host.sent.at(-1).source,/^https:\/\/resources.test/);assert.equal(host.sent.at(-1).inlineBytes,undefined);assert.deepEqual(new Uint8Array(await fs.readFile(file)),bytes);
 const service=host.context.subscriptions.find(item=>item.constructor.name==='PreviewService');service.options.process=async()=>({originalWidth:4096,originalHeight:4096,width:512,height:512,bytes:new Uint8Array(300*1024)});
 await host.panel.receive({type:'loadPreview',id,requestId:'oversized-thumbnail',detail:false,resolution:256});assert.match(host.sent.at(-1).source,/^https:\/\/resources.test/);assert.equal(host.sent.at(-1).inlineBytes,undefined,'large thumbnail payloads use the bounded resource path');
});
