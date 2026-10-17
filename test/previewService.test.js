const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PreviewService } = require('../dist/previewService');
const { initializeProcessor } = require('../dist/previewProcessor');
const dimensions = { originalWidth: 96, originalHeight: 64, width: 39, height: 26 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-preview-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real Worker writes reusable previews, invalidates modifications/settings, and never changes the source', async (t) => {
  const dir = await directory(t);
  const m = await initializeProcessor();
  const bytes = m.ImageMagick.read(m.MagickColors.Red, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  const original = Uint8Array.from(bytes);
  let reads = 0, revision = 1;
  const source = async () => ({ mtime: revision, size: bytes.length, read: async () => { reads++; return bytes; } });
  const service = new PreviewService(dir, source);
  t.after(() => service.dispose());
  const a = await service.get('ssh://dataset/a.jpg', 32, 'a', true, new AbortController().signal);
  assert.match(a.filePath, /\.webp$/);
  assert.ok(a.width * a.height <= 1024);
  assert.ok((await fs.readFile(a.filePath)).length > 0);
  const hit = await service.get('ssh://dataset/a.jpg', 32, 'b', false, new AbortController().signal);
  assert.equal(hit.filePath, a.filePath);
  assert.equal(reads, 1);
  revision++;
  const changed = await service.get('ssh://dataset/a.jpg', 32, 'c', true, new AbortController().signal);
  assert.notEqual(changed.filePath, a.filePath);
  const configured = await service.get('ssh://dataset/a.jpg', 16, 'd', true, new AbortController().signal);
  assert.notEqual(configured.filePath, changed.filePath);
  assert.ok(configured.width * configured.height <= 256);
  const small = await service.get('ssh://dataset/a.jpg', 128, 'e', true, new AbortController().signal);
  assert.equal(small.filePath, undefined);
  assert.deepEqual(bytes, original);
  service.dispose();
  const restored = new PreviewService(dir, source);
  t.after(() => restored.dispose());
  const readCount = reads;
  const reused = await restored.get('ssh://dataset/a.jpg', 32, 'f', true, new AbortController().signal);
  assert.equal(reused.filePath, changed.filePath);
  assert.equal(reads, readCount);
});

test('prioritizes details, merges duplicates, skips cancelled queued work, and rejects disposed requests', async (t) => {
  const dir = await directory(t);
  const gate = deferred(), started = deferred();
  const processed = [];
  const service = new PreviewService(dir, async (id) => ({ mtime: 1, size: 1, read: async () => new Uint8Array([Number(id)]) }), {
    process: async (bytes) => {
      processed.push(bytes[0]);
      if (bytes[0] === 1) { started.resolve(); await gate.promise; }
      return { ...dimensions, bytes: new Uint8Array(10) };
    },
  });
  t.after(() => service.dispose());
  const signal = () => new AbortController().signal;
  const first = service.get('1', 32, 'first', false, signal());
  await started.promise;
  const thumb = service.get('2', 32, 'thumb', false, signal());
  const cancelled = new AbortController();
  const skipped = service.get('3', 32, 'skipped', false, cancelled.signal);
  const rejected = assert.rejects(skipped, { name: 'AbortError' });
  const detail = service.get('4', 32, 'detail', true, signal());
  const duplicate = service.get('4', 32, 'duplicate', false, signal());
  await tick(); cancelled.abort(); gate.resolve();
  const results = await Promise.all([first, thumb, detail, duplicate, rejected]);
  assert.deepEqual(processed, [1, 4, 2]);
  assert.equal(results[2].filePath, results[3].filePath);
  service.dispose();
  await assert.rejects(service.get('1', 32, 'late', true, signal()), { name: 'AbortError' });
});

test('LRU eviction respects active leases and resumes once images are released', async (t) => {
  const dir = await directory(t);
  const service = new PreviewService(dir, async () => ({ mtime: 1, size: 10, read: async () => new Uint8Array(1) }), {
    maxBytes: 10,
    process: async () => ({ ...dimensions, bytes: new Uint8Array(10) }),
  });
  t.after(() => service.dispose());
  const signal = () => new AbortController().signal;
  const a = await service.get('a', 32, 'a', true, signal());
  const b = await service.get('b', 32, 'b', true, signal());
  await fs.access(a.filePath); await fs.access(b.filePath);
  service.release('a');
  for (let i = 0; i < 50; i++) {
    if (!(await fs.readdir(dir)).some((name) => name === path.basename(a.filePath))) { break; }
    await tick();
  }
  await assert.rejects(fs.access(a.filePath));
  await fs.access(b.filePath);
});

test('Worker failure and timeout allow later requests to recover', async (t) => {
  const dir = await directory(t);
  const m = await initializeProcessor();
  const good = m.ImageMagick.read(m.MagickColors.Blue, 96, 64, (image) => image.write(m.MagickFormat.Png, (b) => Uint8Array.from(b)));
  const service = new PreviewService(dir, async (id) => ({ mtime: 1, size: 1, read: async () => id === 'bad' ? new Uint8Array([1]) : good }));
  t.after(() => service.dispose());
  await assert.rejects(service.get('bad', 32, 'bad', true, new AbortController().signal));
  assert.ok((await service.get('good', 32, 'good', true, new AbortController().signal)).filePath);
  const slow = new PreviewService(path.join(dir, 'timeout'), async () => ({ mtime: 1, size: 1, read: async () => good }), { timeoutMs: 1 });
  t.after(() => slow.dispose());
  await assert.rejects(slow.get('slow', 32, 'slow', true, new AbortController().signal), /timed out/);
});

test('static thumbnails have independent cache entries and cannot replace animated detail previews', async (t) => {
  const dir = await directory(t), modes = [];
  const service = new PreviewService(dir, async () => ({ mtime: 1, size: 1, read: async () => new Uint8Array([1]) }), {
    process: async (bytes, resolution, filename, thumbnail) => { modes.push(thumbnail); return { ...dimensions, bytes: new Uint8Array([1]) }; },
  });
  t.after(() => service.dispose());
  const detail = await service.get('animated.gif', 32, 'detail', true, new AbortController().signal);
  const thumbnail = await service.get('animated.gif', 32, 'thumbnail', false, new AbortController().signal, true);
  assert.notEqual(detail.filePath, thumbnail.filePath);
  assert.deepEqual(modes, [false, true]);
  const cached = await service.get('animated.gif', 32, 'other', false, new AbortController().signal, true);
  assert.equal(cached.filePath, thumbnail.filePath); assert.equal(modes.length, 2);
});

test('promotes an adopted neighbour ahead of queued work without repeating reads or processing', async (t) => {
  const dir = await directory(t), gate = deferred(), started = deferred(), sourceGate = deferred();
  const processed = [], reads = [];
  const service = new PreviewService(dir, async (id) => {
    if (id === '4') { await sourceGate.promise; }
    return { mtime: 1, size: 1, read: async () => { reads.push(id); return new Uint8Array([Number(id)]); } };
  }, {
    process: async (bytes) => {
      processed.push(bytes[0]);
      if (bytes[0] === 1) { started.resolve(); await gate.promise; }
      return { ...dimensions, bytes: new Uint8Array(10) };
    },
  });
  t.after(() => service.dispose());
  const signal = () => new AbortController().signal;
  const first = service.get('1', 32, 'first', true, signal()); await started.promise;
  const thumb = service.get('2', 32, 'thumb', false, signal(), true);
  const neighbour = service.get('3', 32, 'neighbour', false, signal());
  await tick(); service.promote('neighbour');
  const early = service.get('4', 32, 'early', false, signal());
  service.promote('early'); sourceGate.resolve(); await tick();
  gate.resolve();
  await Promise.all([first, thumb, neighbour, early]);
  assert.deepEqual(processed, [1, 3, 4, 2]);
  assert.deepEqual(reads, ['1', '3', '4', '2']);
  for (const owner of ['first', 'thumb', 'neighbour', 'early']) { service.release(owner); }
  assert.equal(service.promotedOwners.size, 0);
});

test('bounded parallel jobs preserve priority, merge duplicates, report timings and resize the pool', async (t) => {
  const gates=[deferred(),deferred()],started=[deferred(),deferred()];let running=0,peak=0;const order=[];
  const service=new PreviewService(await directory(t),async id=>({mtime:1,size:1,read:async()=>new Uint8Array([Number(id)])}),{
    concurrency:2,process:async bytes=>{running++;peak=Math.max(peak,running);const id=bytes[0];order.push(id);if(id<=2){started[id-1].resolve();await gates[id-1].promise;}running--;return {...dimensions,bytes:new Uint8Array(10)};}
  });t.after(()=>service.dispose());
  const get=(id,owner,detail=false)=>service.get(String(id),32,owner,detail,new AbortController().signal);
  const a=get(1,'a'),b=get(2,'b');await Promise.all(started.map(x=>x.promise));
  const background=get(3,'background'),foreground=get(4,'foreground',true),duplicate=get(4,'duplicate');
  await tick();gates[0].resolve();
  const result=await foreground;assert.equal(order[2],4);assert.equal(peak,2);assert.equal(result.timings.cacheHit,false);assert.ok(result.timings.queueMs>=0&&result.timings.processMs>=0&&result.timings.readMs>=0);
  assert.equal((await duplicate).filePath,result.filePath);
  service.setConcurrency(1);assert.equal(service.poolStatus.workers,1);
  gates[1].resolve();await Promise.all([a,b,background]);
  assert.equal((await get(4,'cache')).timings.cacheHit,true);
});

test('cancelling the final owner stops active processing; immediate revisit creates fresh work without cancelling a duplicate owner', async (t) => {
  const gates=[deferred(),deferred()],started=[deferred(),deferred()];let calls=0;
  const service=new PreviewService(await directory(t),async()=>({mtime:1,size:1,read:async()=>new Uint8Array(1)}),{
    concurrency:2,process:async()=>{const index=calls++;started[index]?.resolve();await gates[index]?.promise;return {...dimensions,bytes:new Uint8Array(10)};}
  });t.after(()=>service.dispose());
  const firstController=new AbortController();const first=service.get('same',32,'first',true,firstController.signal);await started[0].promise;
  const rejected=assert.rejects(first,{name:'AbortError'});firstController.abort();
  const fresh=service.get('same',32,'fresh',true,new AbortController().signal);await started[1].promise;
  const duplicateController=new AbortController();const duplicate=service.get('same',32,'duplicate',true,duplicateController.signal);
  await tick();const cancelled=assert.rejects(duplicate,{name:'AbortError'});duplicateController.abort();gates[0].resolve();gates[1].resolve();
  await Promise.all([rejected,cancelled]);assert.ok((await fresh).filePath);assert.equal(calls,2);
});

test('queue progress admits foreground before speculation; neighbours outrank thumbnails',async t=>{
 const dir=await directory(t),gate=deferred(),started=deferred(),order=[],queued=[];
 const service=new PreviewService(dir,async id=>({mtime:1,size:1,read:async()=>new Uint8Array([Number(id)])}),{process:async bytes=>{order.push(bytes[0]);if(bytes[0]===1){started.resolve();await gate.promise}return {...dimensions,bytes:new Uint8Array(1)}}});t.after(()=>service.dispose());const signal=()=>new AbortController().signal;
 const first=service.get('1',32,'first',true,signal(),false,()=>queued.push(1));await started.promise;
 const thumb=service.get('2',32,'thumb',false,signal(),true),neighbour=service.get('3',32,'neighbour',false,signal()),foreground=service.get('4',32,'foreground',true,signal());await tick();assert.deepEqual(queued,[1]);gate.resolve();await Promise.all([first,thumb,neighbour,foreground]);assert.deepEqual(order,[1,4,3,2]);
});
