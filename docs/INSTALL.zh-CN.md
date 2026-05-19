<div align="center">

安装指引：中文 · [English](./INSTALL.en.md) · [返回主页](../README.md)

# ST Character WeChat 安装指引
## 让 Codex / Claude Code 帮你装，或按步骤手动装

> 如果你不想看命令，先打开根目录的 [00_START_HERE.html](../00_START_HERE.html)。它会把设置、安装提示、角色卡目录和模板编辑放在同一个页面里。

[![Node >=22](https://img.shields.io/badge/Node-22%2B-3C873A)](../package.json)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-b31b1b)](../LICENSE)

</div>

这页是安装用的长说明。普通使用者只需要知道三件事：先装 Node.js 22+，把角色卡放进 `character-cards/`，然后扫码登录微信。下面的 Prompt 是给 Codex / Claude Code 看的，它们可以照着自动完成大部分步骤。

## 让 Codex / Claude Code 自主安装

如果你想让 AI coding agent 直接帮你下载并安装，把下面这段发给 Codex 或 Claude Code：

```text
请把这个 GitHub 仓库下载到本地并安装：
https://github.com/The-Veridis-Lion/ST_Character_Wechat.git

请按 README 里的 Codex / Claude Code 自主安装说明执行。
优先使用本地 runtime：如果你是 Codex，就用 ST_CHARACTER_WECHAT_RUNTIME=codex；如果你是 Claude Code，就用 ST_CHARACTER_WECHAT_RUNTIME=claudecode。
只创建本地未跟踪的安装文件，例如 .env 和 ~/.st-character-wechat/*。
不要提交或上传 .env、API key、微信登录状态、私有 SillyTavern 角色卡、本地记忆、报告 PNG、node_modules、生成压缩包或用户自己额外创建的外层启动器。
请安装依赖、直接创建本地 .env、使用项目根目录的 character-cards 文件夹放角色卡、运行检查、启动微信登录；二维码会显示在运行命令的终端窗口里，只有在需要扫码或提供远程 API key 时暂停。安装完成后请输出：安装已完成。Windows 用户以后可以双击项目根目录的 01_START_WECHAT.bat 启动；需要从 GitHub 更新程序并启动时，运行 04_UPDATE_AND_START_WECHAT.bat。它适用于 git clone 和 GitHub ZIP 解压目录；第一次在 ZIP 目录运行会自动接到 GitHub 更新源。更新会刷新程序文件并运行 npm install，不会清理 .env、character-cards、本地记忆、报告、状态目录或 node_modules。如果用户明确需要开机自启动，再运行 02_ENABLE_STARTUP.bat，它会在 Windows Startup 文件夹创建普通启动快捷方式。关闭开机自启动时，运行 05_DISABLE_STARTUP.bat。之后要改运行模型或远程 API，可以打开 00_START_HERE.html 的“模型 / API”保存新的 .env。
```

自主安装执行步骤：

1. 如果当前目录还不是这个仓库，先把仓库 clone 到 `ST_Character_Wechat`，或使用 GitHub 下载后的 ZIP 解压目录，然后进入项目根目录。
2. 检查 Node.js 是否可用，并确认 `node --version` 是 `22` 或更高。不是的话，先完成 Node.js 22+ 安装指导。
3. 运行 `npm install`。
4. 使用项目根目录下的 `character-cards/` 放角色卡。目录不存在就创建，然后把 SillyTavern JSON / PNG 角色卡放进去。运行 `npm run cards:list` 直接扫描这个固定目录并列出已有角色卡；不要再询问角色卡路径。
5. 从 [`.env.example`](../.env.example) 创建 `.env`，直接写入本地默认配置，不要要求先打开网页填写。最少填写：

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

如果暂时不知道自己的微信 sender id，第一次本地测试可以先让 `ST_CHARACTER_WECHAT_ALLOWED_USER_IDS` 留空。Character-only 模式会锁定运行进程看到的第一个 sender。后续稳定使用时，再把它改成这个 sender id。

填写 `ST_CHARACTER_WECHAT_LOCAL_TIME_ZONE` 和 `ST_CHARACTER_WECHAT_LOCAL_LOCATION` 后，本地记忆、日报/周报和可选每日天气/穿衣提醒都会使用这个当地时间与位置。需要每天最多提醒一次时，设置 `ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_ENABLED=true` 和 `ST_CHARACTER_WECHAT_DAILY_WEATHER_REMINDER_HOUR=8`；项目每天会在这个小时里随机选一个分钟。如果错过这个小时，会在当天第一次正常回复里带上提醒。

自动日记/周记可以在 `00_START_HERE.html` 的“本地设置”里开启。默认日记时间是 23:30，默认周记是周一 23:30；如果使用者当天已经发送 `/dailycard`，或者本周已经发送 `/weeklycard`，自动发送会跳过，避免重复发长图。

如果本地 runtime 是 Claude Code，使用：

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=claudecode
```

安装完成后，提示使用者：以后如果要换运行模型或任何远程 OpenAI-compatible API，可以打开 [00_START_HERE.html](../00_START_HERE.html) 的“模型 / API”，保存到本地 `.env`。

如果选择 OpenAI、Gemini、DeepSeek 或其他兼容服务，统一使用同一组远程 API 字段：

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=api
ST_CHARACTER_WECHAT_API_BASE_URL=https://api.openai.com/v1
ST_CHARACTER_WECHAT_API_KEY=你的_API_key
ST_CHARACTER_WECHAT_API_MODEL=选择的模型_id
```

填写服务商的 OpenAI-compatible API 地址、key 和模型 id 即可。常见 API 地址示例：OpenAI `https://api.openai.com/v1`、Gemini `https://generativelanguage.googleapis.com/v1beta/openai`、DeepSeek `https://api.deepseek.com/v1`。手册页面可以在填写 key 后从 `/models` 获取模型列表。

6. 运行 `npm run cards:list`，确认固定角色卡目录能直接扫描。
7. 运行 `npm run check`，它会做语法检查和本地安装自检。
8. 运行 `npm run login`。二维码会显示在当前终端窗口里；如果终端二维码显示不完整，就打开终端里打印的链接再扫码。扫码并在微信里确认登录后继续。
9. 运行 `npm run accounts`，确认微信账号已经保存。
10. 用 `npm run start` 启动桥。需要 shared helper 工作流时，用 `npm run shared:start`、`npm run shared:open`、`npm run shared:status`。
11. Windows 用户后续可以双击项目根目录的 `01_START_WECHAT.bat` 一键启动；想更新到 GitHub 最新版本时，双击 `04_UPDATE_AND_START_WECHAT.bat`。它会先尝试停掉正在运行的本项目进程，再从 `https://github.com/The-Veridis-Lion/ST_Character_Wechat.git` 更新程序文件、运行 `npm install`、`npm run check` 并启动。这个脚本适用于 git clone 和 GitHub ZIP 解压目录；第一次在 ZIP 目录运行会自动把当前文件夹接到 GitHub 更新源。更新不会清理 `.env`、`character-cards/`、本地记忆、报告、状态目录或 `node_modules/`。Windows 第一次打开下载来的 bat 时可能提示 Unknown Publisher，点 Run 后，脚本会自动解除本目录启动文件的下载标记。需要开机自启动时，双击 `02_ENABLE_STARTUP.bat`，确认后它会在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 创建指向 `01_START_WECHAT.bat` 的 `ST Character WeChat.lnk`。关闭开机自启动时，双击 `05_DISABLE_STARTUP.bat`；也可以手动删除这个 Startup 文件夹里的 `ST Character WeChat.lnk`。移动项目文件夹后请重新运行 `02_ENABLE_STARTUP.bat`。
12. 在微信里发送 `/char reload`、`/char list`、`/char use 1`，然后发送普通聊天消息测试。每日/每周长图报告可以用 `/dailycard` 和 `/weeklycard` 测试。

## 功能边界

- 从本地目录导入 SillyTavern `.json` / `.png` 角色卡。
- 用 `npm run cards:list` 直接扫描项目根目录的 `character-cards/`。
- `character-cards/` 会忽略 `*.override.json`，避免把覆盖配置误当成角色卡。
- `00_START_HERE.html` 可以把本机角色卡导入 `character-cards/`，也可以把修改后的完整角色卡保存为 `.modified.json` 或 `.modified.png`。
- 在微信里使用 `/char reload`、`/char list`、`/char use`、`/char current`、`/char reset`。
- 只接受一个微信 sender，一次只有一个 active character。如果 `ST_CHARACTER_WECHAT_ALLOWED_USER_IDS` 配了多个 ID，只使用第一个。
- 每个角色使用独立的 Codex / Claude Code / 远程 API runtime thread。
- 可以选择按当地时间每天最多发送一次天气/穿衣提醒，由当前 active character 发出。
- 没有 active character 时只提示 `/char list` / `/char use`，不回退到旧助手聊天。
- 发送到微信前会移除内部块、COT、变量更新。
- 模型回复里的硬换行会拆成多个微信气泡。

## 角色规则

角色 prompt 使用 `name`、`description`、`personality`、`scenario`、`system_prompt`、`post_history_instructions` 和安全的非 MVU `character_book.entries`。

角色 prompt 不使用：

- `first_mes`
- `alternate_greetings`
- `mes_example`
- `creator_notes`
- `tags`
- `extensions`，包括 regex scripts
- MVU 或变量执行

时间字段仍完整保存在内部数据中，包括 `receivedAt`、local time 和 message metadata。Prompt 可以保留私有的 `Current Time` section，但 `User Message` 使用用户原始输入，不会拼 `[时间]` 前缀。

## 本地角色卡

默认目录：

```text
./character-cards
```

可通过环境变量覆盖：

```dotenv
ST_CHARACTER_WECHAT_CHARACTER_CARD_DIR=./character-cards
```

角色卡只从本地文件系统导入。不要通过微信上传私有角色卡，也不要把私有角色卡提交到 GitHub。运行 `npm run manual` 打开本地手册时，手册里的“角色卡目录”页可以直接扫描这个固定目录，并可把你选择的 `.json` / `.png` 写入 `character-cards/`。

手册里的“角色卡修改”会导出完整改后角色卡：原文件是 `.json` 就保存为 `.modified.json`，原文件是 `.png` 就保存为 `.modified.png`。被手动关闭或硬过滤的世界书条目会写回角色卡条目状态；原卡里已关闭的普通条目也可以在页面中重新打开。

## 微信命令

- `/char reload`：重新扫描本地角色卡目录。
- `/char list`：列出已导入角色。
- `/char use <角色名或编号>`：切换当前 sender 的 active character。
- `/char current`：查看当前角色和线程状态。
- `/char reset`：重置当前角色的独立线程。
- `/compact`：压缩当前 active character 的线程。
- `/stop`：停止当前 active character 正在运行的 turn。
- `/model` 和 `/model <id>`：查看或切换当前角色 binding 的模型参数。
- `/yes`、`/no`、`/always`：只响应当前角色线程上的 pending approval。
- `/dailycard`：生成只总结用户状态的每日小结长图 PNG。
- `/weeklycard`：生成只总结用户状态的每周回顾长图 PNG。
- `/reread`：character-only 模式下禁用；角色 prompt 会在每条消息按当前角色卡重新构建。
- `/switch`：character-only 模式下禁用；请用 `/char use <角色>` 切换角色。

所有线程维护命令都要求先选择 active character。

## 长图报告

每日和每周报告命令只要求当前 runtime thread 输出结构化 JSON。程序会把 JSON 填入 `templates/cards/` 下的固定 HTML 模板，用 Playwright/headless browser 截成长图 PNG，再通过现有微信文件发送链路发回聊天。

如果开启自动日记/周记，程序会在本地 `state/auto-report-cards.json` 记录已发送的日期或周记周期。记录只在图片成功发到微信后写入；手动使用 `/dailycard` 或 `/weeklycard` 也会写入这层状态，所以同一天或同一周不会再自动补发。

报告只整理用户自己的状态、话题、关键信息、代表性语句、睡眠、压力、进度、收获和趋势；不总结角色状态，也不执行或渲染角色卡里的 MVU/状态变量。

## 本地用户记忆

每次角色回复已经发到微信后，程序会为这一轮写入本地用户记忆。记录包括用户原文、已发送的角色回复、心情、压力、睡眠、进度、能量等状态信号，以及从用户文本里识别出的带日期事项。

未来事项会同时写入“说出这件事的当天”和“目标日期”。例如用户说“下周三下午3点要体检”，这条事项会保存到下周三当天，日期接近时可被下一轮角色回复 recall。

这层记忆和 runtime compact 是分开的。Compact 只压缩当前 runtime 线程上下文；本地用户记忆仍保存在磁盘上，用于聊天 recall 和日报/周报按日期读取。

默认召回会读取最近 7 天状态信号和未来 21 天计划事项，但不会删除更早的本地记忆。你也可以在 `00_START_HERE.html` 的“模型 / API”里开启可选的长期记忆语义检索：embedding 会把本地记忆建成本地索引，聊天前只用当前消息检索少量候选；rerank 如果开启，也只排序这些候选，不会每轮把全部历史重新跑一遍。最终 top K 是上限，不是固定塞满；弱相关、低 rerank 分数或最近刚召回过的旧记忆会被过滤或降权。不开这项也可以正常使用。

## 安装与运行

本项目不是 npm package。请拉源码、安装依赖、配置 `.env` 后在项目目录运行：

```bash
git clone https://github.com/The-Veridis-Lion/ST_Character_Wechat.git ST_Character_Wechat
cd ST_Character_Wechat
npm install
```

常用脚本：

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

`npm run check` 会检查所有 JavaScript 语法，并运行本地单元测试；浏览器截图渲染测试留给开发者用 `npm test` 全量执行。

仓库根目录提供四个 Windows 便利脚本：`01_START_WECHAT.bat` 用来普通启动，`02_ENABLE_STARTUP.bat` 用来创建开机自启动快捷方式，`04_UPDATE_AND_START_WECHAT.bat` 用来从 GitHub 更新程序文件后启动，`05_DISABLE_STARTUP.bat` 用来删除这个快捷方式并关闭开机自启动。自启动快捷方式指向普通启动脚本，不会在开机时自动拉取更新；需要更新时手动运行 `04_UPDATE_AND_START_WECHAT.bat`。它适用于 git clone 和 GitHub ZIP 解压目录，更新时不会清理 `.env`、角色卡、本地记忆、报告、状态目录或 `node_modules/`。这些脚本第一次运行后会解除本目录启动文件的 Windows 下载标记，减少 Unknown Publisher 弹窗。脚本需要放在 `ST_Character_Wechat` 项目根目录，和 `package.json` 同一层。

## 配置

复制 [`.env.example`](../.env.example) 为 `.env`，只填写你需要的项。

常用变量：

```dotenv
ST_CHARACTER_WECHAT_ALLOWED_USER_IDS=你的微信 user id
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

不要提交 `.env`、`node_modules`、本地微信账号状态、runtime 状态或私有角色卡。

Runtime 选择：

- `codex`：本地 Codex runtime；通常不需要在本项目里填 API key。
- `claudecode`：本地 Claude Code runtime；要求本机已有 `claude` 命令。
- `api`：远程 OpenAI-compatible `/chat/completions` runtime，适用于 OpenAI、Gemini、DeepSeek 或其他服务商。填写 `ST_CHARACTER_WECHAT_API_BASE_URL`、`ST_CHARACTER_WECHAT_API_KEY`、`ST_CHARACTER_WECHAT_API_MODEL`，也可以用 `00_START_HERE.html` 获取并选择模型。

记忆检索 API 和主聊天 API 是两组配置。`ST_CHARACTER_WECHAT_MEMORY_RETRIEVAL_*` 用于 embedding 和可选 rerank，常见中转服务通常也是一个 base URL + key，然后分别选择 embedding 模型和 rerank 模型。首次开启或更换 embedding 模型时会重建本地索引；之后只处理新增记忆和每轮当前消息。用户明确问“之前 / 上次 / 还记得吗”时会使用较宽松的显式回忆阈值；普通聊天使用更严格的被动上下文阈值。

## 更多文档

- [SillyTavern 角色卡微信模式](./character-wechat.md)
- [Manual Instruction Console](../00_START_HERE.html)
- [Long Image Report Cards](./report-card-placeholders.md)
- [OpenAI-Compatible API Runtime](./api-runtime.md)
- [Commands](./commands.md)

## Credit

本项目灵感来自 [WenXiaoWendy/cyberboss.git](https://github.com/WenXiaoWendy/cyberboss.git)。
