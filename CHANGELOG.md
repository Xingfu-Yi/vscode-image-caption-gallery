# Changelog

## 0.11.9

- Refresh the Marketplace overview so two-image comparison and Caption editing are visible before the long feature list, with a clean synthetic comparison screenshot and concise A/B workflow summary.
- Highlight the `E` editing shortcut, protected Caption workflow, linked comparison views and Remote SSH preview path in both English and Chinese documentation and package metadata.

## 0.11.8

- Add `E` as a detail-view shortcut to start editing the current Caption and focus the editor. If Caption is hidden or still loading, reveal and load it first, then enter editing automatically.
- Leave Gallery, settings, comparison, text fields, native video controls and modified/repeated keys untouched; keep the existing save, discard and unsaved-draft protections.

## 0.11.7

- Add **Gallery** navigation to the independent browser image, video and comparison viewers. Return in the same tab to the original mixed-media result set, then open another card without returning to VS Code.
- Preserve browser Gallery search, scroll position and current selection. Video returns retain position, quality, speed, volume and mute state; browser Gallery never requests Caption files.
- Virtualize browser Gallery rows for very large folders. Listing remains metadata-only, DOM stays viewport-bounded, and only visible image thumbnails or video first-frame posters load with four-request concurrency and cancellation.
- Keep browser Gallery behind the existing random private capability and Remote SSH loopback forwarding. Add same-tab routing, session-expiry, child-view cleanup, special-path copying, 100,000-record and zero-Caption regressions.

## 0.11.6

- Add Copy File Path to right-click / trackpad secondary-click menus for Gallery cards, image/video details, comparison panes and independent browser viewers. Copy validated original host paths, preserving literal special characters and Remote SSH paths.
- Keep macOS comparison selection and caption editing menus; dismiss file menus before viewer Escape actions, retain the displayed-image target during pending navigation, and report clipboard failures with retry.

## 0.11.5

- Overlap two bounded compatibility-fragment requests with the existing host processing slots, while keeping MediaSource appends serial. Cancel obsolete seek work and prioritize the new playing fragment.
- Buffer about 20 seconds of viewing time with rate-aware, bounded lookahead and encoded-memory limits in Gallery and browser playback. Preserve paused single-fragment loading and direct seeking.
- Cap input decoder threads and drop surplus source frames before explicit preview transforms. Refresh compatibility caches without changing quality or output frame-rate settings.
- Add exposed host queue/encode/cache timings and buffering diagnostics; reject empty fragments and cover reverse seeks, out-of-order responses, cancellation and byte pressure.

## 0.11.4

- Remove the floating arrow above the image divider. Keep mouse switching in the compact toolbar as Left: A / Left: B, alongside hold-Space comparison.
- Preserve original-resolution headers, the 350 ms entry delay and the two-stage Escape selection flow.

## 0.11.3

- Show each displayed image’s original resolution in the comparison header, keeping it visible beside truncated filenames in panel and browser views.
- Preserve A/B selections when returning to Gallery. A second fresh Escape clears them; key repeat does not clear the pair, and returning never restarts automatic entry.
- Keep the 350 ms selection confirmation delay and cover resolution changes, original-image fallback, and two-stage Escape behavior.

## 0.11.2

- Clear both A/B selections when leaving comparison, while preserving Gallery scroll and decoded previews for later reuse.
- Keep both selection markers visible for 350 ms before automatic entry. Cancel pending entry on deselection, clearing, search/refresh, ordinary preview opening, Settings, Escape, hiding or loss of focus; manual Compare remains immediate.
- Add controlled-clock regressions for delayed entry, repeated pairs, both exit actions and cancelled/obsolete selections.

## 0.11.1

- Keep Ctrl/Command image selection in Gallery when the trailing click loses modifier flags or arrives after pointerup. Consume each selection gesture once, preserve Ctrl context-menu suppression, and retain ordinary pointer/keyboard opening.
- Add regressions for delayed modifier-free clicks, first/second selection, and following ordinary and keyboard gestures.

## 0.11.0

- Add ordered Ctrl / Command image selection and a shared panel/browser comparison view: A on the left, fixed reference B on the right. Videos remain in the existing viewer.
- Toggle the left pane with the center arrow; hold Space for a temporary B copy, release to restore the mouse state. Reset held keys on blur, page hiding and exit.
- Link fit-relative zoom and normalized pan by default, allow independent views, and preserve both cameras when switching A/B. Keep small screens side by side.
- Decode A, B and an independent B copy before enabling switches. Reuse protected preview caches, account for the extra decoded image, pause ordinary neighbour preloading and make ready switches without more network/decoding/Caption requests.
- Open true browser fullscreen with the current pair, quality, cameras and toggle state using private, expiring SSH-forwarded sessions. Hide controls after two idle seconds; retain per-side retry/original actions, file-version checks and configuration invalidation.
- Preserve the 0.10.1 video encoder/timestamp fix and 0.10.2 special-filename URI fix. Add selection, keyboard, camera, lifecycle, browser handoff and synthetic real-Chrome regression checks.

## 0.10.2

- Fix whole-folder loading failures and direct file opening for literal percent signs in local and Remote SSH filenames by removing duplicate URI-path decoding. Preserve literal percent escapes such as `%20` and `%2F` in labels and paths.
- Add local/SSH regressions for nested special-character filenames, original previews, video discovery and matching captions; make the test URI serializer encode paths correctly.

## 0.10.1

- Fix first-fragment WebM playback failures caused by the experimental native Vorbis encoder writing blocks out of timestamp order. Select FFmpeg builds with libvorbis and give an actionable error for explicitly configured builds without it.
- Invalidate previous compatibility-fragment caches; add encoder-discovery, raw WebM block-order, distant-seek and obsolete-cache regression tests.

## 0.10.0

- Make the visible Full screen button and F shortcut available for images as well as videos, including narrow detail toolbars. Add an image fullscreen entry in Settings; from Gallery it starts at the first matching image.
- Add a private browser image viewer with real, user-initiated fullscreen, left/right and Home/End navigation, touch swipes, and buttons/cursor that hide after two idle seconds. Preserve portrait/landscape aspect ratios without cropping, with no Caption or VS Code chrome in fullscreen.
- Reuse host previews and SSH private forwarding; download and decode adjacent images early, retain up to seven images within a 128 MiB decoded-memory estimate, merge in-flight preloads, and keep the previous image during slow changes. Skip oversized background downloads without reducing requested quality.
- Validate file versions in the background, cancel unused requests, protect active transfers with cache leases, and keep browser sessions independent of Gallery. Opening an image viewer never reads captions or changes unsaved drafts.
- Add fullscreen handoff, filtering, cache invalidation, memory budget and private-route tests, plus a read-only real-source browser harness. Verify native fullscreen, hidden controls and warm navigation in Chrome over SSH.

## 0.9.0

- Start neighbour preparation at host queue admission and continue the pipeline when adopting a pending neighbour. Prioritize foreground images, then neighbours, then grid thumbnails.
- Reuse decoded elements and retain up to seven recent details within a 128 MiB estimated decoded-memory LRU. Keep a labelled previous frame or target thumbnail during slow switches and delay loading indicators by 150 ms.
- Separate image switch-to-paint latency from host processing, resource loading and explicit browser decoding; preserve Caption freshness, hidden-caption zero reads and unsaved edits.
- Add a private standalone browser player for Full screen, F and video double-click. Transfer playback state, use user-initiated native fullscreen and hide controls after two idle seconds. Retain Fill panel as a separate settings action.
- Serve supported browser originals by byte range; bundle HLS.js 1.7.3 and its Apache license for requested H.264/AAC MPEG-TS fragments, independent of Gallery sessions. No whole-video conversion or public server port.
- Serialize MediaSource updates, reject abort/close operations, ignore stale seeks and allow one state-preserving recovery. Log concrete decoder and fragment diagnostics in the Video output channel.
- Add real-source SSH navigation and actual VS Code playback harnesses, private-browser-session/HLS tests, cache/prefetch/transition coverage and rapid-cancellation regressions. See docs/performance-0.9.0.md for measured results and limitations.

## 0.8.1

- Decode JPEG grid thumbnails at a reduced size instead of expanding full-resolution pixels. Remove bulky camera metadata while preserving ICC color profiles and EXIF orientation.
- Deliver WebP thumbnails up to 256 KiB inline, avoiding an additional Remote SSH resource request; keep leased resource fallback for larger outputs and detail images.
- Remove duplicate native lazy loading for image cards, prioritize visible rows, adapt the in-flight request count to decoder capacity, and release stalled or failed thumbnail slots.
- Hide empty/broken image placeholders and expose queue, processing and message/display timings on hover.
- Raise the bounded pixel cache to 384 MiB for large PNGs and reserve 768 MiB per decoder when choosing automatic concurrency.
- Add low-memory JPEG, large PNG, inline transport, viewport priority and timeout recovery tests, a repeatable folder benchmark, and a browser harness using 287 generated JPEGs.

## 0.8.0

- Add Original / 2K (1440p) / 1080p / 720p video quality controls below the picture and in Settings. Default to the lower of source resolution and 2K, with proportional landscape/portrait bounds and no upscaling.
- Apply quality caps to codec-compatible originals as well as compatibility fragments. Continue byte-range original playback when codecs and dimensions allow; never prepare whole-video copies.
- Retain position, playing/paused state, speed, volume and Caption drafts during quality changes; request the saved fragment first and cancel stale selections.
- Remove the permanent compatibility banner and centered video fallback overlay. Show loading, concrete decode errors and fallback actions below the picture, with details in Settings.
- Finish finite streams when the last fragment is buffered, avoiding a stall when the final audio samples end early.
- Migrate legacy quality preferences and add geometry, real 4K scaling, restart-at-position, hidden-panel and rapid-quality-change regression coverage.

## 0.7.2

- Send small first-frame JPEGs inline with poster results, avoiding an extra Remote SSH resource fetch; remove duplicate native lazy loading behind the Gallery visibility scheduler.
- Show first-frame preparation/failure states, cancel stalled requests and release grid slots, and expose byte size, cache and timing details on hover.
- Give short poster extraction an independently bounded 1–4-job CPU lane; use single-thread decoding/filtering/encoding and limited probing with one compatibility fallback.
- Serve persisted poster cache hits before FFmpeg discovery; preserve deduplication, leases, source invalidation and stale-response protection.
- Add eight-card, inline transport, timeout/failure, cache-before-tools, extraction fallback and busy-playback regression tests, plus a real eight-video browser harness.

## 0.7.1

- Add a visible Caption toggle to the detail toolbar for images and videos, with a C shortcut and existing unsaved-edit protection.
- Add video focus mode (F or double-click), filling Gallery without reloading the stream; temporarily hide Caption and restore the previous layout on Escape.
- Expose the VS Code window full-screen command from Settings and focused playback, since native HTML video fullscreen is blocked in webviews. Keep window fullscreen and Gallery focus independent.
- Add 0.25×–4× playback-speed settings, synchronizing native rate changes and retaining speed across seeks and video switches.
- Add Caption, focus/draft/restore, speed and fixed full-screen command regression tests; document the controls and fullscreen limitation in English and Chinese.

## 0.7.0

- Stream compatible original videos over private loopback HTTP with byte-range seeking and automatic VS Code Remote SSH forwarding.
- Replace whole-file compatibility conversion with requested four-second VP8/Vorbis fragments, a full MediaSource timeline, bounded nearby buffering, distant seeking and cancellation.
- Generate only first-frame JPEG posters for visible video cards; share and prioritize work, cache requested fragments/posters, and protect visible posters from eviction.
- Default compatibility playback to a maximum height of 720p, with 480/720/1080/2160/original choices in Settings and VS Code configuration; retain original video dimensions in the header.
- Check actual FFmpeg encoders and remove the libmp3lame requirement; offer native fallback when compatibility fails.
- Inline bundled styles and scripts in the initial webview HTML to avoid an unstyled startup while fetching remote assets.
- Add real range, fragment, poster, cache, cancellation, private-forwarding and MediaSource regression tests plus a 40-second streaming browser harness. Update English and Chinese instructions.

## 0.6.0

- Replace the serial decoder with a reusable multiprocess pool on the extension host; support Worker threads as a lower-IPC alternative and as a fallback when child processes cannot start.
- Automatically select 1–4 decoders from CPU/free-memory budgets, or choose 1–8 manually with CPU/total-memory caps. Expose execution mode and parallelism in Settings and VS Code machine settings.
- Preserve priority, deduplication and cache leases; cancel unowned active work, isolate decoder failures, and release idle decoders after 30 seconds. Share session settings across Gallery panels without writing workspace files.
- Use scaled JPEG decoding for resized details and faster WebP encoding while retaining the configured dimensions, quality, alpha, orientation and animation behavior.
- Show queue, source read, host processing, cache write and browser transfer/decode timings separately in Settings, including cache hits and actual execution mode.
- Add real subprocess PID/reuse/fallback, cancellation, concurrency, memory-budget, session UI and timing regression tests plus a repeatable preview benchmark.

## 0.5.2

- Show original and preview dimensions beneath the current filename without opening Settings; clear stale dimensions when switching files.
- Use adequately sized, correctly oriented embedded camera JPEG previews in TIFF-based RAW containers, with scaled JPEG decoding and faster WebP encoding.
- Keep the configured pixel budget; reject undersized/aspect-mismatched previews and lossless sensor JPEG strips, and retain full LibRaw decoding for unavailable previews or original-resolution requests.
- Version RAW preview caches and retain embedded-preview metadata across cache restoration; add RAW fallback, malformed metadata, byte-order, rotation, cache and visible-dimensions regression tests.

## 0.5.1

- Preload and decode the previous and next detail images after the current image is ready; swap decoded elements on warm navigation without a loading flash or duplicate transfers.
- Preload adjacent captions only while Caption is visible, show cached text immediately, and revalidate quietly without overwriting edits.
- Promote adopted requests above background work, cancel obsolete requests, retain at most three detail entries, and release neighbours when hiding the panel or leaving details.
- Skip speculative images above 64 MiB estimated decoded RGBA per neighbour, including animation frames; keep videos on demand and preserve configured preview quality.
- Avoid reloading the opened image when its initial directory scan completes; invalidate neighbours after refresh or preview-setting changes.
- Add decoding, warm navigation, caption freshness, cancellation, priority, memory-budget and Remote SSH regression coverage.

## 0.5.0

- Consolidate display and playback preferences into an accessible Settings drawer available from Gallery and details, with explanations in English or Chinese.
- Keep a compact single-row toolbar; move Caption format/font, dimensions, zoom, thumbnail size and compatibility controls into Settings.
- Add auto/side-by-side/stacked layout selection, image-share and image-zoom sliders, and independent drawer scrolling down to 320 px windows.
- Apply preview quality and video settings to the current Gallery without writing workspace configuration; link to VS Code settings for new-gallery defaults.
- Preserve caption drafts, video playback, keyboard focus and Escape behavior when using settings; remove blurred navigation effects and reduce image padding.
- Add Settings, session preference, responsive UI and configuration-override regression coverage, plus generated development previews.

## 0.4.1

- Virtualize Gallery rows so DOM size and decoded image memory stay bounded as directories grow; retain scroll position and keyboard access to offscreen files.
- Use separate static 512² WebP thumbnails and cap active thumbnail loads at four; keep detail resolution and animation behavior.
- Release grid resources when opening details or hiding a panel, and debounce full-dataset search.
- Stream directory metadata in batches of 512 with stale-scan cancellation and compact final ordering.
- Replace per-request cache sorting with reference counts, byte accounting, LRU map order and coalesced eviction; restore metadata with bounded parallel I/O.
- Add 100,000-record grid, search, navigation, incremental scan and thumbnail regression coverage.

## 0.4.0

- Discover MP4, WebM, MOV, M4V, AVI, MKV and other FFmpeg video containers from folders and Explorer/editor context menus, alongside image and camera RAW files.
- Add an on-demand native video player with playback, seek, volume, fullscreen and Space play/pause; show video dimensions in the header.
- Use lightweight video cards in Gallery without fetching video contents during scanning or grid browsing.
- Share TXT caption editing and full-width browsing with videos; preserve drafts when switching between media types.
- Pause playback on panel hiding and release media sources when changing files or returning to Gallery; ignore stale video responses.
- Add optional host-side FFmpeg/ffprobe compatibility processing with H.264/MP3 output, AAC audio conversion, progress, cancellation, deduplication and a leased 512 MiB disk cache.
- Expose auto/native compatibility mode and a machine-scoped FFmpeg path; provide manual re-encoding after native playback errors.
- Document local/Remote SSH tool requirements and add real AAC/AVI conversion, cache, cancellation and playback regression tests plus generated video fixtures.

## 0.3.0

- Discover camera RAW files, including DNG, CR2/CR3, NEF/NRW, ARW, RAF, ORF, RW2 and other LibRaw camera containers, from folders and image context menus.
- Force the camera RAW decoder instead of showing embedded TIFF thumbnails; use camera white balance, sRGB output, and oriented original dimensions.
- Convert RAW to WebP even below the resolution limit or when resizing is disabled; Load original requests a full-resolution decoded image.
- Increase default pinch zoom sensitivity fivefold and raise the zoom limit to 800%; expose `imageCaptionGallery.zoomSensitivity` for live adjustment.
- Normalize wheel units, limit individual zoom steps, and show a clickable percentage to reset the fitted view.
- Add real Bayer DNG decoding, RAW remote-resource, and gesture regression tests.

## 0.2.0

- Add host-side proportional previews with a configurable total pixel limit, defaulting to 2048²; set `imageCaptionGallery.maxPreviewResolution` to `0` for originals.
- Generate previews on the Remote SSH host, share cached resources across thumbnails and details, and prioritize detail requests in a background Worker.
- Bundle a platform-independent WASM32 ImageMagick runtime; retain transparency, EXIF orientation, and GIF/WebP animations in WebP previews.
- Add a 256 MiB LRU preview cache with active resource protection, cancellation, and explicit Load original recovery.
- Add `imageCaptionGallery.showCaption` and a Gallery toolbar toggle; image-only mode no longer loads or renders captions, and restoring Text reloads the latest caption.
- Keep original dimensions in the header, show preview dimensions on hover, and protect drafts during image resolution changes.
- Add processing, cache, Worker, remote resource, and webview regression coverage.

## 0.1.0

- Add an explicit, safe editing mode for existing or new same-name `.txt` captions.
- Save with `Command+S` or `Ctrl+S`, cancel with `Escape`, and protect every in-page navigation action from discarding unsaved work.
- Detect external caption changes before saving, with Overwrite, Reload, and Continue Editing choices.
- Preserve UTF-8 BOM and LF/CRLF line endings for existing files; create new captions as UTF-8 with LF endings.
- Add a session-persistent Text-pane hide mode for distraction-free image review.
- Replace the Text font slider with a compact 70%–180% dropdown.
- Shorten the Marketplace description to explain the image-and-TXT workflow at a glance.

## 0.0.9

- Replace the generic extension icon with a distinctive Image, Text, and adjustable-divider brand mark.
- Preserve the high-resolution transparent source artwork while shipping an optimized 256 × 256 PNG in the VSIX.

## 0.0.8

- Restore all three GitHub and Marketplace preview images with shared, stable GitHub raw HTTPS URLs.
- Add the Gallery overview and refresh both detail screenshots with larger Image and Text panes.
- Keep images fully contained in the available pane and recompute their fitted size after window or divider resizing.
- Add gesture-only 25%–400% zoom, mouse-drag and two-finger pan, and double-click reset without adding header controls.
- Replace the image-list position with right-aligned `width × height` values in stable four-character fields.
- Open a selected image immediately while its directory is discovered in the background, and defer all Fit work until the detail image has loaded.
- Load Gallery thumbnails only when they approach the visible viewport.

## 0.0.7

- Ship the bilingual Marketplace README and initial product screenshots inside the VSIX.
- Show the macOS launcher as `Command+Option+G` (`⌘⌥G`) in user-facing documentation.
- Use the Marketplace extension identifier in installation instructions so they stay current across releases.

## 0.0.6

- Add a unified, column-aligned header with Image metadata on the left and Text controls on the right.
- Rename the caption column to **Text**.
- Add a draggable, keyboard-accessible divider that remembers its split ratio.
- Add persistent Text scaling from 70% to 180%, defaulting to 100%.

## 0.0.5

- Move detail controls into a compact overlay on the image pane so captions use the full height.
- Replace top navigation buttons with translucent image-edge arrows and a bilingual keyboard hint.
- Remove caption editing, auto-save, and save-state UI; all caption modes are now read-only.
- Keep Markdown as the default view, with read-only Raw text and formatted JSON alternatives.

## 0.0.4

- Use one concise **Image Caption Gallery** action for both folders and images.
- Show the global gallery shortcut alongside its Explorer context-menu action.
- Support plain Left/Right navigation when the caption editor is not focused.
- Render captions as Markdown by default, with Raw text editing and formatted JSON views.

## 0.0.3

- Add an Explorer and image-editor context action for opening the selected image.
- Add `Command+Option+G` (`⌘⌥G`) on macOS and `Ctrl+Alt+G` on Windows/Linux as the default launcher shortcut.
- Open the selected image's folder and jump directly into its caption detail view.

## 0.0.2

- Lower the minimum supported VS Code version from 1.125.0 to 1.85.0.
- Align development type definitions with the VS Code 1.85 extension API.
- Mark the extension as a workspace extension so Remote SSH installs it on the remote host.

## 0.0.1

- Adjustable thumbnail gallery with a compact toolbar.
- Side-by-side image and caption detail view.
- Previous/next keyboard navigation and caption auto-save.
- Local and Remote SSH-compatible file access through the VS Code API.
