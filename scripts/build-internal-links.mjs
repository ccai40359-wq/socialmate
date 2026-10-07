// Build the content pool from many AIHOT queries (deduped by item URL).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAihotMarkdown } from '../src/aihot-parse.mjs';
import { loadConfig, aihotGet } from '../src/aihot.mjs';

const cfg = loadConfig();
const paths = [
  '/latest?limit=30',
  '/latest?limit=30&mode=all',
  '/latest?limit=30&category=ai-models',
  '/latest?limit=30&category=ai-products',
  '/latest?limit=30&category=industry',
  '/latest?limit=30&category=paper',
  '/latest?limit=30&category=tip',
  '/latest?window=7d&limit=30',
];

const seen = new Set();
const all = [];
for (const p of paths) {
  try {
    const items = parseAihotMarkdown(await aihotGet(cfg, p));
    let added = 0;
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url); all.push(it); added++;
    }
    console.log(`${p} -> +${added} (total ${all.length})`);
    await new Promise(r => setTimeout(r, 500));
  } catch (e) { console.log(`skip ${p}: ${e.message}`); }
}

mkdirSync(resolve('queue'), { recursive: true });
writeFileSync(resolve('queue/internal-links.json'), JSON.stringify(all, null, 2), 'utf8');
console.log(`\nSaved ${all.length} unique AIHOT items with summaries.`);
