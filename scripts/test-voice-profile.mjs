import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { styleBlock, sampleCounts, rejectedExamples, userContentFor } from '../src/voice.mjs';

process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

// ---- D1: style block uses all three sample tiers ----------------------
const profile = JSON.parse(readFileSync('queue/voice-profile.json', 'utf8'));
const counts = sampleCounts(profile);
ok('three tiers exist in voice profile', counts.tiny > 0 && counts.short > 0 && counts.medium > 0, JSON.stringify(counts));

const total = counts.total;
console.log(`total samples = ${total} (tiny=${counts.tiny}, short=${counts.short}, medium=${counts.medium})`);
const block = styleBlock(profile);
ok('style block contains the tier total', block.includes(`共 ${total} 条`), `looks for 共 ${total} 条`);
ok('style block injects tiny samples', counts.tiny > 0 && block.split('\n').filter((l) => l.startsWith('- ')).length >= counts.tiny, `tiny=${counts.tiny}`);
ok('style block injects medium samples', counts.medium > 0 && block.includes(profile.samples.medium[0]), 'medium sample text present');

const sampleLines = block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
const allSamples = [...(profile.samples.tiny || []), ...(profile.samples.short || []), ...(profile.samples.medium || [])].slice(0, 60);
ok('all injected samples are real profile samples', sampleLines.every((l) => allSamples.includes(l)), `injected=${sampleLines.length}`);

// ---- E3: feedback injected as negative examples / graceful degradation --
const dir = mkdtempSync(join(tmpdir(), 'sm-voice-fb-'));
const fbFile = join(dir, 'feedback.json');
try {
  writeFileSync(fbFile, JSON.stringify([
    { id: 1, ts: '2026-10-08T00:00:00.000Z', action: 'reject', kind: 'post', text: '这是一条被拒绝的样例内容字符串甲', reason: 'length' },
    { id: 2, ts: '2026-10-08T00:00:01.000Z', action: 'reject', kind: 'post', text: '第二条被拒绝的样例内容字符串乙', reason: '' },
    { id: 3, ts: '2026-10-08T00:00:02.000Z', action: 'approve', kind: 'post', text: '被批准的不该出现' },
  ], null, 2), 'utf8');

  const withFb = userContentFor(profile, 'post', 'PROMPT_MARKER', { file: fbFile });
  ok('reject feedback text is injected', withFb.includes('这是一条被拒绝的样例内容字符串甲') && withFb.includes('第二条被拒绝的样例内容字符串乙'));
  ok('reject reason is injected when present', withFb.includes('（length）'));
  ok('approve records are NOT injected', !withFb.includes('被批准的不该出现'));
  ok('prompt marker still present after feedback section', withFb.includes('PROMPT_MARKER'));
  ok('feedback section order: style → feedback → prompt', withFb.indexOf('最近被拒绝的内容') > -1 && withFb.indexOf('最近被拒绝的内容') < withFb.indexOf('PROMPT_MARKER'));

  writeFileSync(fbFile, JSON.stringify([]), 'utf8');
  const emptyFb = rejectedExamples('post', { file: fbFile });
  ok('empty feedback store degrades to empty string', emptyFb === '');

  rmSync(fbFile, { force: true });
  const missingFb = userContentFor(profile, 'post', 'PROMPT_MARKER', { file: fbFile });
  ok('missing feedback file does not throw and omits the section', !missingFb.includes('最近被拒绝的内容') && missingFb.includes('PROMPT_MARKER'));

  writeFileSync(fbFile, '{not valid json', 'utf8');
  const badFb = userContentFor(profile, 'post', 'PROMPT_MARKER', { file: fbFile });
  ok('unparsable feedback file does not throw and omits the section', !badFb.includes('最近被拒绝的内容') && badFb.includes('PROMPT_MARKER'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} passed`);
process.exit(failures.length ? 1 : 0);
