// The passphrase gate's UI.
//
// Blocking, not a scrim: nothing behind `.gate-scrim` is visible until the passphrase is
// accepted, and there is no way to dismiss it without one. `boot()` shows it immediately unless
// this browser already unlocked once — `UNLOCKED_KEY` in `localStorage` is what's checked, purely
// a client-side memory so the same browser isn't asked again. It is not itself a security
// boundary: the WebSocket underneath keeps working the whole time this screen is up, so this
// keeps a casual visitor out, not a motivated one reading the page's own source.
//
// It also still opens reactively — the first time a mutating reducer refuses with the server's
// "not authenticated" sentence. That path exists for the one case the local flag can't cover: this
// browser's stored identity was authorised once, but the server no longer agrees (the database
// was wiped, or the passphrase rotated).

import type { PlannerApp } from './types';
import { el } from './ui';

/** Must match `require_authenticated`'s refusal in `module/src/reducers/mod.rs` verbatim. */
const AUTH_REQUIRED_MESSAGE = 'Enter the shared passphrase first';

export function isAuthRefusal(text: string): boolean {
  return text === AUTH_REQUIRED_MESSAGE;
}

const UNLOCKED_KEY = 'vertico-planner.unlocked';

export function isUnlockedLocally(): boolean {
  try {
    return window.localStorage.getItem(UNLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

function markUnlockedLocally(): void {
  try {
    window.localStorage.setItem(UNLOCKED_KEY, '1');
  } catch {
    /* A missing storage is not a reason to refuse to run — it just means asking again next visit. */
  }
}

let open = false;

export function showPassphraseGate(app: PlannerApp): void {
  if (open) return;
  open = true;

  const input = el('input', {
    class: 'gate-input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'Shared passphrase',
  }) as HTMLInputElement;
  const error = el('p', { class: 'gate-error' });
  const submit = el('button', { class: 'btn wide', type: 'submit', text: 'Unlock' });

  const form = el('form', { class: 'gate-form' }, [
    el('h2', { class: 'gate-title', text: 'Vertico Planner' }),
    el('p', { class: 'gate-hint' }, [
      'This plan is private to the team. Enter the shared passphrase to open it.',
    ]),
    input,
    error,
    submit,
  ]);
  const scrim = el('div', { class: 'gate-scrim' }, [form]);

  document.body.append(scrim);
  input.focus();

  form.addEventListener('submit', event => {
    event.preventDefault();
    void attempt();
  });

  async function attempt(): Promise<void> {
    const passphrase = input.value;
    if (!passphrase) return;
    if (!app.conn) {
      error.textContent = 'Still connecting — try again in a moment.';
      return;
    }
    submit.setAttribute('disabled', '');
    error.textContent = '';
    try {
      await app.conn.reducers.authenticate({ passphrase });
      markUnlockedLocally();
      scrim.remove();
      open = false;
      app.requestRender();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      submit.removeAttribute('disabled');
      input.select();
      input.focus();
      // A restart, not a toggle: the class has to leave the element before it's added again, or
      // a second wrong guess in a row is a no-op restyle rather than a second shake.
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
    }
  }
}
