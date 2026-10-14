// Tiny JSON file store for run state and dedupe sets.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();

export function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(joinData(file), 'utf8')); }
  catch { return fallback; }
}

export function saveJson(file, value) {
  const abs = joinData(file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2), 'utf8');
}

function joinData(p) {
  return resolve(DATA_ROOT, p);
}

export function todayKey() {
  const now = new Date();
  const cn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = cn.getFullYear();
  const m = String(cn.getMonth() + 1).padStart(2, '0');
  const d = String(cn.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function loadState(file, freshState) {
  const s = loadJson(file, null);
  if (!s || s.date !== todayKey()) {
    const next = { ...freshState(), date: todayKey() };
    saveJson(file, next);
    return next;
  }
  return s;
}

export function saveState(file, state) { saveJson(file, state); }

export function loadSeen(file) { return loadJson(file, { posts: [], topics: [] }); }
export function saveSeen(file, seen) { saveJson(file, seen); }

export function ensureDir(p) { if (!existsSync(joinData(p))) mkdirSync(joinData(p), { recursive: true }); }

// ---- queue/stats.json ring (T6) -----------------------------------------
// Same atomic discipline as src/drafts.mjs saveDrafts: tmp + rename so a
// crash never leaves a half-written stats file. Ring capped at 200 rounds so
// it stays structured and small — never a second log.txt.
const STATS_RING_MAX = 200;
export function loadStatsRing() {
  try { const p = JSON.parse(readFileSync(joinData('queue/stats.json'), 'utf8')); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
export function saveStatsRing(entries) {
  const abs = joinData('queue/stats.json');
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  renameSync(tmp, abs);
}
export function recordRound(entry) {
  const ring = loadStatsRing();
  ring.push({ ts: Date.now(), acted: 0, note: '', ...entry });
  const next = ring.slice(-STATS_RING_MAX);
  saveStatsRing(next);
  return next;
}
export function todayStats() {
  const ring = loadStatsRing().filter((r) => r && Number(r.ts));
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const t = ring.filter((r) => new Date(r.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === day);
  const sum = (k) => t.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const bySource = {}; const dropReasons = {}; const byHour = {};
  for (const r of t) {
    for (const [k, v] of Object.entries(r.bySource || {})) bySource[k] = (bySource[k] || 0) + (Number(v) || 0);
    for (const [k, v] of Object.entries(r.dropReasons || {})) dropReasons[k] = (dropReasons[k] || 0) + (Number(v) || 0);
    const h = String(new Date(r.ts).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit' })).padStart(2, '0');
    byHour[h] = (byHour[h] || 0) + 1;
  }
  return { read: sum('read'), kept: sum('kept'), dropped: sum('dropped'), acted: sum('acted'), bySource, dropReasons, byHour };
}
export { STATS_RING_MAX };
