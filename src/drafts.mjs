// Draft queue for human-review mode: actions that are not auto-published land
// here and can be approved or rejected from the CLI.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const DEFAULT = 'queue/drafts.json';

export function loadDrafts(file = DEFAULT) {
  try { return JSON.parse(readFileSync(joinData(file), 'utf8')); }
  catch { return []; }
}

// Atomic write: the daemon appends drafts while the UI removes them, so a
// half-written file would be read back as a corrupt queue. Write to a temp
// file and rename over the target.
export function saveDrafts(list, file = DEFAULT) {
  const abs = joinData(file);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  renameSync(tmp, abs);
}

function joinData(p) {
  return resolve(DATA_ROOT, p);
}

export function addDraft(draft, file = DEFAULT) {
  const list = loadDrafts(file);
  const id = (Number(list[list.length - 1]?.id) || 0) + 1;
  const entry = { id, createdAt: new Date().toISOString(), ...draft };
  list.push(entry);
  saveDrafts(list, file);
  return entry;
}

export function removeDraft(id, file = DEFAULT) {
  const list = loadDrafts(file);
  const idx = list.findIndex((d) => String(d.id) === String(id));
  if (idx === -1) return null;
  const [entry] = list.splice(idx, 1);
  saveDrafts(list, file);
  return entry;
}
