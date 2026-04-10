# Slack Channel Agent 部署文档

## 架构概览

```
Slack (云端)                    本地机器
  │                              │
  │  WebSocket (Socket Mode)     │
  ├─────────────────────────────►│  slack-channel.ts (MCP Server)
  │                              │    ├─ Slack Bolt: 接收消息
  │                              │    ├─ 消息队列: 串行处理
  │                              │    ├─ JSONL 日志: 持久化记录
  │                              │    └─ MCP stdio: 与 Claude Code 通信
  │                              │          │
  │                              │          │ stdin/stdout (JSON-RPC)
  │                              │          ▼
  │                              │    Claude Code (CLI)
  │                              │      └─ 调用 reply/react 工具回复 Slack
  │◄─────────────────────────────┤
  │  Slack API (HTTP)            │
```

**工作原理：**

1. Claude Code 启动时读取 `.mcp.json`，发现 `slack` 这个 MCP server
2. Claude Code 通过 `npx tsx slack-channel.ts` 启动 MCP server 进程
3. MCP server 通过 **stdio**（stdin/stdout）与 Claude Code 建立 JSON-RPC 通信
4. MCP server 同时通过 **Socket Mode WebSocket** 连接 Slack
5. 用户在 Slack 发消息 → MCP server 收到 → 通过 MCP channel notification 转发给 Claude Code
6. Claude Code 处理后调用 `reply` 工具 → MCP server 收到工具调用 → 通过 Slack API 发送回复

**关键点：** MCP server 是 Claude Code 的子进程，不需要独立部署或常驻运行。Claude Code 会自动管理它的生命周期。

---

## 前置条件

### 1. 创建 Slack App

访问 https://api.slack.com/apps → **Create New App** → **From scratch**

#### App Manifest（推荐方式）

在 App 设置页面选择 **App Manifest**，粘贴以下 YAML：

```yaml
display_information:
  name: claude-agent
  description: Claude Code Slack Agent

features:
  bot_user:
    display_name: claude-agent
    always_online: true

oauth_config:
  scopes:
    bot:
      - channels:history     # 读取公共频道消息
      - channels:read        # 读取频道信息
      - chat:write           # 发送消息
      - reactions:read       # 读取 emoji 反应
      - reactions:write      # 添加/移除 emoji 反应
      - users:read           # 读取用户信息（显示名）
      - groups:history       # 读取私有频道消息（可选）
      - im:history           # 读取私信消息（可选）

settings:
  event_subscriptions:
    bot_events:
      - message.channels     # 公共频道消息事件
      - message.groups       # 私有频道消息事件（可选）
      - message.im           # 私信消息事件（可选）
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true  # 必须启用
  token_rotation_enabled: false
```

#### 手动配置（如不用 Manifest）

1. **Socket Mode**: Settings → Socket Mode → Enable
2. **Event Subscriptions**: Features → Event Subscriptions → Enable → Subscribe to bot events:
   - `message.channels`
3. **Bot Token Scopes**: Features → OAuth & Permissions → Bot Token Scopes → Add:
   - `channels:history`, `channels:read`, `chat:write`, `reactions:read`, `reactions:write`, `users:read`
4. **Install App**: Settings → Install App → Install to Workspace → 授权

#### 获取 Token

| Token | 位置 | 格式 |
|-------|------|------|
| Bot Token | OAuth & Permissions → Bot User OAuth Token | `xoxb-...` |
| App Token | Basic Information → App-Level Tokens → Generate (scope: `connections:write`) | `xapp-...` |
| Signing Secret | Basic Information → App Credentials → Signing Secret | 32 位 hex |

### 2. 安装 Claude Code

```bash
# macOS/Linux
npm install -g @anthropic-ai/claude-code

# Windows
npm install -g @anthropic-ai/claude-code

# 验证
claude --version
```

### 3. 安装 Node.js

需要 Node.js 18+。验证：

```bash
node --version   # v18.0.0+
npm --version
```

---

## 部署步骤

### Step 1: 克隆项目

```bash
git clone <repo-url> claude-slack-agent
cd claude-slack-agent
npm install
```

### Step 2: 配置 MCP Server

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["tsx", "slack-channel.ts"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-你的-bot-token",
        "SLACK_APP_TOKEN": "xapp-你的-app-token",
        "SLACK_SIGNING_SECRET": "你的-signing-secret"
      }
    }
  }
}
```

> **安全提示：** `.mcp.json` 已在 `.gitignore` 中排除。不要将 Token 提交到 Git。

### Step 3: 配置用户白名单

创建白名单文件：

```bash
# macOS/Linux
mkdir -p ~/.claude/channels/slack
echo '{ "allowed_users": ["你的Slack用户ID"] }' > ~/.claude/channels/slack/access.json

# Windows (PowerShell)
New-Item -Path "$env:USERPROFILE\.claude\channels\slack" -ItemType Directory -Force
Set-Content -Path "$env:USERPROFILE\.claude\channels\slack\access.json" -Value '{ "allowed_users": ["你的Slack用户ID"] }'
```

**获取 Slack 用户 ID：**
1. 在 Slack 中点击用户头像 → Profile
2. 点击 `⋮` → Copy member ID
3. 格式为 `U` + 字母数字，如 `U0AKNSSHH18`

### Step 4: 邀请 Bot 到频道

在 Slack 频道中输入：

```
/invite @claude-agent
```

### Step 5: 启动 Claude Code

```bash
cd claude-slack-agent

claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack
```

启动后 Claude Code 会自动：
1. 读取 `.mcp.json` 中的 MCP server 配置
2. 执行 `npx tsx slack-channel.ts` 启动 MCP server
3. MCP server 连接 Slack Socket Mode
4. 开始监听 Slack 消息

> **注意：** `--dangerously-skip-permissions` 让 Claude Code 自动批准所有工具调用（包括文件读写、命令执行）。白名单是安全的外层门控。

### Step 6: 验证

1. 在 Slack 频道发一条消息
2. 应该看到 ⏳ emoji 反应（正在处理）
3. 几秒后收到 Claude 的回复，并看到 ✅ emoji 反应
4. 检查日志：

```bash
# macOS/Linux
cat ~/.claude/channels/slack/logs/$(date +%Y-%m-%d).jsonl | jq .

# Windows (Git Bash)
cat "$USERPROFILE/.claude/channels/slack/logs/$(date +%Y-%m-%d).jsonl" | jq .
```

---

## 后台运行（生产环境）

Claude Code 需要持续运行。推荐使用终端复用工具：

### macOS/Linux: tmux

```bash
# 创建会话
tmux new -s claude-slack

# 在 tmux 中启动
cd ~/claude-slack-agent
claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack

# 分离会话: Ctrl+B, D
# 重新连接: tmux attach -t claude-slack
```

### Windows: 保持终端窗口打开

Windows 上最简单的方式是保持一个终端窗口运行 Claude Code。或者使用 Windows Terminal 的多标签功能。

### 使用 PM2（高级）

> 注意：PM2 管理的是 Claude Code CLI 进程，不是 MCP server。

```bash
npm install -g pm2
pm2 start "claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack" --name claude-slack --cwd /path/to/claude-slack-agent
pm2 save
pm2 startup  # 设置开机自启
```

---

## 文件结构

```
claude-slack-agent/
├── slack-channel.ts          # MCP server 主文件（唯一需要的代码文件）
├── package.json              # 依赖声明
├── tsconfig.json             # TypeScript 配置
├── .mcp.json                 # MCP server 注册（含 Token，不提交 Git）
├── .env.example              # Token 模板
└── .gitignore                # 排除 .env, .mcp.json, node_modules
```

运行时自动创建的文件：

```
~/.claude/channels/slack/
├── access.json               # 用户白名单
└── logs/
    ├── 2026-04-10.jsonl       # 按天的消息处理日志
    └── ...
```

---

## 消息队列状态

在 Slack 中，每条消息的 emoji 反应反映处理状态：

| Emoji | 含义 |
|-------|------|
| 👀 | 已接收，排队等待中 |
| ⏳ | 正在处理 |
| ✅ | 处理完成 |
| ⏰ | 处理超时（>300s），仍在等待 |
| ❌ | 处理失败 |

---

## 日志查询

日志文件位于 `~/.claude/channels/slack/logs/{日期}.jsonl`，每行一条 JSON 记录。

```bash
# 查看今天所有事件
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq .

# 查看超时或失败的消息
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.event == "timeout" or .event == "failed")'

# 查看某个用户的消息
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.user == "danny")'

# 计算平均处理时间
cat ~/.claude/channels/slack/logs/2026-04-10.jsonl | jq 'select(.event == "completed") | .duration_s' | awk '{s+=$1; n++} END {print s/n "s"}'
```

---

## 故障排查

### Bot 不响应消息

1. **检查白名单：** 确认你的 Slack 用户 ID 在 `~/.claude/channels/slack/access.json` 中
2. **检查 Bot 是否在频道中：** 在频道中输入 `/invite @claude-agent`
3. **检查 Claude Code 是否在运行：** 终端中应能看到 Claude Code 界面
4. **检查日志：** 查看 `~/.claude/channels/slack/logs/` 下是否有日志文件

### 看到 👀 但没有后续反应

消息被接收但未被处理。可能原因：
- Claude Code 正在处理前一条消息（等待即可）
- MCP 连接断开（重启 Claude Code）

### 看到 ⏳ 但一直没有 ✅

Claude Code 正在处理但耗时较长。超过 60s 后会在线程中发送心跳通知，超过 300s 会标记超时。

### Token 过期或无效

```
[bolt:error] An API error occurred: invalid_auth
```

重新在 Slack App 设置中获取 Token，更新 `.mcp.json`。

---

## 多机器部署注意事项

1. **每台机器独立运行。** 每台机器运行自己的 Claude Code + MCP server 实例
2. **不要多台机器连同一个 Slack Bot。** 会导致消息被重复处理。如需多机器，为每台创建独立的 Slack App
3. **Token 不共享。** 每台机器有自己的 `.mcp.json` 和 Token
4. **白名单可以相同。** `access.json` 可以包含相同的用户 ID
5. **日志是本地的。** 每台机器的日志存在各自的 `~/.claude/channels/slack/logs/`
