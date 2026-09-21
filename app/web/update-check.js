// Polls this same origin's `version.json` — rewritten with the current commit on every deploy by
// `.github/workflows/deploy.yml` — and offers a one-click reload the moment it disagrees with the
// commit this tab was served. Never reloads on its own: forcing a reload mid-drag would be worse
// than a tab that is a few minutes stale, so this only ever offers, never acts.
(function () {
  'use strict';

  const CHECK_INTERVAL_MS = 3 * 60 * 1000;
  let myCommit = null;

  function fetchVersion() {
    return fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  function check() {
    fetchVersion().then(data => {
      if (!data || !data.commit) return;
      if (myCommit === null) {
        myCommit = data.commit;
        return;
      }
      if (data.commit !== myCommit && !document.getElementById('updateBanner')) showBanner();
    });
  }

  function showBanner() {
    const bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';

    const text = document.createElement('span');
    text.textContent = 'A newer version of the planner is available.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => window.location.reload());

    bar.append(text, btn);
    document.body.append(bar);
  }

  window.setTimeout(check, 3000);
  window.setInterval(check, CHECK_INTERVAL_MS);
})();
