// Daemon lifecycle: the dashboard's primary CTA must actually spawn and kill
// a real process, not just flip a flag.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const PORT = 4177;
const BASE = `http://127.0.0.1:${PORT}`;

const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });

const post = async (p) => (await fetch(BASE + p, { method: 'POST' })).json();
const get = async (p) => (await fetch(BASE + p)).json();

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

const before = await get('/api/status');
check('daemon reports stopped initially', before.daemon.running === false);

const started = await post('/api/daemon/start');
check('start returns a pid', !!started.pid, 'pid=' + started.pid);
check('pid file written', existsSync(resolve('run.pid')) && Number(readFileSync(resolve('run.pid'), 'utf8').trim()) === started.pid);

await new Promise((r) => setTimeout(r, 3000));
const during = await get('/api/status');
check('status shows running while alive', during.daemon.running === true);

const restarted = await post('/api/daemon/start');
check('second start is idempotent', restarted.already === true);

const stopped = await post('/api/daemon/stop');
check('stop reports success', stopped.ok === true);
await new Promise((r) => setTimeout(r, 2500));
check('process is really gone', !alive(started.pid), 'pid=' + started.pid);
const after = await get('/api/status');
check('status shows stopped after stop', after.daemon.running === false);

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
