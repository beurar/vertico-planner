//! Every write path into the planner.
//!
//! Reducers are the **only** way a row changes — that is the whole reason this app keeps its
//! data in SpacetimeDB rather than a JSON file. The renderer drags a bar optimistically, but
//! the row is the truth: a reducer that refuses leaves the row where it was, the subscription
//! pushes the unchanged row back, and the bar snaps.

// ⚠ Plural, every one of them. The `#[table(accessor = task, ...)]` macro generates a trait
// *named* `task`, and a `mod task;` here would shadow it out of every `use crate::tables::*`
// in this subtree — with an error that blames the `ctx.db.task()` call site instead.
pub mod assignments;
pub mod lanes;
pub mod people;
pub mod plan_io;
pub mod tasks;

use spacetimedb::{reducer, ReducerContext, Table};

use crate::tables::*;
use crate::APP_SECRET_ROW_ID;

/// The passphrase gate. Every other reducer starts with `require_authenticated(ctx)?` — this is
/// the only one that doesn't, since it's how an identity gets into `authorized` in the first
/// place. A wrong guess costs the caller nothing but a refusal; there is no lockout, because the
/// whole point is one shared door with one shared key, not a per-identity account.
#[reducer]
pub fn authenticate(ctx: &ReducerContext, passphrase: String) -> Result<(), String> {
    let secret = ctx
        .db
        .app_secret()
        .id()
        .find(APP_SECRET_ROW_ID)
        .ok_or_else(|| "Server has no passphrase configured".to_string())?;
    if secret.passphrase.is_empty() {
        return Err("Server has no passphrase configured yet".to_string());
    }
    if passphrase != secret.passphrase {
        return Err("Incorrect passphrase".to_string());
    }
    if ctx.db.authorized().identity().find(ctx.sender()).is_none() {
        ctx.db.authorized().insert(Authorized { identity: ctx.sender() });
    }
    Ok(())
}

/// Every mutating reducer but `authenticate` itself starts here.
pub(crate) fn require_authenticated(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.authorized().identity().find(ctx.sender()).is_some() {
        Ok(())
    } else {
        Err("Enter the shared passphrase first".to_string())
    }
}

/// Fetch a task or refuse by name. Every reducer that takes a `task_id` starts here, so a stale
/// id from a client that has drifted out of date produces one recognisable sentence.
pub(crate) fn require_task(ctx: &ReducerContext, task_id: u64) -> Result<Task, String> {
    ctx.db
        .task()
        .id()
        .find(task_id)
        .ok_or_else(|| format!("Task {task_id} does not exist"))
}

pub(crate) fn require_lane(ctx: &ReducerContext, lane_id: u64) -> Result<Lane, String> {
    ctx.db
        .lane()
        .id()
        .find(lane_id)
        .ok_or_else(|| format!("Lane {lane_id} does not exist"))
}

pub(crate) fn require_person(ctx: &ReducerContext, person_id: u64) -> Result<Person, String> {
    ctx.db
        .person()
        .id()
        .find(person_id)
        .ok_or_else(|| format!("Person {person_id} does not exist"))
}

/// Validate a proposed predecessor for `task_id`.
///
/// `0` means none. Otherwise the predecessor must exist, must not be the task itself, and must
/// not already depend on the task — a two-task cycle is the obvious mistake but a longer chain
/// is the one that survives review, so the whole chain is walked. The walk is bounded by the
/// number of task rows, which makes it terminate even if a cycle somehow reached the table.
pub(crate) fn check_predecessor(
    ctx: &ReducerContext,
    task_id: u64,
    predecessor_id: u64,
) -> Result<(), String> {
    if predecessor_id == 0 {
        return Ok(());
    }
    if predecessor_id == task_id {
        return Err("A task cannot be its own predecessor".to_string());
    }
    if ctx.db.task().id().find(predecessor_id).is_none() {
        return Err(format!("Predecessor task {predecessor_id} does not exist"));
    }

    let guard = ctx.db.task().count() as usize + 1;
    let mut walker = predecessor_id;
    for _ in 0..guard {
        let Some(row) = ctx.db.task().id().find(walker) else {
            return Ok(());
        };
        if row.predecessor_id == 0 {
            return Ok(());
        }
        if row.predecessor_id == task_id {
            return Err(format!(
                "Task {predecessor_id} already depends on task {task_id}; that would make a cycle"
            ));
        }
        walker = row.predecessor_id;
    }
    Err("Predecessor chain is circular".to_string())
}

/// Delete every assignment matching a predicate and report how many went. Used by both
/// `delete_task` and `delete_person`, whose assignments are dependent rows rather than user
/// content — leaving them behind would be a dangling reference, not a kindness.
pub(crate) fn delete_assignments_where(
    ctx: &ReducerContext,
    keep_out: impl Fn(&Assignment) -> bool,
) -> usize {
    let doomed: Vec<u64> = ctx
        .db
        .assignment()
        .iter()
        .filter(|a| keep_out(a))
        .map(|a| a.id)
        .collect();
    for id in &doomed {
        ctx.db.assignment().id().delete(*id);
    }
    doomed.len()
}
