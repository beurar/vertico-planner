// Headless proof that the app's write path works — the generated bindings, the reducers, the
// refusals, and the invariant the whole drag design rests on.
//
// This is the same code the renderer runs: the same `module_bindings`, the same `spacetimedb`
// SDK, the same subscription. What it cannot show is pixels. It can show that a reducer commits,
// that the subscription pushes the new row back, and — the one that matters for dragging — that
// a refused reducer leaves the row *exactly* as it was, which is what makes a bar snap back.
//
//   npm run verify        (from app/)
//
// It creates its own rows, prefixed `rt-`, and deletes them again. It never touches rows it did
// not create, and it names only `vertico-planner`.

import { DbConnection, tables } from '../src/module_bindings';
import type { Task } from '../src/module_bindings/types';

// The two bits of Node this file touches, declared rather than pulling in `@types/node` for a
// hundred-line script. Everything else here is the same API the renderer uses.
declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

const URI = process.env.PLANNER_STDB_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = process.env.PLANNER_STDB_DB ?? 'vertico-planner';

let passed = 0;
let failed = 0;

function ok(what: string): void {
  passed += 1;
  console.log(`ok   ${String(passed + failed).padStart(2)} — ${what}`);
}

function fail(what: string, detail: string): void {
  failed += 1;
  console.log(`FAIL ${String(passed + failed).padStart(2)} — ${what}\n        ${detail}`);
}

function check(what: string, condition: boolean, detail = ''): void {
  if (condition) ok(what);
  else fail(what, detail);
}

function equal<T>(what: string, actual: T, expected: T): void {
  check(what, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

/** Waits for the subscription to push something. Reducer acks and row updates are two messages. */
async function waitFor<T>(what: string, read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Runs a reducer that is meant to be refused, and returns the sentence it was refused with. */
async function refusal(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  console.log(`# vertico-planner client round-trip — ${URI} / ${DATABASE}\n`);

  const conn = await new Promise<DbConnection>((resolve, reject) => {
    const built = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DATABASE)
      .onConnect(c => {
        c.subscriptionBuilder()
          .onApplied(() => resolve(built))
          .onError(() => reject(new Error('the subscription was refused')))
          .subscribe([tables.person, tables.lane, tables.task, tables.assignment]);
      })
      .onConnectError((_ctx, error) => reject(error))
      .build();
  });
  ok(`connected and subscribed (${conn.db.lane.count()} lane(s) already in the plan)`);

  const stamp = Date.now();
  const laneName = `rt-lane-${stamp}`;
  const laneBName = `rt-lane-b-${stamp}`;
  const personName = `rt-person-${stamp}`;
  const taskName = `rt-task-${stamp}`;

  const findLane = (name: string) => [...conn.db.lane.iter()].find(l => l.name === name);
  const findTask = () => [...conn.db.task.iter()].find(t => t.name === taskName);
  const readTask = (): Task => {
    const row = findTask();
    if (!row) throw new Error('the task vanished');
    return row;
  };

  // --- create -------------------------------------------------------------------------------
  await conn.reducers.createLane({ name: laneName, colour: '#3EE8B0', sortOrder: 900 });
  const lane = await waitFor('the new lane', () => findLane(laneName));
  ok('create_lane committed and the subscription pushed the row');
  equal('the colour was normalised to lower case', lane.colour, '#3ee8b0');

  await conn.reducers.createLane({ name: laneBName, colour: '#e0a64a', sortOrder: 901 });
  const laneB = await waitFor('the second lane', () => findLane(laneBName));

  await conn.reducers.createPerson({
    name: personName,
    role: 'Surveyor',
    avatarColour: '#e0a64a',
    initials: '',
  });
  const person = await waitFor('the new person', () =>
    [...conn.db.person.iter()].find(p => p.name === personName)
  );
  ok('create_person committed');
  equal('blank initials were derived from the name', person.initials.length > 0, true);

  await conn.reducers.createTask({
    laneId: lane.id,
    name: taskName,
    startDay: 20_400,
    durationDays: 5,
    percentComplete: 0,
    predecessorId: 0n,
  });
  const task = await waitFor('the new task', findTask);
  ok('create_task committed');

  // --- the gestures -------------------------------------------------------------------------
  await conn.reducers.moveTask({ taskId: task.id, startDay: 20_403 });
  await waitFor('the moved row', () => (readTask().startDay === 20_403 ? true : undefined));
  ok('move_task — a bar dragged sideways');

  await conn.reducers.resizeTask({ taskId: task.id, durationDays: 9 });
  await waitFor('the resized row', () => (readTask().durationDays === 9 ? true : undefined));
  ok('resize_task — a bar dragged by its right edge');

  // A left-edge drag is both, in one gesture.
  await conn.reducers.moveTask({ taskId: task.id, startDay: 20_401 });
  await conn.reducers.resizeTask({ taskId: task.id, durationDays: 11 });
  await waitFor('the reshaped row', () =>
    readTask().startDay === 20_401 && readTask().durationDays === 11 ? true : undefined
  );
  ok('move_task + resize_task — a bar dragged by its left edge');

  await conn.reducers.setTaskPercent({ taskId: task.id, percentComplete: 65 });
  await waitFor('the percentage', () => (readTask().percentComplete === 65 ? true : undefined));
  ok('set_task_percent — the completion slider');

  await conn.reducers.moveTaskToLane({ taskId: task.id, laneId: laneB.id, startDay: 20_405 });
  await waitFor('the lane change', () => (readTask().laneId === laneB.id ? true : undefined));
  ok('move_task_to_lane — a bar dragged into another lane, in one call');

  await conn.reducers.setLaneColour({ laneId: lane.id, colour: '#5aa9e0' });
  await waitFor('the lane colour', () =>
    findLane(laneName)?.colour === '#5aa9e0' ? true : undefined
  );
  ok('set_lane_colour — the lane swatch');

  await conn.reducers.assignPerson({ taskId: task.id, personId: person.id });
  await waitFor('the assignment', () =>
    [...conn.db.assignment.iter()].some(a => a.taskId === task.id && a.personId === person.id)
      ? true
      : undefined
  );
  ok('assign_person — an avatar dropped on a bar');

  // --- refusals, and the snap-back invariant -------------------------------------------------
  const before = readTask();

  const twice = await refusal(() =>
    conn.reducers.assignPerson({ taskId: task.id, personId: person.id })
  );
  check(
    'the same avatar dropped twice is refused, by name',
    /already assigned/i.test(twice),
    `got: ${twice || '(it committed)'}`
  );
  equal(
    'and no second assignment row exists',
    [...conn.db.assignment.iter()].filter(a => a.taskId === task.id && a.personId === person.id)
      .length,
    1
  );

  const farAway = await refusal(() =>
    conn.reducers.moveTask({ taskId: task.id, startDay: 999_999 })
  );
  check(
    'a bar dragged past the supported range is refused with a sentence',
    /outside the supported range/i.test(farAway),
    `got: ${farAway || '(it committed)'}`
  );
  equal('and the row still holds its old start day', readTask().startDay, before.startDay);

  const zeroWidth = await refusal(() =>
    conn.reducers.resizeTask({ taskId: task.id, durationDays: 0 })
  );
  check(
    'a zero-width bar is refused, not clamped',
    /at least 1 day/i.test(zeroWidth),
    `got: ${zeroWidth || '(it committed)'}`
  );
  equal('and the row still holds its old duration', readTask().durationDays, before.durationDays);

  const overHundred = await refusal(() =>
    conn.reducers.setTaskPercent({ taskId: task.id, percentComplete: 140 })
  );
  check(
    'a percentage over 100 is refused, not clamped',
    /between 0 and 100/i.test(overHundred),
    `got: ${overHundred || '(it committed)'}`
  );
  equal('and the row still holds 65%', readTask().percentComplete, 65);

  const selfLoop = await refusal(() =>
    conn.reducers.setTaskPredecessor({ taskId: task.id, predecessorId: task.id })
  );
  check(
    'a task cannot depend on itself',
    /its own predecessor/i.test(selfLoop),
    `got: ${selfLoop || '(it committed)'}`
  );

  const badColour = await refusal(() =>
    conn.reducers.setLaneColour({ laneId: lane.id, colour: 'mint' })
  );
  check(
    'a lane colour that is not #rrggbb is refused',
    /hex colour/i.test(badColour),
    `got: ${badColour || '(it committed)'}`
  );
  equal('and the lane keeps the colour it had', findLane(laneName)?.colour, '#5aa9e0');

  const fullLane = await refusal(() => conn.reducers.deleteLane({ laneId: laneB.id }));
  check(
    'a lane that still holds tasks refuses to be deleted',
    /still holds/i.test(fullLane),
    `got: ${fullLane || '(it committed)'}`
  );

  // --- clean up ------------------------------------------------------------------------------
  await conn.reducers.deleteTask({ taskId: task.id });
  await waitFor('the deleted task', () => (findTask() ? undefined : true));
  equal(
    'deleting the task took its assignment with it',
    [...conn.db.assignment.iter()].filter(a => a.taskId === task.id).length,
    0
  );

  await conn.reducers.deletePerson({ personId: person.id });
  await conn.reducers.deleteLane({ laneId: lane.id });
  await conn.reducers.deleteLane({ laneId: laneB.id });
  await waitFor('the cleanup', () => (findLane(laneName) || findLane(laneBName) ? undefined : true));
  ok('every row this run created has been deleted again');

  conn.disconnect();
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(error => {
    console.error(`\nround-trip aborted: ${error instanceof Error ? error.message : error}`);
    console.log(`\n${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  });
