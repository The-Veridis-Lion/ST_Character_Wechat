<div align="center">

Install guide: [中文](./INSTALL.zh-CN.md) · English · [Back to home](../README.en.md)

# ST Character WeChat Install Guide
## Let Codex / Claude Code install it, or follow the steps manually

> If you do not want to read commands first, open [00_START_HERE.html](../00_START_HERE.html) in the project root. It keeps setup, install prompts, card folders, and template editing in one local page.

[![Node >=22](https://img.shields.io/badge/Node-22%2B-3C873A)](../package.json)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-b31b1b)](../LICENSE)

</div>

This page is the longer setup guide. In plain terms: install Node.js 22+, put character cards into `character-cards/`, then scan the WeChat login QR code. The prompt below is written for Codex / Claude Code so they can handle most of the setup for you.

## Install With Codex Or Claude Code

If you want an AI coding agent to install this project for you, start Codex or Claude Code and paste this:

```text
Download and install this GitHub repository locally:
https://github.com/The-Veridis-Lion/ST_Character_Wechat.git

Follow the README's autonomous install instructions for Codex / Claude Code.
Prefer a local runtime: use ST_CHARACTER_WECHAT_RUNTIME=codex if you are Codex, or ST_CHARACTER_WECHAT_RUNTIME=claudecode if you are Claude Code.
Create only local untracked setup files such as .env and ~/.st-character-wechat/*.
Do not commit or upload .env, API keys, WeChat login state, private SillyTavern cards, local memory, report PNGs, node_modules, generated archives, or extra launchers created outside this repository.
Install dependencies, create the local .env directly, use the project-local character-cards folder for cards, run checks, start WeChat login, and pause only when terminal QR scanning or a remote API key is needed. When installation is done, output that installation is complete. Windows users can later double-click 01_START_WECHAT.bat in the project root; when they want to update app files from GitHub and start, they can run 04_UPDATE_AND_START_WECHAT.bat. It works for git clones and GitHub ZIP folders; the first run from a ZIP folder connects it to the GitHub update source. Updates refresh app files and run npm install, but do not clean .env, character-cards, local memory, reports, state folders, or node_modules. If the user explicitly wants startup on boot, run 02_ENABLE_STARTUP.bat to create a normal-start shortcut in the Windows Startup folder. To disable startup later, run 05_DISABLE_STARTUP.bat. Remote API settings can be changed later in 00_START_HERE.html under Model / API.
```

Autonomous install steps:

1. If the current directory is not already this repository, clone it into `ST_Character_Wechat` or use the downloaded GitHub ZIP folder, then `cd` into the project root.
2. Verify Node.js is available and `node --version` is `22` or newer. If not, complete Node.js 22+ setup guidance before continuing.
3. Run `npm install`.
4. Use the project-local `character-cards/` folder for role cards. Create it if missing, then put SillyTavern JSON / PNG cards there. Run `npm run cards:list` to scan this fixed folder directly and list existing cards; do not ask for a card path.
5. Create `.env` from [`.env.example`](../.env.example) directly; do not ask the user to fill it in through the web page first. At minimum set:

```dotenv
ST_CHARACTER_WECHAT_USER_NAME=
ST_CHARACTER_WECHAT_USER_GENDER=female
ST_CHARACTER_WECHAT_LOCAL_TIME_ZONE=Asia/Shanghai
ST_CHARACTER_WECHAT_LOCAL_LOCATION=
ST_CHARACTER_WECHAT_WORKSPACE_ROOT=/absolute/path/to/ST_Character_Wechat
ST_CHARACTER_WECHAT_RUNTIME=codex
ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR=./character-cards
ST_CHARACTER_WECHAT_ALLOWED_USER_IDS=
```

Leave `ST_CHARACTER_WECHAT_ALLOWED_USER_IDS` empty for the first local test if the WeChat sender id is not known yet. Character-only mode will lock onto the first sender seen by the running process. For later use, set it to that sender id.

Set `ST_CHARACTER_WECHAT_LOCAL_TIME_ZONE` and `ST_CHARACTER_WECHAT_LOCAL_LOCATION` for local time, memory, reports, and optional daily weather / outfit reminders. To enable one reminder per local day, set `ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_ENABLED=true` and `ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_HOUR=8`; the app picks one random minute inside that hour each day. If the hour is missed, the reminder is added to the first normal reply that day.

Automatic daily / weekly report cards can be enabled from Local Settings in `00_START_HERE.html`. The default daily time is 23:30, and the default weekly time is Monday 23:30. If `/dailycard` has already been used that day, or `/weeklycard` has already been used for that week, the automatic send is skipped.

Proactive character chat is also configured from Local Settings. The default allowed window is 10:00 to 23:30. After each normal character reply, the app rolls the next proactive chat between 15 and 120 minutes later. A user message resets the plan. The pending limit is a positive number of proactive turns while waiting for the user; leaving it blank means no limit. This counts proactive turns, not WeChat bubbles.

If Claude Code is the local runtime, use:

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=claudecode
```

After installation, tell the user that any remote OpenAI-compatible API can be changed later from [00_START_HERE.html](../00_START_HERE.html) under Model / API, then saved back to the local `.env`.

For OpenAI, Gemini, DeepSeek, or another compatible service, use the same remote API fields:

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=api
ST_CHARACTER_WECHAT_API_BASE_URL=https://api.openai.com/v1
ST_CHARACTER_WECHAT_API_KEY=your_api_key
ST_CHARACTER_WECHAT_API_MODEL=selected_model_id
```

Use the provider's OpenAI-compatible base URL, key, and model id. Common base URL examples are OpenAI `https://api.openai.com/v1`, Gemini `https://generativelanguage.googleapis.com/v1beta/openai`, and DeepSeek `https://api.deepseek.com/v1`. The manual page can fetch `/models` after the key is filled.

6. Run `npm run cards:list` to confirm the fixed character-card folder can be scanned directly.
7. Run `npm run check`; it performs syntax checks and local installation self-tests.
8. Run `npm run login`. The QR code appears in the current terminal window. If the terminal QR code is hard to scan, open the printed link in a browser and scan it there. Continue after scanning and confirming login in WeChat.
9. Run `npm run accounts` to confirm a WeChat account was saved.
10. Start the bridge with `npm run start`. For the shared helper workflow, use `npm run shared:start`, `npm run shared:open`, and `npm run shared:status`.
11. Windows users can later double-click `01_START_WECHAT.bat` in the project root to start the bridge. To update to the latest GitHub version, double-click `04_UPDATE_AND_START_WECHAT.bat`; it tries to stop the running project process, then updates app files from `https://github.com/The-Veridis-Lion/ST_Character_Wechat.git`, runs `npm install`, runs `npm run check`, and starts the bridge. This works for git clones and GitHub ZIP folders; the first run from a ZIP folder connects the current folder to the GitHub update source. Updates do not clean `.env`, `character-cards/`, local memory, reports, state folders, or `node_modules/`. Windows may show Unknown Publisher the first time a downloaded bat is opened; after you click Run, the script unblocks launcher files in this folder. To enable startup on boot, double-click `02_ENABLE_STARTUP.bat`; after confirmation it creates `ST Character WeChat.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`, pointing to `01_START_WECHAT.bat`. To disable startup later, double-click `05_DISABLE_STARTUP.bat`; you can also manually delete `ST Character WeChat.lnk` from that Startup folder. If the project folder is moved, run `02_ENABLE_STARTUP.bat` again.
12. Send `/char reload`, `/char list`, `/char use 1`, and then a normal chat message from WeChat. Daily and weekly long reports can be tested with `/dailycard` and `/weeklycard`.

## What It Does

- Imports SillyTavern `.json` and `.png` cards from disk.
- Scans the project-local `character-cards/` folder directly with `npm run cards:list`.
- Ignores `*.override.json` inside `character-cards/`, so override config files are not loaded as cards.
- `00_START_HERE.html` can import local cards into `character-cards/` and save fully modified cards as `.modified.json` or `.modified.png`.
- Uses `/char reload`, `/char list`, `/char use`, `/char current`, and `/char reset` from WeChat.
- Keeps one active sender and one active character at a time. If `ST_CHARACTER_WECHAT_ALLOWED_USER_IDS` contains multiple IDs, only the first one is used.
- Keeps each character in an isolated Codex / Claude Code / remote API runtime thread.
- Optionally sends one local-time weather / outfit reminder per day through the active character.
- Prompts the user to choose a character when none is active; it does not fall back to old assistant chat.
- Sends model replies to WeChat after removing internal blocks, COT, and variable updates.
- Splits hard line breaks into separate WeChat bubbles.

## Character Rules

Character prompts use card definition fields such as `name`, `description`, `personality`, `scenario`, `system_prompt`, `post_history_instructions`, and safe non-MVU `character_book.entries`.

Character prompts intentionally do not use:

- `first_mes`
- `alternate_greetings`
- `mes_example`
- `creator_notes`
- `tags`
- `extensions`, including regex scripts
- MVU or variable execution

Time metadata is still preserved internally, including `receivedAt`, local time, and message metadata. The prompt may include a private `Current Time` section, but the `User Message` is the user's original text and does not receive a `[time]` prefix.

## Local Cards

Default card directory:

```text
./character-cards
```

Override it with:

```dotenv
ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR=./character-cards
```

Cards are imported from the local filesystem only. Do not upload private character cards through WeChat, and do not commit private cards to GitHub. When the manual is opened with `npm run manual`, its "Local Cards" page can scan this fixed folder directly and can write selected `.json` / `.png` cards into `character-cards/`.

The manual's card editor exports a complete modified card: `.json` inputs become `.modified.json`, and `.png` inputs become `.modified.png`. Manually disabled or hard-filtered worldbook entries are written back into the card entry state; normal entries that were already disabled in the source card can also be re-enabled in the page.

## WeChat Commands

- `/char reload`: rescan the local card directory.
- `/char list`: list imported cards.
- `/char use <name|number>`: choose the sender's active character.
- `/char current`: show the current active character and thread state.
- `/char reset`: reset the active character's isolated thread.
- `/compact`: compact the active character's current thread.
- `/stop`: stop the active character's current turn.
- `/model` and `/model <id>`: view or change model parameters for the active character binding.
- `/yes`, `/no`, `/always`: respond only to pending approvals on the active character thread.
- `/dailycard`: generate a daily summary long PNG for user state only.
- `/weeklycard`: generate a weekly review long PNG for user state only.
- `/reread`: disabled in character-only mode; the character prompt is rebuilt for each message.
- `/switch`: disabled in character-only mode; use `/char use <name|number>` instead.

Maintenance commands that operate on a thread require an active character first.

## Long Image Reports

Daily and weekly report commands ask the active runtime thread for structured JSON only. The app renders that JSON through fixed HTML templates under `templates/cards/`, screenshots the page with Playwright/headless browser, and sends the PNG through the existing WeChat file path.

When automatic report cards are enabled, the app stores sent dates or weekly periods in local `state/auto-report-cards.json`. The state is written only after the PNG is successfully sent to WeChat. Manual `/dailycard` and `/weeklycard` runs write the same state, so the automatic send will not duplicate them.

Reports summarize the user's state, topics, facts, quotes, sleep, stress, progress, and trends. They do not summarize character state and do not execute or render MVU/state variables from character cards.

## Local User Memory

After a character reply is delivered, the app writes a local user-memory record for that turn. It stores the user's message, the delivered reply, state signals such as mood, stress, sleep, progress, and energy, plus dated plans found in the user's text.

Future plans are written both to the source day and to their target day. For example, if the user says "next Wednesday at 3pm I need to do a checkup", the item is saved on that Wednesday and can be recalled when that date is near.

This memory is separate from runtime compacting. Compacting only reduces the active runtime thread context; local user memory remains on disk and is used for recall and report-card date ranges.

By default, recall reads recent 7-day state signals and planned items in the next 21 days, but older local memory is not deleted. You can optionally enable long-term semantic memory retrieval in `00_START_HERE.html` under "Model / API": embeddings build a local index, each chat embeds only the current message to retrieve a small candidate pool, and rerank, if enabled, only sorts those candidates. The final top K is a cap, not a fixed amount; weak matches, low rerank scores, and recently recalled old memories are filtered or down-ranked. Leaving it off is fine for normal use.

## Setup

This project is not an npm package. Clone it, install dependencies, configure `.env`, and run from the project directory:

```bash
git clone https://github.com/The-Veridis-Lion/ST_Character_Wechat.git ST_Character_Wechat
cd ST_Character_Wechat
npm install
```

Useful scripts:

```bash
npm run login
npm run accounts
npm run cards:list
npm run manual
npm run shared:start
npm run shared:open
npm run shared:status
npm run doctor
npm run check
```

`npm run check` checks JavaScript syntax and runs local unit tests. Browser screenshot rendering remains in the full developer test run with `npm test`.

The repository root includes four Windows helper scripts: `01_START_WECHAT.bat` starts normally, `02_ENABLE_STARTUP.bat` creates the startup shortcut, `04_UPDATE_AND_START_WECHAT.bat` updates app files from GitHub before starting, and `05_DISABLE_STARTUP.bat` removes that shortcut. The startup shortcut points to the normal start script and does not pull updates during Windows boot; run `04_UPDATE_AND_START_WECHAT.bat` manually when you want to update. It works for git clones and GitHub ZIP folders, and it does not clean `.env`, character cards, local memory, reports, state folders, or `node_modules/`. After the first run, these scripts unblock launcher files in this folder to reduce Windows Unknown Publisher prompts. Keep these scripts in the `ST_Character_Wechat` project root next to `package.json`.

## Configuration

Copy [`.env.example`](../.env.example) to `.env` and fill only what you need.

Common values:

```dotenv
ST_CHARACTER_WECHAT_ALLOWED_USER_IDS=your_wechat_user_id
ST_CHARACTER_WECHAT_WORKSPACE_ROOT=/absolute/path/to/ST_Character_Wechat
ST_CHARACTER_WECHAT_LOCAL_TIME_ZONE=Asia/Shanghai
ST_CHARACTER_WECHAT_LOCAL_LOCATION=
ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_ENABLED=false
ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_HOUR=8
ST_CHARACTER_WECHAT_RUNTIME=codex
ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR=./character-cards
ST_CHARACTER_WECHAT_CHARACTER_WORLDBOOK_OVERRIDES_FILE=

ST_CHARACTER_WECHAT_API_BASE_URL=
ST_CHARACTER_WECHAT_API_KEY=
ST_CHARACTER_WECHAT_API_MODEL=

ST_CHARACTER_WECHAT_USER_MEMORY_DIR=
ST_CHARACTER_WECHAT_USER_MEMORY_RECENT_DAYS=7
ST_CHARACTER_WECHAT_USER_MEMORY_UPCOMING_DAYS=21
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_ENABLED=false
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_BASE_URL=
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_API_KEY=
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_EMBEDDING_MODEL=
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_ENABLED=false
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_MODEL=
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_CANDIDATE_LIMIT=30
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_TOP_K=8
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_PASSIVE_MIN_SCORE=0.32
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_EXPLICIT_MIN_SCORE=0.12
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_RERANK_MIN_SCORE=0.05
ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_COOLDOWN_HOURS=24
ST_CHARACTER_WECHAT_REPORT_CARD_OUTPUT_DIR=
ST_CHARACTER_WECHAT_REPORT_CARD_WIDTH=720
ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_CHANNEL=msedge
ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_EXECUTABLE=
```

Do not commit `.env`, `node_modules`, local WeChat account state, runtime state, or private character cards.

Runtime choices:

- `codex`: local Codex runtime; usually no API key in this project.
- `claudecode`: local Claude Code runtime; requires the local `claude` command.
- `api`: remote OpenAI-compatible `/chat/completions` runtime for OpenAI, Gemini, DeepSeek, or another provider. Set `ST_CHARACTER_WECHAT_API_BASE_URL`, `ST_CHARACTER_WECHAT_API_KEY`, and `ST_CHARACTER_WECHAT_API_MODEL`, or use `00_START_HERE.html` to fetch and select the model.

Memory retrieval API settings are separate from the main chat API. `ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_*` is used for embeddings and optional rerank; common gateway providers usually use one base URL and key, then separate embedding and rerank models. The first enable or an embedding-model change rebuilds the local index; after that it only processes new memory and the current user message per turn. Explicit recall queries such as "previously / last time / remember" use a looser threshold, while ordinary chat uses a stricter passive-context threshold.

## More Docs

- [SillyTavern Character WeChat Mode](./character-wechat.md)
- [Manual Instruction Console](../00_START_HERE.html)
- [Long Image Report Cards](./report-card-placeholders.md)
- [OpenAI-Compatible API Runtime](./api-runtime.md)
- [Commands](./commands.md)

## Credit

Inspired by [WenXiaoWendy/cyberboss.git](https://github.com/WenXiaoWendy/cyberboss.git).
