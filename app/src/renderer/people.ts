// The personnel rail, top right, and the drag that assigns someone to a bar.
//
// An avatar is a coloured disc with initials in it. There is no image column in the database and
// there should not be one: a colour and two letters draw a perfectly good avatar and keep a row
// small enough that every subscriber gets the whole table for nothing.

import { assignPersonToTask, taskUnderPoint } from './chart';
import { isFresh, puff } from './fx';
import { isAssigned, type Person } from './store';
import type { PlannerApp } from './types';
import { clear, el, readableOn } from './ui';

const DRAG_SLOP = 3;

export function renderPeople(app: PlannerApp, host: HTMLElement): void {
  clear(host);
  const { people } = app.snapshot;

  if (people.length === 0) {
    host.append(
      el('p', {
        class: 'empty-note',
        text: 'Nobody yet. “+ Person” adds one; then drag them onto a bar.',
      })
    );
    return;
  }

  for (const person of people) {
    const load = app.snapshot.assignments.filter(a => a.personId === person.id).length;
    const selected = app.selection.kind === 'person' && app.selection.id === person.id;

    const fresh = isFresh('person', person.id);
    const card = el('div', {
      class: `person${selected ? ' selected' : ''}${fresh ? ' enter' : ''}`,
      'data-person-id': String(person.id),
      title: `${person.name}${person.role ? ` — ${person.role}` : ''}`,
    });

    const avatar = el('div', { class: 'avatar', text: person.initials });
    avatar.style.background = person.avatarColour;
    avatar.style.color = readableOn(person.avatarColour);

    const meta = el('div', { class: 'person-meta' }, [
      el('span', { class: 'person-name', text: person.name }),
      el('span', {
        class: 'person-role',
        text: person.role || (load === 1 ? '1 task' : `${load} tasks`),
      }),
    ]);

    card.append(avatar, meta);
    card.addEventListener('pointerdown', event => beginAvatarDrag(app, event, person, card));
    host.append(card);
  }
}

/**
 * Drags a copy of the avatar. On release the bar under the pointer gets `assign_person` — unless
 * that person is already on it, in which case nothing is sent at all: the server refuses a second
 * copy by design, and a refusal the user cannot act on is not worth a toast.
 */
function beginAvatarDrag(
  app: PlannerApp,
  down: PointerEvent,
  person: Person,
  card: HTMLElement
): void {
  if (down.button !== 0) return;
  down.preventDefault();

  const startX = down.clientX;
  const startY = down.clientY;
  let moved = false;
  let ghost: HTMLElement | null = null;
  let hot: HTMLElement | null = null;

  card.setPointerCapture(down.pointerId);
  app.dragging = true;

  const setHot = (bar: HTMLElement | null) => {
    if (hot === bar) return;
    hot?.classList.remove('drop-hot', 'drop-blocked');
    hot = bar;
  };

  const onMove = (event: PointerEvent) => {
    if (!moved) {
      if (
        Math.abs(event.clientX - startX) <= DRAG_SLOP &&
        Math.abs(event.clientY - startY) <= DRAG_SLOP
      ) {
        return;
      }
      moved = true;
      ghost = el('div', { class: 'avatar-ghost', text: person.initials });
      ghost.style.background = person.avatarColour;
      ghost.style.color = readableOn(person.avatarColour);
      document.body.append(ghost);
      card.classList.add('dragging');
    }

    if (ghost) {
      ghost.style.left = `${event.clientX - 18}px`;
      ghost.style.top = `${event.clientY - 18}px`;
    }

    const task = taskUnderPoint(app, event.clientX, event.clientY);
    const bar = task
      ? (document.querySelector(`.bar[data-task-id="${String(task.id)}"]`) as HTMLElement | null)
      : null;
    setHot(bar);
    if (bar && task) {
      bar.classList.toggle('drop-blocked', isAssigned(app.snapshot, task.id, person.id));
      bar.classList.toggle('drop-hot', !isAssigned(app.snapshot, task.id, person.id));
    }
  };

  const onUp = (event: PointerEvent) => {
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onUp);
    if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
    card.classList.remove('dragging');
    ghost?.remove();
    setHot(null);
    app.dragging = false;

    if (!moved) {
      app.select({ kind: 'person', id: person.id });
      return;
    }

    const task = taskUnderPoint(app, event.clientX, event.clientY);
    if (task) {
      const dropX = event.clientX;
      const dropY = event.clientY;
      void assignPersonToTask(app, task.id, person.id).then(ok => {
        if (ok) puff(dropX, dropY, person.avatarColour);
      });
    }
    app.requestRender();
  };

  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);
}
