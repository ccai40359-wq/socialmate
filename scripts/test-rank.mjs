import { connect, workPage, closeBrowser } from '../src/edge.mjs';
import { loadConfig } from '../src/aihot.mjs';
import { collectCandidates } from '../src/perceive/index.mjs';
import { rankCandidates } from '../src/select.mjs';

const cfg = loadConfig();
const { browser, ctx } = await connect(cfg);
const page = await workPage(ctx);

const cands = await collectCandidates({ page, cfg, limit: 40 });
const by = {};
for (const c of cands) by[c.source] = (by[c.source] || 0) + 1;
console.log('total:', cands.length, '| by source:', JSON.stringify(by));
await closeBrowser(browser);

console.log('\n--- rankCandidates (real LLM) ---');
const t0 = Date.now();
const ranked = await rankCandidates(cands, cfg, { topN: 8 });
console.log(`ranked in ${Date.now() - t0}ms; top ${ranked.length}:`);
for (const c of ranked.slice(0, 5)) {
  console.log(`  score=${c.score} [${c.source}] ${(c.title || '').slice(0, 64)}`);
  if (c.why) console.log(`    why: ${c.why}`);
}
process.exit(0);
