# Message Queue & Reliability Design

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Add message queuing, status sync, and persistent logging to slack-channel.ts

## Problem

Current `slack-channel.ts` sends MCP channel notifications as fire-and-forget. When Claude Code is busy processing a previous message, new notifications are silently dropped — no retry, no queue, no record.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Concurrency model | Strict serial queue | MCP channel is single-threaded; serial avoids race conditions |
| Architecture | Inline in slack-channel.ts | 282-line single file; splitting is premature |
| Status sync | Event-driven + heartbeat | Key events immediately; heartbeat for long tasks |
| Log format | JSONL, daily rotation | Machine-queryable; manageable file sizes |
| Timeout behavior | Mark only, keep waiting | Cannot cancel Claude Code processing externally |

## 1. Message Data Model

```typescript
interface QueuedMessage {
  id: string                       // `${channel_id}:${message_ts}`
  text: string                     // Message text
  user_id: string                  // Slack user ID
  user_name: string                // Display name
  channel_id: string               // Channel ID
  message_ts: string               // Message timestamp
  thread_ts: string                // Thread timestamp
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'timeout'
  enqueued_at: number              // Date.now() at enqueue
  processing_started_at?: number   // Date.now() when processing begins
  completed_at?: number            // Date.now() when reply received
  error?: string                   // Failure reason
}
```

Queue state:

```typescript
const queue: QueuedMessage[] = []
let currentMessage: QueuedMessage | null = null
```

## 2. Queue Processing Flow

```
Slack message arrives
  → allowlist check (unchanged)
  → enqueue(message)
    → status = 'queued'
    → add 👀 reaction
    → write log: enqueued
    → if queue has waiting messages: notify in thread "排队中，前面还有 N 条"
    → if no other message processing: processNext()

processNext()
  → dequeue first 'queued' message → set as currentMessage
  → status = 'processing'
  → remove 👀, add ⏳ reaction
  → write log: processing_started
  → send mcp.notification()
  → start heartbeat/timeout timer
  → if MCP notification fails:
      → status = 'failed'
      → remove ⏳, add ❌
      → write log: failed
      → processNext()

reply tool called
  → match currentMessage via channel_id:thread_ts
  → post message to Slack (chunking unchanged)
  → status = 'completed'
  → remove ⏳, add ✅
  → write log: completed (with duration_s)
  → clear timers
  → currentMessage = null
  → processNext()
```

## 3. Timeout & Heartbeat

A single `setInterval` timer (every 10 seconds) manages both:

**Heartbeat:** When `currentMessage` has been processing for > 60 seconds, post a thread message every 30 seconds:
> "仍在处理中... (已用时 90s，队列中还有 2 条)"

Only post at 30-second boundaries (elapsed % 30 === 0 check at 10s granularity, i.e. post at 60s, 90s, 120s...).

**Timeout:** When processing exceeds 300 seconds:
- Set `status = 'timeout'`
- Add ⏰ reaction (keep ⏳ — still waiting)
- Write log: timeout
- Post thread message: "处理已超时(300s)，仍在等待回复..."
- Do NOT dequeue or process next — continue waiting for reply
- Stop heartbeat messages after timeout notification

If reply eventually arrives for a timed-out message, handle normally (complete, ✅, process next).

Timer cleanup: clear interval when no message is processing (currentMessage === null).

## 4. Reaction State Machine

Each message's emoji reactions reflect its processing state:

```
queued       → 👀 (eyes)
processing   → ⏳ (hourglass_flowing_sand)    [remove 👀]
completed    → ✅ (white_check_mark)           [remove ⏳]
timeout      → ⏰ (alarm_clock)               [keep ⏳]
failed       → ❌ (x)                          [remove ⏳ or 👀]
```

Reaction helper function pattern:

```typescript
async function setReaction(channel: string, ts: string, add: string, remove?: string) {
  if (remove) {
    await slackApp.client.reactions.remove({ channel, timestamp: ts, name: remove }).catch(() => {})
  }
  await slackApp.client.reactions.add({ channel, timestamp: ts, name: add }).catch(() => {})
}
```

## 5. Slack Thread Notifications

Notifications are posted as replies in the message's thread (won't pollute channel main view):

| Trigger | Message |
|---------|---------|
| Enqueued with messages ahead | "排队中，前面还有 N 条消息等待处理" |
| Heartbeat (every 30s after 60s) | "仍在处理中... (已用时 Ns，队列中还有 N 条)" |
| Timeout (300s) | "处理已超时(300s)，仍在等待回复..." |

**Not notified:** queue empty (starts immediately), normal completion (reply is the notification).

## 6. JSONL Logging

### File Location & Rotation

```
~/.claude/channels/slack/logs/
├── 2026-04-10.jsonl
├── 2026-04-11.jsonl
└── ...
```

Directory created on first write if it doesn't exist. Files named by UTC date.

### Log Entry Structure

```typescript
interface LogEntry {
  ts: string          // ISO 8601 timestamp
  event: string       // Event type
  id: string          // Message ID (channel:message_ts)
  user?: string       // User display name
  text?: string       // Message text (only on enqueued)
  queue_length?: number
  elapsed_s?: number
  duration_s?: number
  error?: string
}
```

### Event Types

| Event | Trigger | Extra Fields |
|-------|---------|--------------|
| `enqueued` | Message enters queue | text, queue_length |
| `processing_started` | processNext() picks message | user |
| `heartbeat` | Every 30s after 60s of processing | elapsed_s, queue_length |
| `completed` | reply tool called successfully | duration_s |
| `timeout` | Processing exceeds 300s | elapsed_s |
| `failed` | MCP notification send error | error |

### writeLog Function

```typescript
function writeLog(entry: LogEntry): void {
  const date = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const logDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'channels', 'slack', 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logPath = path.join(logDir, `${date}.jsonl`)
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}
```

### Post-hoc Query Examples

```bash
# All unresolved messages today
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.event == "timeout" or .event == "failed")'

# Average processing time
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.event == "completed") | .duration_s' | awk '{s+=$1; n++} END {print s/n}'

# Messages from a specific user
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.user == "danny")'
```

## 7. Integration with Existing Code

### Unchanged
- MCP Server init, capabilities, instructions
- `reply` and `react` tool interface (input params)
- Allowlist mechanism (load + check)
- stderr-only logging rule
- Message chunking logic (39k limit)
- Startup sequence (MCP connect → Slack start)

### Modified: `slackApp.message()` handler (lines 215-276)

Before: resolves user name → sends `mcp.notification()` directly
After: resolves user name → calls `enqueue()` → queue triggers `processNext()` when ready

### Modified: `reply` tool handler (lines 121-168)

Before: posts message → adds ✅ → deletes from pendingMessages
After: posts message → matches currentMessage → marks completed → writes log → clears timers → calls `processNext()`

The `pendingMessages` Map is replaced by `currentMessage` — the reply handler checks `currentMessage.channel_id` and `currentMessage.thread_ts` instead.

### New Code Blocks

| Block | Purpose | Est. Lines |
|-------|---------|------------|
| `QueuedMessage` interface + state vars | Data model | ~15 |
| `enqueue()` | Intake + log + notify | ~30 |
| `processNext()` | Dequeue + MCP send + timer start | ~35 |
| `writeLog()` | JSONL append to daily file | ~20 |
| Heartbeat/timeout timer | setInterval check loop | ~25 |
| `setReaction()` | Reaction add/remove helper | ~15 |

**Total estimated change:** 282 → ~420 lines.

## 8. Constants

```typescript
const TIMEOUT_S = 300           // Timeout threshold
const HEARTBEAT_START_S = 60    // Start heartbeat after this
const HEARTBEAT_INTERVAL_S = 30 // Heartbeat message interval
const TIMER_CHECK_S = 10        // Timer poll interval
```
