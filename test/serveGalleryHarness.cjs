// Browser QA against the compiled extension and real decoder pool, using only
// generated JPEGs in an owned temporary dataset. No user images are displayed.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {AsyncLocalStorage}=require('node:async_hooks'),{randomUUID}=require('node:crypto');
const {createHost}=require('./helpers/host'),{initializeProcessor}=require('../dist/previewProcessor');
(async()=>{
 const cleanup=[],host=await createHost({after:fn=>cleanup.push(fn)},{showCaption:false,maxPreviewResolution:2048,previewConcurrency:4},true);
 const m=await initializeProcessor(),width=3200,height=2400,pixels=Buffer.alloc(width*height*3);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;pixels[i]=(x/16+y/24)%256;pixels[i+1]=(x/24+80)%256;pixels[i+2]=(y/16+120)%256;}
 const bytes=m.ImageMagick.read(Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),pixels]),im=>{im.quality=92;return im.write(m.MagickFormat.Jpeg,b=>Buffer.from(b))});
 const first=path.join(host.dataset,'image-0000.jpg');await fs.writeFile(first,bytes);
 await Promise.all(Array.from({length:286},(_,i)=>fs.link(first,path.join(host.dataset,`image-${String(i+1).padStart(4,'0')}.jpg`))));
 const replies=new AsyncLocalStorage(),resources=new Map(),metrics={previews:0,inline:0,resourceRequests:0,errors:0};
 host.panel.webview.postMessage=async message=>{
  if(message.type==='preview'){metrics.previews++;if(message.source.startsWith('data:'))metrics.inline++;else if(message.source.startsWith('https://resources.test/')){
   const file=new URL(message.source).searchParams.get('uri'),location=new URL(file).pathname;
   if(!decodeURIComponent(location).startsWith(path.dirname(host.dataset)+path.sep))throw Error('Resource outside QA directory');
   const token=randomUUID();resources.set(token,file);message={...message,source:'/resource/'+token};
  }}
  if(message.type==='previewError')metrics.errors++;
  replies.getStore()?.push(message);return true;
 };
 let html=host.panel.webview.html.replace(/  <meta http-equiv="Content-Security-Policy"[^>]+>\n/,'').replace('<title>Image Caption Gallery</title>','<title>Image Caption Gallery 0.8.1 · Real thumbnail QA</title>');
 const theme=(await fs.readFile(path.join(__dirname,'webviewHarness.html'),'utf8')).match(/  <style>[\s\S]*?<\/style>/)?.[0]||'';
 const bridge=`<script>
 let state={};const metricsOutput=document.createElement('output');metricsOutput.id='gallery-qa-metrics';metricsOutput.hidden=true;document.body.append(metricsOutput);let hostMetrics={};
 const report=()=>{metricsOutput.textContent=JSON.stringify({ready:document.querySelectorAll('.gallery-thumbnail.thumbnail-ready').length,rendered:document.querySelectorAll('.image-card').length,errors:document.querySelectorAll('.preview-error').length,...hostMetrics})};
 new MutationObserver(report).observe(document.querySelector('#gallery'),{subtree:true,attributes:true,childList:true});
 window.acquireVsCodeApi=()=>({getState:()=>state,setState:x=>state=x,postMessage:message=>{fetch('/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}).then(r=>r.json()).then(r=>{hostMetrics=r.metrics;for(const m of r.messages)window.postMessage(m,'*');report()}).catch(e=>{metricsOutput.textContent=e.message})}});
 </script>`;
 html=html.replace('</head>',theme+'</head>').replace(/  <script nonce=/,bridge+'\n  <script nonce=');
 const server=http.createServer(async(req,res)=>{try{
  if(req.url==='/message'&&req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw Error('Message too large');}
   const messages=[];await replies.run(messages,()=>host.panel.receive(JSON.parse(body)));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messages,metrics}));return;
  }
  if(req.url.startsWith('/resource/')){const file=resources.get(req.url.slice('/resource/'.length));if(!file){res.writeHead(404);res.end();return;}metrics.resourceRequests++;res.setHeader('Content-Type',file.endsWith('.webp')?'image/webp':'image/jpeg');res.end(await fs.readFile(new URL(file)));return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/html');res.end(html);
 }catch(error){res.writeHead(500);res.end(error.message);}});
 server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
 let closing=false;const close=async()=>{if(closing)return;closing=true;server.close();const preview=host.context.subscriptions.find(s=>s.constructor.name==='PreviewService');preview.dispose();for(let i=0;i<80&&preview.active.size;i++)await new Promise(r=>setTimeout(r,25));for(const fn of cleanup)await fn();process.exit();};
 process.on('SIGINT',close);process.on('SIGTERM',close);
})().catch(error=>{console.error(error);process.exitCode=1});
