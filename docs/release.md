# 发布与源码包 / Source releases

AI Streamer Workflow 0.1.0 是面向开发者的接入框架预览版。原创代码与项目文档采用 [MIT 许可证](../LICENSE)；第三方依赖保留各自许可，详见 [Third-party notices](../THIRD_PARTY_NOTICES.md)。`package.json` 中的 `private: true` 用来防止意外发布到 npm，不限制 MIT 授予的使用权。

## 构建可核验的源码包

在仓库根目录执行：

```sh
npm run check:release
npm run release
```

生成的文件位于 `artifacts/`：

- `ai-streamer-workflow-0.1.0-source.zip`：允许发布的源码与通用文档。
- 同名 `.sha256`：整个 ZIP 的 SHA-256。
- `SOURCE_MANIFEST.json`：每份文件的相对路径、大小和 SHA-256；ZIP 内也包含该清单。

这些命令只在本地构建，不创建 GitHub 仓库、不推送代码，也不自动发布 GitHub Release。清单和散列可核对文件一致性，不能证明全部运行能力。

## 发布核对

1. 在干净目录验证安装、测试和有限离线 demo。记录操作系统、Node 版本、源码提交与实际命令结果。
2. 执行源包检查，并人工检查最终文件清单。源包检查是基本隐私和结构检查，不能识别所有私人内容。
3. 确认仓库、可见范围和发布版本。上传源码时保留许可证与第三方声明；应用二进制还须保留所用 Electron/Chromium 的许可文件。
4. GitHub Release 说明写明功能、已验证环境、已知缺口和安装入口。预览版应标为 pre-release；不要把源码 ZIP 命名为即装即播的桌面安装器。
5. 上传后核对远端文件、提交与校验结果。CI 实际运行成功才可登记为对应系统的离线检查通过。

## 发布内容边界

仓库只包含通用架构、源代码和经许可的展示素材。发布包排除 `.local/`、`.agents/`、依赖、缓存、构建产物和版本历史。运行历史、角色记忆、私人图片/声音、用户数据、账号、密钥、API 响应原文、账本、游戏副本、存档、录屏和私人会话标识不得进入源码包。不要整体推送日常运行目录。

当前源码验证不等于真实模型、游戏、声音和平台已接通，也不等于完成公开直播。应用签名、公证及各操作系统安装器不属于本次源码包的现成产物。完整边界见 [验证状态](verification-status.md) 和 [平台支持](platform-support.md)。

## English

The project is MIT-licensed. Build a source archive with `npm run release`; the output includes a SHA-256 file and a per-file manifest. The command does not publish to GitHub. Mark preview releases as pre-releases, retain third-party notices, and document what was actually tested. A source archive, passing unit tests, and a successful CI run do not establish a working end-to-end livestream.
