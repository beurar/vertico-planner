//! Lanes: the chart's rows, and the one place the user's own colours live.
//!
//! The app's chrome is fixed (near-black ground, mint accent) but a lane colour is **data**.
//! Nothing here snaps a lane towards the house palette; the palette only supplies the defaults
//! offered when a lane is created from the UI.

use spacetimedb::{reducer, ReducerContext, Table};

use crate::reducers::{require_authenticated, require_lane};
use crate::tables::*;
use crate::validate;

#[reducer]
pub fn create_lane(
    ctx: &ReducerContext,
    name: String,
    colour: String,
    sort_order: i32,
) -> Result<(), String> {
    require_authenticated(ctx)?;
    let name = validate::name(&name, "Lane")?;
    let colour = validate::colour(&colour, "Lane colour")?;
    let sort_order = validate::sort_order(sort_order)?;

    let row = ctx.db.lane().insert(Lane {
        id: 0,
        name,
        colour,
        sort_order,
    });
    spacetimedb::log::info!("created lane {} \"{}\"", row.id, row.name);
    Ok(())
}

#[reducer]
pub fn update_lane(
    ctx: &ReducerContext,
    lane_id: u64,
    name: String,
    colour: String,
    sort_order: i32,
) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_lane(ctx, lane_id)?;
    let name = validate::name(&name, "Lane")?;
    let colour = validate::colour(&colour, "Lane colour")?;
    let sort_order = validate::sort_order(sort_order)?;

    ctx.db.lane().id().update(Lane {
        id: existing.id,
        name,
        colour,
        sort_order,
    });
    Ok(())
}

/// The colour picker's own write path — one field, so opening the picker on a lane someone else
/// just renamed cannot silently put the old name back.
#[reducer]
pub fn set_lane_colour(ctx: &ReducerContext, lane_id: u64, colour: String) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_lane(ctx, lane_id)?;
    let colour = validate::colour(&colour, "Lane colour")?;
    ctx.db.lane().id().update(Lane { colour, ..existing });
    Ok(())
}

/// Drag-to-reorder's write path, for the same reason as `set_lane_colour`.
#[reducer]
pub fn reorder_lane(ctx: &ReducerContext, lane_id: u64, sort_order: i32) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_lane(ctx, lane_id)?;
    let sort_order = validate::sort_order(sort_order)?;
    ctx.db.lane().id().update(Lane {
        sort_order,
        ..existing
    });
    Ok(())
}

/// Refuses while the lane still holds tasks.
///
/// Cascading here would delete the user's actual work on one misplaced click, and an
/// undo-through-a-reducer does not exist. Emptying the lane first is one drag per task and is
/// the user's decision to make.
#[reducer]
pub fn delete_lane(ctx: &ReducerContext, lane_id: u64) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_lane(ctx, lane_id)?;
    let held = ctx.db.task().task_by_lane().filter(lane_id).count();
    if held > 0 {
        return Err(format!(
            "Lane \"{}\" still holds {held} task(s); move or delete them first",
            existing.name
        ));
    }
    ctx.db.lane().id().delete(lane_id);
    spacetimedb::log::info!("deleted lane {} \"{}\"", existing.id, existing.name);
    Ok(())
}
