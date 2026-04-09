#!/usr/bin/env npx tsx

import { App, LogLevel } from '@slack/bolt'
import * as fs from 'fs'
import * as path from 'path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

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

// ========== State Tracking ==========
// Maps "channel_id:thread_ts" → message_ts of the original user message.
// Used by the reply tool handler to add status reactions to the correct message.
const pendingMessages = new Map<string, { channel_id: string; message_ts: string }>()

// ========== Helpers ==========
const SLACK_MAX_LENGTH = 39_000 // Leave margin below Slack's 40k limit

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

    // Key must match the one stored by the message handler (channel_id:threadTs)
    const key = `${channel_id}:${thread_ts}`

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

      // Add checkmark reaction to the original message
      const pending = pendingMessages.get(key)
      if (pending) {
        await slackApp.client.reactions.add({
          channel: pending.channel_id,
          timestamp: pending.message_ts,
          name: 'white_check_mark',
        }).catch(() => {}) // Best-effort
        pendingMessages.delete(key)
      }

      return { content: [{ type: 'text', text: 'sent' }] }
    } catch (err: any) {
      // Add x reaction on failure
      const pending = pendingMessages.get(key)
      if (pending) {
        await slackApp.client.reactions.add({
          channel: pending.channel_id,
          timestamp: pending.message_ts,
          name: 'x',
        }).catch(() => {})
        pendingMessages.delete(key)
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
    try {
      await slackApp.client.reactions.add({
        channel: channel_id,
        timestamp: message_ts,
        name: emoji.replace(/:/g, ''),
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
  // Type guard: only process plain user messages
  if (message.type !== 'message') return
  if ((message as any).subtype) return
  if ((message as any).bot_id) return

  const text = (message as any).text || ''
  const user = (message as any).user as string
  const channel = (message as any).channel as string
  const messageTs = (message as any).ts as string
  const threadTs = (message as any).thread_ts || messageTs // Default to message's own ts for threading

  // Gate on allowlist
  if (!allowlist.has(user)) return

  // Add eyes reaction to acknowledge receipt
  await slackApp.client.reactions.add({
    channel,
    timestamp: messageTs,
    name: 'eyes',
  }).catch(() => {}) // Best-effort

  // Store pending message for status reaction tracking
  const key = `${channel}:${threadTs}`
  pendingMessages.set(key, { channel_id: channel, message_ts: messageTs })

  // Resolve user display name
  let userName = 'unknown'
  try {
    const userInfo = await slackApp.client.users.info({ user })
    userName = (userInfo.user as any)?.real_name || (userInfo.user as any)?.name || 'unknown'
  } catch {
    console.error(`[slack] failed to resolve user name for ${user}`)
  }

  // Forward to Claude Code via MCP channel notification
  try {
    await mcp.notification({
      method: 'notifications/claude/channel' as any,
      params: {
        content: text,
        meta: {
          user_id: user,
          user_name: userName,
          channel_id: channel,
          message_ts: messageTs,
          thread_ts: threadTs,
        },
      },
    })
    console.error(`[slack] forwarded message from ${userName}: "${text.substring(0, 80)}"`)
  } catch (err: any) {
    console.error(`[slack] failed to forward message:`, err.message)
    // Add x reaction on MCP forward failure
    await slackApp.client.reactions.add({
      channel,
      timestamp: messageTs,
      name: 'x',
    }).catch(() => {})
    pendingMessages.delete(key)
  }
})

// ========== Start ==========
// MCP transport must connect BEFORE Slack starts (Claude Code expects stdio handshake first)
await mcp.connect(new StdioServerTransport())
await slackApp.start()
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
