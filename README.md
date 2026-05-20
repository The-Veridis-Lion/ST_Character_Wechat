<div align="center">

中文 · [English](./README.en.md)

# ST Character WeChat
## 把 SillyTavern 角色卡接进微信聊天

> 下载到本地，放入角色卡，扫码登录微信，然后就可以在微信里和你的 SillyTavern 角色聊天。

[![Node >=22](https://img.shields.io/badge/Node-22%2B-3C873A)](./package.json)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-b31b1b)](./LICENSE)

</div>

> [!IMPORTANT]
> ## 给我点星！！
> 如果这个项目帮到你，请在 GitHub 右上角点一个 Star。  
> Star 就是给这个项目点星支持，我会很开心。

## 这是什么

ST Character WeChat 是一个本地微信聊天桥。它会读取你电脑里的 SillyTavern 角色卡，然后把微信消息交给角色回复。

你可以把它理解成：

- 角色卡放在本地电脑，不上传到云端。
- 微信只负责收发消息。
- 本地 Codex、本地 Claude Code，或你自己的远程 API 负责生成角色回复。
- 每张角色卡都有自己的聊天线程，切换角色时不容易串上下文。
- 用户未来计划会在角色之间共享，方便无缝切换角色继续照顾同一份日程。

## 你可以用它做什么

### 选择本地或远程模型

可以用本机 Codex、本机 Claude Code，也可以接 OpenAI、Gemini、DeepSeek 或其他兼容 OpenAI Chat Completions 的远程 API。根目录的 `00_START_HERE.html` 可以直接填写 API 地址和密钥、获取模型列表，并把配置保存到本地 `.env`。

远程 API 会优先使用流式返回；项目会按自然句子边界发送完整微信气泡，并根据气泡长度模拟发送间隔，所以即使上游一次性返回，也不会把半句话一截一截刷出来。API 历史也可以按天数压缩成摘要，保留近期原文，把更早的内容变成周/月摘要。

### 和本地角色卡微信聊天

支持 SillyTavern 常见的 `JSON` 和 `PNG` 角色卡。把角色卡放进 `character-cards/`，在微信里发送 `/char list` 和 `/char use 1` 就能选角色。

每个角色都有独立上下文。切换角色会切到对应角色自己的线程；用户未来计划会跨角色召回，但最近聊天状态和角色记忆仍按角色隔离。

### 兼容常见微信消息

普通文字消息可以直接聊天。直接发语音条时，项目会读取微信侧提供的语音文本并交给角色理解。图片、文件、视频附件会保存到本地；支持图片读取的本地运行方式可以把图片内容交给角色理解。

如果你连续发几条消息，项目可以先短暂等待，把等待窗口内的新消息合并成一轮再交给 AI；“正在输入中”也可以设置成收到消息后随机延迟出现，让微信里的节奏更自然。

### 自动过滤不适合微信聊天的内容

角色卡里的 MVU、变量、状态栏、脚本、正则等内容会被过滤，避免角色把内部状态或脚本规则发到微信。根目录的 `00_START_HERE.html` 里还有“角色卡修改”，可以手动检查和保存修改后的完整角色卡。

### 每日和每周长图报告

在微信里发送 `/dailycard` 或 `/weeklycard`，项目会生成日报/周报 PNG 长图。模板是普通 HTML/CSS，可以在网页里导入、编辑和选择。

也可以在“本地设置”里开启自动日记/周记，默认日记时间是 23:30，周记默认周一 23:30。当天或本周已经用指令生成过，就不会再自动重复发送。

### 本地记忆和提醒

每轮角色回复后，项目会把用户消息、角色回复、心情/压力/睡眠/进度等状态信号写入本地记忆。它也会识别带日期的事项，用于之后聊天召回和日报/周报。

最近状态和聊天记忆按角色隔离，避免角色之间串味；未来计划和日程会按用户共享，所以你在一个角色那里说过的体检、DDL、会议，切到另一个角色时也能被自然照顾到。

你还可以开启每日天气/穿衣提醒：每天在你选择的小时里随机提醒一次；如果错过这个时间，会在当天第一次回复你时自然带上提醒。

也可以开启角色主动聊天：每次角色正常回复后，会在你设置的等待范围里随机安排下一次主动消息；你主动发消息会重置计划，未回复时最多主动几轮可以自己填写。

### 上下文管理

可以在微信里用 `/status` 查看当前角色线程、模型和上下文状态，用 `/compact` 压缩当前角色线程，也可以开启自动压缩。压缩只影响运行时线程，不会删除本地角色卡、本地记忆、日报周报或用户计划。

### 可选长期记忆检索

不开也能正常聊天。开启后，项目可以用 embedding 和可选 rerank 从更久以前的本地记忆里找少量相关内容，不会每次把全部历史都发给模型。

## 怎么开始

如果你是普通用户，推荐这样做：

1. 下载或 clone 这个仓库。
2. 打开根目录的 [00_START_HERE.html](./00_START_HERE.html)。
3. 按页面里的“手动安装”或“自动安装 Prompt”走。

如果你想让 Codex 或 Claude Code 自动帮你安装，把这个项目下载下来后，把安装指引交给它：

- [中文安装指引](./docs/INSTALL.zh-CN.md)
- [English install guide](./docs/INSTALL.en.md)

Windows 用户安装完成后，根目录有这些入口：

```text
00_START_HERE.html             本地安装手册和设置页面
01_START_WECHAT.bat            普通启动
02_ENABLE_STARTUP.bat          开机自启动
04_UPDATE_AND_START_WECHAT.bat 从 GitHub 更新程序并启动
05_DISABLE_STARTUP.bat         关闭开机自启动
```

开机自启动只会普通启动，不会开机自动更新。需要更新时，手动运行 `04_UPDATE_AND_START_WECHAT.bat`。它适用于 git clone 目录，也适用于 GitHub ZIP 解压目录；第一次运行会把 ZIP 目录接到 GitHub 更新源。更新会刷新程序文件并运行 `npm install`，不会清理 `.env`、角色卡、本地记忆、报告、状态目录或 `node_modules/`。

Windows 第一次双击从网页下载的 bat 时，可能会提示 `Unknown Publisher`。点击 `Run` 后，脚本会自动解除本目录启动文件的下载标记，后面再打开其他 bat 通常就不会继续弹。

## 微信里常用的命令

| 命令 | 作用 |
| --- | --- |
| `/char reload` | 重新扫描 `character-cards/` |
| `/char list` | 查看可用角色卡 |
| `/char use 1` | 切换到第 1 张角色卡 |
| `/char current` | 查看当前角色 |
| `/char reset` | 重置当前角色的独立聊天线程 |
| `/status` | 查看当前角色线程、模型和上下文状态 |
| `/compact` | 压缩当前角色线程上下文 |
| `/compact auto` | 查看或修改自动压缩设置 |
| `/model` | 查看或切换当前角色线程使用的模型 |
| `/stop` | 停止当前正在运行的一轮回复 |
| `/dailycard` | 生成日报长图 |
| `/weeklycard` | 生成周报长图 |

## 隐私说明

这些内容只应该留在本地，不要上传到 GitHub：

- `.env`
- API key
- 微信登录状态
- 私有角色卡
- 本地记忆
- 日报/周报 PNG
- `node_modules/`

仓库已经用 `.gitignore` 忽略这些内容。默认只保留 `character-cards/.gitkeep`，不会提交你的角色卡。

## 适合谁

适合想把 SillyTavern 角色卡放到微信里聊、又希望角色卡和聊天记忆保存在自己电脑上的人。你不需要先懂代码；让 Codex 或 Claude Code 按安装指引处理即可。

## Credit

本项目灵感来自 [WenXiaoWendy/cyberboss.git](https://github.com/WenXiaoWendy/cyberboss.git)。
