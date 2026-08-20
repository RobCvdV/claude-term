# Answering Claude Code prompts from outside the TUI

Measured empirically against **Claude Code 2.1.235** on 2026-08-19 with
`scripts/hook-spike/` (a logging http hook endpoint + a pty harness driving the
real TUI). This is the mechanism the mobile companion app is built on, and it is
the kind of CLI behaviour that drifts between releases — re-run the harness
before trusting it on a much newer CLI.

## The short version

| Need | Mechanism |
| --- | --- |
| Learn that a human is being asked something, with full detail | `PermissionRequest` http hook — carries `tool_name` + `tool_input` |
| Hold the question open while a phone decides | Just don't answer the HTTP request. The turn blocks. |
| Approve / reject | 2xx body `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"\|"deny"}}}` |
| Let the terminal handle it instead | 2xx with an **empty body**. Also: the native dialog is *already* on screen. |
| Know the user answered in the terminal | The CLI **closes the parked connection**. |
| Send *content* back (a question answer, plan feedback) | `PreToolUse` deny + `permissionDecisionReason` — that reason reaches the model. `PermissionRequest`'s does **not**. |

## Findings

**1. `type: "http"` hook response bodies are parsed exactly like a command
hook's stdout.** The transcript records the exchange as
`{"type":"hook_success","hookEvent":"PermissionRequest","exitCode":200,"stdout":"<our body>"}`.
A 2xx JSON object decides; a 2xx empty body means "no decision".

**2. `PermissionRequest` is the event to use — not `PreToolUse`.** It fires only
when Claude Code is about to ask a human, so a companion sees exactly the
prompts that need one. Payload:

```json
{ "session_id": "…", "transcript_path": "…", "cwd": "…", "prompt_id": "…",
  "permission_mode": "default", "effort": {"level": "low"},
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {"command": "mkdir spike-proof", "description": "…"} }
```

Its output shape is `hookSpecificOutput.decision.behavior`, **not** the
`permissionDecision` field that `PreToolUse` uses. Verified both ways: answering
only `PermissionRequest` ran the tool; answering only `PreToolUse` with
`permissionDecision: "allow"` did **not** — an explicit `ask` rule
(`Bash(mkdir *)`) still routed to `PermissionRequest`, which then fell through to
the dialog.

**3. Parking works, and blocks only that one decision.** A `PermissionRequest`
response withheld for 25 s held the turn for 25 s and was then honoured (the tool
ran). Other hooks kept firing meanwhile — a `Notification` arrived mid-park — so
parking one decision does not stall the rest of the hook pipeline. The documented
default timeout for http hooks is 600 s.

**4. The native dialog renders immediately, in parallel with the parked hook.**
This is the one that overturns the obvious assumption. Claude Code does *not*
wait for the hook before drawing its own prompt — in every run, including ones
where the hook allowed or parked the request, the TUI showed:

```
Bash command  mkdir spike-proof
Permission rule Bash(mkdir *) requires confirmation for this command.
Do you want to proceed?  ❯ 1. Yes  2. No
```

So the phone and the terminal are **both live at the same time**. Handing a
prompt from the phone back to the terminal therefore needs no mechanism at all —
the dialog is already there; just stop holding the response.

**5. Answering in the terminal closes the parked connection.** With a 90 s park,
pressing Enter in the TUI at t≈14 s ran the tool immediately and our still-open
HTTP response was closed by the CLI (`res.on('close')` fires with
`writableEnded === false`). That is the retraction signal: when it fires, tell the
phone to drop the card. Writing a decision after that point is a no-op.

**6. `AskUserQuestion` arrives through `PermissionRequest`, fully structured** —
no screen scraping and no parsing:

```json
{ "tool_name": "AskUserQuestion",
  "tool_input": {"questions": [{"question": "…", "header": "Indentation",
    "options": [{"label": "Spaces", "description": "…"}], "multiSelect": false}]} }
```

**7. `ExitPlanMode` likewise, with the plan text inline** — `tool_input.plan`
holds the full markdown and `tool_input.planFilePath` names the file. There is no
need to guess at the newest `*.md` in `~/.claude/plans/`.

**8. To send *content* back, use `PreToolUse`, not `PermissionRequest`.**
Denying an `AskUserQuestion` through `PermissionRequest` with a
`permissionDecisionReason` loses the reason — the model only saw
"Denied by PermissionRequest hook" and replied *"The question was blocked by a
permission hook, so I couldn't collect your answer."* Denying the same tool
through `PreToolUse` surfaces the reason verbatim as `Error: <reason>`, and the
model used it correctly ("You chose spaces — specifically 2-space indentation").

So a companion that answers questions and gives plan feedback needs **both**
hooks, and `PreToolUse` should carry a matcher so ordinary tool calls are not
parked:

```jsonc
"PreToolUse":        [{ "matcher": "AskUserQuestion|ExitPlanMode",
                        "hooks": [{ "type": "http", "url": "…", "timeout": 600 }] }],
"PermissionRequest": [{ "hooks": [{ "type": "http", "url": "…", "timeout": 600 }] }]
```

`PreToolUse` fires ~120 ms before `PermissionRequest` for the same tool, and a
`PreToolUse` deny short-circuits it entirely.

**9. `Elicitation` never fires for any of this.** It is MCP-specific (an MCP
server asking the user something mid-tool-call). The app registers it today and
it will not fire for `AskUserQuestion`.

**10. `Notification` fires ~6 s after `PermissionRequest`** with
`{"notification_type": "permission_prompt", "message": "Claude needs your permission"}`.
Useful as a "still waiting" nudge for push, but keep it out of activity-state
mapping — it also fires post-`Stop`, which is why it is deliberately unmapped
today.

## Trap: headless `-p` is not a valid harness for this

In `-p` mode a `PreToolUse` `allow` is **not** sufficient — the run still failed
with `Claude requested permissions to use Bash, but you haven't granted it yet`
and `toolDenialKind: "user-rejected"`, even though the hook was recorded as
successful. Headless mode has its own permission gate (the Agent SDK's
`canUseTool`). Everything above was therefore measured in a real pty-hosted TUI,
which is what this app actually runs. Don't "simplify" the harness to `-p`.

## Re-running the harness

```bash
python3 scripts/hook-spike/tui.py park-perm 25000 60     # park 25s, then allow
SPIKE_ANSWER_AT=14 python3 scripts/hook-spike/tui.py park-perm 90000 60
python3 scripts/hook-spike/tui.py empty 0 45             # fall through to the dialog
SPIKE_PROMPT="Use the AskUserQuestion tool to ask me tabs or spaces." \
  python3 scripts/hook-spike/tui.py answer-pre 0 80
```

Run dirs land in `$TMPDIR/claude-term-hook-spike/` (override with `SPIKE_OUT`)
and hold `hooks.jsonl` (every request/response with timings), `settings.json`,
`tui.raw` and `tui.txt`. Nothing touches `~/.claude/settings.json`; the harness
uses a `--settings` overlay and a throwaway fixture dir, exactly as the app does.
