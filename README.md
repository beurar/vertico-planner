# Vertico Planner

A small Gantt planner — personnel, lanes, task bars, drag-to-assign — that keeps its data in its
own SpacetimeDB database on this machine.

This repository currently holds **the module** (`module/`), which is the whole write path. The
Electron app that draws the chart lands beside it in `app/`.

> ⚠ **This is not the game.** The Vertico Universe game server lives in the database
> `vertico-universe` on the same local SpacetimeDB host. This project's database is
> **`vertico-planner`** and nothing here ever names the other one. `--delete-data` is only ever
> pointed at `vertico-planner`.

---

## Running it

The module needs a local SpacetimeDB server. Start it detached and leave it running:

```powershell
Start-Process spacetime -ArgumentList start,--listen-addr,127.0.0.1:3000 -WindowStyle Hidden
```

Publish the module:

```bash
spacetime publish vertico-planner --server local --module-path ./module -y
```

The first publish runs `init`, which seeds four default lanes so the chart is not a blank grid.
Add `--delete-data=always` to start from nothing again — it re-runs `init`, and it is safe here
because this database holds only the plan.

Prove the write path end to end:

```bash
bash tools/roundtrip.sh          # 41 assertions: every reducer, and every refusal
```

Look at the data at any time:

```bash
spacetime sql vertico-planner "SELECT id, name, start_day, duration_days, percent_complete FROM task"
spacetime logs vertico-planner
```

Generate typed client bindings for the app (verified working on CLI 2.8.3):

```bash
spacetime generate --lang typescript --out-dir app/src/module_bindings --module-path ./module -y
```

Compile-check the module without publishing:

```bash
cd module && cargo check --target wasm32-unknown-unknown
```

⚠ `cargo build` and `cargo test` for the module fail **on this machine** with
`error calling dlltool 'dlltool.exe': program not found` — `getrandom` cannot build for the
windows-gnu host. That is environmental, not a defect: the wasm target, which is the one that
matters, builds fine. The pure validators in `module/src/validate.rs` depend on nothing from
SpacetimeDB, so they can be unit-tested by host-mounting that one file into a scratch crate with
`#[path = ".../validate.rs"] pub mod validate;` and running `cargo test` there (4/4 green).

---

## The data model

Four tables, all public — there is one user and the app subscribes to everything.

| Table | Columns |
|---|---|
| `person` | `id`, `name`, `role`, `avatar_colour`, `initials` |
| `lane` | `id`, `name`, `colour`, `sort_order` |
| `task` | `id`, `lane_id`, `name`, `start_day`, `duration_days`, `percent_complete`, `predecessor_id` |
| `assignment` | `id`, `task_id`, `person_id` |

Two decisions worth knowing before you read the code:

**Dates are integer epoch days, never timestamps.** `start_day` is days since 1970-01-01 and a
bar covers `[start_day, start_day + duration_days)`. A Gantt works in whole days; a timestamp
would drag timezones and DST into arithmetic that is meant to be an addition, and produce
off-by-one bars for exactly the users whose local midnight falls the other side of UTC.
Conversion to and from a calendar date happens at the UI edge only.

**An avatar is a colour plus initials, not an image.** Rows stay tiny and no base64 blob rides in
a database row. Blank initials are derived from the name (`Ada Lovelace` → `AL`). Real photographs,
if they are ever wanted, are a file path or an asset store — still not a blob column.

`predecessor_id = 0` means "no predecessor": id 0 is never issued, because `#[auto_inc]` only
assigns when the field is 0.

---

## Reducers are the only write path

Twenty of them. Each returns `Result<(), String>` and **refuses with a sentence** rather than
clamping a bad value, which is what makes optimistic dragging safe: the app moves the bar
immediately, the reducer either commits or refuses, and a refusal leaves the row untouched so the
subscription pushes the old row straight back and the bar snaps.

| Group | Reducers |
|---|---|
| People | `create_person`, `update_person`, `delete_person` |
| Lanes | `create_lane`, `update_lane`, `set_lane_colour`, `reorder_lane`, `delete_lane` |
| Tasks | `create_task`, `update_task`, `delete_task` |
| Gestures | `set_task_percent`, `move_task`, `resize_task`, `move_task_to_lane`, `set_task_predecessor` |
| Assignment | `assign_person`, `unassign_person` |
| Whole plan | `wipe_plan`, `import_plan` |

Each drag gesture has its own narrow reducer instead of going through `update_task`, because a
drag sends a burst of them and a full-row update would carry — and re-assert — the fields the
drag never touched.

### What gets refused, and in what words

| Attempt | Refusal |
|---|---|
| a blank name | `Task name cannot be empty` |
| a colour that is not `#rrggbb` | `Lane colour must be a hex colour like #3ee8b0, got "mint"` |
| more than three initials | `Initials are 4 characters; the limit is 3 (leave them blank to derive them from the name)` |
| a percentage outside 0–100 | `Percent complete must be between 0 and 100, got 140` |
| a duration below 1 day | `Duration must be at least 1 day, got 0` |
| a start day past ±100000 | `Start day 999999 is outside the supported range of ±100000 days from 1970-01-01` |
| an id that does not exist | `Lane 999999 does not exist` |
| a task as its own predecessor | `A task cannot be its own predecessor` |
| a dependency loop of any length | `Task 6 already depends on task 5; that would make a cycle` |
| the same avatar dropped twice | `Ada Lovelace is already assigned to "Survey the site"` |
| deleting a lane that holds tasks | `Lane "Build" still holds 2 task(s); move or delete them first` |

Two things are normalised rather than refused, and both are deliberate: a colour is lower-cased,
so `#3EE8B0` and `#3ee8b0` are one value; and blank initials are derived from the name, because
an omitted optional field is not an invalid one.

Deletion cascades only over **dependent** rows, never user content. `delete_person` takes that
person's assignments; `delete_task` takes its assignments and clears any predecessor pointing at
it. `delete_lane` refuses while the lane still holds tasks — cascading there would destroy real
work on one misplaced click, and there is no undo.

---

## Local save

Nothing leaves this machine: the server listens on `127.0.0.1:3000` and the app talks to it over
a loopback WebSocket. The app is nevertheless dead when the server is down, so it must say so
rather than swallow edits — and `wipe_plan` / `import_plan` are the write half of Export/Import
JSON, so a plan can be backed up to a real file and restored into an empty database.

`import_plan` **remaps ids** instead of restoring them: an exported file's ids sit beside an
`#[auto_inc]` sequence that never issued them, and re-inserting them verbatim would eventually
collide with a fresh insert. So every row goes in with `id = 0`, an old→new map per table
rewrites `lane_id` / `predecessor_id` / `task_id` / `person_id`, and predecessors are wired in a
second pass so a file may list a task before the one it depends on. A reducer is one
transaction, so a file with one bad row on line 400 leaves the existing plan exactly as it was
rather than half replaced — `tools/roundtrip.sh` asserts that.

---

## Layout

```
module/
  Cargo.toml
  src/
    lib.rs            module docs, the `init` seed
    tables.rs         the four tables
    validate.rs       pure field validators (host-testable, refuse-never-clamp)
    reducers/
      mod.rs          shared lookups, the predecessor cycle walk
      people.rs  lanes.rs  tasks.rs  assignments.rs  plan_io.rs
tools/
  roundtrip.sh        the acceptance harness
```

⚠ The reducer submodules are **plural** on purpose. `#[table(accessor = task, ...)]` generates a
trait *named* `task`, and a `mod task;` beside it shadows that trait out of every
`use crate::tables::*` in the subtree — with a compiler error that blames the `ctx.db.task()`
call site instead of the module declaration.
