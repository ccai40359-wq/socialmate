// Verify the perception layer against the live browser + AIHOT.
import { connect, workPage, closeBrowser } from '../src/edge.mjs';
import { loadConfig } from '../src/aihot.mjs';
import { collectCandidates, expandTopics } from '../src/perceive/index.mjs';

const cfg = loadConfig();
console.log('--- expandTopics ---');
for (const seed of ['ai', '大模型', '美股']) {
  console.log(`  "${seed}" ->`, JSON.stringify(await expandTopics(seed, cfg)));
}

const { browser, ctx } = await connect(cfg);
const page = await workPage(ctx);

console.log('\n--- collectCandidates ---');
const cands = await collectCandidates({ page, cfg, limit: 40 });
const bySource = {};
for (const c of cands) bySource[c.source] = (bySource[c.source] || 0) + 1;
console.log('total:', cands.length);
console.log('by source:', JSON.stringify(bySource));

console.log('\n--- samples (3) ---');
for (const c of cands.slice(0, 3)) {
  console.log(`  [${c.source}] likes=${c.likes} age=${c.ageHours} lang=${c.lang}`);
  console.log(`    ${(c.title || c.text || '').slice(0, 90)}`);
  console.log(`    url=${c.url}`);
  console.log(`    origin=${c.origin || '-'}`);
}
await closeBrowser(browser);
process.exit(0);
