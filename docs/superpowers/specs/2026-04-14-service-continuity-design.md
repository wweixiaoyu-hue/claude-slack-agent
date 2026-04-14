# Slack Agent 服务持续性设计

**日期：** 2026-04-14
**状态：** Draft
**作者：** wangyu + Claude

## 背景与问题

当前 Slack Agent 在以下两种情况下会失去可用性，且没有恢复机制：

1. **Claude Code 长时间不回复** —— 父进程卡住但未崩溃，MCP 子进程依然能收到 Slack 消息，但发出的 notification 没人响应，整条队列一直堆积
2. **认证过期** —— Claude Code 的 claude.ai 浏览器登录 session 定期过期，导致处理不了新请求。实践验证，**重启 Claude Code 进程即可恢复**（不需要重走浏览器登录）

共同解法：**重启 Claude Code 父进程**。缺的是"谁来触发重启、谁来拉起"。

## 目标

- 用户能从手机 Slack DM 手动触发 Claude Code 重启
- Claude Code 进程意外退出后能自动被拉起（无人干预）
- 重启过程对正在处理/排队的消息有明确的语义（不是默默丢失）
- 对现有代码改动最小，不引入新依赖

## 非目标（YAGNI）

- 自动检测 Claude Code 卡死并自动重启（容易误判长任务，用户明确选择手动触发）
- 机器重启后自动恢复服务（后续增量，本次不做）
- 队列/会话历史跨进程持久化（重启即丢失，这是刻意的权衡）
- 多机器热备 / 高可用集群

## 架构

```
start-slack.bat (无限循环 wrapper)
     │
     └─ claude --... server:slack   ← 外层，Claude Code CLI 父进程
              │
              └─ npx tsx slack-channel.ts  ← 内层，MCP server 子进程

父进程 (claude) 死 → 子进程 (MCP) stdin EOF → MCP 自行退出
→ wrapper bat 检测到 claude 退出 → 3s 后 goto loop 再拉起
```

### 关键洞察

MCP 虽然是 Claude Code 的子进程，但 MCP 进程本身运行独立的 Node.js 事件循环，有自己的 Slack WebSocket 连接。即使 Claude Code 卡在某个 LLM 调用上不响应 MCP notification，**MCP 依然能正常收到 Slack 消息并执行代码路径**。这正是"从 Slack 手动触发重启"能救活一个卡死 Claude Code 的底层原因。

## 组件 1：Wrapper 循环脚本（`start-slack.bat`）

**职责：** 无限拉起 Claude Code，崩溃或主动退出后 3 秒内重启。

**替换现有 3 行 `start-slack.bat` 为：**

```bat
@echo off
cd /d D:\Code\claude-slack-agent
:loop
echo [%date% %time%] Starting Claude Code...
claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack
echo [%date% %time%] Exited with code %ERRORLEVEL%, restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
```

**设计说明：**
- 3 秒延迟防止 Claude Code 启动失败时造成紧循环打满 CPU
- `echo` 会在终端显示启停时间，便于人工观察
- 不捕获 Ctrl+C：用户按 Ctrl+C 应当能真正停止服务（场景：运维、调试）。Ctrl+C 后 `goto loop` 也会因为 claude 收到信号而退出整个 bat。

## 组件 2：Slack DM 重启指令（`slack-channel.ts`）

### 指令规范

| 项 | 规则 |
|---|---|
| 触发关键词 | `!restart`（严格匹配，`text.trim() === '!restart'`） |
| 触发范围 | **仅 DM**（`channel_id` 以 `D` 开头）。公共/私有频道里发 `!restart` 一律忽略 |
| 权限 | 必须在现有 `allowlist` 白名单内 |
| 冷却期 | 30 秒。内存变量 `lastRestartAt`，重启后自然清零（因为整个 MCP 进程重建） |

### 执行流程

```
收到 slack message 事件
  ↓
现有过滤（type, subtype, bot_id, 文件附件拼接, allowlist 门控）
  ↓
新增拦截：is DM && text.trim() === '!restart' ?
  ↓ (yes)
handleRestartCommand(channel, messageTs, userName)
  ↓
check cooldown (Date.now() - lastRestartAt < 30000)
  ├─ yes → DM 回复 "冷却中，请 Xs 后再试" → return
  └─ no ↓
lastRestartAt = Date.now()
  ↓
统计 unfinished: queue.filter(m => m.status === 'queued').length + (currentMessage ? 1 : 0)
  ↓
DM 回复汇总消息:
  "收到重启指令。
   处理中: N 条 (from X: "...")
   队列中: M 条
   全部标记为失败。
   正在杀掉 PID <ppid>..."
  ↓
对每条未完成消息:
  - setReaction(channel, ts, 'x', 旧emoji)
  - writeLog({event: 'failed', id, error: 'restart triggered'})
  ↓
writeLog({event: 'restart_triggered', trigger_user: userName, ppid: process.ppid, unfinished_count})
  ↓
child_process.exec('taskkill /PID ' + process.ppid + ' /F')
  ↓
Claude Code 退出 → MCP stdin EOF → MCP 自行退出 → wrapper 重启
```

### 插入位置

在 `slack-channel.ts` 现有 `slackApp.message` handler 中，**allowlist 门控之后、用户名解析之前**：

```typescript
// Gate on allowlist
if (!allowlist.has(user)) return

// === NEW: restart command interception ===
if (channel.startsWith('D') && text.trim() === '!restart') {
  await handleRestartCommand(channel, messageTs, user)
  return
}

// === 原有逻辑继续：resolve user display name → enqueue ===
```

将 `userName` 解析放到 restart 检查之后，避免不必要的 API 调用。

### `handleRestartCommand` 函数

```typescript
const RESTART_COOLDOWN_MS = 30_000
let lastRestartAt = 0

async function handleRestartCommand(
  channel: string,
  messageTs: string,
  userId: string,
): Promise<void> {
  const now = Date.now()
  const since = now - lastRestartAt

  if (since < RESTART_COOLDOWN_MS) {
    const remaining = Math.ceil((RESTART_COOLDOWN_MS - since) / 1000)
    await slackApp.client.chat.postMessage({
      channel,
      text: `冷却中，请 ${remaining}s 后再试`,
    }).catch(() => {})
    return
  }
  lastRestartAt = now

  // 解析触发者姓名（用于日志）
  let triggerName = 'unknown'
  try {
    const u = await slackApp.client.users.info({ user: userId })
    triggerName = (u.user as any)?.real_name || (u.user as any)?.name || userId
  } catch { /* ignore */ }

  // 统计 unfinished
  const queuedCount = queue.filter(m => m.status === 'queued').length
  const processing = currentMessage
  const unfinishedTotal = queuedCount + (processing ? 1 : 0)

  // 构造汇总消息
  let summary = `收到重启指令 (来自 ${triggerName})。\n`
  if (processing) {
    summary += `处理中: 1 条 (来自 ${processing.user_name}: "${processing.text.substring(0, 60)}...")\n`
  } else {
    summary += `处理中: 0 条\n`
  }
  summary += `队列中: ${queuedCount} 条\n`
  if (unfinishedTotal > 0) summary += `全部标记为失败。\n`
  summary += `正在杀掉 PID ${process.ppid}...`

  await slackApp.client.chat.postMessage({ channel, text: summary }).catch(() => {})

  // 标记所有未完成消息为失败（包含 timeout 状态 —— 它们也从未完成）
  const toFail = queue.filter(m =>
    m.status === 'queued' || m.status === 'processing' || m.status === 'timeout'
  )
  for (const m of toFail) {
    m.status = 'failed'
    m.error = 'restart triggered'
    await setReaction(m.channel_id, m.message_ts, 'x').catch(() => {})
    writeLog({ event: 'failed', id: m.id, error: 'restart triggered' })
  }

  writeLog({
    event: 'restart_triggered',
    trigger_user: triggerName,
    ppid: process.ppid,
    unfinished_count: unfinishedTotal,
  } as any)  // extend LogEntry type to include these fields

  // 杀父进程 —— Claude Code 退出会导致 MCP stdin EOF，自然退出
  const { exec } = await import('child_process')
  exec(`taskkill /PID ${process.ppid} /F`, (err) => {
    if (err) console.error('[restart] taskkill failed:', err.message)
  })
}
```

### 类型扩展

`LogEvent` 联合类型增加 `'restart_triggered'`：

```typescript
type LogEvent =
  | 'process_started' | 'enqueued' | 'processing_started'
  | 'heartbeat' | 'completed' | 'timeout' | 'failed'
  | 'restart_triggered'  // NEW
```

`LogEntry` interface 增加可选字段：

```typescript
interface LogEntry {
  // ... 现有字段 ...
  trigger_user?: string       // NEW: 谁触发了重启
  ppid?: number               // NEW: 被杀的父进程 PID
  unfinished_count?: number   // NEW: 重启时被标记失败的消息数
}
```

### 实现说明（避免过度清理）

以下清理逻辑**不需要**在 `handleRestartCommand` 里写——因为 MCP 进程紧接着就会整体退出：

- 不需要调用 `stopTimer()`——heartbeat 定时器随进程退出自动清除
- 不需要清理 `conversations` Map（30 分钟内的历史会话上下文）——随进程退出丢失。这是**刻意的**：重启的代价就是所有内存状态归零，与"YAGNI：不做跨进程持久化"一致，用户预期明确
- 汇总消息的 `chat.postMessage` 用 `.catch(() => {})` 包住，即使发送失败也继续执行 taskkill——卡死场景下 Slack API 可能也慢，但必须确保 kill 路径不被阻塞

## 组件 3：文档更新（`DEPLOY.md`）

在现有 "后台运行" 章节后，新增一节：

```markdown
## 服务持续性与重启

### Wrapper 循环自动拉起

`start-slack.bat` 是一个无限循环脚本。Claude Code 正常退出、崩溃、或被
外部信号杀死，bat 会在 3 秒后自动重新启动。机器关机前不需要手动干预。

### 手动触发重启（Slack DM）

场景：Claude Code 长时间不响应（卡住）或你怀疑认证过期。

1. 在与 bot 的 **私聊（DM）** 中发送一条消息，内容严格为：`!restart`
2. Bot 会在 DM 里回复当前队列状态和即将被杀的 PID
3. Claude Code 进程被杀 → wrapper 脚本 3 秒后重启 → 新服务上线
4. 全程中断约 5–10 秒

**限制：**
- 只限 DM，公共/私有频道里发 `!restart` 会被忽略
- 必须是白名单用户
- 30 秒冷却期（防止手抖重复触发）
- 重启时"处理中"和"队列中"的消息都会被标记为失败（❌ emoji），不会自动重试

### 日志中的重启事件

```bash
cat ~/.claude/channels/slack/logs/*.jsonl | jq 'select(.event == "restart_triggered")'
```

每次重启会记录：触发用户、被杀 PID、被丢弃的消息数、时间戳。
```

## 验证方式

**手动集成测试清单：**

1. ✅ 正常启动：运行 `start-slack.bat`，看到日志 `process_started`，Slack 发消息能正常回复
2. ✅ 主动 kill：用任务管理器结束 claude 进程，观察 wrapper 在 3 秒内拉起新进程
3. ✅ DM 触发重启：在 DM 发 `!restart`，验证：
   - 收到汇总回复
   - 处理中/排队消息被打 ❌
   - 日志有 `restart_triggered` 和 `failed` 两类条目
   - 5–10 秒内服务恢复，新消息能处理
4. ✅ 冷却期：连续两次 `!restart`，第二次应回 "冷却中，请 Xs 后再试"
5. ✅ 频道里发 `!restart`：无反应（仅日志或无日志），不会重启
6. ✅ 非白名单用户 DM `!restart`：无反应

**不需要自动化测试：** 所有逻辑都是 IO 密集型（Slack API / 进程控制 / 文件系统），单元测试的桩成本高于手测收益。

## 回退方案

- 如果 `!restart` 实现有 bug 导致误触发，只需把 `slack-channel.ts` 里拦截 `!restart` 的那两行删掉即可回退为原行为
- 如果 `start-slack.bat` 的循环不想要了，回到原始 3 行版本即可
- 所有改动集中在两个文件，Git revert 一次提交即可完全复原

## 开放问题

- **Q：** Windows 上 `taskkill /F` 杀 claude 会不会把还在传输中的 Slack 回复截断？
  **A：** 可能，但这是"卡死后必须重启"的合理代价。正在传输的回复本来就不完整，用户会看到 ❌ 状态明确知道失败了。

- **Q：** 如果 `!restart` 被恶意用户发送怎么办？
  **A：** Allowlist 已经是硬门控，白名单外的用户根本进不了 handler。DM + allowlist + 30s 冷却三层就够了。

- **Q：** MCP 会不会在 taskkill 完成前就被 /T 连带杀掉，导致汇总消息没发出去？
  **A：** 使用 `taskkill /PID <ppid> /F`（不加 /T），只杀 claude。MCP 的死是通过 stdin EOF 被动触发的异步过程，汇总消息的 `chat.postMessage` await 会在 `exec` 之前完成。
