<div align="center">

[中文](./README.md) · English

# ST Character WeChat
## SillyTavern character cards in WeChat

> Download locally, add character cards, scan WeChat login, and chat with your SillyTavern characters from WeChat.

[![Node >=22](https://img.shields.io/badge/Node-22%2B-3C873A)](./package.json)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-b31b1b)](./LICENSE)

</div>

> [!IMPORTANT]
> ## Give Me A Star!!
> If this project helps you, please give the GitHub repo a Star.  
> Stars support this project, and I appreciate them.

## What This Is

ST Character WeChat is a local WeChat bridge. It reads SillyTavern character cards from your computer and lets the selected character reply to WeChat messages.

In plain terms:

- Character cards stay on your computer.
- WeChat only sends and receives messages.
- Codex, Claude Code, or your own API generates replies.
- Each character keeps its own runtime thread, so switching cards is less likely to mix context.

## What It Can Do

### Chat With Local Character Cards

It supports common SillyTavern `JSON` and `PNG` character cards. Put cards into `character-cards/`, then use `/char list` and `/char use 1` in WeChat.

### Handle Common WeChat Messages

Text messages work directly. Voice messages are used as text when WeChat provides a transcript. Images, files, and video attachments are saved locally; local runtimes that can read images can use them in the character reply.

### Filter Card Content That Does Not Belong In Chat

MVU, variables, status bars, scripts, regex-like content, and similar internal card machinery are filtered so they do not leak into WeChat replies. The root `00_START_HERE.html` page also includes a character-card editor for checking and saving a complete modified card.

### Daily And Weekly Long Image Reports

Send `/dailycard` or `/weeklycard` in WeChat to generate daily or weekly PNG report cards. Templates are normal HTML/CSS and can be imported, edited, and selected in the local page.

You can also enable automatic daily / weekly report cards in Local Settings. The default daily time is 23:30, and the default weekly time is Monday 23:30. If the command was already used for that day or week, the automatic send is skipped.

### Local Memory And Reminders

After each delivered character reply, the app writes local user memory: the user message, the sent reply, mood, stress, sleep, progress, energy signals, and dated plans found in the user's text.

You can also enable a daily weather / outfit reminder. It runs once during the selected local hour; if that hour is missed, the next normal reply that day can include it naturally.

You can also enable proactive character chat. After each normal character reply, the app rolls the next proactive message inside your configured delay range. A user message resets the plan, and the maximum number of proactive turns while waiting for the user can be configured.

### Optional Long-Term Memory Search

This is optional. When enabled, embeddings and optional rerank can retrieve a few relevant older local memories. The app does not send the entire history to the model every turn.

## How To Start

For most users:

1. Download or clone this repository.
2. Open [00_START_HERE.html](./00_START_HERE.html) in the project root.
3. Follow either the manual setup tab or the agent install prompt tab.

If you want Codex or Claude Code to install it for you, download the project and give it one of these guides:

- [Chinese install guide](./docs/INSTALL.zh-CN.md)
- [English install guide](./docs/INSTALL.en.md)

Windows users will see these root files after setup:

```text
00_START_HERE.html             local setup manual and settings page
01_START_WECHAT.bat            normal start
02_ENABLE_STARTUP.bat          enable startup on boot
04_UPDATE_AND_START_WECHAT.bat update app files from GitHub and start
05_DISABLE_STARTUP.bat         disable startup on boot
```

Startup-on-boot uses the normal start script. It does not update during Windows boot. Run `04_UPDATE_AND_START_WECHAT.bat` manually when you want to update. It works from a git clone and from a GitHub ZIP folder; the first run connects the ZIP folder to the GitHub update source. Updates refresh app files and run `npm install`, but do not clean `.env`, character cards, local memory, reports, state folders, or `node_modules/`.

Windows may show `Unknown Publisher` the first time a downloaded bat is opened. After you click `Run`, the script unblocks launcher files in this folder, so the other bat files usually stop showing the same prompt.

## Common WeChat Commands

| Command | What It Does |
| --- | --- |
| `/char reload` | Rescan `character-cards/` |
| `/char list` | Show available cards |
| `/char use 1` | Switch to the first card |
| `/char current` | Show the current character |
| `/char reset` | Reset the current character's separate thread |
| `/dailycard` | Generate a daily long image report |
| `/weeklycard` | Generate a weekly long image report |

## Privacy

These should stay local and should not be uploaded to GitHub:

- `.env`
- API keys
- WeChat login state
- private character cards
- local memory
- daily / weekly PNG reports
- `node_modules/`

The repository already ignores these with `.gitignore`. By default, it only keeps `character-cards/.gitkeep`, not your cards.

## Who This Is For

This is for people who want to chat with SillyTavern character cards in WeChat while keeping cards and memory on their own computer. You do not need to be a programmer first; Codex or Claude Code can follow the install guide for you.

## Credit

Inspired by [WenXiaoWendy/cyberboss.git](https://github.com/WenXiaoWendy/cyberboss.git).
