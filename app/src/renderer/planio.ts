// Export and Import.
//
// The data lives on this machine already — the server listens on loopback and nothing leaves it —
// but "on this machine" is not a backup. Export writes a plain JSON file through a real Save
// dialog; Import reads one back through `import_plan`.
//
// Export is a pure read: the renderer already holds every row through its subscription, so it
// serialises what it has. Import cannot be pure, so it is one reducer and one transaction: a file
// with a bad row on line 400 leaves the existing plan exactly as it was.
//
// Ids are written as JSON numbers. They are small `auto_inc` counters, nowhere near 2^53, and
// `import_plan` remaps them on the way in anyway — the numbers in the file are only there to wire
// `laneId`, `predecessorId` and the assignment pairs back together.

import type { PlannerApp } from './types';

const FORMAT = 'vertico-planner-plan';
const VERSION = 1;

interface PlanFile {
  format: string;
  version: number;
  exportedAt: string;
  people: { id: number; name: string; role: string; avatarColour: string; initials: string }[];
  lanes: { id: number; name: string; colour: string; sortOrder: number }[];
  tasks: {
    id: number;
    laneId: number;
    name: string;
    startDay: number;
    durationDays: number;
    percentComplete: number;
    predecessorId: number;
  }[];
  assignments: { taskId: number; personId: number }[];
}

export function serialisePlan(app: PlannerApp): string {
  const snap = app.snapshot;
  const file: PlanFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    people: snap.people.map(p => ({
      id: Number(p.id),
      name: p.name,
      role: p.role,
      avatarColour: p.avatarColour,
      initials: p.initials,
    })),
    lanes: snap.lanes.map(l => ({
      id: Number(l.id),
      name: l.name,
      colour: l.colour,
      sortOrder: l.sortOrder,
    })),
    tasks: snap.tasks.map(t => ({
      id: Number(t.id),
      laneId: Number(t.laneId),
      name: t.name,
      startDay: t.startDay,
      durationDays: t.durationDays,
      percentComplete: t.percentComplete,
      predecessorId: Number(t.predecessorId),
    })),
    assignments: snap.assignments.map(a => ({
      taskId: Number(a.taskId),
      personId: Number(a.personId),
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export async function exportPlan(app: PlannerApp): Promise<void> {
  const bridge = window.planner;
  if (!bridge) {
    app.say('The file bridge is missing — this window was not opened by the app.', 'error');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await bridge.exportJson(`vertico-plan-${stamp}.json`, serialisePlan(app));
  if (result.error) app.say(`Could not write the file: ${result.error}`, 'error');
  else if (result.saved) app.say(`Exported to ${result.path}`);
}

export async function importPlan(app: PlannerApp): Promise<void> {
  const bridge = window.planner;
  if (!bridge) {
    app.say('The file bridge is missing — this window was not opened by the app.', 'error');
    return;
  }
  if (!app.conn) {
    app.say('Not connected — there is nowhere to import to.', 'error');
    return;
  }

  const result = await bridge.importJson();
  if (result.error) {
    app.say(`Could not read the file: ${result.error}`, 'error');
    return;
  }
  if (!result.opened || !result.json) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.json);
  } catch (error) {
    app.say(`That file is not JSON: ${(error as Error).message}`, 'error');
    return;
  }

  const file = parsed as Partial<PlanFile>;
  if (
    !file ||
    !Array.isArray(file.people) ||
    !Array.isArray(file.lanes) ||
    !Array.isArray(file.tasks) ||
    !Array.isArray(file.assignments)
  ) {
    app.say('That file is not a plan: it needs people, lanes, tasks and assignments.', 'error');
    return;
  }
  if (file.format && file.format !== FORMAT) {
    app.say(`That file says it is “${file.format}”, not a ${FORMAT}.`, 'error');
    return;
  }

  const summary = `${file.people.length} people, ${file.lanes.length} lanes, ${file.tasks.length} tasks`;
  if (!window.confirm(`Replace the whole plan with ${summary}?\n\nThis cannot be undone.`)) return;

  const ok = await app.call(() =>
    app.conn!.reducers.importPlan({
      people: file.people!.map(p => ({
        id: BigInt(p.id ?? 0),
        name: String(p.name ?? ''),
        role: String(p.role ?? ''),
        avatarColour: String(p.avatarColour ?? '#3ee8b0'),
        initials: String(p.initials ?? ''),
      })),
      lanes: file.lanes!.map(l => ({
        id: BigInt(l.id ?? 0),
        name: String(l.name ?? ''),
        colour: String(l.colour ?? '#3ee8b0'),
        sortOrder: Number(l.sortOrder ?? 0),
      })),
      tasks: file.tasks!.map(t => ({
        id: BigInt(t.id ?? 0),
        laneId: BigInt(t.laneId ?? 0),
        name: String(t.name ?? ''),
        startDay: Number(t.startDay ?? 0),
        durationDays: Number(t.durationDays ?? 1),
        percentComplete: Number(t.percentComplete ?? 0),
        predecessorId: BigInt(t.predecessorId ?? 0),
      })),
      assignments: file.assignments!.map(a => ({
        taskId: BigInt(a.taskId ?? 0),
        personId: BigInt(a.personId ?? 0),
      })),
    })
  );

  if (ok) {
    app.select({ kind: 'none' });
    app.say(`Imported ${summary}. Ids were reissued.`);
  }
}

/** The New plan button: empties every table. */
export async function wipePlan(app: PlannerApp): Promise<void> {
  if (!app.conn) {
    app.say('Not connected — nothing was changed.', 'error');
    return;
  }
  if (
    !window.confirm('Empty the whole plan — people, lanes, tasks and assignments?\n\nThis cannot be undone. Export first if you want it back.')
  ) {
    return;
  }
  const ok = await app.call(() => app.conn!.reducers.wipePlan({}));
  if (ok) {
    app.select({ kind: 'none' });
    app.say('The plan is empty.');
  }
}
