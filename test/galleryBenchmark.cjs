// Synthetic DOM benchmark; image decoding and disk/network I/O are intentionally separate.
// Usage: node test/galleryBenchmark.cjs [count] [project-directory]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { JSDOM } = require('jsdom');
const count = Number(process.argv[2]) || 10000;
const root = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const dom = new JSDOM(fs.readFileSync(path.join(root, 'test/webviewHarness.html'), 'utf8'), {runScripts:'outside-only',pretendToBeVisual:true});
const { window } = dom;
window.acquireVsCodeApi = () => ({getState:()=>({}),setState(){},postMessage(){}});
window.ResizeObserver = class {observe(){} disconnect(){}};
window.IntersectionObserver = class {observe(){} unobserve(){} disconnect(){}};
window.requestAnimationFrame = () => 0;
const grid = path.join(root, 'media/galleryGrid.js');
if (fs.existsSync(grid)) { window.eval(fs.readFileSync(grid, 'utf8')); }
window.eval(fs.readFileSync(path.join(root, 'media/main.js'), 'utf8'));
const images = Array.from({length:count}, (_,index)=>({id:`frame-${index}`,name:`frame-${index}.jpg`,relativePath:`dataset/frame-${index}.jpg`}));
const started = performance.now();
window.dispatchEvent(new window.MessageEvent('message',{data:{type:'images',images}}));
console.log(JSON.stringify({count,renderMs:Number((performance.now()-started).toFixed(1)),cards:window.document.querySelectorAll('.image-card').length,domNodes:window.document.querySelectorAll('*').length}));
dom.window.close();
