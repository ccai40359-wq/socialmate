// Packaged-boot verification (G5-3..G5-6 of the frozen checklist).
//
// Launches dist/win-unpacked/SocialMate.exe against an ISOLATED user-data
// directory (--user-data-dir), waits for the local control service on
// 4173, then proves the packaged app can:
//   1. boot without "App threw an error during load" / ENOENT chdir
//   2. seed a writable config.json on first launch (no 500 on /api/config)
//   3. persist an /api/config POST into the user-data directory
//   4. still report that value after a full restart (write went to userData,
//      not the read-only asar)
// Exits 0 only when every step passed. Prints the data root it used.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = resolve(ROOT, 'dist', 'win-unpacked', 'SocialMate.exe');
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_NAME = 'SocialMate.exe';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

function killOld() {
  try { spawnSync('taskkill', ['/IM', EXE_NAME, '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

function launch(dataDir) {
  const child = spawn(EXE, [`--user-data-dir=${dataDir}`], {
    cwd: dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  child.stdout.on('data', () => {});
  child.errBuf = err;
  return child;
}

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/');
      if (r.status === 200) return true;
      lastErr = `HTTP ${r.status}`;
    } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, err: lastErr };
}

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, json: await r.json().catch(() => null) };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// Isolated data root under the user's temp dir.
const dataDir = join(tmpdir(), `socialmate-verify-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
console.log('userData (verification):', dataDir);

let child1 = null;
let child2 = null;
try {
  if (!existsSync(EXE)) throw new Error(`missing ${EXE}`);
  killOld();

  // --- first boot --------------------------------------------------------
  child1 = launch(dataDir);
  const ready1 = await waitForReady();
  check('cold boot: 4173/ returns 200', ready1 === true, ready1 === true ? '' : ready1.err);

  const cfg1 = await get('/api/config');
  check('cold boot: /api/config returns 200+ok', cfg1.status === 200 && cfg1.json?.ok === true, `status=${cfg1.status}`);

  const cfgFile = join(dataDir, 'config.json');
  check('first launch seeds writable config.json in userData', existsSync(cfgFile), cfgFile);

  // Probe a dailyTarget value that is guaranteed to differ from the seeded one
  // AND stays inside the server's accepted range (1-200). The old +1 probe
  // broke whenever the seeded config sat at the 200 cap: the server correctly
  // answered 400 and the check misread that as a persistence failure.
  const before = cfg1.json?.config?.dailyTarget;
  const base = Number.isFinite(before) ? before : 40;
  const target = base >= 200 ? base - 1 : base + 1;
  const postRes = await post('/api/config', { dailyTarget: target });
  check('POST /api/config persists dailyTarget', postRes.status === 200 && postRes.json?.ok === true, `status=${postRes.status}`);

  const cfgAfter = await get('/api/config');
  check('GET /api/config reflects the change', cfgAfter.json?.config?.dailyTarget === target, `got=${cfgAfter.json?.config?.dailyTarget}`);

  const onDisk = (() => {
    try { return JSON.parse(readFileSync(cfgFile, 'utf8')).dailyTarget; } catch { return undefined; }
  })();
  check('config.json in userData holds the value', onDisk === target, `disk=${onDisk} target=${target}`);

  const errText = child1.errBuf || '';
  check('no "App threw an error during load"', !/App threw an error during load/.test(errText));
  check('no ENOENT chdir', !/ENOENT[\s\S]*chdir|chdir[\s\S]*ENOENT/i.test(errText));

  // --- restart: the write must survive --------------------------------
  spawnSync('taskkill', ['/PID', String(child1.pid), '/T', '/F'], { stdio: 'ignore' });
  child1.kill();
  await new Promise((r) => setTimeout(r, 1500));

  child2 = launch(dataDir);
  const ready2 = await waitForReady();
  check('restart: 4173/ returns 200', ready2 === true, ready2 === true ? '' : ready2.err);
  const cfgRestart = await get('/api/config');
  check('restart: dailyTarget persisted', cfgRestart.json?.config?.dailyTarget === target, `got=${cfgRestart.json?.config?.dailyTarget} target=${target}`);
} catch (e) {
  check('script completed without exception', false, e.message);
} finally {
  try { if (child1?.pid) spawnSync('taskkill', ['/PID', String(child1.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { if (child2?.pid) spawnSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { killOld(); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} packaged-boot checks passed`);
process.exitCode = failed.length ? 1 : 0;
