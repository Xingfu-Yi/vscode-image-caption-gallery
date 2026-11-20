import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { decodeCaption, encodeCaption } from './captionCodec';
import { settingsHtml } from './settingsHtml';
import { normalizePlaybackState, type BrowserPlaybackState } from './browserPlayer';
import { BrowserGallery } from './browserGallery';
import { BrowserImages } from './browserImages';
import { PreviewService } from './previewService';
import { normalizeVideoQuality, VideoService } from './videoService';
import { MEDIA_EXTENSIONS, isCameraRaw, isVideo } from './imageFormats';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

interface MediaRecord {
  id: string;
  name: string;
  relativePath: string;
  kind: 'image' | 'video';
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
  detail?: boolean;
  original?: boolean;
  prefetch?: boolean;
  concurrency?: number;
  mode?: string;
  videoMaxHeight?: number;
  compatible?: boolean;
  resolution?: number;
  videoCompatibility?: string;
  ffmpegPath?: string;
  playback?: Partial<BrowserPlaybackState>;
  diagnostics?: unknown;
  search?: string;
  ids?: string[];
  comparison?: unknown;
}

const MISSING_CAPTION_REVISION = 'missing';

export function activate(context: vscode.ExtensionContext): void {
  const previews = new PreviewService(
    vscode.Uri.joinPath(context.globalStorageUri, 'previews').fsPath,
    async (id) => {
      const uri = vscode.Uri.parse(id);
      const stat = await vscode.workspace.fs.stat(uri);
      return { mtime: stat.mtime, size: stat.size, read: async () => vscode.workspace.fs.readFile(uri) };
    },
    { concurrency: vscode.workspace.getConfiguration('imageCaptionGallery').get<number>('previewConcurrency', 0), backend: vscode.workspace.getConfiguration('imageCaptionGallery').get<string>('previewExecutionMode', 'process') === 'thread' ? 'thread' : 'process' },
  );
  const videos = new VideoService(
    vscode.Uri.joinPath(context.globalStorageUri, 'videos').fsPath,
    async (id) => {
      const uri = vscode.Uri.parse(id);
      const stat = await vscode.workspace.fs.stat(uri);
      return { filePath: uri.fsPath, mtime: stat.mtime, size: stat.size };
    },
  );
  const browserImages = new BrowserImages(previews, async (id) => {
    const uri = vscode.Uri.parse(id), stat = await vscode.workspace.fs.stat(uri);
    return { filePath: uri.fsPath, mtime: stat.mtime, size: stat.size };
  });
  videos.attachImageBrowser(browserImages);
  const browserGallery = new BrowserGallery({ previews, videos,
    source: async (id) => { const uri = vscode.Uri.parse(id), stat = await vscode.workspace.fs.stat(uri); return { filePath: uri.fsPath, mtime: stat.mtime, size: stat.size }; },
    filePath: id => vscode.Uri.parse(id).fsPath,
    open: async (record, records, gallery, settings, input) => {
      if (record.kind === 'video') {
        const state = normalizePlaybackState({ ...input, quality: input?.quality ?? settings.videoMaxHeight });
        const token = await videos.createBrowserPlayer(record.id, record.name, { mode: 'auto', ffmpegPath: settings.ffmpegPath }, state, gallery);
        return { path: `/v1/${token}/player`, release: () => videos.releaseBrowser(token) };
      }
      const token = browserImages.create(records.filter(record => record.kind === 'image'), record.id, settings.resolution, vscode.env.language, gallery);
      return { path: `/images/${token}/viewer`, release: () => browserImages.release(token) };
    },
  });
  videos.attachGallery(browserGallery); browserImages.attachGallery(browserGallery);
  context.subscriptions.push(browserGallery, browserImages, previews, videos);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('imageCaptionGallery.previewExecutionMode')) {
      previews.setBackend(vscode.workspace.getConfiguration('imageCaptionGallery').get<string>('previewExecutionMode', 'process'));
    }
    if (event.affectsConfiguration('imageCaptionGallery.previewConcurrency')) {
      previews.setConcurrency(vscode.workspace.getConfiguration('imageCaptionGallery').get<number>('previewConcurrency', 0));
    }
  }));
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'imageCaptionGallery.open',
      async (selectedUri?: vscode.Uri) => {
        const imageUri = resolveSelectedMedia(selectedUri);
        if (imageUri) {
          const root = imageUri.with({ path: path.posix.dirname(imageUri.path) });
          await openGallery(context, previews, videos, browserImages, browserGallery, root, imageUri);
          return;
        }

        const root = await resolveRoot(selectedUri);
        if (!root) {
          return;
        }

        await openGallery(context, previews, videos, browserImages, browserGallery, root);
      },
    ),
  );
}

function resolveSelectedMedia(selectedUri?: vscode.Uri): vscode.Uri | undefined {
  if (selectedUri) {
    return isMediaUri(selectedUri) ? selectedUri : undefined;
  }

  const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    activeTabInput instanceof vscode.TabInputText
    || activeTabInput instanceof vscode.TabInputCustom
  ) {
    return isMediaUri(activeTabInput.uri) ? activeTabInput.uri : undefined;
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  return activeEditorUri && isMediaUri(activeEditorUri) ? activeEditorUri : undefined;
}

function isMediaUri(uri: vscode.Uri): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(uri.path).toLowerCase());
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
  previews: PreviewService,
  videos: VideoService,
  browserImages: BrowserImages,
  browserGallery: BrowserGallery,
  root: vscode.Uri,
  initialImageUri?: vscode.Uri,
): Promise<void> {
  const internalVideoBase = await videos.startServer();
  const videoBase = (await vscode.env.asExternalUri(vscode.Uri.parse(internalVideoBase))).toString().replace(/\/$/, '');
  const videoUrl = (token: string, endpoint: string): string => { const url = new URL(videoBase); url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${token}/${endpoint}`; return url.toString(); };
  const baseTitle = `Image Caption Gallery — ${path.posix.basename(root.path)}`;
  const panel = vscode.window.createWebviewPanel(
    'imageCaptionGallery.gallery',
    baseTitle,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri, root, vscode.Uri.file(previews.directory), vscode.Uri.file(videos.directory)],
    },
  );

  panel.webview.html = getHtml(context, panel.webview, root, new URL(videoBase).origin);
  const panelId = crypto.randomBytes(12).toString('hex');
  const requests = new Map<string, AbortController>();
  const previewVersions = new Map<string, { id: string; mtime: number; size: number }>();
  const videoRequests = new Set<string>();
  const captionRequests = new Map<string, AbortController>();
  const disposables: vscode.Disposable[] = [];
  let disposed = false;
  let videoLog: vscode.OutputChannel | undefined;
  let scanSequence = 0;
  const sendPoolStatus = (): void => { void panel.webview.postMessage({ type: 'previewPoolStatus', ...previews.poolStatus }); };
  disposables.push(previews.onConcurrencyChanged(sendPoolStatus));
  const release = (requestId: string): void => {
    requests.get(requestId)?.abort();
    requests.delete(requestId);
    previewVersions.delete(requestId);
    videoRequests.delete(requestId);
    previews.release(`${panelId}/${requestId}`);
    videos.release(`${panelId}/${requestId}`);
  };
  panel.onDidDispose(() => {
    disposed = true;
    for (const requestId of requests.keys()) { release(requestId); }
    for (const controller of captionRequests.values()) { controller.abort(); }
    captionRequests.clear();
    for (const disposable of disposables) { disposable.dispose(); }
  });
  disposables.push(panel.onDidChangeViewState((event) => {
    void panel.webview.postMessage({ type: 'panelVisibility', visible: event.webviewPanel.visible });
  }));
  disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('imageCaptionGallery.maxPreviewResolution', root)) {
      for (const requestId of requests.keys()) { if (!videoRequests.has(requestId)) { release(requestId); } }
      void panel.webview.postMessage({ type: 'previewConfigurationChanged', resolution: vscode.workspace.getConfiguration('imageCaptionGallery', root).get<number>('maxPreviewResolution', 2048) });
    }
    if (event.affectsConfiguration('imageCaptionGallery.videoCompatibility', root)
      || event.affectsConfiguration('imageCaptionGallery.ffmpegPath', root) || event.affectsConfiguration('imageCaptionGallery.videoPreviewMaxHeight', root)) {
      for (const requestId of videoRequests) { release(requestId); }
      void panel.webview.postMessage({ type: 'videoConfigurationChanged', videoCompatibility: vscode.workspace.getConfiguration('imageCaptionGallery', root).get<string>('videoCompatibility', 'auto'), ffmpegPath: vscode.workspace.getConfiguration('imageCaptionGallery', root).get<string>('ffmpegPath', 'ffmpeg'), videoMaxHeight: vscode.workspace.getConfiguration('imageCaptionGallery', root).get<number>('videoPreviewMaxHeight', 1440) });
    }
    if (event.affectsConfiguration('imageCaptionGallery.zoomSensitivity', root)) {
      void panel.webview.postMessage({ type: 'zoomConfigurationChanged', sensitivity: readZoomSensitivity(root) });
    }
  }));

  let imageById = new Map<string, vscode.Uri>();
  let galleryRecords: MediaRecord[] = initialImageUri ? [toMediaRecord(root, initialImageUri)] : [];
  const createBrowserGallery = (message: WebviewMessage, selected: string, resolution?: number) => {
    const query = typeof message.search === 'string' ? message.search.slice(0, 4096).trim().toLocaleLowerCase() : '';
    const records = galleryRecords.filter(record => !query || record.relativePath.toLocaleLowerCase().includes(query));
    const config = vscode.workspace.getConfiguration('imageCaptionGallery', root);
    const executable = typeof message.ffmpegPath === 'string' && message.ffmpegPath.length > 0 && message.ffmpegPath.length <= 4096 && !message.ffmpegPath.includes('\0') ? message.ffmpegPath : config.get<string>('ffmpegPath', 'ffmpeg');
    const token = browserGallery.create(records, selected, {
      resolution: resolution ?? (typeof message.resolution === 'number' ? message.resolution : config.get<number>('maxPreviewResolution', 2048)),
      videoMaxHeight: normalizeVideoQuality(message.playback?.quality ?? message.videoMaxHeight ?? config.get<number>('videoPreviewMaxHeight', 1440)), ffmpegPath: executable, search: typeof message.search === 'string' ? message.search.slice(0, 4096).trim() : '',
    }, vscode.env.language);
    return { token, records, link: browserGallery.link(token, selected)! };
  };
  let pendingInitialImageId = initialImageUri?.toString();

  const sendImages = async (): Promise<void> => {
    const sequence = ++scanSequence;
    await panel.webview.postMessage({ type: 'loading', scanId: sequence });
    try {
      if (pendingInitialImageId && initialImageUri) {
        imageById.set(pendingInitialImageId, initialImageUri);
        await panel.webview.postMessage({
          type: 'initialImage',
          image: toMediaRecord(root, initialImageUri),
        });
      }

      const nextById = new Map<string, vscode.Uri>();
      const records: MediaRecord[] = [];
      galleryRecords = records;
      let batch: MediaRecord[] = [];
      let streamed = false;
      const isCancelled = (): boolean => disposed || sequence !== scanSequence;
      const flush = async (): Promise<void> => {
        if (!batch.length || isCancelled()) { return; }
        const outgoing = batch; batch = [];
        streamed = true;
        await panel.webview.postMessage({ type: 'imageBatch', scanId: sequence, images: outgoing });
      };
      await scanMedia(root, isCancelled, async (uri) => {
        const record = toMediaRecord(root, uri);
        nextById.set(record.id, uri);
        imageById.set(record.id, uri); // Visible streamed records may be opened before scanning finishes.
        records.push(record);
        batch.push(record);
        if (batch.length >= 512) { await flush(); }
      });
      if (isCancelled()) { return; }
      imageById = nextById;
      const initialImageId = pendingInitialImageId && imageById.has(pendingInitialImageId)
        ? pendingInitialImageId : undefined;
      pendingInitialImageId = undefined;
      const collator = new Intl.Collator();
      // Only indices travel back at completion: do not resend the full dataset.
      const order = records.map((_, index) => index).sort((a, b) => collator.compare(records[a].relativePath, records[b].relativePath));
      galleryRecords = order.map(index => records[index]);
      if (streamed) {
        await flush();
        if (!isCancelled()) { await panel.webview.postMessage({ type: 'images', scanId: sequence, order, initialImageId }); }
      } else {
        await panel.webview.postMessage({ type: 'images', scanId: sequence, images: order.map((index) => records[index]), initialImageId });
      }
    } catch (error) {
      if (disposed || sequence !== scanSequence) { return; }
      await panel.webview.postMessage({
        type: 'error', scanId: sequence,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  disposables.push(panel.webview.onDidReceiveMessage(
    async (message: WebviewMessage) => {
      if (disposed) { return; }
      if (message.type === 'setPreviewExecutionMode') {
        if (typeof message.mode === 'string') { previews.setBackend(message.mode); }
        return;
      }
      if (message.type === 'setPreviewConcurrency') {
        if (typeof message.concurrency === 'number') { previews.setConcurrency(message.concurrency); }
        return;
      }
      if (message.type === 'getPreviewPool') { sendPoolStatus(); return; }
      if (message.type === 'promotePreview' && message.requestId && requests.has(message.requestId)) {
        previews.promote(`${panelId}/${message.requestId}`);
        return;
      }
      if (message.type === 'releaseCaption' && message.requestId) {
        captionRequests.get(message.requestId)?.abort();
        captionRequests.delete(message.requestId);
        return;
      }
      if (message.type === 'releasePreview' && message.requestId) {
        release(message.requestId);
        return;
      }
      if (message.type === 'toggleWindowFullscreen') {
        if (!panel.visible) { await panel.webview.postMessage({ type: 'windowFullscreenToggled' }); return; }
        let error: string | undefined;
        try { await vscode.commands.executeCommand('workbench.action.toggleFullScreen'); }
        catch { error = 'Could not toggle VS Code full screen. Use View → Appearance → Full Screen.'; }
        if (!disposed) { await panel.webview.postMessage({ type: 'windowFullscreenToggled', error }); }
        return;
      }
      if (message.type === 'openDefaultSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xingfu-yi.image-caption-gallery');
        return;
      }
      if (message.type === 'ready' || message.type === 'refresh') {
        sendPoolStatus();
        await sendImages();
        return;
      }

      if (message.type === 'dirtyState') {
        panel.title = `${message.dirty ? '● ' : ''}${baseTitle}`;
        return;
      }

      if (message.type === 'confirmUnsaved' && message.requestId) {
        const reason = (message.reason === 'hideText' || message.reason === 'videoFocus')
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

      if (message.type === 'openComparisonInBrowser' && message.requestId) {
        let token: string | undefined, galleryToken: string | undefined, error: string | undefined;
        try {
          const ids = message.ids;
          if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]
            || ids.some(id => typeof id !== 'string' || !imageById.has(id) || isVideo(imageById.get(id)!.path))) {
            throw new Error('Select two different images from this Gallery.');
          }
          const records = ids.map(id => galleryRecords.find(record => record.id === id)!);
          if (records.some(record => !record)) { throw new Error('The selected images are no longer in this Gallery.'); }
          const configured = vscode.workspace.getConfiguration('imageCaptionGallery', root).get<number>('maxPreviewResolution', 2048);
          const resolution = typeof message.resolution === 'number' ? message.resolution : configured;
          const gallery = createBrowserGallery(message, ids[0], resolution); galleryToken = gallery.token;
          token = browserImages.createComparison(records, resolution, vscode.env.language, message.comparison, gallery.link);
          const url = new URL(videoBase); url.pathname = `${url.pathname.replace(/\/$/, '')}/images/${token}/viewer`;
          if (!await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) { throw new Error('Could not open the browser comparison.'); }
        } catch (failure) { if (token) { browserImages.release(token); } if (galleryToken) browserGallery.release(galleryToken); error = failure instanceof Error ? failure.message : String(failure); }
        if (!disposed) { await panel.webview.postMessage({ type: 'browserComparisonOpened', requestId: message.requestId, ids: message.ids, opened: !error, error }); }
        return;
      }
      if (message.type === 'copyFilePath' && message.requestId) {
        const uri = typeof message.id === 'string' ? imageById.get(message.id) : undefined;
        let error: string | undefined;
        try {
          if (!uri) { throw new Error('This file is no longer in this Gallery.'); }
          await vscode.env.clipboard.writeText(uri.fsPath);
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        if (!disposed) { await panel.webview.postMessage({ type: 'filePathCopied', id: message.id, requestId: message.requestId, copied: !error, error }); }
        return;
      }
      const imageId = message.id;
      const imageUri = imageId ? imageById.get(imageId) : undefined;
      if (!imageId || !imageUri) {
        return;
      }

      if (message.type === 'videoDiagnostic' && isVideo(imageUri.path)) {
        videoLog ??= vscode.window.createOutputChannel('Image Caption Gallery · Video');
        if (!disposables.includes(videoLog)) { disposables.push(videoLog); }
        videoLog.appendLine(`${new Date().toISOString()} ${path.posix.basename(imageUri.path)} ${JSON.stringify(message.diagnostics ?? {}).slice(0, 4000)}`);
        return;
      }
      if (message.type === 'openImagesInBrowser' && message.requestId && !isVideo(imageUri.path)) {
        let token: string | undefined, galleryToken: string | undefined, error: string | undefined;
        try {
          const configured = vscode.workspace.getConfiguration('imageCaptionGallery', root).get<number>('maxPreviewResolution', 2048);
          const resolution = message.original ? 0 : typeof message.resolution === 'number' ? message.resolution : configured;
          const gallery = createBrowserGallery(message, imageId, resolution); galleryToken = gallery.token;
          token = browserImages.create(gallery.records.filter(record => record.kind === 'image'), imageId, resolution, vscode.env.language, gallery.link);
          const url = new URL(videoBase); url.pathname = `${url.pathname.replace(/\/$/, '')}/images/${token}/viewer`;
          if (!await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) { throw new Error('Could not open the browser image viewer.'); }
        } catch (failure) { if (token) { browserImages.release(token); } if (galleryToken) browserGallery.release(galleryToken); error = failure instanceof Error ? failure.message : String(failure); }
        if (!disposed) { await panel.webview.postMessage({ type: 'browserImagesOpened', id: imageId, requestId: message.requestId, opened: !error, error }); }
        return;
      }
      if (message.type === 'openVideoInBrowser' && message.requestId && isVideo(imageUri.path)) {
        let token: string | undefined, galleryToken: string | undefined, error: string | undefined;
        try {
          const config = vscode.workspace.getConfiguration('imageCaptionGallery', root);
          const executable = typeof message.ffmpegPath === 'string' && message.ffmpegPath.length > 0 && message.ffmpegPath.length <= 4096 && !message.ffmpegPath.includes('\0') ? message.ffmpegPath : config.get<string>('ffmpegPath', 'ffmpeg');
          const gallery = createBrowserGallery(message, imageId); galleryToken = gallery.token;
          token = await videos.createBrowserPlayer(imageId, path.posix.basename(imageUri.path), { mode: 'auto', ffmpegPath: executable }, message.playback || {}, gallery.link);
          if (disposed) { videos.releaseBrowser(token); browserGallery.release(galleryToken); return; }
          const url = new URL(videoUrl(token, 'player')); url.searchParams.set('quality', String(normalizeVideoQuality(message.playback?.quality)));
          if (!await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) { throw new Error('Could not open the browser player.'); }
        } catch (failure) { if (token) { videos.releaseBrowser(token); } if (galleryToken) browserGallery.release(galleryToken); error = failure instanceof Error ? failure.message : String(failure); }
        if (!disposed) { await panel.webview.postMessage({ type: 'browserVideoOpened', id: imageId, requestId: message.requestId, opened: !error, error }); }
        return;
      }

      if (message.type === 'validatePreview' && message.requestId) {
        const requestId = message.requestId;
        const version = previewVersions.get(requestId);
        const controller = requests.get(requestId);
        if (!version || version.id !== imageId || !controller) { return; }
        let changed = false;
        try {
          const stat = await vscode.workspace.fs.stat(imageUri);
          changed = stat.mtime !== version.mtime || stat.size !== version.size;
        } catch { changed = true; }
        if (changed && !disposed && !controller.signal.aborted && previewVersions.get(requestId) === version) {
          await panel.webview.postMessage({ type: 'previewInvalidated', id: imageId, requestId });
        }
        return;
      }

      if (message.type === 'loadVideoPoster' && message.requestId && isVideo(imageUri.path)) {
        const requestId = message.requestId; release(requestId);
        const controller = new AbortController(); requests.set(requestId, controller); videoRequests.add(requestId);
        try {
          const configured = vscode.workspace.getConfiguration('imageCaptionGallery', root).get<string>('ffmpegPath', 'ffmpeg');
          const executable = typeof message.ffmpegPath === 'string' && message.ffmpegPath.length > 0 && message.ffmpegPath.length <= 4096 && !message.ffmpegPath.includes('\0') ? message.ffmpegPath : configured;
          const poster = await videos.posterPreview(imageId, `${panelId}/${requestId}`, controller.signal, executable);
          if (!disposed && !controller.signal.aborted) { await panel.webview.postMessage({ type: 'videoPoster', id: imageId, requestId, source: poster.source, timing: poster.timing }); }
        } catch (error) {
          if (!disposed && !controller.signal.aborted) { await panel.webview.postMessage({ type: 'videoPosterError', id: imageId, requestId, message: error instanceof Error ? error.message : String(error) }); }
          release(requestId);
        }
        return;
      }

      if (message.type === 'loadVideo' && message.requestId && isVideo(imageUri.path)) {
        const requestId = message.requestId;
        release(requestId);
        const controller = new AbortController();
        requests.set(requestId, controller);
        videoRequests.add(requestId);
        try {
          const config = vscode.workspace.getConfiguration('imageCaptionGallery', root);
          const prepared = await videos.get(imageId, `${panelId}/${requestId}`, controller.signal, {
            mode: (message.videoCompatibility === 'auto' || message.videoCompatibility === 'native' ? message.videoCompatibility : config.get<string>('videoCompatibility', 'auto')) === 'native' ? 'native' : 'auto',
            ffmpegPath: typeof message.ffmpegPath === 'string' && message.ffmpegPath.length > 0 && message.ffmpegPath.length <= 4096 && !message.ffmpegPath.includes('\0') ? message.ffmpegPath : config.get<string>('ffmpegPath', 'ffmpeg') || 'ffmpeg',
            maxHeight: normalizeVideoQuality(message.videoMaxHeight ?? config.get<number>('videoPreviewMaxHeight', 1440)),
          }, message.compatible === true);
          if (disposed || controller.signal.aborted) { return; }
          await panel.webview.postMessage({
            type: 'video', id: imageId, requestId,
            source: videoUrl(prepared.token, 'original'), poster: videoUrl(prepared.token, 'poster'),
            converted: prepared.converted, note: prepared.note, duration: prepared.duration, width: prepared.width, height: prepared.height, previewWidth: prepared.previewWidth, previewHeight: prepared.previewHeight,
            stream: prepared.stream ? { ...prepared.stream, base: videoUrl(prepared.token, 'segment/') } : undefined,
          });
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            await panel.webview.postMessage({
              type: 'videoError', id: imageId, requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          release(requestId);
        }
        return;
      }

      if (message.type === 'loadPreview' && message.requestId && !isVideo(imageUri.path)) {
        const requestId = message.requestId;
        release(requestId);
        const controller = new AbortController();
        requests.set(requestId, controller);
        try {
          const stat = await vscode.workspace.fs.stat(imageUri);
          const configured = vscode.workspace.getConfiguration('imageCaptionGallery', root)
            .get<number>('maxPreviewResolution', 2048);
          const selected = typeof message.resolution === 'number' && Number.isSafeInteger(message.resolution) && message.resolution >= 0 && message.resolution <= 65536 ? message.resolution : configured;
          const limit = Number.isSafeInteger(selected) && selected >= 0 ? selected : 2048;
          const thumbnail = !message.detail;
          const resolution = thumbnail ? Math.min(limit || 512, 512) : limit;
          // Browsers cannot display camera RAW, even when no resizing is requested.
          const decode = message.prefetch === true || thumbnail || isCameraRaw(imageUri.path) || (!message.original && resolution !== 0);
          const preview = decode ? await previews.get(
            imageId, message.original && !thumbnail ? 0 : resolution, `${panelId}/${requestId}`, Boolean(message.detail) && !message.prefetch, controller.signal, thumbnail, () => {
              if (!disposed && !controller.signal.aborted && message.detail && !message.prefetch) {
                void panel.webview.postMessage({ type: 'previewProgress', id: imageId, requestId, stage: 'queued' });
              }
            },
          ) : undefined;
          if (disposed || controller.signal.aborted) { return; }
          if (!decode && message.detail && !message.prefetch && !controller.signal.aborted) {
            void panel.webview.postMessage({ type: 'previewProgress', id: imageId, requestId, stage: 'queued' });
          }
          // At most two neighbours, each with <=64 MiB estimated decoded RGBA.
          // Large originals/animations stay on demand, without silently lowering quality.
          if (message.prefetch && preview && preview.width * preview.height * (preview.frameCount ?? 1) > 16 * 1024 * 1024) {
            await panel.webview.postMessage({ type: 'previewSkipped', id: imageId, requestId });
            release(requestId);
            return;
          }
          const inline = thumbnail && preview ? await previews.inlineThumbnail(preview, controller.signal) : undefined;
          if (disposed || controller.signal.aborted) { return; }
          previewVersions.set(requestId, { id: imageId, mtime: stat.mtime, size: stat.size });
          await panel.webview.postMessage({
            type: 'preview', id: imageId, requestId,
            source: inline?.source ?? panel.webview.asWebviewUri(preview?.filePath ? vscode.Uri.file(preview.filePath) : imageUri).toString(),
            inlineBytes: inline?.bytes,
            originalWidth: preview?.originalWidth, originalHeight: preview?.originalHeight,
            width: preview?.width, height: preview?.height, frameCount: preview?.frameCount,
            previewSource: preview?.previewSource,
            timings: preview?.timings,
          });
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            await panel.webview.postMessage({
              type: 'previewError', id: imageId, requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          release(requestId);
        }
        return;
      }

      const captionUri = sidecarUri(imageUri);

      if (message.type === 'loadCaption' && message.requestId) {
        const requestId = message.requestId;
        captionRequests.get(requestId)?.abort();
        const controller = new AbortController();
        captionRequests.set(requestId, controller);
        try {
          const caption = await readCaption(captionUri);
          if (!disposed && !controller.signal.aborted) {
            await postCaption(panel.webview, 'caption', imageId, caption, requestId, controller.signal);
          }
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            await panel.webview.postMessage({
              type: 'captionError', id: imageId, requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          if (captionRequests.get(requestId) === controller) { captionRequests.delete(requestId); }
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
  ));
}

function toMediaRecord(
  root: vscode.Uri,
  uri: vscode.Uri,
): MediaRecord {
  return {
    id: uri.toString(),
    name: path.posix.basename(uri.path),
    relativePath: relativePath(root, uri),
    kind: isVideo(uri.path) ? 'video' : 'image',
  };
}

async function scanMedia(
  root: vscode.Uri, isCancelled: () => boolean, found: (uri: vscode.Uri) => Promise<void>,
): Promise<void> {
  const pending = [root];
  while (pending.length > 0 && !isCancelled()) {
    const directory = pending.pop()!;
    const entries = await vscode.workspace.fs.readDirectory(directory);
    for (let index = 0; index < entries.length; index++) {
      if (isCancelled()) { return; }
      const [name, type] = entries[index];
      if ((type & vscode.FileType.Directory) && !EXCLUDED_DIRECTORIES.has(name)) {
        pending.push(vscode.Uri.joinPath(directory, name));
      } else if ((type & vscode.FileType.File) && MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
        await found(vscode.Uri.joinPath(directory, name));
      }
      // Also yield in folders dominated by TXT/unsupported files.
      if (index % 512 === 511) { await new Promise<void>((resolve) => setImmediate(resolve)); }
    }
  }
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
  requestId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const renderedCaption = await renderMarkdown(caption.text);
  if (signal?.aborted) { return; }
  await webview.postMessage({
    type,
    id,
    requestId,
    caption: caption.text,
    renderedCaption,
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
  // Uri.path is already decoded. Decoding again breaks literal '%' filenames
  // and changes names such as '%20' or '%2F' into spaces or path separators.
  return file.path.startsWith(rootPath)
    ? file.path.slice(rootPath.length)
    : file.path;
}

function readZoomSensitivity(root: vscode.Uri): number {
  const value = vscode.workspace.getConfiguration('imageCaptionGallery', root).get<number>('zoomSensitivity', 5);
  return Number.isFinite(value) ? Math.min(10, Math.max(0.5, value)) : 5;
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview, root: vscode.Uri, videoOrigin: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  // Inline trusted bundled assets once: SSH need not fetch CSS and three scripts
  // separately, and the initial document never flashes an unstyled editor.
  const styles = ['style.css', 'compareView.css', 'fileContextMenu.css'].map(file => readFileSync(vscode.Uri.joinPath(context.extensionUri, 'media', file).fsPath, 'utf8')).join('\n').replaceAll('</style', '<\\/style');
  const scripts = ['galleryGrid.js', 'videoStream.js', 'fileContextMenu.js', 'compareView.js', 'main.js'].map((file) => readFileSync(vscode.Uri.joinPath(context.extensionUri, 'media', file).fsPath, 'utf8')).join('\n;\n').replaceAll('</script', '<\\/script');
  const defaultThumbnailSize = vscode.workspace
    .getConfiguration('imageCaptionGallery', root)
    .get<number>('defaultThumbnailSize', 220);
  const config = vscode.workspace.getConfiguration('imageCaptionGallery', root);
  const showCaption = config.get<boolean>('showCaption', true);
  const language = vscode.env?.language ?? 'en';
  const t = (en: string, zh: string): string => language.toLowerCase().startsWith('zh') ? zh : en;
  const settingsLabel = language.toLowerCase().startsWith('zh') ? '设置' : 'Settings';
  const gallerySettings = escapeHtml(JSON.stringify({
    resolution: config.get<number>('maxPreviewResolution', 2048),
    concurrency: config.get<number>('previewConcurrency', 0),
    executionMode: config.get<string>('previewExecutionMode', 'process'),
    videoCompatibility: config.get<string>('videoCompatibility', 'auto'),
    videoMaxHeight: config.get<number>('videoPreviewMaxHeight', 1440),
    ffmpegPath: config.get<string>('ffmpegPath', 'ffmpeg'),
  }));
  const settingsButton = (id: string): string => `<button id="${id}" class="button settings-toggle" type="button" aria-haspopup="dialog" aria-controls="settings-dialog" aria-expanded="false" aria-label="${settingsLabel}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-2 2 2 3 3 1 1 3h6l1-3 3-1 2-3-2-2 2-2-2-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/></svg><span>${settingsLabel}</span></button>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: ${escapeHtml(videoOrigin)}; media-src ${webview.cspSource} ${escapeHtml(videoOrigin)} blob:; connect-src ${escapeHtml(videoOrigin)}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${styles}</style>
  <title>Image Caption Gallery</title>
</head>
<body data-default-thumbnail-size="${defaultThumbnailSize}" data-show-caption="${showCaption}" data-zoom-sensitivity="${readZoomSensitivity(root)}" data-gallery-settings="${gallerySettings}" data-ui-language="${language.startsWith('zh') ? 'zh' : 'en'}">
  <div id="browser-status" class="browser-status" role="status" aria-live="polite"></div>
  <section id="gallery-view">
    <header class="toolbar">
      <strong class="brand">Gallery</strong>
      <input id="search" class="search" type="search" placeholder="Search media…" aria-label="Search images and videos">
      <span id="count" class="muted" role="status" aria-live="polite">0 images</span>
      <button id="refresh" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
      <span id="comparison-selection" class="comparison-selection hidden"><button id="compare-selected" class="button" type="button" disabled></button><button id="clear-comparison" class="icon-button" type="button" aria-label="${t('Clear image selection', '清空图片选择')}">×</button></span>
      <button id="comparison-help" class="icon-button" type="button" aria-label="${t('How to compare two images', '如何对比两张图片')}" title="${t('Ctrl / ⌘ click two images to compare', 'Ctrl / ⌘ 点击两张图片进入对比')}">A/B</button>
      ${settingsButton('gallery-settings')}
    </header>
    <main id="gallery" class="gallery" aria-label="Media gallery"></main>
    <div id="empty" class="empty">Loading media…</div>
  </section>

  <section id="detail-view" class="detail-view hidden" tabindex="-1">
    <header class="detail-header">
      <div class="image-header">
        <button id="back" class="button" aria-label="Return to Gallery">←<span class="back-label"> Gallery</span></button>
        <strong id="media-kind-label" class="visually-hidden">Image</strong>
        <div class="detail-file"><span id="detail-path" class="detail-path"></span><span id="detail-dimensions" class="detail-dimensions" aria-live="polite"></span></div>
      </div>
      <div class="text-header">
        <span id="editing-label" class="editing-label hidden">Editing .txt</span>
        <span id="edit-state" class="edit-state hidden" aria-live="polite">Unsaved</span>
        <button id="edit-caption" class="button header-action" type="button" title="${t('Edit caption (E)', '编辑 Caption（E）')}" aria-label="${t('Edit caption (E)', '编辑 Caption（E）')}">Edit</button>
        <div id="edit-actions" class="edit-actions hidden">
          <button id="cancel-edit" class="icon-button" type="button" title="Discard edits (Escape)" aria-label="Discard edits">×</button>
          <button id="save-edit" class="icon-button primary-action" type="button" title="Save caption (Control or Command S)" aria-label="Save caption">✓</button>
        </div>
        <button id="detail-toggle-caption" class="button caption-quick-toggle" type="button" aria-pressed="true" aria-label="${t('Hide Caption', '隐藏 Caption')}" title="${t('Hide Caption (C)', '隐藏 Caption（C）')}"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="1"/><path d="M12 3v14M14 7h2m-2 3h2m-2 3h2"/></svg><span>Caption</span></button>
        <button id="video-focus" class="button video-focus-toggle hidden" type="button" aria-label="${t('Full screen in browser (F)', '浏览器全屏（F）')}" title="${t('Full screen in browser (F)', '浏览器全屏（F）')}"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M7 2H2v5m11-5h5v5M2 13v5h5m11-5v5h-5"/></svg><span>${t('Full screen', '全屏')}</span></button>
        ${settingsButton('detail-settings')}
      </div>
    </header>
    <main class="detail-content">
      <div class="image-pane">
        <div id="video-focus-controls" class="video-focus-controls hidden" role="toolbar" aria-label="${t('Focused video controls', '专注播放控制')}">
          <span class="focus-hint">${t('Fill panel', '铺满面板')}</span>
          <button id="focus-window-fullscreen" class="button" type="button">${t('Browser full screen', '浏览器全屏')}</button>
          ${settingsButton('focus-settings')}
          <button id="exit-video-focus" class="button" type="button">${t('Exit panel view (Esc)', '退出铺满（Esc）')}</button>
          <span id="video-focus-status" role="status" aria-live="polite"></span>
        </div>
        <button id="previous" class="image-navigation previous" title="Previous file (Left Arrow)" aria-label="Previous file">‹</button>
        <div id="image-stage" class="image-stage" title="Pinch to zoom · Drag or two-finger scroll to pan · Double-click to reset">
          <img id="detail-image" alt="Selected image" draggable="false">
          <video id="detail-video" class="detail-video hidden" controls controlslist="nofullscreen" preload="metadata" playsinline aria-label="Video player"></video>
          <div id="image-status" class="image-status hidden" role="status">
            <span id="image-status-message"></span>
            <button id="load-original" class="button hidden" type="button">Load original</button>
          </div>
        </div>
        <div id="video-toolbar" class="video-toolbar hidden" aria-label="${t('Video playback options', '视频播放选项')}">
          <div class="video-quality-control"><label for="video-quality">${t('Quality', '画质')}</label><select id="video-quality">${[0,1440,1080,720].map((value) => `<option value="${value}">${value === 0 ? t('Original', '原画') : value === 1440 ? '2K' : `${value}p`}</option>`).join('')}</select><span id="video-quality-info"></span></div>
          <div id="video-feedback" class="video-feedback" role="status" aria-live="polite"><span id="video-feedback-message"></span><button id="video-fallback" class="button hidden" type="button"></button></div>
        </div>
        <button id="next" class="image-navigation next" title="Next file (Right Arrow)" aria-label="Next file">›</button>
        <div class="navigation-hint">← / → 切换文件 · Switch files</div>
      </div>
      <div id="splitter" class="splitter" role="separator" aria-label="Resize image and text panes" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="80" aria-valuenow="64" tabindex="0"></div>
      <aside class="caption-pane">
        <div id="caption-preview" class="caption-preview markdown-view" aria-live="polite"></div>
        <textarea id="caption-editor" class="caption-editor hidden" aria-label="Caption editor" spellcheck="false"></textarea>
      </aside>
    </main>
  </section>

  ${settingsHtml(language)}
  <script nonce="${nonce}">${scripts}</script>
</body>
</html>`;
}

export function deactivate(): void {}
