import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeCaption, encodeCaption } from './captionCodec';

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

interface CaptionDocument {
  text: string;
  exists: boolean;
  revision: string;
  hasBom: boolean;
  eol: 'lf' | 'crlf';
}

interface WebviewMessage {
  type?: string;
  id?: string;
  caption?: string;
  baseRevision?: string;
  requestId?: string;
  reason?: string;
  dirty?: boolean;
}

const MISSING_CAPTION_REVISION = 'missing';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'imageCaptionGallery.open',
      async (selectedUri?: vscode.Uri) => {
        const imageUri = resolveSelectedImage(selectedUri);
        if (imageUri) {
          const root = imageUri.with({ path: path.posix.dirname(imageUri.path) });
          await openGallery(context, root, imageUri);
          return;
        }

        const root = await resolveRoot(selectedUri);
        if (!root) {
          return;
        }

        await openGallery(context, root);
      },
    ),
  );
}

function resolveSelectedImage(selectedUri?: vscode.Uri): vscode.Uri | undefined {
  if (selectedUri) {
    return isImageUri(selectedUri) ? selectedUri : undefined;
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
  const baseTitle = `Image Caption Gallery — ${path.posix.basename(root.path)}`;
  const panel = vscode.window.createWebviewPanel(
    'imageCaptionGallery.gallery',
    baseTitle,
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
      if (pendingInitialImageId && initialImageUri) {
        imageById.set(pendingInitialImageId, initialImageUri);
        await panel.webview.postMessage({
          type: 'initialImage',
          image: toImageRecord(root, initialImageUri, panel.webview),
        });
      }

      const imageUris = await scanImages(root);
      imageById = new Map(imageUris.map((uri) => [uri.toString(), uri]));
      const images = imageUris.map((uri) => toImageRecord(root, uri, panel.webview));
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
    async (message: WebviewMessage) => {
      if (message.type === 'ready' || message.type === 'refresh') {
        await sendImages();
        return;
      }

      if (message.type === 'dirtyState') {
        panel.title = `${message.dirty ? '● ' : ''}${baseTitle}`;
        return;
      }

      if (message.type === 'confirmUnsaved' && message.requestId) {
        const reason = message.reason === 'hideText'
          ? 'hiding the Text pane'
          : message.reason === 'gallery'
            ? 'returning to the Gallery'
            : 'switching images';
        const choice = await vscode.window.showWarningMessage(
          `Save caption changes before ${reason}?`,
          { modal: true },
          'Save',
          'Discard',
          'Continue Editing',
        );
        await panel.webview.postMessage({
          type: 'unsavedDecision',
          requestId: message.requestId,
          decision: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'continue',
        });
        return;
      }

      if (message.type === 'confirmDiscard' && message.requestId) {
        const choice = await vscode.window.showWarningMessage(
          'Discard the unsaved caption changes?',
          { modal: true },
          'Discard',
          'Continue Editing',
        );
        await panel.webview.postMessage({
          type: 'discardDecision',
          requestId: message.requestId,
          decision: choice === 'Discard' ? 'discard' : 'continue',
        });
        return;
      }

      const imageId = message.id;
      const imageUri = imageId ? imageById.get(imageId) : undefined;
      if (!imageId || !imageUri) {
        return;
      }

      const captionUri = sidecarUri(imageUri);

      if (message.type === 'loadCaption') {
        try {
          const caption = await readCaption(captionUri);
          await postCaption(panel.webview, 'caption', imageId, caption);
        } catch (error) {
          await panel.webview.postMessage({
            type: 'captionError',
            id: message.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (
        message.type === 'saveCaption'
        && typeof message.caption === 'string'
        && typeof message.baseRevision === 'string'
      ) {
        try {
          const current = await readCaption(captionUri);
          if (current.revision !== message.baseRevision) {
            const choice = await vscode.window.showWarningMessage(
              'This caption changed outside Image Caption Gallery while you were editing it.',
              { modal: true, detail: 'Choose Overwrite to save your draft, or Reload to use the latest file contents.' },
              'Overwrite',
              'Reload',
              'Continue Editing',
            );

            if (choice === 'Reload') {
              await postCaption(panel.webview, 'captionReloaded', imageId, current);
              return;
            }

            if (choice !== 'Overwrite') {
              await panel.webview.postMessage({ type: 'captionSaveCancelled', id: message.id });
              return;
            }
          }

          const saved = await writeCaption(captionUri, message.caption, current);
          await postCaption(panel.webview, 'captionSaved', imageId, saved);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Could not save caption: ${messageText}`);
          await panel.webview.postMessage({
            type: 'captionSaveError',
            id: message.id,
            message: messageText,
          });
        }
      }
    },
    undefined,
    context.subscriptions,
  );
}

function toImageRecord(
  root: vscode.Uri,
  uri: vscode.Uri,
  webview: vscode.Webview,
): ImageRecord {
  return {
    id: uri.toString(),
    name: path.posix.basename(uri.path),
    relativePath: relativePath(root, uri),
    source: webview.asWebviewUri(uri).toString(),
  };
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

async function readCaption(uri: vscode.Uri): Promise<CaptionDocument> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const decoded = decodeCaption(bytes);
    return {
      text: decoded.text,
      exists: true,
      revision: decoded.revision,
      hasBom: decoded.hasBom,
      eol: decoded.eol,
    };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return {
        text: '',
        exists: false,
        revision: MISSING_CAPTION_REVISION,
        hasBom: false,
        eol: 'lf',
      };
    }
    throw error;
  }
}

async function writeCaption(
  uri: vscode.Uri,
  text: string,
  template: CaptionDocument,
): Promise<CaptionDocument> {
  const bytes = encodeCaption(text, {
    hasBom: template.exists && template.hasBom,
    eol: template.exists ? template.eol : 'lf',
  });
  await vscode.workspace.fs.writeFile(uri, bytes);
  return readCaption(uri);
}

async function postCaption(
  webview: vscode.Webview,
  type: 'caption' | 'captionReloaded' | 'captionSaved',
  id: string,
  caption: CaptionDocument,
): Promise<void> {
  await webview.postMessage({
    type,
    id,
    caption: caption.text,
    renderedCaption: await renderMarkdown(caption.text),
    exists: caption.exists,
    revision: caption.revision,
  });
}

async function renderMarkdown(caption: string): Promise<string> {
  try {
    return await vscode.commands.executeCommand<string>('markdown.api.render', caption) ?? '';
  } catch {
    return `<pre>${escapeHtml(caption)}</pre>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

  <section id="detail-view" class="detail-view hidden" tabindex="-1">
    <header class="detail-header">
      <div class="image-header">
        <button id="back" class="button">← Gallery</button>
        <strong class="column-title">Image</strong>
        <span id="detail-path" class="detail-path"></span>
        <span class="image-dimensions" title="Original image dimensions (width × height)" aria-label="Original image dimensions: width by height">
          <span id="image-width" class="dimension-value">—</span>
          <span class="dimension-separator">×</span>
          <span id="image-height" class="dimension-value">—</span>
        </span>
        <button id="show-text" class="button text-restore hidden" title="Show Text pane" aria-label="Show Text pane">Text ‹</button>
      </div>
      <div class="header-divider" aria-hidden="true"></div>
      <div class="text-header">
        <strong class="column-title">Text</strong>
        <span id="editing-label" class="editing-label hidden">Editing .txt</span>
        <label id="caption-mode-control" class="mode-control">
          <span class="visually-hidden">Text view</span>
          <select id="caption-mode" aria-label="Text view mode">
            <option value="markdown" selected>Markdown</option>
            <option value="raw">Raw text</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label class="zoom-control" title="Text size percentage">
          <span>Font</span>
          <select id="text-zoom" aria-label="Text size percentage">
            <option value="70">70%</option>
            <option value="80">80%</option>
            <option value="90">90%</option>
            <option value="100" selected>100%</option>
            <option value="110">110%</option>
            <option value="120">120%</option>
            <option value="130">130%</option>
            <option value="140">140%</option>
            <option value="150">150%</option>
            <option value="160">160%</option>
            <option value="170">170%</option>
            <option value="180">180%</option>
          </select>
        </label>
        <span id="edit-state" class="edit-state hidden" aria-live="polite">Unsaved</span>
        <button id="edit-caption" class="button header-action" type="button">Edit</button>
        <div id="edit-actions" class="edit-actions hidden">
          <button id="cancel-edit" class="icon-button" type="button" title="Discard edits (Escape)" aria-label="Discard edits">×</button>
          <button id="save-edit" class="icon-button primary-action" type="button" title="Save caption (Control or Command S)" aria-label="Save caption">✓</button>
        </div>
        <button id="hide-text" class="icon-button pane-toggle" type="button" title="Hide Text pane" aria-label="Hide Text pane">›</button>
      </div>
    </header>
    <main class="detail-content">
      <div class="image-pane">
        <button id="previous" class="image-navigation previous" title="Previous image (Left Arrow)" aria-label="Previous image">‹</button>
        <div id="image-stage" class="image-stage" title="Pinch to zoom · Drag or two-finger scroll to pan · Double-click to reset">
          <img id="detail-image" alt="Selected image" draggable="false">
        </div>
        <button id="next" class="image-navigation next" title="Next image (Right Arrow)" aria-label="Next image">›</button>
        <div class="navigation-hint">← / → 切换图片 · Switch images</div>
      </div>
      <div id="splitter" class="splitter" role="separator" aria-label="Resize image and text panes" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="80" aria-valuenow="64" tabindex="0"></div>
      <aside class="caption-pane">
        <div id="caption-preview" class="caption-preview markdown-view" aria-live="polite"></div>
        <textarea id="caption-editor" class="caption-editor hidden" aria-label="Caption editor" spellcheck="false"></textarea>
      </aside>
    </main>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate(): void {}
