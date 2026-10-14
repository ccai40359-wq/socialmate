// Leadgen HTTP API for the desktop UI. Mounted from src/server.mjs `api()`.
// Read-only posture: collect spawns a background CLI run; status edits only
// touch queue/leads.json; contact fetch opens ONE profile page on demand —
// never a bulk crawl.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { appendLog } from './log.mjs';
import { loadLeads, patchLead } from './leadgen/store.mjs';
import { loadCollectStatus, setRunning } from './leadgen/status.mjs';

let collectChild = null;

function spawnCollect({ ROOT, CODE_ROOT }) {
  if (collectChild && collectChild.exitCode === null) return { ok: true, already: true, pid: collectChild.pid };
  const env = { ...process.env };
  let scriptArgs; let spawnCwd = ROOT;
  if (CODE_ROOT) {
    scriptArgs = [resolve(CODE_ROOT, 'src', 'cli.mjs'), 'leads', 'collect'];
    spawnCwd = ROOT;
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    scriptArgs = ['src/cli.mjs', 'leads', 'collect'];
  }
  const child = spawn(process.execPath, scriptArgs, { cwd: spawnCwd, env, detached: false, stdio: 'ignore' });
  collectChild = child;
  setRunning(true);
  child.on('error', (e) => { appendLog('server: leadgen collect spawn failed: ' + e.message); setRunning(false); });
  child.on('exit', (code) => { appendLog('server: leadgen collect exited code=' + code); collectChild = null; });
  appendLog('server: leadgen collect started pid=' + child.pid);
  return { ok: true, pid: child.pid };
}

export async function handleLeadsApi(req, res, url, ctx) {
  const { json, readBody, ROOT, CODE_ROOT } = ctx;
  const p = url.pathname;
  const cfg = ctx.cfg || {};

  if (req.method === 'GET' && p === '/api/leads') {
    const want = url.searchParams.get('status') || 'all';
    let leads = loadLeads();
    if (want !== 'all') leads = leads.filter((l) => (l.status || 'new') === want);
    leads.sort((a, b) => (b.demand || 0) - (a.demand || 0) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
    return json(res, 200, { ok: true, leads, count: leads.length });
  }

  if (req.method === 'POST' && p === '/api/leads/collect') {
    return json(res, 200, spawnCollect({ ROOT, CODE_ROOT }));
  }

  if (req.method === 'GET' && p === '/api/leads/collect/status') {
    const st = loadCollectStatus();
    const running = !!(collectChild && collectChild.exitCode === null) || !!st.running;
    return json(res, 200, { ok: true, running, last: st.last || null, updatedAt: st.updatedAt || null });
  }

  const statusMatch = p.match(/^\/api\/leads\/([^/]+)\/status$/);
  if ((req.method === 'POST' || req.method === 'PUT') && statusMatch) {
    const body = await readBody(req);
    const allowed = ['new', 'contacted', 'followup', 'skip', 'won'];
    if (!body || !allowed.includes(body.status)) return json(res, 400, { ok: false, error: 'status must be one of ' + allowed.join('|') });
    const lead = patchLead(statusMatch[1], { status: body.status, statusNote: body.note || undefined });
    return json(res, lead ? 200 : 404, lead ? { ok: true, lead } : { ok: false, error: 'lead not found' });
  }

  // On-demand single-profile contact extraction. Opens ONE profile page in the
  // real browser for a single lead and reads its bio. Deliberately not bulk:
  // this is the PDPO boundary the product agreed on.
  const contactMatch = p.match(/^\/api\/leads\/([^/]+)\/contact$/);
  if ((req.method === 'GET' || req.method === 'POST') && contactMatch) {
    const lead = loadLeads().find((l) => String(l.id) === String(contactMatch[1]));
    if (!lead) return json(res, 404, { ok: false, error: 'lead not found' });
    try {
      const { fetchLeadContacts } = await import('./leadgen/contact-fetch.mjs');
      const out = await fetchLeadContacts(lead, { cfg, ROOT });
      const updated = patchLead(lead.id, { contacts: out.contacts, contactsFetchedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, contacts: out.contacts, lead: updated });
    } catch (e) {
      appendLog('server: contact fetch failed: ' + e.message);
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  return null; // not a leadgen route
}


