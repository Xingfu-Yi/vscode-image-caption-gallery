// Compare bounded parallel thumbnail generation without modifying source files.
// Usage: GALLERY_BENCHMARK_RUNTIME=/path/to/dist node test/thumbnailBenchmark.cjs folder [count=12] [workers=0]
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const runtime=process.env.GALLERY_BENCHMARK_RUNTIME||path.join(__dirname,'../dist');
const {PreviewService}=require(path.join(runtime,'previewService'));
(async()=>{
 const folder=path.resolve(process.argv[2]),count=Math.max(1,Math.min(1000,Number(process.argv[3])||12)),concurrency=Number(process.argv[4])||0;
 const files=(await fs.readdir(folder)).filter(name=>/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(name)).sort().slice(0,count).map(name=>path.join(folder,name));
 if(!files.length)throw Error('No supported images in the benchmark directory.');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gallery-thumbnail-benchmark-'));
 const source=async id=>{const file=new URL(id),stat=await fs.stat(file);return{mtime:stat.mtimeMs,size:stat.size,read:()=>fs.readFile(file)}};
 let service=new PreviewService(directory,source,{concurrency});
 try{
  for(const round of ['cold','warm','restart']){
   if(round==='restart'){service.dispose();await service.eviction;service=new PreviewService(directory,source,{concurrency});}
   let first;const start=performance.now();const results=await Promise.all(files.map(async(file,i)=>{
    try{const result=await service.get(pathToFileURL(file).href,512,round+i,false,new AbortController().signal,true);const bytes=result.filePath?(await fs.stat(result.filePath)).size:0;first??=performance.now()-start;return{...result,outputBytes:bytes};}
    catch(error){return{file:path.basename(file),error:error.message};}
   }));
   const good=results.filter(r=>!r.error),sum=name=>good.reduce((total,r)=>total+(r.timings?.[name]||0),0);
   console.log(JSON.stringify({round,workers:service.poolStatus.workers,images:files.length,milliseconds:Math.round(performance.now()-start),firstMs:Math.round(first||0),cacheHits:good.filter(r=>r.timings?.cacheHit).length,meanProcessMs:Math.round(sum('processMs')/(good.length||1)),meanQueueMs:Math.round(sum('queueMs')/(good.length||1)),outputBytes:good.reduce((s,r)=>s+r.outputBytes,0),errors:results.filter(r=>r.error).map(r=>({file:r.file,error:r.error})),processIds:[...new Set(good.map(r=>r.timings?.pid).filter(Boolean))]}));
  }
 }finally{service.dispose();await service.eviction;await fs.rm(directory,{recursive:true,force:true,maxRetries:5});}
})().catch(error=>{console.error(error);process.exitCode=1});
