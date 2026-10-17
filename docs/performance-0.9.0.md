# 0.9.0 verification

Measured on the same SSH host, 2048² detail preview setting and four decoder processes. The read-only source gallery contained 286 images (mostly 4912 × 7360 JPEGs). The navigation harness compares the previous and new client scheduling/cache using the same preview service and separate temporary caches; timings include SSH transfer and a browser frame after readiness.

| Scenario | Previous client | New client |
| --- | ---: | ---: |
| Ten immediate forward switches, mean | 1117 ms | 592 ms |
| Six switches through recent history, mean | 170 ms | 28 ms |
| Thirty already-decoded adjacent switches, P95 | 33 ms | 33 ms |
| Redundant neighbour preview requests during those warm switches | 30 | 0 |

The immediate-forward P95 remained about 1.17 seconds: a cold image still needs CPU work when navigation outruns preloading. The warm P95 target of ≤100 ms passed with no loading overlay or repeat preview requests. Adjacent warm switching already worked in the previous client; the improvement is earlier overlap and retained history. Uncached 36 MP JPEG detail processing still took about 0.85 seconds on this host. Results vary with CPU, source format, network and reading time; no instantaneous cold-load guarantee is made.

Actual VS Code 1.115 / Electron 39 tests exercised the reported eight-second 1080p MOV and 129-second 4K MOV, including the four-second boundary and a jump to 97 seconds. Baseline playback also passed in this isolated run, so the original intermittent error was not conclusively reproduced. The fix addresses observed abort/disposal/stale-update defects and preserves concrete diagnostics for further failures.

Chrome exercised the same real SSH originals, Original/2K/1080p/720p, inherited position/speed and actual fullscreen with auto-hiding controls. A 97-second start requested segment 24 rather than preparing preceding segments. Original media were not modified. Safari's native-HLS fallback is implemented but not covered by this Chrome/VS Code run.

Reproduction: `test/serveNavigationHarness.cjs` accepts `GALLERY_QA_SOURCE_FOLDER` and optional `GALLERY_QA_OLD_MAIN`; it writes host caches only to temporary directories. `test/vscodePlayback.cjs` runs via VS Code `--extensionTestsPath`, with `GALLERY_QA_CASES` (stream descriptors) and `GALLERY_QA_RESULT` paths in an isolated user directory.
