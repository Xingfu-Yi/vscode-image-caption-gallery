// Real Chrome smoke/performance check using synthetic media only.
// GALLERY_PLAYWRIGHT_MODULE=/path/to/playwright node test/compareBrowserSmoke.cjs
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { fileURLToPath } = require('node:url');
const { chromium } = require(process.env.GALLERY_PLAYWRIGHT_MODULE || 'playwright');
const { createHost } = require('./helpers/host'), { initializeProcessor } = require('../dist/previewProcessor');
(async () => {
  const cleanup = [], host = await createHost({ after: fn => cleanup.push(fn) }, { maxPreviewResolution: 2048, showCaption: true });
  let browser, server;
  try {
    const magick = await initializeProcessor();
    for (const [name, width, height, color] of [['A.png', 3200, 1800, magick.MagickColors.Red], ['B.png', 1800, 3200, magick.MagickColors.CornflowerBlue]]) {
      const png = magick.ImageMagick.read(color, width, height, image => image.write(magick.MagickFormat.Png, bytes => Buffer.from(bytes)));
      await fs.writeFile(path.join(host.dataset, name), png);
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route('https://resources.test/**', async route => {
      const file = fileURLToPath(new URL(route.request().url()).searchParams.get('uri'));
      await route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.webp') ? 'image/webp' : 'image/png' });
    });
    await context.addInitScript(() => {
      window.__decodeCount = 0; const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () { window.__decodeCount++; return decode.call(this); };
    });
    const panel = await context.newPage();
    const errors = []; panel.on('pageerror', error => errors.push(error.message));
    await panel.exposeFunction('hostPost', message => host.panel.receive(message));
    await panel.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => { void window.hostPost(message); } }); });
    host.panel.webview.postMessage = async message => { host.sent.push(message); if (!panel.isClosed()) await panel.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message); return true; };
    server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(host.panel.webview.html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await panel.goto(`http://127.0.0.1:${server.address().port}/panel`); await panel.locator('.image-card').first().waitFor();
    await panel.locator('.image-card').nth(0).click({ modifiers: ['Meta'] }); await panel.locator('.image-card').nth(1).click({ modifiers: ['Meta'] });
    assert.equal(await panel.locator('.comparison-marker').count(), 2, 'show both selection markers before automatic entry');
    assert.equal(await panel.locator('.compare-view').count(), 0);
    await panel.waitForSelector('.compare-view[data-ready=true]', { timeout: 45000 });
    assert.equal(host.sent.some(message => message.type === 'caption'), false);
    await panel.evaluate(() => { window.__right = document.querySelector('[data-side="1"] img'); });
    const previewCount = host.sent.filter(message => message.type === 'preview').length;
    const measure = async page => page.evaluate(async () => {
      const count = window.__decodeCount, samples = [];
      for (let i = 0; i < 60; i++) {
        const start = performance.now(); document.querySelector('.compare-toggle').click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); samples.push(performance.now() - start);
      }
      if (window.__decodeCount !== count) throw new Error('Hot switches decoded again.');
      samples.sort((a, b) => a - b); return { samples: samples.length, p95Ms: samples[Math.ceil(samples.length * .95) - 1], maxMs: samples.at(-1) };
    });
    const panelTiming = await measure(panel); assert.ok(panelTiming.p95Ms <= 100);
    assert.equal(await panel.evaluate(() => window.__right === document.querySelector('[data-side="1"] img')), true);
    assert.equal(host.sent.filter(message => message.type === 'preview').length, previewCount);
    const stage = panel.locator('.compare-stage').first(), box = await stage.boundingBox();
    await stage.dispatchEvent('wheel', { deltaY: -40, ctrlKey: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await panel.mouse.down(); await panel.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30); await panel.mouse.up();
    await panel.locator('[data-action=link]').click(); await panel.locator('.compare-stage').nth(1).dispatchEvent('wheel', { deltaY: -20, ctrlKey: true }); await panel.locator('.compare-toggle').click();
    await panel.screenshot({ path: '/private/tmp/gallery-compare-panel.png' });
    await panel.locator('[data-action=fullscreen]').click(); await panel.waitForFunction(() => !document.querySelector('[data-action=fullscreen]').disabled);
    const handoff = host.sent.findLast(message => message.type === 'browserComparisonOpened'); assert.equal(handoff.opened, true);
    const page = await context.newPage(), requests = []; page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.openedUrls.at(-1)); await page.waitForSelector('.compare-view[data-ready=true]', { timeout: 45000 });
    assert.equal(await page.locator('.compare-view').getAttribute('data-showing-reference'), 'true'); assert.equal(await page.locator('[data-action=link]').textContent(), 'Independent');
    assert.equal(await page.locator('.compare-zoom').first().textContent(), await panel.locator('.compare-zoom').first().textContent());
    const before = requests.length, browserTiming = await measure(page); assert.ok(browserTiming.p95Ms <= 100); assert.equal(requests.length, before);
    await page.locator('[data-action=fullscreen]').click(); assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), true);
    await page.keyboard.press('Space'); assert.equal(await page.locator('.compare-view').getAttribute('data-showing-reference'), 'true');
    await page.waitForTimeout(2400); assert.equal(await page.locator('.compare-view').evaluate(root => root.classList.contains('compare-idle')), true);
    await page.screenshot({ path: '/private/tmp/gallery-compare-browser.png' });
    await page.keyboard.press('f'); assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false); assert.ok(await page.locator('.compare-view').count());
    await page.setViewportSize({ width: 460, height: 640 });
    const panes = await page.locator('.compare-pane').evaluateAll(panes => panes.map(pane => { const r = pane.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
    assert.equal(panes[0].y, panes[1].y); assert.ok(panes[1].x > panes[0].x); assert.ok(Math.abs(panes[0].width - panes[1].width) <= 1);
    await panel.locator('[data-action=back]').click();
    assert.equal(await panel.locator('.comparison-marker').count(), 2, 'exit preserves both selections');
    await panel.locator('#comparison-help').press('Escape');
    assert.equal(await panel.locator('.comparison-marker, .comparison-selected').count(), 0, 'second Escape clears both selections');
    assert.deepEqual(errors, []);
    const result = { panel: panelTiming, browser: browserTiming, hotSwitchRequests: requests.length - before, additionalCaptions: host.sent.filter(message => message.type === 'caption').length, trueFullscreen: true, smallScreenSideBySide: true };
    await fs.writeFile('/private/tmp/gallery-compare-smoke.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); for (const finish of cleanup) await finish(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
