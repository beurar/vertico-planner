//! Whole-plan writes: **New plan** and **Import**.
//!
//! The app's Export is a pure read — the renderer already holds every row through its
//! subscription, so it serialises what it has and hands it to a Save dialog. Import is the
//! opposite and cannot be pure, so it lives here as one reducer.
//!
//! ## Why import remaps ids instead of restoring them
//!
//! An exported file carries the ids it was written with. Re-inserting those verbatim would put
//! rows beside an `#[auto_inc]` sequence that never saw them, and the next ordinary insert would
//! eventually collide. So `import_plan` inserts every row with `id = 0`, keeps an
//! old→new map per table, and rewrites `lane_id`, `predecessor_id`, `task_id` and `person_id`
//! through it. The plan comes back identical in shape; only the numbers change.
//!
//! ## Why refusing part-way is safe
//!
//! A reducer is one transaction. Every refusal below rolls the whole import back, so a file with
//! one bad colour on row 400 leaves the existing plan exactly as it was rather than half
//! replaced.

use std::collections::BTreeMap;

use spacetimedb::{reducer, ReducerContext, SpacetimeType, Table};

use crate::reducers::require_authenticated;
use crate::tables::*;
use crate::validate;

#[derive(SpacetimeType, Clone, Debug)]
pub struct PersonImport {
    pub id: u64,
    pub name: String,
    pub role: String,
    pub avatar_colour: String,
    pub initials: String,
}

#[derive(SpacetimeType, Clone, Debug)]
pub struct LaneImport {
    pub id: u64,
    pub name: String,
    pub colour: String,
    pub sort_order: i32,
}

#[derive(SpacetimeType, Clone, Debug)]
pub struct TaskImport {
    pub id: u64,
    pub lane_id: u64,
    pub name: String,
    pub start_day: i32,
    pub duration_days: i32,
    pub percent_complete: i32,
    pub predecessor_id: u64,
}

#[derive(SpacetimeType, Clone, Debug)]
pub struct AssignmentImport {
    pub task_id: u64,
    pub person_id: u64,
}

/// Empty every table. The **New plan** command, and the first half of an import.
#[reducer]
pub fn wipe_plan(ctx: &ReducerContext) -> Result<(), String> {
    require_authenticated(ctx)?;
    wipe(ctx);
    spacetimedb::log::info!("plan wiped");
    Ok(())
}

fn wipe(ctx: &ReducerContext) {
    let ids: Vec<u64> = ctx.db.assignment().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.assignment().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.task().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.task().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.lane().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.lane().id().delete(id);
    }
    let ids: Vec<u64> = ctx.db.person().iter().map(|r| r.id).collect();
    for id in ids {
        ctx.db.person().id().delete(id);
    }
}

/// Replace the whole plan with the contents of an exported file.
#[reducer]
pub fn import_plan(
    ctx: &ReducerContext,
    people: Vec<PersonImport>,
    lanes: Vec<LaneImport>,
    tasks: Vec<TaskImport>,
    assignments: Vec<AssignmentImport>,
) -> Result<(), String> {
    require_authenticated(ctx)?;
    wipe(ctx);

    let mut person_ids: BTreeMap<u64, u64> = BTreeMap::new();
    for (index, row) in people.iter().enumerate() {
        let name = validate::name(&row.name, "Person")
            .map_err(|e| format!("people[{index}]: {e}"))?;
        let role = validate::optional_text(&row.role, "Role")
            .map_err(|e| format!("people[{index}]: {e}"))?;
        let avatar_colour = validate::colour(&row.avatar_colour, "Avatar colour")
            .map_err(|e| format!("people[{index}]: {e}"))?;
        let initials = validate::initials(&row.initials, &name)
            .map_err(|e| format!("people[{index}]: {e}"))?;
        let inserted = ctx.db.person().insert(Person {
            id: 0,
            name,
            role,
            avatar_colour,
            initials,
        });
        person_ids.insert(row.id, inserted.id);
    }

    let mut lane_ids: BTreeMap<u64, u64> = BTreeMap::new();
    for (index, row) in lanes.iter().enumerate() {
        let name = validate::name(&row.name, "Lane").map_err(|e| format!("lanes[{index}]: {e}"))?;
        let colour = validate::colour(&row.colour, "Lane colour")
            .map_err(|e| format!("lanes[{index}]: {e}"))?;
        let sort_order =
            validate::sort_order(row.sort_order).map_err(|e| format!("lanes[{index}]: {e}"))?;
        let inserted = ctx.db.lane().insert(Lane {
            id: 0,
            name,
            colour,
            sort_order,
        });
        lane_ids.insert(row.id, inserted.id);
    }

    // Tasks land with no predecessor, then a second pass wires them: a file is free to list a
    // task before the one it depends on.
    let mut task_ids: BTreeMap<u64, u64> = BTreeMap::new();
    for (index, row) in tasks.iter().enumerate() {
        let name = validate::name(&row.name, "Task").map_err(|e| format!("tasks[{index}]: {e}"))?;
        let start_day =
            validate::start_day(row.start_day).map_err(|e| format!("tasks[{index}]: {e}"))?;
        let duration_days = validate::duration_days(row.duration_days)
            .map_err(|e| format!("tasks[{index}]: {e}"))?;
        let percent_complete = validate::percent(row.percent_complete)
            .map_err(|e| format!("tasks[{index}]: {e}"))?;
        validate::span(start_day, duration_days).map_err(|e| format!("tasks[{index}]: {e}"))?;
        let lane_id = *lane_ids.get(&row.lane_id).ok_or_else(|| {
            format!(
                "tasks[{index}] \"{}\" names lane {}, which the file does not contain",
                row.name, row.lane_id
            )
        })?;
        let inserted = ctx.db.task().insert(Task {
            id: 0,
            lane_id,
            name,
            start_day,
            duration_days,
            percent_complete,
            predecessor_id: 0,
        });
        task_ids.insert(row.id, inserted.id);
    }

    for (index, row) in tasks.iter().enumerate() {
        if row.predecessor_id == 0 {
            continue;
        }
        let new_id = task_ids[&row.id];
        let predecessor_id = *task_ids.get(&row.predecessor_id).ok_or_else(|| {
            format!(
                "tasks[{index}] \"{}\" names predecessor {}, which the file does not contain",
                row.name, row.predecessor_id
            )
        })?;
        if predecessor_id == new_id {
            return Err(format!(
                "tasks[{index}] \"{}\" is its own predecessor",
                row.name
            ));
        }
        let existing = ctx.db.task().id().find(new_id).expect("just inserted");
        ctx.db.task().id().update(Task {
            predecessor_id,
            ..existing
        });
    }

    // The wiring pass above can only build a cycle out of rows the file itself contains, so the
    // check runs once at the end over the finished table rather than per row.
    reject_cycles(ctx)?;

    let mut seen: Vec<(u64, u64)> = Vec::new();
    for (index, row) in assignments.iter().enumerate() {
        let task_id = *task_ids.get(&row.task_id).ok_or_else(|| {
            format!(
                "assignments[{index}] names task {}, which the file does not contain",
                row.task_id
            )
        })?;
        let person_id = *person_ids.get(&row.person_id).ok_or_else(|| {
            format!(
                "assignments[{index}] names person {}, which the file does not contain",
                row.person_id
            )
        })?;
        if seen.contains(&(task_id, person_id)) {
            continue;
        }
        seen.push((task_id, person_id));
        ctx.db.assignment().insert(Assignment {
            id: 0,
            task_id,
            person_id,
        });
    }

    spacetimedb::log::info!(
        "imported {} people, {} lanes, {} tasks, {} assignments",
        people.len(),
        lanes.len(),
        tasks.len(),
        seen.len()
    );
    Ok(())
}

/// Walk every task's predecessor chain; refuse if any of them fails to terminate.
fn reject_cycles(ctx: &ReducerContext) -> Result<(), String> {
    let guard = ctx.db.task().count() as usize + 1;
    for task in ctx.db.task().iter() {
        let mut walker = task.predecessor_id;
        let mut steps = 0usize;
        while walker != 0 {
            if walker == task.id {
                return Err(format!(
                    "The imported plan has a circular dependency around task \"{}\"",
                    task.name
                ));
            }
            let Some(next) = ctx.db.task().id().find(walker) else {
                break;
            };
            walker = next.predecessor_id;
            steps += 1;
            if steps > guard {
                return Err("The imported plan has a circular dependency".to_string());
            }
        }
    }
    Ok(())
}
