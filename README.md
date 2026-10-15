# SocialMate — 自媒体人的 media-agent（推特 / X 版）

<p align="center"><img src="docs/assets/cover-banner.png" alt="SocialMate" width="100%"></p>

> **Your social media mate — it reads, it thinks, it posts.**
>
> 一个跑在你自己电脑上的社媒运营 Agent：它盯热点、按你的语气写内容、给你审核，
> 再驱动你**本机真实 Edge 浏览器的登录态**去发布和互动。默认**审核模式**，一切先进队列等你放行。

SocialMate 的定位不是「纯自动发帖机器人」，而是**自媒体人的 media-agent**：
发现热点 → 理解 → 生成 → 你决定 → 它执行。所以「可解释、可干预、可暂停」是它的第一性原则，
而不是事后补的开关。

---

## 目录

- [它是什么](#它是什么)
- [能做什么（功能总览）](#能做什么功能总览)
- [它是怎么工作的（一条内容的一生）](#它是怎么工作的一条内容的一生)
- [快速开始（5 步跑起来）](#快速开始5-步跑起来)
- [两种运行模式](#两种运行模式)
- [桌面端界面说明](#桌面端界面说明)
- [配置详解 configjson](#配置详解-configjson)
- [模型接入](#模型接入)
- [命令速查](#命令速查)
- [数据与文件在哪](#数据与文件在哪)
- [打包成 exe 与分发](#打包成-exe-与分发)
- [隐私与密钥安全](#隐私与密钥安全)
- [常见问题](#常见问题)
- [反检测设计（尽量不像机器人）](#反检测设计尽量不像机器人)
- [已知限制](#已知限制)
- [风险与合规](#风险与合规)
- [参与贡献 / 许可证](#参与贡献--许可证)
- [附带模块（非推特）](#附带模块非推特)

---

## 它是什么

- **本地优先（local-first）**：所有代码、配置、队列、日志都在你自己的电脑上，不上传任何服务器。
- **用你自己的浏览器登录态**：不保存你的 X 密码，而是复制你本机 Edge 的 profile，
  启动一个**独立的** Edge 实例（独立数据目录 + 独立调试端口 9222）来操作。你原来的 Edge 完全不受影响。

> 原话需求：「我要你 30-50min 发有内容 有内涵 有意义的贴，原创内容，而不是纯扯淡」。
> 所以 SocialMate 的重点是**有观点、有信息量的原创内容**，以及**克制的互动**，而不是刷屏。

---

> 想把这套「操作 X」的能力直接给别的 agent 用？见姊妹项目
> **[agent-skill-forx](https://github.com/ccai40359-wq/agent-skill-forx)**
> —— Agent Skill + MCP server，把点赞、刷帖、互关、引用、评论做成 agent 的原生工具。

## 能做什么（功能总览）

每条线都可以在桌面端「设置 → 功能开关」里单独开/关。

| 功能 | 开关名 | 说明 |
|------|--------|------|
| 原创热点帖 | `post` | 基于 AIHOT 热点 / X 趋势，写**有观点、有信息量**的原创贴（可带来源链接）。 |
| 引用 + 评论 | `quote` | 引用别人的帖子，加上你自己的评论。**当作"评论"对待**，门槛更高（见下）。 |
| 随手扯淡 | `muse` | 被刷到的帖启发，说**你自己的话**，不引用、不带链接。 |
| 回复评论区 | `reply` | 回复**你自己帖子**下面的评论。 |
| 别人评论区互动 | `othersReply` | 去互关朋友的**评论区留言**（跟「引用」是两码事，不占用你的时间线）。 |
| 点赞 | `like` | 只点赞、不发言。 |
| 自动刷帖 | `browse` | 像真人一样刷一会儿时间线，让账号看起来更活跃。 |
| 涨粉 | `follow` | 主动关注粉丝数在 1 万以内的蓝V账号，并去他们帖子下评论互动。 |
| 回关 | `followBack` | 谁关注了你，就回关谁（只回关蓝V）。 |

**互动与涨粉**是一整套包装：关注蓝V + 去他们评论区互动 + 回关关注你的人，
目标是**提高你帖子下的互动**，而不是冷冰冰地刷数。

### 三线产出的节奏与闸门

同一条调度会产出不同性质的内容，各自有独立的**每日配额**与**冷却时间**（`config.json` 的 `gate.perKind`）：

| 线 | kind | 说明 | 默认日上限 | 默认冷却 |
|----|------|------|-----------|---------|
| 热点贴 | `post` | 原创热点分析 | 8/天 | 30 分钟 |
| 引用 | `quote` | 引用别人的帖 + 你的评论 | 7/天 | 30 分钟 |
| 随手扯淡 | `muse` | 即兴感想，不带链接 | 5/天 | 独立 |
| 回复 | `reply` | 回复自己帖子下的评论 | 10/天 | 独立 |
| 别人评论区 | `othersReply` | 去互关朋友评论区互动 | 40/天 | 0 分钟 |
| 点赞 | `engage` | 点赞 | 20/天 | 20 分钟 |
| 刷时间线 | `browse` | 刷一会儿 | 3/天 | 60 分钟 |
| 关注 | `follow` / `followBack` | 涨粉 / 回关 | 200 / 100 每日 | 2 / 1 分钟 |

> **为什么引用和 muse 的配额这么低？** 引用会把你的内容**直接推进对方的时间线**（对方和对方的
> 关注者都能看到），比发自己的原创帖危险得多；muse 没有素材兜底，一旦编造就是假消息。
> 所以两者配额都必须**低于**原创热点贴，而 muse 是最保守的一条，默认只先出草稿。

---

## 它是怎么工作的（一条内容的一生）

```
感知 (collect)          判断              行动 (publish)
─────────────         ─────────         ──────────────
AIHOT 热点   ┐
X 趋势       ├─► 候选池 ─► 打分/排序 ─► 生成文案 ─► 闸门检查 ─► 草稿 或 发布
X 搜索       │   (candidates.json)                    (gate.mjs)
关注时间线   ┘                                          │
                                                        ▼
                                              审核模式：进队列等你点「发布」
                                              全自动：检查通过直接发（仍需 --publish）
```

**采集与发布是分开的两轮**：同一轮里绝不「既抓又发」。这样任何一轮出问题都不会连累另一轮，
也便于你观察「它读到了什么」。

**闸门（gate.mjs）** 是发布前最后一道，会检查：
- 长度（太短/太长）、与历史重复度（防复读）、链接占比；
- 每日上限 + 冷却（`checkKindBudget`）；
- 内容安全（`safety.screenContent`：硬禁词 + 政治/财经风险类，默认关闭）；
- **空洞引用检测**：生成的评论若与原帖正文没有任何词交集，判为"空洞引用"并拒绝；
- **muse 专属护栏**：禁止任何 URL、禁止具体数字/人名/机构名/事件名（muse 没有素材兜底）。

**善后（feedback）** 会把你的每次审核判断记到 `queue/feedback.json`（approve / reject / edit），
作为下一轮生成的**上下文**（"最近被拒的例子，避免重犯"）。它只做上下文，**不变成发布硬闸门**。

---

## 快速开始（5 步跑起来）

> 前置：Windows + Node.js 20+（本仓库用 Node 24 开发）+ 已登录 X 的 Microsoft Edge。

### 1. 装依赖

```powershell
npm install
```

运行时依赖**只有 `playwright`** 一个；`electron` / `electron-builder` 是开发依赖（跑桌面端和打包用）。

### 2. 复制你自己的配置文件

```powershell
Copy-Item config.example.json config.json
```

`config.json` 是你自己的运行配置，已被 `.gitignore` 忽略（不会误传别人的配置上去，也不会覆盖你的）。

### 3. 接入你自己的模型（可跳过，先跑起来也行）

两种方式二选一：

```powershell
Copy-Item .env.example .env      # 方式 A：填 env（推荐，.env 被忽略）
# 或
Copy-Item provider.example.json provider.json   # 方式 B：填文件（provider.json 被忽略）
```

在文件里填上你的 `API Key`、`Base URL`、`模型名`。密钥读取优先级：**真实环境变量 > `.env` > `secrets.json`**。

### 4. 接入你的 X 登录态（关键一步）

SocialMate 不保存你的 X 密码，而是复制你本机 Edge 的登录态：

```powershell
# 1) 彻底关掉 Edge（数据被占用会复制失败）
Stop-Process -Name msedge -Force
# 2) 把 Edge 的 Default profile 复制进项目
node scripts/copy-edge-profile.mjs
```

它会复制 `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default`（以及解锁 Cookie 需要的 `Local State`）
到项目的 `edge-profile/`。**这是唯一一步手动操作浏览器的地方，之后都由 SocialMate 自己启动一个
独立的 Edge 实例来跑。**

> 应用会自动从 Edge 页面**实时识别**你已登录账号的昵称、handle 与真实头像；Edge 不在线时显示
> 上次缓存的账号（`cache/`），**不会编造**。换了 X 账号，重复第 4 步即可。

### 5. 打开它

```powershell
npm run app        # 开发模式：直接开桌面窗口
# 或
npm run server     # 只跑本地控制服务（浏览器访问 http://127.0.0.1:4173）
```

第一次打开会有一个**新手向导**（5 步）：选浏览器 → 登录 → 配模型（带连接测试）→ 选话题 → 设节奏。
向导**永远不会**把发布模式设成全自动，跑完仍是安全的**审核**模式。

---

## 两种运行模式

```powershell
node src/cli.mjs mode            # 查看当前模式
node src/cli.mjs mode review     # 审核模式（默认）：所有动作进草稿队列
node src/cli.mjs mode auto       # 全自动模式：检查通过就直接发
```

- **审核模式 `review`（默认）**：草稿是主角，发布是动作。它写好的内容先放队列，你点「发布」才真的发出去。
  新人不熟悉时选这个最稳。
- **全自动模式 `auto`**：它检查完安全就直接发到 X，中间没人再帮你看一遍。

> **硬规则（不可绕过）**：全自动也需要**本次调用显式加 `--publish`** 才会真正发布。
> 存储的偏好不算数，这是为了「改了设置结果它半夜开始疯狂发」这种事故不成立。

---

## 桌面端界面说明

单窗口，左侧导航，右上角**常驻「暂停」紧急制动**。

### 仪表盘
回答一个问题：**「它现在在干什么，正常吗？」**
- 状态卡（4 宫格）：今日发布 / 今日引用 / 今日回复 / 待审草稿。
- 运行状态：守护进程「运行中 (PID)」/「已停止」+ 启动/停止按钮；下次动作；当前模式徽章（审核=橙 / 全自动=红）。
- 内容池：候选总数、其中带 X 原始帖的数量，附「刷新」。
- 日志流：最近 40 行，等宽、可滚动、每 5 秒刷新；错误行标红。

### 队列（核心页面）
回答：**「它准备发什么，我要不要放行？」**
- 每项左边是 kind 徽章（原创 / 引用 / 回复 / 扯淡 …）。
- 引用/原创显示目标推文链接；回复显示「回复 @someone」+ 对方原话（灰色引用块）+ 你的草稿。
- 正文**内联可编辑**（点击变输入框，失焦或 `Ctrl+Enter` 保存）。
- 每项两个动作：`发布`（主按钮）、`丢弃`（可选填一个拒绝理由：太长/重复/语气不对/事实错/不相关/其他）。
- 顶部：待审计数 + `全部发布`（危险按钮，需二次确认）。

### 模型
回答：**「我的大脑接好了吗？」**
- 协议（OpenAI 兼容 / Anthropic / OpenAI Responses）、Base URL、API Key、主模型、廉价模型。
- `测试连接`：成功显示 `✓ 连接正常 · 1234 毫秒 · 模型名`；失败显示具体错误。

### 设置
回答：**「它的节奏和边界是什么？」**
- **功能开关**：上表 9 条线各自的开/关（每个开关都有讲人话的说明）。
- **发布节奏**：每日目标、引用占比、活跃时段、每条线的**每日上限 / 冷却分钟数**（数字框）。
- **模式**：审核 / 全自动（全自动需二次确认，并有风险说明）。
- **语气**：启用语气学习开关 + 语气模型。
- **拟人化**：打字延时区间等（高级项）。
- **安全**：允许财经类 / 允许政治类内容——**默认全部关闭**，开启需二次确认。

---

## 配置详解 `config.json`

从 `config.example.json` 复制而来。常用字段：

| 字段 | 默认 | 含义 |
|------|------|------|
| `autoMode` | `"review"` | `review`（默认）或 `auto`。 |
| `dailyTarget` | `20` | 每天目标条数（含草稿与已发）。 |
| `quoteRatio` | `0.3` | 引用帖在内容里的占比（0-1）。 |
| `minGapMinutes` / `maxGapMinutes` | `30` / `50` | 发布间隔的「下限 / 上限（分钟）」。两者都设时每轮在区间内**随机**取值；只设下限则固定间隔。 |
| `activeHours` | `{start:8,end:23}` | 只在此时段内发帖（夜间静默）。 |
| `replyScan.intervalMinutes` | `45` | 多久扫一次自己帖子的评论。 |
| `replyScan.maxAgeHours` | `48` | 只处理多少小时内的新评论。 |
| `topicSeeds` | 见下 | 关键词种子。**别用裸「AI」**：它会命中所有语言里的 ai 音节，把池子污染。 |
| `features` | 见 `config.example.json` | 9 条功能线的开/关。 |
| `gate.perKind` | 见 `config.example.json` | 每条线的每日上限与冷却。 |
| `safety.allowPolitics` / `allowFinance` | `false` / `false` | 政治 / 财经类内容开关，默认关。 |
| `topicPostRequiresSource` | `true` | 有选题的帖子必须带来源链接或引用，避免"别人不知道你在说什么"。 |
| `perceive.minLikes` | `10` | 候选入池的最低点赞门槛。 |
| `humanize.enabled` | `true` | 拟人化输入（真人般的打字节奏）。 |
| `voiceEnabled` / `voiceModel` | `true` / 模型名 | 语气学习开关与所用模型。 |

> 「发布节奏」页的数字框会在你改完后**立刻落盘**，并被守护进程读到（热重载）。

---

## 模型接入

`src/llm.mjs` 支持三种协议，一套调用形状：**OpenAI 兼容 / Anthropic / OpenAI Responses**。
配置从 `provider.json` + `secrets.json` + env/`.env` 读取，**永不写日志**。

- **`provider.json`**（或 `provider.example.json` 复制而来）：`protocol` / `baseURL` / `model` / `cheapModel`。
- **密钥**：放 `secrets.json`（`{"apiKey": "..."}`）或 `.env`（`OPENAI_API_KEY=...`）。
  优先级：**真实环境变量 > `.env` > `secrets.json`**。
- **双模型档位**：主模型写内容，`cheapModel` 做打分等便宜活。
- **降级**：模型不可用时，生成会走模板兜底并在日志标 `DEGRADED`，**不会因此清空内容池或崩溃**。
- **推理模型提示**：推理模型的思考 token 会先吃掉预算；留足 `max_tokens`，否则正文可能为空。

---

## 命令速查

```powershell
# 运行
npm run app                     # 桌面窗口
npm run server                  # 本地控制服务（127.0.0.1:4173）
npm start                       # 启动调度器（守护进程）
npm run once                    # 只跑一轮内容
npm run dryrun                  # 空跑：只打印它打算做什么，不发布

# 模式与草稿
node src/cli.mjs mode review    # 切到审核模式
node src/cli.mjs drafts         # 看待审草稿
node src/cli.mjs approve 3      # 发布 3 号草稿（会真的发到 X）
node src/cli.mjs approve-all    # 全部发布
node src/cli.mjs reject 3       # 丢弃 3 号草稿

# 状态与内容
node src/cli.mjs status         # 账号、今日计数、内容池概览
node src/cli.mjs pool           # 刷新 AIHOT 内容池
node src/cli.mjs post           # 立即发一条快讯
node src/cli.mjs scan-replies   # 列出别人对我帖子的新回复 + 建议回复
node src/cli.mjs quote <url> <评论>
node src/cli.mjs reply <url> <回复>

# 浏览器与打包
npm run copy-profile            # 复制 Edge profile（Edge 需完全关闭）
npm run dist                    # electron-builder 打 Windows 便携版 exe
npm run verify:packaged         # 验证打包版能正常冷启动
```

`approve` / `approve-all` / `post` / `quote` / `reply` 在没有显式 `--publish` 时，**审核模式下只入草稿**。

---

## 数据与文件在哪

```
推特自动发帖\
├── app/                  # 桌面端（Electron 外壳 + 渲染层）
├── src/                  # 大脑：采集/生成/闸门/发布/控制服务
├── scripts/              # 测试、截图、打包验证、工具脚本
├── config.json           # ← 你的运行配置（被 git 忽略）
├── config.example.json   # ← 提交进仓库的安全默认模板
├── provider.json         # ← 你的模型接入（被忽略）
├── secrets.json          # ← 你的密钥（被忽略，绝不提交）
├── .env                  # ← 你的密钥（被忽略）
├── edge-profile/         # ← 你的 Edge 登录态副本（被忽略）
├── voice.seed.json       # ← 你的语气种子（被忽略），示例见 voice.seed.example.json
├── queue/                # 草稿、候选池、已发历史、反馈（运行态，被忽略）
├── cache/                # 账号/头像缓存（运行态，被忽略）
├── shots/                # 截图（运行态，被忽略）
├── log.txt               # 日志（被忽略）
├── state.json            # 今日计数等运行态（被忽略）
├── control.json          # 暂停开关 + 当前模式（被忽略）
└── dist/                 # 打包产物（被忽略）
```

**哪些文件会被提交进仓库**：只有源码、`app/`、`scripts/`、文档、`config.example.json`、
`provider.example.json`、`voice.seed.example.json`、`.env.example`、`LICENSE` 等。
所有**密钥、登录态、运行数据**都被 `.gitignore` 挡住。

---

## 打包成 exe 与分发

```powershell
npm run dist      # 产物：dist/SocialMate-<版本>-portable.exe（约 75MB）
```

打包**刻意排除**了登录态与密钥：`edge-profile/`、`secrets.json`、`.env`、`provider.json`、
`config.json`、`queue/`、`state.json`、`control.json` 都不会进安装包——这是为了避免把凭据
打进可分发文件。**首次双击 exe 会从 `config.example.json` 生成一份安全的默认配置
（审核模式、涨粉/回关默认关闭）。**

### 两种打开方式

- **推荐：双击仓库根目录的 `SocialMate.bat`。**
  它把打包版的「数据根」钉在**当前仓库目录**（设 `SOCIALMATE_DATA_DIR`），于是打包版复用你
  已经登录的 `edge-profile/`、`secrets.json`、`provider.json`、`config.json`、`queue/` 与 `log.txt`——
  **双击即用**，数据仍在本目录。
- **直接双击 `dist\SocialMate-*-portable.exe`。**
  数据根默认落在 `%APPDATA%\socialmate`（一份全新的空数据目录，**没有** Edge 登录态）。
  此时需要在那个目录里重新放好 `secrets.json` / `provider.json` 并重新登录 X，或者改用上面的 `.bat`。

> 发版建议：把 exe 作为 **GitHub Release 附件**上传，而不是提交进 git 仓库（75MB 二进制不适合进版本库）。

---

## 隐私与密钥安全

- **密钥永不进入**：API 返回体、日志、截图、提交物。
- **密钥只从** env / `.env` / `secrets.json` 读取；`.env`、`secrets.json`、`provider.json` 均在 `.gitignore` 中。
- **登录态只在本机**：`edge-profile/` 是你 Edge 的副本，只用于本地，永不提交、永不打包。
- 提交前请自查：`git status` 里不应出现任何 `.env` / `secrets.json` / `edge-profile/` / `queue/` / `state.json`。

---

## 常见问题

**Q：第一次打开是全自动吗？**
不是。默认永远是**审核模式**（`review`），并且全自动也需要每次显式 `--publish` 才真发。

**Q：它会不会保存我的 X 密码？**
不会。它只用你本机 Edge 的登录态副本，不接触密码。

**Q：提示 `Profile copy missing`（找不到 edge-profile）。**
Edge 没关干净或还没复制。关掉 Edge（`Stop-Process -Name msedge -Force`）后跑 `node scripts/copy-edge-profile.mjs`。

**Q：模型连不上 / 正文是空的。**
先点「模型」页的「测试连接」看具体错误。推理模型请留足 `max_tokens`；密钥/Base URL 不对也会连不上。

**Q：我改了设置但它还是老样子。**
守护进程在每个循环开头都会**重新读** `config.json`（热重载）；少数字段（如 `stateFile` / `cdpPort`）需重启。

**Q：内容池是空的 / 候选很少。**
跑 `node src/cli.mjs pool` 刷新；或等一轮 collect。点赞门槛 `perceive.minLikes` 太高也会让池子变小。

**Q：账号切换了怎么办？**
重做第 4 步（关 Edge → 复制 profile → 重启），它会重新识别新账号的昵称与头像。

---

## 反检测设计（尽量不像机器人）

> 结论先说：SocialMate **不做指纹伪造**，走的是「真实环境 + 真人行为」路线。
> 检测系统看的是**异常**，不是「自动化」本身；所有设计都围绕「不产生异常」。

### 1) 环境层：用真东西，不伪装

- **真实浏览器二进制**：直接启动你本机安装的 **Microsoft Edge**（`config.json` 的 `edgePath`），
  不是 Chromium 替身、不是无头内核。TLS 指纹、字体、WebGL、扩展都和你平时上网一致。
- **真实登录会话副本**：复制你 Edge 的 profile（`scripts/copy-edge-profile.mjs`），
  **不保存密码、不模拟登录**，Cookie 是真实会话。
- **本机家用 IP**：走你自己的网络出口，**不是**数据中心/云服务器 IP（这是最容易被判定的一类）。
- **不做指纹伪造**：不覆盖 `navigator.webdriver`、不注入 stealth 脚本——
  伪造反而更容易自相矛盾被识别。我们只保证「真」。
- **独立 Profile 副本**：用单独一份数据目录，避免和你的日常窗口争抢会话。
- **零无头**：全程可见窗口（`--no-first-run` / `--no-default-browser-check` 等只是减少干扰弹窗）。

### 2) 行为层（`src/humanize.mjs`）

- **逐字符打字**：`typeHuman` 按 30–100ms/字符随机输入，CJK 再 ×1.3 停留；
  **避免** `insertText` 一次性灌入（这是最响亮的自动化特征之一）。
- **思考停顿**：`thinkPause` 在动作之间插入 2–5 秒随机停顿；小概率在中途加长，像在斟酌用词。
- **预热滚动**：`scrollWarmup` 操作前先滚 3–5 次（步长 200–900，偶尔反向）。
- **鼠标轨迹**：`moveHuman` 用 smoothstep 缓动、8–20 步逼近目标点（带 ±3px 抖动），
  **不是瞬移点击**；`clickHuman` 先移动到位再点。
- **非发布动作穿插**：点赞（`like`）、刷时间线（`browse`）让账号行为像人，而不是只发帖。
- **零碎分钟调度 + 抖动**：发布时刻落在**离散的「非整点分钟」**（`OFF_MINUTES = 3/7/11/17/23/33/41/47/51/53`），
  再叠加秒级抖动——**不会**每分钟整点准点发，两次也不会共享同一时间戳。
- **随机间隔**：`minGapMinutes`–`maxGapMinutes` 区间内每轮随机取值（例：30–50 分钟），
  不是固定周期。
- **夜间静默**：`activeHours`（默认 8–23 点）之外不动作。
- **采集与发布分属两轮**：同一轮里**绝不**既抓又发（见 `run.mjs` 的 I2 隔离）。

### 3) 内容层（避免「同一条内容发一万个号」）

- **模板轮换 + 语气学习**：文案由你自己的语气画像驱动，**每个用户的产出不同**，
  避免大量账号发同一条标题被 X 关联（这是开源版最大的隐性风险）。
- **闸门防复读**：`gate.mjs` 检查与历史内容的相似度（`maxSimilarity`），过高直接拒绝。
- **控制外链比例**：不必每条都带外链，`topicPostRequiresSource` 只要求「有选题时」带来源。
- **风险梯度**：政治/财经类内容**默认关闭**，需手动开启并二次确认——
  政治类触及 X 的「协同性不真实行为」政策，是封号最快的一类。

### 4) 撞上风控怎么办（`src/safety.mjs`）

- `detectBlock` 会识别 **验证码 / 账号锁定 / 限流 / 掉登录 / 动作被拦**，并**立即暂停**守护进程
  （写入 `control.json` 的 `paused=true` + 原因），同时**截图留证**到 `shots/`，而不是继续硬撞。
- 触发风控后请**人工处理**（手动完成验证、降低配额、拉长冷却），不要立刻重试。

> ⚠️ **重要**：以上只**降低**被判定为自动化的概率，**不能消除**风险。
> 自动化操作本身违反 X 的服务条款，最终风险由使用者自行承担。

---

## 已知限制

- **平台**：目前只在 Windows 上验证（依赖 Edge 路径与 `%LOCALAPPDATA%`）。
- **限流**：X 有速率限制，采集/互动过快会被限流甚至触发验证；请把冷却与上限当**安全阀**，别拉满。
- **窗口宽度**：桌面端为 1100×760 设计，最小 900×620。
- **语气学习**：首次需要先采集你自己的帖子（见下）才有可用的语气画像；没有时只能用通用文案。
- **AIHOT 依赖**：热点发现依赖 aihot.news 的可达性；不可达时会退回 X 搜索/趋势。

---

## 风险与合规

**自动化操作违反 X 的服务条款，账号风险自行承担。** SocialMate 的设计尽量贴近真人
（本机 IP + 真实浏览器二进制 + 真人打字节奏 + 真人级间隔），但这只降低风险、**不能消除**。
请务必：
- 保持**审核模式**、从小配额开始；
- 引用/扯淡这类高风险线配额**低于**原创；
- 不要 24 小时连轴转，善用 `activeHours` 与暂停。

---

## 参与贡献 / 许可证

- **许可证**：MIT（见 [`LICENSE`](LICENSE)），可自由使用、修改与再分发。
- **贡献**：欢迎 issue 与 PR（功能建议、文案、界面打磨、Edge/浏览器适配都算）。
  提交前请先跑测试（见下）。
- **测试**：`npm test`（集成验收）+ `scripts/` 下的各套回归，例如：

```powershell
npm test
node scripts/test-server.mjs
node scripts/test-daemon.mjs
node scripts/test-p0-acceptance.mjs
```

---

## 附带模块（非推特）

`src/leadgen/` 与 `src/leads-api.mjs` 是一个**其他平台**（小红书 / Facebook / Threads）的线索雷达，
不属于推特功能，也和 SocialMate 的产品定位不同。它目前只为回归测试而保留，默认不参与推特流程。
如果你只关心推特，可以忽略这一块。