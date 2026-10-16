// SocialMate renderer. Plain ES modules-free JS: no build step, offline-capable.
// All state comes from the local control server on 127.0.0.1.
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
  if (!res.ok && data && !data.error) data.error = `HTTP ${res.status}`;
  return data;
};

const PAGES = { dashboard: '仪表盘', queue: '队列', model: '模型', settings: '设置' };
let currentPage = 'dashboard';
let statusCache = null;
let logTimer = null;
let editingId = null;
let confirmHandler = null;

// ---------- feedback ----------
function toast(title, body, kind = 'ok', sticky = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  el.innerHTML = `<span class="tt"></span><span class="tb"></span>`;
  el.querySelector('.tt').textContent = title;
  if (body) el.querySelector('.tb').textContent = body;
  el.addEventListener('click', () => el.remove());
  $('toasts').appendChild(el);
  if (!sticky) setTimeout(() => el.remove(), 2500);
  return el;
}

// Gate reasons are compact codes; the review queue is the main flow, so turn
// them into something a human can act on.
function explainGate(reason) {
  const m = /^gate:\s*(.*)$/.exec(reason || '');
  const body = m ? m[1] : (reason || '');
  const parts = body.split(',').filter(Boolean).map((r) => {
    if (r.startsWith('too-long')) return `太长（加权 ${r.split(':')[1]}，上限 280）`;
    if (r.startsWith('too-short')) return '太短';
    if (r.startsWith('duplicate')) return `与已发内容重复（相似度 ${r.split(':')[1]}）`;
    if (r.startsWith('content:')) return `触发安全过滤（${r.slice(8)}）`;
    if (r.startsWith('link-ratio')) return '带链接比例过高';
    return r;
  });
  return '无法发布：' + parts.join('；');
}

// Drop reasons come from the perceive stage as compact codes; turn them into
// plain Chinese so the dashboard reads like a person wrote it.
function explainDropReason(reason) {
  const r = String(reason == null ? '' : reason);
  if (r.startsWith('lang:')) return '不是中文/英文';
  if (r.startsWith('likes:')) {
    const rest = r.slice('likes:'.length);
    const m = /^(\d+)<(\d+)/.exec(rest);
    if (m) return '只有 ' + m[1] + ' 个赞（不到 ' + m[2] + ' 赞）';
    const n = /^(\d+)/.exec(rest);
    if (n) return '只有 ' + n[1] + ' 个赞';
    return '点赞太少';
  }
  if (r === 'irrelevant') return '和 AI 话题无关';
  if (r === 'duplicate') return '和别人重复了';
  if (r === 'unknown' || r === 'other') return '其它原因';
  return '其它原因';
}

// Source keys are internal names; give each one a human label.
function sourceLabel(key) {
  const labels = { aihot: 'AIHOT 热点', 'x-trend': 'X 趋势', 'x-search': 'X 关键词搜索', 'x-home': '你的首页时间线', 'x-following': '你关注的人', rss: 'RSS 订阅' };
  return labels[key] || key;
}

// Round kinds in the timeline are terse codes; humanize them.
function roundKindLabel(kind) {
  if (kind === 'collect') return '采集素材';
  if (kind === 'browse') return '刷帖子';
  return kind;
}

function showError(msg, retry) {
  $('errorText').textContent = msg;
  $('errorBand').hidden = false;
  confirmHandler = retry || null;
  $('errorRetry').hidden = !retry;
}

// ---------- modal ----------
function confirmAction({ title, body, ok = '确认', danger = true, onOk, reasons = null }) {
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  const okBtn = $('modalOk');
  okBtn.textContent = ok;
  okBtn.className = 'btn ' + (danger ? 'danger' : '');
  // Optional reason picker. Not picking one is a valid choice: it must never
  // block the primary action, only enrich the captured feedback.
  const wrap = $('modalReasonWrap'), sel = $('modalReason');
  if (reasons && reasons.length) {
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = '（不选）';
    sel.appendChild(none);
    for (const r of reasons) {
      const o = document.createElement('option');
      o.value = r.value; o.textContent = r.label;
      sel.appendChild(o);
    }
    sel.value = '';
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
  $('modal').hidden = false;
  confirmHandler = onOk;
}
function closeModal() { $('modal').hidden = true; confirmHandler = null; }

$('modalCancel').addEventListener('click', closeModal);
$('modalOk').addEventListener('click', async () => {
  const fn = confirmHandler;
  const reason = $('modalReasonWrap').hidden ? undefined : ($('modalReason').value || undefined);
  closeModal();
  if (fn) await fn(reason);
});
$('errorClose').addEventListener('click', () => { $('errorBand').hidden = true; });
$('errorRetry').addEventListener('click', async () => {
  const fn = confirmHandler;
  $('errorBand').hidden = true;
  if (fn) await fn();
});

// ---------- navigation ----------
function go(page) {
  currentPage = page;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('is-active', b.dataset.page === page);
  for (const p of document.querySelectorAll('.page')) p.hidden = p.id !== 'page-' + page;
  $('pageTitle').textContent = PAGES[page];
  if (page === 'queue') loadDrafts();
  if (page === 'model') loadProvider();
  if (page === 'settings') loadConfig();
  if (page === 'dashboard') refreshStatus();
}
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b) go(b.dataset.page);
});

// ---------- dashboard ----------
function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

async function refreshStatus() {
  const s = await api('/api/status');
  if (!s || !s.ok) { showError('无法读取运行状态：' + (s?.error || '未知错误'), refreshStatus); return; }
  statusCache = s;
  $('errorBand').hidden = true;

  setText('acctName', (s.account || '').split(' @')[0] || '未识别');
  setText('acctHandle', '@' + ((s.account || '').split(' @')[1] || ''));
  setAvatar((s.account || 'S').trim()[0] || 'S');
  loadAvatar();

  const t = s.today || {};
  const target = s.dailyTarget || 20;
  setText('stPosts', t.postsPublished ?? '—');
  setText('stQuotes', t.quotesPublished ?? '—');
  setText('stReplies', t.repliesPublished ?? '—');
  setText('stFollows', t.followsPublished ?? '—');
  // Two different things used to share one number: follow-backs are PEOPLE we
  // followed back, not comment-section posts. Show both, each honestly.
  const backCount = t.followBacksPublished || 0;
  setText('stFollowsSub', '今天新关注的蓝V（≤ 1 万粉丝），另回关 ' + backCount + ' 人');
  setText('stOthers', t.othersRepliesPublished || 0);
  setText('stOthersSub', '今天去别人评论区留言');
  const pend = s.drafts?.pending ?? 0;
  setText('stDrafts', pend);
  setText('stPostsSub', `目标 ${target}`);
  setText('stQuotesSub', `引用占比 ${Math.round((statusCache.quoteRatio ?? 0.4) * 100)}%`);
  setText('stRepliesSub', '自动回复评论区');
  setText('stDraftsSub', pend ? '等待你的审核' : '没有待审内容');
  $('stDrafts').classList.toggle('over', pend > 10);

  const units = t.units ?? 0;
  $('navQueueBadge').hidden = !pend;
  $('navQueueBadge').textContent = pend;

  $('runDot').className = 'dot ' + (s.daemon?.running ? 'on' : 'off');
  setText('runText', s.daemon?.running ? `守护进程运行中` : '守护进程已停止');
  const nextAt = s.nextAllowedAt || 0;
  setText('nextAction', nextAt > Date.now() ? fmtTime(nextAt) + ' 后' : '待命');
  setText('progressText', `${units} / ${target}`);
  const fill = $('progressFill');
  fill.style.width = Math.min(100, (units / target) * 100) + '%';
  fill.classList.toggle('done', units >= target);

  setText('poolTotal', s.pool?.total ?? '—');
  setText('poolWithX', s.pool?.withXOriginal ?? '—');
  loadStats();

  const mode = s.mode || 'review';
  const chip = $('modeChip');
  chip.textContent = mode === 'auto' ? '全自动' : '审核';
  chip.classList.toggle('auto', mode === 'auto');

  const paused = !!s.paused;
  const btn = $('pauseBtn');
  btn.classList.toggle('is-paused', paused);
  btn.setAttribute('aria-pressed', String(paused));
  setText('pauseLabel', paused ? '已暂停' : '暂停');

  $('daemonPill').querySelector('.dot').className = 'dot ' + (s.daemon?.running ? 'on' : 'off');
  setText('daemonText', s.daemon?.running ? '运行中' : '已停止');

  if (currentPage === 'dashboard') { loadLogs(); loadActivity(); }
}

function setAvatar(initial) {
  const img = $("avatarImg");
  const fallback = $("avatarInitial");
  if (img) img.style.display = "none";
  if (fallback) { fallback.textContent = (initial || "S").toUpperCase(); fallback.style.display = ""; }
}

async function loadAvatar() {
  const r = await api("/api/avatar");
  const img = $("avatarImg");
  if (!img) return;
  const url = r && r.ok ? r.url : null;
  if (!url) { setAvatar((statusCache?.account || "S").trim()[0] || "S"); return; }
  img.onerror = () => setAvatar((statusCache?.account || "S").trim()[0] || "S");
  img.src = url;
  img.style.display = "block";
  $("avatarInitial").style.display = "none";
}

const OB_STEPS = [
  {
    title: "1 · 选择浏览器",
    controls: ["obBrowserEdge", "obBrowserChrome", "obBrowserFirefox"],
    html:
      '<label class="radio ob-browser-opt"><input type="radio" name="obBrowser" value="edge" id="obBrowserEdge" checked /><span><b>Edge（推荐）</b> — 用你本机 Edge 的登录状态（接管入口 127.0.0.1:9222），登录态直接可用</span></label>' +
      '<label class="radio ob-browser-opt"><input type="radio" name="obBrowser" value="chrome" id="obBrowserChrome" /><span>Chrome — 暂不支持：登录态识别与发布只适配 Edge，后续版本加入。</span></label>' +
      '<label class="radio ob-browser-opt"><input type="radio" name="obBrowser" value="firefox" id="obBrowserFirefox" /><span>Firefox — 暂不支持：需要和 Edge 一样的接管方式，当前只适配 Edge。</span></label>',
    async render() {
      const tip = document.createElement("p"); tip.className = "ob-hint";
      tip.textContent = "SocialMate 要操作你的 X 账号，得让程序接管一个浏览器。选 Edge 是因为它能直接借用你已经在 Edge 里登录好的会话——你不用重新输密码。下面 127.0.0.1:9222 是 Edge 留给程序的「接管入口」，不用你手动改。选哪个浏览器：";
      $("obBody").append(tip);
      $("obBody").insertAdjacentHTML("beforeend", OB_STEPS[0].html);
    },
  },
  {
    title: "2 · 登录",
    controls: ["obCopyCmdBtn", "obAvatarImg", "obAccountName", "obAccountHandle"],
    html:
      '<p class="ob-hint">这一步把你的登录态借给 SocialMate 用：它不会保存你的密码，只会复制 Edge 里已有的登录会话（相当于借钥匙不借锁）。第一次做要先彻底关掉 Edge（任务栏和后台都退出），否则文件被占用会复制失败；之后正常用就随时可以复制。请先关掉 Edge，再执行下面这条命令：</p>' +
      '<pre class="ob-code mono" id="obCopyCmd">node scripts/copy-edge-profile.mjs</pre>' +
      '<button class="btn tiny ghost" id="obCopyCmdBtn" type="button">复制命令到剪贴板</button>' +
      '<div class="ob-account" id="obStep2Account">' +
      '  <img id="obAvatarImg" alt="" /><span class="ob-avatar" id="obAvatarInitial">?</span>' +
      '  <div><b id="obAccountName">读取中…</b><span class="mono" id="obAccountHandle">—</span></div>' +
      '</div>' +
      '<p class="ob-hint" id="obAccountNote"></p>',
    async render() {
      $("obBody").insertAdjacentHTML("beforeend", OB_STEPS[1].html);
      const s = statusCache || await api("/api/status");
      if (!s || !s.ok) {
        setText("obAccountName", "无法读取状态");
        setText("obAccountHandle", s?.error || "未知错误");
        setText("obAccountNote", "请确认本地控制服务已启动（npm run app 会自动拉起）。");
        return;
      }
      const acc = s.account || "";
      const name = acc.split(" @")[0] || "未识别";
      const handle = "@" + (acc.split(" @")[1] || "");
      setText("obAccountName", name);
      setText("obAccountHandle", handle);
      setText("obAccountNote", acc
        ? "以上是当前识别到的 X 账号。头像来自 Edge 实时页面，Edge 不在线时显示最近一次缓存。"
        : "暂未识别到已登录账号。请先按上面的步骤把 Edge 的登录状态复制过来，并在 Edge 里登录 X。");
      const av = await api("/api/avatar");
      const img = $("obAvatarImg");
      const initial = $("obAvatarInitial");
      if (img && av && av.ok && av.url) {
        img.onerror = () => { img.style.display = "none"; if (initial) initial.style.display = ""; };
        img.src = av.url;
        img.style.display = "block";
        if (initial) initial.style.display = "none";
      } else if (initial) {
        initial.textContent = (name || "?").trim()[0] || "?";
        initial.style.display = "";
      }
    },
  },
  {
    title: "3 · 配置模型",
    controls: ["obMdlProtocol", "obMdlBaseURL", "obMdlApiKey", "obMdlModel", "obMdlTest", "obMdlSave"],
    html:
      '<p class="ob-hint">这一步告诉它用哪个「大脑」：模型负责给素材打分、写帖子正文和写回复。先用「测试连接」确认填对了，再点「保存」。API Key 只会写进本机的 secrets.json，不会上传、也不会进日志。下面每项：协议选默认的 OpenAI 兼容即可，Base URL 填服务商给的地址，API Key 填密钥（已配过可留空），模型名填服务商提供的名字。</p>' +
      '<label class="field"><span>协议</span><select id="obMdlProtocol">' +
      '<option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="openai-responses">OpenAI Responses</option>' +
      '</select></label>' +
      '<label class="field"><span>Base URL</span><input id="obMdlBaseURL" type="text" spellcheck="false" placeholder="https://api.example.com/v1" /></label>' +
      '<label class="field"><span>API Key</span><input id="obMdlApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="已配置可留空（只写 secrets.json）" /></label>' +
      '<label class="field"><span>模型</span><input id="obMdlModel" type="text" spellcheck="false" placeholder="deepseek/deepseek-v4.1-flash" /></label>' +
      '<div class="btn-row"><button class="btn tiny" id="obMdlTest" type="button">测试连接</button>' +
      '<button class="btn tiny ghost" id="obMdlSave" type="button">保存</button>' +
      '<span class="test-result mono" id="obMdlResult"></span></div>',
    async render() {
      $("obBody").insertAdjacentHTML("beforeend", OB_STEPS[2].html);
      const r = await api("/api/provider");
      if (r && r.ok) {
        $("obMdlProtocol").value = r.provider?.protocol || "openai";
        $("obMdlBaseURL").value = r.provider?.baseURL || "";
        $("obMdlModel").value = r.provider?.model || "";
        const keyEl = $("obMdlApiKey");
        keyEl.value = "";
        keyEl.placeholder = r.hasKey ? "已配置（留空则不修改）" : "未配置";
      } else {
        setText("obMdlResult", "读取模型配置失败：" + (r?.error || "未知错误"));
      }
    },
  },
  {
    title: "4 · 选择话题",
    controls: ["obTopicSeeds", "obTopicsSave"],
    html:
      '<p class="ob-hint">这里填它平时要盯着的关键词：内容池会围绕这些话题去抓热点，一行放一个，想加就加、想删就删。比如做 AI 就写 AI、大模型、ChatGPT 各占一行。保存后立刻生效，不影响其他设置。</p>' +
      '<textarea id="obTopicSeeds" rows="7" spellcheck="false"></textarea>' +
      '<button class="btn tiny" id="obTopicsSave" type="button">保存话题</button>' +
      '<span class="test-result mono" id="obTopicsResult"></span>',
    async render() {
      $("obBody").insertAdjacentHTML("beforeend", OB_STEPS[3].html);
      const r = await api("/api/config");
      if (r && r.ok) {
        const seeds = Array.isArray(r.config?.topicSeeds) ? r.config.topicSeeds : [];
        $("obTopicSeeds").value = seeds.join("\n");
      } else {
        setText("obTopicsResult", "读取配置失败：" + (r?.error || "未知错误"));
      }
    },
  },
  {
    title: "5 · 设置节奏",
    controls: ["obDailyTarget", "obMinGap", "obHourStart", "obHourEnd", "obPaceSave"],
    html:
      '<p class="ob-hint">这里安排它几点干活、干多少：「每日目标」是一天最多几条，「最小间隔」是两条之间至少隔多久，「活跃起/活跃止」是它每天几点到几点工作、其余时间安静待着。保存后只改节奏，不会改发布模式——这一步结束它仍然是「审核」模式，发什么都要你点头。</p>' +
      '<div class="field-row">' +
      '<label class="field"><span>每日目标</span><input id="obDailyTarget" type="number" min="1" max="200" /></label>' +
      '<label class="field"><span>最小间隔（分钟）</span><input id="obMinGap" type="number" min="1" max="720" /></label>' +
      '</div>' +
      '<div class="field-row">' +
      '<label class="field"><span>活跃起（时）</span><input id="obHourStart" type="number" min="0" max="23" /></label>' +
      '<label class="field"><span>活跃止（时）</span><input id="obHourEnd" type="number" min="1" max="24" /></label>' +
      '</div>' +
      '<button class="btn tiny" id="obPaceSave" type="button">保存节奏</button>' +
      '<span class="test-result mono" id="obPaceResult"></span>',
    async render() {
      $("obBody").insertAdjacentHTML("beforeend", OB_STEPS[4].html);
      const r = await api("/api/config");
      if (r && r.ok) {
        const c = r.config || {};
        $("obDailyTarget").value = c.dailyTarget ?? 20;
        $("obMinGap").value = c.minGapMinutes ?? 60;
        $("obHourStart").value = c.activeHours?.start ?? 8;
        $("obHourEnd").value = c.activeHours?.end ?? 23;
      } else {
        setText("obPaceResult", "读取配置失败：" + (r?.error || "未知错误"));
      }
    },
  },
];

// Config write helpers. The ONLY writes the onboarding flow performs are
// marked with OB_ONBOARDING_WRITE below: topicSeeds / dailyTarget /
// activeHours / minGapMinutes / provider fields. autoMode is never assigned:
// the review default in config.json stays untouched.
const OB_STEP_SHELL = [
  "obStep1Shell", "obStep2Shell", "obStep3Shell", "obStep4Shell", "obStep5Shell",
];

// The static shells in index.html exist so test-onboarding.mjs can assert the
// DOM contract. At runtime they are removed before any step renders, so the
// ids below are unique per mounted step (each render rebuilds fresh nodes).
for (const sid of OB_STEP_SHELL) { const s = $(sid); if (s) s.remove(); }

let obStep = 0;
function showOnboarding() {
  obStep = 0;
  $("obOverlay").hidden = false;
  runObStep();
}
function hideOnboarding() {
  $("obOverlay").hidden = true;
  localStorage.setItem("onboarded", "1");
}
const OB_WRITE = (body) => api("/api/config", { method: "POST", body });

async function runObStep() {
  const st = OB_STEPS[obStep];
  $("obBody").innerHTML = "";
  $("obBody").append(Object.assign(document.createElement("b"), { textContent: st.title }));
  await st.render();
  wireStep();
  $("obStepNum").textContent = obStep + 1;
  $("obStepTotal").textContent = OB_STEPS.length;
  $("obPrev").hidden = obStep === 0;
  $("obNext").textContent = obStep === OB_STEPS.length - 1 ? "完成" : "下一步";
}
$("obNext").addEventListener("click", () => {
  if (obStep < OB_STEPS.length - 1) { obStep++; runObStep(); }
  else hideOnboarding();
});
$("obPrev").addEventListener("click", () => { if (obStep > 0) { obStep--; runObStep(); } });
$("obSkip").addEventListener("click", hideOnboarding);
$("obReopen").addEventListener("click", () => { obStep = 0; showOnboarding(); });
// ---- onboarding step interactions (bound on every render; each step
//      rebuilds its nodes, so listeners are attached to the fresh nodes) ----
async function obSaveProvider() {
  const body = {
    protocol: $("obMdlProtocol").value,
    baseURL: $("obMdlBaseURL").value.trim(),
    model: $("obMdlModel").value.trim(),
  };
  const key = $("obMdlApiKey").value.trim();
  if (key) body.apiKey = key;
  const r = await api("/api/provider", { method: "POST", body });
  if (!r?.ok) {
    $("obMdlResult").className = "test-result mono err";
    $("obMdlResult").textContent = "✗ " + (r?.error || "保存失败");
    return;
  }
  $("obMdlResult").className = "test-result mono ok";
  $("obMdlResult").textContent = "✓ 已保存（apiKey 只写入 secrets.json）";
  $("obMdlApiKey").value = "";
  $("obMdlApiKey").placeholder = "已配置（留空则不修改）";
}

function wireStep() {
  const step = OB_STEPS[obStep];

  if (step && step.controls && step.controls.includes("obCopyCmdBtn")) {
    const btn = $("obCopyCmdBtn");
    if (btn) btn.addEventListener("click", async () => {
      const text = "node scripts/copy-edge-profile.mjs";
      try {
        await navigator.clipboard.writeText(text);
        toast("命令已复制", "先关闭 Edge，再执行这条命令，就能把登录状态复制过来。", "ok");
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); toast("命令已复制", "先关闭 Edge，再执行这条命令，就能把登录状态复制过来。", "ok"); }
        catch { toast("复制失败", "请手动输入：" + text, "warn", true); }
        ta.remove();
      }
    });
  }

  if (step && step.controls && step.controls.includes("obMdlSave")) {
    const save = $("obMdlSave");
    const test = $("obMdlTest");
    if (save) save.addEventListener("click", obSaveProvider);
    if (test) test.addEventListener("click", async () => {
      const btn = $("obMdlTest"), out = $("obMdlResult");
      btn.disabled = true;
      out.className = "test-result mono";
      out.textContent = "测试中…";
      await obSaveProvider().catch(() => {});
      const r = await api("/api/provider/test", { method: "POST" });
      btn.disabled = false;
      if (r?.ok) {
        out.className = "test-result mono ok";
        out.textContent = `✓ 连接正常 · ${r.latencyMs} 毫秒 · ${r.model}`;
      } else {
        out.className = "test-result mono err";
        out.textContent = "✗ " + (r?.error || "未知错误");
      }
    });
  }

  if (step && step.controls && step.controls.includes("obTopicsSave")) {
    const btn = $("obTopicsSave");
    if (btn) btn.addEventListener("click", async () => {
      const seeds = $("obTopicSeeds").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // OB_ONBOARDING_WRITE: only topicSeeds is sent; autoMode and every
      // other config key stay untouched (server merges against the file).
      const r = await OB_WRITE({ topicSeeds: seeds });
      if (!r?.ok) {
        $("obTopicsResult").className = "test-result mono err";
        $("obTopicsResult").textContent = "✗ " + (r?.error || "保存失败");
        return;
      }
      $("obTopicsResult").className = "test-result mono ok";
      $("obTopicsResult").textContent = `✓ 已保存 ${seeds.length} 个话题`;
    });
  }

  if (step && step.controls && step.controls.includes("obPaceSave")) {
    const btn = $("obPaceSave");
    if (btn) btn.addEventListener("click", async () => {
      const dailyTarget = Number($("obDailyTarget").value);
      const minGapMinutes = Number($("obMinGap").value);
      const activeHours = { start: Number($("obHourStart").value), end: Number($("obHourEnd").value) };
      if (!Number.isFinite(dailyTarget) || dailyTarget < 1 || dailyTarget > 200) {
        $("obPaceResult").className = "test-result mono err";
        $("obPaceResult").textContent = "✗ 每日目标需在 1-200 之间";
        return;
      }
      if (!Number.isFinite(minGapMinutes) || minGapMinutes < 1 || minGapMinutes > 720) {
        $("obPaceResult").className = "test-result mono err";
        $("obPaceResult").textContent = "✗ 最小间隔需在 1-720 分钟之间";
        return;
      }
      if (!Number.isFinite(activeHours.start) || activeHours.start < 0 || activeHours.start > 23 ||
          !Number.isFinite(activeHours.end) || activeHours.end < 1 || activeHours.end > 24 ||
          activeHours.start >= activeHours.end) {
        $("obPaceResult").className = "test-result mono err";
        $("obPaceResult").textContent = "✗ 活跃时段非法（如 8-23）";
        return;
      }
      // OB_ONBOARDING_WRITE: only pace fields are sent; autoMode stays review.
      const r = await OB_WRITE({ dailyTarget, minGapMinutes, activeHours });
      if (!r?.ok) {
        $("obPaceResult").className = "test-result mono err";
        $("obPaceResult").textContent = "✗ " + (r?.error || "保存失败");
        return;
      }
      $("obPaceResult").className = "test-result mono ok";
      $("obPaceResult").textContent = "✓ 节奏已保存（模式保持审核）";
    });
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Beginner-facing activity: the server translates log lines into plain
// sentences, so this only renders. Empty feed == it has not acted yet.
async function loadActivity() {
  const r = await api('/api/activity?n=60');
  if (!r || !r.ok) return;
  const now = r.now || {};
  const dot = $('nowDot');
  if (dot) dot.className = 'now-dot ' + (now.level || '');
  setText('nowTitle', now.title || '—');
  setText('nowDetail', now.detail || '');

  const feed = $('activityFeed');
  if (!feed) return;
  const items = r.items || [];
  if (!items.length) {
    feed.innerHTML = '<div class="act-row"><span class="act-body">还没有动作。启动守护进程后，它做的每件事都会出现在这里。</span></div>';
    return;
  }
  feed.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'act-row ' + (it.level || '');
    const ts = document.createElement('span');
    ts.className = 'act-ts';
    ts.textContent = it.ts || '';
    const body = document.createElement('span');
    body.className = 'act-body';
    body.textContent = it.title || '';
    row.append(ts, body);
    feed.appendChild(row);
  }
}

async function loadLogs() {
  const r = await api('/api/logs?lines=40');
  if (!r || !r.ok) return;
  const lines = (r.lines || []).filter((l) => l.trim());
  const pre = $('logs');
  if (!lines.length) { pre.textContent = '（暂无日志）'; return; }
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.innerHTML = '';
  for (const l of lines.reverse()) {
    const span = document.createElement('span');
    if (/error|failed|blocked|失败|错误/i.test(l)) span.className = 'ln-err';
    else if (/DRAFT/.test(l)) span.className = 'ln-draft';
    else if (/PUBLISHED/.test(l)) span.className = 'ln-pub';
    span.textContent = l + '\n';
    pre.appendChild(span);
  }
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

$('pauseBtn').addEventListener('click', async () => {
  const paused = !!statusCache?.paused;
  const btn = $('pauseBtn');
  btn.classList.add('is-confirming');
  setTimeout(() => btn.classList.remove('is-confirming'), 500);
  const r = await api('/api/control', { method: 'POST', body: { paused: !paused } });
  if (!r?.ok) return toast('切换失败', r?.error, 'err', true);
  toast(!paused ? '已暂停' : '已恢复', !paused ? '守护进程下一轮循环起生效' : null);
  refreshStatus();
});

$('daemonStart').addEventListener('click', async () => {
  const r = await api('/api/daemon/start', { method: 'POST' });
  if (!r?.ok) return toast('启动失败', r?.error, 'err', true);
  toast(r.already ? '已在运行' : '守护进程已启动', r.pid ? '进程号 ' + r.pid : null);
  refreshStatus();
});
$('daemonStop').addEventListener('click', () => {
  confirmAction({
    title: '停止守护进程？',
    body: '当前循环结束后不再产生新草稿。已排队的内容不受影响。',
    ok: '停止', onOk: async () => {
      const r = await api('/api/daemon/stop', { method: 'POST' });
      if (!r?.ok) return toast('停止失败', r?.error, 'err', true);
      toast('守护进程已停止');
      refreshStatus();
    },
  });
});
$('poolRefresh').addEventListener('click', async () => {
  const b = $('poolRefresh'); b.disabled = true; b.textContent = '刷新中…';
  await refreshStatus();
  b.disabled = false; b.textContent = '刷新';
  toast('内容池已刷新');
});

// ---------- queue ----------
// 全自动 mode never leaves a draft, so the queue page also shows what the
// agent is publishing right now and what it just published. Both come from the
// control server (no client-side invention), so they cannot disagree with
// log.txt.
async function loadPublishing() {
  const wrap = $('publishingNow');
  const feed = $('publishedFeed');
  const card = $('publishedCard');
  const s = await api('/api/status');
  const live = (s && s.ok && Array.isArray(s.publishing)) ? s.publishing : [];
  if (wrap) {
    if (!live.length) { wrap.hidden = true; wrap.innerHTML = ''; }
    else {
      wrap.hidden = false;
      wrap.innerHTML = '';
      for (const p of live) {
        const row = document.createElement('div');
        row.className = 'card q-item publishing';
        const top = document.createElement('div');
        top.className = 'q-top';
        const kind = document.createElement('span');
        kind.className = 'q-kind quote';
        kind.textContent = '正在发布 · ' + ({ post: '原创', quote: '引用', muse: '随手扯淡', reply: '回复', othersReply: '评论区互动', growthFollow: '涨粉' }[p.kind] || p.kind);
        const t = document.createElement('span');
        t.className = 'q-time mono';
        t.textContent = p.at ? fmtTime(Date.parse(p.at)) : '';
        top.append(kind, t);
        row.appendChild(top);
        const text = document.createElement('div');
        text.className = 'q-text';
        text.textContent = p.text || '';
        row.appendChild(text);
        if (p.targetUrl) {
          const a = document.createElement('a');
          a.className = 'q-target';
          a.href = p.targetUrl; a.target = '_blank'; a.rel = 'noreferrer';
          a.textContent = (p.author ? '给 @' + p.author + ' · ' : '') + p.targetUrl;
          row.appendChild(a);
        }
        wrap.appendChild(row);
      }
    }
  }
  const r = await api('/api/published?n=30');
  if (feed && card) {
    const list = (r && r.ok && Array.isArray(r.published)) ? r.published : [];
    card.hidden = !list.length;
    feed.innerHTML = '';
    for (const e of list) {
      const row = document.createElement('div');
      row.className = 'act-row';
      const kind = document.createElement('span');
      kind.className = 'act-kind mono';
      kind.textContent = ({ post: '原创', quote: '引用', muse: '扯淡', reply: '回复', othersReply: '互动', growthFollow: '涨粉', follow: '涨粉', followBack: '回关' }[e.kind] || e.kind || '内容');
      const body = document.createElement('span');
      body.className = 'act-body';
      body.textContent = (e.text || '').replace(/\s+/g, ' ').slice(0, 120) || '（已关注）';
      const when = document.createElement('span');
      when.className = 'act-ts mono';
      when.textContent = e.at ? fmtTime(Date.parse(e.at)) : '';
      row.append(kind, body, when);
      if (e.url && /^https?:/.test(e.url)) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => window.open(e.url, '_blank'));
      }
      feed.appendChild(row);
    }
  }
}

async function loadDrafts() {
  const r = await api('/api/drafts');
  const body = $('queueBody');
  if (!r || !r.ok) { showError('无法读取草稿队列：' + (r?.error || ''), loadDrafts); return; }
  const drafts = r.drafts || [];
  setText('queueCount', drafts.length);
  $('approveAll').disabled = !drafts.length;
  loadPublishing();
  body.innerHTML = '';

  if (!drafts.length) {
    body.innerHTML = `<div class="card empty"><span class="e-ico">≡</span>
      <b>队列是空的</b>
      它平时按你设的节奏干活，把写好的内容先放这里等你过目（审核模式）。<br />
      想马上看到内容：去「设置」把模式切到全自动，或到仪表盘点「启动守护进程」。</div>`;
    return;
  }

  for (const d of drafts) {
    const card = document.createElement('div');
    card.className = 'card q-item';
    card.dataset.id = d.id;

    const kindMap = { post: ['原创', 'post'], quote: ['引用', 'quote'], reply: ['回复', 'reply'], othersReply: ['互动', 'reply'], growthFollow: ['涨粉', 'reply'] };
    const [kLabel, kCls] = kindMap[d.kind] || ['原创', 'post'];

    const top = document.createElement('div');
    top.className = 'q-top';
    top.innerHTML = `<span class="q-kind ${kCls}"></span><span class="q-time mono"></span>`;
    top.querySelector('.q-kind').textContent = kLabel;
    const tEl = top.querySelector('.q-time');
    tEl.textContent = d.createdAt ? fmtTime(Date.parse(d.createdAt)) : '';

    card.appendChild(top);

    if (d.title) {
      const ti = document.createElement('div');
      ti.className = 'q-title';
      ti.textContent = '选题：' + d.title;
      card.appendChild(ti);
    }

    // T3: a topic post links back to its source so the reader (and the human
    // reviewing the draft) can see what the post is actually about.
    if (d.sourceUrl) {
      const src = document.createElement('div');
      src.className = 'q-target';
      const a = document.createElement('a');
      a.href = d.sourceUrl; a.target = '_blank'; a.rel = 'noreferrer';
      a.textContent = '来源：' + d.sourceUrl;
      src.appendChild(a);
      card.appendChild(src);
    }

    if (d.kind === 'quote' || d.kind === 'reply') {
      if (d.targetUrl) {
        const tgt = document.createElement('div');
        tgt.className = 'q-target';
        const a = document.createElement('a');
        a.href = d.targetUrl; a.target = '_blank'; a.rel = 'noreferrer';
        a.textContent = d.kind === 'reply' ? (d.replyTo ? `回复 @${d.replyTo} · ` : '回复 ') + d.targetUrl : '目标：' + d.targetUrl;
        tgt.appendChild(a);
        card.appendChild(tgt);
      }
      if (d.quotedText) {
        const q = document.createElement('div');
        q.className = 'q-quoted';
        q.textContent = d.quotedText;
        card.appendChild(q);
      }
    }

    const text = document.createElement('div');
    text.className = 'q-text';
    // AC-11: a growth-follow draft has an intentionally empty body (the action
    // is a follow, not a post). Render a plain-language summary so the card is
    // never blank.
    if ((d.kind === 'growthFollow' || d.kind === 'follow') && !String(d.text || '').trim()) {
      const who = d.author ? '@' + d.author : '这个蓝V';
      const fans = (d.followers != null) ? '（' + d.followers + ' 粉丝）' : '';
      text.textContent = '关注 ' + who + fans + '，并去他的帖子下留一条评论';
    } else {
      text.textContent = d.text;
    }
    // Growth drafts promise a comment, so the reviewer needs to see BOTH the
    // post being commented on and where the comment lands — otherwise the
    // card asks for a judgement it gives no evidence for.
    if (d.kind === 'growthFollow' || d.kind === 'follow') {
      if (d.commentUrl) {
        const cu = document.createElement('div');
        cu.className = 'q-target';
        const a = document.createElement('a');
        a.href = d.commentUrl; a.target = '_blank'; a.rel = 'noreferrer';
        a.textContent = '评论目标：' + d.commentUrl;
        cu.appendChild(a);
        card.appendChild(cu);
      }
      if (d.sourceText) {
        const st = document.createElement('div');
        st.className = 'q-quoted';
        st.textContent = '他最近的帖子：' + d.sourceText;
        card.appendChild(st);
      }
    }
    text.title = '点击编辑';
    card.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'q-actions';
    const pub = document.createElement('button');
    pub.className = 'btn'; pub.textContent = '发布';
    const drop = document.createElement('button');
    drop.className = 'btn ghost'; drop.textContent = '丢弃';
    const status = document.createElement('span');
    status.className = 'q-status';
    actions.append(pub, drop, status);
    card.appendChild(actions);

    // inline edit
    text.addEventListener('click', () => startEdit(card, text, d));
    text.addEventListener('blur', () => finishEdit(card, text, d));
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { text.textContent = d.text; text.blur(); }
    });

    pub.addEventListener('click', () => {
      // Publishing is irreversible and goes straight to the live X account, so
      // it gets the same confirm step as 丢弃 / 全部发布. Without this a single
      // stray click on 发布 posts for real.
      confirmAction({
        title: '发布这条内容？',
        body: '将通过 Edge 立即发布到你的 X 账号，发布后无法撤回。',
        ok: '发布',
        onOk: () => publishOne(card, d, status, pub),
      });
    });
    drop.addEventListener('click', () => {
      confirmAction({
        title: '丢弃这条草稿？',
        body: '内容会被删除，无法恢复。选填原因能帮它下次少写这类内容。',
        ok: '丢弃',
        reasons: [
          { value: 'too_long', label: '太长' },
          { value: 'duplicate', label: '重复' },
          { value: 'tone', label: '语气不对' },
          { value: 'factual', label: '事实错' },
          { value: 'irrelevant', label: '不相关' },
          { value: 'other', label: '其他' },
        ],
        onOk: async (reason) => {
          const rr = await api(`/api/drafts/${d.id}/reject`, { method: 'POST', body: reason ? { reason } : {} });
          if (!rr?.ok) return toast('丢弃失败', rr?.error, 'err', true);
          toast('已丢弃');
          loadDrafts(); refreshStatus();
        },
      });
    });

    body.appendChild(card);
  }
}

function startEdit(card, el, d) {
  if (el.isContentEditable) return;
  editingId = d.id;
  el.contentEditable = 'true';
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
}

async function finishEdit(card, el, d) {
  if (!el.isContentEditable) return;
  el.contentEditable = 'false';
  editingId = null;
  const next = el.textContent ?? '';
  if (!next.trim() || next === d.text) { el.textContent = d.text; return; }
  const r = await api(`/api/drafts/${d.id}/update`, { method: 'POST', body: { text: next } });
  if (!r?.ok) { el.textContent = d.text; return toast('保存失败', r?.error, 'err', true); }
  d.text = next;
  const s = card.querySelector('.q-status');
  s.textContent = '已保存';
  s.className = 'q-status q-saved';
  setTimeout(() => { s.textContent = ''; s.className = 'q-status'; }, 1800);
}

async function publishOne(card, d, status, btn) {
  // Flush any in-progress edit first. The textarea holds the newest text, and
  // d.text only updates after a successful save, so publishing straight from
  // d.text could send the pre-edit version of what the user is looking at.
  const el = card.querySelector('.q-text');
  if (el && el.isContentEditable) await finishEdit(card, el, d);
  const shown = el ? (el.textContent || '') : d.text;
  if (shown.trim() && shown !== d.text) {
    const saved = await api(`/api/drafts/${d.id}/update`, { method: 'POST', body: { text: shown } });
    if (!saved?.ok) return toast('发布前保存失败', saved?.error, 'err', true);
    d.text = shown;
  }

  card.classList.add('busy');
  btn.textContent = '发布中…';
  status.textContent = '正在通过 Edge 发布…';
  const r = await api(`/api/drafts/${d.id}/approve`, { method: 'POST' });
  card.classList.remove('busy');
  btn.textContent = '发布';
  if (r?.ok) { toast('已发布', `${d.kind} · ${(d.text || '').slice(0, 24)}…`); status.textContent = ''; loadDrafts(); refreshStatus(); }
  else {
    const why = r?.results?.[0]?.error || r?.error;
    status.textContent = /^gate:/.test(why || '') ? '未通过闸门' : '发布失败';
    toast('发布失败', explainGate(why), 'err', true);
  }
}

$('approveAll').addEventListener('click', () => {
  const n = $('queueCount').textContent;
  confirmAction({
    title: '发布全部草稿？',
    body: `将依次通过 Edge 发布 ${n} 条内容，每条间隔约 4 秒。已发布的内容无法撤回。`,
    ok: `发布 ${n} 条`, onOk: async () => {
      const r = await api('/api/drafts/approve-all', { method: 'POST' });
      const okN = (r?.results || []).filter((x) => x.ok).length;
      const badN = (r?.results || []).length - okN;
      const firstBad = (r?.results || []).find((x) => !x.ok);
      toast(badN ? '部分发布失败' : '全部已发布',
        badN ? `成功 ${okN} 条；` + explainGate(firstBad?.error) : `成功 ${okN} 条`,
        badN ? 'err' : 'ok', badN > 0);
      loadDrafts(); refreshStatus();
    },
  });
});

// ---------- model ----------
async function loadProvider() {
  const r = await api('/api/provider');
  if (!r?.ok) { showError('无法读取模型配置：' + (r?.error || ''), loadProvider); return; }
  const p = r.provider || {};
  $('pvProtocol').value = p.protocol || 'openai';
  $('pvBaseURL').value = p.baseURL || '';
  $('pvModel').value = p.model || '';
  $('pvCheapModel').value = p.cheapModel || '';
  const keyEl = $('pvApiKey');
  keyEl.value = '';
  keyEl.placeholder = r.hasKey ? '已配置（留空则不修改）' : '未配置';
}

$('pvSave').addEventListener('click', async () => {
  const body = {
    protocol: $('pvProtocol').value,
    baseURL: $('pvBaseURL').value.trim(),
    model: $('pvModel').value.trim(),
    cheapModel: $('pvCheapModel').value.trim(),
  };
  const key = $('pvApiKey').value.trim();
  if (key) body.apiKey = key;
  const r = await api('/api/provider', { method: 'POST', body });
  if (!r?.ok) return toast('保存失败', r?.error, 'err', true);
  toast('模型配置已保存');
  loadProvider();
});

$('pvTest').addEventListener('click', async () => {
  const btn = $('pvTest'); const out = $('pvResult');
  btn.disabled = true; out.className = 'test-result mono'; out.textContent = '测试中…';
  const r = await api('/api/provider/test', { method: 'POST' });
  btn.disabled = false;
  if (r?.ok) { out.className = 'test-result mono ok'; out.textContent = `✓ 连接正常 · ${r.latencyMs} 毫秒 · ${r.model}`; }
  else { out.className = 'test-result mono err'; out.textContent = '✗ ' + (r?.error || '未知错误'); }
});

// ---------- settings ----------
const SAFETY_KEYS = { setAllowFinance: 'allowFinance', setAllowPolitics: 'allowPolitics' };
async function loadConfig() {
  const r = await api('/api/config');
  if (!r?.ok) { showError('无法读取设置：' + (r?.error || ''), loadConfig); return; }
  const c = r.config || {};
  $('setDailyTarget').value = c.dailyTarget ?? 20;
  $('setQuoteRatio').value = c.quoteRatio ?? 0.4;
  setText('quoteRatioVal', Number(c.quoteRatio ?? 0.4).toFixed(2));
  $('setMinGap').value = c.minGapMinutes ?? 60;
  $('setMaxGap').value = c.maxGapMinutes ?? '';
  $('setHourStart').value = c.activeHours?.start ?? 0;
  $('setHourEnd').value = c.activeHours?.end ?? 24;
  $('setVoiceEnabled').checked = c.voiceEnabled !== false;
  const safety = c.safety || {};
  $('setAllowFinance').checked = !!safety.allowFinance;
  $('setAllowPolitics').checked = !!safety.allowPolitics;
  const h = c.humanize || {};
  $('setTypeMin').value = h.typeDelayMin ?? 30;
  $('setTypeMax').value = h.typeDelayMax ?? 100;
  // Feature switches + browse sub-controls (F4-d / F4-f): read the real
  // values from config so re-entering the page shows what is actually saved.
  const features = c.features || {};
  $('setFeatPost').checked = features.post !== false;
  $('setFeatQuote').checked = features.quote !== false;
  $('setFeatMuse').checked = features.muse !== false;
  $('setFeatReply').checked = features.reply !== false;
  $('setFeatLike').checked = features.like !== false;
  $('setFeatBrowse').checked = features.browse === true;
  $('setFeatOthersReply').checked = features.othersReply !== false;
  $('setFeatFollow').checked = features.follow === true;
  $('setFeatFollowBack').checked = features.followBack !== false;
  // Quota / cooldown boxes (T4): read the real gate.perKind values so the
  // page shows what is saved. Defaults mirror config.json exactly; 0 is a
  // legal value (DailyMax=0 blocks, CooldownMinutes=0 means no cooldown).
  const pk = (c.gate && c.gate.perKind) || {};
  $('setPostDailyMax').value = pk.postDailyMax ?? 8;
  $('setQuoteDailyMax').value = pk.quoteDailyMax ?? 7;
  $('setMuseDailyMax').value = pk.museDailyMax ?? 5;
  $('setReplyDailyMax').value = pk.replyDailyMax ?? 10;
  $('setOthersReplyDailyMax').value = pk.othersReplyDailyMax ?? 6;
  $('setBrowseDailyMax').value = pk.browseDailyMax ?? 3;
  $('setFollowDailyMax').value = pk.followDailyMax ?? 30;
  $('setPostCooldownMinutes').value = pk.postCooldownMinutes ?? 45;
  $('setQuoteCooldownMinutes').value = pk.quoteCooldownMinutes ?? 30;
  $('setOthersReplyCooldownMinutes').value = pk.othersReplyCooldownMinutes ?? 30;
  $('setBrowseCooldownMinutes').value = pk.browseCooldownMinutes ?? 60;
  $('setFollowCooldownMinutes').value = pk.followCooldownMinutes ?? 2;
  $('setFollowBackDailyMax').value = pk.followBackDailyMax ?? 100;
  $('setFollowBackCooldownMinutes').value = pk.followBackCooldownMinutes ?? 1;
  const browse = c.browse || {};
  $('setBrowseMinutes').value = browse.minutes ?? 3;
  $('setBrowseScrolls').value = browse.maxScrolls ?? 8;
  $('setBrowseLike').checked = browse.likeWhileBrowsing !== false;
  $('browseSub').hidden = !(features.browse === true);
  const mode = c.autoMode || statusCache?.mode || 'review';
  for (const el of document.querySelectorAll('input[name="runMode"]')) el.checked = el.value === mode;
  $('modeHint').textContent = mode === 'auto'
    ? '全自动：它检查完安全就直接发到 X，中间没人再帮你看一遍。'
    : '审核：它写好的内容先放队列，你点「发布」才真的发出去。新人不熟悉时选这个更稳。';
}
$('setFeatBrowse').addEventListener('change', (e) => { $('browseSub').hidden = !e.target.checked; });

$('setQuoteRatio').addEventListener('input', (e) => setText('quoteRatioVal', Number(e.target.value).toFixed(2)));
$('setTypeDelay').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('setTypeMin').value = v;
  $('setTypeMax').value = v * 3;
  setText('typeDelayVal', `${v}–${v * 3} ms`);
});

for (const [id, key] of Object.entries(SAFETY_KEYS)) {
  $(id).addEventListener('change', (e) => {
    if (!e.target.checked) return;
    e.target.checked = false;
    confirmAction({
      title: '开启高风险内容？',
      body: '这类内容在 X 属于高风险，可能导致账号被限制。确认要允许模型生成并发布这类内容吗？',
      ok: '我确认，开启', onOk: () => { e.target.checked = true; toast('已勾选，记得保存设置', null, 'warn'); },
    });
  });
}

$('setSave').addEventListener('click', async () => {
  const body = {
    dailyTarget: Number($('setDailyTarget').value),
    quoteRatio: Number($('setQuoteRatio').value),
    minGapMinutes: Number($('setMinGap').value),
    // Empty max = "keep whatever is stored" (server deep-merge); a real value
    // turns the cadence into a random [min, max] window.
    ...(($('setMaxGap').value.trim() !== '') && { maxGapMinutes: Number($('setMaxGap').value) }),
    activeHours: { start: Number($('setHourStart').value), end: Number($('setHourEnd').value) },
    voiceEnabled: $('setVoiceEnabled').checked,
    autoMode: document.querySelector('input[name="runMode"]:checked')?.value || 'review',
    safety: { allowFinance: $('setAllowFinance').checked, allowPolitics: $('setAllowPolitics').checked },
    humanize: {
      typeDelayMin: Number($('setTypeMin').value),
      typeDelayMax: Number($('setTypeMax').value),
    },
    features: {
      post: $('setFeatPost').checked,
      quote: $('setFeatQuote').checked,
      muse: $('setFeatMuse').checked,
      reply: $('setFeatReply').checked,
      like: $('setFeatLike').checked,
      browse: $('setFeatBrowse').checked,
      othersReply: $('setFeatOthersReply').checked,
      follow: $('setFeatFollow').checked,
      followBack: $('setFeatFollowBack').checked,
    },
    gate: {
      perKind: {
        // Empty quota boxes mean "keep the current value": the key is simply
        // not submitted, so the server deep merge leaves it untouched. An
        // explicit 0 is the only way to mean "block this lane" — never
        // convert an empty input to 0 (that would silently block every lane).
        ...(($('setPostDailyMax').value.trim() !== '') && { postDailyMax: Number($('setPostDailyMax').value) }),
        ...(($('setQuoteDailyMax').value.trim() !== '') && { quoteDailyMax: Number($('setQuoteDailyMax').value) }),
        ...(($('setMuseDailyMax').value.trim() !== '') && { museDailyMax: Number($('setMuseDailyMax').value) }),
        ...(($('setReplyDailyMax').value.trim() !== '') && { replyDailyMax: Number($('setReplyDailyMax').value) }),
        ...(($('setOthersReplyDailyMax').value.trim() !== '') && { othersReplyDailyMax: Number($('setOthersReplyDailyMax').value) }),
        ...(($('setBrowseDailyMax').value.trim() !== '') && { browseDailyMax: Number($('setBrowseDailyMax').value) }),
        ...(($('setFollowDailyMax').value.trim() !== '') && { followDailyMax: Number($('setFollowDailyMax').value) }),
        ...(($('setPostCooldownMinutes').value.trim() !== '') && { postCooldownMinutes: Number($('setPostCooldownMinutes').value) }),
        ...(($('setQuoteCooldownMinutes').value.trim() !== '') && { quoteCooldownMinutes: Number($('setQuoteCooldownMinutes').value) }),
        ...(($('setOthersReplyCooldownMinutes').value.trim() !== '') && { othersReplyCooldownMinutes: Number($('setOthersReplyCooldownMinutes').value) }),
        ...(($('setBrowseCooldownMinutes').value.trim() !== '') && { browseCooldownMinutes: Number($('setBrowseCooldownMinutes').value) }),
        ...(($('setFollowCooldownMinutes').value.trim() !== '') && { followCooldownMinutes: Number($('setFollowCooldownMinutes').value) }),
        ...(($('setFollowBackDailyMax').value.trim() !== '') && { followBackDailyMax: Number($('setFollowBackDailyMax').value) }),
        ...(($('setFollowBackCooldownMinutes').value.trim() !== '') && { followBackCooldownMinutes: Number($('setFollowBackCooldownMinutes').value) }),
      },
    },
    browse: {
      minutes: Number($('setBrowseMinutes').value),
      maxScrolls: Number($('setBrowseScrolls').value),
      likeWhileBrowsing: $('setBrowseLike').checked,
    },
  };
  const r = await api('/api/config', { method: 'POST', body });
  if (!r?.ok) return toast('保存失败', r?.error, 'err', true);
  await api('/api/control', { method: 'POST', body: { mode: body.autoMode } });
  const s = $('setSaved');
  s.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  toast('设置已保存');
  setTimeout(() => { s.textContent = ''; }, 3000);
  refreshStatus();
});

// ---------- boot ----------
if (!localStorage.getItem('onboarded')) showOnboarding();
refreshStatus();
setInterval(() => { if (currentPage === 'dashboard' && !statusCache?.paused) loadLogs(); }, 5000);
setInterval(() => { if (currentPage === 'dashboard') loadActivity(); }, 5000);
setInterval(() => { refreshStatus(); }, 15000);

// ---------- stats card (T6) ----------
async function loadStats() {
  const r = await api('/api/stats');
  if (!r || !r.ok) return;
  const t = r.today || {};
  setText('stRead', t.read ?? '—');
  setText('stKept', t.kept ?? '—');
  setText('stDropped', t.dropped ?? '—');
  const top = (r.topDropReasons || []).map((x) => explainDropReason(x.reason) + ' ' + x.n).join(' / ') || '无';
  setText('stDropReasons', top);
  const src = Object.entries(r.bySource || {}).map(([k, v]) => sourceLabel(k) + ' ' + v).join(' / ') || '—';
  setText('stBySource', src);
  const wrap = $('statsTimeline');
  if (!wrap) return;
  wrap.innerHTML = '';
  const rows = r.recent || [];
  if (!rows.length) { wrap.textContent = '还没有轮次记录。'; return; }
  for (const row of rows) {
    const ts = new Date(row.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    const line = document.createElement('div');
    line.className = 'stats-line mono';
    line.textContent = ts + '  ' + (roundKindLabel(row.kind) || '?') + '  读 ' + (row.read ?? 0) + ' / 入池 ' + (row.kept ?? 0) + ' / 丢 ' + (row.dropped ?? 0) + (row.acted ? ' / 互动 ' + row.acted : '');
    wrap.appendChild(line);
  }
}

// ---------- run-once (T5) ----------
$('runOnce').addEventListener('click', async () => {
  const btn = $('runOnce');
  btn.disabled = true;
  btn.textContent = '执行中…';
  try {
    const r = await api('/api/daemon/run-once', { method: 'POST' });
    if (r?.conflict) { toast('守护进程正在运行', '先停止守护进程，再执行单轮。', 'warn', true); }
    else if (r?.ok) { toast('已开始执行一轮', '只采集与写草稿（review），绝不会发布。'); refreshStatus(); }
    else { toast('执行失败', r?.error || '未知错误', 'err', true); }
  } finally {
    btn.disabled = false;
    btn.textContent = '立即执行一次';
  }
});

// ---------- manual round triggers (互动卡片) ----------
const ROUND_BUTTONS = [
  { id: 'actCollect', name: 'collect', label: '采集热点', readonly: true },
  { id: 'actLike', name: 'like', label: '点个赞', readonly: true },
  { id: 'actBrowse', name: 'browse', label: '刷一刷', readonly: true },
  { id: 'actReply', name: 'reply', label: '回复评论区', readonly: false },
  { id: 'actOthers', name: 'others', label: '互动别人', readonly: false },
  { id: 'actFollow', name: 'follow', label: '涨粉', readonly: false },
  { id: 'actContent', name: 'content', label: '发一条', readonly: false },
];
const actStatusEl = $('actStatus');
function setActStatus(text, kind) {
  if (!actStatusEl) return;
  actStatusEl.textContent = text || '';
  actStatusEl.className = 'act-status' + (kind ? ' ' + kind : '');
}
for (const spec of ROUND_BUTTONS) {
  const btn = $(spec.id);
  if (!btn) continue;
  btn.addEventListener('click', async () => {
    const run = async () => {
      btn.disabled = true;
      btn.textContent = '执行中…';
      setActStatus('执行中…', 'busy');
      try {
        const body = spec.readonly ? undefined : { publish: true };
        const r = await api('/api/round/' + spec.name, { method: 'POST', body });
        if (r?.conflict) {
          setActStatus('失败', 'err');
          toast('守护进程正在运行', '请先停止守护进程，再手动执行。', 'warn', true);
          return;
        }
        if (r?.ok) {
          setActStatus('已触发', 'ok');
          toast(`已触发「${spec.label}」`, r?.publish ? '本次调用已确认发布。' : '只读/草稿轮，不会发布。');
          refreshStatus();
          return;
        }
        setActStatus('失败', 'err');
        toast('执行失败', r?.error || '未知错误', 'err', true);
      } catch (e) {
        setActStatus('失败', 'err');
        toast('执行失败', e.message || String(e), 'err', true);
      } finally {
        btn.disabled = false;
        btn.textContent = spec.label;
      }
    };
    if (spec.readonly) {
      await run();
    } else {
      confirmAction({
        title: `确认执行「${spec.label}」`,
        body: '发布类轮次需要本次显式确认：确认后才会执行（审核模式下写入草稿队列，不会真的发出去）。',
        ok: '确认执行',
        danger: true,
        onOk: async () => { await run(); },
      });
    }
  });
}
