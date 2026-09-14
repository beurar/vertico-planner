// The Gantt itself: the ruler, the lanes, the bars, and the three gestures that live on a bar.
//
// A gesture moves the bar under the pointer immediately and calls a reducer when the pointer is
// released. The reducer is the truth. If it refuses, `app.call` shows the sentence and
// re-renders, and the re-render paints the bar back at the row's values — the bar snaps because
// nothing local was ever written, not because anything undoes it.

import {
  dayOfMonth,
  formatDay,
  isMonthStart,
  isWeekend,
  lastDay,
  monthLabel,
  today,
} from './dates';
import { isAssigned, type Lane, type Task } from './store';
import type { PlannerApp } from './types';
import { clamp, clear, el, mix, rgba, readableOn } from './ui';

/** Must match `--lane-h`, `--bar-h` and `--head-w` in styles.css; set from here at startup. */
export const LANE_H = 78;
export const BAR_H = 46;
export const HEAD_W = 196;
/** How wide the resize zone at each end of a bar is. */
const GRIP_W = 10;
/** Pointer travel, in pixels, below which a press is a click and not a drag. */
const DRAG_SLOP = 3;

export interface ChartHosts {
  scroll: HTMLElement;
  inner: HTMLElement;
  timeline: HTMLElement;
  lanes: HTMLElement;
  empty: HTMLElement;
}

type DragMode = 'move' | 'resize-left' | 'resize-right';

export function installChartMetrics(): void {
  const root = document.documentElement.style;
  root.setProperty('--lane-h', `${LANE_H}px`);
  root.setProperty('--bar-h', `${BAR_H}px`);
  root.setProperty('--head-w', `${HEAD_W}px`);
}

/** Chooses the window of days to draw, and writes it back onto the app for hit-testing. */
function computeRange(app: PlannerApp): void {
  const now = today();
  let min = now - 7;
  let max = now + 24;
  for (const task of app.snapshot.tasks) {
    min = Math.min(min, task.startDay);
    max = Math.max(max, task.startDay + Math.max(1, task.durationDays));
  }
  app.originDay = min - 4;
  app.dayCount = Math.max(45, max + 10 - app.originDay);
}

const px = (n: number) => `${Math.round(n)}px`;

export function renderChart(app: PlannerApp, hosts: ChartHosts): void {
  computeRange(app);
  const dayW = app.dayWidth;
  const trackW = app.dayCount * dayW;

  hosts.inner.style.width = px(HEAD_W + trackW);
  hosts.inner.classList.toggle('compact', dayW < 16);

  renderTimeline(app, hosts.timeline, trackW);
  renderLanes(app, hosts.lanes, trackW);

  const hasLanes = app.snapshot.lanes.length > 0;
  hosts.empty.hidden = hasLanes;
  if (!hasLanes) {
    hosts.empty.textContent = app.connected
      ? 'No lanes yet. “+ Lane” makes the first one.'
      : 'Waiting for the planner database…';
  }
}

function renderTimeline(app: PlannerApp, host: HTMLElement, trackW: number): void {
  clear(host);
  const { originDay, dayCount, dayWidth } = app;

  host.append(el('div', { class: 'timeline-corner' }, [el('span', { text: 'Timeline' })]));

  const cols = el('div', { class: 'timeline-cols' });
  cols.style.width = px(trackW);

  // Month band: one label per run of days in the same month.
  let runStart = 0;
  for (let i = 1; i <= dayCount; i += 1) {
    if (i === dayCount || isMonthStart(originDay + i)) {
      const band = el('div', { class: 'tl-month' }, [
        el('span', { text: monthLabel(originDay + runStart) }),
      ]);
      band.style.left = px(runStart * dayWidth);
      band.style.width = px((i - runStart) * dayWidth);
      cols.append(band);
      runStart = i;
    }
  }

  const now = today();
  for (let i = 0; i < dayCount; i += 1) {
    const day = originDay + i;
    const cell = el('div', {
      class: `tl-day${isWeekend(day) ? ' weekend' : ''}${day === now ? ' today' : ''}`,
    });
    cell.style.left = px(i * dayWidth);
    cell.style.width = px(dayWidth);
    cell.append(el('span', { class: 'tl-dom', text: String(dayOfMonth(day)) }));
    cell.title = formatDay(day);
    cols.append(cell);
  }

  host.append(cols);
}

function renderLanes(app: PlannerApp, host: HTMLElement, trackW: number): void {
  clear(host);
  const { snapshot, originDay, dayCount, dayWidth } = app;

  const grid = el('div', { class: 'grid' });
  grid.style.width = px(trackW);
  grid.style.height = px(Math.max(1, snapshot.lanes.length) * LANE_H);
  for (let i = 0; i < dayCount; i += 1) {
    const day = originDay + i;
    if (!isWeekend(day)) continue;
    const band = el('div', { class: 'grid-weekend' });
    band.style.left = px(i * dayWidth);
    band.style.width = px(dayWidth);
    grid.append(band);
  }
  const nowLine = el('div', { class: 'grid-today' });
  nowLine.style.left = px((today() - originDay) * dayWidth);
  grid.append(nowLine);
  host.append(grid);

  for (const lane of snapshot.lanes) {
    host.append(renderLane(app, lane, trackW));
  }

  host.append(renderDependencies(app, trackW));

  // A label only pans if it actually overflows, and that is a layout question the DOM can
  // only answer once the bars are mounted. One pass per render, not one per bar: this reads
  // scrollWidth, which forces layout, and doing it inside renderBar would do so mid-build.
  requestAnimationFrame(() => markPanningLabels(host));
}

/// Tags every task label whose text is wider than the room it has, so the CSS may pan it.
/// Cleared first, because a bar that grew (a resize, a zoom to week view) no longer overflows
/// and a stale marquee on a label that now fits reads as a bug.
function markPanningLabels(host: HTMLElement): void {
  for (const label of Array.from(host.querySelectorAll<HTMLElement>('.bar-label'))) {
    const name = label.querySelector<HTMLElement>('.bar-name');
    if (!name) continue;
    label.classList.toggle('pans', name.scrollWidth > label.clientWidth + 1);
  }
}

function renderLane(app: PlannerApp, lane: Lane, trackW: number): HTMLElement {
  const tasks = app.snapshot.tasksByLane.get(lane.id) ?? [];
  const selected = app.selection.kind === 'lane' && app.selection.id === lane.id;

  const row = el('div', { class: `lane${selected ? ' selected' : ''}`, 'data-lane-id': String(lane.id) });

  const head = el('div', { class: 'lane-head' });
  head.style.borderLeftColor = lane.colour;

  const swatch = el('button', {
    class: 'lane-swatch',
    type: 'button',
    title: `Lane colour — ${lane.colour}`,
  });
  swatch.style.background = lane.colour;
  const picker = el('input', { class: 'lane-colour-input', type: 'color', value: lane.colour });
  // The picker commits on `change` (the OS dialog's OK), not on every `input` tick, so dragging
  // around a colour wheel is not two hundred reducer calls.
  picker.addEventListener('change', () => {
    void app.call(() =>
      app.conn!.reducers.setLaneColour({ laneId: lane.id, colour: picker.value.toLowerCase() })
    );
  });
  picker.addEventListener('click', event => event.stopPropagation());
  swatch.addEventListener('click', event => {
    event.stopPropagation();
    picker.click();
  });
  swatch.append(picker);

  const title = el('div', { class: 'lane-title' }, [
    el('span', { class: 'lane-name', text: lane.name }),
    el('span', {
      class: 'lane-count',
      text: tasks.length === 1 ? '1 task' : `${tasks.length} tasks`,
    }),
  ]);

  head.append(swatch, title);
  head.addEventListener('click', () => app.select({ kind: 'lane', id: lane.id }));
  row.append(head);

  const track = el('div', { class: 'lane-track', 'data-lane-id': String(lane.id) });
  track.style.width = px(trackW);
  track.style.backgroundSize = `${app.dayWidth}px 100%`;

  // Double-clicking empty track is the fastest way to start a task where you are looking.
  track.addEventListener('dblclick', event => {
    if ((event.target as HTMLElement).closest('.bar')) return;
    const rect = track.getBoundingClientRect();
    const day = app.originDay + Math.floor((event.clientX - rect.left) / app.dayWidth);
    createTaskAt(app, lane.id, day);
  });

  for (const task of tasks) track.append(renderBar(app, task, lane));
  row.append(track);
  return row;
}

function renderBar(app: PlannerApp, task: Task, lane: Lane): HTMLElement {
  const dayW = app.dayWidth;
  const selected = app.selection.kind === 'task' && app.selection.id === task.id;
  const width = Math.max(1, task.durationDays) * dayW;

  const bar = el('div', {
    class: `bar${selected ? ' selected' : ''}${task.percentComplete >= 100 ? ' done' : ''}`,
    'data-task-id': String(task.id),
    title: `${task.name} — ${formatDay(task.startDay)} → ${formatDay(
      lastDay(task.startDay, task.durationDays)
    )} (${task.durationDays}d, ${task.percentComplete}%)`,
  });
  bar.style.left = px((task.startDay - app.originDay) * dayW);
  bar.style.width = px(width);
  bar.style.background = mix('#0c1211', lane.colour, 0.22);
  bar.style.borderColor = rgba(lane.colour, selected ? 0.95 : 0.55);

  const progress = el('div', { class: 'bar-progress' });
  progress.style.width = `${clamp(task.percentComplete, 0, 100)}%`;
  progress.style.background = rgba(lane.colour, 0.42);
  bar.append(progress);

  const label = el('div', { class: 'bar-label' }, [
    el('span', { class: 'bar-name', text: task.name }),
  ]);
  bar.append(label);

  const badge = el('span', {
    class: `bar-badge${task.percentComplete >= 100 ? ' complete' : ''}`,
    text: task.percentComplete >= 100 ? 'done' : `${task.percentComplete}%`,
  });
  if (task.percentComplete >= 100) {
    badge.style.background = lane.colour;
    badge.style.color = readableOn(lane.colour);
  }
  bar.append(badge);

  // Assigned avatars ride the bar, so who is on what is readable without selecting anything.
  const people = app.snapshot.peopleByTask.get(task.id) ?? [];
  if (people.length > 0 && width >= 96) {
    const strip = el('div', { class: 'bar-people' });
    for (const person of people.slice(0, 3)) {
      strip.append(miniAvatar(person.avatarColour, person.initials, person.name));
    }
    if (people.length > 3) {
      strip.append(el('span', { class: 'bar-people-more', text: `+${people.length - 3}` }));
    }
    bar.append(strip);
  }

  // The percentage slider rides ONLY the selected bar. A live slider on every bar meant a
  // stray click while panning or reaching for a drag handle silently rewrote a task's
  // progress, and a reducer round-trip is not something to fire by accident. Select the task
  // and the slider appears here; the inspector always carries one either way.
  if (selected && width >= 120) {
    const slider = el('input', {
      class: 'bar-slider',
      type: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: String(task.percentComplete),
      title: 'Completion',
    }) as HTMLInputElement;
    slider.style.accentColor = lane.colour;
    // Without this the press would start a bar drag as well as a slider drag.
    slider.addEventListener('pointerdown', event => {
      event.stopPropagation();
      app.dragging = true;
    });
    slider.addEventListener('click', event => event.stopPropagation());
    // A press that never moved the knob fires no `change`, so renders are switched back on here
    // as well — otherwise one stray click on a slider would freeze the chart.
    const endSliderDrag = () => {
      app.dragging = false;
      app.requestRender();
    };
    slider.addEventListener('pointerup', endSliderDrag);
    slider.addEventListener('pointercancel', endSliderDrag);
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      progress.style.width = `${value}%`;
      badge.textContent = value >= 100 ? 'done' : `${value}%`;
    });
    slider.addEventListener('change', () => {
      app.dragging = false;
      void app.call(() =>
        app.conn!.reducers.setTaskPercent({
          taskId: task.id,
          percentComplete: Number(slider.value),
        })
      );
    });
    bar.append(slider);
  }

  bar.append(el('div', { class: 'grip left' }), el('div', { class: 'grip right' }));

  bar.addEventListener('pointerdown', event => {
    const target = event.target as HTMLElement;
    if (target.closest('.bar-slider')) return;
    const rect = bar.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    const mode: DragMode =
      offset <= GRIP_W ? 'resize-left' : offset >= rect.width - GRIP_W ? 'resize-right' : 'move';
    beginBarDrag(app, event, task, bar, mode);
  });

  return bar;
}

function miniAvatar(colour: string, initials: string, name: string): HTMLElement {
  const node = el('span', { class: 'mini-avatar', text: initials, title: name });
  node.style.background = colour;
  node.style.color = readableOn(colour);
  return node;
}

/**
 * One gesture. Which reducer it becomes:
 *   body dragged sideways        → move_task
 *   body dragged to another lane → move_task_to_lane (one call, never a move plus a move)
 *   right edge dragged           → resize_task
 *   left edge dragged            → move_task *and* resize_task, because the bar's start and its
 *                                  width both changed and there is no reducer that does both
 */
function beginBarDrag(
  app: PlannerApp,
  down: PointerEvent,
  task: Task,
  bar: HTMLElement,
  mode: DragMode
): void {
  if (down.button !== 0) return;
  down.preventDefault();

  const dayW = app.dayWidth;
  const lanes = app.snapshot.lanes;
  const laneIndex = lanes.findIndex(l => l.id === task.laneId);
  const startX = down.clientX;
  const startY = down.clientY;

  let curStart = task.startDay;
  let curDuration = Math.max(1, task.durationDays);
  let curLaneIndex = laneIndex;
  let moved = false;

  app.dragging = true;
  bar.classList.add('dragging');
  bar.setPointerCapture(down.pointerId);

  const ghost = document.getElementById('dragGhost');

  const paint = (event: PointerEvent) => {
    bar.style.left = px((curStart - app.originDay) * dayW);
    bar.style.width = px(curDuration * dayW);
    bar.style.transform =
      curLaneIndex === laneIndex ? '' : `translateY(${(curLaneIndex - laneIndex) * LANE_H}px)`;

    for (const node of document.querySelectorAll('.lane.drop-target')) {
      node.classList.remove('drop-target');
    }
    if (curLaneIndex !== laneIndex) {
      const targetLane = lanes[curLaneIndex];
      document
        .querySelector(`.lane[data-lane-id="${String(targetLane.id)}"]`)
        ?.classList.add('drop-target');
    }

    if (ghost) {
      ghost.hidden = false;
      ghost.textContent = `${formatDay(curStart)} → ${formatDay(
        lastDay(curStart, curDuration)
      )} · ${curDuration}d`;
      ghost.style.left = px(event.clientX + 16);
      ghost.style.top = px(event.clientY + 18);
    }
  };

  const onMove = (event: PointerEvent) => {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) moved = true;
    const days = Math.round(dx / dayW);

    if (mode === 'move') {
      curStart = task.startDay + days;
      curLaneIndex = lanes.length
        ? clamp(laneIndex + Math.round(dy / LANE_H), 0, lanes.length - 1)
        : laneIndex;
    } else if (mode === 'resize-right') {
      curDuration = Math.max(1, task.durationDays + days);
    } else {
      // Dragging the left edge past the right one would make a zero-width bar, which is not a
      // task; it stops at one day rather than being refused for a value the user cannot see.
      const shift = Math.min(days, task.durationDays - 1);
      curStart = task.startDay + shift;
      curDuration = task.durationDays - shift;
    }
    paint(event);
  };

  const onUp = async (event: PointerEvent) => {
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
    bar.classList.remove('dragging');
    if (ghost) ghost.hidden = true;
    for (const node of document.querySelectorAll('.lane.drop-target')) {
      node.classList.remove('drop-target');
    }
    app.dragging = false;

    if (!moved) {
      app.select({ kind: 'task', id: task.id });
      return;
    }

    const laneChanged = curLaneIndex !== laneIndex && laneIndex >= 0;
    const startChanged = curStart !== task.startDay;
    const durationChanged = curDuration !== task.durationDays;

    if (laneChanged) {
      await app.call(() =>
        app.conn!.reducers.moveTaskToLane({
          taskId: task.id,
          laneId: lanes[curLaneIndex].id,
          startDay: curStart,
        })
      );
    } else if (mode === 'resize-left') {
      // Two reducers, each atomic on its own. The move goes first so the bar's right edge — the
      // one the user is not holding — never appears to jump.
      const movedOk = startChanged
        ? await app.call(() => app.conn!.reducers.moveTask({ taskId: task.id, startDay: curStart }))
        : true;
      if (movedOk && durationChanged) {
        await app.call(() =>
          app.conn!.reducers.resizeTask({ taskId: task.id, durationDays: curDuration })
        );
      }
    } else if (startChanged) {
      await app.call(() => app.conn!.reducers.moveTask({ taskId: task.id, startDay: curStart }));
    } else if (durationChanged) {
      await app.call(() =>
        app.conn!.reducers.resizeTask({ taskId: task.id, durationDays: curDuration })
      );
    }

    // Whether it committed or was refused, the next paint comes from the rows.
    app.requestRender();
  };

  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

/** Predecessor arrows: from the end of the earlier bar to the start of the later one. */
function renderDependencies(app: PlannerApp, trackW: number): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'deps');
  const height = Math.max(1, app.snapshot.lanes.length) * LANE_H;
  svg.setAttribute('width', String(trackW));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${trackW} ${height}`);

  const defs = document.createElementNS(NS, 'defs');
  const marker = document.createElementNS(NS, 'marker');
  marker.setAttribute('id', 'depArrow');
  marker.setAttribute('viewBox', '0 0 8 8');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '4');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const head = document.createElementNS(NS, 'path');
  head.setAttribute('d', 'M0 0 L8 4 L0 8 z');
  head.setAttribute('fill', 'rgba(120,150,145,0.75)');
  marker.append(head);
  defs.append(marker);
  svg.append(defs);

  const laneRow = new Map<bigint, number>();
  app.snapshot.lanes.forEach((lane, index) => laneRow.set(lane.id, index));

  for (const task of app.snapshot.tasks) {
    if (task.predecessorId === 0n) continue;
    const from = app.snapshot.taskById.get(task.predecessorId);
    if (!from) continue;
    const fromRow = laneRow.get(from.laneId);
    const toRow = laneRow.get(task.laneId);
    if (fromRow === undefined || toRow === undefined) continue;

    const x1 = (from.startDay + Math.max(1, from.durationDays) - app.originDay) * app.dayWidth;
    const y1 = fromRow * LANE_H + LANE_H / 2;
    const x2 = (task.startDay - app.originDay) * app.dayWidth;
    const y2 = toRow * LANE_H + LANE_H / 2;
    const midX = x2 > x1 + 16 ? (x1 + x2) / 2 : x1 + 12;

    const path = document.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgba(120,150,145,0.55)');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('marker-end', 'url(#depArrow)');
    svg.append(path);
  }

  return svg;
}

/** Used by the toolbar and by a double-click on empty track. */
export function createTaskAt(app: PlannerApp, laneId: bigint, startDay: number): void {
  if (!app.conn) {
    app.say('Not connected — the task was not created.', 'error');
    return;
  }
  app.selectNext('task');
  void app.call(() =>
    app.conn!.reducers.createTask({
      laneId,
      name: 'New task',
      startDay,
      durationDays: 5,
      percentComplete: 0,
      predecessorId: 0n,
    })
  );
}

/** Drop hit-testing for a dragged avatar: which bar is under this point, if any. */
export function taskUnderPoint(app: PlannerApp, x: number, y: number): Task | null {
  const node = document.elementFromPoint(x, y) as HTMLElement | null;
  const bar = node?.closest('.bar') as HTMLElement | null;
  if (!bar) return null;
  const id = bar.dataset.taskId;
  if (!id) return null;
  return app.snapshot.taskById.get(BigInt(id)) ?? null;
}

/** Assigns, unless the row already exists — the drop the server would refuse is simply not made. */
export function assignPersonToTask(app: PlannerApp, taskId: bigint, personId: bigint): void {
  if (!app.conn) {
    app.say('Not connected — nobody was assigned.', 'error');
    return;
  }
  if (isAssigned(app.snapshot, taskId, personId)) return;
  void app.call(
    () => app.conn!.reducers.assignPerson({ taskId, personId }),
    // Belt and braces: two drops in the same frame race the subscription, and the second one
    // being refused is not an error worth a toast.
    { ignore: /already assigned/i }
  );
}
