// Publish-time gate: an edited draft that violates the gate must be refused
// before any browser action. Uses an unreachable CDP port so that a bug in the
// gate is observable: if the gate lets it through we get a browser error
// instead of a gate error, which is a distinguishable failure.
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const DRAFTS = resolve('queue/drafts.json');
const backup = existsSync(DRAFTS) ? readFileSync(DRAFTS, 'utf8') : '[]';

const PORT = 4181;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

// A draft that is far too long for X, as if the user pasted a wall of text.
writeFileSync(DRAFTS, JSON.stringify([{ id: 900, kind: 'post', createdAt: new Date().toISOString(), text: '啊'.repeat(400) }], null, 2), 'utf8');

const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/drafts/900/approve`, { method: 'POST' });
  const j = await r.json();
  const first = j?.results?.[0] || {};
  check('over-long draft is refused, not published', first.ok === false, JSON.stringify(first).slice(0, 160));
  check('refusal cites the gate, not the browser', /gate:/.test(first.error || ''), first.error || '(no error)');
  check('refused draft stays in the queue', JSON.parse(readFileSync(DRAFTS, 'utf8')).some((d) => String(d.id) === '900'));

  // A spam draft must be refused for content reasons.
  writeFileSync(DRAFTS, JSON.stringify([{ id: 901, kind: 'post', createdAt: new Date().toISOString(), text: '加微 私聊 兼职刷单 返利' }], null, 2), 'utf8');
  const r2 = await fetch(`http://127.0.0.1:${PORT}/api/drafts/901/approve`, { method: 'POST' });
  const j2 = await r2.json();
  const first2 = j2?.results?.[0] || {};
  check('spam draft is refused', first2.ok === false && /gate:/.test(first2.error || ''), JSON.stringify(first2).slice(0, 160));
} finally {
  server.close();
  writeFileSync(DRAFTS, backup, 'utf8');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
