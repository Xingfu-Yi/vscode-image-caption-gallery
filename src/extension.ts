import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

interface ImageRecord {
  id: string;
  name: string;
  relativePath: string;
  source: string;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'imageCaptionGallery.open',
      async (selectedUri?: vscode.Uri) => {
        const root = await resolveRoot(selectedUri);
        if (!root) {
          return;
        }

        await openGallery(context, root);
      },
    ),
    vscode.commands.registerCommand(
      'imageCaptionGallery.openSelected',
      async (selectedUri?: vscode.Uri) => {
        const imageUri = resolveSelectedImage(selectedUri);
        if (!imageUri) {
          await vscode.window.showWarningMessage(
            'Select or open a supported image, then run Image Caption Gallery again.',
          );
          return;
        }

        const root = imageUri.with({ path: path.posix.dirname(imageUri.path) });
        await openGallery(context, root, imageUri);
      },
    ),
  );
}

function resolveSelectedImage(selectedUri?: vscode.Uri): vscode.Uri | undefined {
  if (selectedUri && isImageUri(selectedUri)) {
    return selectedUri;
  }

  const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    activeTabInput instanceof vscode.TabInputText
    || activeTabInput instanceof vscode.TabInputCustom
  ) {
    return isImageUri(activeTabInput.uri) ? activeTabInput.uri : undefined;
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  return activeEditorUri && isImageUri(activeEditorUri) ? activeEditorUri : undefined;
}

function isImageUri(uri: vscode.Uri): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(uri.path).toLowerCase());
}

async function resolveRoot(selectedUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (selectedUri) {
    const stat = await vscode.workspace.fs.stat(selectedUri);
    return stat.type & vscode.FileType.Directory
      ? selectedUri
      : selectedUri.with({ path: path.posix.dirname(selectedUri.path) });
  }

  if (vscode.workspace.workspaceFolders?.length === 1) {
    return vscode.workspace.workspaceFolders[0].uri;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open Image Gallery',
  });

  return picked?.[0];
}

async function openGallery(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
  initialImageUri?: vscode.Uri,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'imageCaptionGallery.gallery',
    `Image Caption Gallery — ${path.posix.basename(root.path)}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri, root],
    },
  );

  panel.webview.html = getHtml(context, panel.webview);

  let imageById = new Map<string, vscode.Uri>();
  let pendingInitialImageId = initialImageUri?.toString();

  const sendImages = async (): Promise<void> => {
    await panel.webview.postMessage({ type: 'loading' });
    try {
      const imageUris = await scanImages(root);
      imageById = new Map(imageUris.map((uri) => [uri.toString(), uri]));
      const images: ImageRecord[] = imageUris.map((uri) => ({
        id: uri.toString(),
        name: path.posix.basename(uri.path),
        relativePath: relativePath(root, uri),
        source: panel.webview.asWebviewUri(uri).toString(),
      }));
      const initialImageId = pendingInitialImageId && imageById.has(pendingInitialImageId)
        ? pendingInitialImageId
        : undefined;
      pendingInitialImageId = undefined;
      await panel.webview.postMessage({ type: 'images', images, initialImageId });
    } catch (error) {
      await panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  panel.webview.onDidReceiveMessage(
    async (message: { type?: string; id?: string; caption?: string }) => {
      if (message.type === 'ready' || message.type === 'refresh') {
        await sendImages();
        return;
      }

      const imageUri = message.id ? imageById.get(message.id) : undefined;
      if (!imageUri) {
        return;
      }

      const captionUri = sidecarUri(imageUri);

      if (message.type === 'loadCaption') {
        const caption = await readCaption(captionUri);
        await panel.webview.postMessage({
          type: 'caption',
          id: message.id,
          caption,
        });
      }

      if (message.type === 'saveCaption') {
        await vscode.workspace.fs.writeFile(
          captionUri,
          new TextEncoder().encode(message.caption ?? ''),
        );
        await panel.webview.postMessage({ type: 'saved', id: message.id });
      }
    },
    undefined,
    context.subscriptions,
  );
}

async function scanImages(root: vscode.Uri): Promise<vscode.Uri[]> {
  const images: vscode.Uri[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }

    const entries = await vscode.workspace.fs.readDirectory(directory);
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) && !EXCLUDED_DIRECTORIES.has(name)) {
        pending.push(vscode.Uri.joinPath(directory, name));
        continue;
      }

      if ((type & vscode.FileType.File) && IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        images.push(vscode.Uri.joinPath(directory, name));
      }
    }
  }

  return images.sort((left, right) => left.path.localeCompare(right.path));
}

async function readCaption(uri: vscode.Uri): Promise<string> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return '';
    }
    throw error;
  }
}

function sidecarUri(imageUri: vscode.Uri): vscode.Uri {
  return imageUri.with({ path: imageUri.path.replace(/\.[^/.]+$/, '.txt') });
}

function relativePath(root: vscode.Uri, file: vscode.Uri): string {
  const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
  return decodeURIComponent(file.path.startsWith(rootPath)
    ? file.path.slice(rootPath.length)
    : file.path);
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'style.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
  const defaultThumbnailSize = vscode.workspace
    .getConfiguration('imageCaptionGallery')
    .get<number>('defaultThumbnailSize', 220);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Image Caption Gallery</title>
</head>
<body data-default-thumbnail-size="${defaultThumbnailSize}">
  <section id="gallery-view">
    <header class="toolbar">
      <strong class="brand">Image Caption Gallery</strong>
      <input id="search" class="search" type="search" placeholder="Search images…" aria-label="Search images">
      <label class="size-control" title="Thumbnail size">
        <span>Size</span>
        <input id="thumbnail-size" type="range" min="96" max="480" step="8" aria-label="Thumbnail size">
        <output id="thumbnail-size-value"></output>
      </label>
      <span id="count" class="muted">0 images</span>
      <button id="refresh" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
    </header>
    <main id="gallery" class="gallery" aria-live="polite"></main>
    <div id="empty" class="empty">Loading images…</div>
  </section>

  <section id="detail-view" class="detail-view hidden">
    <header class="toolbar detail-toolbar">
      <button id="back" class="button">← Gallery</button>
      <span id="detail-path" class="detail-path"></span>
      <span id="position" class="muted"></span>
      <button id="previous" class="icon-button" title="Previous image (Alt+Left)" aria-label="Previous image">←</button>
      <button id="next" class="icon-button" title="Next image (Alt+Right)" aria-label="Next image">→</button>
      <span id="save-state" class="save-state">Saved</span>
    </header>
    <main class="detail-content">
      <div class="image-pane">
        <img id="detail-image" alt="Selected image">
      </div>
      <div class="caption-pane">
        <label for="caption">Prompt / Caption</label>
        <textarea id="caption" spellcheck="false" placeholder="No caption yet. Start typing to create a same-name .txt file."></textarea>
        <p class="hint">Auto-saves after typing · Ctrl/Cmd+S to save now · Esc to return</p>
      </div>
    </main>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate(): void {}
