// The Gantt itself: the ruler, the lanes, the bars, and the three gestures that live on a bar.
//
// A gesture moves the bar under the pointer immediately and calls a reducer when the pointer is
// released. The reducer is the truth. If it refuses, `app.call` shows the sentence and
// re-renders, and the re-render paints the bar back at the row's values — the bar snaps because
// nothing local was ever written, not because anything undoes it.

import {
  dayOfMonth,
  formatDay,
  fractionOfDay,
  isMonthStart,
  isWeekend,
  lastDay,
  monthLabel,
  today,
} from './dates';
import { isFresh, puff, celebrate } from './fx';
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

/** Two bars in the same lane whose days overlap are given their own sub-row instead of drawing
 *  on top of each other — a cutaway, not a collision. */
const STACK_GAP = 3;
/** However many sub-rows a lane needs, no bar shrinks past this — thinner than this and there is
 *  nothing left to read. */
const MIN_STACK_H = 14;
/** Horizontal breathing room on each side of a bar: the "little deadspace" a dependency line
 *  needs to have somewhere to be routed *through* rather than over a block. */
const BAR_GUTTER = 1.5;
/** Extra padding added around a bar when treating it as an obstacle for line-routing — keeps a
 *  routed line from hugging a bar's edge closely enough to read as touching it. */
const LINE_GUTTER = 3;

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

/**
 * Changes `app.dayWidth` to `newDayWidth` while keeping the day under `clientX` under `clientX` —
 * the difference between a zoom that feels controlled and one that flings the chart sideways
 * every time you touch it. The scroll correction has to wait for the render the new width causes
 * (that's what actually changes the track's scrollable size), so it rides a second animation
 * frame queued right behind the render's own.
 */
export function zoomAt(
  app: PlannerApp,
  scroll: HTMLElement,
  clientX: number,
  newDayWidth: number
): void {
  if (newDayWidth === app.dayWidth) return;
  const rect = scroll.getBoundingClientRect();
  const offsetInTrack = clientX - rect.left + scroll.scrollLeft - HEAD_W;
  const dayUnderPointer = app.originDay + offsetInTrack / app.dayWidth;

  app.dayWidth = newDayWidth;
  app.requestRender();

  requestAnimationFrame(() => {
    const targetLeft = (dayUnderPointer - app.originDay) * app.dayWidth + HEAD_W;
    scroll.scrollLeft = Math.max(0, targetLeft - (clientX - rect.left));
  });
}

/** A bar's rendered rectangle, in the lanes container's own coordinate space (`left` is
 *  track-relative, `top` is lane-relative — `laneRow * LANE_H + top` is the absolute y). */
interface BarBox {
  left: number;
  width: number;
  top: number;
  height: number;
  laneRow: number;
}

/**
 * Assigns each task in a lane to a 0-indexed sub-row so that no two tasks sharing a sub-row
 * overlap in time. Greedy interval-graph colouring: sorted by start day, each task takes the
 * lowest sub-row whose most recently placed task has already ended by the time this one starts.
 */
function packSubRows(tasks: Task[]): Map<bigint, number> {
  const sorted = [...tasks].sort((a, b) => {
    if (a.startDay !== b.startDay) return a.startDay - b.startDay;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const rowEnds: number[] = [];
  const rowOf = new Map<bigint, number>();
  for (const task of sorted) {
    const endDay = task.startDay + Math.max(1, task.durationDays);
    let row = rowEnds.findIndex(end => end <= task.startDay);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(endDay);
    } else {
      rowEnds[row] = endDay;
    }
    rowOf.set(task.id, row);
  }
  return rowOf;
}

/** Divides the lane's usual bar-height allowance evenly across `subRowCount` slots. A lane with
 *  no overlap (`subRowCount === 1`) gets back exactly today's numbers — this is additive, not a
 *  redesign of the common case. */
function stackedBox(subRow: number, subRowCount: number): { top: number; height: number } {
  const pad = (LANE_H - BAR_H) / 2;
  if (subRowCount <= 1) return { top: pad, height: BAR_H };
  const raw = (BAR_H - (subRowCount - 1) * STACK_GAP) / subRowCount;
  const height = Math.max(MIN_STACK_H, raw);
  const stride = height + STACK_GAP;
  return { top: pad + subRow * stride, height };
}

/** Every task's rendered rectangle, computed once per render and shared by the bars themselves
 *  and the dependency-arrow router — the one thing both need to agree on is where a block
 *  actually is. */
function computeBarBoxes(app: PlannerApp): Map<bigint, BarBox> {
  const { snapshot, originDay, dayWidth } = app;
  const boxes = new Map<bigint, BarBox>();

  snapshot.lanes.forEach((lane, laneRow) => {
    const tasks = snapshot.tasksByLane.get(lane.id) ?? [];
    const subRowOf = packSubRows(tasks);
    let subRowCount = 1;
    for (const row of subRowOf.values()) subRowCount = Math.max(subRowCount, row + 1);

    for (const task of tasks) {
      const subRow = subRowOf.get(task.id) ?? 0;
      const { top, height } = stackedBox(subRow, subRowCount);
      const rawLeft = (task.startDay - originDay) * dayWidth;
      const rawWidth = Math.max(1, task.durationDays) * dayWidth;
      boxes.set(task.id, {
        left: rawLeft + BAR_GUTTER,
        width: Math.max(4, rawWidth - BAR_GUTTER * 2),
        top,
        height,
        laneRow,
      });
    }
  });

  return boxes;
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
  const boxes = computeBarBoxes(app);

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
  const todayIndex = today() - originDay;
  if (todayIndex >= 0 && todayIndex < dayCount) {
    const nowBand = el('div', { class: 'grid-today' });
    nowBand.style.left = px(todayIndex * dayWidth);
    nowBand.style.width = px(dayWidth);
    grid.append(nowBand);
  }
  host.append(grid);

  for (const lane of snapshot.lanes) {
    host.append(renderLane(app, lane, trackW, boxes));
  }

  host.append(renderDependencies(app, trackW, boxes));

  // Above everything, including the dependency arrows: a glance has to find "now" without caring
  // what happens to be plotted on top of it today.
  if (todayIndex >= 0 && todayIndex < dayCount) {
    host.append(renderNowLine(app, todayIndex, dayWidth));
  }

  // A label only pans if it actually overflows, and that is a layout question the DOM can
  // only answer once the bars are mounted. One pass per render, not one per bar: this reads
  // scrollWidth, which forces layout, and doing it inside renderBar would do so mid-build.
  requestAnimationFrame(() => markPanningLabels(host));
}

/**
 * The precise "now" marker: a glowing line at the actual time of day, riding above every bar and
 * arrow, with a masked, animated trail fading out behind it (earlier today) so the sweep reads as
 * motion, not just a static mark. `todayIndex`/`dayWidth` place it in the same track-relative
 * coordinate space `renderLanes`'s other overlays use; `HEAD_W` shifts it into the lanes
 * container's own space, since — unlike `.grid`'s children — this sits outside `.grid` on
 * purpose, to escape its stacking context and actually paint on top.
 */
function renderNowLine(app: PlannerApp, todayIndex: number, dayWidth: number): HTMLElement {
  const frac = fractionOfDay();
  const layer = el('div', { class: 'now-layer' });
  layer.style.left = px(HEAD_W + todayIndex * dayWidth);
  layer.style.width = px(dayWidth);
  layer.style.height = px(Math.max(1, app.snapshot.lanes.length) * LANE_H);

  const tail = el('div', { class: 'now-tail' });
  tail.style.width = px(frac * dayWidth);
  layer.append(tail);

  const line = el('div', { class: 'now-line' });
  line.style.left = px(frac * dayWidth);
  layer.append(line);

  return layer;
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

function renderLane(
  app: PlannerApp,
  lane: Lane,
  trackW: number,
  boxes: Map<bigint, BarBox>
): HTMLElement {
  const tasks = app.snapshot.tasksByLane.get(lane.id) ?? [];
  const selected = app.selection.kind === 'lane' && app.selection.id === lane.id;
  const fresh = isFresh('lane', lane.id);

  const row = el('div', {
    class: `lane${selected ? ' selected' : ''}${fresh ? ' enter' : ''}`,
    'data-lane-id': String(lane.id),
  });

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

  for (const task of tasks) {
    const box = boxes.get(task.id);
    if (box) track.append(renderBar(app, task, lane, box));
  }
  row.append(track);
  return row;
}

function renderBar(app: PlannerApp, task: Task, lane: Lane, box: BarBox): HTMLElement {
  const selected = app.selection.kind === 'task' && app.selection.id === task.id;
  const width = box.width;
  const fresh = isFresh('task', task.id);

  const thin = box.height < 24;
  const bar = el('div', {
    class: `bar${selected ? ' selected' : ''}${task.percentComplete >= 100 ? ' done' : ''}${fresh ? ' enter' : ''}${thin ? ' thin' : ''}`,
    'data-task-id': String(task.id),
    title: `${task.name} — ${formatDay(task.startDay)} → ${formatDay(
      lastDay(task.startDay, task.durationDays)
    )} (${task.durationDays}d, ${task.percentComplete}%)`,
  });
  bar.style.left = px(box.left);
  bar.style.width = px(width);
  bar.style.top = px(box.top);
  bar.style.height = px(box.height);
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

  // Assigned avatars ride the bar, so who is on what is readable without selecting anything —
  // but a bar squeezed thin by a stack of overlapping tasks doesn't have the room to also carry
  // avatars without them landing on top of the label.
  const people = app.snapshot.peopleByTask.get(task.id) ?? [];
  if (people.length > 0 && width >= 96 && box.height >= 30) {
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
  if (selected && width >= 120 && box.height >= 24) {
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
      const value = Number(slider.value);
      const justFinished = value >= 100 && task.percentComplete < 100;
      const rect = justFinished ? bar.getBoundingClientRect() : null;
      void app.call(() =>
        app.conn!.reducers.setTaskPercent({ taskId: task.id, percentComplete: value })
      ).then(ok => {
        if (ok && rect) celebrate(rect.left + rect.width / 2, rect.top + rect.height / 2, lane.colour);
      });
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
    beginBarDrag(app, event, task, lane, bar, mode);
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
  lane: Lane,
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
    // Captured before the awaits below: `bar` still sits exactly where the drag left it, and by
    // the time a reducer answers, a re-render may already have replaced the node it belongs to.
    const dropRect = bar.getBoundingClientRect();
    let committed = false;

    if (laneChanged) {
      committed = await app.call(() =>
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
      committed = movedOk;
      if (movedOk && durationChanged) {
        committed = await app.call(() =>
          app.conn!.reducers.resizeTask({ taskId: task.id, durationDays: curDuration })
        );
      }
    } else if (startChanged) {
      committed = await app.call(() => app.conn!.reducers.moveTask({ taskId: task.id, startDay: curStart }));
    } else if (durationChanged) {
      committed = await app.call(() =>
        app.conn!.reducers.resizeTask({ taskId: task.id, durationDays: curDuration })
      );
    }

    if (committed) {
      puff(dropRect.left + dropRect.width / 2, dropRect.top + dropRect.height / 2, lane.colour);
    }

    // Whether it committed or was refused, the next paint comes from the rows.
    app.requestRender();
  };

  bar.addEventListener('pointermove', onMove);
  bar.addEventListener('pointerup', onUp);
  bar.addEventListener('pointercancel', onUp);
}

/** An obstacle for line-routing: one bar's horizontal extent, padded by `LINE_GUTTER`, tagged
 *  with the lane row it sits in. */
interface Obstacle {
  laneRow: number;
  left: number;
  right: number;
}

function intersects(a: number, b: number, o: Obstacle): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return o.right > lo && o.left < hi;
}

/**
 * Picks where the elbow's vertical run crosses from the predecessor's row to the successor's —
 * the one place the previous version of this line just picked the geometric midpoint, which had
 * no idea whether some third task's bar happened to be sitting there. Tries the natural midpoint
 * first (so the common, empty-corridor case looks exactly as it always has), then walks outward
 * in small steps until it finds an x where: the horizontal run in the FROM row (`x1` to that x)
 * is clear, the horizontal run in the TO row (that x to `x2`) is clear, and every row strictly
 * between the two has nothing sitting exactly on that column (the vertical run passes straight
 * through those rows top to bottom). Gives up and falls back to the old heuristic only if the
 * whole search window is obstructed, which needs a lane packed edge to edge to happen at all.
 */
function routeMidX(
  x1: number,
  x2: number,
  fromRow: number,
  toRow: number,
  obstacles: Obstacle[]
): number {
  const fallback = x2 > x1 + 16 ? (x1 + x2) / 2 : x1 + 12;
  const rowLo = Math.min(fromRow, toRow);
  const rowHi = Math.max(fromRow, toRow);

  const valid = (mid: number): boolean => {
    for (const o of obstacles) {
      if (o.laneRow === fromRow && intersects(x1, mid, o)) return false;
      if (o.laneRow === toRow && intersects(mid, x2, o)) return false;
      if (o.laneRow > rowLo && o.laneRow < rowHi && mid > o.left && mid < o.right) return false;
    }
    return true;
  };

  if (valid(fallback)) return fallback;

  const lo = Math.min(x1, x2) - 24;
  const hi = Math.max(x1, x2) + 24;
  const STEP = 4;
  for (let d = STEP; d <= hi - lo; d += STEP) {
    if (fallback + d <= hi && valid(fallback + d)) return fallback + d;
    if (fallback - d >= lo && valid(fallback - d)) return fallback - d;
  }
  return fallback;
}

/** Predecessor arrows: from the end of the earlier bar to the start of the later one, routed
 *  through whatever deadspace `routeMidX` can find rather than straight through the midpoint. */
function renderDependencies(
  app: PlannerApp,
  trackW: number,
  boxes: Map<bigint, BarBox>
): SVGSVGElement {
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

  for (const task of app.snapshot.tasks) {
    if (task.predecessorId === 0n) continue;
    const from = app.snapshot.taskById.get(task.predecessorId);
    if (!from) continue;
    const fromBox = boxes.get(from.id);
    const toBox = boxes.get(task.id);
    if (!fromBox || !toBox) continue;

    const x1 = fromBox.left + fromBox.width;
    const y1 = fromBox.laneRow * LANE_H + fromBox.top + fromBox.height / 2;
    const x2 = toBox.left;
    const y2 = toBox.laneRow * LANE_H + toBox.top + toBox.height / 2;

    const obstacles: Obstacle[] = [];
    for (const [id, box] of boxes) {
      if (id === from.id || id === task.id) continue;
      obstacles.push({
        laneRow: box.laneRow,
        left: box.left - LINE_GUTTER,
        right: box.left + box.width + LINE_GUTTER,
      });
    }
    const midX = routeMidX(x1, x2, fromBox.laneRow, toBox.laneRow, obstacles);

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`);
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

/**
 * Assigns, unless the row already exists — the drop the server would refuse is simply not made.
 * Resolves `true` only on an actual commit, which is what a drop's own puff of feedback should be
 * conditioned on: a drop nobody's identity ever reaches the server for should stay silent.
 */
export function assignPersonToTask(
  app: PlannerApp,
  taskId: bigint,
  personId: bigint
): Promise<boolean> {
  if (!app.conn) {
    app.say('Not connected — nobody was assigned.', 'error');
    return Promise.resolve(false);
  }
  if (isAssigned(app.snapshot, taskId, personId)) return Promise.resolve(false);
  return app.call(
    () => app.conn!.reducers.assignPerson({ taskId, personId }),
    // Belt and braces: two drops in the same frame race the subscription, and the second one
    // being refused is not an error worth a toast.
    { ignore: /already assigned/i }
  );
}
