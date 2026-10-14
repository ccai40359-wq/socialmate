// CLI: leadgen commands. Read-only collection + human outreach edits.
//   node src/cli.mjs leads                   查看线索队列
//   node src/cli.mjs leads collect [--once] [--dry-run] [--platforms=threads,fb,xhs]
//   node src/cli.mjs leads status            采集状态
//   node src/cli.mjs leads mark <id> <new|contacted|followup|skip|won>
// The synthetic [获取联系方式] action (contact fetch) is triggered from the UI
// API only, because it needs a live browser tab on demand.
import { loadLeads, patchLead } from './store.mjs';

export async function runLeadsCommand(cmd, args, ctx) {
  const { cfg } = ctx;
  if (cmd === 'leads') {
    const sub = args[0] || 'list';
    if (sub === 'collect') {
      const dry = args.includes('--dry-run');
      const { collectRun } = await import('./collect.mjs');
      const platArg = args.find((a) => a.startsWith('--platforms='));
      const platforms = platArg ? platArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const kwArg = args.find((a) => a.startsWith('--max-keywords='));
      const maxKeywords = kwArg ? Number(kwArg.split('=')[1]) : undefined;
      const report = await collectRun({ cfg, platforms, dryRun: dry, maxKeywords });
      console.log(JSON.stringify(report, null, 2));
      return report.platforms && Object.values(report.platforms).some((p) => p.error) ? 1 : 0;
    }
    if (sub === 'status') {
      // last collect report, if any, from queue/leadgen-status.json
      const { loadJson } = await import('../store.mjs');
      const last = loadJson('queue/leadgen-status.json', null);
      console.log(JSON.stringify(last || { ok: false, note: 'no collect has run yet' }, null, 2));
      return 0;
    }
    if (sub === 'mark') {
      const id = args[1];
      const status = args[2];
      if (!id || !status) { console.log('usage: leads mark <id> <new|contacted|followup|skip|won>'); return 2; }
      const lead = patchLead(id, { status });
      console.log(lead ? `lead ${id} -> ${status}` : `lead ${id} not found`);
      return lead ? 0 : 1;
    }
    // default: list
    const leads = loadLeads().sort((a, b) => (b.demand || 0) - (a.demand || 0));
    if (!leads.length) { console.log('(lead queue is empty — run: node src/cli.mjs leads collect)'); return 0; }
    for (const l of leads.slice(0, 40)) {
      console.log(`[${String(l.demand).padStart(3)}] ${l.platform} ${l.status} ${l.author || ''} :: ${String(l.text || '').replace(/\s+/g, ' ').slice(0, 70)}`);
      console.log(`      ${l.postUrl}`);
    }
    console.log(`(${leads.length} leads total)`);
    return 0;
  }
  return null;
}


