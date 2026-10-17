# Image fullscreen verification — 0.10.0

Image and video details now share the visible **Full screen / 全屏** button and F shortcut. Images open a standalone browser viewer through the existing private loopback / SSH forward; a click on **View full screen / 进入全屏** enters the browser's native Fullscreen API. Gallery itself does not change VS Code layout settings.

Verified behavior:

- True browser fullscreen (`document.fullscreenElement`), landscape 1600 × 900 and portrait 900 × 1600 fit without cropping. Toolbar, left/right arrows and cursor disappear after two idle seconds. Interaction restores controls; Escape or F exits fullscreen without returning to Gallery.
- Left/right, Home/End, rapid forward/reverse input, reuse of the same decoded image element, delayed switching feedback, bounded history and decoded-memory eviction. Cached adjacent navigation makes no duplicate image request.
- File-version revalidation, page refresh restarting its request sequence, old-page request rejection, session expiry, private route validation, failed browser handoff cleanup and preservation of forwarding path/query.
- No Caption requests in the image browser. Opening it preserves Gallery's unsaved Caption editor and visibility. Search order is copied at opening and videos are skipped.
- Original image bytes and transparent PNG previews are preserved; oversize background originals are skipped. RAW/EXIF/animation processing continues through the shared, regression-tested preview service.

Real-source check used the existing SSH Home folder `20260603__车展模特8__0a70cb07a609`, containing 286 images. The first 4912 × 7360 JPEG was delivered as an approximately 2048²-pixel WebP preview (1673 × 2506, about 304 KiB). In six already-decoded neighbour transitions, switch-to-next-paint was about 2–17 ms with no duplicate target requests or Caption reads. This is a small warm-cache sample, not a cold-load guarantee. Cold images still require host processing and SSH transfer.

Automated coverage includes `test/browserImages.test.js`, `test/browserImagesClient.test.js`, and image handoff assertions in `test/webview.test.js`, along with all existing preview and video tests. All 152 tests pass on Node 25.9 and the minimum Node 18.18.2. `test/serveImageBrowserHarness.cjs` starts a private, read-only harness; set `GALLERY_QA_SOURCE_FOLDER` to use a real image directory and `GALLERY_QA_RESOLUTION` to select its pixel budget. Its generated previews live only in an owned temporary directory. No source media are changed.

Browser sessions keep the preview quality selected at opening, remain usable after Gallery closes, and expire after 30 inactive minutes. Disconnecting SSH or closing VS Code stops the service. Fullscreen requires a browser user gesture; Gallery therefore opens the browser first and the viewer presents its fullscreen button.
