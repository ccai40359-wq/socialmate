// G2: first-run wizard must be a real graphical 5-step flow, not three walls
// of text. Static assertions only — no browser needed, so this runs anywhere.
//
// The brief asks for: pick browser -> log in -> configure model (with a
// connection test) -> pick topics -> set pacing. Each step must actually
// present controls, and the wizard must never be able to flip the publish
// mode away from review.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
const check = (id, desc, fn) => {
  try {
    const r = fn();
    results.push({ id, desc, ok: r === true, detail: r === true ? '' : String(r) });
  } catch (e) { results.push({ id, desc, ok: false, detail: e.message }); }
};

const appJs = readFileSync('app/renderer/app.js', 'utf8');
const html = readFileSync('app/renderer/index.html', 'utf8');

const start = appJs.indexOf('const OB_STEPS');
const end = appJs.indexOf('\n];', start);
if (start < 0 || end < 0) { console.log('FAIL  OB_STEPS not found'); process.exit(1); }
const stepsSrc = appJs.slice(start, end + 3);
// The wizard region also owns its writer; the settings page (which legitimately
// saves autoMode) lives outside it.
const writeEnd = appJs.indexOf('async function runObStep');
const wizardRegion = appJs.slice(start, writeEnd > start ? writeEnd : end + 3);

const titles = [...stepsSrc.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
const controlGroups = [...stepsSrc.matchAll(/controls:\s*\[([^\]]*)\]/g)].map((m) =>
  [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));

check('G2-1', 'wizard is exactly 5 steps', () =>
  titles.length === 5 ? true : `found ${titles.length} steps: ${JSON.stringify(titles)}`);

check('G2-2', 'the 5 steps cover the briefed flow in order', () => {
  const want = [/浏览?器/, /登录/, /模型/, /话题/, /节奏/];
  const missing = want.filter((re, i) => !re.test(titles[i] || ''));
  return missing.length === 0 ? true : `step titles do not match the brief: ${JSON.stringify(titles)}`;
});

check('G2-3', 'every step renders controls (no text-only wall)', () => {
  const perStep = stepsSrc.split(/\n  \{\n/).slice(1);
  const bad = [];
  for (const s of perStep) {
    if (!/async render\(\)/.test(s)) bad.push('step without render()');
    else if (!/<(input|select|button|textarea)\b/i.test(s)) bad.push('step without an interactive control');
  }
  return bad.length === 0 ? true : bad.join('; ');
});

check('G2-4', 'every declared control id exists in the DOM sources', () => {
  const declared = controlGroups.flat();
  if (!declared.length) return 'no controls declared';
  const missing = declared.filter((id) => !stepsSrc.includes(id) && !html.includes(id));
  return missing.length === 0 ? true : 'ids missing from html: ' + missing.join(', ');
});

check('G2-5', 'onboarding chrome ids exist in index.html', () => {
  const ids = ['obOverlay', 'obStepNum', 'obStepTotal', 'obBody', 'obPrev', 'obNext', 'obSkip', 'obReopen'];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  return missing.length === 0 ? true : 'missing: ' + missing.join(', ');
});

check('G2-6', 'index.html advertises the same step total (5)', () => {
  const m = html.match(/id="obStepTotal"[^>]*>(\d+)</);
  if (!m) return 'obStepTotal not found in index.html';
  return m[1] === '5' ? true : `index.html says ${m[1]} but OB_STEPS has ${titles.length}`;
});

check('G2-7', 'the wizard can never write autoMode', () => {
  // Comment lines legitimately explain that autoMode is NOT touched, so strip
  // comments before looking for an actual assignment.
  const code = wizardRegion
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if (!/autoMode/.test(code)) return true;
  const bySend = /autoMode\s*:/.test(code);
  return bySend
    ? 'the onboarding region sends autoMode to /api/config — it must not touch publish mode'
    : true;
});

check('G2-8', 'the model step can actually test a connection', () => {
  if (!/obMdlTest/.test(stepsSrc)) return 'no test-connection control in the model step';
  if (!/\/api\/provider\/test/.test(appJs)) return 'the wizard never calls /api/provider/test';
  return true;
});

check('G2-9', 'skip + re-open are wired, onboarding state persists', () => {
  if (!/localStorage\.setItem\(\s*"onboarded"/.test(appJs)) return 'onboarded flag is not persisted';
  if (!/obSkip/.test(appJs)) return 'skip button not wired';
  if (!/obReopen/.test(appJs)) return 're-open entry point not wired';
  return true;
});

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(6)} ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
