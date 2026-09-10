// The whole bridge between the main process and the renderer.
//
// `contextIsolation` is on, so the renderer sees exactly the four functions below and nothing
// else — no `require`, no `fs`, no `ipcRenderer`. The renderer's own connection to SpacetimeDB is
// a loopback WebSocket, which needs no Node access, so this stays as small as it looks.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('planner', {
  /** Where to connect: `{ uri, database, smoke, versions }`. */
  config: () => ipcRenderer.invoke('planner:config'),

  /** Show a Save dialog and write `json` to the chosen file. */
  exportJson: (suggestedName, json) =>
    ipcRenderer.invoke('planner:export-json', { suggestedName, json }),

  /** Show an Open dialog and return the chosen file's text. */
  importJson: () => ipcRenderer.invoke('planner:import-json'),

  /** Told once, after the first paint. `--smoke` runs exit successfully on it. */
  signalReady: info => ipcRenderer.send('planner:ready', info),
});
