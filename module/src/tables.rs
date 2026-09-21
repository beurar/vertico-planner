//! The four planner tables.
//!
//! ## Why the ids are `u64` and the dates are `i32`
//!
//! Row ids are `#[auto_inc]` `u64` — SpacetimeDB assigns one only when the field is `0`, which
//! is also why `Task::predecessor_id == 0` is the sentinel for "no predecessor": id 0 can never
//! be a real row.
//!
//! Dates are **integer epoch days** (days since 1970-01-01, UTC), never timestamps. A Gantt
//! chart works in whole days; a timestamp would drag timezones and DST into arithmetic that is
//! supposed to be `start_day + duration_days`, and produce off-by-one bars for exactly the
//! users whose local midnight falls on the other side of UTC. Conversion happens at the UI
//! edge only.
//!
//! ## Why avatars are a colour plus initials
//!
//! An avatar is `avatar_colour` + `initials`, not an image. Rows stay tiny, every subscriber
//! gets the whole table cheaply, and no base64 blob rides in a database row. Real pictures, if
//! they are ever wanted, are a file path or an asset store — still not a blob column.

use spacetimedb::{table, Identity};

/// Someone who can be assigned to a task. Drawn top-right in the app as a coloured avatar
/// bearing [`Person::initials`].
#[table(accessor = person, public)]
#[derive(Clone, Debug)]
pub struct Person {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub role: String,
    /// `#rrggbb`, lower-cased on write. This is the person's own colour, not a lane's.
    pub avatar_colour: String,
    /// 1–3 characters. Derived from `name` when the caller leaves it blank.
    pub initials: String,
}

/// A horizontal row of the chart. Owns a colour the user picks; the app's palette supplies
/// only the defaults.
#[table(accessor = lane, public)]
#[derive(Clone, Debug)]
pub struct Lane {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    /// `#rrggbb`, lower-cased on write.
    pub colour: String,
    /// Ascending display order. Ties are broken by `id`, so duplicates are legal.
    pub sort_order: i32,
}

/// One bar. `start_day` is an epoch day; the bar covers
/// `[start_day, start_day + duration_days)`.
#[table(accessor = task, public, index(accessor = task_by_lane, btree(columns = [lane_id])))]
#[derive(Clone, Debug)]
pub struct Task {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub lane_id: u64,
    pub name: String,
    /// Days since the Unix epoch. May be negative; see `validate::EPOCH_DAY_LIMIT`.
    pub start_day: i32,
    /// At least 1. A zero-width bar is not a task.
    pub duration_days: i32,
    /// 0–100 inclusive. Out of range is refused, never clamped.
    pub percent_complete: i32,
    /// Another task's id, or `0` for none. Never this task, and never a cycle.
    pub predecessor_id: u64,
}

/// A person on a task. The pair is unique: `assign_person` refuses a second copy rather than
/// quietly inserting one, so the app can drag the same avatar twice without growing the table.
#[table(
    accessor = assignment,
    public,
    index(accessor = assignment_by_task, btree(columns = [task_id])),
    index(accessor = assignment_by_person, btree(columns = [person_id]))
)]
#[derive(Clone, Debug)]
pub struct Assignment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub task_id: u64,
    pub person_id: u64,
}

/// The shared passphrase gate. One row (`id = 1`), seeded by `init`.
///
/// **Deliberately not `public`.** A private table is never sent to a client under any
/// circumstance — not by subscription, not by query — so the passphrase never rides the wire to
/// anyone. Only reducer code running on the server can read this table. Change the value with
/// `spacetime sql vertico-planner "UPDATE app_secret SET passphrase = '...' WHERE id = 1"`;
/// there is deliberately no reducer for it, so rotating it cannot itself be gate-crashed.
#[table(accessor = app_secret)]
#[derive(Clone, Debug)]
pub struct AppSecret {
    #[primary_key]
    pub id: u8,
    pub passphrase: String,
}

/// Identities that have supplied the correct passphrase to `authenticate`, and so may call any
/// other reducer. Also private, for the same reason: which identities are authorised is nobody's
/// business but the server's, and there is no client feature that would ever read this table.
#[table(accessor = authorized)]
#[derive(Clone, Debug)]
pub struct Authorized {
    #[primary_key]
    pub identity: Identity,
}
