// The renderer's read model.
//
// There is no local mutable copy of the plan. Every render reads the subscription's cache and
// builds a plain snapshot from it, which is what makes the "the row is the truth" rule cheap to
// honour: a refused reducer changes nothing, the next render reads the same rows back, and a bar
// that was dragged optimistically snaps to where it actually is.
//
// The plan is a few hundred rows at most, so rebuilding the snapshot per frame costs nothing
// worth the bugs a hand-maintained cache would introduce.

import type { DbConnection } from '../module_bindings';
import type { Assignment, Lane, Person, Task } from '../module_bindings/types';

export type { Assignment, Lane, Person, Task };

export interface Snapshot {
  people: Person[];
  lanes: Lane[];
  tasks: Task[];
  assignments: Assignment[];
  personById: Map<bigint, Person>;
  laneById: Map<bigint, Lane>;
  taskById: Map<bigint, Task>;
  /** Task id → the people on it, in personnel order. */
  peopleByTask: Map<bigint, Person[]>;
  /** Task id → the assignment rows on it, for unassigning. */
  assignmentsByTask: Map<bigint, Assignment[]>;
  /** Lane id → its tasks, earliest first. */
  tasksByLane: Map<bigint, Task[]>;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  people: [],
  lanes: [],
  tasks: [],
  assignments: [],
  personById: new Map(),
  laneById: new Map(),
  taskById: new Map(),
  peopleByTask: new Map(),
  assignmentsByTask: new Map(),
  tasksByLane: new Map(),
};

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

export function snapshotOf(conn: DbConnection | null): Snapshot {
  if (!conn) return EMPTY_SNAPSHOT;

  const people = [...conn.db.person.iter()].sort(byName);
  // Ties on sort_order break by id, so two lanes may legally share an order.
  const lanes = [...conn.db.lane.iter()].sort(
    (a, b) => a.sortOrder - b.sortOrder || Number(a.id - b.id)
  );
  const tasks = [...conn.db.task.iter()].sort(
    (a, b) => a.startDay - b.startDay || Number(a.id - b.id)
  );
  const assignments = [...conn.db.assignment.iter()];

  const personById = new Map(people.map(p => [p.id, p]));
  const laneById = new Map(lanes.map(l => [l.id, l]));
  const taskById = new Map(tasks.map(t => [t.id, t]));

  const peopleByTask = new Map<bigint, Person[]>();
  const assignmentsByTask = new Map<bigint, Assignment[]>();
  for (const row of assignments) {
    const person = personById.get(row.personId);
    if (person) {
      const list = peopleByTask.get(row.taskId);
      if (list) list.push(person);
      else peopleByTask.set(row.taskId, [person]);
    }
    const rows = assignmentsByTask.get(row.taskId);
    if (rows) rows.push(row);
    else assignmentsByTask.set(row.taskId, [row]);
  }
  for (const list of peopleByTask.values()) list.sort(byName);

  const tasksByLane = new Map<bigint, Task[]>();
  for (const task of tasks) {
    const list = tasksByLane.get(task.laneId);
    if (list) list.push(task);
    else tasksByLane.set(task.laneId, [task]);
  }

  return {
    people,
    lanes,
    tasks,
    assignments,
    personById,
    laneById,
    taskById,
    peopleByTask,
    assignmentsByTask,
    tasksByLane,
  };
}

/** True when this person already sits on this task — the drop the server would refuse. */
export function isAssigned(snap: Snapshot, taskId: bigint, personId: bigint): boolean {
  const rows = snap.assignmentsByTask.get(taskId);
  return !!rows && rows.some(row => row.personId === personId);
}
