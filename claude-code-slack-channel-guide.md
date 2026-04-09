# Claude Code Channels + Slack 个人开发助手方案

## 架构总览

```
Slack (你发消息)
    ↕ Socket Mode (WebSocket)
Slack Channel Server (MCP 进程)
    ↕ stdio
Claude Code 本地会话 (读消息 → 执行 → 调 reply tool 回复)
```

核心思路：写一个 **MCP Server**，它同时是 Slack Bot，把 Slack 消息推送给 Claude Code，Claude Code 通过 MCP tool 回复到 Slack。

---

## 第一步：创建 Slack App

1. 去 [api.slack.com/apps](https://api.slack.com/apps) 创建应用
2. 启用 **Socket Mode**（避免暴露公网端口）
3. 获取三个 token：
   - `SLACK_BOT_TOKEN` (xoxb-...)
   - `SLACK_APP_TOKEN` (xapp-...)
   - `SLACK_SIGNING_SECRET`
4. Bot 权限需要：`chat:write`, `reactions:write`, `channels:history`, `users:read`

---

## 第二步：创建项目

```bash
mkdir slack-channel && cd slack-channel
npm init -y
npm install @modelcontextprotocol/sdk @slack/bolt zod
```

---

## 第三步：编写 Channel Server

### 3.1 MCP Server 声明

Channel MCP Server 必须声明以下 capabilities：

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { App } from '@slack/bolt'

const mcp = new Server(
  { name: 'slack', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},              // 必须：注册为 channel
        'claude/channel/permission': {},   // 可选：远程审批工具调用
      },
      tools: {},                           // 必须：暴露 reply 等工具
    },
    instructions: `Messages arrive as <channel source="slack" channel_id="..." user_id="...">.
Reply with the reply tool.`,
  },
)
```

### 3.2 消息推送（Slack → Claude Code）

```typescript
// 当 Slack 收到消息时，推送给 Claude
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: '帮我修复 auth 模块的 bug',
    meta: {
      channel_id: 'C123XYZ',
      user_id: 'U456ABC',
      user_name: 'alice',
      thread_ts: '1712579400.000100',
    },
  },
})
```

Claude 看到的效果：

```xml
<channel source="slack" channel_id="C123XYZ" user_id="U456ABC" user_name="alice">
帮我修复 auth 模块的 bug
</channel>
```

### 3.3 回复工具（Claude Code → Slack）

```typescript
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to Slack',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          text: { type: 'string' },
          thread_ts: { type: 'string', description: 'reply in thread' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          message_ts: { type: 'string' },
          emoji: { type: 'string', description: 'emoji name without colons' },
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
      thread_ts?: string
    }
    await slackApp.client.chat.postMessage({ channel: channel_id, text, thread_ts })
    return { content: [{ type: 'text', text: 'sent' }] }
  }

  if (name === 'react') {
    const { channel_id, message_ts, emoji } = args as {
      channel_id: string
      message_ts: string
      emoji: string
    }
    await slackApp.client.reactions.add({
      channel: channel_id,
      timestamp: message_ts,
      name: emoji.replace(/:/g, ''),
    })
    return { content: [{ type: 'text', text: 'reacted' }] }
  }

  throw new Error(`unknown tool: ${name}`)
})
```

### 3.4 安全：发送者白名单

**必须做**，否则任何人 @ 你的 bot 都会触发 Claude 执行代码。

```typescript
import * as fs from 'fs'
import * as path from 'path'

const allowlistPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude/channels/slack/access.json'
)

let allowlist = new Set<string>()

function loadAllowlist(): void {
  try {
    const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'))
    allowlist = new Set(data.allowed_users || [])
  } catch {
    allowlist = new Set()
  }
}

function saveAllowlist(): void {
  const dir = path.dirname(allowlistPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({ allowed_users: Array.from(allowlist) }, null, 2)
  )
}

loadAllowlist()
```

在消息处理中使用：

```typescript
slackApp.message(async ({ message }) => {
  if (!allowlist.has(message.user)) return // 静默丢弃非白名单用户
  // ... 转发给 Claude
})
```

### 3.5 远程权限审批（可选）

Claude 想执行危险操作时，推送审批请求到 Slack，你回复 `yes/no` + request_id 即可。

```typescript
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const approvalChannel = process.env.SLACK_APPROVAL_CHANNEL
  await slackApp.client.chat.postMessage({
    channel: approvalChannel,
    text: `Claude wants to run **${params.tool_name}**: ${params.description}\n\n` +
          `Reply: \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
  })
})

// 在消息处理中解析审批回复
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

slackApp.message(async ({ message }) => {
  const text = message.text
  const permMatch = PERMISSION_REPLY_RE.exec(text)

  if (permMatch) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return
  }

  // ... 正常消息处理
})
```

---

## 第四步：完整代码

```typescript
#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { App } from '@slack/bolt'
import * as fs from 'fs'
import * as path from 'path'

// ========== Slack App ==========
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

// ========== MCP Server ==========
const mcp = new Server(
  { name: 'slack', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: `Messages arrive as <channel source="slack" channel_id="..." user_id="..." user_name="...">.\nReply with the reply tool, passing channel_id and optional thread_ts.`,
  },
)

// ========== Allowlist ==========
const allowlistPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude/channels/slack/access.json'
)
let allowlist = new Set<string>()

function loadAllowlist(): void {
  try {
    const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'))
    allowlist = new Set(data.allowed_users || [])
  } catch {
    allowlist = new Set()
  }
}

function saveAllowlist(): void {
  const dir = path.dirname(allowlistPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(allowlistPath, JSON.stringify({ allowed_users: Array.from(allowlist) }, null, 2))
}

loadAllowlist()

// ========== Tools ==========
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to Slack',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Slack channel ID' },
          text: { type: 'string', description: 'Message text (supports Slack mrkdwn)' },
          thread_ts: { type: 'string', description: 'Optional: reply in thread' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          message_ts: { type: 'string' },
          emoji: { type: 'string', description: 'Emoji name without colons' },
        },
        required: ['channel_id', 'message_ts', 'emoji'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === 'reply') {
    const { channel_id, text, thread_ts } = args as any
    await slackApp.client.chat.postMessage({ channel: channel_id, text, thread_ts })
    return { content: [{ type: 'text', text: 'sent' }] }
  }

  if (name === 'react') {
    const { channel_id, message_ts, emoji } = args as any
    await slackApp.client.reactions.add({
      channel: channel_id,
      timestamp: message_ts,
      name: emoji.replace(/:/g, ''),
    })
    return { content: [{ type: 'text', text: 'reacted' }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// ========== Permission Relay ==========
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const approvalChannel = process.env.SLACK_APPROVAL_CHANNEL
  if (!approvalChannel) return

  await slackApp.client.chat.postMessage({
    channel: approvalChannel,
    text: `Claude wants to run *${params.tool_name}*: ${params.description}\n\nReply: \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
  })
})

// ========== Slack Message Handler ==========
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

slackApp.message(async ({ message }) => {
  if (message.type !== 'message' || (message as any).subtype) return

  const text = (message as any).text || ''
  const user = (message as any).user
  const channel = (message as any).channel
  const thread_ts = (message as any).thread_ts || ''

  // Gate on sender
  if (!allowlist.has(user)) return

  // Check for permission verdict
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission' as any,
      params: {
        request_id: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return
  }

  // Resolve user name
  let userName = 'unknown'
  try {
    const userInfo = await slackApp.client.users.info({ user })
    userName = (userInfo.user as any)?.real_name || 'unknown'
  } catch {}

  // Forward to Claude Code
  await mcp.notification({
    method: 'notifications/claude/channel' as any,
    params: {
      content: text,
      meta: {
        user_id: user,
        user_name: userName,
        channel_id: channel,
        thread_ts,
      },
    },
  })
})

// ========== Start ==========
await mcp.connect(new StdioServerTransport())
await slackApp.start()
console.error('Slack channel server started')
```

### package.json

```json
{
  "name": "claude-slack-channel",
  "version": "0.0.1",
  "type": "module",
  "main": "slack-channel.js",
  "scripts": {
    "build": "tsc",
    "start": "node slack-channel.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "@slack/bolt": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "@types/node": "latest"
  }
}
```

---

## 第五步：注册和启动

### 开发阶段

在项目目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["./slack-channel.js"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_SIGNING_SECRET": "...",
        "SLACK_APPROVAL_CHANNEL": "C00000000"
      }
    }
  }
}
```

启动：

```bash
claude --dangerously-load-development-channels server:slack
```

### 发布后

打包为插件发布到 marketplace，然后：

```bash
claude --channels plugin:slack@your-marketplace
```

---

## 第六步：验证

1. 在 Claude Code 会话中运行 `/mcp`，确认 slack server 状态为 connected
2. 在 Slack 频道里发一条消息
3. Claude Code 终端应该收到 `<channel>` 标签并响应
4. 回复应出现在 Slack 中

---

## 完整消息流

```
你在 Slack: "@Claude 帮我看看为什么测试挂了"
    ↓ Socket Mode
Slack Channel Server: 验证白名单 → 推送 notification
    ↓ stdio (MCP)
Claude Code: 收到 <channel> 标签 → 读代码 → 跑测试 → 发现问题
    ↓ 调用 reply tool
Slack Channel Server: chat.postMessage()
    ↓ Slack API
你在 Slack 看到: "测试失败是因为 mock 数据过期了，我已经更新了 fixtures..."
```

---

## 注意事项

| 项目 | 说明 |
|------|------|
| **版本要求** | Claude Code v2.1.80+ |
| **状态** | 研究预览，API 可能变动 |
| **生命周期** | Claude Code 会话关闭 = channel 断开 |
| **持久化运行** | 需要 `tmux`/`screen` 保持 Claude Code 会话打开 |
| **安全** | 必须配置白名单，否则任何人都能触发代码执行 |

---

## 调试

```bash
# 检查 MCP 连接状态
/mcp

# 查看调试日志
cat ~/.claude/debug/<session-id>.txt

# 常见问题
# - 消息不到达：检查白名单 access.json
# - Tool not found：确认 capabilities.tools: {} 已声明
# - 连接失败：确认 Socket Mode token 正确
```
