# Long Image Report Cards

ST Character WeChat supports two report-card commands:

```text
/dailycard
/diarycard
/weeklycard
```

These commands generate long PNG images only. They do not send a short text summary version.

## Flow

1. The command reads local user-memory records for the target date range and includes them in the report prompt.
2. The runtime is prompted to output one structured JSON object only.
3. Application code sanitizes the JSON so character-state, state-variable, and status-bar content is removed.
4. The JSON is rendered into a fixed HTML template:
   - `templates/cards/daily-diary.html`
   - `templates/cards/weekly-review.html`
5. `CardRenderService` opens the HTML with Playwright/headless browser and exports a full-page PNG.
6. The WeChat adapter sends the PNG through `sendFile`.

## Boundaries

Reports summarize user state only: mood, stress, sleep, progress, topics, facts, representative user wording, supplemental notes, and time or energy trends.

Reports must not summarize character state, relationship state, card variables, status bars, or MVU content. Character cards are still imported from the local card directory only; private cards should not be uploaded through WeChat or committed to GitHub.

## Configuration

```dotenv
ST_CHARACTER_WECHAT_REPORT_CARD_OUTPUT_DIR=
ST_CHARACTER_WECHAT_REPORT_CARD_TEMPLATE_DIR=
ST_CHARACTER_WECHAT_REPORT_CARD_WIDTH=720
ST_CHARACTER_WECHAT_REPORT_CARD_DEVICE_SCALE_FACTOR=2
ST_CHARACTER_WECHAT_REPORT_TIME_ZONE=Asia/Shanghai
ST_CHARACTER_WECHAT_USER_MEMORY_DIR=
ST_CHARACTER_WECHAT_USER_MEMORY_TIME_ZONE=Asia/Shanghai
ST_CHARACTER_WECHAT_USER_MEMORY_RECENT_DAYS=7
ST_CHARACTER_WECHAT_USER_MEMORY_UPCOMING_DAYS=21
ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_CHANNEL=msedge
ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_EXECUTABLE=
```

Use `ST_CHARACTER_WECHAT_PLAYWRIGHT_BROWSER_EXECUTABLE` when Chrome or Edge is installed in a non-standard location.
