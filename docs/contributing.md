# 参与贡献 / Contributing

欢迎改进 AI Streamer Workflow。当前最有价值的贡献是可复现的适配器、真实接入证据、跨平台兼容修复和更清楚的使用说明。较大的接口或行为变化请先开 Issue，说明目标、使用场景及验证方法，便于避免重复开发。

## 本地准备

需要 Node.js 22.12 或更新版本和 npm。在自己的 fork/分支上工作：

```sh
git clone https://github.com/XIANYU-HW/ai-streamer-workflow.git
cd ai-streamer-workflow
npm ci --ignore-scripts
npm run setup -- --skip-install
npm test
npm run demo
npm run check:release
```

此路径只准备配置并执行离线检查，不安装桌面运行库。需要检查舞台时，再运行 `npm run setup` 和 `npm run studio`。`npm run demo` 使用模拟驱动，不启动真实游戏、语音或直播。

## 改什么，验证什么

| 修改类型 | 建议验证 |
| --- | --- |
| 文档和展示素材 | 链接、排版、准确性及 `npm run check:release` |
| 核心调度或状态 | 相关失败场景、恢复/停止行为，以及 `npm test` |
| 桌面应用 | 离线测试 + 对应操作系统上的实际窗口或声音检查 |
| 新适配器 | [接口契约](../packages/runtime/INTEGRATION.md) + 实际外部效果、超时和清理回执 |

真实测试须在自己的获准环境中进行。不要用模拟驱动通过真实直播验收，也不要将“命令已发送”当成“游戏已发生动作”或“声音已进入直播”。未验证的部分请直接写明。

## 提交 Pull Request

用简短说明写清楚：遇到的问题、修改后的行为、验证命令与结果，以及尚未验证的部分。添加适当的回归覆盖，避免只重复实现细节的测试。行为变化保持默认不产生外部输出、不启用费用；如果需要改变默认值，请在 PR 中明确说明。

只提交通用源文件。`.local/`、`.agents/`、角色资料、声音、运行日志、账号和密钥留在本机。截图或错误输出需去除个人资料和凭据。不要直接粘贴整个运行目录。

贡献应是你有权按本项目 [MIT 许可证](../LICENSE) 提供的内容；第三方代码、素材和依赖须保留来源与原许可。角色、游戏资源和外部服务访问权不由本仓库授予。

## English

Start with a focused issue for substantial changes. Use Node.js 22.12+, run the offline checks above, and verify the actual affected behavior. Tell reviewers what changed, how it was tested, and what remains unverified. Real adapters need real external evidence; simulated receipts are useful fixtures, not proof of livestream operation. Keep personal data, credentials and runtime artifacts out of commits. Contributions must be available under the project MIT license, with third-party notices preserved.
