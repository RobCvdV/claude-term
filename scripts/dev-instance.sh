#!/bin/bash
# Drive a throwaway claude-term dev instance for checks and screenshots.
#   scripts/dev-instance.sh start [project-dir] [port]   → prints the CDP port when ready
#   scripts/dev-instance.sh stop
#   scripts/dev-instance.sh log
# Uses its own profile under $TMPDIR, so it never touches the real app's tabs,
# and copies the Jira token only when it is stored unencrypted — an encrypted
# one would raise a keychain prompt that blocks the main process.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${TMPDIR:-/tmp}/claude-term-devdrive"
PROFILE="$BASE/profile"
LOG="$BASE/dev.log"

case "${1:-}" in
  start)
    PROJECT="${2:-$ROOT}"
    PORT="${3:-9340}"
    mkdir -p "$PROFILE"
    rm -f "$PROFILE/session.json"
    REAL="$HOME/Library/Application Support/claude-term/jira-credentials.json"
    if [ -f "$REAL" ] && grep -q '"enc":false' "$REAL"; then cp "$REAL" "$PROFILE/"; fi
    [ -f "$PROFILE/app-settings.json" ] || echo '{"jiraTicketStatus":true}' > "$PROFILE/app-settings.json"
    cd "$ROOT"
    CLAUDE_TERM_USER_DATA_DIR="$PROFILE" CLAUDE_TERM_DEBUG_PORT="$PORT" CLAUDE_TERM_DEFAULT_CWD="$PROJECT" \
      nohup npm run dev > "$LOG" 2>&1 &
    for _ in $(seq 1 90); do
      if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" > /dev/null; then
        echo "ready: port $PORT, project $PROJECT, log $LOG"
        exit 0
      fi
      sleep 1
    done
    echo "dev instance did not open port $PORT — see $LOG" >&2
    exit 1
    ;;
  stop)
    pkill -f "$ROOT/node_modules/electron/dist/Electron.app" || true
    pkill -f "electron-vite dev" || true
    echo stopped
    ;;
  log)
    tail -n "${2:-40}" "$LOG"
    ;;
  *)
    echo "usage: $0 start [project-dir] [port] | stop | log [lines]" >&2
    exit 2
    ;;
esac
