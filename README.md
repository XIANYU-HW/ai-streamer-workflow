<div align="center">

<img src="docs/assets/hero.jpg" alt="霓裳 Nichang — AI 娘直播天团，一站式AI团队全自动直播" width="100%">

# 霓裳 · Nichang

**AI Streamer Workflow**

**一站式AI团队全自动直播**

让 AI 拥有自己的身份故事，带着独立记忆，与不同搭档一起登场。

[![Verify source](https://github.com/XIANYU-HW/ai-streamer-workflow/actions/workflows/verify.yml/badge.svg)](https://github.com/XIANYU-HW/ai-streamer-workflow/actions/workflows/verify.yml)
[![MIT](https://img.shields.io/badge/license-MIT-79DFC1?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522.12-ABC4FF?style=flat-square)](https://nodejs.org/en/download)
[![Preview](https://img.shields.io/badge/v0.1.0-developer_preview-FFB593?style=flat-square)](docs/roadmap.md)

**简体中文** · [English](docs/README.en.md)

[快速开始](#快速开始) · [真实直播](#真实直播展示) · [角色与记忆](#让主播拥有故事记忆与搭档) · [工作室](#工作室预览) · [接入指南](packages/runtime/INTEGRATION.md) · [参与贡献](docs/contributing.md)

</div>

<sub>封面为 GPT、DeepSeek、Claude、Gemini、Grok、Kimi 的 AI 娘化概念合绘；角色不随源码预装。参见[视觉说明](docs/showcase.md)。</sub>

> **v0.1.0 · 首个公开预览版 · 持续更新**
> 已提供角色工作室、独立记忆档案、七岗位模板与直播协作核心。当前仍有已知问题，真实模型、声音、游戏与平台需要接入；整场无人指引直播仍是持续完善的目标。[已知限制](docs/known-limitations.md) · [路线图](docs/roadmap.md)

## 让主播拥有故事、记忆与搭档

你搭建的不只是会说话的 AI，而是一支有各自经历、性格和默契的直播团队。

| 🎭 自定义 AI 身份故事 | 📖 每个角色的长期记忆 | ✨ 自由组合直播阵容 |
| :--- | :--- | :--- |
| 自定义姓名、背景故事、性格、称呼、形象与声线，创造属于你的主播 | 角色拥有独立记忆档案，保存确认过的场次经历；下一场可以继续使用，换搭档也保留自己的记忆 | 同一角色可参加不同场景、与不同搭档组合；工作室支持每场最多四人编排 |

**从人设到长期陪伴。** 角色、场景、场次与记忆可以在本机保存、导出和恢复。下一场从该角色已确认的历史出发；搭档的私有背景和记忆不会自动混入自己的上下文。

*当前记忆流程：记录场次事件 → 为亲历角色整理记忆草稿 → 确认保存 → 后续场次带入上下文。真实直播事件的自动采集、记忆提炼及模型回复仍需接入。默认直播协作模板采用双主播；四人编排是工作室的场景能力。*

## 真实直播展示

**GPT 学姐 × 大肥鱼学妹，挑战《Getting Over It》。** 下图来自 2026 年 10 月 29 日的早期公开试播，保留当时真实的游戏与角色布局。

![早期公开试播：游戏、GPT 学姐、大肥鱼学妹与节目状态栏](docs/assets/live-gameplay.png)

*游戏恢复后的节目输出，纽约时间 03:55。顶部“GPT（暂停）”为当时真实状态。*

<details>
<summary><b>再看一张：第一棵树前的双主播画面</b></summary>

![早期公开试播：第一棵树附近的游戏与双角色，顶部显示交接中](docs/assets/live-handoff.png)

*纽约时间 04:26，顶部实际显示“交接中”。画面未经补绘或替换。*

</details>

*这些是项目内部接入环境在公开直播期间保存的节目输出截图；公开 v0.1.0 仍需配置适配器，不是安装即得的效果。截图不代表观众端下行、弹幕回复或整场自主运行已通过验收。[素材与范围说明](docs/showcase.md)*

## 把一个直播间，交给一支 AI 团队

游戏操作、主持节奏、观众互动、舞台声音和异常收尾需要配合。霓裳把这些工作整理成七个岗位，让你选择自己的 AI、角色、游戏与平台。

| 一键准备团队 | 多主播配合 | 串起直播流程 |
| :--- | :--- | :--- |
| setup 准备应用、七岗提示词与 Agent Skill；模型和供应商自由选择 | 默认 A/B 双主播、轮换玩家、共享语音队列，协调主持与游戏操作 | 接入检查、演练、运行、恢复与停止；按阶段核对真实结果 |

## 工作室预览

![工作室真实截图：新建空白角色库与舞台，未开始直播](docs/assets/studio-preview.png)

*当前源码在全新资料目录中的真实界面。初始没有预装角色、声线或直播记录；截图不是直播实录。可在工作室中创建自己的角色与场景。*

![七个岗位协作与外部适配器接入示意](docs/assets/team-flow.svg)

*协作流程示意。实线说明岗位分工，外部模型、游戏、语音和平台需要各自接入并验证。工作室与通用运行核心之间也需要集成宿主连接。*

## 快速开始

需要 [Node.js 22.12 或更新版本](https://nodejs.org/en/download)（含 npm）与网络连接。先下载源码并进入目录：

```sh
git clone https://github.com/XIANYU-HW/ai-streamer-workflow.git
cd ai-streamer-workflow
```

然后准备并打开工作室：

```sh
npm run setup
npm run doctor
npm run studio
```

Windows 也可以双击 `Setup-Windows.cmd`；macOS / Linux 可以运行 `sh setup.sh`。首次 setup 下载 Electron 应用依赖、创建 `.local/workflow.json` 和七岗提示词；**不会自动开始游戏、播音或直播**。

`doctor` 会列出尚未接入的模块。新安装显示 `UNCONFIGURED / NOT_VERIFIED` 是正常的待配置状态。重复 setup 会保留你的配置和已修改的 Skill。

只想先看看调度逻辑？不需要模型账号或付费服务：

```sh
npm run setup -- --skip-install
npm run demo
```

这个 demo 使用模拟适配器，演示礼物优先、去重、玩家轮换、局部恢复和停止确认；输出明确标注 `simulated: true`，不会操控真实游戏、播放语音或开播。`--skip-install` 只准备配置，启动图形工作室仍需完整 setup。

## 给团队选好角色，再接上真实世界

1. **选择配置**：编辑 `.local/workflow.json`，设置主播、模型、声线、游戏与输出平台。供应商、模型与推理档位默认留空，密钥通过本机应用安全设置管理。
2. **建立岗位**：让支持 Skill 的 AI 读取 [ai-streamer-workflow/SKILL.md](skills/ai-streamer-workflow/SKILL.md)。setup 生成提示词和计划，客户端拥有建会话工具时才能自动创建实际 Agent；其他客户端可手动使用 `.local/agent-plan/` 的七份提示词。
3. **接入适配器**：按 [接口文档](packages/runtime/INTEGRATION.md) 连接模型决策、游戏观测与输入、语音、观众事件及直播软件，逐项核对真实回执。
4. **完成演练**：先确认游戏响应、声音入节目、画面采集和停止有效，再进行授权范围内的录播或直播。参见 [运行指南](skills/ai-streamer-workflow/references/operation.md)。

可以向你的 AI 提出：

```text
为这个项目创建并配置七个岗位对话，使用我当前选择的 AI 和模型。
先读取项目 Skill，完成接入检查，并列出仍缺的适配器；暂不启动直播。
```

| 岗位 | 负责什么 |
| :--- | :--- |
| 项目统筹 | 目标、配置与跨岗位协调 |
| 直播导播 | 节目节奏、画面与待机切换 |
| 游戏实况执行 | 持有唯一游戏控制权，执行策略与主持协作 |
| 观众互动管理 | 选择弹幕、核验礼物、整理待回应内容 |
| 游戏适配工程师 | 接通具体游戏的观测、输入和反馈 |
| 舞台与声音工程师 | 角色、场景、声线和输出接入 |
| 独立验收 | 按证据核对安装、运行与收尾 |

## 这个版本能做什么

| 部件 | 已提供 | 接入者仍需完成 |
| :--- | :--- | :--- |
| 舞台工作室 | 身份故事、角色/场景编辑、最多四人编排、独立声线配置 | 角色和动画素材、声线与节目采集 |
| 角色记忆 | 按角色隔离、草稿确认、跨场上下文、本地保存与备份 | 真实直播事件采集、自动提炼和模型决策接入 |
| 协作核心 | 单控制租约、单语音队列、礼物优先与去重、轮换、健康与停止状态 | 持续运行宿主和真实适配器 |
| 游戏 | 通用接口与游戏适配专岗 | 每款游戏的观测、输入和实机验证 |
| 互动 | 标准观众事件接口与模拟事件 | 平台允许的真实弹幕/礼物入口 |
| AI / 模型 | 职责、能力要求与建岗模板 | 你选择的客户端/API和实际决策连接 |
| 节目输出 | 舞台与可选节目窗口，不绑定某款直播软件 | 音画路由、平台软件与实际开播/下播验收 |

默认每 15 分钟轮换玩家，两位主播都可以说话；普通弹幕择要回应，可信礼物优先。无弹幕时控制闲聊频率；局部故障由对应岗位恢复，需要大修时切换待机。**用户停止请求优先处理，实际停止结果以回执为准。** 参数可在配置与集成宿主中调整。

核心逻辑的离线检查、桌面界面检查和真实直播是不同的验证层级。具体范围见 [验证状态](docs/verification-status.md) 与 [平台支持](docs/platform-support.md)。当前交付为源码，不含已签名桌面安装器。

## 开发与参与

欢迎贡献真实适配器、平台实测和可复现问题。优先方向见 [路线图](docs/roadmap.md)，步骤见 [贡献指南](docs/contributing.md)。

```sh
npm test                # 离线逻辑检查
npm run check:release   # 源文件与隐私边界检查
npm run release         # 生成干净源码 ZIP、SHA256 和清单
```

```text
apps/       工作室与节目窗口
packages/   调度核心、适配器协议与模拟
skills/     Agent Skill、七岗职责与运行指引
config/     不绑定供应商的默认配置
docs/       架构、验证范围与贡献说明
```

[架构](docs/architecture.md) · [验证方法](skills/ai-streamer-workflow/references/verification.md) · [源码打包说明](docs/release.md) · [提交问题](https://github.com/XIANYU-HW/ai-streamer-workflow/issues/new/choose)

## 许可证

本项目原创代码与文档采用 [MIT License](LICENSE)。第三方依赖保留各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。角色、声音、模型与平台服务由使用者自行选择，其授权分别适用。

<div align="center">

由 [清风作梦 · Dreaming Breeze](https://github.com/XIANYU-HW) 发起  
**让每个想象中的直播间，都有机会成为现实。**

</div>
