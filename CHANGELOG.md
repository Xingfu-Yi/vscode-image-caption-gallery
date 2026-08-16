# Changelog

## 0.0.7

- Fit images to the currently available pane without cropping and recompute the fit after window or divider resizing.
- Add persistent 25%–400% image zoom, drag-to-pan, Fit reset, double-click reset, and Ctrl/Command-wheel zooming.
- Open a selected image immediately while its directory is discovered in the background, and defer all Fit work until the detail image has loaded.
- Load Gallery thumbnails only when they approach the visible viewport.
- Ship the bilingual Marketplace README and both product screenshots inside the VSIX.
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
