const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { PreviewExecutor, previewConcurrency } = require('../dist/previewExecutor');
const { initializeProcessor } = require('../dist/previewProcessor');

test('automatic and manual decoder counts respect CPU and memory budgets', () => {
  const gib=1024**3;
  assert.equal(previewConcurrency(0,{cpus:16,total:32*gib,free:8*gib}),4);
  assert.equal(previewConcurrency(0,{cpus:8,total:8*gib,free:gib}),1);
  assert.equal(previewConcurrency(0,{cpus:1,total:gib,free:0}),1);
  assert.equal(previewConcurrency(8,{cpus:2,total:32*gib,free:8*gib}),2);
  assert.equal(previewConcurrency(8,{cpus:16,total:2*gib,free:0}),2);
});

async function fixture(t, processScript) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-executor-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const file of ['previewExecutor.js','previewWorker.js','previewProcessor.js','previewGeometry.js','rawEmbeddedPreview.js','imageFormats.js']) { await fs.copyFile(path.join(__dirname,'../dist',file),path.join(directory,file)); }
  await fs.symlink(path.join(__dirname,'../dist/vendor'),path.join(directory,'vendor'));
  if(processScript) { await fs.writeFile(path.join(directory,'previewProcess.js'),processScript); }
  return require(path.join(directory,'previewExecutor.js')).PreviewExecutor;
}
const input={bytes:new Uint8Array([1]),resolution:32,filename:'fixture.jpg',thumbnail:false};

test('separate child PIDs decode concurrently, reuse processes and preserve input bytes', async (t) => {
  const m=await initializeProcessor();
  const bytes=m.ImageMagick.read(m.MagickColors.Blue,96,64,im=>im.write(m.MagickFormat.Png,b=>Uint8Array.from(b)));
  const copy=Uint8Array.from(bytes), executor=new PreviewExecutor();t.after(()=>executor.dispose());
  const results=await Promise.all([0,1].map(slot=>executor.run(slot,{...input,bytes},new AbortController().signal)));
  assert.ok(results.every(x=>x.engine==='process'&&x.pid!==process.pid));
  assert.notEqual(results[0].pid,results[1].pid);
  const reused=await executor.run(0,{...input,bytes},new AbortController().signal);
  assert.equal(reused.pid,results[0].pid);
  assert.deepEqual(bytes,copy);assert.ok(reused.result.width*reused.result.height<=32**2);
});

test('process startup failure falls back to a reusable thread decoder', async (t) => {
  const Executor=await fixture(t),executor=new Executor();t.after(()=>executor.dispose());
  const m=await initializeProcessor();const bytes=m.ImageMagick.read(m.MagickColors.Red,96,64,im=>im.write(m.MagickFormat.Jpeg,b=>Uint8Array.from(b)));
  const result=await executor.run(0,{...input,bytes},new AbortController().signal);
  assert.equal(result.engine,'thread');assert.equal(result.pid,process.pid);
  assert.ok(result.result.bytes.length>0);
});

test('cancels active processes promptly, isolates crashes and shuts down abandoned children', async (t) => {
  const Executor=await fixture(t,`process.on('disconnect',()=>process.exit());process.send({ready:true});process.on('message',m=>{if(m.filename==='crash')process.exit(7);if(m.filename==='good')process.send({pid:process.pid,result:{width:1,height:1,originalWidth:1,originalHeight:1}});});`);
  const executor=new Executor('process',1000);t.after(()=>executor.dispose());
  const controller=new AbortController();
  const active=executor.run(0,input,controller.signal);controller.abort();
  await assert.rejects(active,{name:'AbortError'});
  await assert.rejects(executor.run(0,{...input,filename:'crash'},new AbortController().signal),/exited/);
  const good=await executor.run(0,{...input,filename:'good'},new AbortController().signal);assert.equal(good.engine,'process');
  const pending=executor.run(0,input,new AbortController().signal);
  await new Promise(setImmediate);executor.dispose();
  await assert.rejects(pending,/exited|cancelled/);
});

test('idle decoder processes exit and later requests recreate them', async (t) => {
  const Executor=await fixture(t,`process.on('disconnect',()=>process.exit());process.send({ready:true});process.on('message',()=>process.send({pid:process.pid,result:{width:1,height:1,originalWidth:1,originalHeight:1}}));`);
  const executor=new Executor('process',1000,10);t.after(()=>executor.dispose());
  const first=await executor.run(0,input,new AbortController().signal);
  await new Promise(resolve=>setTimeout(resolve,40));
  const second=await executor.run(0,input,new AbortController().signal);assert.notEqual(second.pid,first.pid);
});
