# Image Caption Gallery

A focused VS Code extension for browsing image datasets and editing sidecar captions.

It combines two modes in one editor tab:

1. A clean, searchable image gallery with a continuously adjustable thumbnail-size slider.
2. A detail view with the image on the left and its prompt/caption on the right.

## Features

- Open a folder from the Explorer context menu or Command Palette.
- Recursively discover `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, and `.avif` images.
- Resize thumbnails from 96 px to 480 px instead of choosing a fixed column count.
- Search by filename or relative path.
- Click any thumbnail to open a side-by-side image/caption editor.
- Read and write same-name `.txt` sidecar captions.
- Create a missing `.txt` caption file on first save.
- Navigate with toolbar buttons or `Alt+Left` / `Alt+Right`.
- Return to the gallery with `Escape` while preserving the gallery state.
- Work with local folders and VS Code Remote SSH workspaces.

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

Open this repository in VS Code and press `F5`. In the Extension Development Host, open a folder containing images and run **Image Caption Gallery: Open Gallery**.

## Current status

This repository starts with a functional MVP. Planned improvements include virtualized rendering for very large datasets, configurable caption formats, richer sorting/filtering, image metadata, and packaged releases.

## Contributing

Issues and pull requests are welcome. Please keep changes focused and describe how you tested local and Remote SSH behavior.

## License

[MIT](LICENSE)
