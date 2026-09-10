#!/usr/bin/env bash
#
# Round-trips every reducer in the `vertico-planner` module through the SpacetimeDB CLI and
# reads the resulting rows back with SQL. This is the module's acceptance harness: it proves the
# write path works end to end without an app in front of it.
#
#   bash tools/roundtrip.sh
#
# ⚠ It calls `wipe_plan` first, so it REPLACES whatever plan is in the database. Export first if
# the plan matters. It never names any database but `vertico-planner`.
#
# Two CLI details this script exists to encode, both of which cost a run to discover:
#
#   * `#[auto_inc]` ids are NOT reset by `wipe_plan` — the sequence keeps counting. So every id
#     below is looked up by name (`id_of`) rather than assumed to be 1.
#   * a negative argument like `-1` is parsed by clap as a flag unless `--` comes first, hence
#     `spacetime call -y -- <db> <reducer> ...` throughout.

set -uo pipefail

DB=vertico-planner
PASS=0
FAIL=0

strip() { grep -v '^WARNING: This command is UNSTABLE'; }

sql() { spacetime sql "$DB" "$1" 2>&1 | strip; }

# id_of <table> <name> -- the row's id, or empty if there is no such row.
id_of() {
  spacetime sql "$DB" "SELECT id FROM $1 WHERE name = '$2'" 2>/dev/null \
    | grep -E '^[[:space:]]*[0-9]+[[:space:]]*$' | head -1 | tr -d '[:space:]'
}

# expect_ok <label> <reducer> [json args...]
expect_ok() {
  local label="$1"; shift
  local out status
  out=$(spacetime call -y -- "$DB" "$@" 2>&1); status=$?
  if [ $status -eq 0 ]; then
    printf 'PASS  %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %s -- expected success, got: %s\n' \
      "$label" "$(printf '%s' "$out" | strip | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
  fi
}

# expect_refusal <label> <expected substring> <reducer> [json args...]
expect_refusal() {
  local label="$1"; local needle="$2"; shift 2
  local out status
  out=$(spacetime call -y -- "$DB" "$@" 2>&1); status=$?
  if [ $status -eq 0 ]; then
    printf 'FAIL  %s -- reducer accepted a value it should have refused\n' "$label"
    FAIL=$((FAIL + 1))
  elif printf '%s' "$out" | grep -qF "$needle"; then
    printf 'PASS  %s -- refused: %s\n' "$label" "$needle"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %s -- refused, but not with "%s": %s\n' \
      "$label" "$needle" "$(printf '%s' "$out" | strip | tr '\n' ' ')"
    FAIL=$((FAIL + 1))
  fi
}

echo "== reset =="
expect_ok "wipe_plan" wipe_plan

echo
echo "== lanes =="
expect_ok      "create_lane Planning"    create_lane '"Planning"' '"#3EE8B0"' 0
expect_ok      "create_lane Build"       create_lane '"Build"'    '"#e0a64a"' 1
expect_refusal "create_lane blank name"  "cannot be empty" create_lane '"   "' '"#3ee8b0"' 0
expect_refusal "create_lane bad colour"  "hex colour"      create_lane '"Nope"' '"mint"' 0
LANE_PLANNING=$(id_of lane Planning)
LANE_BUILD=$(id_of lane Build)
echo "      lane ids: Planning=$LANE_PLANNING Build=$LANE_BUILD"
expect_ok      "set_lane_colour"         set_lane_colour "$LANE_BUILD" '"#E05C4A"'
expect_ok      "reorder_lane"            reorder_lane "$LANE_BUILD" 5
expect_refusal "set_lane_colour on a missing lane" "does not exist" set_lane_colour 999999 '"#3ee8b0"'
sql "SELECT id, name, colour, sort_order FROM lane"

echo
echo "== people =="
expect_ok      "create_person derived initials"  create_person '"Ada Lovelace"' '"Engineer"' '"#3EE8B0"' '""'
expect_ok      "create_person explicit initials" create_person '"Grace Hopper"' '"Architect"' '"#e0a64a"' '"gh"'
expect_refusal "create_person 4-letter initials" "the limit is 3" create_person '"Too Long"' '"x"' '"#3ee8b0"' '"ABCD"'
ADA=$(id_of person 'Ada Lovelace')
GRACE=$(id_of person 'Grace Hopper')
echo "      person ids: Ada=$ADA Grace=$GRACE"
expect_ok      "update_person" update_person "$ADA" '"Ada Lovelace"' '"Lead Engineer"' '"#3ee8b0"' '"AL"'
sql "SELECT id, name, role, avatar_colour, initials FROM person"

echo
echo "== tasks =="
expect_ok      "create_task"             create_task "$LANE_PLANNING" '"Survey the site"' 20000 5 0 0
SURVEY=$(id_of task 'Survey the site')
expect_ok      "create_task with a predecessor" create_task "$LANE_BUILD" '"Pour the slab"' 20005 10 0 "$SURVEY"
SLAB=$(id_of task 'Pour the slab')
echo "      task ids: Survey=$SURVEY Slab=$SLAB"
expect_refusal "create_task duration 0"  "at least 1 day"    create_task "$LANE_PLANNING" '"Zero width"' 20000 0 0 0
expect_refusal "create_task percent 140" "between 0 and 100" create_task "$LANE_PLANNING" '"Overdone"' 20000 1 140 0
expect_refusal "create_task unknown lane" "Lane 999999 does not exist" create_task 999999 '"Homeless"' 20000 1 0 0
expect_refusal "create_task unknown predecessor" "does not exist" create_task "$LANE_PLANNING" '"Dangling"' 20000 1 0 999999
expect_refusal "create_task past the epoch-day range" "outside the supported range" create_task "$LANE_PLANNING" '"Far future"' 999999 1 0 0
expect_ok      "set_task_percent 45"     set_task_percent "$SURVEY" 45
expect_refusal "set_task_percent -1"     "between 0 and 100" set_task_percent "$SURVEY" -1
expect_ok      "move_task"               move_task "$SURVEY" 20002
expect_ok      "resize_task"             resize_task "$SURVEY" 8
expect_refusal "resize_task to 0"        "at least 1 day"    resize_task "$SURVEY" 0
expect_ok      "move_task_to_lane"       move_task_to_lane "$SURVEY" "$LANE_BUILD" 20003
expect_refusal "self predecessor"        "cannot be its own predecessor" set_task_predecessor "$SLAB" "$SLAB"
expect_refusal "cyclic predecessor"      "would make a cycle" set_task_predecessor "$SURVEY" "$SLAB"
expect_ok      "clear predecessor"       set_task_predecessor "$SLAB" 0
expect_ok      "set predecessor again"   set_task_predecessor "$SLAB" "$SURVEY"
sql "SELECT id, lane_id, name, start_day, duration_days, percent_complete, predecessor_id FROM task"

echo
echo "== assignments =="
expect_ok      "assign_person"                assign_person "$SURVEY" "$ADA"
expect_ok      "assign second person"         assign_person "$SURVEY" "$GRACE"
expect_refusal "assign the same person twice" "already assigned" assign_person "$SURVEY" "$ADA"
expect_refusal "assign a missing person"      "Person 999999 does not exist" assign_person "$SURVEY" 999999
expect_ok      "unassign_person"              unassign_person "$SURVEY" "$GRACE"
expect_refusal "unassign someone who is not on it" "is not assigned" unassign_person "$SURVEY" "$GRACE"
sql "SELECT id, task_id, person_id FROM assignment"

echo
echo "== cascades and guards =="
expect_refusal "delete_lane while it holds tasks" "still holds" delete_lane "$LANE_BUILD"
expect_ok      "delete_person takes their assignment" delete_person "$ADA"
sql "SELECT COUNT(*) AS assignments_left FROM assignment"
expect_ok      "delete_task clears the dependent's predecessor" delete_task "$SURVEY"
sql "SELECT id, name, predecessor_id FROM task"

echo
echo "== import =="
expect_ok "import_plan" import_plan \
  '[{"id":7,"name":"Ada Lovelace","role":"Engineer","avatar_colour":"#3ee8b0","initials":"AL"}]' \
  '[{"id":11,"name":"Planning","colour":"#3ee8b0","sort_order":0},{"id":12,"name":"Build","colour":"#e0a64a","sort_order":1}]' \
  '[{"id":21,"lane_id":11,"name":"Survey the site","start_day":20000,"duration_days":5,"percent_complete":100,"predecessor_id":0},{"id":22,"lane_id":12,"name":"Pour the slab","start_day":20005,"duration_days":10,"percent_complete":30,"predecessor_id":21}]' \
  '[{"task_id":22,"person_id":7}]'
expect_refusal "import_plan with a dangling lane" "which the file does not contain" import_plan \
  '[]' '[]' \
  '[{"id":1,"lane_id":404,"name":"Orphan","start_day":0,"duration_days":1,"percent_complete":0,"predecessor_id":0}]' \
  '[]'
expect_refusal "import_plan with a cycle" "circular dependency" import_plan \
  '[]' \
  '[{"id":1,"name":"L","colour":"#3ee8b0","sort_order":0}]' \
  '[{"id":1,"lane_id":1,"name":"A","start_day":0,"duration_days":1,"percent_complete":0,"predecessor_id":2},{"id":2,"lane_id":1,"name":"B","start_day":0,"duration_days":1,"percent_complete":0,"predecessor_id":1}]' \
  '[]'
echo "      (the two refused imports must have left the good one intact:)"
sql "SELECT id, lane_id, name, start_day, duration_days, percent_complete, predecessor_id FROM task"
sql "SELECT id, task_id, person_id FROM assignment"

echo
echo "================================"
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
