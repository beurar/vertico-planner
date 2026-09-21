# Vertico Planner

### 🔗 [Open the live planner](https://beurar.github.io/vertico-planner/) — the whole team uses this link

A small Gantt planner — personnel, lanes, task bars, drag-to-assign — backed by SpacetimeDB.

The team version above runs entirely in the browser (no install) and talks to a shared database
on SpacetimeDB **Maincloud**, so everyone sees the same plan update live. The whole page is
private to the team: the first visit from any browser asks for the shared passphrase before
showing anything, and remembers it after that (see [Access control](#access-control), including
what this gate does and doesn't actually protect). The page also checks for a newer deploy every
few minutes and offers a one-click reload — see [Staying up to date](#staying-up-to-date).

This repository holds **the module** (`module/`, the whole write path) and **the app** (`app/`,
one renderer shared by an Electron build for local development and the browser build that's
deployed above).

> ⚠ **This is not the game.** The Vertico Universe game server lives in the database
> `vertico-universe`. This project's databases are named `vertico-planner*` and nothing here ever
> names the other one. `--delete-data` is only ever pointed at a `vertico-planner*` database.

---

## Deployment: how the team's copy stays online

Two independent pieces are deployed, and neither one is this machine:

| Piece | Where | How it gets there |
|---|---|---|
| The module (write path) | SpacetimeDB **Maincloud**, database `vertico-planner-d6f218` | A one-off `spacetime publish`, by hand, from whoever has the CLI logged in — see below. Maincloud is a paid tier on this account, so this is deliberately not automated on every push. |
| The app (UI) | GitHub Pages, `app/dist-web/` built by `app/build.mjs --web` | Automatic — `.github/workflows/deploy.yml` builds and publishes on every push to `main` that touches `app/`. |

Republishing the module (schema or reducer changes):

```bash
spacetime publish vertico-planner-d6f218 --server maincloud --module-path ./module -y
```

Adding a table is a safe additive migration; **never pass `--delete-data` against this database**
— unlike the local one below, it holds the real plan. If a manual migration is ever needed, do it
by hand with `spacetime sql`, not by deleting and re-running `init`.

### Access control

Two layers, deliberately different in what they actually guarantee.

**Writes are server-enforced.** `app_secret` and `authorized` (see `module/src/tables.rs`) are
deliberately **not** `public` — SpacetimeDB never sends a private table to any client, by
subscription or by query, so this is enforced by the server, not by the app hiding a button.
Every mutating reducer starts with `require_authenticated`. `authenticate(passphrase)` adds the
caller's identity to `authorized` on a correct guess, and that identity — one per browser, via the
token `connection.ts` keeps in `localStorage` — stays authorised until the database is wiped.

**The view itself is only client-blocked, not private.** `auth.ts` shows a full-screen,
undismissable passphrase gate over the whole app the moment it boots, unless this browser already
unlocked once (a second `localStorage` flag, separate from the identity token). This keeps a
casual visitor out. It is **not** real confidentiality: the four data tables (`person`, `lane`,
`task`, `assignment`) stay `public` — reads were never worth gating server-side for this app — so
the WebSocket connection underneath is live the whole time the gate is up, and anyone reading the
page's own source could query it directly, bypassing the UI entirely. Treat the gate as "keeps the
board off the public internet's casual radar," not as encryption.

Because the "already unlocked" flag is new, a teammate who authenticated before this existed
(by editing something, back when only writes were gated) will still see the gate once — their
identity is still authorised server-side, but this browser's local flag is not.

The passphrase itself is **not** in this repository, on purpose — a real credential does not
belong in source control, even a public one. `app_secret.passphrase` starts empty on a fresh
database; set or change it directly against the database, which needs the CLI logged in as the
database's owner:

```bash
spacetime sql --server maincloud vertico-planner-d6f218 "UPDATE app_secret SET passphrase = '...' WHERE id = 1"
```

If the database already existed before `app_secret` did (an `UPDATE` against a table that has no
row yet silently affects zero rows — `init` only seeds it on a *fresh* database), `INSERT` instead:

```bash
spacetime sql --server maincloud vertico-planner-d6f218 "INSERT INTO app_secret (id, passphrase) VALUES (1, '...')"
```

Share the value with the team over whatever channel you already trust with internal-only info —
not a public place.

### Staying up to date

`app/web/update-check.js` polls `version.json` (rewritten by the deploy workflow with the commit
just published) every few minutes and shows a small "Reload" banner the moment it disagrees with
the version the tab was loaded with. It never reloads on its own — forcing a reload out from under
someone mid-drag would be worse than a tab that's a few minutes stale — so a teammate who leaves a
tab open across a deploy has to click through once, deliberately.

---

## Running it locally

For development, or to try a change before it reaches the team. This talks to a **local**
SpacetimeDB server, entirely separate from the Maincloud database above — nothing you do here
touches the team's plan.

The module needs a local SpacetimeDB server. Start it detached and leave it running:

```powershell
Start-Process spacetime -ArgumentList start,--listen-addr,127.0.0.1:3000 -WindowStyle Hidden
```

Publish the module:

```bash
spacetime publish vertico-planner --server local --module-path ./module -y
```

The first publish runs `init`, which seeds four default lanes (and an empty `app_secret` row) so
the chart is not a blank grid. Add `--delete-data=always` to start from nothing again — it re-runs
`init`, and it is safe here because this database holds only local test data. After any publish
that (re-)creates `app_secret`, set a local passphrase before the app can write anything:

```bash
spacetime sql vertico-planner "UPDATE app_secret SET passphrase = 'local-dev' WHERE id = 1"
```

Prove the write path end to end:

```bash
ROUNDTRIP_PASSPHRASE=local-dev bash tools/roundtrip.sh    # 44 assertions: every reducer, every refusal, the gate itself
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

Private tables (`app_secret`, `authorized`) are silently skipped by `generate` — that's correct,
not a bug: there is nothing for a client to bind to on a table it can never see.

Run the Electron app against local (`app/`):

```bash
cd app && npm ci && npm start
```

Or build and serve the same browser bundle the team uses, against local — `bridge.js` points at
Maincloud by default, so for a throwaway local check edit the `uri`/`database` in
`app/web/bridge.js` (don't commit that change):

```bash
cd app && npm run build:web
python -m http.server 8123 --directory dist-web    # then open http://127.0.0.1:8123
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

Six tables. The four the app draws from are public — everyone subscribes to all of them, and
there is no per-user data to hide. Two more, `app_secret` and `authorized`, are deliberately
**not** public — see [Access control](#access-control).

| Table | Columns |
|---|---|
| `person` | `id`, `name`, `role`, `avatar_colour`, `initials` |
| `lane` | `id`, `name`, `colour`, `sort_order` |
| `task` | `id`, `lane_id`, `name`, `start_day`, `duration_days`, `percent_complete`, `predecessor_id` |
| `assignment` | `id`, `task_id`, `person_id` |
| `app_secret` *(private)* | `id`, `passphrase` |
| `authorized` *(private)* | `identity` |

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

Twenty-one of them. Every one but `authenticate` itself returns `Result<(), String>` and
**refuses with a sentence** rather than clamping a bad value, which is what makes optimistic
dragging safe: the app moves the bar immediately, the reducer either commits or refuses, and a
refusal leaves the row untouched so the subscription pushes the old row straight back and the bar
snaps.

| Group | Reducers |
|---|---|
| Access | `authenticate` |
| People | `create_person`, `update_person`, `delete_person` |
| Lanes | `create_lane`, `update_lane`, `set_lane_colour`, `reorder_lane`, `delete_lane` |
| Tasks | `create_task`, `update_task`, `delete_task` |
| Gestures | `set_task_percent`, `move_task`, `resize_task`, `move_task_to_lane`, `set_task_predecessor` |
| Assignment | `assign_person`, `unassign_person` |
| Whole plan | `wipe_plan`, `import_plan` |

Every reducer but `authenticate` starts with `require_authenticated(ctx)?` — see
[Access control](#access-control).

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
| any write before `authenticate` succeeds | `Enter the shared passphrase first` |
| the wrong passphrase | `Incorrect passphrase` |

Two things are normalised rather than refused, and both are deliberate: a colour is lower-cased,
so `#3EE8B0` and `#3ee8b0` are one value; and blank initials are derived from the name, because
an omitted optional field is not an invalid one.

Deletion cascades only over **dependent** rows, never user content. `delete_person` takes that
person's assignments; `delete_task` takes its assignments and clears any predecessor pointing at
it. `delete_lane` refuses while the lane still holds tasks — cascading there would destroy real
work on one misplaced click, and there is no undo.

---

## Export, Import, and local save

The team's plan lives on Maincloud, not on any one person's machine — see
[Deployment](#deployment-how-the-teams-copy-stays-online). Locally (`Running it locally` above)
nothing leaves the machine at all: the server listens on `127.0.0.1:3000` and the app talks to it
over a loopback WebSocket. Either way the app is dead when its server is unreachable, so it must
say so rather than swallow edits — and `wipe_plan` / `import_plan` are the write half of
Export/Import JSON, so a plan can be backed up to a real file and restored into an empty database
regardless of which database it's talking to.

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
    tables.rs         the six tables (four public, two private — see Access control)
    validate.rs       pure field validators (host-testable, refuse-never-clamp)
    reducers/
      mod.rs          shared lookups, the predecessor cycle walk, authenticate, require_authenticated
      people.rs  lanes.rs  tasks.rs  assignments.rs  plan_io.rs
tools/
  roundtrip.sh        the acceptance harness
app/
  main.js  preload.js  index.html     Electron build (local dev)
  web/
    index.html                        the page GitHub Pages actually serves
    bridge.js                         window.planner, browser-native (download/file-input, Maincloud config)
    update-check.js                   polls version.json, offers a reload
  src/renderer/                       shared by both builds — chart, drag gestures, auth.ts (the passphrase modal)
  build.mjs                           `node build.mjs` (Electron) or `--web` (dist-web/, GitHub Pages)
.github/workflows/
  deploy.yml          builds app/ and publishes dist-web/ to GitHub Pages on every push to main
```

⚠ The reducer submodules are **plural** on purpose. `#[table(accessor = task, ...)]` generates a
trait *named* `task`, and a `mod task;` beside it shadows that trait out of every
`use crate::tables::*` in the subtree — with a compiler error that blames the `ctx.db.task()`
call site instead of the module declaration.
