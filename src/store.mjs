// Tiny JSON file store for run state and dedupe sets.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(resolve(file), 'utf8')); }
  catch { return fallback; }
}

export function saveJson(file, value) {
  const abs = resolve(file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(value, null, 2), 'utf8');
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

export function ensureDir(p) { if (!existsSync(resolve(p))) mkdirSync(resolve(p), { recursive: true }); }
