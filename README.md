# X 媒体助手（media-agent 雏形）

用你自己的 Edge 登录态运行，内容来自 AIHOT 实时热点，**展示链接指向原文官方来源**（不是 AIHOT 中转页）。
支持：发帖、引用+评论、回复自己帖子的评论。默认**审核模式**。

## 两种模式

```powershell
node src/cli.mjs mode            # 查看当前模式
node src/cli.mjs mode review     # 审核模式（默认）：所有动作进草稿队列
node src/cli.mjs mode auto       # 全自动模式：直接发布
```

## 草稿审核闭环

```powershell
node src/cli.mjs drafts          # 查看待审草稿（帖子/引用/回复）
node src/cli.mjs approve 3       # 发布 3 号草稿
node src/cli.mjs approve-all     # 全部发布
node src/cli.mjs reject 3        # 丢弃 3 号草稿
```

## 回复自己帖子的评论

```powershell
node src/cli.mjs scan-replies    # 列出别人对我帖子的新回复 + 建议回复
```

调度器每 45 分钟自动扫一次（`config.json` 里 `replyScan.intervalMinutes`），审核模式下生成回复草稿等你批。

## 其他命令

```powershell
node src/cli.mjs status          # 账号、今日计数、内容池概览
node src/cli.mjs pool            # 刷新 AIHOT 内容池
node src/cli.mjs post            # 立即发一条快讯
node src/cli.mjs quote <url> <评论>
node src/cli.mjs reply <url> <回复>

node src/run.mjs                 # 启动调度器
node src/run.mjs --once          # 只跑一轮内容
```

## 配置 `config.json`

- `autoMode`：`review`（默认）或 `auto`
- `dailyTarget`：每天目标条数（默认 20，含草稿与已发）
- `quoteRatio`：引用帖占比（默认 0.4）
- `replyScan.intervalMinutes`：扫描自己帖子评论的频率
- `replyScan.maxAgeHours`：只处理多少小时内的新评论
- `activeHours`：发帖时段，`{"start":7,"end":24}` 可限制为白天

## 内容来源策略

- **发现层**：AIHOT（每日新话题 + 中文摘要）
- **引用目标**：优先用 AIHOT 条目的「原文」——官方博客或 X 官方账号原帖
- **兜底**：X 搜索（带最低点赞门槛），只有原帖不是 X 时才用

## 登录态失效

1. 彻底关闭 Edge：`Stop-Process -Name msedge -Force`
2. `Remove-Item -Recurse -Force edge-profile`
3. `node scripts/copy-edge-profile.mjs`
4. 重启调度器

## 注意

日志在 `log.txt`，草稿在 `queue/drafts.json`，截图在 `shots/`。
自动化操作违反 X 服务条款，账号风险自行承担。
