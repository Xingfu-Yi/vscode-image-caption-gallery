const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

class Uri {
  constructor(scheme, authority, pathname, query = '') { this.scheme = scheme; this.authority = authority; this.path = pathname; this.query = query; }
  static file(value) { return new Uri('file', '', path.resolve(value)); }
  static parse(value) { const url = new URL(value); return new Uri(url.protocol.slice(0, -1), url.host, decodeURIComponent(url.pathname), url.search.slice(1)); }
  static joinPath(base, ...segments) { return base.with({ path: path.posix.join(base.path, ...segments) }); }
  with(change) { return new Uri(this.scheme, this.authority, change.path ?? this.path, change.query ?? this.query); }
  get fsPath() { return this.path; }
  toString() { return (this.scheme === 'file' ? pathToFileURL(this.path).href : `${this.scheme}://${this.authority}${this.path.split('/').map(encodeURIComponent).join('/')}`) + (this.query ? '?' + this.query : ''); }
}
const disposable = () => ({ dispose() {} });

async function createHost(t, settings = {}, remote = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-host-'));
  const dataset = path.join(directory, 'dataset');
  await fs.mkdir(dataset);
  // Remote extension-host fsPath resolves on that host. Keep the fake URI's
  // logical /dataset path, while native fs/FFmpeg see this fixture's real file.
  class HostUri extends Uri {
    static parse(value) { const uri = Uri.parse(value); return new HostUri(uri.scheme, uri.authority, uri.path, uri.query); }
    get fsPath() { return this.scheme === 'vscode-remote' ? path.join(dataset, path.posix.relative('/dataset', this.path)) : this.path; }
    with(change) { return new HostUri(this.scheme, this.authority, change.path ?? this.path, change.query ?? this.query); }
  }
  const panels = [], reads = [], sent = [], configurationListeners = [], commandsCalled = [], openedUrls = [], videoLogs = [], clipboardWrites = [];
  let command;
  const config = { defaultThumbnailSize: 220, maxPreviewResolution: 32, showCaption: true, videoCompatibility: 'native', ...settings };
  const local = (uri) => uri.scheme === 'vscode-remote' ? path.join(dataset, path.posix.relative('/dataset', uri.path)) : uri.fsPath;
  class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
  const vscode = {
    env: { openExternal: async uri => { openedUrls.push(uri.toString()); return !settings.failBrowserOpen; }, language: settings.uiLanguage || 'en', asExternalUri: async (uri) => settings.externalVideoBase ? { toString: () => settings.externalVideoBase } : uri },
    Uri: HostUri, FileSystemError, FileType: { File: 1, Directory: 2 }, ViewColumn: { One: 1 }, TabInputText: class {}, TabInputCustom: class {},
    commands: {
      registerCommand: (_, callback) => { command = callback; return disposable(); },
      executeCommand: async (command, text) => { commandsCalled.push({ command, text }); return `<p>${text}</p>`; },
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
      onDidChangeConfiguration: (callback) => { configurationListeners.push(callback); return disposable(); },
      fs: {
        stat: async (uri) => { const stat = await fs.stat(local(uri)); return { type: stat.isDirectory() ? 2 : 1, mtime: stat.mtimeMs, size: stat.size }; },
        readDirectory: async (uri) => (await fs.readdir(local(uri), { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        readFile: async (uri) => {
          reads.push(uri.toString());
          try { return await fs.readFile(local(uri)); }
          catch (error) { if (error.code === 'ENOENT') { throw new FileSystemError('FileNotFound'); } throw error; }
        },
        writeFile: (uri, bytes) => fs.writeFile(local(uri), bytes),
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine: text => videoLogs.push(text), dispose() {} }),
      tabGroups: { activeTabGroup: {} },
      showWarningMessage: async () => 'Continue Editing',
      showErrorMessage: async () => {},
      createWebviewPanel: (_, title, column, options) => {
        const panel = { title, options, visible: true, onDidChangeViewState(callback) { this.changeVisibility = (visible) => { this.visible = visible; callback({ webviewPanel: this }); }; return disposable(); }, onDidDispose(callback) { this.close = callback; return disposable(); }, webview: {
          cspSource: 'https://resources.test',
          asWebviewUri: (uri) => ({ toString: () => `https://resources.test/?uri=${encodeURIComponent(uri.toString())}` }),
          postMessage: async (message) => { sent.push(message); return true; },
          onDidReceiveMessage: (callback) => { panel.receive = callback; return disposable(); },
        } };
        panels.push(panel); return panel;
      },
    },
  };
  vscode.env.clipboard = { writeText: async text => { if (settings.failClipboard) throw new Error('Clipboard unavailable'); clipboardWrites.push(text); } };
  const load = Module._load;
  Module._load = function (id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
  let extension;
  try { delete require.cache[require.resolve('../../dist/extension')]; extension = require('../../dist/extension'); }
  finally { Module._load = load; }
  const context = { subscriptions: [], globalStorageUri: Uri.file(path.join(directory, 'storage')), extensionUri: Uri.file(path.resolve(__dirname, '../..')) };
  extension.activate(context);
  const root = remote ? new HostUri('vscode-remote', 'ssh-remote+test', '/dataset') : Uri.file(dataset);
  await command(root);
  t.after(async () => {
    for (const panel of panels) { panel.close(); }
    for (const item of context.subscriptions) { item.dispose(); }
    await Promise.allSettled(context.subscriptions.map(item => item.initialized).filter(Boolean));
    await Promise.allSettled(context.subscriptions.flatMap(item => [item.eviction, item.pruning]).filter(Boolean));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  return { clipboardWrites, openedUrls, videoLogs, commandsCalled, fileSystem: vscode.workspace.fs, panel: panels[0], config, reads, sent, dataset, root, context, configurationListeners, open: () => command(root), openMedia: async (filename) => { await command(Uri.joinPath(root, filename)); return panels.at(-1); } };
}
module.exports = { createHost };
