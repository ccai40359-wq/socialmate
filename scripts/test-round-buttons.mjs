// Round-button API acceptance: POST /api/round/<name>.
// The route contract (400/409/200 + publish flags) is asserted against a
// server whose CODE_ROOT points at a non-existent dir, so any spawned child
// fails fast on 'error' instead of touching the real browser or the X account.
// Read-only rounds never publish (hard invariant I1), so no draft/post can
// result from this file.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_CODE_ROOT = resolve(ROOT, '_w-nocode-root');
process.env.SOCIALMATE_CODE_ROOT = FAKE_CODE_ROOT;

const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });

const results = [];
const okc = (name, detail = '') => results.push({ name, ok: true, detail });
const badc = (name, detail) => results.push({ name, ok: false, detail: String(detail) });
const assert = (name, cond, detail = '') => {
  if (cond) okc(name, detail); else badc(name, 'ASSERT FAILED ' + detail);
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};

const logBefore = existsSync(resolve(ROOT, 'log.txt')) ? readFileSync(resolve(ROOT, 'log.txt'), 'utf8').split('\n').length : 0;

try {
  const unknown = await post('/api/round/foo');
  assert('POST /api/round/foo -> 400', unknown.status === 400, `status=${unknown.status}`);
  assert('  ...error says unknown round', /unknown round/.test(unknown.json?.error || ''), unknown.text);

  const collect = await post('/api/round/collect');
  assert('POST /api/round/collect -> 200', collect.status === 200 && collect.json?.ok === true, `status=${collect.status} body=${collect.text.slice(0, 120)}`);
  assert('  ...round=collect, publish=false', collect.json?.round === 'collect' && collect.json?.publish === false, collect.text);
  assert('  ...spawn went to the fake code root (never real)', collect.json?.pid != null, collect.text);

  const collectPub = await post('/api/round/collect', { publish: true });
  assert('POST /api/round/collect {publish:true} -> still publish:false', collectPub.status === 200 && collectPub.json?.publish === false, collectPub.text);

  const replyNo = await post('/api/round/reply');
  assert('POST /api/round/reply (no body) -> 400', replyNo.status === 400, `status=${replyNo.status}`);
  assert('  ...error demands explicit publish', /publish/.test(replyNo.json?.error || ''), replyNo.text);
  const replyBody = await post('/api/round/reply', {});
  assert('POST /api/round/reply {} -> 400 (empty object is not a confirmation)', replyBody.status === 400, `status=${replyBody.status}`);

  const replyYes = await post('/api/round/reply', { publish: true });
  assert('POST /api/round/reply {publish:true} -> 200', replyYes.status === 200 && replyYes.json?.ok === true, `status=${replyYes.status}`);
  assert('  ...round=reply, publish=true', replyYes.json?.round === 'reply' && replyYes.json?.publish === true, replyYes.text);

  for (const name of ['like', 'browse', 'others', 'content']) {
    const r = await post('/api/round/' + name, name === 'others' || name === 'content' ? { publish: true } : undefined);
    assert('POST /api/round/' + name + ' accepted', r.status === 200 && r.json?.ok === true && r.json?.round === name, `status=${r.status} body=${r.text.slice(0, 120)}`);
  }

  const logAfter = existsSync(resolve(ROOT, 'log.txt')) ? readFileSync(resolve(ROOT, 'log.txt'), 'utf8').split('\n').length : 0;
  assert('round starts logged to log.txt', logAfter > logBefore, `before=${logBefore} after=${logAfter}`);
  const logText = readFileSync(resolve(ROOT, 'log.txt'), 'utf8');
  assert('log records round + publish flag', /server: round reply started pid=\d+ publish=--publish/.test(logText) && /server: round collect started pid=\d+ publish=no/.test(logText), logText.split('\n').slice(-12).join('\n'));
} finally {
  server.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.error('FAILURES:', failed.length); process.exit(1); }
process.exit(0);
