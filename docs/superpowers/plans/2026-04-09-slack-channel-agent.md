# Slack Channel Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-file MCP Channel Server that bridges Slack and Claude Code, enabling remote control from phone.

**Architecture:** Single TypeScript file (`slack-channel.ts`) combining Slack Bolt (Socket Mode) and MCP Server (stdio). Bun runtime, no build step. Slack messages forwarded as MCP channel notifications; Claude replies via MCP `reply` tool back to Slack.

**Tech Stack:** Bun, TypeScript, @modelcontextprotocol/sdk, @slack/bolt

**Spec:** `docs/superpowers/specs/2026-04-09-slack-channel-agent-design.md`

---

## File Structure

```
slack-channel.ts       # Main server — MCP + Slack Bolt, all logic in one file
package.json           # Dependencies (bun-compatible), scripts
tsconfig.json          # TypeScript config for IDE support only
.mcp.json              # MCP server registration for Claude Code
.env.example           # Template for required tokens
.gitignore             # Exclude .env, node_modules, bun.lockb
```

Single-file design is intentional — this is a personal tool where simplicity matters more than separation of concerns.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `.mcp.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-slack-channel",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "start": "bun slack-channel.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "@slack/bolt": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "types": ["bun"]
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 3: Create `.env.example`**

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
SLACK_SIGNING_SECRET=your-secret
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.env
bun.lockb
dist/
```

- [ ] **Step 5: Create `.mcp.json`**

```json
{
  "mcpServers": {
    "slack": {
      "command": "bun",
      "args": ["slack-channel.ts"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_SIGNING_SECRET": "..."
      }
    }
  }
}
```

- [ ] **Step 6: Install dependencies**

Run: `bun install`
Expected: `bun.lockb` created, `node_modules/` populated, no errors.

- [ ] **Step 7: Commit scaffolding**

```bash
git add package.json tsconfig.json .env.example .gitignore .mcp.json
git commit -m "chore: scaffold project with package.json, tsconfig, and config files"
```

---

### Task 2: Slack Bolt App Initialization

**Files:**
- Create: `slack-channel.ts`

This task creates the Slack Bolt app with Socket Mode, configured to NOT write to stdout (critical for MCP compatibility).

- [ ] **Step 1: Create `slack-channel.ts` with Slack Bolt setup**

```typescript
#!/usr/bin/env bun

import { App, LogLevel } from '@slack/bolt'

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

// Placeholder: message handler will be added in Task 4
slackApp.message(async ({ message }) => {
  console.error('[slack] received message:', (message as any).text?.substring(0, 50))
})

await slackApp.start()
console.error('[slack-channel] Slack app started')
```

- [ ] **Step 2: Verify Slack Bolt starts without errors and stdout is clean**

Run: `SLACK_BOT_TOKEN=test SLACK_APP_TOKEN=test SLACK_SIGNING_SECRET=test timeout 3 bun slack-channel.ts 2>/dev/null || true`
Expected: No output at all (all logging goes to stderr, which is suppressed). If you see ANY output, something is writing to stdout and will break MCP.

Then verify stderr output:
Run: `SLACK_BOT_TOKEN=test SLACK_APP_TOKEN=test SLACK_SIGNING_SECRET=test timeout 3 bun slack-channel.ts 2>&1 1>/dev/null || true`
Expected: Should see Bolt connection attempt logs on stderr. Kill with Ctrl+C if needed.

- [ ] **Step 3: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add Slack Bolt app with Socket Mode and stderr-only logging"
```

---

### Task 3: MCP Server Setup

**Files:**
- Modify: `slack-channel.ts`

Add the MCP Server with channel capability, tools (reply + react), and the critical instructions field. Wire up stdio transport.

- [ ] **Step 1: Add MCP Server initialization**

Add these imports at the top of `slack-channel.ts`:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
```

Add MCP server creation after the Slack App block:

```typescript
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
```

- [ ] **Step 2: Add state tracking map for status reactions**

Add after MCP server creation:

```typescript
// ========== State Tracking ==========
// Maps "channel_id:thread_ts" → message_ts of the original user message.
// Used by the reply tool handler to add ✅ or ❌ reactions to the correct message.
const pendingMessages = new Map<string, { channel_id: string; message_ts: string }>()
```

- [ ] **Step 3: Add `chunkText` helper and constants**

Add after the state tracking map:

```typescript
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
```

- [ ] **Step 4: Add tool definitions (reply + react)**

```typescript
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
```

- [ ] **Step 5: Add tool handler (CallToolRequestSchema)**

```typescript
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

      // Add ✅ reaction to the original message
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
      // Add ❌ reaction on failure
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
```

- [ ] **Step 6: Wire up MCP transport and adjust startup order**

Replace the startup section at the bottom of the file:

```typescript
// ========== Start ==========
// MCP transport must connect BEFORE Slack starts (Claude Code expects stdio handshake first)
await mcp.connect(new StdioServerTransport())
await slackApp.start()
console.error('[slack-channel] Server ready — Slack connected, MCP channel active')
```

- [ ] **Step 7: Verify TypeScript compiles without errors**

Run: `bunx tsc --noEmit`
Expected: No errors. (This type-checks without executing, so no tokens needed.)

- [ ] **Step 8: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add MCP server with reply/react tools and channel capability"
```

---

### Task 4: Allowlist & Message Handler

**Files:**
- Modify: `slack-channel.ts`

Add the file-based user allowlist and the Slack message handler that filters, reacts, and forwards messages to Claude Code.

- [ ] **Step 1: Add allowlist imports and loading**

Add `fs` and `path` imports at the top:

```typescript
import * as fs from 'fs'
import * as path from 'path'
```

Add allowlist section after MCP server creation (before tools):

```typescript
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
```

- [ ] **Step 2: Replace the placeholder message handler**

Replace the placeholder `slackApp.message(...)` block with:

```typescript
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

  // Add 👀 reaction to acknowledge receipt
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
    // Add ❌ reaction on MCP forward failure
    await slackApp.client.reactions.add({
      channel,
      timestamp: messageTs,
      name: 'x',
    }).catch(() => {})
    pendingMessages.delete(key)
  }
})
```

- [ ] **Step 3: Create the allowlist file for testing**

Run:
```bash
mkdir -p ~/.claude/channels/slack
echo '{ "allowed_users": ["YOUR_SLACK_USER_ID"] }' > ~/.claude/channels/slack/access.json
```

Replace `YOUR_SLACK_USER_ID` with your actual Slack user ID (found in Slack → Profile → three-dot menu → Copy member ID).

- [ ] **Step 4: Commit**

```bash
git add slack-channel.ts
git commit -m "feat: add user allowlist and Slack message handler with forwarding"
```

---

### Task 5: End-to-End Integration Test

**Files:**
- No new files — this is a manual verification task

This task verifies the complete flow using real Slack and Claude Code.

**Prerequisites:**
- Slack App created with correct scopes and event subscriptions (see spec prerequisites)
- Bot installed to workspace
- `.env` file created with real tokens (copy from `.env.example`)
- Allowlist configured with your Slack user ID

- [ ] **Step 1: Create `.env` with real tokens**

```bash
cp .env.example .env
# Edit .env with your actual Slack tokens
```

- [ ] **Step 2: Update `.mcp.json` with real tokens**

Edit `.mcp.json` and replace the placeholder token values with your actual tokens. (These come from the Slack App you created in the prerequisites.)

- [ ] **Step 3: Verify standalone startup**

Run: `bun slack-channel.ts`
Expected output (stderr):
```
[allowlist] loaded 1 user(s) from /home/user/.claude/channels/slack/access.json
[slack-channel] Server ready — Slack connected, MCP channel active
```

If Slack connection fails, check that `SLACK_APP_TOKEN` starts with `xapp-` and Socket Mode is enabled in the Slack app config.

- [ ] **Step 4: Test with Claude Code**

Run:
```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack
```

Once Claude Code starts:
1. Run `/mcp` in Claude Code — verify `slack` server shows as connected
2. In Slack, invite the bot to a channel: `/invite @your-bot-name`
3. Send a simple message: `hello, what time is it?`
4. Verify:
   - `👀` reaction appears on your message (acknowledging receipt)
   - Claude Code terminal shows the forwarded message
   - A reply appears in a Slack thread under your message
   - `✅` reaction appears on your message (reply sent)

- [ ] **Step 5: Test error cases**

1. Send a message from a non-allowlisted user (or a second Slack account) — should be silently dropped
2. Verify no reaction or response appears for the non-allowlisted message

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: finalize configuration for end-to-end testing"
```

---

## Verification Summary

After completing all tasks, the following should work:

1. `bun slack-channel.ts` starts without errors (logs to stderr only)
2. Claude Code with `--dangerously-load-development-channels server:slack` connects to the MCP server
3. `/mcp` shows slack server as connected
4. Slack messages from allowlisted users get `👀` → forwarded → reply in thread → `✅`
5. Slack messages from non-allowlisted users are silently dropped
6. No output ever goes to stdout (only stderr)
7. Long responses are chunked into multiple Slack messages
