# 展示素材说明 / Showcase notes

## AI 直播天团封面

`assets/hero.jpg` 是为霓裳项目用内置 imagegen 生成的概念合绘，并用同一张图作为 GitHub 分享预览。构图包含 GPT、DeepSeek、Claude、Gemini、Grok、Kimi 六位 AI 的社区拟人意象：白紫龙娘、蓝发鲸鱼娘、橙发花饰、蓝紫猫耳、金发黑衣与银紫月色。生成后只转换为 JPEG 以减小下载体积，没有使用第三方立绘文件拼贴。

形象方向参考 [AI 娘化图鉴](https://genderswapai.com/zh-CN/ai-gijinka) 与 [AIHER](https://aiher.ai/)，其中图鉴记录了 ZipZipPipe 等社区创作者的形象贡献。此图是项目主题插画，不是实际直播截图，也不表示六模型已全部完成接入、角色随源码预装或品牌官方背书。第三方品牌与既有角色设计的权利不因项目 MIT 许可而转移。

## 真实试播画面

`live-gameplay.png` 与 `live-handoff.png` 是 2026-10-29 早期公开试播期间保存的本地节目输出，均为 960 × 540 原图，未裁剪、未补画、未替换游戏或角色。

| 文件 | 纽约时间 | 画面与状态 | SHA256 |
| --- | --- | --- | --- |
| `assets/live-gameplay.png` | 03:55:06 | 游戏恢复后；顶部显示 GPT 暂停 | `428f7f667428c00bbfccaca66e8ad86966363a7fee1494c17ebc4c9cdc954caf` |
| `assets/live-handoff.png` | 04:26:19 | 第一棵树附近；顶部显示交接中 | `aa589bf00071e6a653c9a95d9c80de84c5a604aca2970cb7c8ff9b3734301b20` |

项目统筹核对了两张图片与同场连续性记录的关联。平台原生结束页显示 03:51–04:35、共 45 分钟；这证明对应场次确实开播并结束，不证明每个组件在全程正常运行。含账号和观众信息的后台原图没有随仓库发布。

截图来自内部已接入环境，不代表公开 v0.1.0 安装即可得到相同效果；未用这些画面证明观众端下行、真实弹幕处理、声音采集、游戏进展或无人指引闭环。画面中弹幕区为空，暂停和交接状态原样保留。

游戏画面来自 *Getting Over It with Bennett Foddy*，权利归相应权利人。GPT 学姐为参考[用户指定的公开拟人作品](https://www.douyin.com/note/7689579334881433855)重绘的项目角色，大肥鱼学妹为项目生成的鲸鱼主题角色。这里展示实际节目画面，未把其中的独立立绘、游戏素材或第三方设计作为 MIT 角色资源包分发。

## 工作室预览与能力

`assets/studio-preview.png` 是公开源码在全新资料目录中的真实界面，属于产品界面截图，不是直播记录。角色库初始为空。

- 身份故事、角色与场景：[`model.js`](../apps/studio/renderer/model.js) 的角色校验、保存与开场快照。
- 独立记忆：同一文件的事件记录、记忆草稿与确认、`buildContext`；记忆按角色隔离，确认后可用于后续场次。
- 当前事件来自手动排演记录；真实直播自动采集、长期记忆进入外部模型提示、无人指引运行仍需集成验证。
- 工作室单场最多四人；默认直播协作模板为双主播。角色库当前上限 12，记忆条目上限 1000，并非无限储存。

## English

The AI-generated cover is a conceptual ensemble inspired by community AI personifications, not an official brand collaboration or a bundled six-model integration. The two 960 × 540 gameplay images are unmodified programme-output captures saved during an actual early public trial stream on October 29, 2026. They show paused / handoff-in-progress states as they were. They come from an internal integrated environment, not a clean installation of public v0.1.0, and do not establish viewer-side delivery or autonomous operation. Game imagery, brands, and pre-existing character designs retain their respective rights; the MIT code license does not grant rights to those third-party elements.
