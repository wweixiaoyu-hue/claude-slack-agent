---
description: Collect new posts from Anthropic + Karpathy, write today's Chinese digest, commit, and post URL to Slack
---

# /daily-digest

You are running the daily digest job. Today's date is the current local date; use it as `YYYY-MM-DD` everywhere below.

## Sources

| Key | URL |
|---|---|
| `anthropic_news` | https://www.anthropic.com/news |
| `anthropic_engineering` | https://www.anthropic.com/engineering |
| `karpathy_blog` | https://karpathy.bearblog.dev/blog/ (also try `/feed/`) |
| `karpathy_youtube` | https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ (fallback: https://www.youtube.com/@AndrejKarpathy/videos) |

## Procedure

1. **Read state.** Open `daily-digest/state.json`. It has `{anthropic_news: [...], anthropic_engineering: [...], karpathy_blog: [...], karpathy_youtube: [...]}` — each value is a list of URLs already published.

2. **Fetch each source in parallel** (dispatch 4 subagents — one per source). Each subagent should:
   - Fetch the source listing
   - For each item NOT in state, fetch the full page
   - Return JSON: `[{title, url, date, summary_zh}]` — `summary_zh` is one concise Chinese paragraph (60–150 chars), conveying the actual point of the article (not a literal title translation)
   - Sort newest-first

3. **If every source returns zero new items**, do NOT write a new dated file. Reply to Slack: `今日无新内容。` and stop.

4. **Otherwise, write `daily-digest/YYYY-MM-DD.md`** using this layout:

   ```markdown
   # Daily Digest — YYYY-MM-DD

   _Anthropic + Karpathy 中文速览_

   ## Anthropic News

   - **[Title](url)** — YYYY-MM-DD
     summary_zh
   - ...

   ## Anthropic Engineering
   ...

   ## Karpathy — Blog
   ...

   ## Karpathy — YouTube
   ...

   ---
   _自动生成 by `/daily-digest`_
   ```

   Skip any section that has zero new items.

5. **Update `daily-digest/index.md`** — keep a reverse-chronological list of all dated files. Add today's at the top. Format: `- [YYYY-MM-DD](YYYY-MM-DD.md) — N items`.

6. **Update `daily-digest/state.json`** — append all new URLs from this run to the appropriate lists.

7. **Commit and push:**
   ```
   git add daily-digest/
   git commit -m "daily-digest: YYYY-MM-DD"
   git push
   ```

8. **Reply to Slack** with the GitHub URL plus a brief Chinese summary of what's in today's report:

   ```
   今日 Daily Digest 已发布：
   https://github.com/wweixiaoyu-hue/claude-slack-agent/blob/main/daily-digest/YYYY-MM-DD.md

   • Anthropic News N 条：<2-3 bullet 高亮>
   • Anthropic Engineering N 条：<高亮>
   • Karpathy 博客 N 条：<高亮>
   • Karpathy YouTube N 条：<高亮>
   ```

## Notes

- Anthropic pages are JS-heavy. If the index page returns few items, fall back to `https://www.anthropic.com/sitemap.xml` or `sitemap_index.xml` and grep for `/news/` or `/engineering/` URLs.
- Karpathy YouTube RSS occasionally 404s for this channel — fall back to scraping `/@AndrejKarpathy/videos`.
- Do NOT include items already in `state.json`. State is the source of truth for "已发布".
- All summaries must be Chinese.
