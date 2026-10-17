// Ship a self-contained WASM32 runtime, without platform-specific native modules.
const fs = require('node:fs');
const path = require('node:path');
const runtime = path.dirname(require.resolve('@imagemagick/magick-wasm'));
const vendor = path.resolve(__dirname, '../dist/vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const [source, target] of [
  [path.join(runtime, 'index.umd.cjs'), 'magick.cjs'],
  [require.resolve('@imagemagick/magick-wasm/magick.wasm'), 'magick.wasm'],
  [path.join(runtime, '../LICENSE'), 'LICENSE'],
  [path.join(runtime, '../NOTICE'), 'NOTICE'],
]) {
  fs.copyFileSync(source, path.join(vendor, target));
}

const hlsRoot = path.dirname(require.resolve('hls.js/package.json'));
fs.copyFileSync(path.join(hlsRoot, 'dist/hls.min.js'), path.join(vendor, 'hls.min.js'));
fs.copyFileSync(path.join(hlsRoot, 'LICENSE'), path.join(vendor, 'HLS-LICENSE'));
