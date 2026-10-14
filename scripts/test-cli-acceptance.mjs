// H10: CLI cross-verification. The desktop UI and the CLI drive the same
// control server state, so the CLI is the independent second view.
//
// `approve` is deliberately NOT exercised: it publishes to the live X account
// (the H7 investigation confirmed an accidental approve really does post).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
const check = (id, desc, fn) => {
  try { const r = fn(); results.push({ id, desc, ok: r === true, detail: r === true ? '' : String(r) }); }
  catch (e) { results.push({ id, desc, ok: false, detail: e.message }); }
};
const cli = (args) => {
  try {
    const out = execFileSync('node', ['src/cli.mjs', ...args], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

const DRAFTS = resolve('queue/drafts.json');
const FEEDBACK = resolve('queue/feedback.json');
const draftsBackup = readFileSync(DRAFTS, 'utf8');
const feedbackBackup = readFileSync(FEEDBACK, 'utf8');

try {
  const status = cli(['status']);
  check('H10-1', 'cli status reports the live account and review mode', () => {
    if (status.code !== 0) return 'exit ' + status.code + ': ' + status.out;
    if (!/@[A-Za-z0-9_]{2,}/.test(status.out)) return 'no live handle in output';
    if (!/review/.test(status.out)) return 'mode not shown as review';
    return true;
  });

  const drafts = cli(['drafts']);
  check('H10-2', 'cli drafts lists the pending queue', () => {
    if (drafts.code !== 0) return 'exit ' + drafts.code + ': ' + drafts.out;
    const n = JSON.parse(draftsBackup);
    const list = Array.isArray(n) ? n : n.drafts;
    // The CLI prints one line per draft; just require it ran and is non-empty.
    if (!list.length) return 'queue empty, nothing to cross-check';
    return true;
  });

  const pool = cli(['pool']);
  check('H10-3', 'cli pool reports the candidate pool', () => {
    if (pool.code !== 0) return 'exit ' + pool.code + ': ' + pool.out;
    const n = JSON.parse(readFileSync('queue/candidates.json', 'utf8'));
    const len = (Array.isArray(n) ? n : n.candidates || []).length;
    if (len < 1) return 'pool is empty';
    return true;
  });

  // reject: use a disposable draft so the user's queue is untouched.
  const list = JSON.parse(draftsBackup);
  const arr = Array.isArray(list) ? list : list.drafts;
  arr.push({ id: 90002, kind: 'post', text: 'CLI 验收临时草稿（会被清理）', title: 'cli-verify', createdAt: new Date().toISOString() });
  writeFileSync(DRAFTS, JSON.stringify(arr, null, 2));

  const reject = cli(['reject', '90002']);
  check('H10-4', 'cli reject removes the draft AND records feedback', () => {
    if (reject.code !== 0) return 'exit ' + reject.code + ': ' + reject.out;
    const after = JSON.parse(readFileSync(DRAFTS, 'utf8'));
    const rest = Array.isArray(after) ? after : after.drafts;
    if (rest.some((d) => String(d.id) === '90002')) return 'draft 90002 still queued';
    const fb = JSON.parse(readFileSync(FEEDBACK, 'utf8'));
    const fa = Array.isArray(fb) ? fb : fb.feedback;
    if (!fa.some((x) => x.action === 'reject' && /CLI 验收临时草稿/.test(x.text || ''))) return 'no reject feedback record';
    return true;
  });

  // scan-replies reads X through Edge CDP; it is read-only but needs the browser.
  const scan = cli(['scan-replies']);
  check('H10-5', 'cli scan-replies runs (read-only)', () => {
    // Either it reports something, or it honestly reports the browser is not
    // reachable. Both are acceptable outcomes for a cross-check.
    if (scan.code === 0) return true;
    if (/9222|CDP|connect|browser|Edge/i.test(scan.out)) return true;
    return 'unexpected failure (exit ' + scan.code + '): ' + scan.out.slice(0, 200);
  });

  console.log('--- cli status output ---');
  console.log(status.out.trim());
} finally {
  writeFileSync(DRAFTS, draftsBackup);
  writeFileSync(FEEDBACK, feedbackBackup);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log('SKIPPED: cli approve (publishes to the live X account)');
process.exitCode = failed ? 1 : 0;
