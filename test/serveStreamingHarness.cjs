const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {VideoService}=require('../dist/videoService');
(async()=>{
 const root=path.resolve(__dirname,'..'),file=process.env.GALLERY_TEST_VIDEO||path.join(__dirname,'fixtures/streaming-timeline.mp4'),stat=await fs.stat(file);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-streaming-harness-'));
 const copies=Array.from({length:8},(_,i)=>path.join(directory,`clip-${i}.mp4`));await Promise.all(copies.map(copy=>fs.copyFile(file,copy)));
 const videos=new VideoService(directory,async id=>{const match=/^demo-clip-([0-7])$/.exec(id);const source=match?copies[Number(match[1])]:file;const stat=await fs.stat(source);return{filePath:source,mtime:stat.mtimeMs,size:stat.size}});const base=await videos.startServer();
 const signal=new AbortController().signal,info=await videos.get('clip','compatible',signal,{mode:'auto',ffmpegPath:'ffmpeg',maxHeight:720}),native=await videos.get('clip','native',signal,{mode:'native',ffmpegPath:'ffmpeg'});
 const descriptor=x=>({...x,source:`${base}/v1/${x.token}/original`,poster:`${base}/v1/${x.token}/poster`,stream:x.stream?{...x.stream,base:`${base}/v1/${x.token}/segment/`}:undefined});
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.url==='/stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(videos.stats));return;}
   const requestUrl=new URL(req.url,'http://localhost');
   if(requestUrl.pathname==='/video'){const height=Number(requestUrl.searchParams.get('height')),mode=requestUrl.searchParams.get('native')==='true'?'native':'auto';const owner='video/'+requestUrl.searchParams.get('request');const controller=new AbortController();const result=await videos.get('clip',owner,controller.signal,{mode,ffmpegPath:'ffmpeg',maxHeight:height},requestUrl.searchParams.get('force')==='true');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(descriptor(result)));return;}
   if(requestUrl.pathname==='/release'){videos.release('video/'+requestUrl.searchParams.get('request'));res.end();return;}
   if(requestUrl.pathname==='/poster'){const id=requestUrl.searchParams.get('id')||'';if(!/^(demo-clip-[0-7]|demo-video|demo-compatible)$/.test(id)){res.writeHead(404);res.end();return;}const owner='card/'+id;const controller=new AbortController();res.once('close',()=>{controller.abort();videos.release(owner)});const poster=await videos.posterPreview(id,owner,controller.signal,'ffmpeg');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source:poster.source,timing:poster.timing}));return;}
   const pathname=decodeURIComponent(requestUrl.pathname);const target=path.resolve(root,'.'+pathname);
   if(!target.startsWith(root+path.sep)||!['.html','.js','.css','.webm','.mp4','.jpg'].includes(path.extname(target))){res.writeHead(404);res.end();return;}
   let bytes=await fs.readFile(target);
   if(target.endsWith('webviewHarness.html')){
    bytes=bytes.toString().replace('const demoSvg',`const streamingFixture=${JSON.stringify(descriptor(info))},nativeFixture=${JSON.stringify(descriptor(native))};\nconst demoSvg`)
    .replace('</body>',`<output hidden id="video-stream-stats"></output><script>setInterval(async()=>{document.querySelector('#video-stream-stats').textContent=JSON.stringify(await(await fetch('/stats')).json());},250);</script></body>`);
   }
   res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.webm':'video/webm','.jpg':'image/jpeg'})[path.extname(target)]);res.end(bytes);
  }catch(e){res.writeHead(500);res.end(e.message);}
 });server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/test/webviewHarness.html`));
 const close=async()=>{videos.dispose();server.close();await fs.rm(directory,{recursive:true,force:true});process.exit();};process.on('SIGINT',close);process.on('SIGTERM',close);
})().catch(e=>{console.error(e);process.exitCode=1});
