const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {VideoService,needsVideoConversion,videoPreviewDimensions,normalizeVideoQuality}=require('../dist/videoService');
const fixture=path.join(__dirname,'fixtures/streaming-timeline.mp4');
const available=spawnSync('ffmpeg',['-version']).status===0;
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function setup(t,file=fixture,options={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-stream-test-'));
 const service=new VideoService(directory,async()=>{const stat=await fs.stat(file);return{filePath:file,size:stat.size,mtime:stat.mtimeMs};},options);
 t.after(async()=>{service.dispose();await service.pruning;await fs.rm(directory,{recursive:true,force:true});});
 return {service,base:await service.startServer(),directory};
}
const signal=()=>new AbortController().signal;
const url=(base,info,endpoint)=>`${base}/v1/${info.token}/${endpoint}`;

test('codecs distinguish native H264/MP3 and WebM from AAC or incompatible video',()=>{
 const probe=(video,audio,pix_fmt='yuv420p')=>({streams:[{codec_type:'video',codec_name:video,pix_fmt},...(audio?[{codec_type:'audio',codec_name:audio}]:[])]});
 assert.equal(needsVideoConversion('clip.mp4',probe('h264','mp3')),false);
 assert.equal(needsVideoConversion('clip.mp4',probe('h264','aac')),true);
 assert.equal(needsVideoConversion('clip.webm',probe('vp9','opus')),false);
 assert.equal(needsVideoConversion('clip.mov',probe('h264','mp3')),true);
 assert.equal(needsVideoConversion('clip.mp4',probe('h264',null,'yuv444p')),true);
});

test('private original endpoint supports exact byte ranges, suffixes and HEAD without downloading the whole file',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-range-fixture-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'large.mp4'),handle=await fs.open(file,'w');await handle.truncate(32*1024*1024);await handle.write(Buffer.from('requested-range'),0,15,1024*1024);await handle.close();
 const {service,base}=await setup(t,file);const info=await service.get('file','one',signal(),{mode:'native',ffmpegPath:'missing'});const source=url(base,info,'original');
 let res=await fetch(source,{headers:{Range:'bytes=1048576-1048590'}});
 assert.equal(res.status,206);assert.equal(res.headers.get('content-range'),'bytes 1048576-1048590/33554432');assert.equal(await res.text(),'requested-range');
 assert.equal(service.stats.rangeBytes,15);assert.equal(service.stats.segments,0);
 res=await fetch(source,{method:'HEAD',headers:{Range:'bytes=0-'}});assert.equal(res.status,206);assert.equal(Number(res.headers.get('content-length')),4*1024*1024);assert.equal(service.stats.rangeBytes,15);
 res=await fetch(source,{headers:{Range:'bytes=-16'}});assert.equal((await res.arrayBuffer()).byteLength,16);
 for(const range of ['bytes=999999999-','bytes=2-1','bytes=0-1,3-4','bytes=-0','bytes=-9999999999999999999999999999']){res=await fetch(source,{headers:{Range:range}});assert.equal(res.status,416);}
 assert.equal((await fetch(base+'/v1/'+'0'.repeat(64)+'/original')).status,404);
 assert.equal((await fetch(source,{method:'POST'})).status,405);
 service.release('one');assert.equal((await fetch(source)).status,404);
});

test('opening AAC video only probes metadata; posters and far-away fragments are independent, cached and bounded', {skip:!available},async t=>{
 const {service,base,directory}=await setup(t);const before=await fs.readFile(fixture);
 const info=await service.get('file','one',signal(),{mode:'auto',ffmpegPath:'ffmpeg',maxHeight:720});
 assert.equal(info.converted,true);assert.match(info.stream.mime,/vp8,vorbis/);assert.equal(info.duration,40);assert.equal(service.stats.segments,0);
 const poster=await fetch(url(base,info,'poster'));assert.equal(poster.status,200);assert.equal(poster.headers.get('content-type'),'image/jpeg');await poster.arrayBuffer();
 assert.equal(service.stats.posters,1);assert.equal(service.stats.segments,0);
 const first=await fetch(url(base,info,'segment/0.webm'));const firstBytes=Buffer.from(await first.arrayBuffer());assert.equal(first.status,200);
 const far=await fetch(url(base,info,'segment/8.webm'));const farBytes=Buffer.from(await far.arrayBuffer());assert.equal(far.status,200);
 assert.equal(service.stats.segments,2,'seeking 32 seconds ahead must not process the intervening segments');assert.notDeepEqual(firstBytes,farBytes);
 const output=path.join(directory,'probe.webm');await fs.writeFile(output,farBytes);
 const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,height','-of','json',output],{encoding:'utf8'}).stdout);
 assert.ok(Number(probe.format.duration)<=4.1);assert.ok(probe.streams.some(x=>x.codec_name==='vorbis'));assert.ok(probe.streams.find(x=>x.codec_name==='vp8').height<=720);
 const again=await fetch(url(base,info,'segment/8.webm'));assert.deepEqual(Buffer.from(await again.arrayBuffer()),farBytes);assert.equal(service.stats.segments,2);
 assert.equal((await fetch(url(base,info,'segment/10.webm'))).status,416);
 assert.deepEqual(await fs.readFile(fixture),before);
 assert.ok((await fs.readdir(path.join(directory,'stream-v1'))).every(x=>/\.(webm|jpg)$/.test(x)),'no full MP4 compatibility copy');
});

test('cached segments survive restart and source/settings changes create independent entries', {skip:!available},async t=>{
 const {service,base,directory}=await setup(t);const settings={mode:'auto',ffmpegPath:'ffmpeg',maxHeight:720};
 const info=await service.get('file','one',signal(),settings);const bytes=Buffer.from(await(await fetch(url(base,info,'segment/0.webm'))).arrayBuffer());service.dispose();
 const stat=await fs.stat(fixture),restored=new VideoService(directory,async()=>({filePath:fixture,size:stat.size,mtime:stat.mtimeMs}));t.after(()=>restored.dispose());
 const nextBase=await restored.startServer(),next=await restored.get('file','two',signal(),settings);
 assert.deepEqual(Buffer.from(await(await fetch(url(nextBase,next,'segment/0.webm'))).arrayBuffer()),bytes);assert.equal(restored.stats.segments,0);
 const changed=await restored.get('file','three',signal(),{...settings,maxHeight:1080});await(await fetch(url(nextBase,changed,'segment/0.webm'))).arrayBuffer();assert.equal(restored.stats.segments,1);
 const controller=new AbortController(),revoked=await restored.get('file','revoked',controller.signal,settings);controller.abort();assert.equal((await fetch(url(nextBase,revoked,'original'))).status,404);
});

test('missing tools allow native containers and give an error for forced compatibility',async t=>{
 const {service,base}=await setup(t);const settings={mode:'auto',ffmpegPath:'/missing/gallery-tools/ffmpeg'};
 const info=await service.get('file','one',signal(),settings);assert.equal(info.converted,false);assert.match(info.note,/unavailable/);
 const native=await fetch(url(base,info,'original'),{headers:{Range:'bytes=0-31'}});assert.equal(native.status,206);assert.equal((await native.arrayBuffer()).byteLength,32);
 await assert.rejects(service.get('file','forced',signal(),settings,true),/ENOENT|FFmpeg/);
});

test('session release cancels an in-flight request and never exposes arbitrary source paths', {skip:!available},async t=>{
 const {service,base}=await setup(t);const info=await service.get('file','one',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});
 const pending=fetch(url(base,info,'segment/0.webm')).then(x=>x.arrayBuffer());const rejected=assert.rejects(pending);
 await tick();service.release('one');await rejected;
 for(let i=0;i<100&&service.running.size;i++){await tick();}
 assert.equal(service.running.size,0);assert.equal((await fetch(base+'/etc/passwd')).status,404);
 const fresh=await service.get('file','fresh',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});assert.equal((await fetch(url(base,fresh,'segment/0.webm'))).status,200);
});


test('visible posters are leased across LRU eviction and become evictable when released', {skip:!available}, async t => {
 const {service,directory}=await setup(t,fixture,{maxBytes:1});
 const file=await service.poster('file','visible',signal(),'ffmpeg');await service.pruning;
 assert.ok((await fs.stat(file)).size>1);
 const same=await service.poster('file','another',signal(),'ffmpeg');assert.equal(same,file);assert.equal(service.stats.posters,1);
 service.release('visible');await service.pruning;assert.ok((await fs.stat(file)).isFile());
 service.release('another');await service.pruning;await assert.rejects(fs.stat(file),/ENOENT/);
 assert.equal((await fs.readdir(path.join(directory,'stream-v1'))).length,0);
});

test('posters deliver a bounded inline JPEG, deduplicate requests and hit disk cache before tool detection after restart', {skip:!available}, async t=>{
 const {service,directory}=await setup(t);const [a,b]=await Promise.all(['one','two'].map(owner=>service.posterPreview('file',owner,signal(),'ffmpeg')));
 assert.match(a.source,/^data:image\/jpeg;base64,/);assert.equal(a.source,b.source);assert.equal(service.stats.posters,1);
 const bytes=Buffer.from(a.source.split(',')[1],'base64');assert.deepEqual(bytes,await fs.readFile(a.file));assert.ok(bytes.length<2*1024*1024);assert.equal(a.timing.bytes,bytes.length);assert.equal(a.timing.cacheHit,false);assert.ok(a.timing.totalMs>=0);assert.ok(a.timing.processMs>0);assert.equal(service.stats.segments,0);
 service.dispose();await service.pruning;const stat=await fs.stat(fixture);
 const restored=new VideoService(directory,async()=>({filePath:fixture,size:stat.size,mtime:stat.mtimeMs}));t.after(()=>restored.dispose());
 restored.tools=async()=>{throw Error('Cached posters must not start encoder detection')};
 const warm=await restored.posterPreview('file','warm',signal(),'ffmpeg');assert.equal(warm.source,a.source);assert.equal(warm.timing.cacheHit,true);assert.equal(warm.timing.processMs,0);assert.equal(restored.stats.posterCacheHits,1);assert.equal(restored.stats.posters,0);
});

test('poster extraction runs while the playback lane is occupied and remains independently bounded', {skip:!available}, async t=>{
 const {service,base}=await setup(t,fixture,{maxJobs:1,maxPosterJobs:1});const info=await service.get('file','video',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});
 const run=service.run.bind(service);let release,entered;const running=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);let released=false;
 service.run=async(executable,args,...rest)=>{if(args.includes('webm')){entered();await blocked;}return run(executable,args,...rest)};
 const video=fetch(url(base,info,'segment/0.webm'));await running;
 try{
  const first=await service.posterPreview('file','poster',signal(),'ffmpeg');assert.match(first.source,/^data:image\/jpeg/);assert.equal(released,false,'poster must finish before the blocked playback job');
  assert.equal(service.stats.posters,1);
 }finally{released=true;release();}
 const response=await video;assert.equal(response.status,200);await response.arrayBuffer();
});

test('limited-probe first-frame extraction falls back once without caching an empty image', {skip:!available},async t=>{
 const {service}=await setup(t);const run=service.run.bind(service);let fast=0,normal=0;
 service.run=(exe,args,...rest)=>{if(args.includes('image2pipe')){if(args.includes('-probesize')){fast++;return Promise.resolve(Buffer.alloc(0));}normal++;}return run(exe,args,...rest)};
 const poster=await service.posterPreview('file','one',signal(),'ffmpeg');assert.match(poster.source,/^data:image\/jpeg/);assert.equal(fast,1);assert.equal(normal,1);
 await service.posterPreview('file','two',signal(),'ffmpeg');assert.equal(normal,1);assert.equal(service.stats.posterCacheHits,1);
});

test('changed source fingerprints regenerate posters and damaged inputs do not poison later jobs', {skip:!available},async t=>{
 const own=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-poster-source-'));t.after(()=>fs.rm(own,{recursive:true,force:true}));const file=path.join(own,'clip.mp4');await fs.copyFile(fixture,file);
 const {service}=await setup(t,file);const initial=await service.posterPreview('file','one',signal(),'ffmpeg');
 const future=new Date(Date.now()+2000);await fs.utimes(file,future,future);const updated=await service.posterPreview('file','two',signal(),'ffmpeg');assert.notEqual(initial.file,updated.file);assert.equal(service.stats.posters,2);
 await fs.writeFile(file,'damaged');await assert.rejects(service.posterPreview('file','damaged',signal(),'ffmpeg'),/Video request failed/);assert.equal(service.stats.posterFailures,1);
 await fs.copyFile(fixture,file);const fresh=await service.posterPreview('file','fresh',signal(),'ffmpeg');assert.match(fresh.source,/^data:image\/jpeg/);
});

test('quality geometry caps landscape, portrait, square and wide videos without upscaling',()=>{
 const examples=[
  [3840,2160,1440,2560,1440],[2160,3840,1440,1440,2560],[1920,1080,1440,1920,1080],
  [1280,720,1440,1280,720],[2560,1440,1440,2560,1440],[3840,2160,1080,1920,1080],
  [3840,2160,720,1280,720],[2160,3840,720,720,1280],[2048,2048,1440,1440,1440],
  [4000,1000,1440,2560,640],[3840,2160,0,3840,2160]
 ];
 for(const [w,h,cap,width,height] of examples){const result=videoPreviewDimensions(w,h,cap);assert.deepEqual(result,{width,height});assert.ok(result.width<=w&&result.height<=h);assert.ok(Math.abs(result.width/result.height-w/h)<0.002);}
 for(const cap of [0,720,1080,1440])assert.equal(normalizeVideoQuality(cap),cap);
 assert.equal(normalizeVideoQuality(undefined),1440);assert.equal(normalizeVideoQuality(480),720);assert.equal(normalizeVideoQuality(2160),1440);
});

test('default 2K also scales codec-compatible originals; original choice bypasses conversion and sources stay intact',{skip:!available},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-quality-source-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'4k.mp4');const make=spawnSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=3840x2160:r=2:d=0.5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2',file],{encoding:'utf8'});assert.equal(make.status,0,make.stderr);
 const {service,base}=await setup(t,file),before=await fs.stat(file);
 for(const [cap,width,height] of [[undefined,2560,1440],[1080,1920,1080],[720,1280,720]]){
  const info=await service.get('file','quality',signal(),{mode:'auto',ffmpegPath:'ffmpeg',maxHeight:cap});assert.equal(info.converted,true);assert.equal(info.width,3840);assert.equal(info.height,2160);assert.equal(info.previewWidth,width);assert.equal(info.previewHeight,height);
  const response=await fetch(url(base,info,'segment/0.webm'));assert.equal(response.status,200);const output=path.join(directory,'result.webm');await fs.writeFile(output,Buffer.from(await response.arrayBuffer()));
  const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',output],{encoding:'utf8'}).stdout);assert.deepEqual(probe.streams[0],{width,height});
 }
 const rotatedFile=path.join(directory,'portrait.mp4');let rotate=spawnSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-display_rotation','90','-i',file,'-c','copy',rotatedFile],{encoding:'utf8'});if(rotate.status!==0){rotate=spawnSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',file,'-c','copy','-metadata:s:v:0','rotate=90',rotatedFile],{encoding:'utf8'});}assert.equal(rotate.status,0,rotate.stderr);
 const portrait=await setup(t,rotatedFile),rotated=await portrait.service.get('portrait','portrait',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});assert.equal(rotated.width,2160);assert.equal(rotated.height,3840);assert.equal(rotated.previewWidth,1440);assert.equal(rotated.previewHeight,2560);
 const portraitResponse=await fetch(url(portrait.base,rotated,'segment/0.webm'));assert.equal(portraitResponse.status,200);const portraitOutput=path.join(directory,'portrait.webm');await fs.writeFile(portraitOutput,Buffer.from(await portraitResponse.arrayBuffer()));const portraitProbe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',portraitOutput],{encoding:'utf8'}).stdout);assert.deepEqual(portraitProbe.streams[0],{width:1440,height:2560});
 const original=await service.get('file','original',signal(),{mode:'auto',ffmpegPath:'ffmpeg',maxHeight:0});assert.equal(original.converted,false);assert.equal(original.previewWidth,3840);assert.equal(original.stream,undefined);
 const native=await service.get('file','native',signal(),{mode:'native',ffmpegPath:'ffmpeg',maxHeight:720});assert.equal(native.converted,false);
 assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
 const small=await setup(t,path.join(__dirname,'fixtures/video-compatible.mp4'));const info=await small.service.get('small','small',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});assert.equal(info.converted,false);assert.equal(info.previewWidth,info.width);
});
