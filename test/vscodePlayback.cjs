// Run with VS Code --extensionTestsPath; exercises the real webview decoder.
const vscode = require('vscode'), fs = require('node:fs/promises'), path = require('node:path');
exports.run = async () => {
 const cases=JSON.parse(await fs.readFile(process.env.GALLERY_QA_CASES,'utf8'));
 const origins=[...new Set(cases.map(item=>new URL(item.stream.base).origin))].join(' ');
 const script=await fs.readFile(process.env.GALLERY_QA_STREAM || path.join(__dirname,'../media/videoStream.js'),'utf8');
 const panel=vscode.window.createWebviewPanel('gallery.playback.qa','Gallery playback verification',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true});
 try {
  const result=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Actual VS Code playback verification timed out')),100000);panel.webview.onDidReceiveMessage(message=>{if(message.type==='result'){clearTimeout(timeout);resolve(message);}});});
  panel.webview.html=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${origins} blob:; connect-src ${origins}; script-src 'nonce-qa'; style-src 'unsafe-inline'"><style>body{background:#111;color:#ddd}video{width:600px;height:380px}</style><video controls muted></video><pre id="status">Verifying actual VS Code video decoding…</pre><script nonce="qa">${script}</script><script nonce="qa">
  (async()=>{const api=acquireVsCodeApi(),cases=${JSON.stringify(cases)},results=[];
  const wait=(predicate,ms=25000)=>new Promise((resolve,reject)=>{const start=performance.now();const timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve()}else if(performance.now()-start>ms){clearInterval(timer);reject(Error('Timed out: '+document.querySelector('#status').textContent))}},50)});
  for(const item of cases){let stream,errors=[];const video=document.querySelector('video');
   const report=error=>{errors.push(String(error));document.querySelector('#status').textContent=errors.join(' | ')};
   const listener=()=>report('media '+video.error?.code+': '+video.error?.message);video.addEventListener('error',listener);
   try {stream=new GalleryVideoStream(video,item.stream,report);stream.start();await wait(()=>video.readyState>=2||errors.length);if(errors.length)throw Error(errors.join(' | '));
    video.playbackRate=2;await video.play();await wait(()=>video.currentTime>=Math.min(4.4,item.duration-.5)||errors.length);if(errors.length)throw Error(errors.join(' | '));
    video.pause();for(const time of item.id==='small'?[4.1,0,5.2]:[110.2,4.1,72.2,97.2]){video.currentTime=time;await new Promise(resolve=>setTimeout(resolve,50));}await wait(()=>!video.seeking&&video.readyState>=2||errors.length);if(errors.length)throw Error(errors.join(' | '));
    const time=video.currentTime;await video.play();await wait(()=>video.currentTime>time+.5||errors.length);if(errors.length)throw Error(errors.join(' | '));
    results.push({id:item.id,ok:true,time:video.currentTime,width:video.videoWidth,height:video.videoHeight,audioDecodedBytes:video.webkitAudioDecodedByteCount,audioTracks:video.audioTracks?.length,buffered:[...Array(video.buffered.length)].map((_,i)=>[video.buffered.start(i),video.buffered.end(i)])});
   }catch(error){results.push({id:item.id,ok:false,error:error.message,mediaError:video.error?.message,state:video.dataset.streamState,readyState:video.readyState})}
   finally{video.pause();stream?.dispose();video.removeEventListener('error',listener);video.removeAttribute('src');video.load();delete video.dataset.streamError}
  }
  api.postMessage({type:'result',supported:MediaSource.isTypeSupported('video/webm; codecs="vp8,vorbis"'),results});document.querySelector('#status').textContent=JSON.stringify(results,null,2);
  })().catch(error=>acquireVsCodeApi().postMessage({type:'result',fatal:error.message}));</script>`;
  const actual=await result;await fs.writeFile(process.env.GALLERY_QA_RESULT,JSON.stringify(actual,null,2));console.log(JSON.stringify(actual));
 }finally{panel.dispose();}
};
