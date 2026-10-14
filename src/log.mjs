import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const logFile = resolve(DATA_ROOT, 'log.txt');

export function nowLocal() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

export function appendLog(msg) {
  const line = `[${nowLocal()}] ${msg}`;
  console.log(line);
  try { appendFileSync(logFile, line + '\n'); } catch (_) {}
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
