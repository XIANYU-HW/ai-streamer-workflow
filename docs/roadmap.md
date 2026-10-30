# 霓裳 · 路线图 / Roadmap

**定位：一站式AI团队全自动直播。** 让拥有身份故事与独立记忆的 AI 主播自由组合，在完成接入与授权后，协作执行从开播到下播的完整流程。

这是产品方向。0.1.0 交付的是接入框架与开发者预览；整场自主直播尚未由本公开源码包证明。下列后续阶段是工作方向，不代表已完成或承诺发布日期。

本项目将持续迭代：优先修复已发现、可复现的问题，再完善真实接入与首次使用体验。[已知限制](known-limitations.md) 记录当前确认的边界，具体进展以实际提交和后续版本说明为准。

## 0.1.0 · 团队与工作流基础

- [x] 一次 setup 准备本地配置、Skill 和七岗提示词；实际 Agent 会话由宿主创建。
- [x] 可选 AI/模型、两位主播槽位与可配置轮换规则。
- [x] 单控制租约、单语音队列、礼物事件去重/优先、健康与停止状态。
- [x] 身份故事、角色独立记忆草稿与确认、跨场上下文、本地备份。
- [x] 最多四人的工作室场景编排、可选节目窗口和有限离线 demo。
- [x] 清晰的适配接口、源码包清单和离线测试入口。

## 接下来 · 首条真实闭环

- [ ] 给出一个可复现的真实模型与游戏适配示例，覆盖观察、决策、输入和释放。
- [ ] 将真实语音播放与舞台输出接入录制，分别核验声音已播放与录制已采集。
- [ ] 接入一个平台允许使用的真实弹幕/礼物来源，核验事件来源、去重和回复延迟。
- [ ] 在限定时长内完成真实输出、轮换、异常待机及停止，保存可分享的脱敏验收证据。

- [ ] 接入真实直播事件，完善角色记忆自动提炼、确认与跨场调用链路。

## 然后 · 从搭建走向自主运行

- [ ] 将七岗实际会话创建、健康检查、交接和恢复串成可观察的任务流程。
- [ ] 在用户选定环境和权限范围内，验证无需逐步人工提示的开播到下播流程。
- [ ] 增加多个游戏/平台的适配案例；逐项发布支持矩阵，不从单个案例推断普遍支持。
- [ ] 改善首次使用引导、跨平台图形/音频兼容和安装交付体验。

每一项“完成”都应带上适用环境与证据。源码、模拟、应用窗口、实际录制和公开直播分别验收。欢迎通过 [Issue](https://github.com/XIANYU-HW/ai-streamer-workflow/issues/new/choose) 提出场景，或按 [贡献指南](contributing.md) 提交实现。

## English

The goal is an AI broadcast crew that can run an entire session without step-by-step human guidance after configuration and authorization. Version 0.1.0 delivers the coordination framework, role prompts, studio source and offline demos. The next milestone is one reproducible real integration with observable game, voice, event, output and stop behavior. Autonomous full-session operation and broader platform coverage remain future validation milestones.
