---
name: ship
description: Ship claude-term changes — run the same checks CI runs, commit with a conventional message, push, open a GitHub PR with a test plan, wait for the quality check, merge, and watch the automatic release on main until it reports the new version. Use when the user says commit/push/PR/merge/release ("merge and release", "ship it").
---

# Ship a change

Every push to `main` builds and publishes a release (`.github/workflows/release.yml`);
the version is computed from commit messages: `feat:` → minor, `fix:` → patch,
`BREAKING CHANGE` → major. So the commit type _is_ the version decision.

## Steps

1. **Checks** (all must pass; same as CI's `quality` job):
   `npm run typecheck && npm run lint && npx prettier --check . && npx vitest run` — Prettier over the whole repo, as CI does (skills and scripts included)
2. **Docs**: a new or rebound key → walk the five places in CLAUDE.md. A
   user-visible feature → README feature list and the Help overlay's User Guide.
3. **Branch**: `feature/<topic>` or `fix/<topic>` off an up-to-date `main`
   (no Jira ticket needed — this is a personal repo).
4. **Commit**: `feat: …` / `fix: …`, a body saying what changed and why, the
   attribution trailers from the system reminder.
5. **PR**: `gh pr create --base main` with `## Summary` (bullets, user-facing)
   and `## Test plan` (checkboxes: what was run, with counts; what was verified
   in a dev build — see the check-in-app skill; what was **not** verified, unchecked).
6. **Merge** only when the user asked to, and only after the check **passed**:
   `gh pr checks <n> --watch --interval 20; echo "checks exit $?"` — exit 0 means
   every check passed; anything else, read `gh run view <id> --log-failed`
   and fix first. Never merge on output you didn't see. Then
   `gh pr merge <n> --merge --delete-branch` (merge commits, not squash).
7. **Release**: watch the run on main in the background
   (`gh run watch <id> --exit-status`), then `gh release list --limit 1` and
   report the version.
8. **Clean up**: `git checkout main && git pull`, delete the merged local branch.

## Several changes, one release

Each merge to main is its own release. To ship two branches as one: merge the
second branch into the first locally (`git merge --no-edit <other>`), rerun the
checks, push, and open one PR describing both.

## Stacked or conflicting branches

Merge the base PR first, then `git merge origin/main` into the next branch,
resolve, rerun all checks, push, merge.
