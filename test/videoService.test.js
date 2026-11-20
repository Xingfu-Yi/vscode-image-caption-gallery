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
function serverTiming(response,cacheHit){
 const header=response.headers.get('server-timing');assert.ok(header,'media responses report host preparation timings');
 const metrics=Object.fromEntries(header.split(',').map(part=>{const match=/^\s*(\w+);dur=([\d.]+)/.exec(part);assert.ok(match,part);return[match[1],Number(match[2])];}));
 for(const name of ['prepare','queue','encode','cache'])assert.ok(Number.isFinite(metrics[name])&&metrics[name]>=0,name);
 assert.match(header,new RegExp(`cache;dur=[\\d.]+;desc="${cacheHit?'hit':'miss'}"`));
 assert.match(response.headers.get('access-control-expose-headers'),/Server-Timing/i);
 if(cacheHit){assert.equal(metrics.queue,0);assert.equal(metrics.encode,0);}
 return metrics;
}

test('rotated WebM metadata produces upright compatibility fragments in Webview and browser playback', {skip:!available},async t=>{
 const rotated=path.join(__dirname,'fixtures/rotation-webm.webm');
 const original=await fs.readFile(rotated);
 const {service,base,directory}=await setup(t,rotated);
 const decode=(file,filter)=>{
  const p=spawnSync('ffmpeg',['-nostdin','-v','error','-noautorotate','-i',file,'-map','0:v:0','-frames:v','1','-an','-vf',filter,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.equal(p.status,0,p.stderr.toString());return p.stdout;
 };
 const expected=decode(rotated,'transpose=clock,scale=48:64');
 for(const target of ['webview','browser']){
  const info=await service.get('rotated',target,signal(),{mode:'auto',target,ffmpegPath:'ffmpeg',maxHeight:0});
  assert.equal(info.converted,true);assert.equal(info.width,240);assert.equal(info.height,320);
  const suffix=target==='browser'?'ts':'webm';
  const res=await fetch(url(base,info,'segment/0.'+suffix));assert.equal(res.status,200);
  const output=path.join(directory,'upright-'+target+'.'+suffix);await fs.writeFile(output,Buffer.from(await res.arrayBuffer()));
  const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}).stdout);
  const video=probe.streams.find(s=>s.codec_type==='video');assert.equal(video.width,240);assert.equal(video.height,320);
  assert.equal(Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation??0)%360,0);
  const actual=decode(output,'scale=48:64');assert.equal(actual.length,expected.length);
  const error=actual.reduce((sum,value,i)=>sum+Math.abs(value-expected[i]),0)/actual.length;
  assert.ok(error<12,`compatibility pixels must rotate once; mean RGB difference=${error}`);
 }
 assert.deepEqual(await fs.readFile(rotated),original);
});

test('codecs distinguish native H264/MP3 and WebM from AAC or incompatible video',()=>{
 const probe=(video,audio,pix_fmt='yuv420p')=>({streams:[{codec_type:'video',codec_name:video,pix_fmt},...(audio?[{codec_type:'audio',codec_name:audio}]:[])]});
 assert.equal(needsVideoConversion('clip.mp4',probe('h264','mp3')),false);
 assert.equal(needsVideoConversion('clip.mp4',probe('h264','aac')),true);
 assert.equal(needsVideoConversion('clip.webm',probe('vp9','opus')),false);
 assert.equal(needsVideoConversion('clip.mov',probe('h264','mp3')),true);
 assert.equal(needsVideoConversion('clip.mp4',probe('h264',null,'yuv444p')),true);
});

test('WebM display rotations always use compatibility pixels while ordinary native WebM stays direct',()=>{
 for(const angle of [-90,90,180,270]){
  const probe={streams:[{codec_type:'video',codec_name:'vp9',pix_fmt:'yuv420p',side_data_list:[{rotation:angle}]},{codec_type:'audio',codec_name:'opus'}]};
  assert.equal(needsVideoConversion('portrait.webm',probe),true);
  assert.equal(needsVideoConversion('portrait.webm',probe,true),true);
 }
 const probe={streams:[{codec_type:'video',codec_name:'vp9',side_data_list:[{rotation:360}]}]};
 assert.equal(needsVideoConversion('normal.webm',probe),false);
 assert.equal(needsVideoConversion('legacy.webm',{streams:[{codec_type:'video',codec_name:'vp8',tags:{rotate:'90'}}]}),true);
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
 const poster=await fetch(url(base,info,'poster'));assert.equal(poster.status,200);assert.equal(poster.headers.get('content-type'),'image/jpeg');serverTiming(poster,false);await poster.arrayBuffer();
 assert.equal(service.stats.posters,1);assert.equal(service.stats.segments,0);
 const first=await fetch(url(base,info,'segment/0.webm'));const firstBytes=Buffer.from(await first.arrayBuffer());assert.equal(first.status,200);assert.ok(serverTiming(first,false).encode>0);
 const far=await fetch(url(base,info,'segment/8.webm'));const farBytes=Buffer.from(await far.arrayBuffer());assert.equal(far.status,200);
 assert.equal(service.stats.segments,2,'seeking 32 seconds ahead must not process the intervening segments');assert.notDeepEqual(firstBytes,farBytes);
 const output=path.join(directory,'probe.webm');await fs.writeFile(output,farBytes);
 const probe=JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,height','-of','json',output],{encoding:'utf8'}).stdout);
 assert.ok(Number(probe.format.duration)<=4.1);assert.ok(probe.streams.some(x=>x.codec_name==='vorbis'));assert.ok(probe.streams.find(x=>x.codec_name==='vp8').height<=720);
 const again=await fetch(url(base,info,'segment/8.webm'));assert.deepEqual(Buffer.from(await again.arrayBuffer()),farBytes);assert.equal(service.stats.segments,2);serverTiming(again,true);
 assert.equal((await fetch(url(base,info,'segment/10.webm'))).status,416);
 assert.deepEqual(await fs.readFile(fixture),before);
 assert.ok((await fs.readdir(path.join(directory,'stream-v1'))).every(x=>/\.(webm|jpg)$/.test(x)),'no full MP4 compatibility copy');
});

test('compatibility clips cap input decoder threads and discard surplus frames before transforms in both players',async t=>{
 const {service,base}=await setup(t),commands=[];
 service.run=async(executable,args)=>{
  if(args.includes('-encoders'))return Buffer.from(' V..... libvpx test\n V..... libx264 test\n A..... libvorbis test\n A..... aac test\n');
  if(args.includes('-show_entries'))return Buffer.from(JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',width:3840,height:2160},{codec_type:'audio',codec_name:'aac'}],format:{duration:'40'}}));
  commands.push(args);return Buffer.from('test fragment');
 };
 for(const target of ['webview','browser']){
  const info=await service.get('file',target,signal(),{mode:'auto',target,ffmpegPath:'test-ffmpeg',maxHeight:1080});
  const response=await fetch(url(base,info,`segment/0.${target==='browser'?'ts':'webm'}`));assert.equal(response.status,200);await response.arrayBuffer();
 }
 assert.equal(commands.length,2);
 for(const args of commands){
  const input=args.indexOf('-i'),threads=args.indexOf('-threads'),filter=args[args.indexOf('-vf')+1];
  assert.ok(threads<input,'input decoder cap must precede the input');
  assert.equal(Number(args[threads+1]),Math.min(4,Math.max(1,os.availableParallelism())));
  assert.equal(args[args.indexOf('-threads',input)+1],'2','preserve the output encoder cap');
  assert.match(filter,/^fps=30,.*scale=1920:1080/,'reduce frames before expensive scaling');
  assert.equal(args[args.indexOf('-r')+1],'30','preserve the existing output rate');
 }
});

test('fragments from the previous filter pipeline are regenerated for Webview and browser players',{skip:!available},async t=>{
 const {createHash}=require('node:crypto');
 for(const target of ['webview','browser']){
  const {service,base,directory}=await setup(t),settings={mode:'auto',target,ffmpegPath:'ffmpeg',maxHeight:720};
  const info=await service.get('file','old',signal(),settings,true),session=service.sessions.get(info.token),source=session.source;
  const extension=target==='browser'?'.ts':'.webm',version=target==='browser'?'browser-h264-aac-ts-v2':'vp8-safe-audio-v5';
  const key=createHash('sha256').update(JSON.stringify([source.filePath,source.mtime,source.size,session.version,session.tools.ffmpeg,0,720,info.stream.mime,session.orientation?.key,version])).digest('hex');
  const obsolete=Buffer.from('previous filtering pipeline');await fs.writeFile(path.join(directory,'stream-v1',key+extension),obsolete);
  service.dispose();await service.pruning;
  const restored=new VideoService(directory,async()=>source);t.after(()=>restored.dispose());
  const nextBase=await restored.startServer(),next=await restored.get('file','new',signal(),settings,true);
  const response=await fetch(url(nextBase,next,'segment/0'+extension));assert.equal(response.status,200);assert.notDeepEqual(Buffer.from(await response.arrayBuffer()),obsolete);
  assert.equal(restored.stats.segments,1);serverTiming(response,false);
 }
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
 // Whole seconds keep this cache-invalidation test independent of sub-ms stat rounding.
 const future=new Date((Math.floor(Date.now()/1000)+2)*1000);await fs.utimes(file,future,future);const updated=await service.posterPreview('file','two',signal(),'ffmpeg');assert.notEqual(initial.file,updated.file);assert.equal(service.stats.posters,2);
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


test('default FFmpeg discovery skips the experimental native Vorbis-only build', {skip:process.platform==='win32'}, async t => {
 const {service} = await setup(t);
 service.run = async executable => Buffer.from(executable === 'ffmpeg'
  ? ' V..... libvpx test\n A..X.. vorbis test\n'
  : ' V..... libvpx test\n A..... libvorbis test\n');
 const tools = await service.tools('ffmpeg');
 assert.equal(tools.ffmpeg, '/usr/bin/ffmpeg');
 assert.ok(tools.encoders.has('libvorbis'));
});

test('explicit native Vorbis-only FFmpeg reports the missing stable encoder instead of generating broken audio', async t => {
 const {service} = await setup(t);
 service.run = async (executable, args) => Buffer.from(args.includes('-encoders')
  ? ' V..... libvpx test\n A..X.. vorbis test\n'
  : JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',width:320,height:180},{codec_type:'audio',codec_name:'aac'}],format:{duration:'40'}}));
 await assert.rejects(service.get('file','one',signal(),{mode:'auto',ffmpegPath:'/custom/ffmpeg'}), /libvorbis/);
 assert.equal(service.stats.segments, 0);
});

test('stable encoder fallback produces ordered, decodable WebM blocks for first and distant fragments', {skip:!available || process.platform==='win32'}, async t => {
 const {webmTimeline} = require('./helpers/webmTimeline');
 const {service,base,directory} = await setup(t);
 const tools = await service.tools('ffmpeg');
 if (!tools.encoders.has('libvorbis')) { t.skip('FFmpeg lacks libvorbis'); return; }
 const run = service.run.bind(service); service.toolCache.clear();
 service.run = (executable,args,...rest) => {
  if (executable === 'ffmpeg' && args.includes('-encoders')) return Promise.resolve(Buffer.from(' V..... libvpx test\n A..X.. vorbis test\n'));
  return run(executable === '/usr/bin/ffmpeg' ? 'ffmpeg' : executable === '/usr/bin/ffprobe' ? 'ffprobe' : executable,args,...rest);
 };
 const info = await service.get('file','stable',signal(),{mode:'auto',ffmpegPath:'ffmpeg'});
 assert.equal(info.stream.mime, 'video/webm; codecs="vp8,vorbis"');
 assert.equal(service.sessions.get(info.token).tools.ffmpeg,'/usr/bin/ffmpeg');
 for (const index of [0,8]) {
  const response = await fetch(url(base,info,`segment/${index}.webm`));
  assert.equal(response.status,200);
  const bytes = Buffer.from(await response.arrayBuffer()), blocks = webmTimeline(bytes);
  assert.equal(new Set(blocks.map(block => block.track)).size,2);
  assert.ok(blocks.length > 100);
  for (let i = 1; i < blocks.length; i++) {
   if (blocks[i].cluster === blocks[i-1].cluster) assert.ok(blocks[i].timecode >= blocks[i-1].timecode, `WebM block timecode went backwards at ${i}`);
  }
  const output = path.join(directory,`stable-${index}.webm`); await fs.writeFile(output,bytes);
  const probe = JSON.parse(spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','json',output],{encoding:'utf8'}).stdout);
  assert.ok(probe.streams.some(stream => stream.codec_name === 'vorbis'));
  const decode = spawnSync('ffmpeg',['-v','error','-i',output,'-f','null','-']);
  assert.equal(decode.status,0,decode.stderr.toString());
 }
 assert.equal(service.stats.segments,2);
});

test('obsolete Vorbis fragment caches are not reused after the safe-audio fix', {skip:!available}, async t => {
 const {createHash} = require('node:crypto');
 const {service,base,directory} = await setup(t), settings = {mode:'auto',ffmpegPath:'ffmpeg',maxHeight:720};
 const info = await service.get('file','old',signal(),settings);
 const session = service.sessions.get(info.token), source = session.source;
 const oldKey = createHash('sha256').update(JSON.stringify([source.filePath,source.mtime,source.size,session.tools.ffmpeg,0,720,info.stream.mime,'vp8-vorbis-quality-v3'])).digest('hex');
 const obsolete = Buffer.from('obsolete incompatible WebM cache');
 await fs.mkdir(path.join(directory,'stream-v1'),{recursive:true});
 await fs.writeFile(path.join(directory,'stream-v1',oldKey+'.webm'),obsolete);
 service.dispose(); await service.pruning;
 const restored = new VideoService(directory,async()=>source); t.after(()=>restored.dispose());
 const nextBase = await restored.startServer(), next = await restored.get('file','new',signal(),settings);
 const response = await fetch(url(nextBase,next,'segment/0.webm'));
 assert.equal(response.status,200); assert.notDeepEqual(Buffer.from(await response.arrayBuffer()),obsolete);
 assert.equal(restored.stats.segments,1,'the obsolete on-disk entry must trigger regeneration');
});
