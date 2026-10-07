// Draft queue for human-review mode: actions that are not auto-published land
// here and can be approved or rejected from the CLI.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DEFAULT = 'queue/drafts.json';

export function loadDrafts(file = DEFAULT) {
  try { return JSON.parse(readFileSync(resolve(file), 'utf8')); }
  catch { return []; }
}

export function saveDrafts(list, file = DEFAULT) {
  const abs = resolve(file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(list, null, 2), 'utf8');
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
