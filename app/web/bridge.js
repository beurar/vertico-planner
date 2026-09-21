// Browser polyfill for the Electron preload bridge. `main.ts`'s `boot()` reads `window.planner`
// with a fallback if it's missing (see `PlannerBridge` in `src/renderer/types.ts`) — this file's
// only job is to exist before `renderer.js` runs, so that fallback is never needed here.
//
// There is nothing secret in this file: the database name and URI are not the protection. The
// module's `authenticate` reducer is — see `module/src/reducers/mod.rs` and the README.
(function () {
  'use strict';

  window.planner = {
    config: () =>
      Promise.resolve({
        uri: 'https://maincloud.spacetimedb.com',
        database: 'vertico-planner-d6f218',
        smoke: false,
        versions: { electron: '-', chrome: navigator.userAgent },
      }),

    // No Save dialog in a browser: this triggers a normal download instead.
    exportJson: (suggestedName, json) => {
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.append(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        return Promise.resolve({ saved: true, path: suggestedName });
      } catch (err) {
        return Promise.resolve({ saved: false, error: String((err && err.message) || err) });
      }
    },

    // No Open dialog either: a hidden <input type=file> stands in for it. Browsers fire no
    // 'cancel' event on it, so a cancel is inferred from the window regaining focus with no
    // 'change' having landed — the standard workaround for this gap in the File API.
    importJson: () =>
      new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';

        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(result);
        };

        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (!file) {
            finish({ opened: false });
            return;
          }
          file
            .text()
            .then(json => finish({ opened: true, path: file.name, json }))
            .catch(err => finish({ opened: false, error: String((err && err.message) || err) }));
        });

        window.addEventListener(
          'focus',
          () => {
            // The dialog has just closed either way; give 'change' a moment to land first.
            window.setTimeout(() => finish({ opened: false }), 300);
          },
          { once: true }
        );

        document.body.append(input);
        input.click();
      }),

    // `--smoke` is an Electron-only concept; nothing in the browser build reads this.
    signalReady: () => {},
  };
})();
