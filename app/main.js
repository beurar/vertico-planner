// Electron main process.
//
// This process owns the window and the two file dialogs (Export / Import). It does not talk to
// SpacetimeDB at all: the renderer holds the WebSocket, because a loopback socket needs no Node
// access and routing every row through IPC would buy nothing.
//
// Security: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, remote navigation denied.
// The preload bridge is the only surface the renderer can reach, and it exposes four calls.

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

/** `npm start -- --smoke` opens the window, waits for the renderer to report in, and exits. */
const SMOKE = process.argv.includes('--smoke');
const SMOKE_TIMEOUT_MS = 40000;

/** Where the planner's database lives. Overridable so a second copy can point somewhere else. */
const STDB_URI = process.env.PLANNER_STDB_URI || 'ws://127.0.0.1:3000';
const STDB_DATABASE = process.env.PLANNER_STDB_DB || 'vertico-planner';

/** @type {BrowserWindow | null} */
let mainWindow = null;
let smokeTimer = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#070B0A',
    title: 'Vertico Planner',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Renderer console lands in this process's stdout, which is what makes a headless
  // `--smoke` run able to fail on a renderer error instead of showing a blank window.
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = level === 2 ? 'warn' : level === 3 ? 'error' : 'log';
    const where = sourceId ? ` (${path.basename(String(sourceId))}:${line})` : '';
    process.stdout.write(`[renderer:${tag}] ${message}${where}\n`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    process.stderr.write(`[main] renderer gone: ${details.reason}\n`);
    if (SMOKE) app.exit(1);
  });

  // Nothing in this app navigates anywhere. A stray link opens in the real browser instead of
  // turning the window into one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

ipcMain.handle('planner:config', () => ({
  uri: STDB_URI,
  database: STDB_DATABASE,
  smoke: SMOKE,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
}));

/** Export: the renderer serialises what its subscription already holds; this writes the file. */
ipcMain.handle('planner:export-json', async (_event, payload) => {
  const suggested = String((payload && payload.suggestedName) || 'plan.json');
  const json = String((payload && payload.json) || '');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export plan',
    defaultPath: suggested,
    filters: [{ name: 'Plan JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  try {
    await fs.writeFile(result.filePath, json, 'utf8');
    return { saved: true, path: result.filePath };
  } catch (err) {
    return { saved: false, error: String((err && err.message) || err) };
  }
});

/** Import: this reads the file, the renderer validates nothing and hands it to `import_plan`. */
ipcMain.handle('planner:import-json', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import plan',
    properties: ['openFile'],
    filters: [{ name: 'Plan JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { opened: false };
  const file = result.filePaths[0];
  try {
    const json = await fs.readFile(file, 'utf8');
    return { opened: true, path: file, json };
  } catch (err) {
    return { opened: false, error: String((err && err.message) || err) };
  }
});

/** The renderer reports once it has painted; `--smoke` uses it as the pass condition. */
ipcMain.on('planner:ready', (_event, info) => {
  const summary = info && typeof info === 'object' ? JSON.stringify(info) : String(info);
  process.stdout.write(`[main] renderer ready ${summary}\n`);
  if (SMOKE) {
    clearTimeout(smokeTimer);
    process.stdout.write('[main] SMOKE OK: window opened and the renderer painted\n');
    setTimeout(() => app.exit(0), 250);
  }
});

app.whenReady().then(() => {
  mainWindow = createWindow();

  if (SMOKE) {
    smokeTimer = setTimeout(() => {
      process.stderr.write('[main] SMOKE FAIL: renderer never reported ready\n');
      app.exit(1);
    }, SMOKE_TIMEOUT_MS);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
