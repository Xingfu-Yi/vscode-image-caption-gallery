const fs = require('node:fs/promises'), path = require('node:path');
const { VideoService } = require('../dist/videoService');
(async () => {
 const sources=JSON.parse(process.env.GALLERY_QA_VIDEO_SOURCES || '{}');if(!Object.keys(sources).length)throw Error('Set GALLERY_QA_VIDEO_SOURCES to an ID → absolute-path JSON object');
 const service=new VideoService(path.join(__dirname,'../qa-cache'),async id=>{const file=sources[id];if(!file)throw Error('Unknown fixture');const stat=await fs.stat(file);return {filePath:file,mtime:stat.mtimeMs,size:stat.size}});
 const base=await service.startServer(),cases=[];
 for (const id of Object.keys(sources)) {
  const info=await service.get(id,id,new AbortController().signal,{mode:'auto',ffmpegPath:'/usr/bin/ffmpeg',maxHeight:1440});
  const browser=await service.createBrowserPlayer(id,path.basename(sources[id]),{mode:'auto',ffmpegPath:'/usr/bin/ffmpeg'},{time:id==='small'?0:97,rate:1.5,volume:0.1,muted:true,quality:1440});
  cases.push({id,...info,stream:{...info.stream,base:`${base}/v1/${info.token}/segment/`},browser:`${base}/v1/${browser}/player?quality=1440`});
 }
 console.log(JSON.stringify({base,cases}));
 const shutdown=()=>{service.dispose();process.exit()};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
 setInterval(()=>console.log(JSON.stringify({stats:service.stats})),30000);
})().catch(error=>{console.error(error);process.exit(1)});
