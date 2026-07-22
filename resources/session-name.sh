#!/bin/bash
# Installed by claude-term into its userData dir. The `claude` launcher (the zsh
# wrapper function and the bash PATH shim) calls this with the exact args the
# user typed and, if it prints a non-empty name, launches `claude --name <name>`
# so the session shows up in the Claude app under the tab's branch name instead
# of an auto-generated summary. Prints nothing (→ no --name) when a name should
# not be forced. The branch→name transform is the twin of
# src/main/session-name.ts (used for live /rename on branch switch) — keep both
# in sync: shorten only the long branch prefixes and always keep the ticket.

# Respect an explicit user-supplied name — never override it.
for a in "$@"; do
  case "$a" in
    -n | --name | --name=*) exit 0 ;;
  esac
done

# Only name interactive session launches. The first non-option argument is the
# subcommand (mcp, agents, …) or, for us, a --resume id / initial prompt. Skip
# the known subcommands (and attach); anything else is an interactive session.
for a in "$@"; do
  case "$a" in
    -*) continue ;;
    agents | auth | auto-mode | doctor | gateway | install | mcp | plugin | plugins | project | setup-token | ultrareview | update | upgrade | attach)
      exit 0
      ;;
    *) break ;;
  esac
done

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$branch" ] && exit 0
[ "$branch" = "HEAD" ] && exit 0 # detached — no meaningful branch name

case "$branch" in
  bugfix/*) printf '%s' "bug/${branch#bugfix/}" ;;
  feature/*) printf '%s' "feat/${branch#feature/}" ;;
  chore/*) printf '%s' "chore/${branch#chore/}" ;;
  *) printf '%s' "$branch" ;;
esac
