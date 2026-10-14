// Thin AIHOT client shared by all modules.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();

export function loadConfig() {
  // config.json is the user's own runtime config and is git-ignored. A fresh
  // checkout (or a first launch with no config yet) falls back to the committed
  // template so the app can always start; the desktop shell also seeds a
  // writable config.json from this template on first run.
  const own = resolve(DATA_ROOT, 'config.json');
  if (existsSync(own)) return JSON.parse(readFileSync(own, 'utf8'));
  return JSON.parse(readFileSync(resolve(DATA_ROOT, 'config.example.json'), 'utf8'));
}

export async function aihotGet(cfg, path) {
  const res = await fetch(`https://aihot.news/api/v1/agent${path}`, {
    headers: { 'User-Agent': cfg.aihotUserAgent, 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 5) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return aihotGet(cfg, path);
  }
  if (!res.ok) throw new Error(`AIHOT ${path} -> HTTP ${res.status}`);
  return res.text();
}
