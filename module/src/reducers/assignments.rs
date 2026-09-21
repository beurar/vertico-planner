//! Assignments: dropping an avatar onto a bar, and pulling it off again.

use spacetimedb::{reducer, ReducerContext, Table};

use crate::reducers::{require_authenticated, require_person, require_task};
use crate::tables::*;

/// Refuses a duplicate rather than inserting a second identical row — the same avatar dropped
/// twice on the same bar is a slip of the mouse, and two rows would draw two avatars.
#[reducer]
pub fn assign_person(ctx: &ReducerContext, task_id: u64, person_id: u64) -> Result<(), String> {
    require_authenticated(ctx)?;
    let task = require_task(ctx, task_id)?;
    let person = require_person(ctx, person_id)?;

    let already = ctx
        .db
        .assignment()
        .assignment_by_task()
        .filter(task_id)
        .any(|a| a.person_id == person_id);
    if already {
        return Err(format!(
            "{} is already assigned to \"{}\"",
            person.name, task.name
        ));
    }

    ctx.db.assignment().insert(Assignment {
        id: 0,
        task_id,
        person_id,
    });
    Ok(())
}

#[reducer]
pub fn unassign_person(ctx: &ReducerContext, task_id: u64, person_id: u64) -> Result<(), String> {
    require_authenticated(ctx)?;
    let task = require_task(ctx, task_id)?;
    let person = require_person(ctx, person_id)?;

    let found: Vec<u64> = ctx
        .db
        .assignment()
        .assignment_by_task()
        .filter(task_id)
        .filter(|a| a.person_id == person_id)
        .map(|a| a.id)
        .collect();
    if found.is_empty() {
        return Err(format!(
            "{} is not assigned to \"{}\"",
            person.name, task.name
        ));
    }
    for id in found {
        ctx.db.assignment().id().delete(id);
    }
    Ok(())
}
