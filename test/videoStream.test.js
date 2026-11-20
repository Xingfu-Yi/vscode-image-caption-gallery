const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(setImmediate);
function setup(t,delay=false,startTime=0,byteLength=1){
 const dom=new JSDOM('<video controls></video>',{runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,v=w.document.querySelector('video'),requests=[],pending=[];let paused=true;
 Object.defineProperty(v,'paused',{get:()=>paused});v.load=()=>{};v.play=async()=>{paused=false;v.dispatchEvent(new w.Event('play'));};v.pause=()=>{paused=true;v.dispatchEvent(new w.Event('pause'));};
 let media,revoke=0;
 class Media extends w.EventTarget{constructor(){super();media=this;this.readyState='closed';queueMicrotask(()=>{this.readyState='open';this.dispatchEvent(new w.Event('sourceopen'));});}static isTypeSupported(){return true;}addSourceBuffer(){return this.buffer=new Buffer();}removeSourceBuffer(){}endOfStream(){this.readyState='ended';}}
 class Buffer extends w.EventTarget{constructor(){super();this.ranges=[];this.offset=0;this.appends=[];}get buffered(){const values=this.ranges;return {length:values.length,start:i=>values[i][0],end:i=>values[i][1]};}set timestampOffset(x){this.offset=x;if(media.readyState==='ended')media.readyState='open';}get timestampOffset(){return this.offset;}abort(){}appendBuffer(){this.ranges.push([this.offset,this.offset+4]);this.appends.push(this.offset);queueMicrotask(()=>this.dispatchEvent(new w.Event('updateend')));}remove(a,b){this.ranges=this.ranges.filter(x=>x[0]>=b||x[1]<=a);queueMicrotask(()=>this.dispatchEvent(new w.Event('updateend')));}}
 w.MediaSource=Media;w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>revoke++;
 const response=()=>({ok:true,headers:{get:()=> 'prepare;dur=100, queue;dur=0, encode;dur=98, cache;dur=2;desc="miss"'},arrayBuffer:async()=>new ArrayBuffer(byteLength)});
 w.fetch=(url,{signal})=>{requests.push(url);if(!delay)return Promise.resolve(response());return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new w.DOMException('Aborted','AbortError')),{once:true});pending.push(()=>resolve(response()));});};
 w.eval(fs.readFileSync(path.join(__dirname,'../media/videoStream.js'),'utf8'));const errors=[],diagnostics=[];
 const stream=new w.GalleryVideoStream(v,{duration:120,startTime,segmentSeconds:4,mime:'video/webm; codecs="vp8,vorbis"',base:'http://127.0.0.1:9000/prefix/segment/?tunnel=private'},x=>errors.push(x),()=>{},x=>diagnostics.push(x));t.after(()=>stream.dispose());stream.start();
 return {w,v,requests,pending,stream,errors,diagnostics,media:()=>media,revoke:()=>revoke,seek:time=>{v.currentTime=time;v.dispatchEvent(new w.Event('seeking'));}};
}
test('paused detail fetches only its first fragment, preserves full duration and seeks directly to a distant fragment',async t=>{
 const ui=setup(t);await tick();assert.equal(ui.requests.length,1);assert.match(ui.requests[0],/segment\/0.webm\?tunnel=private$/);assert.equal(ui.media().duration,120);
 ui.seek(97);await tick();assert.equal(ui.requests.length,2);assert.match(ui.requests[1],/segment\/24.webm/);assert.deepEqual(ui.media().buffer.appends,[0,96]);assert.equal(ui.media().buffer.ranges.length,1);assert.equal(ui.errors.length,0);
});
test('playback buffers nearby clips and evicts distant data; post-end seeking reopens MediaSource',async t=>{
 const ui=setup(t);await tick();await ui.v.play();await tick();assert.equal(ui.requests.length,6);
 ui.seek(40.1);await tick();assert.deepEqual(ui.requests.slice(-6).map(x=>new URL(x).pathname.split('/').pop()),['10.webm','11.webm','12.webm','13.webm','14.webm','15.webm']);assert.ok(ui.media().buffer.ranges.every(x=>x[0]>=32));
 ui.seek(116);await tick();assert.equal(ui.media().readyState,'ended','finish the finite stream without waiting for timeupdate at the last audio sample');
 ui.v.pause();ui.seek(0);await tick();assert.equal(ui.media().readyState,'open');assert.equal(ui.media().buffer.appends.at(-1),0);
});
test('rapid seek aborts stale fetches; hide/resume and disposal release in-flight work and object URLs',async t=>{
 const ui=setup(t,true);await tick();ui.seek(29);await tick();assert.equal(ui.requests.length,2);ui.pending[1]();await tick();assert.deepEqual(ui.media().buffer.appends,[28]);
 ui.seek(70);await tick();ui.stream.suspend();ui.stream.resume();await tick();assert.match(ui.requests.at(-1),/17.webm/);ui.stream.dispose();await tick();assert.ok(ui.revoke()>=1);assert.equal(ui.errors.length,0);
});

test('a quality restart fetches the saved fragment first, without generating earlier fragments',async t=>{
 const ui=setup(t,false,97);await tick();assert.equal(ui.v.currentTime,97);assert.equal(ui.requests.length,1);assert.match(ui.requests[0],/segment\/24.webm/);assert.deepEqual(ui.media().buffer.appends,[96]);assert.equal(ui.errors.length,0);
});

test('aborted or closed SourceBuffer updates reject instead of marking a fragment loaded',async t=>{
 const ui=setup(t);await tick();const buffer=ui.media().buffer;
 const aborted=ui.stream.update(()=>buffer.dispatchEvent(new ui.w.Event('abort')));await assert.rejects(aborted,{name:'AbortError'});
 const closed=ui.stream.update(()=>{ui.media().readyState='closed';ui.media().dispatchEvent(new ui.w.Event('sourceclose'))});await assert.rejects(closed,{name:'AbortError'});assert.equal(ui.stream.operations.size,0);
});

test('disposing during append rejects the pending operation and removes its listeners',async t=>{
 const ui=setup(t);await tick();const pending=ui.stream.update(()=>{});const rejected=assert.rejects(pending,{name:'AbortError'});ui.stream.dispose();await rejected;assert.equal(ui.stream.operations.size,0);
});

test('fragment network timeouts fail explicitly instead of retrying the same aborted request forever',async t=>{
 const ui=setup(t,true),timers=[],set=ui.w.setTimeout.bind(ui.w);ui.w.setTimeout=(callback,ms,...args)=>{if(ms===30000)timers.push(callback);return set(callback,ms,...args)};await tick();assert.equal(timers.length,1);timers[0]();await tick();assert.equal(ui.requests.length,1);assert.match(ui.errors[0],/Fragment 0.*timed out.*SSH/);
});

test('empty successful responses fail once instead of marking unplayable data loaded or restarting requests',async t=>{
 const ui=setup(t,false,0,0);await tick();assert.match(ui.errors[0],/Fragment 0.*empty/);assert.deepEqual([...ui.stream.loaded],[]);
 await ui.v.play();ui.v.dispatchEvent(new ui.w.Event('timeupdate'));ui.v.dispatchEvent(new ui.w.Event('waiting'));await tick();assert.equal(ui.errors.length,1);assert.equal(ui.requests.length,1);assert.equal(ui.stream.requests.size,0);
});

test('two in-flight fetches overlap host encoding but out-of-order responses append serially; pause cancels lookahead',async t=>{
 const ui=setup(t,true);await tick();await ui.v.play();await tick();
 assert.equal(ui.requests.length,2,'request the next fragment before the first response arrives');
 ui.pending[1]();await tick();assert.deepEqual(ui.media().buffer.appends,[],'later response waits for the first fragment');
 ui.pending[0]();await tick();assert.deepEqual(ui.media().buffer.appends,[0,4]);
 assert.equal(ui.requests.length,4);assert.equal(ui.stream.requests.size,2,'bounded lookahead, not a full-video download');
 ui.v.pause();await tick();assert.equal(ui.stream.requests.size,0);assert.deepEqual(ui.media().buffer.appends,[0,4]);assert.equal(ui.errors.length,0);
 const fetched=ui.diagnostics.filter(x=>x.stage==='fetched');assert.equal(fetched.length,2);assert.match(fetched[0].serverTiming,/encode;dur=98/);
});

test('seek discards both obsolete pipeline requests and appends only the new location',async t=>{
 const ui=setup(t,true);await tick();await ui.v.play();await tick();ui.seek(97);await tick();
 assert.deepEqual(ui.requests.slice(2).map(x=>new URL(x).pathname.split('/').pop()),['24.webm','25.webm']);
 ui.pending[0]();ui.pending[1]();ui.pending[3]();await tick();assert.deepEqual(ui.media().buffer.appends,[]);
 ui.pending[2]();await tick();assert.deepEqual(ui.media().buffer.appends,[96,100]);assert.equal(ui.errors.length,0);
 ui.stream.dispose();await tick();assert.equal(ui.stream.requests.size,0);
});

test('short backward seek gives the missing playing fragment priority over retained later requests',async t=>{
 const ui=setup(t,true,100);await tick();await ui.v.play();await tick();
 assert.match(ui.requests[0],/25.webm/);assert.match(ui.requests[1],/26.webm/);
 ui.seek(88);await tick();assert.deepEqual(ui.requests.slice(-2).map(x=>new URL(x).pathname.split('/').pop()),['22.webm','23.webm']);
 ui.pending[2]();await tick();assert.deepEqual(ui.media().buffer.appends,[88]);assert.equal(ui.errors.length,0);
});

test('lookahead follows playback speed with a finite ceiling and reports starvation separately from fragment errors',async t=>{
 const ui=setup(t);await tick();ui.v.playbackRate=2;await ui.v.play();await tick();assert.equal(ui.requests.length,11);
 ui.v.playbackRate=4;ui.v.dispatchEvent(new ui.w.Event('ratechange'));await tick();assert.equal(ui.requests.length,13,'48 media seconds maximum');
 ui.v.dispatchEvent(new ui.w.Event('waiting'));await tick();const diagnostic=ui.diagnostics.find(x=>x.stage==='waiting');assert.equal(diagnostic.rate,4);assert.equal(diagnostic.time,0);assert.equal(ui.errors.length,0);
});

test('encoded byte budget stops speculative appends and advancing playback releases history without duplicate requests',async t=>{
 const ui=setup(t);ui.stream.maxBufferBytes=3;await tick();await ui.v.play();await tick();
 assert.deepEqual(ui.media().buffer.appends,[0,4,8]);assert.ok(ui.stream.bufferBytes()<=3);assert.ok(ui.stream.requests.size<=2);
 ui.v.currentTime=4.1;ui.v.dispatchEvent(new ui.w.Event('timeupdate'));await tick();assert.ok(ui.media().buffer.appends.includes(12));assert.ok(ui.stream.bufferBytes()<=3);
 assert.equal(new Set(ui.requests).size,ui.requests.length,'ready fragments are reused after budget pressure');assert.equal(ui.errors.length,0);
});
