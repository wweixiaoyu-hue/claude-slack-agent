# Service Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user recover the Slack Agent from hangs and auth-expired states by sending `!restart` in a Slack DM, and make Claude Code auto-restart on any crash.

**Architecture:** A Windows batch-file wrapper loop infinitely respawns Claude Code. Inside `slack-channel.ts` (the MCP child), we intercept a narrow `!restart` DM command from the allowlist, mark unfinished messages failed, announce in DM, and `taskkill /F` the parent Claude Code process. Process death cascades down via stdin-EOF so the wrapper can restart everything clean.

**Tech Stack:** TypeScript + Node.js (existing `slack-channel.ts`), `@slack/bolt` (Socket Mode), Windows `cmd.exe` batch wrapper, Windows `taskkill`. No new dependencies.

**Testing approach:** This project has no test framework (confirmed: `package.json` has no test script, no test runner in devDependencies). The spec explicitly calls out manual integration testing as the appropriate choice given every code path is IO-bound (Slack API, process control, file system). Each task below includes a manual verification checklist in place of automated tests.

**Reference spec:** [docs/superpowers/specs/2026-04-14-service-continuity-design.md](../specs/2026-04-14-service-continuity-design.md)

---

## File Structure

| File | Change Type | Responsibility |
|---|---|---|
| `start-slack.bat` | Modify (rewrite) | Infinite-loop wrapper that respawns Claude Code on any exit |
| `slack-channel.ts` | Modify | Add `!restart` command interception + `handleRestartCommand` function + new log event type |
| `DEPLOY.md` | Modify | Document wrapper-loop behavior and `!restart` usage |

All changes are additive within `slack-channel.ts` — no existing code paths are modified or removed except for adding a 4-line interception block in the message handler.

---

## Task 1: Update `start-slack.bat` to wrapper loop

**Files:**
- Modify: `start-slack.bat`

**Why first:** If later tasks break the MCP server, the wrapper loop already being in place ensures we can still reach a working state by exiting and restarting manually. Also lets us test auto-respawn independently.

- [ ] **Step 1: Rewrite `start-slack.bat`**

Replace the entire contents with:

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

- [ ] **Step 2: Verify auto-respawn works**

Run: `start-slack.bat` in a Windows terminal.

Expected:
1. Terminal prints `[<date> <time>] Starting Claude Code...`
2. Claude Code launches and connects to Slack
3. Open Task Manager, end the `claude.exe` process
4. Terminal prints `Exited with code ...` and after 3 seconds prints `Starting Claude Code...` again
5. Claude Code reconnects

If step 4 does not happen, check that `goto loop` is on its own line and the label `:loop` is spelled correctly. The `timeout /t 3 /nobreak >nul` must include `>nul` to suppress `timeout`'s countdown output or stdout will be noisy.

- [ ] **Step 3: Verify Ctrl+C stops the loop**

With the wrapper running and Claude Code alive, press Ctrl+C in the wrapper terminal.

Expected: The batch file exits entirely (both `claude` and the loop itself terminate). Does NOT enter another `goto loop` iteration.

This is important: operators need a clean way to fully stop the service. If Ctrl+C enters another iteration, the user can never stop it without Task Manager.

- [ ] **Step 4: Commit**

```bash
git add start-slack.bat
git commit -m "feat: make start-slack.bat auto-respawn Claude Code on exit"
```

---

## Task 2: Extend log types in `slack-channel.ts`

**Files:**
- Modify: [slack-channel.ts:143-155](slack-channel.ts#L143-L155)

**Why:** Tiny, isolated type-only change that the later restart logic depends on. Keeping it in its own commit makes later diffs clean.

- [ ] **Step 1: Add `restart_triggered` to `LogEvent` union**

Find the existing definition at [slack-channel.ts:143](slack-channel.ts#L143):

```typescript
type LogEvent = 'process_started' | 'enqueued' | 'processing_started' | 'heartbeat' | 'completed' | 'timeout' | 'failed'
```

Replace with:

```typescript
type LogEvent = 'process_started' | 'enqueued' | 'processing_started' | 'heartbeat' | 'completed' | 'timeout' | 'failed' | 'restart_triggered'
```

- [ ] **Step 2: Extend `LogEntry` interface with restart fields**

Find the existing `LogEntry` at [slack-channel.ts:145-155](slack-channel.ts#L145-L155) and add three optional fields:

```typescript
interface LogEntry {
  event: LogEvent
  id?: string
  user?: string
  text?: string
  queue_length?: number
  elapsed_s?: number
  duration_s?: number
  was_timeout?: boolean
  error?: string
  trigger_user?: string       // NEW: for restart_triggered
  ppid?: number               // NEW: for restart_triggered
  unfinished_count?: number   // NEW: for restart_triggered
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors (or only errors pre-existing and unrelated to these lines).

If errors appear specifically about `LogEvent` or `LogEntry`, double-check the exact type names match the existing casing in the file.

- [ ] **Step 4: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add restart_triggered log event type"
```

---

## Task 3: Implement `handleRestartCommand` function

**Files:**
- Modify: `slack-channel.ts` (add new function + module-level state)

**Why:** Self-contained function, easy to read in isolation. Not yet wired into the message handler — that's Task 4 — so the behavior change isn't live yet.

- [ ] **Step 1: Add cooldown constants and state**

Find the `// ========== Helpers ==========` section around [slack-channel.ts:120](slack-channel.ts#L120) and below the existing constants (SLACK_MAX_LENGTH, TIMEOUT_S, etc.), add:

```typescript
const RESTART_COOLDOWN_MS = 30_000
let lastRestartAt = 0
```

- [ ] **Step 2: Add `handleRestartCommand` function**

Add this function after the `// ========== Queue Functions ==========` block (after `startTimer`/`stopTimer` at around [slack-channel.ts:351](slack-channel.ts#L351), before `// ========== MCP Tools ==========` at [slack-channel.ts:353](slack-channel.ts#L353)):

```typescript
// ========== Restart Command ==========
async function handleRestartCommand(
  channel: string,
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

  // Resolve trigger user display name for log (best-effort)
  let triggerName = userId
  try {
    const u = await slackApp.client.users.info({ user: userId })
    triggerName = (u.user as any)?.real_name || (u.user as any)?.name || userId
  } catch { /* ignore */ }

  // Count unfinished messages
  const queuedCount = queue.filter(m => m.status === 'queued').length
  const processing = currentMessage
  const unfinishedTotal = queuedCount + (processing ? 1 : 0)

  // Build summary message
  let summary = `收到重启指令 (来自 ${triggerName})。\n`
  if (processing) {
    const preview = processing.text.substring(0, 60)
    summary += `处理中: 1 条 (来自 ${processing.user_name}: "${preview}...")\n`
  } else {
    summary += `处理中: 0 条\n`
  }
  summary += `队列中: ${queuedCount} 条\n`
  if (unfinishedTotal > 0) summary += `全部标记为失败。\n`
  summary += `正在杀掉 PID ${process.ppid}...`

  await slackApp.client.chat.postMessage({ channel, text: summary }).catch(() => {})

  // Mark all unfinished messages (queued/processing/timeout) as failed
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
  })

  // Kill parent Claude Code. /F = force, no /T so MCP dies naturally via stdin EOF.
  const { exec } = await import('child_process')
  exec(`taskkill /PID ${process.ppid} /F`, (err) => {
    if (err) console.error('[restart] taskkill failed:', err.message)
  })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

Common issues:
- If `process.ppid` is flagged as possibly undefined: Node types allow it as `number`, but some versions type it as `number | undefined`. If so, add `!` or guard: `process.ppid!` or check before use.
- `import('child_process')` is a dynamic import — ensure `"module": "esnext"` or similar in `tsconfig.json` (should already be set for this project).

- [ ] **Step 4: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add handleRestartCommand for Slack-triggered Claude Code restart"
```

---

## Task 4: Wire restart interception into message handler

**Files:**
- Modify: [slack-channel.ts:514-560](slack-channel.ts#L514-L560) (the `slackApp.message` handler)

**Why:** This is the activation point — after this task, `!restart` is live. Separated from Task 3 so the behavior change is one focused commit.

- [ ] **Step 1: Insert interception block after allowlist check**

Find the `slackApp.message` handler. Locate the allowlist gate at around [slack-channel.ts:540](slack-channel.ts#L540):

```typescript
  // Gate on allowlist
  if (!allowlist.has(user)) return

  // Resolve user display name
  let userName = 'unknown'
  try {
```

Insert a new block **between** `if (!allowlist.has(user)) return` and `let userName = 'unknown'`:

```typescript
  // Gate on allowlist
  if (!allowlist.has(user)) return

  // Intercept restart command (DM-only, exact-match)
  if (channel.startsWith('D') && text.trim() === '!restart') {
    await handleRestartCommand(channel, user)
    return
  }

  // Resolve user display name
  let userName = 'unknown'
  try {
```

Note: `channel`, `text`, `messageTs`, `user` are all already declared above in the handler. No new imports needed.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: wire !restart DM command into message handler"
```

---

## Task 5: Manual integration testing

**Files:** None modified — this is verification only.

**Why:** Every code path here is IO-bound; the spec decided against automated tests. We run the full scenario matrix by hand.

**Setup:**
- Stop any running Claude Code / `start-slack.bat`
- Open a fresh Windows terminal in `D:\Code\claude-slack-agent`
- Prepare a Slack DM with the bot (one-on-one conversation)
- Tail the log file in a second terminal:
  ```bash
  cd ~/.claude/channels/slack/logs
  # Replace YYYY-MM-DD with today's date
  tail -f YYYY-MM-DD.jsonl
  ```
- Start the service: `start-slack.bat`

- [ ] **Step 1: Verify normal operation still works**

Send a normal message in the DM: `你好`

Expected:
- 👀 or no emoji (if nothing else queued)
- ⏳ appears when processing starts
- Claude replies in the DM
- ✅ appears when done
- Log file shows: `enqueued` → `processing_started` → `completed`

- [ ] **Step 2: Verify `!restart` in DM triggers restart**

Send in the DM: `!restart`

Expected:
- Bot replies with a summary message: `收到重启指令 (来自 <your name>)。 处理中: 0 条 队列中: 0 条 正在杀掉 PID <number>...`
- Within 3–10 seconds, wrapper terminal prints `Exited with code ... Restarting in 3s... Starting Claude Code...`
- Log file shows: `restart_triggered` with `trigger_user`, `ppid`, `unfinished_count: 0`
- Then new `process_started` entry after restart
- Send another normal message → bot replies → service confirmed alive

- [ ] **Step 3: Verify cooldown rejects rapid second trigger**

Immediately after restart (within 30s), send in the DM: `!restart`

Expected:
- Bot replies: `冷却中，请 Xs 后再试` (X is a countdown, decrementing)
- No process restart
- No `restart_triggered` log entry

- [ ] **Step 4: Verify `!restart` in a channel is ignored**

In a public/private channel where the bot is present (not a DM), send: `!restart`

Expected:
- No bot reply
- No restart
- No log entry for the message (or just a silent drop at the DM-check)

- [ ] **Step 5: Verify `!restart` from non-allowlisted user is ignored**

(Optional — requires a second Slack account not in the allowlist. Skip if unavailable.)

From a non-allowlisted account, DM the bot: `!restart`

Expected: No reaction, no restart, no log entry.

- [ ] **Step 6: Verify in-flight message cleanup on restart**

Wait 30s+ for cooldown to clear. Then:

1. Send a long-running message that will take a while (e.g., `请仔细阅读整个项目代码库然后给出详细分析`)
2. Immediately after seeing ⏳ (but before ✅), send: `!restart`

Expected:
- Bot replies with summary mentioning `处理中: 1 条 (来自 ...)`
- The original long-running message gets ❌ emoji
- Log file shows a `failed` entry with `error: "restart triggered"` for that message ID
- Log file shows `restart_triggered` with `unfinished_count: 1`
- Service restarts

- [ ] **Step 7: Verify exact-match is strict**

Send in the DM: `!restart now` (extra text after)

Expected:
- Treated as a normal message → goes into the queue → Claude tries to answer it (will probably reply something like "好的，我来重启" but no actual restart happens).
- NO `restart_triggered` log entry. NO process kill.

This confirms `text.trim() === '!restart'` exact-match is working.

- [ ] **Step 8: Fix any failures**

If any step fails, debug, fix, and re-run the failing step. Commit any fixes with a clear message like:

```bash
git add slack-channel.ts
git commit -m "fix: <specific issue found in manual testing>"
```

---

## Task 6: Update `DEPLOY.md`

**Files:**
- Modify: `DEPLOY.md` (add new section after existing "后台运行（生产环境）" section)

**Why last:** Documentation reflects shipped behavior. Writing it last guarantees what we document actually works.

- [ ] **Step 1: Add new section to `DEPLOY.md`**

Find the "## 后台运行（生产环境）" section in [DEPLOY.md](DEPLOY.md). Insert a new section immediately **after** it ends (before "## 文件结构"):

```markdown
## 服务持续性与重启

### Wrapper 循环自动拉起

`start-slack.bat` 是一个无限循环脚本。Claude Code 正常退出、崩溃、或被外部信号杀死，bat 会在 3 秒后自动重新启动。机器关机前不需要手动干预。

停止服务：在运行 `start-slack.bat` 的终端按 Ctrl+C 即可完全退出（循环也会跟着结束，不会再次拉起）。

### 手动触发重启（Slack DM）

场景：Claude Code 长时间不响应（卡住）或你怀疑认证过期。

1. 在与 bot 的 **私聊（DM）** 中发送一条消息，内容严格为：`!restart`
2. Bot 会在 DM 里回复当前队列状态和即将被杀的 PID
3. Claude Code 进程被杀 → wrapper 脚本 3 秒后重启 → 新服务上线
4. 全程中断约 5–10 秒

**限制：**
- 只限 DM，公共/私有频道里发 `!restart` 会被忽略
- 必须是白名单用户
- 必须精确匹配（`text.trim() === '!restart'`），`!restart now` 这种会被当作普通消息
- 30 秒冷却期（防止手抖重复触发）
- 重启时"处理中"和"队列中"的消息都会被标记为失败（❌ emoji），不会自动重试

### 日志中的重启事件

```bash
# 查看历史重启记录
cat ~/.claude/channels/slack/logs/*.jsonl | jq 'select(.event == "restart_triggered")'

# 本月重启次数
cat ~/.claude/channels/slack/logs/*.jsonl | jq -r 'select(.event == "restart_triggered") | .ts' | wc -l
```

每次重启会记录：触发用户 (`trigger_user`)、被杀 PID (`ppid`)、被丢弃的消息数 (`unfinished_count`)、时间戳 (`ts`)。
```

- [ ] **Step 2: Verify the section reads clearly**

Open `DEPLOY.md` and visually inspect:
- The new section appears after "后台运行（生产环境）" and before "## 文件结构"
- No duplicate headings
- Code blocks render correctly (triple-backtick blocks closed properly)
- The Chinese and English text mix consistently with the rest of the document

- [ ] **Step 3: Commit**

```bash
git add DEPLOY.md
git commit -m "docs: document wrapper-loop auto-restart and !restart command"
```

---

## Task 7: Final verification

**Files:** None modified.

**Why:** Sanity-check the whole branch before declaring done.

- [ ] **Step 1: Review full diff**

Run: `git log --oneline origin/main..HEAD`

Expected commits (6 total):
1. `feat: make start-slack.bat auto-respawn Claude Code on exit`
2. `feat: add restart_triggered log event type`
3. `feat: add handleRestartCommand for Slack-triggered Claude Code restart`
4. `feat: wire !restart DM command into message handler`
5. (Optional) `fix: ...` if any test failures surfaced fixes
6. `docs: document wrapper-loop auto-restart and !restart command`

- [ ] **Step 2: Verify TypeScript still compiles cleanly**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify one final end-to-end smoke test**

With a freshly-started service (via `start-slack.bat`):
1. Send a normal DM message → get a reply
2. Send `!restart` → get summary, watch restart, wait ~10s
3. Send another normal DM message → get a reply

This confirms the full pipeline works after an intentional restart.

- [ ] **Step 4: Done**

Report to user:
- Number of commits on branch
- That all 7 manual test steps passed
- Any quirks observed during testing

---

## Rollback Procedure

If this whole plan needs to be reverted:

```bash
# Find the commit BEFORE task 1
git log --oneline  # identify the last commit that isn't part of this plan
git reset --hard <that-commit-hash>
```

All changes are in two source files + one doc file, so a full revert is clean.

## Appendix: Why Windows-specific

This plan uses `taskkill` (Windows) and `.bat` (Windows). Other platforms (macOS/Linux) would need:
- A shell wrapper: `while true; do claude ...; sleep 3; done`
- `process.kill(process.ppid, 'SIGTERM')` instead of `taskkill`

Cross-platform support is out of scope — the user runs this on Windows.
