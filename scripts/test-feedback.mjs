// Feedback capture acceptance: real HTTP against a real server on a test port.
// Proves reject / edit / approve are recorded, that the store survives a
// restart, and that feedback never became a publish gate.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const PORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;
const DRAFTS = resolve('queue/drafts.json');
const FEEDBACK = resolve('queue/feedback.json');

const results = [];
const ok = (n, d = '') => results.push({ name: n, ok: true, detail: d });
const bad = (n, d) => results.push({ name: n, ok: false, detail: String(d) });
const assert = (n, c, d = '') => { if (c) ok(n, d); else bad(n, 'ASSERT FAILED ' + d); };

const backup = {
  drafts: existsSync(DRAFTS) ? readFileSync(DRAFTS, 'utf8') : null,
  feedback: existsSync(FEEDBACK) ? readFileSync(FEEDBACK, 'utf8') : null,
};
const restore = () => {
  try { if (backup.drafts === null) rmSync(DRAFTS, { force: true }); else writeFileSync(DRAFTS, backup.drafts, 'utf8'); } catch {}
  try { if (backup.feedback === null) rmSync(FEEDBACK, { force: true }); else writeFileSync(FEEDBACK, backup.feedback, 'utf8'); } catch {}
};
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

const feedback = await import('../src/feedback.mjs');

async function startServer() {
  const { startServer: s } = await import('../src/server.mjs');
  return s({ port: PORT });
}

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};

// seed drafts directly (the API has no create endpoint)
writeFileSync(DRAFTS, JSON.stringify([
  { id: 901, createdAt: new Date().toISOString(), kind: 'post', text: '这是一条会被拒绝的草稿内容', title: 't' },
  { id: 902, createdAt: new Date().toISOString(), kind: 'post', text: '这是一条会被编辑的草稿内容', title: 't' },
  { id: 903, createdAt: new Date().toISOString(), kind: 'post', text: 'hi', title: 'too short on purpose' },
], null, 2), 'utf8');
try { rmSync(FEEDBACK, { force: true }); } catch {}

let server = await startServer();
ok('server starts', `port ${PORT}`);
try {
  // --- reject with a reason -------------------------------------------
  const rj = await post('/api/drafts/901/reject', { reason: 'too_long' });
  assert('reject returns ok', rj.status === 200 && rj.json?.ok === true);
  const afterReject = feedback.loadFeedback();
  const rec = afterReject.find((x) => x.text === '这是一条会被拒绝的草稿内容');
  assert('reject recorded with reason', !!rec && rec.action === 'reject' && rec.reason === 'too_long', JSON.stringify(rec));
  assert('reject record has required fields', !!rec && rec.kind === 'post' && typeof rec.ts === 'string' && typeof rec.id === 'number');

  // --- reject without a reason is allowed ------------------------------
  const rj2 = await post('/api/drafts/902/reject', {});
  assert('reject without reason still 200', rj2.status === 200 && rj2.json?.ok === true);
  const noReason = feedback.loadFeedback().find((x) => x.action === 'reject' && x.kind === 'post' && !x.reason);

  // --- edit records before/after ---------------------------------------
  writeFileSync(DRAFTS, JSON.stringify([{ id: 902, createdAt: new Date().toISOString(), kind: 'post', text: '这是一条会被编辑的草稿内容', title: 't' }], null, 2), 'utf8');
  const ed = await post('/api/drafts/902/update', { text: '编辑之后的草稿内容' });
  assert('edit returns ok', ed.status === 200 && ed.json?.ok === true);
  const editRec = feedback.loadFeedback().find((x) => x.action === 'edit');
  assert('edit records before AND after', !!editRec && editRec.text === '这是一条会被编辑的草稿内容' && editRec.editedText === '编辑之后的草稿内容', JSON.stringify(editRec));

  // --- approve that fails the gate is still recorded --------------------
  // text 'hi' is below gate.minLength, so checkPost rejects it BEFORE any
  // publish call: nothing is posted, but the human's approval is captured.
  writeFileSync(DRAFTS, JSON.stringify([{ id: 903, createdAt: new Date().toISOString(), kind: 'post', text: 'hi', title: 'too short' }], null, 2), 'utf8');
  const ap = await post('/api/drafts/903/approve');
  const apRec = feedback.loadFeedback().filter((x) => x.action === 'approve' && x.text === 'hi').pop();
  assert('gate-blocked approve is recorded', !!apRec && /gate:/.test(apRec.gateReason || ''), JSON.stringify(apRec));
  assert('gate-blocked approve did NOT publish', ap.json?.results?.[0]?.ok === false, JSON.stringify(ap.json?.results));

  // --- recentFeedback() read API ---------------------------------------
  const recent = feedback.recentFeedback({ action: 'reject', n: 10 });
  assert('recentFeedback returns rejects, newest first', Array.isArray(recent) && recent.length >= 1 && recent[0].action === 'reject');
  const none = feedback.recentFeedback({ kind: 'quote', action: 'reject', n: 5 });
  assert('recentFeedback filters by kind', Array.isArray(none) && none.every((x) => x.kind === 'quote'));

  // --- persists across a restart, stays valid JSON ----------------------
  const before = feedback.loadFeedback().length;
  server.close();
  server = await startServer();
  const after = feedback.loadFeedback().length;
  assert('feedback survives server restart', after === before && after > 0, `${before} -> ${after}`);
  let parsedOk = true;
  try { const raw = JSON.parse(readFileSync(FEEDBACK, 'utf8')); parsedOk = Array.isArray(raw); } catch { parsedOk = false; }
  assert('feedback.json is a valid JSON array', parsedOk);

  // --- ring cap ---------------------------------------------------------
  for (let i = 0; i < 520; i++) feedback.recordFeedback({ action: 'reject', kind: 'post', text: 'cap ' + i });
  assert('feedback ring-truncates to <= 500', feedback.loadFeedback().length <= 500, String(feedback.loadFeedback().length));

  // --- no secrets -------------------------------------------------------
  assert('feedback.json has no secret fields', !/apiKey|api_key|sk-[A-Za-z0-9]{8,}/i.test(readFileSync(FEEDBACK, 'utf8')));
} finally {
  server.close();
  restore();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.error('FAILURES:', failed.length); process.exit(1); }
process.exit(0);
