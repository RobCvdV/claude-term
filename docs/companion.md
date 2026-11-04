# Phone companion

How a phone reaches claude-term sessions. The app itself is
[claude-term-companion](https://github.com/RobCvdV/claude-term-companion); the wire protocol is
[claude-term-protocol](https://github.com/RobCvdV/claude-term-protocol), pinned to a tag and
shared by both ends so they can't drift apart. Its types are inferred from zod schemas, so
validation and TypeScript are one statement.

## Reaching the Mac

- **Only over Tailscale.** The server binds to the tailnet address plus loopback, never
  `0.0.0.0`, so nothing on the local network can reach it. WireGuard supplies the encryption.
- **Ed25519 challenge/response** answers "which of my devices is this, and is this request
  fresh?". No token or password is ever sent.

## Pairing

**⌘K → Phones — pair or revoke…** shows a QR (address, port and code in one scan) and the same
code to type. It is valid for two minutes and enrols exactly one device, which proves it holds
its own key. The panel lists paired devices and revokes them; revoking drops the socket at once.

There is no confirmation dialog: the code is the gate, and a second modal on top of the code
panel is what deadlocked pairing the first time. The registry is `companion-devices.json` in
userData (mode 0600) and holds public keys only.

`scripts/companion-client.mjs` is a command-line stand-in for the phone:

```bash
node scripts/companion-client.mjs pair --host 100.x.y.z --port <port> --code ABCD2345
node scripts/companion-client.mjs watch   # prints sessions and prompts; reads commands on stdin
```

## Answering prompts

- Prompts are held for a phone whenever one is **paired**, connected or not. A phone that
  reconnects is handed everything still waiting.
- Claude Code draws its dialog in the terminal at the same time, so a prompt is always still
  answerable at the desk. Whichever side answers first wins. Nothing is auto-approved.
- **Questions** (`AskUserQuestion`) are held by the term-bridge mod, which races the terminal's
  dialog against the phone with no time limit.
- **Permissions** stay on the `PermissionRequest` hook, which Claude Code gives up on after
  600 s. At 9.5 minutes claude-term denies it with a reason the mod recognises, and the mod asks
  again as an **Allow/Deny** question — Allow re-runs that exact call once. Nothing is
  remembered from a re-ask.
- **"Allow and stop asking"** writes a rule into the project's `.claude/settings.local.json`, the
  file Claude Code's own "don't ask again" uses. Rules are only offered for `Bash`, and never for
  a command with shell operators: a rule read off `mkdir a && rm -rf b` would license the second
  half too. For other tools the prompt is answered once.
- A held prompt is handed back when its tab closes or the app quits.

Every held prompt's life — parked, answered, expired, withdrawn — is logged to `companion.log`
in userData.

## Sending prompts

A prompt from a phone is **held while the session shows a dialog**, since text typed then would
answer the dialog instead. It goes in as soon as the dialog clears. A busy session needs no such
care — Claude Code queues typed input itself.

## Following a session

- **Progress** — while a turn runs, the mod reports the spinner's word ("Tinkering"), the tool
  running and what it runs on, and the steps done so far.
- **Conversation** (`w <tab>` in the client) — read from the transcript, not the terminal, which
  keeps no scrollback. Turns are append-only, so a follower keeps an index as its cursor and each
  poll costs a stat plus a read of the new bytes. The parse cache is shared with `⌘F`.
- **Screen snapshot** (`v <tab>`) — the visible rows right now, not a byte stream: the TUI redraws
  in place, so its PTY output is mostly cursor moves and spinner frames. Only the renderer's xterm
  knows what is on screen, so main asks it over `screen:request` / `screen:reply`
  (`src/main/screen-requests.ts`) and gives up rather than hang if no answer comes.

## Push notifications

Paired phones get a push through Expo when a tab starts waiting for input, a long turn finishes,
or a session ends.

- Not while the app is focused, and not to a device that reports the session on screen.
- A tab can't ping twice within ten seconds.
- Bodies hold only the title and folder name, because a push travels through Expo and Apple; the
  command, path and diff stay on the tailnet.
- A token Expo reports as `DeviceNotRegistered` is dropped.
