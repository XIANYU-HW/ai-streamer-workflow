# Programme Host

独立、静音的公开节目窗口。默认只有中性等待画面，没有角色、历史场次、图片、凭据或预设节目地址。它不启动工作室、直播软件、声音、游戏或服务器。

## 安装与启动

使用 Node.js 22.12 或更新版本和 npm。仓库安装流程只安装依赖并执行静态 `prepare`，不会打开窗口。

```sh
npm ci
npm test
npm start
```

只有显式启动时才出现窗口。显式配置本机公开画面示例（端口替换为本机工作室提供的值）：

```sh
npm start -- --url http://127.0.0.1:19100/overlay.html
```

可选 `--standby-url http://127.0.0.1:19100/standby.html` 必须与主画面同源。只支持 `127.0.0.1` 或 IPv6 `[::1]`、明确端口的 HTTP 地址；不接收账号、查询参数、外网地址或私有编辑页面。入口为 `overlay.html`、`scene-output.html` 或 `standby.html`。

公开资源限 `style.css`、`motion.css`、`avatar.js`、`stage-render.js`、`overlay.js`、`state.json` 与只读 `/api/public`、`/api/public-meta`、`/api/motion`。用户图片可内嵌 PNG/JPEG/WebP data URL。POST、声音媒体、麦克风/摄像头权限、下载、子窗口、重定向与私有 API 均不开放。

默认资料目录为系统 AppData 下的 `AiStreamerProgrammePublic`。可用 `AI_STREAMER_PROGRAMME_DATA_DIR` 指定新的绝对本机路径；相对路径、符号链接、旧工作室/节目窗目录或已有陌生文件的目录会被拒绝。它不会寻找、导入或读取旧用户资料。

快捷键只在本窗口生效：`Cmd/Ctrl+1` 节目页，`Cmd/Ctrl+2` 等待页，`Cmd/Ctrl+R` 重载，`Cmd/Ctrl+Q` 退出。窗口静音且无边框，可拖动。1920×1080 内容按窗口尺寸缩放，不承诺系统级透明窗口效果。

## 验证与构建

`npm test` 是隔离的 Node 测试，不运行 Electron 或访问网络。`npm run prepare` 只检查源码和包配置。`npm run smoke` 才会显式运行隐藏的 offscreen Electron，使用临时资料目录、默认空态、无远程请求，结束后清理临时目录。

```sh
npm run build:mac
npm run build:win
```

构建只使用已安装的精确 Electron 45.0.0 运行库，输出到本目录 `dist/`，不启动应用。`build:mac` 要求 macOS 和 macOS 运行库；`build:win` 要求 Windows 运行库，不能把当前系统下载的 Mac 运行库当作 Windows 版。交叉打包可显式设置 `AI_STREAMER_ELECTRON_DIST` 指向同版本、目标平台的纯净 Electron 解压目录（需保留 `version` 与上游许可证文件）。已有输出不会覆盖。

macOS 包只做本机 ad-hoc 签名，没有开发者签名或公证；Windows 是便携目录，没有签名安装器，版本资源仍为上游 Electron。源码测试、打包、Windows 实机运行、录制软件捕获分别验收；不能由前者推断后者通过。Electron/Chromium 的原许可证随运行库保留，本项目原创源码采用 [MIT 许可证](../../LICENSE)。
