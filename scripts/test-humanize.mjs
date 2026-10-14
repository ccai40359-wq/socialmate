// Humanization checks. typeHuman/thinkPause are timing-driven and need a page,
// so they run against a minimal mock rather than a browser: the contract that
// matters is "types character by character, in order, with randomised delay".
import { typeHuman, thinkPause, pickTimingProfile } from '../src/humanize.mjs';

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

// --- pickTimingProfile ---------------------------------------------------
const def = pickTimingProfile({});
check('pickTimingProfile returns the documented defaults',
  def.charDelayMin === 30 && def.charDelayMax === 100 && def.pauseMin === 2000 && def.pauseMax === 5000 && def.warmupScrollsMin === 3 && def.warmupScrollsMax === 5,
  JSON.stringify(def));

const custom = pickTimingProfile({ humanize: { charDelayMin: 10, charDelayMax: 20 } });
check('config overrides win over defaults',
  custom.charDelayMin === 10 && custom.charDelayMax === 20 && custom.pauseMin === 2000 && custom.warmupScrollsMin === 3,
  JSON.stringify(custom));

// --- typeHuman against a mock page/locator -------------------------------
const typed = [];
let clicked = 0;
const locator = { async click() { clicked++; } };
const page = {
  keyboard: { async type(ch) { typed.push(ch); } },
  async waitForTimeout() {},
  async mouse() {},
};

const text = '兄弟们 AI 真香';
const t0 = Date.now();
let err = null;
try { await typeHuman(page, locator, text, { cfg: { humanize: { charDelayMin: 8, charDelayMax: 16 } } }); }
catch (e) { err = e.message; }
const elapsed = Date.now() - t0;

check('typeHuman runs without throwing', !err, err || '');
check('typeHuman clicks the target first', clicked === 1, `clicks=${clicked}`);
check('every character is typed, in order',
  typed.join('') === text, `got=${JSON.stringify(typed.join(''))}`);
check('typing is not instantaneous (delays actually applied)',
  elapsed > text.length * 6, `elapsed=${elapsed}ms for ${text.length} chars`);

// --- thinkPause actually waits -------------------------------------------
const w0 = Date.now();
await thinkPause(page, { cfg: { humanize: { pauseMin: 80, pauseMax: 120 } } });
const waited = Date.now() - w0;
check('thinkPause waits within the configured 80-120ms window', waited >= 70 && waited <= 400, `waited ${waited}ms`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
