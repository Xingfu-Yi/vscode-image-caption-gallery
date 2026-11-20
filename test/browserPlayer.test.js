const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {VideoService}=require('../dist/videoService'),{normalizePlaybackState,browserPlayerAsset}=require('../dist/browserPlayer');
const fixture=path.join(__dirname,'fixtures/streaming-timeline.mp4'),available=spawnSync('ffmpeg',['-version']).status===0;
async function setup(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-browser-test-'));const service=new VideoService(directory,async()=>{const stat=await fs.stat(fixture);return{filePath:fixture,mtime:stat.mtimeMs,size:stat.size}});t.after(async()=>{service.dispose();await service.pruning;await fs.rm(directory,{recursive:true,force:true})});return{service,base:await service.startServer()}}
const endpoint=(base,token,name)=>`${base}/v1/${token}/${name}`;
test('browser handoff state clamps invalid values and keeps quality choices',()=>{
 assert.deepEqual(normalizePlaybackState({time:-5,rate:99,volume:NaN,muted:'yes',quality:1}),{time:0,rate:4,volume:1,muted:false,quality:1440});
 assert.deepEqual(normalizePlaybackState({time:97,rate:1.75,volume:.3,muted:true,quality:720}),{time:97,rate:1.75,volume:.3,muted:true,quality:720});
});
test('browser player uses its own private session, bundled scripts, CSP and original AAC playback',{skip:!available},async t=>{
 const {service,base}=await setup(t);const gallery=await service.get('clip','gallery',new AbortController().signal,{mode:'native',ffmpegPath:'ffmpeg'});
 const token=await service.createBrowserPlayer('clip','private <title>.mp4',{mode:'auto',ffmpegPath:'ffmpeg'},{time:17,rate:1.75,volume:.3,muted:true,quality:1440});service.release('gallery');
 let response=await fetch(endpoint(base,token,'player?forward=private'));assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('referrer-policy'),'no-referrer');
 const html=await response.text();assert.match(html,/hls.js\?forward=private/);assert.doesNotMatch(html,/private <title>|https:\/\/|caption/i);
 assert.match(html,/controlslist="nofullscreen"/);assert.match(html,/file-menu\.css\?forward=private/);assert.ok(html.indexOf('file-menu.js')<html.indexOf('player.js'));
 for(const name of ['player.js','player.css','hls.js','file-menu.js','file-menu.css']){response=await fetch(endpoint(base,token,name));assert.equal(response.status,200);assert.ok((await response.text()).length>100)}
 const data=await(await fetch(endpoint(base,token,'state'))).json();assert.equal(data.title,'private <title>.mp4');assert.equal(data.filePath,fixture);assert.equal(data.state.time,17);assert.equal(data.state.rate,1.75);assert.equal(data.video.converted,false,'browser can decode AAC without conversion');assert.equal(service.stats.segments,0);
 assert.equal((await fetch(endpoint(base,gallery.token,'player'))).status,404);
 assert.equal((await fetch(endpoint(base,token,'heartbeat'),{method:'POST'})).status,204);
 service.releaseBrowser(token);assert.equal((await fetch(endpoint(base,token,'state'))).status,404);assert.equal((await fetch(endpoint(base,data.video.token,'original'))).status,404);assert.equal((await fetch(endpoint(base,token,'file-menu.js'))).status,404);
});

test('browser player assets are a fixed allowlist and never resolve a source file path',async()=>{
 for(const name of ['../videoService.js','../../package.json','/etc/passwd','unknown.css']){await assert.rejects(browserPlayerAsset(name),/Unknown player asset/);}
});
test('browser HLS manifests are metadata only; requested TS fragments decode and seek without preceding work',{skip:!available},async t=>{
 const {service,base}=await setup(t);const token=await service.createBrowserPlayer('clip','clip.mp4',{mode:'auto',ffmpegPath:'ffmpeg'},{time:33,quality:720});
 const data=await(await fetch(endpoint(base,token,'state?quality=720&compatible=1'))).json();assert.equal(data.video.stream.format,'hls');assert.equal(service.stats.segments,0);
 const manifest=await(await fetch(endpoint(base,data.video.token,'manifest.m3u8?forward=private'))).text();assert.match(manifest,/#EXT-X-DISCONTINUITY/);assert.match(manifest,/segment\/8.ts\?forward=private/);assert.match(manifest,/#EXT-X-ENDLIST/);assert.equal(service.stats.segments,0);
 const source=endpoint(base,data.video.token,'segment/8.ts'),first=await fetch(source),bytes=Buffer.from(await first.arrayBuffer());assert.equal(first.status,200);assert.equal(first.headers.get('content-type'),'video/mp2t');assert.equal(service.stats.segments,1);
 const decode=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-f','null','-'],{input:bytes,encoding:'buffer'});assert.equal(decode.status,0,decode.stderr.toString());
 assert.deepEqual(Buffer.from(await(await fetch(source)).arrayBuffer()),bytes);assert.equal(service.stats.segments,1);
 assert.equal((await fetch(endpoint(base,data.video.token,'segment/8.webm'))).status,404);
 const changed=await(await fetch(endpoint(base,token,'state?quality=1080&compatible=1'))).json();assert.notEqual(changed.video.token,data.video.token);assert.equal((await fetch(source)).status,404,'quality change revokes previous playback session');
 service.sessions.get(token).browser.lastActivity=Date.now()-31*60*1000;service.expireBrowserSessions();assert.equal((await fetch(endpoint(base,token,'player'))).status,404);
});

test('browser video metadata uses the validated source path verbatim instead of its title or identifier',{skip:!available},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-browser-path-'));const file=path.join(directory,'中文 空格 100% #? literal%20%2F.mp4');await fs.copyFile(fixture,file);
 const id='vscode-remote://ssh-remote+Home/data/encoded%2520.mp4';let lookups=0;
 const service=new VideoService(path.join(directory,'cache'),async known=>{lookups++;assert.equal(known,id);const stat=await fs.stat(file);return{filePath:file,mtime:stat.mtimeMs,size:stat.size}});
 t.after(async()=>{service.dispose();await service.pruning;await fs.rm(directory,{recursive:true,force:true})});
 const base=await service.startServer(),token=await service.createBrowserPlayer(id,'untrusted title %25.mp4',{mode:'auto',ffmpegPath:'ffmpeg'},{});
 const data=await(await fetch(endpoint(base,token,'state'))).json();assert.equal(data.filePath,file);assert.notEqual(data.filePath,id);assert.notEqual(data.filePath,data.title);
 assert.equal(service.stats.posters,0);assert.equal(service.stats.segments,0);assert.equal(service.stats.rangeBytes,0);assert.ok(lookups>=1);
 assert.equal((await fetch(endpoint(base,token,'../../package.json'))).status,404);assert.equal((await fetch(endpoint(base,'0'.repeat(64),'file-menu.js'))).status,404);
 service.releaseBrowser(token);assert.equal((await fetch(endpoint(base,token,'state'))).status,404);
});
