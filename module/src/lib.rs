//! **Vertico Planner** — the SpacetimeDB module behind the Electron Gantt planner.
//!
//! Published as the database **`vertico-planner`** on the local server. It shares the host with
//! the game's `vertico-universe` database and shares nothing else: separate database, separate
//! schema, separate repository.
//!
//! ```text
//! spacetime publish vertico-planner --server local --module-path ./module -y
//! ```
//!
//! ## Shape
//!
//! Four tables — [`tables::Person`], [`tables::Lane`], [`tables::Task`], [`tables::Assignment`] —
//! all public, because the app subscribes to all of them and there is exactly one user.
//!
//! Reducers are the only write path. Every one of them returns `Result<(), String>` and
//! **refuses with a sentence** rather than clamping a bad value: a bar that the server would not
//! move stays where it was, the subscription pushes the unchanged row, and the renderer's
//! optimistic drag snaps back. That round trip is the whole point of putting the data here.
//!
//! ## Local save
//!
//! Nothing leaves this machine: the server listens on `127.0.0.1:3000` and the app talks to it
//! over a loopback WebSocket. The app is nevertheless dead when the server is down, so it says
//! so in the UI, and [`reducers::plan_io`] carries the Import half of Export/Import JSON for
//! backups that survive a wiped database.

pub mod reducers;
pub mod tables;
pub mod validate;

use spacetimedb::{reducer, ReducerContext, Table};

use crate::tables::*;

/// Default lanes, offered so a fresh database is not a blank grid with no way in.
///
/// These colours are the app's house palette; they are **defaults, not a policy**. A lane colour
/// is the user's data and `set_lane_colour` will take any hex they like.
const SEED_LANES: [(&str, &str, i32); 4] = [
    ("Planning", "#3ee8b0", 0),
    ("Build", "#e0a64a", 1),
    ("Review", "#4c5f5a", 2),
    ("Release", "#e05c4a", 3),
];

/// Runs on first publish and on any publish that passes `--delete-data`.
///
/// ⚠ A lifecycle reducer that panics aborts the publish itself, so this one only inserts, and
/// only into a table it has just found empty.
#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    if ctx.db.lane().count() > 0 {
        return;
    }
    for (name, colour, sort_order) in SEED_LANES {
        ctx.db.lane().insert(Lane {
            id: 0,
            name: name.to_string(),
            colour: colour.to_string(),
            sort_order,
        });
    }
    spacetimedb::log::info!("vertico-planner initialised with {} lanes", SEED_LANES.len());
}
