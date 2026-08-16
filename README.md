# Image Caption Gallery

A focused VS Code extension for browsing image datasets and previewing sidecar captions.

It combines two modes in one editor tab:

1. A clean, searchable image gallery with a continuously adjustable thumbnail-size slider.
2. A detail view with the image on the left and its prompt/caption on the right.

## Features

- Open a folder or image from the single **Image Caption Gallery** Explorer action.
- See the launch shortcut directly in the Explorer context menu.
- Launch from anywhere with `Cmd+Alt+G` on macOS or `Ctrl+Alt+G` on Windows/Linux.
- Recursively discover `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, and `.avif` images.
- Resize thumbnails from 96 px to 480 px instead of choosing a fixed column count.
- Search by filename or relative path.
- Click any thumbnail to open a side-by-side image/caption viewer.
- Read same-name `.txt` sidecar captions without modifying dataset files.
- Render captions as Markdown by default, with read-only Raw text and formatted JSON modes.
- Navigate with translucent image-edge controls or plain `Left` / `Right`.
- Return to the gallery with `Escape` while preserving the gallery state.
- Work with local folders and VS Code Remote SSH workspaces.

## Compatibility

- Visual Studio Code 1.85.0 or newer.
- Local workspaces and VS Code Remote SSH.
- No native runtime dependencies; the packaged extension is platform-independent.

## Dataset layout

```text
dataset/
├── image-001.jpg
├── image-001.txt
├── image-002.png
└── image-002.txt
```

## Run locally

```bash
npm install
npm run compile
```

Open this repository in VS Code and press `F5`. In the Extension Development Host, open a folder containing images and run **Image Caption Gallery**.

To test the focused-image workflow, click an image in Explorer and press `Cmd+Alt+G` on macOS or `Ctrl+Alt+G` on Windows/Linux. You can also right-click either an image or a folder and choose **Image Caption Gallery**.

## Current status

This repository starts with a functional MVP. Planned improvements include virtualized rendering for very large datasets, configurable caption formats, richer sorting/filtering, image metadata, and packaged releases.

## Contributing

Issues and pull requests are welcome. Please keep changes focused and describe how you tested local and Remote SSH behavior.

## License

[MIT](LICENSE)
