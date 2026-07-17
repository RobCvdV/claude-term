#!/bin/bash
# Installed by claude-term into its userData dir. Claude Code pipes the
# statusline JSON to this script; it is forwarded to the app and nothing is
# printed, so the in-TUI statusline stays empty (the app bar replaces it).
# Read stdin BEFORE backgrounding: background jobs get stdin from /dev/null.
json=$(cat)
printf '%s' "$json" | curl -s -m 1 -X POST \
  "http://127.0.0.1:${CLAUDE_TERM_PORT}/statusline?tab=${CLAUDE_TERM_TAB_ID}&token=${CLAUDE_TERM_TOKEN}" \
  -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 &
