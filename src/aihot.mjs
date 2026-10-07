// Thin AIHOT client shared by all modules.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig() {
  return JSON.parse(readFileSync(resolve('config.json'), 'utf8'));
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
