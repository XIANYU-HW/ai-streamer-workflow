# 已知限制 / Known limitations

霓裳（Nichang）的首个公开版本仍在早期开发阶段。目前已发现一些问题，后续会持续修复与完善。这份清单说明当前确认的能力边界；它不是所有缺陷的完整列表，也不表示未列出的功能已经验证。

| 当前限制 | 对使用者的影响 |
| --- | --- |
| 没有随包交付完整的真实适配链 | 模型、游戏、语音、观众事件与平台需要按设备接入；不能直接启动一场无人指引的完整直播 |
| setup 只生成岗位计划与提示词 | 自动创建真实岗位会话取决于 AI 客户端工具；缺少工具时需手动建立 |
| 工作室与通用 runtime 是独立模块 | 需要持续运行的集成宿主连接；启动两个进程不代表已接通 |
| 跨平台验收仍不完整 | 自动化离线检查不能替代 Windows/Linux/macOS 的实际音频、游戏输入与采集验证 |
| 没有已签名/公证的桌面安装器 | 当前从源码安装；桌面交付体验仍需完善 |
| 主要详细文档为中文 | 英文首页已提供，完整英文实现指南仍待补齐 |

## 反馈与更新

遇到问题请通过 [Bug 表单](https://github.com/XIANYU-HW/ai-streamer-workflow/issues/new?template=bug_report.yml) 提供环境、版本、复现步骤、预期与实际结果。请移除账号、密钥、角色隐私与运行原文。

维护方向是持续修复可复现的问题、完善首次使用体验，并逐步交付可验证的真实直播链路。功能方向见 [路线图](roadmap.md)。具体优先级和进度以仓库实际提交、Issue 和后续版本说明为准；不承诺未经确认的发布日期或响应时限。

## English

Nichang is an early public preview with known rough edges. It does not bundle a complete real-world adapter chain or guarantee unattended end-to-end broadcasts. Agent creation depends on client tooling; the studio and generic runtime need an integration host. Real audio, gameplay and capture require device-specific validation. Signed installers and complete English implementation guides are not yet provided.

Development will continue through bug fixes, integrations and usability improvements. Please report reproducible problems without credentials or private runtime data. Track actual progress through commits, issues and future version notes; the roadmap is a direction, not a release-date promise.
