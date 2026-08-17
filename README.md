# Image Caption Gallery

[English](README.md) | [简体中文](README.zh-CN.md)

A fast, local-first VS Code extension for browsing image datasets and editing sidecar captions without leaving the editor.

Open a folder as an adjustable thumbnail gallery, select an image, and review or edit its matching `.txt` caption beside it. Captions stay read-only by default and can be rendered as Markdown, raw text, or formatted JSON.

## Preview

### Gallery overview

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-overview.jpg" alt="Image Caption Gallery showing an adjustable image dataset gallery" width="100%">
</p>

### Image and Markdown caption

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-detail-en.jpg" alt="Image Caption Gallery showing an image beside an English Markdown caption" width="100%">
</p>

### Caption editing

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-detail-zh.jpg" alt="Image Caption Gallery editing a same-name TXT caption with save and cancel controls" width="100%">
</p>

## Features

- Open a folder or selected image from the Explorer context menu.
- Launch instantly with `Command+Option+G` (`⌘⌥G`) on macOS or `Ctrl+Alt+G` on Windows/Linux.
- Recursively discover `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, and `.avif` files.
- Resize gallery thumbnails continuously from 96 px to 480 px.
- Search images by filename or relative path.
- Read, edit, and create same-name `.txt` sidecar captions with an explicit Edit mode.
- Render captions as Markdown by default, with Raw text and formatted JSON modes.
- Save with `Command+S` / `Ctrl+S`, or cancel with `Escape`.
- Confirm before switching images, returning to Gallery, or hiding Text when a draft is unsaved.
- Detect external file changes before saving and choose to overwrite, reload, or continue editing.
- Preserve UTF-8 BOM and LF/CRLF line endings whenever an existing caption is updated.
- Drag the center divider to resize the Image and Text panes.
- Hide the Text pane for a full-width, image-only view and restore it with the compact **Text ‹** control.
- Keep every image fully visible without cropping, even after resizing the window or divider.
- Zoom from 25% to 400% with a trackpad pinch or `Ctrl/Command + wheel`.
- Pan an enlarged image by dragging or two-finger scrolling, and double-click to restore the original fitted view.
- Show the original `width × height` resolution as right-aligned values in stable four-character fields.
- Scale caption text from 70% to 180% with a compact dropdown.
- Switch images with `Left` / `Right` or the translucent image-edge controls.
- Return to the gallery with `Escape` while preserving search and thumbnail state.
- Work with local folders and VS Code Remote SSH workspaces.

## Install

Install directly from the VS Code Marketplace:

```bash
code --install-extension xingfu-yi.image-caption-gallery --force
```

You can also download the latest `.vsix` from [GitHub Releases](https://github.com/Xingfu-Yi/vscode-image-caption-gallery/releases) and run **Extensions: Install from VSIX...** from the VS Code Command Palette.

When using Remote SSH, install the extension in the remote extension host. If you run the command in a remote terminal, copy the `.vsix` to the remote machine first and use its remote path.

## Usage

1. Open a folder that contains images and matching caption files.
2. Right-click an image or folder in Explorer and select **Image Caption Gallery**. You can also select an image and press the launch shortcut.
3. Adjust the thumbnail size or search the gallery.
4. Select an image to open the side-by-side Image and Text view.
5. Select **Edit** to change the caption. Use `Command+S` / `Ctrl+S` or the checkmark to save; use `Escape` or × to cancel.

If the matching `.txt` file does not exist, Edit starts with an empty draft and Save creates the file. If another program changes the caption while you are editing, Image Caption Gallery asks whether to overwrite it, reload the external version, or keep editing your draft.

### Shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Open Image Caption Gallery | `Command+Option+G` (`⌘⌥G`) | `Ctrl+Alt+G` |
| Save caption while editing | `Command+S` | `Ctrl+S` |
| Cancel caption editing | `Escape` | `Escape` |
| Previous / next image | `Left` / `Right` | `Left` / `Right` |
| Zoom image | Trackpad pinch or `Command + wheel` | Touchpad pinch or `Ctrl + wheel` |
| Pan enlarged image | Drag or two-finger scroll | Drag or two-finger scroll |
| Reset image view | Double-click image | Double-click image |
| Return to gallery | `Escape` | `Escape` |

## Dataset layout

The caption file must use the same base name as the image:

```text
dataset/
├── image-001.jpg
├── image-001.txt
├── image-002.png
└── image-002.txt
```

## Compatibility

- Visual Studio Code 1.85.0 or newer.
- Local workspaces and VS Code Remote SSH.
- Platform-independent package with no native runtime dependencies.

## Privacy

Image Caption Gallery reads and writes captions directly in the current workspace only when you explicitly save. It does not upload dataset files and does not include telemetry.

## Development

```bash
npm install
npm run compile
```

Open the repository in VS Code and press `F5` to launch an Extension Development Host.

## Roadmap

- Virtualized rendering for very large datasets.
- More configurable caption and metadata file naming.
- Richer sorting and filtering.
- Image metadata and dataset-quality tools.

## Contributing

Issues and pull requests are welcome. Please keep changes focused and describe how you tested local and Remote SSH behavior.

## License

[MIT](LICENSE)
