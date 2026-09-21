// The passphrase gate's UI.
//
// It is never shown proactively — a browser that already holds an authorised identity (the same
// token `connection.ts` persists to `localStorage`) never sees it again, because the server
// already knows that identity. It is shown on demand, the first time a mutating reducer refuses
// with the server's "not authenticated" sentence: reading the plan works with no gate at all,
// only changing it does.

import type { PlannerApp } from './types';
import { el } from './ui';

/** Must match `require_authenticated`'s refusal in `module/src/reducers/mod.rs` verbatim. */
const AUTH_REQUIRED_MESSAGE = 'Enter the shared passphrase first';

export function isAuthRefusal(text: string): boolean {
  return text === AUTH_REQUIRED_MESSAGE;
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
      'This plan is shared with the team. Ask whoever set it up for the passphrase — you can look around without it, but changes need it.',
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
      error.textContent = 'Not connected — wait for the status dot to turn green and try again.';
      return;
    }
    submit.setAttribute('disabled', '');
    error.textContent = '';
    try {
      await app.conn.reducers.authenticate({ passphrase });
      scrim.remove();
      open = false;
      app.say('Unlocked. Try that again.');
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      submit.removeAttribute('disabled');
      input.select();
      input.focus();
    }
  }
}
