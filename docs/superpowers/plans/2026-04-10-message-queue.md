# Message Queue & Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict serial message queue with Slack status sync, heartbeat/timeout, and persistent JSONL logging to `slack-channel.ts`.

**Architecture:** All changes inline in the existing single-file `slack-channel.ts` (~282 lines → ~420 lines). New code blocks: constants, interfaces, queue state, helper functions (`writeLog`, `setReaction`, `enqueue`, `processNext`, timer logic). Existing `slackApp.message()` and `reply` tool handler are modified. The `pendingMessages` Map is removed, replaced by `currentMessage`.

**Tech Stack:** TypeScript, `@slack/bolt`, `@modelcontextprotocol/sdk`, Node.js `fs` (JSONL logging)

**Spec:** `docs/superpowers/specs/2026-04-10-message-queue-design.md`

---

### Task 1: Add constants, interfaces, and queue state variables

**Files:**
- Modify: `slack-channel.ts:57-58` (replace `pendingMessages` Map section)

- [ ] **Step 1: Add constants block after the SLACK_MAX_LENGTH constant (line 61)**

Insert after `const SLACK_MAX_LENGTH = 39_000`:

```typescript
const TIMEOUT_S = 300
const HEARTBEAT_START_S = 60
const HEARTBEAT_INTERVAL_S = 30
const TIMER_CHECK_S = 10
const RESERVED_EMOJI = new Set(['eyes', 'hourglass_flowing_sand', 'white_check_mark', 'alarm_clock', 'x'])
```

- [ ] **Step 2: Add QueuedMessage interface and LogEntry type after constants**

```typescript
interface QueuedMessage {
  id: string
  text: string
  user_id: string
  user_name: string
  channel_id: string
  message_ts: string
  thread_ts: string
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'timeout'
  enqueued_at: number
  processing_started_at?: number
  completed_at?: number
  error?: string
}

type LogEvent = 'process_started' | 'enqueued' | 'processing_started' | 'heartbeat' | 'completed' | 'timeout' | 'failed'

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
}
```

- [ ] **Step 3: Replace pendingMessages section with queue state**

Remove the entire State Tracking section (comment + Map):
```typescript
// ========== State Tracking ==========
// Maps "channel_id:thread_ts" → message_ts of the original user message.
// Used by the reply tool handler to add status reactions to the correct message.
const pendingMessages = new Map<string, { channel_id: string; message_ts: string }>()
```

Replace with:
```typescript
const queue: QueuedMessage[] = []
let currentMessage: QueuedMessage | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastHeartbeatPeriod = 0
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (the removed `pendingMessages` references will cause errors — that's expected at this stage, just verify the new types/interfaces are valid by checking the error messages only reference `pendingMessages` usage sites, not the new code)

- [ ] **Step 5: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add queue data model, constants, and state variables"
```

---

### Task 2: Add writeLog and setReaction helper functions

**Files:**
- Modify: `slack-channel.ts` (insert after queue state variables, before MCP tools section)

- [ ] **Step 1: Add writeLog function**

```typescript
let logDirCreated = false
const logDir = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', 'channels', 'slack', 'logs',
)

function writeLog(entry: LogEntry): void {
  try {
    if (!logDirCreated) {
      fs.mkdirSync(logDir, { recursive: true })
      logDirCreated = true
    }
    const date = new Date().toISOString().slice(0, 10)
    const logPath = path.join(logDir, `${date}.jsonl`)
    fs.appendFileSync(logPath, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n')
  } catch (err: any) {
    console.error('[log] write failed:', err.message)
  }
}
```

- [ ] **Step 2: Add setReaction helper**

```typescript
async function setReaction(channel: string, ts: string, add: string, remove?: string): Promise<void> {
  if (remove) {
    await slackApp.client.reactions.remove({ channel, timestamp: ts, name: remove }).catch(() => {})
  }
  await slackApp.client.reactions.add({ channel, timestamp: ts, name: add }).catch(() => {})
}
```

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add writeLog and setReaction helpers"
```

---

### Task 3: Add enqueue function

**Files:**
- Modify: `slack-channel.ts` (insert after helpers, before MCP tools)

- [ ] **Step 1: Add enqueue function**

```typescript
async function enqueue(msg: Omit<QueuedMessage, 'id' | 'status' | 'enqueued_at'>): Promise<void> {
  const item: QueuedMessage = {
    ...msg,
    id: `${msg.channel_id}:${msg.message_ts}`,
    status: 'queued',
    enqueued_at: Date.now(),
  }
  queue.push(item)

  writeLog({
    event: 'enqueued',
    id: item.id,
    user: item.user_name,
    text: item.text,
    queue_length: queue.length,
  })

  // If there are messages ahead, notify the user and add eyes reaction
  const ahead = queue.filter(m => m.status === 'queued').length - 1 + (currentMessage ? 1 : 0)
  if (ahead > 0) {
    await setReaction(item.channel_id, item.message_ts, 'eyes')
    await slackApp.client.chat.postMessage({
      channel: item.channel_id,
      text: `排队中，前面还有 ${ahead} 条消息等待处理`,
      thread_ts: item.thread_ts,
    }).catch(() => {})
  }

  // If nothing is currently processing, start
  if (!currentMessage) {
    await processNext()
  }
}
```

- [ ] **Step 2: Add a placeholder processNext (will be implemented in Task 4)**

```typescript
async function processNext(): Promise<void> {
  // TODO: implement in Task 4
}
```

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add enqueue function with queue position notifications"
```

---

### Task 4: Add processNext function and heartbeat/timeout timer

**Files:**
- Modify: `slack-channel.ts` (replace placeholder processNext)

- [ ] **Step 1: Replace placeholder processNext with full implementation**

```typescript
async function processNext(): Promise<void> {
  // Find next queued message
  const next = queue.find(m => m.status === 'queued')
  if (!next) return

  currentMessage = next
  next.status = 'processing'
  next.processing_started_at = Date.now()

  // Update reaction: remove eyes (if it was waiting), add hourglass
  await setReaction(next.channel_id, next.message_ts, 'hourglass_flowing_sand', 'eyes')

  writeLog({
    event: 'processing_started',
    id: next.id,
    user: next.user_name,
  })

  // Send MCP notification
  try {
    await mcp.notification({
      method: 'notifications/claude/channel' as any,
      params: {
        content: next.text,
        meta: {
          user_id: next.user_id,
          user_name: next.user_name,
          channel_id: next.channel_id,
          message_ts: next.message_ts,
          thread_ts: next.thread_ts,
        },
      },
    })
    console.error(`[queue] processing message from ${next.user_name}: "${next.text.substring(0, 80)}"`)
  } catch (err: any) {
    console.error(`[queue] MCP notification failed:`, err.message)
    next.status = 'failed'
    next.error = err.message
    await setReaction(next.channel_id, next.message_ts, 'x', 'hourglass_flowing_sand')
    writeLog({ event: 'failed', id: next.id, error: err.message })
    const idx = queue.indexOf(next)
    if (idx >= 0) queue.splice(0, idx + 1)
    currentMessage = null
    await processNext()
    return
  }

  // Start heartbeat/timeout timer
  // Initialize to (HEARTBEAT_START_S / HEARTBEAT_INTERVAL_S - 1) so first heartbeat fires at HEARTBEAT_START_S
  lastHeartbeatPeriod = Math.floor(HEARTBEAT_START_S / HEARTBEAT_INTERVAL_S) - 1
  startTimer()
}
```

- [ ] **Step 2: Add startTimer and stopTimer functions**

```typescript
function startTimer(): void {
  stopTimer()
  heartbeatTimer = setInterval(async () => {
    if (!currentMessage || !currentMessage.processing_started_at) return

    const elapsed_s = Math.floor((Date.now() - currentMessage.processing_started_at) / 1000)

    // Timeout check (only fire once)
    if (elapsed_s >= TIMEOUT_S && currentMessage.status !== 'timeout') {
      currentMessage.status = 'timeout'
      await setReaction(currentMessage.channel_id, currentMessage.message_ts, 'alarm_clock')
      writeLog({ event: 'timeout', id: currentMessage.id, elapsed_s })
      await slackApp.client.chat.postMessage({
        channel: currentMessage.channel_id,
        text: `处理已超时(${TIMEOUT_S}s)，仍在等待回复...`,
        thread_ts: currentMessage.thread_ts,
      }).catch(() => {})
      return // Stop heartbeat after timeout
    }

    // Heartbeat check (only while not timed out)
    if (currentMessage.status === 'processing') {
      const period = Math.floor(elapsed_s / HEARTBEAT_INTERVAL_S)
      if (elapsed_s >= HEARTBEAT_START_S && period > lastHeartbeatPeriod) {
        lastHeartbeatPeriod = period
        const waiting = queue.filter(m => m.status === 'queued').length
        writeLog({ event: 'heartbeat', id: currentMessage.id, elapsed_s, queue_length: waiting })
        await slackApp.client.chat.postMessage({
          channel: currentMessage.channel_id,
          text: `仍在处理中... (已用时 ${elapsed_s}s，队列中还有 ${waiting} 条)`,
          thread_ts: currentMessage.thread_ts,
        }).catch(() => {})
      }
    }
  }, TIMER_CHECK_S * 1000)
}

function stopTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add processNext with heartbeat and timeout timer"
```

---

### Task 5: Modify reply tool handler to integrate with queue

**Files:**
- Modify: `slack-channel.ts` — the `reply` case in `CallToolRequestSchema` handler (currently lines 121-168)

- [ ] **Step 1: Rewrite reply handler**

Replace the entire `if (name === 'reply') { ... }` block with:

```typescript
  if (name === 'reply') {
    const { channel_id, text, thread_ts } = args as {
      channel_id: string
      text: string
      thread_ts: string
    }

    try {
      // Chunk long messages to stay under Slack's 40k limit
      if (text.length > SLACK_MAX_LENGTH) {
        const chunks = chunkText(text, SLACK_MAX_LENGTH)
        for (const chunk of chunks) {
          await slackApp.client.chat.postMessage({ channel: channel_id, text: chunk, thread_ts })
        }
      } else {
        await slackApp.client.chat.postMessage({ channel: channel_id, text, thread_ts })
      }

      // Queue bookkeeping
      if (currentMessage) {
        const wasTimeout = currentMessage.status === 'timeout'
        currentMessage.status = 'completed'
        currentMessage.completed_at = Date.now()
        const duration_s = Math.floor((currentMessage.completed_at - (currentMessage.processing_started_at || currentMessage.enqueued_at)) / 1000)

        await setReaction(currentMessage.channel_id, currentMessage.message_ts, 'white_check_mark', 'hourglass_flowing_sand')
        // Clean up alarm_clock if message had timed out
        if (wasTimeout) {
          await slackApp.client.reactions.remove({
            channel: currentMessage.channel_id, timestamp: currentMessage.message_ts, name: 'alarm_clock',
          }).catch(() => {})
        }

        writeLog({
          event: 'completed',
          id: currentMessage.id,
          duration_s,
          was_timeout: wasTimeout || undefined,
        })

        // Prune completed/failed entries to prevent unbounded memory growth
        const idx = queue.indexOf(currentMessage)
        if (idx >= 0) queue.splice(0, idx + 1)

        stopTimer()
        currentMessage = null
        await processNext()
      }

      return { content: [{ type: 'text', text: 'sent' }] }
    } catch (err: any) {
      // Mark failure on current message
      if (currentMessage) {
        currentMessage.status = 'failed'
        currentMessage.error = err.message
        await setReaction(currentMessage.channel_id, currentMessage.message_ts, 'x', 'hourglass_flowing_sand')
        writeLog({ event: 'failed', id: currentMessage.id, error: err.message })
        const idx = queue.indexOf(currentMessage)
        if (idx >= 0) queue.splice(0, idx + 1)
        stopTimer()
        currentMessage = null
        await processNext()
      }

      console.error('[reply] error:', err.message)
      return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true }
    }
  }
```

- [ ] **Step 2: Verify no references to pendingMessages remain**

Search for `pendingMessages` in the file — should return zero results.

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: integrate reply tool with queue lifecycle"
```

---

### Task 6: Add react tool emoji blocklist

**Files:**
- Modify: `slack-channel.ts` — the `react` case in `CallToolRequestSchema` handler (currently lines 171-188)

- [ ] **Step 1: Add blocklist check to react handler**

At the beginning of the `if (name === 'react')` block, after extracting `emoji`, add:

```typescript
    const cleanEmoji = emoji.replace(/:/g, '')
    if (RESERVED_EMOJI.has(cleanEmoji)) {
      return {
        content: [{ type: 'text', text: `error: emoji "${cleanEmoji}" is reserved for queue status` }],
        isError: true,
      }
    }
```

Update the `reactions.add` call to use `cleanEmoji` instead of `emoji.replace(/:/g, '')`.

- [ ] **Step 2: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: block reserved status emoji in react tool"
```

---

### Task 7: Modify slackApp.message handler to use enqueue

**Files:**
- Modify: `slack-channel.ts` — `slackApp.message()` handler (currently lines 215-276)

- [ ] **Step 1: Rewrite message handler**

Replace the entire `slackApp.message(async ({ message }) => { ... })` block with:

```typescript
slackApp.message(async ({ message }) => {
  // Type guard: only process plain user messages
  if (message.type !== 'message') return
  if ((message as any).subtype) return
  if ((message as any).bot_id) return

  const text = (message as any).text || ''
  const user = (message as any).user as string
  const channel = (message as any).channel as string
  const messageTs = (message as any).ts as string
  const threadTs = (message as any).thread_ts || messageTs

  // Gate on allowlist
  if (!allowlist.has(user)) return

  // Resolve user display name
  let userName = 'unknown'
  try {
    const userInfo = await slackApp.client.users.info({ user })
    userName = (userInfo.user as any)?.real_name || (userInfo.user as any)?.name || 'unknown'
  } catch {
    console.error(`[slack] failed to resolve user name for ${user}`)
  }

  // Enqueue for serial processing
  await enqueue({
    text,
    user_id: user,
    user_name: userName,
    channel_id: channel,
    message_ts: messageTs,
    thread_ts: threadTs,
  })
})
```

Key changes from original:
- Removed direct `reactions.add('eyes')` — now handled by `enqueue()` conditionally
- Removed `pendingMessages.set()` — replaced by queue
- Removed direct `mcp.notification()` — now handled by `processNext()`
- User name resolution stays in the handler (before enqueue)

- [ ] **Step 2: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: replace direct MCP notification with queue-based processing"
```

---

### Task 8: Add process_started log event at startup

**Files:**
- Modify: `slack-channel.ts` — startup section (currently lines 278-282)

- [ ] **Step 1: Add startup log event after both MCP and Slack are connected**

Replace:
```typescript
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
```

With:
```typescript
writeLog({ event: 'process_started', id: 'system' })
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
```

`process_started` is already in the `LogEvent` union type from Task 1 — no cast needed.

- [ ] **Step 2: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: log process_started event at startup"
```

---

### Task 9: End-to-end verification

- [ ] **Step 1: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Verify no references to pendingMessages**

Search for `pendingMessages` — should return zero results.

- [ ] **Step 3: Verify all queue state transitions are consistent**

Manually trace through the code for these scenarios:
1. Single message: arrives → enqueue (no eyes, processNext) → processing (⏳) → reply (✅, processNext finds nothing)
2. Two messages: msg1 arrives → processing; msg2 arrives → queued (👀, "前面还有1条") → msg1 reply (✅, processNext picks msg2) → msg2 processing (⏳, remove 👀) → msg2 reply (✅)
3. Timeout: message processing > 300s → ⏰ added, heartbeat stops → eventual reply → ✅ with was_timeout
4. MCP failure: processNext sends notification → catch → ❌ → processNext picks next

- [ ] **Step 4: Run the server manually to verify startup**

Run: `npx tsx slack-channel.ts 2>&1 | head -5`
Expected: Should see startup log output (will fail to connect MCP without Claude Code, but verifies the code loads)

- [ ] **Step 5: Check log file was created**

After running server briefly, check: `ls ~/.claude/channels/slack/logs/`
Expected: `2026-04-10.jsonl` file exists with a `process_started` entry

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add slack-channel.ts
git commit -m "fix: address issues found in e2e verification"
```
