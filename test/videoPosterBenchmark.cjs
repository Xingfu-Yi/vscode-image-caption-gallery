// Repeatable host-side first-frame benchmark; only its own temporary cache is written.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {VideoService}=require('../dist/videoService');
(async()=>{
 const input=path.resolve(process.argv[2]||path.join(__dirname,'fixtures')),ffmpeg=process.argv[3]||'ffmpeg';
 const names=(await fs.readdir(input)).filter(name=>/\.(mp4|webm|mov|m4v|mkv|avi|mpg|mpeg|wmv|3gp|mts|m2ts|ogv|vob|flv)$/i.test(name)).sort().slice(0,8);
 if(!names.length)throw Error('No videos in the supplied directory.');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-poster-benchmark-'));
 const source=async id=>{const filePath=path.join(input,names[Number(id)]),stat=await fs.stat(filePath);return{filePath,size:stat.size,mtime:stat.mtimeMs}};
 let service=new VideoService(directory,source);
 const sample=async phase=>{
  const started=performance.now();
  const samples=await Promise.all(names.map(async(_,index)=>{const poster=await service.posterPreview(String(index),`${phase}/${index}`,new AbortController().signal,ffmpeg);return{index,...poster.timing}}));
  return{phase,totalMs:Math.round(performance.now()-started),samples:samples.map(x=>Object.fromEntries(Object.entries(x).map(([key,value])=>[key,typeof value==='number'?Math.round(value):value])))};
 };
 try{
  const cold=await sample('cold'),warm=await sample('warm');service.dispose();await service.pruning;
  service=new VideoService(directory,source);const restarted=await sample('restarted');
  console.log(JSON.stringify({node:process.version,files:names.length,cold,warm,restarted,stats:service.stats},null,2));
 }finally{service.dispose();await service.pruning;await fs.rm(directory,{recursive:true,force:true})}
})().catch(error=>{console.error(error.message);process.exitCode=1});
