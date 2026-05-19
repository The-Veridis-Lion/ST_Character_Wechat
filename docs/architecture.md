# Architecture

## Core

`core` is responsible for:

- reading config
- choosing which channel / runtime / integrations to use
- orchestrating capabilities instead of implementing concrete protocols

## Channel Adapters

`adapters/channel/*`

Responsible for:

- receiving messages
- sending messages
- typing / media / context token handling

Not responsible for:

- Codex / Claude Code thread logic
- reminder / timeline / diary logic

## Runtime Adapters

`adapters/runtime/*`

Responsible for:

- sending messages into the specific agent runtime
- handling thread / session / approval / stop

Not responsible for:

- WeChat protocol details
- timeline UI

Current runtimes:

- `codex`
- `claudecode`
- `api`
- `gemini`
- `deepseek`

`api`, `gemini`, and `deepseek` share the OpenAI-compatible `/chat/completions` adapter and store text-only local history in `${ST_CHARACTER_WECHAT_STATE_DIR}/api-threads.json`.

## Character Layer

`core/characters/*`

Responsible for:

- scanning local SillyTavern `.json` and `.png` cards
- parsing character definitions and character book / worldbook entries
- filtering MVU-like state entries
- building WeChat character-chat prompts
- enforcing one active WeChat sender and keeping each character separate from runtime thread ids

Not responsible for:

- executing MVU variables
- using `first_mes` or `alternate_greetings` as WeChat openers
- storing private card files in the repository

## Capability Integrations

`integrations/*`

Examples:

- `timeline`
- `reminder`
- `diary`
- `dailyDiaryCard`
- `weeklyReviewCard`
- `userMemory`

After each delivered character reply, `userMemory` writes a local sender + character + date record. These records keep user-state signals and dated future commitments outside the runtime thread, so recall and report cards are not dependent on compacted model context.

Daily diary and weekly review commands read local user-memory records for the target date range, ask the runtime for structured JSON only, sanitize that JSON, render `templates/cards/daily-diary.html` or `templates/cards/weekly-review.html`, screenshot the result with Playwright/headless browser, and send the PNG through WeChat `sendFile`.

## Local Setup Console

`00_START_HERE.html` is a root static local helper page. It combines:

- manual install steps
- copy-ready install prompts for Codex / Claude Code
- `.env` saving for local Codex, local Claude Code, Gemini, DeepSeek, and generic OpenAI-compatible APIs
- local character-card directory scanning
- the full character-card editor
- daily / weekly report template customization

It does not send data to a server. API keys and private card files remain in the user's browser and local filesystem.

These capabilities are bundled as local compatibility layers for GitHub release users, so a fresh clone does not need private or personal GitHub dependencies.

## Bundled Local Layers

- timeline:
  - local timeline compatibility command in `scripts/local-timeline.js`
- whereabouts:
  - local whereabouts service in `src/services/whereabouts-service.js`
- weixin bridge:
  - to be split into a standalone adapter
- codex runtime:
  - to be split into a standalone adapter
- API runtime:
  - uses OpenAI-compatible `/chat/completions` endpoints, including Gemini and DeepSeek
