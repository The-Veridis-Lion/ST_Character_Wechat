# Commands

## Design Principles

`ST Character WeChat` does not hard-code one shared string format across terminal commands, WeChat commands, and different agent runtimes.

It defines stable internal actions first, then lets each channel expose its own entrypoints:

- core action: stable internal meaning
- terminal command: terminal entrypoint
- weixin command: WeChat entrypoint

This keeps the core naming stable when new runtimes or channels are added later.

The runtime can be `codex`, `claudecode`, or `gemini`, but the documented command surface stays the same.

## Current Action Groups

### Lifecycle & Diagnostics

- `app.login`
- `app.accounts`
- `app.start`
- `app.shared_start`
- `app.shared_open`
- `app.shared_status`
- `app.doctor`

### Workspace & Thread

- `workspace.bind`
- `workspace.status`
- `character.manage`
- `thread.new`
- `thread.reread`
- `thread.compact`
- `thread.auto_compact`
- `thread.switch`
- `thread.stop`
- `channel.chunk_min`
- `report.daily_card`
- `report.weekly_card`

### Approvals & Control

- `approval.accept_once`
- `approval.accept_character_once`
- `approval.reject_once`

### Capabilities

- `model.inspect`
- `model.select`
- `channel.send_file`
- `timeline.write`
- `reminder.create`
- `diary.append`
- `app.star`
- `app.help`

## Current Terminal Commands

The intentionally small public set is:

- `npm run login`
- `npm run accounts`
- `npm run shared:start`
- `npm run shared:open`
- `npm run shared:status`
- `npm run doctor`
- `npm run help`

## Project Tools

Some internal structured tools are reserved for local services and report work; normal character replies should stay as character chat.

Those capabilities are exposed as project-native structured tools:

- `st_character_wechat_channel_send_file`
- `st_character_wechat_diary_append`
- `st_character_wechat_reminder_create`
- `st_character_wechat_system_send`
- `st_character_wechat_timeline_write`
- `st_character_wechat_timeline_build`
- `st_character_wechat_timeline_serve`
- `st_character_wechat_timeline_dev`
- `st_character_wechat_timeline_screenshot`

Notes:
- These tools are bound to the ST Character WeChat project and routed through the repo's internal tool host.
- Claude Code loads them through workspace-local `.mcp.json` injected by ST Character WeChat and passed to Claude at startup with `--mcp-config`.
- Codex loads them through the runtime-side ST Character WeChat MCP bridge configured at spawn time.
- The public human terminal surface stays intentionally small: lifecycle commands plus shared bridge scripts.

## Character-Only WeChat Commands

- `/bind`
- `/status`
- `/char list`
- `/char use <name|number>`
- `/char current`
- `/char reload`
- `/char reset`
- `/new`
- `/reread`
- `/compact`
- `/compact auto`
- `/compact auto on`
- `/compact auto off`
- `/compact auto <percent>`
- `/stop`
- `/switch`
- `/chunk <number>`
- `/dailycard`
- `/diarycard`
- `/weeklycard`
- `/yes`
- `/always`
- `/no`
- `/model`
- `/model <id>`
- `/star`
- `/help`

Notes:

- `/status` covers the active character thread, workspace, model, and context details
- there is no separate `/context` command; use `/status` and read the `📦 context` line
- API runtime status reports local history character count and message count instead of token-window remaining percentage
- `/new` is the same as `/char reset`; it resets the active character's isolated thread
- `/compact` asks the active character thread to compact its context and reports start / finish back to WeChat
- `/compact auto` shows or changes silent automatic compact for the active character thread; it defaults to `75%` used context
- compacting only reduces runtime thread context; it does not delete local user-memory records used for recall and report cards
- `/reread` is disabled in character-only mode because the character prompt is rebuilt from the active card for every message
- `/switch` is disabled in character-only mode; use `/char use <name|number>` to switch characters
- `/stop` stops the active character's current turn
- `/yes`, `/always`, and `/no` answer pending approvals on the active character thread only
- `/model` reads or updates model parameters for the active character binding
- `/char` commands scan local SillyTavern character cards and switch the active character for this WeChat sender
- `/char opening` is intentionally not available; `first_mes` and `alternate_greetings` are not used for WeChat character chat
- `/dailycard`, `/diarycard`, and `/weeklycard` generate long PNG reports from local user-memory date ranges, runtime JSON, and fixed HTML templates
- `/checkin`, `/weekly`, `/userstatus`, and `/statuscard` are legacy names; if typed, they return disabled/replacement guidance
- file sending is still available, but no longer exposed as a WeChat command

See [report-card-placeholders.md](./report-card-placeholders.md) for the daily / weekly long-image report boundary.

For manual character-card cleanup, open [00_START_HERE.html](../00_START_HERE.html) and use the `角色卡修改` tab. The editor saves a complete modified card as `.modified.json` or `.modified.png`; `*.override.json` files inside `character-cards/` are ignored by card scanning.

The root setup console is [00_START_HERE.html](../00_START_HERE.html). It includes manual install steps, agent install prompts, runtime `.env` saving, local card scanning, character-card edits, and report template customization.
