import { execFile } from 'child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { VolumeOp, VolumeState } from '../shared/types'

/**
 * Bridges the app's status bar to the audio-notifications plugin's live volume
 * knob. The plugin's notification hook reads ~/.claude/audio_volume_scale (a
 * float 0.0-1.0) fresh on every notification, so writing it changes the volume
 * for ALL running Claude sessions at once. ~/.claude/vol.sh is the canonical
 * control (handles +/-, mute<->restore via a .last file, atomic writes, and an
 * audible tick); we shell out to it for mutations so our controls, the global
 * hotkeys, and the menubar all stay in sync. Reads go straight to the file so
 * the 1.5s status-bar poll doesn't spawn a process every tick.
 */

const CLAUDE_DIR = join(homedir(), '.claude')
const SCALE_FILE = join(CLAUDE_DIR, 'audio_volume_scale')
const LAST_FILE = join(CLAUDE_DIR, 'audio_volume_scale.last')
const VOL_SH = join(CLAUDE_DIR, 'vol.sh')

function readPct(): number {
  try {
    const raw = readFileSync(SCALE_FILE, 'utf8').trim()
    if (!raw) return 100
    const f = parseFloat(raw)
    if (Number.isNaN(f)) return 100
    return Math.max(0, Math.min(100, Math.round(f * 100)))
  } catch {
    return 100
  }
}

export function getVolume(): VolumeState {
  const available = existsSync(SCALE_FILE) || existsSync(VOL_SH)
  const pct = readPct()
  return { pct, muted: pct <= 0, available }
}

function runVolSh(arg: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('/bin/bash', [VOL_SH, arg], { timeout: 4000 }, () => resolve())
  })
}

/** Write an integer percent (clamped) as a 0.000 float, atomically. */
function writePct(p: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(p)))
  const tmp = `${SCALE_FILE}.tmp`
  writeFileSync(tmp, (clamped / 100).toFixed(3))
  renameSync(tmp, SCALE_FILE)
}

/** Fallback for machines without vol.sh: mirror its mute<->restore behaviour. */
function toggleMuteDirect(): void {
  const now = readPct()
  if (now > 0) {
    writeFileSync(LAST_FILE, String(now))
    writePct(0)
  } else {
    let last = 100
    try {
      last = parseInt(readFileSync(LAST_FILE, 'utf8').trim(), 10) || 100
    } catch {
      /* no remembered level → full volume */
    }
    writePct(last)
  }
}

export async function setVolume(op: VolumeOp): Promise<VolumeState> {
  if (existsSync(VOL_SH)) {
    const arg =
      op === 'up' ? '+' : op === 'down' ? '-' : op === 'toggle' ? 'm' : String(op)
    await runVolSh(arg)
  } else {
    const now = readPct()
    if (op === 'up') writePct(now + 10)
    else if (op === 'down') writePct(now - 10)
    else if (op === 'toggle') toggleMuteDirect()
    else if (typeof op === 'number') writePct(op)
  }
  return getVolume()
}
