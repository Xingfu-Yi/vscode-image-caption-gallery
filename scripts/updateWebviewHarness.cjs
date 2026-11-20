// Regenerate the static preview from the extension HTML, keeping the fixture bridge.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHost } = require('../test/helpers/host');
(async () => {
  const target = path.join(__dirname, '../test/webviewHarness.html');
  const old = await fs.readFile(target, 'utf8');
  const fixture = old.match(/  <script>\s*const demoSvg[\s\S]*?<\/script>/)?.[0];
  const style = old.match(/  <style>[\s\S]*?<\/style>/)?.[0];
  if (!fixture || !style) { throw new Error('Missing harness fixtures or theme'); }
  const cleanup = [];
  const host = await createHost({ after: (fn) => cleanup.push(fn) }, { maxPreviewResolution: 2048, videoCompatibility: 'auto' });
  try {
    await Promise.all(host.context.subscriptions.filter((item) => item.initialized).map((item) => item.initialized));
    let html = host.panel.webview.html
      .replace(/  <meta http-equiv="Content-Security-Policy"[^>]+>\n/, '')
      .replace(/  <style nonce="[^"]+">[\s\S]*?<\/style>/, '<link rel="stylesheet" href="../media/style.css">\n<link rel="stylesheet" href="../media/compareView.css">\n<link rel="stylesheet" href="../media/fileContextMenu.css">\n'+style)
      .replace(/<title>[^<]+<\/title>/, `<title>Image Caption Gallery ${require('../package.json').version} Preview</title>`)
      .replace(/  <script nonce="[^"]+">[\s\S]*?<\/script>\n/g, '')
      .replace('</body>', fixture+'\n  <script src="../media/galleryGrid.js"></script>\n  <script src="../media/videoStream.js"></script>\n  <script src="../media/fileContextMenu.js"></script>\n  <script src="../media/compareView.js"></script>\n  <script src="../media/main.js"></script>\n</body>');
    await fs.writeFile(target, html);
    console.log('Updated test/webviewHarness.html from the compiled extension HTML.');
  } finally { for (const fn of cleanup) { await fn(); } }
})().catch((error) => { console.error(error); process.exitCode = 1; });
