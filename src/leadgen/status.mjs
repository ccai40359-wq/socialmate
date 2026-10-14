// Leadgen status + collect-run bookkeeping. queue/leadgen-status.json holds
// the last CollectReport so both the UI and CLI can answer "when did it last
// run and what happened" without re-reading logs.
import { loadJson, saveJson } from '../store.mjs';

const STATUS_FILE = 'queue/leadgen-status.json';

export function loadCollectStatus() {
  return loadJson(STATUS_FILE, { ok: false, running: false, last: null });
}

export function setRunning(running) {
  const cur = loadCollectStatus();
  saveJson(STATUS_FILE, { ...cur, running: !!running, updatedAt: new Date().toISOString() });
}

export function recordCollectReport(report) {
  saveJson(STATUS_FILE, { ok: !Object.values(report?.platforms || {}).some((p) => p?.error), running: false, last: report, updatedAt: new Date().toISOString() });
}
