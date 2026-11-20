const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {readVideoOrientation}=require('../dist/videoOrientation');
const {VideoService}=require('../dist/videoService');
const fixture=path.join(__dirname,'fixtures/rotation-webm.webm');
const available=spawnSync('ffmpeg',['-version']).status===0;
const signal=()=>new AbortController().signal;
async function makeSidecar(file,rotation='cw90',extra={}){
 const stat=await fs.stat(file,{bigint:true}),identity={dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime_ns:String(stat.mtimeNs)};
 const record={status:'reported',reference:'encoded_pixels',asset_id:path.basename(file).split('__')[0],rotation,native_rotation_applied:false,source_identity:identity,...extra};
 // Reproduce the Python writer's exact integer tokens, including nanoseconds.
 const text=JSON.stringify(record).replace(/("(?:dev|ino|size|mtime_ns)":)"(-?\d+)"/g,'$1$2')+'\n';
 await fs.writeFile(file+'.jsonl',text);return text;
}
async function ownFile(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-orientation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'v000000001__演示.webm');await fs.copyFile(fixture,file);
 const source=async()=>{const stat=await fs.stat(file);return{filePath:file,size:stat.size,mtime:stat.mtimeMs};};
 return{file,directory,source};
}
const decode=(file,filter)=>{
 const p=spawnSync('ffmpeg',['-nostdin','-v','error','-noautorotate','-i',file,'-map','0:v:0','-frames:v','1','-an','-vf',filter,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 assert.equal(p.status,0,p.stderr.toString());return p.stdout;
};
const compare=(actual,expected)=>{
 assert.equal(actual.length,expected.length);const error=actual.reduce((sum,value,i)=>sum+Math.abs(value-expected[i]),0)/actual.length;
 assert.ok(error<12,`orientation must match encoded-pixel reference; mean RGB difference=${error}`);
};

test('absolute direction reader binds exact nanosecond identity and rejects foreign, stale, multiline, oversized and linked JSONL',async t=>{
 const{file,directory,source}=await ownFile(t);let info=await source();
 assert.equal(await readVideoOrientation(info),undefined);
 const text=await makeSidecar(file);const first=await readVideoOrientation(info);assert.equal(first.rotation,'cw90');
 await fs.writeFile(file+'.jsonl',text.replace(/("mtime_ns":)(\d+)/,(_,key,value)=>key+(BigInt(value)+1n)));
 assert.equal(await readVideoOrientation(info),undefined,'one-nanosecond stale identity must not round into a match');
 for(const extra of [{asset_id:'v000000002'},{reference:'display_pixels'},{rotation:'sideways'},
                     {native_rotation_applied:true},{rotation_degrees:-90}]){
  await makeSidecar(file,'cw90',extra);assert.equal(await readVideoOrientation(info),undefined);
 }
 await fs.writeFile(file+'.jsonl',text+text);assert.equal(await readVideoOrientation(info),undefined);
 await fs.writeFile(file+'.jsonl','x'.repeat(16385));assert.equal(await readVideoOrientation(info),undefined);
 const outside=path.join(directory,'saved.jsonl');await fs.writeFile(outside,text);await fs.unlink(file+'.jsonl');await fs.symlink(outside,file+'.jsonl');
 assert.equal(await readVideoOrientation(info),undefined);await fs.unlink(file+'.jsonl');
 await makeSidecar(file,'none');assert.equal((await readVideoOrientation(info)).rotation,'none');
 await fs.appendFile(file,'modified');info=await source();assert.equal(await readVideoOrientation(info),undefined);
});

test('sidecar orientation controls posters and both fragment paths exactly once, invalidates caches, and preserves source bytes', {skip:!available},async t=>{
 const{file,directory,source}=await ownFile(t),before=await fs.readFile(file),caption=path.join(directory,'v000000001__演示.txt');
 await fs.writeFile(caption,'preserve existing caption\n');
 const service=new VideoService(path.join(directory,'cache'),source);t.after(async()=>{service.dispose();await service.pruning;});const base=await service.startServer();
 const posterPaths=[];
 for(const [rotation,transform,width,height] of [['cw90','transpose=clock,',240,320],['none','',320,240],['ccw90','transpose=cclock,',240,320],['180','hflip,vflip,',320,240]]){
  await makeSidecar(file,rotation);const expected=decode(file,transform+'scale=48:64');
  const poster=await service.posterPreview('one','poster',signal(),'ffmpeg');posterPaths.push(poster.file);
  const posterFile=path.join(directory,'poster.jpg');await fs.writeFile(posterFile,Buffer.from(poster.source.split(',')[1],'base64'));
  compare(decode(posterFile,'scale=48:64'),expected);
  for(const target of ['webview','browser']){
   const info=await service.get('one',target,signal(),{mode:'auto',target,ffmpegPath:'ffmpeg',maxHeight:0});
   assert.equal(info.converted,true);assert.equal(info.width,width);assert.equal(info.height,height);
   const suffix=target==='browser'?'ts':'webm',response=await fetch(`${base}/v1/${info.token}/segment/0.${suffix}`);
   assert.equal(response.status,200);const output=path.join(directory,'result.'+suffix);await fs.writeFile(output,Buffer.from(await response.arrayBuffer()));
   compare(decode(output,'scale=48:64'),expected);
  }
 }
 assert.equal(new Set(posterPaths).size,4,'changing only direction metadata must invalidate the poster cache');
 await makeSidecar(file,'cw90',{native_rotation_applied:true});
 const normal=await service.get('one','native-tag',signal(),{mode:'auto',ffmpegPath:'ffmpeg',maxHeight:0});assert.equal(normal.width,240);assert.equal(normal.height,320);
 const native=await service.get('one','original',signal(),{mode:'native',ffmpegPath:'missing'});assert.equal(native.converted,false);
 assert.deepEqual(await fs.readFile(file),before);assert.equal(await fs.readFile(caption,'utf8'),'preserve existing caption\n');
});

test('actual MPEG-TS media uses its absolute direction sidecar in Webview and browser playback', {skip:!available},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-mts-orientation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'v000000002__camera.mts');
 // A patterned synthetic frame makes a missed transpose observable; a solid
 // color could pass pixel comparison even when the picture remained sideways.
 const made=spawnSync('ffmpeg',['-nostdin','-v','error','-noautorotate','-i',fixture,'-t','1','-map','0:v:0','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2','-f','mpegts',file],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
 const before=await fs.readFile(file);await makeSidecar(file);
 const source=async()=>{const stat=await fs.stat(file);return{filePath:file,size:stat.size,mtime:stat.mtimeMs};};
 const service=new VideoService(path.join(directory,'cache'),source);t.after(async()=>{service.dispose();await service.pruning;});const base=await service.startServer();
 const expected=decode(file,'transpose=clock,scale=48:64');
 for(const target of ['webview','browser']){
  const info=await service.get('one',target,signal(),{mode:'auto',target,ffmpegPath:'ffmpeg',maxHeight:0});assert.equal(info.converted,true);
  assert.equal(info.width,240);assert.equal(info.height,320);
  const suffix=target==='browser'?'ts':'webm',response=await fetch(`${base}/v1/${info.token}/segment/0.${suffix}`);assert.equal(response.status,200);
  const output=path.join(directory,'upright.'+suffix);await fs.writeFile(output,Buffer.from(await response.arrayBuffer()));compare(decode(output,'scale=48:64'),expected);
 }
 assert.deepEqual(await fs.readFile(file),before);
});

test('replacement media preserving size and mtime invalidates probes/posters/fragments, and sidecar changes revoke old fragments', {skip:!available},async t=>{
 const{file,directory,source}=await ownFile(t),fixedTime=new Date(Math.floor(Date.now()/1000)*1000);await fs.utimes(file,fixedTime,fixedTime);
 const service=new VideoService(path.join(directory,'cache'),source);t.after(async()=>{service.dispose();await service.pruning;});const base=await service.startServer();
 const run=service.run.bind(service);let probes=0;service.run=(exe,args,...rest)=>{if(path.basename(exe).includes('ffprobe'))probes++;return run(exe,args,...rest);};
 const settings={mode:'auto',ffmpegPath:'ffmpeg',maxHeight:0};
 const first=await service.get('one','old',signal(),settings),probeCount=probes,poster=await service.posterPreview('one','poster',signal(),'ffmpeg');
 const response=await fetch(`${base}/v1/${first.token}/segment/0.webm`);assert.equal(response.status,200);await response.arrayBuffer();
 const replacement=path.join(directory,'replacement.webm');await fs.copyFile(file,replacement);await fs.utimes(replacement,fixedTime,fixedTime);await fs.rename(replacement,file);
 assert.equal((await fetch(`${base}/v1/${first.token}/segment/0.webm`)).status,500);
 assert.equal((await fetch(`${base}/v1/${first.token}/original`,{headers:{Range:'bytes=0-15'}})).status,409);
 const next=await service.get('one','new',signal(),settings);assert.equal(probes,probeCount+1,'same size/mtime replacement must rerun the metadata probe');
 const nextPoster=await service.posterPreview('one','poster',signal(),'ffmpeg');assert.notEqual(nextPoster.file,poster.file);
 await makeSidecar(file,'none');
 const obsolete=await fetch(`${base}/v1/${next.token}/segment/0.webm`);assert.equal(obsolete.status,500);assert.match(await obsolete.text(),/direction changed/);
 const refreshed=await service.get('one','fresh',signal(),settings);assert.equal(refreshed.width,320);assert.equal(refreshed.height,240);
});

test('media replaced during FFmpeg output is rejected before a fragment enters the persistent cache', {skip:!available},async t=>{
 const{file,directory,source}=await ownFile(t),service=new VideoService(path.join(directory,'cache'),source);
 t.after(async()=>{service.dispose();await service.pruning;});const base=await service.startServer(),settings={mode:'auto',ffmpegPath:'ffmpeg',maxHeight:0};
 const run=service.run.bind(service);let replace=true;
 service.run=async(exe,args,...rest)=>{
  const bytes=await run(exe,args,...rest);
  if(replace&&args.includes('webm')){replace=false;const newFile=path.join(directory,'replacement.webm');await fs.copyFile(file,newFile);await fs.rename(newFile,file);}
  return bytes;
 };
 const info=await service.get('one','old',signal(),settings),response=await fetch(`${base}/v1/${info.token}/segment/0.webm`);
 assert.equal(response.status,500);assert.match(await response.text(),/video changed/);
 assert.equal(service.entries.size,0,'changed content must not be committed under the previous file version');
 const next=await service.get('one','fresh',signal(),settings),fresh=await fetch(`${base}/v1/${next.token}/segment/0.webm`);
 assert.equal(fresh.status,200);await fresh.arrayBuffer();assert.equal(service.entries.size,1);
});
