//! Field validation, shared by every reducer.
//!
//! **The rule: refuse with a reason, never clamp silently.** A percentage of 140 is a bug in
//! whatever sent it — storing 100 instead hides that bug forever and leaves the user staring at
//! a bar that disagrees with the slider they just dragged. Every function here returns
//! `Err(String)` carrying a sentence a human can act on, and the app shows it and snaps the bar
//! back to the row.
//!
//! Two things here *are* normalisations rather than refusals, and both are declared:
//!
//! * a colour is lower-cased, so `#3EE8B0` and `#3ee8b0` are one value rather than two;
//! * blank initials are derived from the name, because "leave it blank and I'll work it out" is
//!   an omitted optional field, not an invalid one. A non-blank value that is too long is still
//!   refused.
//!
//! Nothing in this file touches `ReducerContext`, so it links into a host-side test crate.

/// Days either side of 1970-01-01 that a task may start. ~±274 years, which is far past any
/// plan a human is drawing and far short of the overflow that makes `start_day + duration_days`
/// wrap into a bar drawn in the wrong century.
pub const EPOCH_DAY_LIMIT: i32 = 100_000;

/// The longest a single bar may be: 100 years. Beyond that it is a data-entry slip, not a task.
pub const MAX_DURATION_DAYS: i32 = 36_500;

/// A name a row is identified by. Trimmed; refused when empty or absurdly long.
pub fn name(raw: &str, what: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{what} name cannot be empty"));
    }
    if trimmed.chars().count() > 120 {
        return Err(format!(
            "{what} name is {} characters; the limit is 120",
            trimmed.chars().count()
        ));
    }
    Ok(trimmed.to_string())
}

/// A free-text label that is allowed to be empty (a person's role, for instance).
pub fn optional_text(raw: &str, what: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > 120 {
        return Err(format!(
            "{what} is {} characters; the limit is 120",
            trimmed.chars().count()
        ));
    }
    Ok(trimmed.to_string())
}

/// `#rrggbb`, case-insensitive on the way in, lower-case on the way out.
///
/// Deliberately strict: no named colours, no 3-digit short form, no `rgba()`. One shape means
/// the app can put the string straight into a style without parsing it, and a typo is caught
/// here instead of rendering as transparent black.
pub fn colour(raw: &str, what: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let bad = || {
        Err(format!(
            "{what} must be a hex colour like #3ee8b0, got \"{trimmed}\""
        ))
    };
    if trimmed.len() != 7 || !trimmed.starts_with('#') {
        return bad();
    }
    if !trimmed[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return bad();
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// 1–3 characters. Blank means "derive them from the name".
pub fn initials(raw: &str, person_name: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(derive_initials(person_name));
    }
    let count = trimmed.chars().count();
    if count > 3 {
        return Err(format!(
            "Initials are {count} characters; the limit is 3 (leave them blank to derive them from the name)"
        ));
    }
    Ok(trimmed.to_uppercase())
}

/// First letter of each of the first two words, upper-cased. Falls back to the first character,
/// and to `"?"` for a name with no letters at all — a name that empty is refused upstream, so
/// this is belt and braces.
pub fn derive_initials(person_name: &str) -> String {
    let mut out = String::new();
    for word in person_name.split_whitespace().take(2) {
        if let Some(c) = word.chars().next() {
            out.extend(c.to_uppercase());
        }
    }
    if out.is_empty() {
        "?".to_string()
    } else {
        out
    }
}

/// 0–100 inclusive.
pub fn percent(value: i32) -> Result<i32, String> {
    if !(0..=100).contains(&value) {
        return Err(format!(
            "Percent complete must be between 0 and 100, got {value}"
        ));
    }
    Ok(value)
}

/// At least one whole day.
pub fn duration_days(value: i32) -> Result<i32, String> {
    if value < 1 {
        return Err(format!(
            "Duration must be at least 1 day, got {value}"
        ));
    }
    if value > MAX_DURATION_DAYS {
        return Err(format!(
            "Duration is {value} days; the limit is {MAX_DURATION_DAYS}"
        ));
    }
    Ok(value)
}

/// An epoch day inside [`EPOCH_DAY_LIMIT`].
pub fn start_day(value: i32) -> Result<i32, String> {
    if value.abs() > EPOCH_DAY_LIMIT {
        return Err(format!(
            "Start day {value} is outside the supported range of ±{EPOCH_DAY_LIMIT} days from 1970-01-01"
        ));
    }
    Ok(value)
}

/// The pair together: a bar must also *end* inside the range, or the chart has to draw a bar
/// whose right edge it cannot place.
pub fn span(start: i32, duration: i32) -> Result<(), String> {
    let end = start
        .checked_add(duration)
        .ok_or_else(|| format!("Start day {start} plus {duration} days overflows"))?;
    if end > EPOCH_DAY_LIMIT {
        return Err(format!(
            "A task starting on day {start} and running {duration} days ends past the supported range of +{EPOCH_DAY_LIMIT} days"
        ));
    }
    Ok(())
}

/// A display-order value. Wide open, but bounded so a stray value cannot break the app's sort.
pub fn sort_order(value: i32) -> Result<i32, String> {
    if !(-100_000..=100_000).contains(&value) {
        return Err(format!(
            "Sort order {value} is outside ±100000"
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_is_normalised_and_shapes_are_refused() {
        assert_eq!(colour("#3EE8B0", "Lane colour").unwrap(), "#3ee8b0");
        assert!(colour("3ee8b0", "Lane colour").is_err());
        assert!(colour("#3ee8b", "Lane colour").is_err());
        assert!(colour("mint", "Lane colour").is_err());
        assert!(colour("#3ee8bz", "Lane colour").is_err());
    }

    #[test]
    fn initials_derive_from_the_name_when_blank() {
        assert_eq!(initials("  ", "Ada Lovelace").unwrap(), "AL");
        assert_eq!(initials("", "Prince").unwrap(), "P");
        assert_eq!(initials("adl", "Ada Lovelace").unwrap(), "ADL");
        assert!(initials("ADLX", "Ada Lovelace").is_err());
    }

    #[test]
    fn percent_and_duration_refuse_rather_than_clamp() {
        assert!(percent(-1).is_err());
        assert!(percent(101).is_err());
        assert_eq!(percent(100).unwrap(), 100);
        assert!(duration_days(0).is_err());
        assert_eq!(duration_days(1).unwrap(), 1);
    }

    #[test]
    fn a_span_must_end_inside_the_range() {
        assert!(span(0, 30).is_ok());
        assert!(span(EPOCH_DAY_LIMIT - 1, 30).is_err());
        assert!(span(i32::MAX, 1).is_err());
    }
}
