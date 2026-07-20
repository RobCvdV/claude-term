#!/bin/bash
# claude-term activity logger.
#
# Installed as a global Claude Code hook (UserPromptSubmit / PostToolUse / Stop /
# SessionStart / SessionEnd). Each invocation appends ONE timestamped heartbeat
# line to ~/.claude/activity-hours.jsonl. claude-term's "activity hours" overview
# reads that file and reconstructs wall-clock engagement per ticket per day
# (summing the gaps between consecutive heartbeats within a session, capping any
# gap longer than its idle threshold so time-away isn't counted).
#
# Design rules: must be FAST (PostToolUse fires on every tool) and FAIL-SAFE
# (always exit 0 so a logging hiccup never blocks the user's session).

input=$(cat)
log_file="$HOME/.claude/activity-hours.jsonl"

# One jq call extracts all three fields (@tsv escapes any tabs/newlines inside
# them) — PostToolUse is hot, so avoid spawning jq three times per beat.
IFS=$'\t' read -r event cwd session < <(
    printf '%s' "$input" | jq -r \
        '[.hook_event_name // "", (.cwd // .workspace.current_dir // ""), .session_id // ""] | @tsv' \
        2>/dev/null
)
[ -z "$cwd" ] && cwd="$PWD"
now=$(date +%s)

# Resolve the current git branch, cached per-cwd (60s TTL) so PostToolUse — which
# fires many times per turn — doesn't shell out to git every time. An empty
# branch (non-repo dir) is a valid cached value.
branch=""
cache_dir="/tmp/claude-activity-cache"
mkdir -p "$cache_dir" 2>/dev/null
cache_file="$cache_dir/$(printf '%s' "$cwd" | md5)"
fresh=0
if [ -f "$cache_file" ]; then
    ctime=$(stat -f %m "$cache_file" 2>/dev/null || echo 0)
    [ $((now - ctime)) -lt 60 ] && fresh=1
fi
if [ "$fresh" = "1" ]; then
    branch=$(cat "$cache_file" 2>/dev/null)
else
    branch=$(git --no-optional-locks -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
    printf '%s' "$branch" > "$cache_file" 2>/dev/null
fi

# jq -n builds a properly-escaped JSON object (paths/branches may contain quotes).
jq -cn \
    --argjson ts "$now" \
    --arg event "$event" \
    --arg session "$session" \
    --arg cwd "$cwd" \
    --arg branch "$branch" \
    '{ts:$ts, event:$event, session:$session, cwd:$cwd, branch:$branch}' \
    >> "$log_file" 2>/dev/null

exit 0
