//! Personnel: the avatars in the app's top-right rail.

use spacetimedb::{reducer, ReducerContext, Table};

use crate::reducers::{delete_assignments_where, require_authenticated, require_person};
use crate::tables::*;
use crate::validate;

#[reducer]
pub fn create_person(
    ctx: &ReducerContext,
    name: String,
    role: String,
    avatar_colour: String,
    initials: String,
) -> Result<(), String> {
    require_authenticated(ctx)?;
    let name = validate::name(&name, "Person")?;
    let role = validate::optional_text(&role, "Role")?;
    let avatar_colour = validate::colour(&avatar_colour, "Avatar colour")?;
    let initials = validate::initials(&initials, &name)?;

    let row = ctx.db.person().insert(Person {
        id: 0,
        name,
        role,
        avatar_colour,
        initials,
    });
    spacetimedb::log::info!("created person {} \"{}\"", row.id, row.name);
    Ok(())
}

#[reducer]
pub fn update_person(
    ctx: &ReducerContext,
    person_id: u64,
    name: String,
    role: String,
    avatar_colour: String,
    initials: String,
) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_person(ctx, person_id)?;
    let name = validate::name(&name, "Person")?;
    let role = validate::optional_text(&role, "Role")?;
    let avatar_colour = validate::colour(&avatar_colour, "Avatar colour")?;
    let initials = validate::initials(&initials, &name)?;

    ctx.db.person().id().update(Person {
        id: existing.id,
        name,
        role,
        avatar_colour,
        initials,
    });
    Ok(())
}

/// Removing a person also removes their assignments: those rows point at a person who no longer
/// exists, so keeping them would leave the chart drawing an avatar for nobody.
#[reducer]
pub fn delete_person(ctx: &ReducerContext, person_id: u64) -> Result<(), String> {
    require_authenticated(ctx)?;
    let existing = require_person(ctx, person_id)?;
    let dropped = delete_assignments_where(ctx, |a| a.person_id == person_id);
    ctx.db.person().id().delete(person_id);
    spacetimedb::log::info!(
        "deleted person {} \"{}\" and {} assignment(s)",
        existing.id,
        existing.name,
        dropped
    );
    Ok(())
}
