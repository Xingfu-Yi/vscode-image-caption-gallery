// Run on the source host. Returns numeric diagnostics only; never exports media.
// GALLERY_COMPARISON_RUNTIME=/installed/extension/dist node test/verifyComparisonHost.cjs folder
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const runtime = process.env.GALLERY_COMPARISON_RUNTIME || path.join(__dirname, '../dist');
const { BrowserImages } = require(path.join(runtime, 'browserImages')), { PreviewService } = require(path.join(runtime, 'previewService')), { VideoService } = require(path.join(runtime, 'videoService'));
(async () => {
  const folder = path.resolve(process.argv[2]), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-comparison-host-'));
  let reads = 0, sourceBytes = 0;
  const records = (await fs.readdir(folder)).filter(name => /\.(jpe?g|png|webp|gif|bmp|avif|dng|cr2|nef|arw)$/i.test(name)).sort().slice(0, 2).map(name => ({ id: pathToFileURL(path.join(folder, name)).href, name, relativePath: name }));
  assert.equal(records.length, 2, 'The folder must contain two supported images.');
  const source = async id => { const filePath = fileURLToPath(id), stat = await fs.stat(filePath); return { filePath, mtime: stat.mtimeMs, size: stat.size }; };
  const before = await Promise.all(records.map(image => source(image.id)));
  const previews = new PreviewService(path.join(directory, 'previews'), async id => ({ ...await source(id), read: async () => { const bytes = await fs.readFile(fileURLToPath(id)); reads++; sourceBytes += bytes.length; return bytes; } }), { concurrency: 2 });
  const browser = new BrowserImages(previews, source), videos = new VideoService(path.join(directory, 'videos'), source); videos.attachImageBrowser(browser);
  try {
    const base = await videos.startServer(), token = browser.createComparison(records, 2048, 'en', { showingReference: true });
    const url = name => `${base}/images/${token}/${name}`;
    const state = await (await fetch(url('state'))).json(); assert.equal(state.images.length, 2); assert.equal(state.comparison.showingReference, true); assert.equal(reads, 0);
    const rounds = [];
    for (const round of ['cold', 'warm']) {
      const started = performance.now(), priorReads = reads;
      const images = await Promise.all(records.map(async (_, side) => {
        const response = await fetch(url(`image/${side}`)); assert.equal(response.status, 200);
        const bytes = (await response.arrayBuffer()).byteLength;
        const dimension = key => Number(response.headers.get(`X-Image-${key}`));
        const width = dimension('Width'), height = dimension('Height'); assert.ok(width * height <= 2048 ** 2);
        return { width, height, originalWidth: dimension('Original-Width'), originalHeight: dimension('Original-Height'), bytes };
      }));
      if (round === 'warm') assert.equal(reads, priorReads, 'Warm preview reads must use the cache.');
      rounds.push({ round, milliseconds: Math.round(performance.now() - started), sourceReads: reads - priorReads, images });
    }
    assert.deepEqual(await Promise.all(records.map(image => source(image.id))), before, 'Source files must remain unchanged.');
    browser.release(token); assert.equal((await fetch(url('state'))).status, 404);
    console.log(JSON.stringify({ node: process.version, sourceCount: records.length, sourceBytes, rounds, sourceMetadataUnchanged: true, captionReads: 0, revokedSession: true }));
  } finally {
    browser.dispose(); previews.dispose(); videos.dispose(); await Promise.allSettled([previews.initialized, previews.eviction, videos.initialized, videos.pruning]);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
