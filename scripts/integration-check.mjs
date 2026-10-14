// Integration acceptance: verifies the assembled pipeline end to end.
// Run by the main session after all workstreams land.
// Exits non-zero if any required module is missing or any assertion fails.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Always evaluate paths against the repo root, no matter where npm is invoked from.
process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r !== false, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
async function checkAsync(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: r !== false, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

const REQUIRED = [
  'src/llm.mjs', 'src/voice.mjs', 'src/gate.mjs', 'src/select.mjs', 'src/run.mjs',
  'src/control.mjs', 'src/server.mjs', 'src/humanize.mjs', 'src/safety.mjs',
  'src/perceive/index.mjs', 'app/main.mjs', 'app/renderer/index.html',
];
for (const f of REQUIRED) check(`file exists: ${f}`, () => existsSync(resolve(f)));

// --- module interfaces --------------------------------------------------
await checkAsync('llm exports frozen interface', async () => {
  const m = await import('../src/llm.mjs');
  for (const fn of ['loadProviderConfig', 'complete', 'completeJson', 'testConnection', 'isConfigured']) {
    if (typeof m[fn] !== 'function') throw new Error(`missing export ${fn}`);
  }
  return true;
});

await checkAsync('safety exports frozen interface', async () => {
  const m = await import('../src/safety.mjs');
  for (const fn of ['detectBlock', 'screenContent', 'weightedLen']) {
    if (typeof m[fn] !== 'function') throw new Error(`missing export ${fn}`);
  }
  if (m.weightedLen('https://a.com') !== 23) throw new Error('URL must weigh 23');
  if (m.weightedLen('中文') !== 4) throw new Error('CJK must weigh 2 each');
  return true;
});

await checkAsync('humanize exports frozen interface', async () => {
  const m = await import('../src/humanize.mjs');
  for (const fn of ['typeHuman', 'thinkPause', 'scrollWarmup', 'moveHuman', 'pickTimingProfile']) {
    if (typeof m[fn] !== 'function') throw new Error(`missing export ${fn}`);
  }
  return true;
});

await checkAsync('control round-trips', async () => {
  const m = await import('../src/control.mjs');
  m.writeControl({ paused: false, mode: 'review' });
  const c = m.readControl();
  if (c.mode !== 'review') throw new Error('mode did not persist');
  return true;
});

await checkAsync('perceive exports frozen interface', async () => {
  const m = await import('../src/perceive/index.mjs');
  for (const fn of ['collectCandidates', 'expandTopics']) {
    if (typeof m[fn] !== 'function') throw new Error(`missing export ${fn}`);
  }
  return true;
});

// --- behaviour assertions ----------------------------------------------
await checkAsync('gate rejects spam and duplicates', async () => {
  const g = await import('../src/gate.mjs');
  const good = g.checkPost({ text: 'AI 又出新东西了，这次是模型侧', cfg: {}, history: { entries: [] } });
  if (!good.ok) throw new Error('normal AI content was rejected: ' + good.reasons.join(','));
  const spam = g.checkPost({ text: '彩票代理加微信刷单返利', cfg: {}, history: { entries: [] } });
  if (spam.ok) throw new Error('spam content passed the gate');
  const dup = g.checkPost({ text: 'AI 又出新东西了，这次是模型侧', cfg: {}, history: { entries: [{ id: 'x', text: 'AI 又出新东西了，这次是模型侧' }] } });
  if (dup.ok) throw new Error('duplicate content passed the gate');
  return true;
});

await checkAsync('gate enforces weighted length', async () => {
  const g = await import('../src/gate.mjs');
  const long = '中'.repeat(200);
  const r = g.checkPost({ text: long, cfg: {}, history: { entries: [] } });
  if (r.ok) throw new Error('over-length post passed');
  return true;
});

await checkAsync('safety blocks politics by default', async () => {
  const s = await import('../src/safety.mjs');
  const r = s.screenContent('某国大选结果引发争议', { safety: { allowPolitics: false } });
  if (r.ok) throw new Error('politics passed while disabled');
  return true;
});

await checkAsync('risk categories can be enabled explicitly', async () => {
  const s = await import('../src/safety.mjs');
  const r = s.screenContent('某国大选结果引发争议', { safety: { allowPolitics: true } });
  if (!r.ok) throw new Error('politics stayed blocked even when enabled: ' + r.reason);
  return true;
});

// --- leadgen (线索雷达) --------------------------------------------------
await checkAsync('leadgen exports frozen interface', async () => {
  const store = await import('../src/leadgen/store.mjs');
  for (const fn of ['loadLeads', 'saveLeads', 'patchLead', 'appendLeads', 'newLeadId']) {
    if (typeof store[fn] !== 'function') throw new Error(`missing store export ${fn}`);
  }
  const score = await import('../src/leadgen/score.mjs');
  if (typeof score.scoreLeads !== 'function') throw new Error('missing scoreLeads');
  const gate = await import('../src/leadgen/gate.mjs');
  if (typeof gate.checkAction !== 'function') throw new Error('missing checkAction');
  const contact = await import('../src/leadgen/contact.mjs');
  if (typeof contact.extractContacts !== 'function') throw new Error('missing extractContacts');
  const collect = await import('../src/leadgen/collect.mjs');
  if (typeof collect.collectRun !== 'function') throw new Error('missing collectRun');
  const adapters = await import('../src/leadgen/adapters/index.mjs');
  for (const p of ['xhs', 'fb', 'threads']) {
    const a = await adapters.getAdapter(p);
    if (!a || typeof a.collect !== 'function') throw new Error(`adapter ${p} missing collect()`);
  }
  return true;
});

await checkAsync('leadgen is read-only by design', async () => {
  const gate = await import('../src/leadgen/gate.mjs');
  for (const act of ['post', 'quote', 'reply', 'dm', 'like', 'follow', 'comment']) {
    const r = gate.checkAction(act);
    if (r.ok || r.reason !== 'read-only') throw new Error(`action ${act} must be read-only`);
  }
  if (!gate.checkAction('open').ok) throw new Error('read actions must pass');
  return true;
});

await checkAsync('leadgen lead id is stable', async () => {
  const store = await import('../src/leadgen/store.mjs');
  const a = store.newLeadId('threads', 'https://www.threads.com/@x/post/1');
  const b = store.newLeadId('threads', 'https://www.threads.com/@x/post/1');
  if (a !== b || !/^[0-9a-f]{12}$/.test(a)) throw new Error('lead id not stable sha1-12');
  return true;
});

// --- provider reachability (only if configured) -------------------------
await checkAsync('configured provider answers, or is honestly unconfigured', async () => {
  const m = await import('../src/llm.mjs');
  if (!m.isConfigured()) return 'not configured (acceptable)';
  const r = await m.testConnection();
  if (!r.ok) throw new Error('configured but testConnection failed: ' + r.error);
  return `ok in ${r.latencyMs}ms`;
});

// --- report -------------------------------------------------------------
let failures = 0;
for (const r of results) {
  if (!r.ok) failures++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
// Use exitCode rather than process.exit(): on Windows, a hard exit while the
// undici agent is still closing trips a libuv assertion after the report.
process.exitCode = failures ? 1 : 0;

