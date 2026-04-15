# Daily Digest Project — Plan

## Goal
Every day at 08:00, collect latest posts from Anthropic (news + engineering) and Karpathy (blog + YouTube), summarize in Chinese, publish as a dated HTML page on the existing repo `wweixiaoyu-hue/claude-slack-agent`, and post the URL back to Slack.

## Key Design Choice: Claude-as-Worker via /loop
Instead of writing a scraper + calling the Claude API for translation, we use Claude Code itself (running inside `/loop`) as the worker. Claude fetches, summarizes, and commits directly. No API key needed.

## Sources & Endpoints
| Source | URL | Method |
|---|---|---|
| Anthropic news | `https://www.anthropic.com/news` | HTML scrape |
| Anthropic engineering | `https://www.anthropic.com/engineering` | HTML scrape |
| Karpathy blog | `https://karpathy.bearblog.dev/blog/` + `/feed/` | RSS |
| Karpathy YouTube | `https://www.youtube.com/feeds/videos.xml?user=AndrejKarpathy` (verify channel id) | RSS |

## Deliverables
1. `daily-digest/` directory in repo root
2. `daily-digest/YYYY-MM-DD.html` — one file per day
3. `daily-digest/index.html` — auto-updated list of all archived days, newest first
4. `daily-digest/state.json` — tracks last-seen item per source so we only publish *new* items
5. `.claude/commands/daily-digest.md` — slash command that tells Claude exactly what to do each fire
6. `daily-digest/template.html` — simple page template (header, date, grouped sections)

## GitHub Pages
Currently **disabled** (404 on wweixiaoyu-hue.github.io/claude-slack-agent/).
Options:
- **A. Enable Pages** (recommended) — publish from `main` branch `/daily-digest` folder. User has to click once in repo Settings → Pages.
- **B. Raw links** — URL format `https://raw.githubusercontent.com/wweixiaoyu-hue/claude-slack-agent/main/daily-digest/YYYY-MM-DD.html` — loads as plain text, not rendered HTML. Bad UX.
- **C. htmlpreview.github.io** — wrap raw link with `https://htmlpreview.github.io/?<raw-url>`. Works but slow.

**Recommendation: A.** User enables Pages once, done.

## /loop Integration
- User runs `/loop 24h /daily-digest` at 8am (first fire immediate, then every 24h)
- `/daily-digest` slash command does:
  1. Read `daily-digest/state.json` (last-seen per source)
  2. Fetch each source, diff against state
  3. For each new item: fetch full content, write one-paragraph Chinese summary
  4. Render today's page from template
  5. Regenerate `index.html`
  6. Update `state.json`
  7. `git add daily-digest/ && git commit && git push`
  8. Reply to Slack with `https://wweixiaoyu-hue.github.io/claude-slack-agent/YYYY-MM-DD.html`

## Caveats to Flag
- `/loop` dies if Claude Code exits — user must keep a session alive. If computer reboots, loop needs to be restarted manually.
- First run will backfill: all "last-seen" values empty → tons of articles. Need to decide: publish backlog or silently set state to current and start fresh tomorrow? → **Set state fresh, start tomorrow** (otherwise first page is huge).
- YouTube channel ID for Karpathy needs verification — may be `UCPk3RMMXAfLhMJPFpQhye9g` but I'll verify via `/@AndrejKarpathy` page.
- Anthropic pages are JS-heavy; WebFetch may miss items. Fallback: scrape with a headless approach or accept minor misses.

## Task Breakdown
- [ ] User confirms plan + picks Pages option (A/B/C)
- [ ] User enables GitHub Pages in repo settings (if A)
- [ ] Create `daily-digest/` scaffold (template, empty state.json, README)
- [ ] Create `.claude/commands/daily-digest.md` slash command
- [ ] Dry run: invoke `/daily-digest` manually, verify output
- [ ] Seed state.json with current items (skip backlog)
- [ ] Commit + push
- [ ] Verify page is live at Pages URL
- [ ] Document loop startup procedure in `README.md`

## Open Questions for User
1. Pages option A/B/C?
2. Backfill behavior: skip backlog, or publish all history on day 1?
3. Page styling: minimal (shadcn-ish card list) or plain text?
4. What should Slack notification look like — just the URL, or with a preview of today's items?
