//! Tasks: the bars. Dragging, resizing and the completion slider all land here.
//!
//! Each gesture gets its own narrow reducer rather than going through `update_task`, because a
//! drag sends a burst of them and a full-row update would carry — and therefore re-assert — the
//! four fields the drag never touched.

use spacetimedb::{reducer, ReducerContext, Table};

use crate::reducers::{check_predecessor, delete_assignments_where, require_lane, require_task};
use crate::tables::*;
use crate::validate;

#[reducer]
pub fn create_task(
    ctx: &ReducerContext,
    lane_id: u64,
    name: String,
    start_day: i32,
    duration_days: i32,
    percent_complete: i32,
    predecessor_id: u64,
) -> Result<(), String> {
    require_lane(ctx, lane_id)?;
    let name = validate::name(&name, "Task")?;
    let start_day = validate::start_day(start_day)?;
    let duration_days = validate::duration_days(duration_days)?;
    let percent_complete = validate::percent(percent_complete)?;
    validate::span(start_day, duration_days)?;
    // Id 0 is not yet taken, so "is it itself?" cannot fire here; the existence test still must.
    check_predecessor(ctx, 0, predecessor_id)?;

    let row = ctx.db.task().insert(Task {
        id: 0,
        lane_id,
        name,
        start_day,
        duration_days,
        percent_complete,
        predecessor_id,
    });
    spacetimedb::log::info!(
        "created task {} \"{}\" on lane {} at day {} for {} day(s)",
        row.id,
        row.name,
        row.lane_id,
        row.start_day,
        row.duration_days
    );
    Ok(())
}

/// The edit panel's write path: everything the panel shows, in one transaction.
#[reducer]
pub fn update_task(
    ctx: &ReducerContext,
    task_id: u64,
    lane_id: u64,
    name: String,
    start_day: i32,
    duration_days: i32,
    percent_complete: i32,
    predecessor_id: u64,
) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    require_lane(ctx, lane_id)?;
    let name = validate::name(&name, "Task")?;
    let start_day = validate::start_day(start_day)?;
    let duration_days = validate::duration_days(duration_days)?;
    let percent_complete = validate::percent(percent_complete)?;
    validate::span(start_day, duration_days)?;
    check_predecessor(ctx, task_id, predecessor_id)?;

    ctx.db.task().id().update(Task {
        id: existing.id,
        lane_id,
        name,
        start_day,
        duration_days,
        percent_complete,
        predecessor_id,
    });
    Ok(())
}

/// The completion slider.
#[reducer]
pub fn set_task_percent(
    ctx: &ReducerContext,
    task_id: u64,
    percent_complete: i32,
) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    let percent_complete = validate::percent(percent_complete)?;
    ctx.db.task().id().update(Task {
        percent_complete,
        ..existing
    });
    Ok(())
}

/// Dragging a bar sideways. Duration is untouched, so the bar keeps its width.
#[reducer]
pub fn move_task(ctx: &ReducerContext, task_id: u64, start_day: i32) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    let start_day = validate::start_day(start_day)?;
    validate::span(start_day, existing.duration_days)?;
    ctx.db.task().id().update(Task {
        start_day,
        ..existing
    });
    Ok(())
}

/// Dragging a bar's edge. `start_day` is untouched, so the left edge stays put; a drag on the
/// left edge is a `move_task` and a `resize_task` in the same gesture.
#[reducer]
pub fn resize_task(ctx: &ReducerContext, task_id: u64, duration_days: i32) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    let duration_days = validate::duration_days(duration_days)?;
    validate::span(existing.start_day, duration_days)?;
    ctx.db.task().id().update(Task {
        duration_days,
        ..existing
    });
    Ok(())
}

/// Dragging a bar onto another lane. One reducer rather than a move plus a lane change, because
/// a diagonal drag is one gesture and half of it landing is worse than none of it landing.
#[reducer]
pub fn move_task_to_lane(
    ctx: &ReducerContext,
    task_id: u64,
    lane_id: u64,
    start_day: i32,
) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    require_lane(ctx, lane_id)?;
    let start_day = validate::start_day(start_day)?;
    validate::span(start_day, existing.duration_days)?;
    ctx.db.task().id().update(Task {
        lane_id,
        start_day,
        ..existing
    });
    Ok(())
}

/// Dragging a dependency arrow, or clearing one with `predecessor_id = 0`.
#[reducer]
pub fn set_task_predecessor(
    ctx: &ReducerContext,
    task_id: u64,
    predecessor_id: u64,
) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;
    check_predecessor(ctx, task_id, predecessor_id)?;
    ctx.db.task().id().update(Task {
        predecessor_id,
        ..existing
    });
    Ok(())
}

/// Deleting a task takes its assignments with it, and clears any other task's predecessor that
/// pointed at it. Both are dangling references rather than user content: an assignment to a task
/// that is gone draws nothing, and a predecessor id that resolves to no row draws an arrow into
/// empty space.
#[reducer]
pub fn delete_task(ctx: &ReducerContext, task_id: u64) -> Result<(), String> {
    let existing = require_task(ctx, task_id)?;

    let dependents: Vec<Task> = ctx
        .db
        .task()
        .iter()
        .filter(|t| t.predecessor_id == task_id)
        .collect();
    for dependent in &dependents {
        ctx.db.task().id().update(Task {
            predecessor_id: 0,
            ..dependent.clone()
        });
    }

    let dropped = delete_assignments_where(ctx, |a| a.task_id == task_id);
    ctx.db.task().id().delete(task_id);
    spacetimedb::log::info!(
        "deleted task {} \"{}\", {} assignment(s), cleared {} predecessor link(s)",
        existing.id,
        existing.name,
        dropped,
        dependents.len()
    );
    Ok(())
}
