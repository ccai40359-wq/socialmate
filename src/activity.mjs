// Activity translation: turn the raw run log into plain-language "what did it
// just do" for people who are not developers. Pure and dependency-free so the
// wording can be asserted directly in tests instead of eyeballed in a browser.
//
// Two consumers:
//   - summarize(lines)    -> the scrolling activity feed on the dashboard
//   - describeNow(status) -> the single "它在做什么" line at the top
//
// Any line this module does not recognise is reported with title === null and
// is dropped from the beginner feed. Nothing is lost: the raw log is still
// served by GET /api/logs and shown in the 技术日志 card.

const KIND_LABEL = {
  post: '原创帖',
  quote: '引用',
  muse: '扯淡',
  reply: '回复评论区',
  othersReply: '别人评论区互动',
  like: '点赞',
};

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || '内容';
}

function splitTs(line) {
  const m = /^\[(\d{2}:\d{2}:\d{2})\]\s*([\s\S]*)$/.exec(String(line || ''));
  return m ? { ts: m[1], body: m[2].trim() } : { ts: '', body: String(line || '').trim() };
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function featureLabel(key) {
  const L = {
    post: '原创帖', quote: '引用', muse: '扯淡', reply: '回复评论区',
    like: '点赞', browse: '自动刷帖', othersReply: '别人评论区互动',
  };
  return L[key] || key;
}

// Sentinel: a rule matched but this line is developer noise, not an action.
const HIDE = Symbol('hide');

// Ordered most-specific-first. Each rule turns one log line into one sentence a
// non-developer can act on. A rule's `plain` returns a string, or HIDE to say
// "matched on purpose, keep it out of the beginner feed".
const RULES = [
  // ---- safety: before the generic action rules, or they would be swallowed ----
  { re: /^BLOCKED:\s*(.+?)[.;]?\s*Pausing globally/i, category: 'block', level: 'err',
    plain: (m) => `检测到异常（${clip(m[1], 60)}），已自动停手，不会再重试。` },
  { re: /^Blocked during action:\s*(.+?)[.;]?\s*Pausing globally/i, category: 'block', level: 'err',
    plain: (m) => `操作被安全闸门拦下（${clip(m[1], 60)}），已自动停手。` },
  { re: /^xbot:\s*blocked\s*\((.+)\)/i, category: 'block', level: 'err',
    plain: (m) => `发布前被安全闸门拦下（${clip(m[1], 60)}）。` },
  { re: /^BLOCKED screenshot/i, category: 'block', level: 'err', plain: () => HIDE },

  // ---- publishing (only in 全自动, or right after you approve) ----
  { re: /^POST ok ::\s*([\s\S]+)$/i, category: 'publish', level: 'pub', kind: 'post',
    plain: (m) => `已发出一条原创帖：${clip(m[1], 70)}` },
  { re: /^QUOTE ok ::\s*(\S+)\s*::\s*([\s\S]+)$/i, category: 'publish', level: 'pub', kind: 'quote',
    plain: (m) => `已引用别人的帖子并评论：${clip(m[2], 60)}` },
  { re: /^REPLY ok ::\s*(\S+)\s*::\s*([\s\S]+)$/i, category: 'publish', level: 'pub', kind: 'reply',
    plain: (m) => `已在别人帖子下回复：${clip(m[2], 60)}` },

  // ---- drafts waiting for your review ----
  { re: /^DRAFT post #(\d+) queued ::\s*([\s\S]+)$/i, category: 'draft', level: 'draft',
    plain: (m) => `写好一条原创帖，放进「队列」等你审核：${clip(m[2], 60)}` },
  { re: /^DRAFT #(\d+) \[(\w+)\][^:]*::\s*([\s\S]+)$/i, category: 'draft', level: 'draft',
    plain: (m) => `写好一条${kindLabel(m[2])}，放进「队列」等你审核：${clip(m[3], 60)}` },
  { re: /^DRAFT (quote|muse|post) #(\d+)[^:]*:\s*([\s\S]+)$/i, category: 'draft', level: 'draft',
    plain: (m) => `写好一条${kindLabel(m[1])}，等你审核：${clip(m[3], 60)}` },
  { re: /^DRAFT reply #(\d+) to (@\S+)/i, category: 'draft', level: 'draft',
    plain: (m) => `写好一条回复给 ${m[2]}，等你审核。` },
  { re: /^DRAFT (\w+) #(\d+) ->\s*(@\S+)[^:]*:\s*([\s\S]+)$/i, category: 'draft', level: 'draft',
    plain: (m) => `写好一条${kindLabel(m[1])}，对象 ${m[3]}，等你审核：${clip(m[4], 55)}` },
  { re: /^DRYRUN /i, category: 'draft', level: 'info',
    plain: () => '试跑了一轮（不会真的发布，也没留在队列里）。' },

  // ---- likes ----
  { re: /^(?:browse )?LIKE ok ::\s*(\S+)/i, category: 'like', level: 'ok',
    plain: () => '给一条时间线上的帖子点了赞。' },
  { re: /^LIKE skip ::\s*button not found/i, category: 'like', level: 'info', plain: () => HIDE },

  // ---- browsing ----
  { re: /^browse round: browsed (\d+) tweets, liked (\d+)\/(\d+)/i, category: 'browse', level: 'ok',
    plain: (m) => `刷了 ${m[1]} 条时间线，点了 ${m[2]} 个赞。` },
  { re: /^browse round: skipped/i, category: 'browse', level: 'info',
    plain: () => '这轮刷帖跳过了（今天刷帖次数已用完）。' },

  // ---- the pool like round ----
  { re: /^engage round: liked (\d+)\/(\d+) \(fresh (\d+)\)/i, category: 'like', level: 'ok',
    plain: (m) => `点赞完成：点了 ${m[1]} 个，候选 ${m[3]} 条。` },
  { re: /^engage round: skipped/i, category: 'like', level: 'info', plain: () => HIDE },

  // ---- replies to your own post / other people's threads ----
  { re: /^Replies:? found:? (\d+), new:? (\d+)/i, category: 'reply', level: 'info',
    plain: (m) => `检查自己的评论区：发现 ${m[1]} 条，新增 ${m[2]} 条待处理。` },
  { re: /^Reply round: (\d+) handled/i, category: 'reply', level: 'ok',
    plain: (m) => `处理了 ${m[1]} 条评论。` },
  { re: /^othersReply round: acted (\d+)\/(\d+) \(candidates (\d+)\)/i, category: 'reply', level: 'ok',
    plain: (m) => `在别人评论区互动：处理 ${m[1]} 条，候选 ${m[3]} 条。` },

  // ---- collection (reading only, never publishing) ----
  { re: /^collect: \+(\d+) new, pool=(\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `收集新素材 ${m[1]} 条，素材库现有 ${m[2]} 条。` },
  { re: /^Collect round: \+(\d+) \(pool (\d+)\)/i, category: 'collect', level: 'info',
    plain: (m) => `这一轮收集了 ${m[1]} 条新素材（素材库 ${m[2]} 条）。` },
  { re: /^perceive\/aihot: (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `从 AIHOT 读到 ${m[1]} 条 AI 热点。` },
  { re: /^perceive\/trends: (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `从 X 趋势读到 ${m[1]} 条。` },
  { re: /^perceive\/search: (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `关键词搜索到 ${m[1]} 条。` },
  { re: /^perceive\/timeline: (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `从你的首页/互关时间线读到 ${m[1]} 条。` },
  { re: /^perceive\/rss: (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `从 RSS 读到 ${m[1]} 条。` },
  { re: /^timeline (x-[\w-]+): (\d+)/i, category: 'collect', level: 'info',
    plain: (m) => `从${m[1] === 'x-following' ? '你关注的人' : '你的首页'}时间线读到 ${m[2]} 条。` },
  { re: /^perceive: (\d+) candidates$/i, category: 'collect', level: 'info',
    plain: (m) => `这一轮共整理出 ${m[1]} 条候选素材。` },
  { re: /^perceive: (\d+) after dedupe/i, category: 'collect', level: 'info',
    plain: (m) => `去重和筛选后，留下 ${m[1]} 条可用素材。` },
  { re: /^perceive: DEGRADED/i, category: 'collect', level: 'warn',
    plain: () => '素材筛选降级了，这一轮保留原始素材，没有清空素材库。' },
  { re: /^perceive\/(aihot|trends|search|timeline|rss) failed/i, category: 'collect', level: 'warn',
    plain: (m) => `有一路素材没抓到（${m[1]}），其它来源不受影响。` },
  { re: /^perceive\//i, category: 'collect', level: 'info', plain: () => HIDE },

  // ---- every sentence you can actually act on ----
  { re: /^Picked \(score/i, category: 'plan', level: 'info',
    plain: () => '挑好了一个选题，准备写内容。' },
  { re: /^Gate rejected \((.+?)\)/i, category: 'check', level: 'warn',
    plain: (m) => `有一条内容没过安全检查（${clip(m[1], 40)}），已跳过没有发布。` },
  { re: /^quote rejected: hollow quote/i, category: 'check', level: 'info',
    plain: () => '这条引用评论与原帖没有实质关系，判定为空洞引用，已改成原创帖。' },
  { re: /^quote rejected: author already quoted today \((@\S+)\)/i, category: 'check', level: 'info',
    plain: (m) => `今天已经引用过 ${m[1]}，为避免刷屏改成原创帖。` },
  { re: /^quote target is growth lane/i, category: 'check', level: 'info',
    plain: () => '这条是互关/涨粉帖，按车道规则不能引用，已改成原创帖。' },
  { re: /^quote target (?:check failed|unavailable)/i, category: 'check', level: 'info',
    plain: () => '原帖打不开了，这条引用已改成原创帖。' },
  { re: /^muse: voice unavailable/i, category: 'check', level: 'info',
    plain: () => '语气模型暂时不可用，这条改为原创帖。' },
  { re: /^planner: DEGRADED/i, category: 'check', level: 'warn',
    plain: () => '语气模型暂时不可用，这次用了模板兜底。' },
  { re: /^othersReply hollow quote rejected/i, category: 'check', level: 'info',
    plain: () => '一条评论区互动与原帖无关，已放弃发送。' },
  { re: /^(?:othersReply|reply) gate rejected \((.+?)\)/i, category: 'check', level: 'info',
    plain: (m) => `一条互动没过安全检查（${clip(m[1], 40)}），已跳过。` },

  // ---- skipped because a feature lane is switched off ----
  { re: /(.+) skipped: features\.(\w+)=false/i, category: 'skip', level: 'info',
    plain: (m) => `「${featureLabel(m[2])}」功能是关闭的，这条线整轮跳过。` },
  { re: /^content round skipped: all content features disabled/i, category: 'skip', level: 'info',
    plain: () => '原创/引用/扯淡都关着，这一轮不产出内容。' },
  { re: /^skip: post lane disabled/i, category: 'skip', level: 'info',
    plain: () => '原创帖功能关着，这条降级路径也跳过。' },
  { re: /^no candidates$/i, category: 'skip', level: 'info',
    plain: () => '素材库为空，先去收集素材。' },
  { re: /^no fresh candidate/i, category: 'skip', level: 'info',
    plain: () => '这轮没有合适的选题，等下一轮。' },
  { re: /^content round: candidate pool empty/i, category: 'skip', level: 'info',
    plain: () => '素材库为空，暂时改用 AIHOT 缓存。' },

  // ---- scheduling / lifecycle ----
  { re: /^Round (\w+)\.\s*(\d+)\/(\d+) today\.\s*Next at :(\d+)/i, category: 'schedule', level: 'info',
    plain: (m) => `本轮结束（今天 ${m[2]}/${m[3]}），下一次动作大约在 :${String(m[4]).padStart(2, '0')} 分。` },
  { re: /^Daily target consumed \((\d+)\)/i, category: 'schedule', level: 'warn',
    plain: (m) => `今天的量已经发满了（${m[1]} 条），先休息。` },
  { re: /^SocialMate up\. account=(.+?) mode=(\w+) publish=(\w+)/i, category: 'start', level: 'ok',
    plain: (m) => `已启动：账号 ${clip(m[1], 40)}，模式 ${m[2] === 'auto' ? '全自动' : '审核'}${m[3] === 'true' ? '（会直接发布）' : '（只写草稿，等你审核）'}。` },
  { re: /^SocialMate up\./i, category: 'start', level: 'ok',
    plain: () => '已启动。' },
  { re: /^Signed in as:\s*([^|]+)\|/i, category: 'start', level: 'ok',
    plain: (m) => `已登录：${clip(m[1], 40)}。` },
  { re: /^Launching isolated Edge/i, category: 'start', level: 'info',
    plain: () => '正在启动一个独立的 Edge 窗口来操作。' },
  { re: /^Daemon start\./i, category: 'start', level: 'ok',
    plain: () => '守护进程开始工作。' },
  { re: /^publish gate: review/i, category: 'start', level: 'info',
    plain: () => '审核模式：每条内容都先进队列，等你点「发布」才真的发出去。' },
  { re: /^server: listening on/i, category: 'start', level: 'info',
    plain: () => '本地控制服务已启动。' },
  { re: /^server: daemon started pid=(\d+)(.*)$/i, category: 'start', level: 'ok',
    plain: (m) => `守护进程已启动${/publish=--publish/.test(m[2]) ? '（全自动，会直接发布）' : '（只写草稿）'}。` },
  { re: /^server: daemon stopped pid=(\d+)/i, category: 'stop', level: 'info',
    plain: () => '守护进程已停止。' },
  { re: /^--once\b/i, category: 'schedule', level: 'info', plain: () => HIDE },
  { re: /^Round OK \(/i, category: 'schedule', level: 'info', plain: () => HIDE },

  // ---- account / capability notes ----
  { re: /^account: live read failed/i, category: 'info', level: 'info',
    plain: () => 'Edge 暂时读不到账号，先用上缓存显示。' },
  { re: /^avatar: live read failed/i, category: 'info', level: 'info', plain: () => HIDE },

  // ---- errors ----
  { re: /^Action failed:\s*(.+)$/i, category: 'error', level: 'err',
    plain: (m) => `这一步失败了：${clip(m[1], 70)}` },
  { re: /^FATAL:\s*(.+)$/i, category: 'error', level: 'err',
    plain: (m) => `程序遇到严重错误已退出：${clip(m[1], 70)}` },
  { re: /^llm: DEGRADED/i, category: 'error', level: 'warn',
    plain: () => '模型这次没返回可用结果，已按降级方案处理。' },
  { re: /^llm: model substitution detected/i, category: 'error', level: 'warn',
    plain: () => '服务端换用了另一个模型，已记录。' },
  { re: /^llm: truncated/i, category: 'info', level: 'info', plain: () => HIDE },
  { re: /failed:|\bfailed\b/i, category: 'error', level: 'warn',
    plain: (m, body) => `有一步出错但不影响继续：${clip(body, 70)}` },

  { re: /^Round (\w+)\.\s*Today (\d+)\/(\d+)\.\s*Next ~?(\d+)/i, category: 'schedule', level: 'info',
    plain: (m) => `本轮结束（今天 ${m[2]}/${m[3]}），下一次大约 ${m[4]} 分钟后。` },
  { re: /^perceive: (\d+) candidates after dedupe/i, category: 'collect', level: 'info',
    plain: (m) => `去重后还剩 ${m[1]} 条候选素材。` },
  { re: /^llm: empty content/i, category: 'error', level: 'warn',
    plain: () => '模型返回了空内容，正在加大长度重试。' },
  { re: /^BLOCKED during \w+/i, category: 'block', level: 'err',
    plain: () => '操作途中被安全闸门拦下，已停手不再重试。' },
  // ---- developer noise: matched on purpose so it never reaches the feed ----
  { re: /^humanize:|^xbot: humanize\.typeHuman failed/i, category: 'info', level: 'info', plain: () => HIDE },
  { re: /^detectBlock error/i, category: 'info', level: 'info', plain: () => HIDE },
  { re: /^Timeline navigation|^optional module not ready|^pool refresh skip/i, category: 'info', level: 'info', plain: () => HIDE },
];

export function classifyLine(line) {
  const { ts, body } = splitTs(line);
  if (!body) return null;
  for (const r of RULES) {
    const m = r.re.exec(body);
    if (!m) continue;
    let title = null;
    try { title = r.plain ? r.plain(m, body) : null; } catch { title = null; }
    if (title === HIDE) return { ts, category: r.category, level: 'hide', title: null, raw: body };
    return { ts, category: r.category, level: r.level || 'info', title, raw: body, kind: r.kind || null };
  }
  return { ts, category: 'other', level: 'hide', title: null, raw: body };
}

// Newest first, developer noise dropped.
export function summarize(lines) {
  const out = [];
  for (const l of lines || []) {
    const it = classifyLine(l);
    if (it && it.title) out.push(it);
  }
  return out.reverse();
}

function hhmm(ms) {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// One sentence for "现在在做什么". Uses only fields the control server already
// publishes, so it cannot disagree with the rest of the dashboard.
export function describeNow(status, nowMs = Date.now()) {
  if (!status || status.ok === false) {
    return { level: 'warn', title: '读不到运行状态', detail: '请确认程序已经启动（用 npm run app 打开它会自动拉起后台）。' };
  }
  const running = !!status.daemon?.running;
  const t = status.today || {};
  const target = status.dailyTarget || 20;
  const progress = `今天已产出 ${t.units || 0}/${target}`;

  if (!running) {
    return { level: 'idle', title: '现在没有在干活', detail: '点下面的「启动守护进程」，它才会开始按你的设置工作。' };
  }
  if (status.paused) {
    return { level: 'warn', title: '已暂停', detail: '暂停期间它不会做任何事，点右上角「继续」才会恢复。' };
  }
  const nextAt = status.nextAllowedAt || 0;
  if (nextAt > nowMs) {
    return { level: 'ok', title: '在等下一个时间点', detail: `${progress}；下一次大约 ${hhmm(nextAt)} 才有动作。` };
  }
  const pend = status.drafts?.pending || 0;
  // T6/CON-5: only when stats.json exists do we quote real numbers; missing
  // stats fall back to the original wording (never invented).
  const st = status.stats && (Number(status.stats.read) > 0 || Number(status.stats.kept) > 0);
  const tail = st
    ? '刚看了 ' + status.stats.read + ' 条素材，留下 ' + status.stats.kept + ' 条' + (pend ? '；队列里有 ' + pend + ' 条等你审核。' : '。')
    : (pend ? '队列里有 ' + pend + ' 条等你审核。' : '正在挑选题、写内容。');
  return { level: 'ok', title: '正在干活', detail: progress + '；' + tail };
}
