# Slack Channel Agent Design Spec

## Context

**Problem:** When away from the desk (e.g., on phone), there's no way to interact with Claude Code running on the home workstation. The goal is to send commands from Slack on a phone and receive Claude Code's responses back in Slack.

**Approach:** Build a single-file MCP Channel Server that bridges Slack (Socket Mode) and Claude Code (stdio). This leverages Claude Code's experimental Channels feature (v2.1.80+, research preview).

**Target user:** Solo developer, remote-controlling Claude Code from phone via Slack.

---

## Architecture

### Single-File Monolith

One TypeScript file (`slack-channel.ts`) that combines:
- **Slack Bolt App** — Socket Mode WebSocket connection to Slack
- **MCP Server** — stdio-based Channel server for Claude Code

```
Phone/Slack
    |  (Socket Mode WebSocket)
    v
slack-channel.ts (Bun process)
    |  (stdio, MCP protocol)
    v
Claude Code session (--dangerously-skip-permissions)
```

### Runtime

- **Bun** — native TypeScript execution, no build step
- `.mcp.json` uses `bun` as the command

### File Layout

```
slack-channel.ts       # Main server (MCP + Slack Bolt)
package.json           # Dependencies and scripts
tsconfig.json          # TypeScript config (IDE support only)
.mcp.json              # MCP server registration
.env.example           # Template for required env vars
.gitignore             # Exclude .env, node_modules
```

---

## Data Flow

### Message In (Slack -> Claude Code)

1. User sends message in Slack channel/thread
2. Slack Bolt receives via Socket Mode
3. Server checks: is `message.user` in allowlist? If not, drop silently
4. Server checks: is it a bot message or subtype? If yes, ignore
5. Server resolves user's display name via `users.info`
6. Server adds `eyes` emoji reaction (acknowledging receipt)
7. Server sends MCP notification:
   ```
   method: notifications/claude/channel
   params: { content, meta: { channel_id, user_id, user_name, thread_ts } }
   ```
8. Claude Code receives as `<channel source="slack" ...>` XML tag

### Message Out (Claude Code -> Slack)

1. Claude Code calls `reply` tool with `channel_id`, `text`, `thread_ts`
2. Server calls `slackApp.client.chat.postMessage()`
3. Message appears in Slack (in thread if `thread_ts` provided)

### Status Indicators

Automatic emoji reactions on the original message:
- `eyes` — message received, processing
- `white_check_mark` — reply sent successfully
- `x` — error occurred during processing

---

## MCP Tools

### `reply`

Send a text message to Slack.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel_id` | string | yes | Slack channel ID |
| `text` | string | yes | Message text (supports Slack mrkdwn) |
| `thread_ts` | string | no | Thread timestamp for threaded replies |

### `react`

Add an emoji reaction to a message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel_id` | string | yes | Slack channel ID |
| `message_ts` | string | yes | Message timestamp |
| `emoji` | string | yes | Emoji name without colons |

---

## MCP Instructions

The instructions field is critical — it forces Claude to always call the `reply` tool since the user cannot see the terminal.

```
CRITICAL: The user cannot see the terminal at all. The ONLY way they receive
your response is if you call the reply tool. You MUST call reply after every
single Slack message — no exceptions. Never respond only in the terminal.

Messages arrive as <channel source="slack" channel_id="..." user_id="..."
user_name="...">. Always pass back channel_id and thread_ts from the meta.

Keep responses concise — the user is reading on a phone. Use short paragraphs,
bullet points, and code blocks sparingly.
```

---

## Security

### User Allowlist

- **Location:** `~/.claude/channels/slack/access.json`
- **Format:** `{ "allowed_users": ["U12345ABC"] }`
- **Behavior:**
  - Loaded at startup
  - Messages from non-allowlisted users silently dropped
  - Empty/missing file = no users authorized (safe default)

### Message Filtering

- Ignore bot messages (`message.subtype` present)
- Ignore message subtypes (edits, joins, topic changes, etc.)
- Only process plain user messages

### Permission Model

- Claude Code runs with `--dangerously-skip-permissions` (auto-approve all)
- No remote permission approval relay (removed for simplicity)
- Security relies entirely on the allowlist gating who can send commands

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | yes | Bot user OAuth token (xoxb-...) |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode (xapp-...) |
| `SLACK_SIGNING_SECRET` | yes | App signing secret |

---

## Session Lifecycle

### Startup Sequence

1. Load environment variables (from process.env)
2. Initialize Slack Bolt App with Socket Mode
3. Initialize MCP Server with `claude/channel` capability
4. Load user allowlist from disk
5. Register Slack message handler
6. Connect MCP via StdioServerTransport
7. Start Slack app (`slackApp.start()`)
8. Log "ready" to stderr

### Launch Command

```bash
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels \
       server:slack
```

### Persistence

- Claude Code process must remain alive for channel to work
- Use persistent terminal session (tmux/screen on macOS, or keep terminal open)
- If Claude Code exits, MCP server exits, Slack bot disconnects

### Error Handling

- **Slack API errors:** Log to stderr, add `x` reaction to message. Bolt has built-in Socket Mode reconnection.
- **MCP transport errors:** Process exits, requires restart of `claude` command.
- **Allowlist file missing:** Empty set, no users authorized.
- **User resolution failure:** Fall back to "unknown" user name.

---

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "latest",
  "@slack/bolt": "latest",
  "zod": "latest"
}
```

Dev dependencies: `typescript`, `@types/node` (for IDE support).

---

## Verification Plan

1. **Unit check:** Run `bun slack-channel.ts` standalone — should start without errors and log "ready" to stderr
2. **MCP check:** In Claude Code session, run `/mcp` — slack server should show "connected"
3. **Allowlist check:** Send message from non-allowlisted user — should be silently dropped
4. **End-to-end check:** Send message from allowlisted user in Slack — should get `eyes` reaction, then a reply in thread, then `white_check_mark` reaction
5. **Error check:** Send message that causes Claude to error — should get `x` reaction

---

## Constraints & Risks

- **Research preview:** Claude Code Channels API may change without notice
- **Version requirement:** Claude Code v2.1.80+
- **Not in Slack whitelist:** Must use `--dangerously-load-development-channels` flag
- **Single session:** One Claude Code instance at a time per channel server
- **No message buffering:** If Claude Code is not running, Slack messages are lost
