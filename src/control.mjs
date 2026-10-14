// Run control: the pause switch and publish mode, shared by CLI, server and
// the desktop UI. Atomic writes so a crash never leaves a half-written file.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const DEFAULT = { paused: false, mode: 'review', updatedAt: null };

export function controlFile() {
  return process.env.SOCIALMATE_CONTROL
    ? resolve(process.env.SOCIALMATE_CONTROL)
    : resolve(DATA_ROOT, 'control.json');
}

export function readControl() {
  const f = controlFile();
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return { ...DEFAULT, ...raw };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeControl(patch) {
  const f = controlFile();
  const next = { ...readControl(), ...patch, updatedAt: new Date().toISOString() };
  const tmp = f + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, f);
  return next;
}

export function isPaused() { return !!readControl().paused; }
export function currentMode(fallback = 'review') { return readControl().mode || fallback; }

// T8-b: a block pauses globally and records why, in one place so both the
// scheduler and the tests exercise the same code path.
export function pause(reason) {
  return writeControl({ paused: true, pauseReason: reason || "blocked" });
}
