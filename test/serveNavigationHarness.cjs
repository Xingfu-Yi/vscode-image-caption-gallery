// Real-source navigation benchmark. Source directories are read-only; previews
// and host state live in owned temporary directories. Streams host progress as NDJSON.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {AsyncLocalStorage}=require('node:async_hooks'),{randomUUID}=require('node:crypto');
const {createHost}=require('./helpers/host');
(async()=>{
 const source=process.env.GALLERY_QA_SOURCE_FOLDER;if(!source)throw Error('Set GALLERY_QA_SOURCE_FOLDER');
 const cleanup=[],replies=new AsyncLocalStorage(),resources=new Map(),hosts=new Map();
 const oldMain=process.env.GALLERY_QA_OLD_MAIN?await fs.readFile(process.env.GALLERY_QA_OLD_MAIN,'utf8'):null;
 const theme=(await fs.readFile(path.join(__dirname,'webviewHarness.html'),'utf8')).match(/  <style>[\s\S]*?<\/style>/)?.[0]||'';
 for(const phase of oldMain?['before','after']:['after']){
  const host=await createHost({after:fn=>cleanup.push(fn)},{showCaption:false,maxPreviewResolution:2048,previewConcurrency:4});
  const real=uri=>path.join(source,path.relative(host.dataset,uri.fsPath));
  host.fileSystem.readDirectory=async uri=>(await fs.readdir(real(uri),{withFileTypes:true})).filter(x=>x.isFile()&&/\.(jpe?g|png|gif|webp|arw|cr2|nef|dng)$/i.test(x.name)).map(x=>[x.name,1]);
  host.fileSystem.stat=async uri=>{const stat=await fs.stat(real(uri));return{type:stat.isDirectory()?2:1,mtime:stat.mtimeMs,size:stat.size}};
  host.fileSystem.readFile=async uri=>{host.reads.push(uri.toString());return fs.readFile(real(uri))};
  const metrics={requests:0,previews:0,progress:0,resourceBytes:0,resourceRequests:0};
  host.panel.webview.postMessage=async message=>{
   if(message.type==='preview'){metrics.previews++;if(message.source.startsWith('https://resources.test/')){
    const original=new URL(new URL(message.source).searchParams.get('uri'));let file=original.pathname;
    if(file.startsWith(host.dataset+path.sep))file=real({fsPath:file});
    else if(!file.startsWith(path.dirname(host.dataset)+path.sep))throw Error('Unexpected QA resource');
    const token=randomUUID();resources.set(token,{file,metrics});message={...message,source:'/resource/'+token};
   }}
   if(message.type==='previewProgress')metrics.progress++;
   replies.getStore()?.(message);return true;
  };
  let html=host.panel.webview.html.replace(/  <meta http-equiv="Content-Security-Policy"[^>]+>\n/,'');
  if(phase==='before')html=html.replace(await fs.readFile(path.join(__dirname,'../media/main.js'),'utf8'),oldMain);
  const bridge=`<script>window.qaMessages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage:message=>{window.qaMessages.push(message);fetch('/message/${phase}',{method:'POST',body:JSON.stringify(message)}).then(async response=>{const reader=response.body.getReader(),decoder=new TextDecoder();let text='';while(true){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});let index;while((index=text.indexOf('\\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);if(line)window.postMessage(JSON.parse(line),'*')}}}).catch(console.error)}});</script>`;
  html=html.replace('</head>',theme+'</head>').replace(/  <script nonce=/,bridge+'\n  <script nonce=');hosts.set(phase,{host,html,metrics});
 }
 const server=http.createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/message/')&&req.method==='POST'){
   const state=hosts.get(pathname.split('/')[2]);if(!state){res.writeHead(404);res.end();return}let body='';for await(const bytes of req){body+=bytes;if(body.length>65536)throw Error('Message too large')}
   state.metrics.requests++;res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'});res.flushHeaders();await replies.run(message=>{if(!res.destroyed)res.write(JSON.stringify(message)+'\n')},()=>state.host.panel.receive(JSON.parse(body)));res.end();return;
  }
  if(pathname.startsWith('/resource/')){const resource=resources.get(pathname.slice('/resource/'.length));if(!resource){res.writeHead(404);res.end();return}const bytes=await fs.readFile(resource.file);resource.metrics.resourceRequests++;resource.metrics.resourceBytes+=bytes.length;res.setHeader('Content-Type',resource.file.endsWith('.webp')?'image/webp':'image/jpeg');res.end(bytes);return}
  if(pathname==='/metrics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Object.fromEntries([...hosts].map(([name,value])=>[name,value.metrics]))));return}
  const state=hosts.get(pathname.slice(1)||'after');if(!state){res.writeHead(404);res.end();return}res.setHeader('Content-Type','text/html');res.end(state.html);
 }catch(error){if(!res.headersSent)res.writeHead(500);res.end(error.message)}});
 server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
 const close=async()=>{server.close();for(const {host}of hosts.values())for(const service of host.context.subscriptions)service.dispose();for(const fn of cleanup)await fn();process.exit()};process.on('SIGINT',close);process.on('SIGTERM',close);
})().catch(error=>{console.error(error);process.exit(1)});
