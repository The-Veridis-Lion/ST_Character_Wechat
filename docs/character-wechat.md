# SillyTavern Character WeChat Mode

This project runs as a local WeChat bridge for SillyTavern character cards.

The user places `.json` or `.png` character cards in a local directory. The bridge scans that directory, parses safe character definition fields and non-MVU worldbook entries, then routes one WeChat sender to one active character at a time.

Runtime adapters such as Codex, Claude Code, Gemini, and OpenAI-compatible APIs are inference engines for character replies.

## Local Card Directory

Default:

```text
./character-cards
```

Override:

```dotenv
ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR=./character-cards
```

Cards are imported from the local filesystem. Do not upload cards through WeChat, and do not commit private cards.

## Supported Inputs

- SillyTavern JSON cards using `chara_card_v2` or `chara_card_v3`
- SillyTavern PNG cards with embedded `chara` metadata

Fields used for prompt construction:

- `name`
- `description`
- `personality`
- `scenario`
- `system_prompt`
- `post_history_instructions`
- safe `character_book.entries`

Fields intentionally not used:

- `first_mes`
- `alternate_greetings`
- `mes_example`
- `creator_notes`
- `tags`
- `extensions`, including regex scripts
- raw card metadata beyond the supported role/world fields

There is no `/char opening` command. Card greetings are not inserted into WeChat chat.

## Active Character And Threads

Character-only mode is designed for a single human user. If `ST_CHARACTER_WECHAT_ALLOWED_USER_IDS` contains multiple IDs, the bridge accepts only the first one and ignores messages from others. If no allowlist is configured, the first sender seen by the running process becomes the active sender.

The active sender has one active character at a time.

Runtime sessions are isolated by:

```text
wechat sender + active character id + workspace
```

Switching characters with `/char use` does not reuse the previous character's thread context. If no active character is selected, normal chat and thread maintenance commands ask the user to run `/char list` and `/char use`; they do not fall back to old assistant behavior.

## Prompt Inputs

The character prompt combines:

- private WeChat chat rules
- `Current Time` as internal context
- current character definition
- relationship/world setting from the card
- constant non-MVU worldbook entries
- keyword-matched non-MVU worldbook entries
- the current user message

The `User Message` section uses the user's original input. It does not prepend `[time]` to the text. Time metadata such as `receivedAt`, local time, and message metadata remains preserved internally for future timeline, diary, weekly, and statistics features.

For character chat attachments, the prompt receives a conservative text note that attachments exist. It does not inject coding assistant instructions such as "read these files", `Read`, or `view_image`.

## MVU Handling

ST Character WeChat does not implement MVU.

It does not execute variables, maintain character state, or treat card state blocks as a runtime state system. MVU-like content is filtered or downgraded before it reaches the character prompt.

Examples of filtered content:

- `[InitVar]`
- `UpdateVariable`
- `getvar`
- `setvar`
- `stat_data`
- `status_current_variables`
- `StatusPlaceHolderImpl`
- `变量更新`
- `更新变量`
- `状态变量`
- `内部状态`
- obvious Chinese variable/status update blocks

Worldbook entries that look like MVU/state machinery are not selected for character chat.

Manual review is supported by [00_START_HERE.html](../00_START_HERE.html) in the `角色卡修改` tab. The editor saves a complete modified card: `.json` inputs become `.modified.json`, and `.png` inputs become `.modified.png`. Manually closed or hard-filtered worldbook entries are written back into the card entry state, and normal entries that were already disabled in the source card can be re-enabled in the page.

## Output Cleaning

Before sending text to WeChat, the bridge removes internal content first, then splits clean user-facing text into bubbles.

Cleaned content includes:

- `<think>...</think>`
- `<analysis>...</analysis>`
- `<message>...</message>`
- `<UpdateVariable>...</UpdateVariable>`
- Chinese internal blocks such as `<变量更新>...</变量更新>`, `<状态>...</状态>`, `<思维链>...</思维链>`
- unknown closed XML/HTML-like blocks, including Unicode tag names
- leftover self-closing, closing, or dangling tags
- COT / reasoning label blocks

If cleaning leaves no visible text, nothing is sent to WeChat.

## WeChat Bubble Delivery

Hard line breaks are respected as message boundaries after cleaning. Empty lines are ignored. The bridge sends one line as one WeChat bubble and does not pack multi-line text into a single bubble.

## Commands

Character commands:

```text
/char reload
/char list
/char use 1
/char use Ciel
/char current
/char reset
```

Thread maintenance commands are scoped to the current active character:

- `/new`: same as `/char reset`
- `/compact`: compact the active character thread
- `/stop`: stop the active character turn
- `/model`: view or update the active character binding's model parameters
- `/yes`, `/no`, `/always`: respond to approvals on the active character thread only
- `/dailycard`, `/diarycard`: generate a daily status diary long PNG for user state only
- `/weeklycard`: generate a weekly review long PNG for user state only

Disabled in character-only mode:

- `/switch`: use `/char use <role>` instead
- `/reread`: the character prompt is rebuilt from the current card for every message

## System Messages

Character-only mode prevents legacy reminder, checkin, location, and other system-trigger messages from entering old base threads or contaminating character chat. Reminder queues are drained without being sent, checkin is disabled, and location triggers are ignored instead of being routed through the legacy productivity system prompt.

The optional daily weather / outfit reminder is separate from the legacy reminder queue. When enabled, it chooses one random minute inside the configured local hour each day, requires an active character and a known WeChat context token, and routes through the active character thread. If the configured hour is missed, the reminder is folded into the first normal character reply later that same local day.

## Deferred Reports

Daily diary cards and weekly review cards are implemented as long PNG reports. The runtime returns structured JSON only; application code sanitizes the JSON, renders a fixed HTML template, screenshots it with Playwright/headless browser, and sends the PNG through WeChat `sendFile`.

Reports summarize user state only. They do not summarize character state, relationship state, card variables, status bars, or MVU state.

## Local User Memory and Recall

Character chat uses a local memory layer that is separate from the runtime thread.

After a character reply has been delivered to WeChat, the app writes a local turn record for the active sender and active character. The record includes:

- the user's original message
- the delivered character reply
- state signals such as mood, stress, sleep, progress, and energy
- dated plans or future commitments found in the user's message

Future commitments are stored on both the source day and the target day. For example, if the user says "下周三下午3点要体检", the item is saved to that next Wednesday's day record, so later chat and report generation can recall it by date.

Recall is scoped by sender and character for chat prompts, so separate character threads do not pull each other's local memories. Report cards read local memory by date range and user-state fields rather than relying only on whatever the runtime thread still remembers.

By default, chat recall reads a small text window: recent state signals and upcoming dated plans. Older local memory remains on disk. If `ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_ENABLED=true`, the app also builds a local semantic index with the configured embedding model and can retrieve longer-term related memories outside that text window. Optional rerank only sorts the embedding candidate pool; it does not scan the entire history on every turn. Semantic top K is a cap, not a fixed fill amount: low-score candidates are omitted, explicit recall queries use a looser threshold, and recently recalled memories are down-ranked.

Runtime compacting is different: `/compact` and auto compact only compress the active runtime thread context. They do not delete local user memory.
