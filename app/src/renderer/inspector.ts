// The edit panel for whatever is selected: a task, a lane, or a person.
//
// Each control commits through the narrowest reducer that can do the job — a date field calls
// `move_task`, not `update_task` — so editing one field never re-asserts the other six over a
// change someone (or some drag) made in between. `update_task` is left for the name, which has
// no narrow reducer of its own.

import { formatLongDay, fromIso, lastDay, toIso } from './dates';
import type { Lane, Person, Task } from './store';
import type { PlannerApp, Selection } from './types';
import { LANE_PALETTE, clear, deriveInitials, el, readableOn } from './ui';

let lastKey = '';

export interface InspectorHosts {
  title: HTMLElement;
  body: HTMLElement;
}

function keyOf(selection: Selection): string {
  return selection.kind === 'none' ? 'none' : `${selection.kind}:${selection.id}`;
}

export function renderInspector(app: PlannerApp, hosts: InspectorHosts): void {
  const key = keyOf(app.selection);

  // Rebuilding the panel while someone is typing in it would eat the keystroke and the caret.
  // A render that arrives mid-edit is deferred until the field is left.
  if (key === lastKey && hosts.body.contains(document.activeElement)) {
    hosts.body.addEventListener('focusout', () => app.requestRender(), { once: true });
    return;
  }
  lastKey = key;

  clear(hosts.body);

  switch (app.selection.kind) {
    case 'task': {
      const task = app.snapshot.taskById.get(app.selection.id);
      if (!task) return showNothing(app, hosts);
      hosts.title.textContent = 'Task';
      renderTaskForm(app, hosts.body, task);
      return;
    }
    case 'lane': {
      const lane = app.snapshot.laneById.get(app.selection.id);
      if (!lane) return showNothing(app, hosts);
      hosts.title.textContent = 'Lane';
      renderLaneForm(app, hosts.body, lane);
      return;
    }
    case 'person': {
      const person = app.snapshot.personById.get(app.selection.id);
      if (!person) return showNothing(app, hosts);
      hosts.title.textContent = 'Person';
      renderPersonForm(app, hosts.body, person);
      return;
    }
    default:
      return showNothing(app, hosts);
  }
}

function showNothing(app: PlannerApp, hosts: InspectorHosts): void {
  lastKey = 'none';
  hosts.title.textContent = 'Nothing selected';
  clear(hosts.body);
  hosts.body.append(
    el('p', {
      class: 'empty-note',
      text: 'Click a bar, a lane header or a person to edit it. Drag a bar to move it, its ends to reshape it, and an avatar onto it to assign.',
    })
  );
}

// ---------------------------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------------------------

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: labelText }),
    control,
  ]);
  if (hint) wrap.append(el('span', { class: 'field-hint', text: hint }));
  return wrap;
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const input = el('input', { class: 'input', type: 'text', value, placeholder }) as HTMLInputElement;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  return input;
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  const input = el('input', {
    class: 'input',
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
  }) as HTMLInputElement;
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });
  return input;
}

function colourInput(value: string): HTMLInputElement {
  return el('input', { class: 'input colour', type: 'color', value }) as HTMLInputElement;
}

function dangerButton(label: string): HTMLButtonElement {
  return el('button', { class: 'btn danger wide', type: 'button', text: label }) as HTMLButtonElement;
}

// ---------------------------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------------------------

function renderTaskForm(app: PlannerApp, host: HTMLElement, task: Task): void {
  const lane = app.snapshot.laneById.get(task.laneId);

  const name = textInput(task.name);
  name.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.updateTask({
        taskId: task.id,
        laneId: task.laneId,
        name: name.value,
        startDay: task.startDay,
        durationDays: task.durationDays,
        percentComplete: task.percentComplete,
        predecessorId: task.predecessorId,
      })
    );
  });
  host.append(field('Name', name));

  const laneSelect = el('select', { class: 'input' }) as HTMLSelectElement;
  for (const option of app.snapshot.lanes) {
    const node = el('option', { value: String(option.id), text: option.name }) as HTMLOptionElement;
    if (option.id === task.laneId) node.selected = true;
    laneSelect.append(node);
  }
  laneSelect.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.moveTaskToLane({
        taskId: task.id,
        laneId: BigInt(laneSelect.value),
        startDay: task.startDay,
      })
    );
  });
  host.append(field('Lane', laneSelect));

  const start = el('input', {
    class: 'input',
    type: 'date',
    value: toIso(task.startDay),
  }) as HTMLInputElement;
  start.addEventListener('change', () => {
    const day = fromIso(start.value);
    if (day === null) {
      app.say('That is not a date.', 'error');
      app.requestRender();
      return;
    }
    void app.call(() => app.conn!.reducers.moveTask({ taskId: task.id, startDay: day }));
  });
  host.append(field('Starts', start, `epoch day ${task.startDay}`));

  const duration = numberInput(task.durationDays, 1, 100000);
  duration.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.resizeTask({ taskId: task.id, durationDays: Number(duration.value) })
    );
  });
  host.append(
    field('Days', duration, `ends ${formatLongDay(lastDay(task.startDay, task.durationDays))}`)
  );

  // The completion badge and its slider. The badge follows the slider live; the reducer is called
  // once, on release.
  const percentRow = el('div', { class: 'percent-row' });
  const readout = el('span', {
    class: 'percent-readout',
    text: `${task.percentComplete}%`,
  });
  if (lane) {
    readout.style.background = lane.colour;
    readout.style.color = readableOn(lane.colour);
  }
  const slider = el('input', {
    class: 'input range',
    type: 'range',
    min: '0',
    max: '100',
    step: '5',
    value: String(task.percentComplete),
  }) as HTMLInputElement;
  if (lane) slider.style.accentColor = lane.colour;
  slider.addEventListener('input', () => {
    readout.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.setTaskPercent({
        taskId: task.id,
        percentComplete: Number(slider.value),
      })
    );
  });
  percentRow.append(slider, readout);
  host.append(field('Complete', percentRow));

  const predecessor = el('select', { class: 'input' }) as HTMLSelectElement;
  predecessor.append(el('option', { value: '0', text: '— none —' }));
  for (const other of app.snapshot.tasks) {
    if (other.id === task.id) continue;
    const node = el('option', { value: String(other.id), text: other.name }) as HTMLOptionElement;
    if (other.id === task.predecessorId) node.selected = true;
    predecessor.append(node);
  }
  predecessor.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.setTaskPredecessor({
        taskId: task.id,
        predecessorId: BigInt(predecessor.value),
      })
    );
  });
  host.append(field('After', predecessor, 'a cycle is refused, at any depth'));

  host.append(renderAssignees(app, task));

  const remove = dangerButton('Delete task');
  remove.addEventListener('click', () => {
    if (!window.confirm(`Delete “${task.name}”? Its assignments go with it.`)) return;
    app.select({ kind: 'none' });
    void app.call(() => app.conn!.reducers.deleteTask({ taskId: task.id }));
  });
  host.append(remove);
}

function renderAssignees(app: PlannerApp, task: Task): HTMLElement {
  const assigned = app.snapshot.peopleByTask.get(task.id) ?? [];
  const wrap = el('div', { class: 'field' }, [
    el('span', { class: 'field-label', text: 'Assigned' }),
  ]);

  const chips = el('div', { class: 'chips' });
  if (assigned.length === 0) {
    chips.append(el('span', { class: 'field-hint', text: 'Nobody — drag an avatar onto the bar.' }));
  }
  for (const person of assigned) {
    const chip = el('span', { class: 'chip' });
    chip.style.background = person.avatarColour;
    chip.style.color = readableOn(person.avatarColour);
    chip.append(el('span', { text: person.name }));
    const remove = el('button', {
      class: 'chip-x',
      type: 'button',
      text: '×',
      title: `Unassign ${person.name}`,
    });
    remove.addEventListener('click', () => {
      void app.call(() =>
        app.conn!.reducers.unassignPerson({ taskId: task.id, personId: person.id })
      );
    });
    chip.append(remove);
    chips.append(chip);
  }
  wrap.append(chips);

  const free = app.snapshot.people.filter(p => !assigned.some(a => a.id === p.id));
  if (free.length > 0) {
    const add = el('select', { class: 'input' }) as HTMLSelectElement;
    add.append(el('option', { value: '', text: '+ assign someone…' }));
    for (const person of free) {
      add.append(el('option', { value: String(person.id), text: person.name }));
    }
    add.addEventListener('change', () => {
      if (!add.value) return;
      const personId = BigInt(add.value);
      void app.call(() => app.conn!.reducers.assignPerson({ taskId: task.id, personId }), {
        ignore: /already assigned/i,
      });
    });
    wrap.append(add);
  }

  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Lane
// ---------------------------------------------------------------------------------------------

function renderLaneForm(app: PlannerApp, host: HTMLElement, lane: Lane): void {
  const name = textInput(lane.name);
  const order = numberInput(lane.sortOrder, -100000, 100000);

  name.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.updateLane({
        laneId: lane.id,
        name: name.value,
        colour: lane.colour,
        sortOrder: lane.sortOrder,
      })
    );
  });
  host.append(field('Name', name));

  const colour = colourInput(lane.colour);
  colour.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.setLaneColour({ laneId: lane.id, colour: colour.value.toLowerCase() })
    );
  });
  host.append(field('Colour', colour, 'bars in this lane take this colour'));

  const swatches = el('div', { class: 'swatches' });
  for (const preset of LANE_PALETTE) {
    const button = el('button', { class: 'swatch', type: 'button', title: preset });
    button.style.background = preset;
    button.addEventListener('click', () => {
      void app.call(() =>
        app.conn!.reducers.setLaneColour({ laneId: lane.id, colour: preset })
      );
    });
    swatches.append(button);
  }
  host.append(swatches);

  order.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.reorderLane({ laneId: lane.id, sortOrder: Number(order.value) })
    );
  });
  host.append(field('Order', order, 'lower is higher up the chart'));

  const count = app.snapshot.tasksByLane.get(lane.id)?.length ?? 0;
  const remove = dangerButton('Delete lane');
  remove.addEventListener('click', () => {
    if (!window.confirm(`Delete lane “${lane.name}”?`)) return;
    app.select({ kind: 'none' });
    void app.call(() => app.conn!.reducers.deleteLane({ laneId: lane.id }));
  });
  host.append(remove);
  if (count > 0) {
    host.append(
      el('p', {
        class: 'field-hint',
        text: `This lane holds ${count} task(s); the server refuses to delete it until they are moved or gone.`,
      })
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------------------------

function renderPersonForm(app: PlannerApp, host: HTMLElement, person: Person): void {
  const name = textInput(person.name);
  const role = textInput(person.role, 'optional');
  const colour = colourInput(person.avatarColour);
  const initials = textInput(person.initials, deriveInitials(person.name));

  const commit = () => {
    void app.call(() =>
      app.conn!.reducers.updatePerson({
        personId: person.id,
        name: name.value,
        role: role.value,
        avatarColour: colour.value.toLowerCase(),
        initials: initials.value,
      })
    );
  };

  for (const input of [name, role, colour, initials]) {
    input.addEventListener('change', commit);
  }

  const preview = el('div', { class: 'avatar preview', text: person.initials });
  preview.style.background = person.avatarColour;
  preview.style.color = readableOn(person.avatarColour);
  host.append(el('div', { class: 'person-preview' }, [preview]));

  host.append(field('Name', name));
  host.append(field('Role', role));
  host.append(field('Colour', colour));
  host.append(field('Initials', initials, 'left blank, the server derives them from the name'));

  const load = app.snapshot.assignments.filter(a => a.personId === person.id).length;
  const remove = dangerButton('Delete person');
  remove.addEventListener('click', () => {
    if (!window.confirm(`Delete ${person.name}? Their ${load} assignment(s) go too.`)) return;
    app.select({ kind: 'none' });
    void app.call(() => app.conn!.reducers.deletePerson({ personId: person.id }));
  });
  host.append(remove);
}
