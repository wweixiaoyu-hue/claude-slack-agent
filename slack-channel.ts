#!/usr/bin/env npx tsx

import { App, LogLevel } from '@slack/bolt'
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

// Placeholder: message handler will be added in Task 4
slackApp.message(async ({ message }) => {
  console.error('[slack] received message:', (message as any).text?.substring(0, 50))
})

// ========== Start ==========
// MCP transport must connect BEFORE Slack starts (Claude Code expects stdio handshake first)
await mcp.connect(new StdioServerTransport())
await slackApp.start()
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
