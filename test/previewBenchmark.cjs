// Synthetic JPEG benchmark; optional argument uses a local image without changing it.
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const runtime = process.env.GALLERY_BENCHMARK_RUNTIME || path.join(__dirname, '../dist');
const { PreviewService } = require(path.join(runtime, 'previewService'));
const { initializeProcessor } = require(path.join(runtime, 'previewProcessor'));
(async () => {
  let bytes, suffix = '.jpg';
  if (process.argv[2]) { bytes = await fs.readFile(process.argv[2]); suffix = path.extname(process.argv[2]); }
  else {
    const m = await initializeProcessor(), w = 3200, h = 2400, pixels = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { const i = (y*w+x)*3; pixels[i] = (x*3+y)%256; pixels[i+1] = (x+y*2)%256; pixels[i+2] = ((x>>4)*13+(y>>4)*9)%256; } }
    bytes = m.ImageMagick.read(Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), pixels]), (image) => { image.quality = 90; return image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)); });
  }
  for (const [backend, concurrency] of [['process',1],['process',2],['thread',2]]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-preview-benchmark-'));
    const service = new PreviewService(directory, async () => ({ mtime: 1, size: bytes.length, read: async () => bytes }), { backend, concurrency });
    try {
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => service.get(`file:///benchmark-${i}${suffix}`, 1024, `image-${i}`, true, new AbortController().signal)));
      console.log(JSON.stringify({ backend, workers: service.poolStatus.workers, images: 6, resolution: 1024, ms: Math.round(performance.now()-start), bytes: bytes.length, meanQueueMs: Math.round(results.reduce((sum,r)=>sum+r.timings.queueMs,0)/6), meanProcessMs: Math.round(results.reduce((sum,r)=>sum+r.timings.processMs,0)/6), processIds: [...new Set(results.map((r)=>r.timings.pid))] }));
    } finally { service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
