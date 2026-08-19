#!/usr/bin/env python3
"""Drive the real Claude Code TUI in a pty and watch what an http hook can do.

This is the Phase 0 spike harness behind docs/companion-hook-protocol.md. It
starts a logging hook endpoint, launches the real `claude` TUI in a pty against a
throwaway fixture dir, sends one prompt, and reports which hooks fired, whether
the native permission dialog rendered, and whether the tool ran.

Usage:  python3 scripts/hook-spike/tui.py <policy> [delay_ms] [watch_seconds]

Policies (see hook-server.mjs): empty | 204 | allow | deny | allow-pre |
allow-perm | deny-perm | park-perm | answer | answer-pre

Env: SPIKE_PROMPT, SPIKE_MODE (permission mode), SPIKE_EFFORT, SPIKE_REASON,
     SPIKE_ANSWER_AT (seconds; presses Enter in the TUI to answer there),
     SPIKE_TAG (suffix for the run dir), SPIKE_OUT (where run dirs go).
"""
import os, pty, sys, time, json, fcntl, termios, struct, select, re, shutil, signal, subprocess, socket

HERE = os.path.dirname(os.path.abspath(__file__))
# runs are throwaway; keep them out of the repo
SP = os.environ.get("SPIKE_OUT") or os.path.join(
    os.environ.get("TMPDIR", "/tmp"), "claude-term-hook-spike")
policy = sys.argv[1] if len(sys.argv) > 1 else "empty"
delay = sys.argv[2] if len(sys.argv) > 2 else "0"
watch = float(sys.argv[3]) if len(sys.argv) > 3 else 45.0
answer_at = float(os.environ.get("SPIKE_ANSWER_AT", "0"))  # seconds after prompt: press Enter in the TUI

run = os.path.join(SP, f"tui-{policy}-{delay}{os.environ.get('SPIKE_TAG','')}")
shutil.rmtree(run, ignore_errors=True)
fixture = os.path.join(run, "fixture")
os.makedirs(fixture)
open(os.path.join(fixture, "readme.md"), "w").write("hello spike\n")

log = os.path.join(run, "hooks.jsonl")
portfile = os.path.join(run, "port")
env = dict(os.environ, SPIKE_LOG=log, SPIKE_POLICY=policy,
           SPIKE_DELAY_MS=delay, SPIKE_PORT_FILE=portfile)
srv = subprocess.Popen(["node", os.path.join(HERE, "hook-server.mjs")],
                       env=env, stdout=open(os.path.join(run, "server.out"), "w"),
                       stderr=subprocess.STDOUT)
for _ in range(50):
    if os.path.exists(portfile) and open(portfile).read().strip():
        break
    time.sleep(0.1)
port = open(portfile).read().strip()

events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
          "Elicitation", "Notification", "PostToolUse", "Stop", "SessionEnd"]
url = f"http://127.0.0.1:{port}/hook?tab=spike&token=spike"
settings = json.dumps({
    "hooks": {e: [{"hooks": [{"type": "http", "url": url, "timeout": 600}]}] for e in events},
    "permissions": {"defaultMode": "default", "ask": ["Bash(mkdir *)"]},
    "effortLevel": os.environ.get("SPIKE_EFFORT", "low"),
})
open(os.path.join(run, "settings.json"), "w").write(settings)

claude = shutil.which("claude")
print(f"=== TUI policy={policy} delay={delay}ms port={port} ===", flush=True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(fixture)
    os.environ["TERM"] = "xterm-256color"
    for k in ("CLAUDE_CODE_SSE_PORT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
              "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"):
        os.environ.pop(k, None)
    mode = os.environ.get("SPIKE_MODE", "default")
    os.execv(claude, [claude, "--settings", settings, "--permission-mode", mode])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 130, 0, 0))
raw = open(os.path.join(run, "tui.raw"), "wb")
buf = bytearray()

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            raw.write(d); raw.flush(); buf.extend(d)

ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][B0]|\x1b[=>]")
def text():
    return ANSI.sub(b"", bytes(buf)).decode("utf8", "replace")

pump(8)
prompt = os.environ.get("SPIKE_PROMPT") or f"Use the Bash tool to run exactly: mkdir spike-proof-{policy}   — then stop."
os.write(fd, b"\x1b[200~" + prompt.encode() + b"\x1b[201~")
time.sleep(0.3)
os.write(fd, b"\r")
print(f"[sent prompt at t=0, watching {watch}s]", flush=True)

t0 = time.time()
marks = []
# The TUI positions each glyph with its own cursor move, so stripping ANSI
# collapses the spaces out of words — match against whitespace-free text.
DIALOG = re.compile(r"(Doyouwanttoproceed|requiresconfirmation)", re.I)
def squashed():
    return re.sub(r"\s+", "", text())
seen_dialog = False
answered = False
while time.time() - t0 < watch:
    pump(1.0)
    if answer_at and not answered and time.time() - t0 >= answer_at:
        answered = True
        os.write(fd, b"\r")   # confirm the highlighted "1. Yes" in the native dialog
        print(f"  t={round(time.time()-t0,1)}s  ANSWERED IN TERMINAL (Enter)", flush=True)
    if not seen_dialog and DIALOG.search(squashed()):
        seen_dialog = True
        marks.append((round(time.time() - t0, 1), "NATIVE DIALOG VISIBLE"))
        print(f"  t={marks[-1][0]}s  NATIVE DIALOG VISIBLE", flush=True)
    p = os.path.join(fixture, f"spike-proof-{policy}")
    if os.path.isdir(p):
        marks.append((round(time.time() - t0, 1), "TOOL RAN"))
        print(f"  t={marks[-1][0]}s  TOOL RAN (dir created)", flush=True)
        break

pump(1.0)
os.write(fd, b"\x03"); time.sleep(0.3); os.write(fd, b"\x03")
pump(1.5)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
srv.terminate()
raw.close()
open(os.path.join(run, "tui.txt"), "w").write(text())

print("--- result ---")
print(f"  native dialog appeared: {seen_dialog}")
print(f"  tool ran: {os.path.isdir(os.path.join(fixture, 'spike-proof-' + policy))}")
print("--- hook events ---")
try:
    for l in open(log):
        d = json.loads(l)
        if d.get("phase") == "req":
            print(f"  {d['t']:>7}ms  {d.get('event')}")
except FileNotFoundError:
    pass
print(f"--- artifacts in {run} ---")
