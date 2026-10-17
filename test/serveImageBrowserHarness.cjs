// Private, read-only image browser QA. Source files are never modified.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { PreviewService } = require('../dist/previewService'), { VideoService } = require('../dist/videoService');
const { BrowserImages } = require('../dist/browserImages'), { initializeProcessor } = require('../dist/previewProcessor');
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-image-browser-qa-'));
  const sourceFolder = process.env.GALLERY_QA_SOURCE_FOLDER || path.join(directory, 'sources');
  if (!process.env.GALLERY_QA_SOURCE_FOLDER) {
    await fs.mkdir(sourceFolder); const m = await initializeProcessor();
    for (let i = 0; i < 12; i++) {
      const [w, h] = i % 2 ? [900, 1600] : [1600, 900];
      const bytes = m.ImageMagick.read(i % 3 ? m.MagickColors.CornflowerBlue : m.MagickColors.Orange, w, h, image => image.write(m.MagickFormat.Jpeg, b => Buffer.from(b)));
      await fs.writeFile(path.join(sourceFolder, `${String(i).padStart(2, '0')}.jpg`), bytes);
    }
  }
  const records = (await fs.readdir(sourceFolder)).filter(name => /\.(jpe?g|png|gif|webp|arw|nef|cr2|dng|avif|bmp)$/i.test(name)).sort((a, b) => a.localeCompare(b)).map(name => ({ id: pathToFileURL(path.join(sourceFolder, name)).toString(), name, relativePath: name }));
  const source = async id => { const filePath = fileURLToPath(id); const stat = await fs.stat(filePath); return { filePath, mtime: stat.mtimeMs, size: stat.size }; };
  const metrics = { reads: 0, sourceBytes: 0 };
  const previews = new PreviewService(path.join(directory, 'previews'), async id => ({ ...await source(id), read: async () => { const bytes = await fs.readFile(fileURLToPath(id)); metrics.reads++; metrics.sourceBytes += bytes.length; return bytes; } }), { concurrency: 4 });
  const videos = new VideoService(path.join(directory, 'videos'), source), images = new BrowserImages(previews, source);
  videos.attachImageBrowser(images); const base = await videos.startServer();
  const token = images.create(records, records[Number(process.env.GALLERY_QA_START_INDEX || 0)].id, Number(process.env.GALLERY_QA_RESOLUTION || 2048), 'zh');
  console.log(JSON.stringify({ directory, sourceFolder, total: records.length, base, viewer: `${base}/images/${token}/viewer` }));
  const shutdown = async () => { images.dispose(); previews.dispose(); videos.dispose(); await Promise.allSettled([previews.initialized, previews.eviction, videos.initialized, videos.pruning]); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); process.exit(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  setInterval(() => console.log(JSON.stringify(metrics)), 30000);
})().catch(error => { console.error(error); process.exitCode = 1; });
