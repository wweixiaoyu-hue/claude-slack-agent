#!/usr/bin/env npx tsx

import { App, LogLevel } from '@slack/bolt'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ========== Stderr Logger ==========
// Critical: Bolt must NEVER write to stdout — MCP uses stdout for JSON-RPC.
// All logging goes to stderr.
const stderrLogger = {
  debug: (...msgs: unknown[]) => console.error('[bolt:debug]', ...msgs),
  info: (...msgs: unknown[]) => console.error('[bolt:info]', ...msgs),
  warn: (...msgs: unknown[]) => console.error('[bolt:warn]', ...msgs),
  error: (...msgs: unknown[]) => console.error('[bolt:error]', ...msgs),
  getLevel: () => LogLevel.INFO,
  setLevel: () => {},
  setName: () => {},
}

// ========== Slack App ==========
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  logger: stderrLogger,
})

// ========== MCP Server ==========
const mcp = new Server(
  { name: 'slack', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // Intentionally NOT declaring 'claude/channel/permission'
        // — we use --dangerously-skip-permissions instead
      },
      tools: {},
    },
    instructions: `CRITICAL: The user cannot see the terminal at all. The ONLY way they receive your response is if you call the reply tool. You MUST call reply after every single Slack message — no exceptions. Never respond only in the terminal.

Messages arrive as <channel source="slack" channel_id="..." user_id="..." user_name="...">. Always pass back channel_id and thread_ts from the meta.

Keep responses concise — the user is reading on a phone. Use short paragraphs, bullet points, and code blocks sparingly.`,
  },
)

// ========== Queue State ==========
const queue: QueuedMessage[] = []
let currentMessage: QueuedMessage | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastHeartbeatPeriod = 0

// ========== Conversation Context ==========
interface ConversationEntry {
  role: 'user' | 'assistant'
  user_name?: string
  content: string
  ts: number  // Date.now() for timeout calculation
}

const conversations = new Map<string, ConversationEntry[]>()
const CONTEXT_MAX_ENTRIES = 20        // Keep last 20 exchanges (10 rounds)
const CONTEXT_TIMEOUT_MS = 30 * 60 * 1000  // 30 min inactivity = new conversation

function getConversationKey(channel_id: string, thread_ts: string, message_ts: string): string {
  // DM channels (D...) and group DMs: use channel_id as key (messages are rarely threaded)
  // Public/private channels (C.../G...): use thread if threaded, otherwise channel_id
  if (channel_id.startsWith('D')) return channel_id
  return thread_ts !== message_ts ? `${channel_id}:${thread_ts}` : channel_id
}

function getConversationHistory(key: string): ConversationEntry[] {
  const history = conversations.get(key)
  if (!history || history.length === 0) return []

  // Check timeout: if last entry is older than threshold, clear and start fresh
  const lastEntry = history[history.length - 1]
  if (Date.now() - lastEntry.ts > CONTEXT_TIMEOUT_MS) {
    conversations.delete(key)
    return []
  }
  return history
}

function addToConversation(key: string, entry: ConversationEntry): void {
  let history = conversations.get(key)
  if (!history) {
    history = []
    conversations.set(key, history)
  }
  history.push(entry)
  // Trim to max entries
  if (history.length > CONTEXT_MAX_ENTRIES) {
    history.splice(0, history.length - CONTEXT_MAX_ENTRIES)
  }
}

function formatContextForMCP(history: ConversationEntry[], newMessage: string, userName: string): string {
  if (history.length === 0) return newMessage

  const lines = history.map(e => {
    if (e.role === 'user') {
      return `[${e.user_name || 'user'}]: ${e.content}`
    } else {
      return `[assistant]: ${e.content}`
    }
  })

  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n[${userName}]: ${newMessage}`
}

// ========== Helpers ==========
const SLACK_MAX_LENGTH = 39_000 // Leave margin below Slack's 40k limit
const TIMEOUT_S = 300
const HEARTBEAT_START_S = 60
const HEARTBEAT_INTERVAL_S = 30
const TIMER_CHECK_S = 10
const RESERVED_EMOJI = new Set(['eyes', 'hourglass_flowing_sand', 'white_check_mark', 'alarm_clock', 'x'])

// Restart command cooldown
const RESTART_COOLDOWN_MS = 30_000
let lastRestartAt = 0

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

type LogEvent = 'process_started' | 'enqueued' | 'processing_started' | 'heartbeat' | 'completed' | 'timeout' | 'failed' | 'restart_triggered'

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
  trigger_user?: string
  ppid?: number
  unfinished_count?: number
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    // Try to split on paragraph boundary
    let splitAt = remaining.lastIndexOf('\n\n', maxLen)
    if (splitAt < maxLen / 2) {
      // No good paragraph break — split on line boundary
      splitAt = remaining.lastIndexOf('\n', maxLen)
    }
    if (splitAt < maxLen / 2) {
      // No good line break — hard split
      splitAt = maxLen
    }
    chunks.push(remaining.substring(0, splitAt))
    remaining = remaining.substring(splitAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

// ========== Logging ==========
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

// ========== Reaction Helper ==========
async function setReaction(channel: string, ts: string, add: string, remove?: string): Promise<void> {
  if (remove) {
    await slackApp.client.reactions.remove({ channel, timestamp: ts, name: remove }).catch(() => {})
  }
  await slackApp.client.reactions.add({ channel, timestamp: ts, name: add }).catch(() => {})
}

// ========== Queue Functions ==========
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

  // Build content with conversation history
  const convKey = getConversationKey(next.channel_id, next.thread_ts, next.message_ts)
  const history = getConversationHistory(convKey)
  const contentWithContext = formatContextForMCP(history, next.text, next.user_name)

  // Record user message in conversation
  addToConversation(convKey, { role: 'user', user_name: next.user_name, content: next.text, ts: Date.now() })

  // Send MCP notification
  try {
    await mcp.notification({
      method: 'notifications/claude/channel' as any,
      params: {
        content: contentWithContext,
        meta: {
          user_id: next.user_id,
          user_name: next.user_name,
          channel_id: next.channel_id,
          message_ts: next.message_ts,
          thread_ts: next.thread_ts,
        },
      },
    })
    console.error(`[queue] processing message from ${next.user_name}: "${next.text.substring(0, 80)}" (history: ${history.length} entries)`)
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

function startTimer(): void {
  stopTimer()
  heartbeatTimer = setInterval(async () => {
    try {
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
    } catch (err: any) {
      console.error('[timer] unexpected error:', err.message)
    }
  }, TIMER_CHECK_S * 1000)
}

function stopTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

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
  summary += `正在拉起新进程并杀掉 PID ${process.ppid}...`

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

  // Snapshot existing claude.exe PIDs BEFORE spawning the new one, so we can
  // kill only the old ones (process.ppid is unreliable — it may point at
  // intermediate npx/tsx shells rather than the actual claude.exe).
  const { spawn, exec, execSync } = await import('child_process')
  let oldClaudePids: string[] = []
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH /FO CSV').toString()
    oldClaudePids = Array.from(out.matchAll(/"claude\.exe","(\d+)"/g)).map(m => m[1])
  } catch (e) {
    console.error('[restart] tasklist failed:', (e as Error).message)
  }
  console.error('[restart] old claude.exe PIDs:', oldClaudePids)

  // Spawn a fully detached new start-slack.bat in a new console window.
  // `cmd /c start` hands it off to a new console outside our process tree.
  const batPath = path.join(__dirname, 'start-slack.bat')
  const child = spawn('cmd.exe', ['/c', 'start', '""', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: __dirname,
  })
  child.unref()

  // Small delay so the new bat + claude.exe have a moment to launch before we
  // start killing (killing too early can cascade through the job object).
  await new Promise((r) => setTimeout(r, 1000))

  // Kill each OLD claude.exe PID individually. New claude.exe (not in the
  // snapshot) survives.
  for (const pid of oldClaudePids) {
    exec(`taskkill /PID ${pid} /F`, (err) => {
      if (err) console.error(`[restart] taskkill PID=${pid} failed:`, err.message)
    })
  }
}

// ========== MCP Tools ==========
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to Slack. You MUST call this for every incoming message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Slack channel ID from the incoming message meta' },
          text: { type: 'string', description: 'Message text (supports Slack mrkdwn formatting)' },
          thread_ts: { type: 'string', description: 'Thread timestamp — ALWAYS pass this from the incoming message meta' },
        },
        required: ['channel_id', 'text', 'thread_ts'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Slack message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Slack channel ID' },
          message_ts: { type: 'string', description: 'Timestamp of the message to react to' },
          emoji: { type: 'string', description: 'Emoji name without colons (e.g. "thumbsup")' },
        },
        required: ['channel_id', 'message_ts', 'emoji'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

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

      // Queue bookkeeping (FIFO: reply always applies to currentMessage)
      if (currentMessage) {
        if (currentMessage.channel_id !== channel_id || currentMessage.thread_ts !== thread_ts) {
          console.error(`[reply] WARNING: reply params (${channel_id}:${thread_ts}) do not match current message (${currentMessage.channel_id}:${currentMessage.thread_ts})`)
        }

        // Save assistant reply to conversation history
        const convKey = getConversationKey(currentMessage.channel_id, currentMessage.thread_ts, currentMessage.message_ts)
        addToConversation(convKey, { role: 'assistant', content: text, ts: Date.now() })
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

  if (name === 'react') {
    const { channel_id, message_ts, emoji } = args as {
      channel_id: string
      message_ts: string
      emoji: string
    }
    const cleanEmoji = emoji.replace(/:/g, '')
    if (RESERVED_EMOJI.has(cleanEmoji)) {
      return {
        content: [{ type: 'text', text: `error: emoji "${cleanEmoji}" is reserved for queue status` }],
        isError: true,
      }
    }
    try {
      await slackApp.client.reactions.add({
        channel: channel_id,
        timestamp: message_ts,
        name: cleanEmoji,
      })
      return { content: [{ type: 'text', text: 'reacted' }] }
    } catch (err: any) {
      console.error('[react] error:', err.message)
      return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true }
    }
  }

  throw new Error(`unknown tool: ${name}`)
})

// ========== Allowlist ==========
const allowlistPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', 'channels', 'slack', 'access.json'
)

let allowlist = new Set<string>()

function loadAllowlist(): void {
  try {
    const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'))
    allowlist = new Set(data.allowed_users || [])
    console.error(`[allowlist] loaded ${allowlist.size} user(s) from ${allowlistPath}`)
  } catch {
    allowlist = new Set()
    console.error(`[allowlist] no allowlist found at ${allowlistPath} — all messages will be dropped`)
  }
}

loadAllowlist()

// ========== Slack Message Handler ==========
slackApp.message(async ({ message }) => {
  // Type guard: only process user messages (plain text or file shares)
  if (message.type !== 'message') return
  const subtype = (message as any).subtype
  if (subtype && subtype !== 'file_share') return
  if ((message as any).bot_id) return

  let text = (message as any).text || ''

  // Append file info for file_share messages
  const files = (message as any).files as any[] | undefined
  if (files && files.length > 0) {
    const fileDescriptions = files.map((f: any) => {
      const name = f.name || 'unknown'
      const url = f.url_private || f.permalink || ''
      return `[附件: ${name}]${url ? ` ${url}` : ''}`
    }).join('\n')
    text = text ? `${text}\n${fileDescriptions}` : fileDescriptions
  }
  const user = (message as any).user as string
  const channel = (message as any).channel as string
  const messageTs = (message as any).ts as string
  const threadTs = (message as any).thread_ts || messageTs

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

// ========== Start ==========
// MCP transport must connect BEFORE Slack starts (Claude Code expects stdio handshake first)
await mcp.connect(new StdioServerTransport())
await slackApp.start()
writeLog({ event: 'process_started', id: 'system' })
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
