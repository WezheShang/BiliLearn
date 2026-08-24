# Suikan 随看 📺

> **随时看，随手记。Watch less. Learn more.**
> 一款把"长视频"变成可学习、可检索、可保存的学习资料的浏览器扩展。

[![Forked from youtube-digest](https://img.shields.io/badge/forked%20from-youtube--digest-blueviolet)](https://github.com/zarazhangrui/youtube-digest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Maintainer: WezheShang](https://img.shields.io/badge/maintainer-WezheShang-orange)](https://github.com/WezheShang)
[![Status: V1.0 (renamed from bilidown)](https://img.shields.io/badge/status-V1.0-blue)]()

**Suikan（随看）** 是 **WezheShang** 维护的 Chrome / Edge 扩展，基于 [Zara Zhang 的 youtube-digest](https://github.com/zarazhangrui/youtube-digest) 二次开发，遵循 MIT 协议。

它把一段长视频从"必须从 0 看到 1"的负担，转化成"边看边记、随时回看、可导出的可沉淀资料"。当前主要支持哔哩哔哩（B 站），未来会扩展到 YouTube、抖音、知乎视频课、Ted、Coursera 等学习视频平台。

**它不是简单地把整段字幕丢给 AI**——围绕真实使用场景处理了几个关键问题：**视频切换、分 P / 合集识别、时间戳跳转、播放位置跟随、全屏笔记、AI 概览、多格式导出**。

> [!IMPORTANT]
> 本项目由 **WezheShang** 维护，基于 [zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest) 二次开发，遵循 MIT License。
>
> **V1.0 重命名公告**：本项目原名 **bilidown**（V0.x 早期版本），V1.0 起改名为 **Suikan 随看**，定位从"B 站专用适配版"升级为"通用学习视频助手"。B 站是第一个支持的平台，未来会按平台贡献者优先级扩展。
>
> 完整版权与致谢信息见 [`NOTICE`](NOTICE) 和 [`LICENSE`](LICENSE) 文件。

---

## ✨ 核心功能

### 1. 与视频网站深度集成

扩展会直接注入到视频页面，在操作栏中加入 **AI 总结** 按钮：

- 跟随视频站操作栏布局（不被页面缩放/响应式影响）
- 点击后打开浏览器侧边栏
- 不需要复制视频链接到其他工具
- 支持 SPA 单页应用的视频切换

侧边栏包含 4 个视图：

```text
字幕        原文 / 中文 / 双语
概览        AI 章节 + 关键观点（懒加载）
总结        整段学习笔记（懒加载）
笔记        时间戳 + 自由记录
```

### 2. 视频身份精确识别

视频站可能在不刷新浏览器的情况下切换 BV、分 P 或合集分集。Suikan 会根据当前页面的：

```text
BV 号 / 视频 ID
分 P 参数
合集 / 分集标识
当前活动视频链接
```

创建独立状态和缓存，避免打开第二个视频后仍显示第一个视频的内容。**关键技术点**：bvid+cid 双键缓存，cid 是分集之间的唯一区分键（多 P 视频共享 bvid 和标题）。

### 3. 配置 ASR 后默认使用语音识别

当前版本把 Fun-ASR（阿里云百炼）作为配置后的主要文字来源：

```text
已配置阿里云百炼 API Key
        ↓
点击 AI 总结后直接使用 Fun-ASR
```

这样可以绕开某些视频没有字幕、AI 字幕质量不稳定或字幕有错的情况。

如果没有配置百炼 API Key，扩展才会读取：

```text
平台原生字幕接口（如 B 站的 /x/player/wbi/v2）
        ↓
校验返回的 bvid / cid 是否与当前视频一致（避免字幕错配）
```

ASR 不会在打开页面时自动预加载——只有点击 AI 总结后才会开始下载和识别，从而避免：

- 不必要的流量消耗
- 页面打开后的后台任务
- API 免费额度消耗
- 用户只是浏览视频时的等待

### 4. 中文 AI 概览 / 总结

AI 会根据当前视频字幕或 ASR 结果生成：

- 视频内容概览
- **简体中文**章节时间线
- 每章内容说明
- 关键观点
- 值得记录的原话
- 可继续整理的学习笔记

章节标题和说明会**显式要求使用简体中文**——不会因为字幕里混有英文术语就生成整套英文章节。

### 5. 播放位置联动

点击字幕或概览中的时间戳，播放器会跳转到对应位置：

```text
00:27 → 跳转到视频第 27 秒
04:18 → 跳转到视频第 4 分 18 秒
```

字幕列表也可以跟随当前播放进度，方便边看视频边阅读内容。

### 6. 普通页面与全屏笔记

除了侧边栏中的笔记页面，扩展也适配了播放器全屏场景。可以在观看过程中记录：

- 当前时间戳
- 临时想法
- 视频重点
- 待办事项
- 需要回看的片段

笔记会绑定当前视频 ID 和分集，不会混入其他视频。

### 7. 多格式导出

当前支持：

```text
Markdown
HTML
复制到飞书（剪贴板 / 富文本双通道）
```

适合继续整理到飞书文档、飞书知识库、Obsidian、Notion、Typora、个人博客或本地 HTML 文件。

### 8. 切换页面不中断后台转录（Whisper 路径）

如果你用本地 Whisper 而不是 Fun-ASR：开始转录后可以**自由切换到其他标签页或关闭侧栏**——转录在后台继续，**不会因为页面失焦而中断**。这是从 youtube-digest 继承的能力，并在 bilidown 阶段做了三重加固：

- `chrome.alarms` 每 30 秒唤起 service worker 维持心跳
- 转录完成即写服务端缓存（即使客户端死了结果也不丢）
- 看门狗检测异常中断的转录任务并恢复

> 此项仅当使用本地 Whisper（`start_whisper_server.bat`）时生效。Fun-ASR 是云端接口，本身不受浏览器焦点影响。

### 9. 繁体 → 简体自动归一化

whisper-tiny/base 在普通话音频上有概率输出繁体字（输/别/体）。服务端在落盘前自动用 zhconv 转成简体——不需要二次手动校正。

---

## 🌐 当前支持的平台

| 平台 | 状态 | 笔记 |
| --- | --- | --- |
| **哔哩哔哩 (B 站)** `bilibili.com/video/*` | ✅ 主要支持 | 完整功能：操作栏按钮、识别、B 站原生字幕、`/x/player/wbi/v2` |
| YouTube | 🚧 计划中 | 沿用 youtube-digest 原能力 + B 站内容审查规则 |
| 抖音 / 知乎视频课 / TED / Coursera | ⏳ 未来 | 等需求或贡献者 |

扩展的代码结构按"按平台适配"组织——`content.js` 检测当前 URL 走对应平台分支，**共享** ASR / AI 概览 / 笔记 / 导出逻辑。**新增平台 = 加一个 content script 适配 + 一个 platform-specific fetcher**，核心 pipeline 复用。

---

## 🖥️ 浏览器兼容性

| 浏览器 | 建议版本 | 支持情况 |
| --- | ---: | --- |
| Google Chrome | 116+ | ✅ 主要支持 |
| Microsoft Edge | 116+ | ✅ 主要支持（同一份 zip） |
| 其他 Chromium 浏览器 | 116+ | ⚠️ 取决于 Side Panel API |
| Firefox | — | ❌ 当前不支持 |
| Safari | — | ❌ 当前不支持 |

Chrome 和 Microsoft Edge 使用同一个扩展目录和安装包，**不需要单独下载 Edge 版本**。

其他 Chromium 浏览器需要支持：

```text
Manifest V3
Side Panel API
chrome.alarms（用于后台保温）
chrome.storage.local
```

---

## 🚀 快速安装

### 方法一：加载发布包

1. 下载 `suikan-v1.0.x.zip`。
2. 将 ZIP 完整解压到固定文件夹（**不要**放在云盘同步目录——Chrome 会校验文件路径）。
3. 不要在加载扩展后删除或移动该文件夹。

#### Chrome

1. 打开 `chrome://extensions/`。
2. 开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择刚才解压的文件夹。

#### Microsoft Edge

1. 打开 `edge://extensions/`。
2. 开启左侧的 **开发人员模式**。
3. 点击 **加载解压缩的扩展**。
4. 选择刚才解压的文件夹。

安装完成后，刷新已经打开的视频页面。

### 方法二：从源码加载

```bash
git clone https://github.com/WezheShang/suikan.git
cd suikan
```

然后在 Chrome 或 Edge 的扩展管理页面中直接选择项目根目录。

扩展运行不依赖 npm；npm 只用于跑测试和打包。

---

## 🔑 API 配置

| 服务 | 是否必需 | 用途 |
| --- | --- | --- |
| **minimax API Key** | 必需 | 概览、章节、观点、翻译和笔记整理（任何 AI 提供商都可以走 OpenAI 兼容接口） |
| **阿里云百炼 API Key** | 推荐配置 | 配置后默认使用 Fun-ASR 作为字幕来源 |
| **本地 Whisper** | 可选 | 完全离线场景，需启动 `start_whisper_server.bat` |

点击扩展的 **设置**，填写对应 API Key 后保存即可。

密钥只保存在当前浏览器的扩展本地存储中。重新安装扩展或清除扩展数据后，需要重新配置。

### 更新时保留 API Key

**不要先删除旧扩展。** Chrome 官方说明，扩展被移除时会清除它的 `chrome.storage.local`；即使稍后装回相同扩展 ID，已经删除的本地 Key 也不会自动回来。

本扩展从 V1.0 起在 `manifest.json` 中包含固定的扩展身份公钥。即使开发者模式下更换了解压目录，Chrome / Edge 也可以据此生成稳定的扩展 ID。首次从更早版本切换到 V1.0 时扩展 ID 可能改变一次，需要重新填写一次 Key；之后请保留该 `key` 字段，不要在二次开发时重新生成。

---

## 🧠 当前工作原理

```text
打开视频页面
      ↓
content.js 检测平台 + 注入 AI 总结按钮 + 识别当前视频 ID / 分集
      ↓
用户点击 AI 总结
      ↓
是否配置百炼 API Key？
      ↓
   ┌──┴──┐
  是     否
   ↓      ↓
Fun-ASR  平台原生字幕（如 B 站的 /x/player/wbi/v2）
音轨转写  校验 bvid / cid 一致性
   ↓      ↓
   └─→ 转写文本 + 时间戳
            ↓
      minimax 分析
            ↓
   概览 / 章节 / 观点 / 笔记
            ↓
    按视频隔离缓存（bvid+cid 双键）
            ↓
      侧栏 UI 渲染
```

设计原则：

> **配置 ASR 后默认使用 ASR；未配置时读取原生字幕；所有分析结果按视频隔离。**
> **不再让用户看到 30 分钟的"白板等待"——所有长任务必须可后台、可恢复。**

---

## 🎙️ 为什么用阿里云百炼 Fun-ASR？

原上游项目（youtube-digest）主要围绕 YouTube 和 Supadata 工作，但 Supadata 的视频平台支持范围不包含 B 站。

因此本项目将配置百炼 Key 后的默认识别流程改为阿里云百炼 Fun-ASR：

- 国内账号注册和访问更方便
- 中文识别更符合当前场景
- 不要求用户本地安装 Python、模型和运行环境
- 不需要长期占用本机 CPU / GPU
- 浏览器扩展只在用户需要时调用

Fun-ASR 是否免费取决于阿里云百炼当前的免费额度和计费规则。本项目不会绕过平台计费，也不承诺永久免费。

---

## ⚡ ASR 速度说明

无字幕视频的完整流程包含：

```text
获取视频播放信息
下载音轨
上传临时音频
提交识别任务
等待 Fun-ASR / 本地 Whisper 完成
拉取识别结果
minimax 生成概览
```

因此它一定会比直接读取字幕慢。

当前版本优先选择低码率音轨，以减少下载、上传和识别等待。视频越长、网络越慢、识别任务越繁忙，耗时越明显。

---

## ⚠️ HTTP 403 是什么？

视频音轨地址通常带有临时鉴权参数，可能在一段时间后失效。

如果出现：

```text
语音识别失败
B 站音轨下载失败：HTTP 403
```

可以依次尝试：

1. 刷新当前视频页面。
2. 确认视频可以正常播放。
3. 重新点击 AI 总结并发起 ASR。
4. 如果扩展刚更新，在扩展管理页面重新加载扩展。
5. 私密、付费、地区限制视频可能仍然无法下载音轨。

扩展会为视频站媒体请求补充必要的来源信息，但无法保证所有受限视频都可以识别。

---

## 📖 使用流程

1. 打开一个公开的视频页面（B 站 / 未来 YouTube / 抖音）。
2. 点击"转发"按钮右侧（或对应平台 UI 锚点）的 **AI 总结**。
3. 在侧边栏确认当前视频标题和 UP 主 / 频道。
4. 已配置百炼 API Key 时，等待 Fun-ASR 完成识别（或本地 Whisper 完成）。
5. 未配置百炼 API Key 时，插件尝试读取当前视频的原生字幕。
6. 打开 **概览** 查看中文章节和关键观点。
7. 点击章节或字幕时间戳跳转视频。
8. 在 **笔记** 中记录内容。
9. 导出 Markdown、HTML，或复制到飞书。

---

## 📁 项目结构

```text
suikan/
├── manifest.json              # Chrome / Edge 扩展配置
├── background.js              # API、ASR、缓存与后台消息
├── content.js                 # 视频站按钮、播放器和视频切换
├── settings.js                # 设置读取与兼容逻辑
├── sidepanel.html             # 侧边栏页面
├── sidepanel.css              # 侧边栏 B 站主题样式
├── sidepanel.js               # 字幕、概览、笔记与导出
├── options.html               # 设置页面
├── options.css
├── options.js
├── _locales/
│   └── zh_CN/
│       └── messages.json      # Chrome Web Store 多语言描述
├── prompts/                   # AI 分析提示词
├── rules/                     # B 站音轨网络规则
├── icons/                     # 扩展图标
├── whisper_server.py          # 本地 Whisper 推理（仓库外依赖 zhconv，见 README）
├── start_whisper_server.bat   # 本地 Whisper 启动脚本（-B -I 抑制 __pycache__）
├── dev-clean.ps1              # 扩展加载前清理 __pycache__/ 等 Chrome 拒载条目
├── t2s_converter.py           # 仓库外的简繁转换（避免在 bilidown 根生成 __pycache__/）
├── PRIVACY.md
├── SECURITY.md
├── LICENSE
├── NOTICE                     # 双版权与修改说明
├── CHANGELOG.md
└── README.md
```

测试套件独立于扩展目录，位于仓库外的 `../bilidown-tests/`（**不是** Chrome 扩展扫描范围）。

---

## 🧱 技术栈

```text
Chrome Extension Manifest V3
Vanilla JavaScript
HTML5 / CSS3
Side Panel API
chrome.alarms（后台保温）
chrome.storage.local
minimax API（任何 OpenAI 兼容接口）
阿里云百炼 Fun-ASR
本地 Whisper（可选）
Python（本地 Whisper 推理 + 简繁转换）
```

没有使用 React、Vue 或其他前端框架，扩展加载后可以直接运行。

---

## 🛠️ 本地开发

```bash
# 跑全量回归
node ../bilidown-tests/run_all.js

# 跑快速子集（不需要 whisper_server）
node ../bilidown-tests/test_t2s_conversion.js \
  && node ../bilidown-tests/test_clear_tab_dom.js \
  && node ../bilidown-tests/test_switch_tab_scroll.js
```

`dev-clean.ps1` 在扩展目录运行一次可清理 Python 跑时生成的 `__pycache__/`（Chrome MV3 拒载双下划线开头的条目）。也可以 `powershell -NoProfile -ExecutionPolicy Bypass -File .\dev-clean.ps1` 手动调用。

详细测试说明见 `../bilidown-tests/`。

---

## ⚠️ 当前局限

- 主要适配普通 B 站视频页，番剧、直播、课堂等页面结构可能不同。
- 私密、付费、地区受限或需要额外权限的视频可能无法读取字幕或音轨。
- 配置百炼 API Key 后会默认走 ASR，需要等待音频下载、上传和识别。
- AI 提供商的免费额度、价格和可用性由对应平台决定。
- 视频站修改网页结构或内部接口后，扩展可能需要更新。
- 其他 Chromium 浏览器即使版本符合，也可能缺少 Side Panel API。

---

## 🔐 隐私

当前版本：

- 没有账号系统
- 没有自建中转服务器
- 没有埋点统计
- 不收集用户的视频观看记录
- API Key 保存在浏览器本地扩展存储
- 字幕分析时会将文本发送给配置的 AI 服务
- ASR 时会将视频音轨发送给阿里云百炼相关服务

详细说明见 `PRIVACY.md` 和 `SECURITY.md`。

**请不要提交包含真实 API Key 的 Issue、截图或代码。**

---

## 🤝 上游项目与二次开发说明

本项目基于：

> [zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest)

进行二次开发。

主要改造包括：

- 从 YouTube 页面适配为哔哩哔哩视频页面（当前主战场）
- 从 YouTube 视频识别改为 BV / 分 P / 合集识别（**cid 作为权威键**，避免多 P 视频错位）
- 重新实现 B 站操作栏按钮和播放器交互
- 使用 B 站主题的中文侧边栏和设置页
- 增加阿里云百炼 Fun-ASR 默认识别方案
- 原生字幕接口改为 `/x/player/wbi/v2`，并校验返回的 `bvid` 与 `cid`
- 增加视频状态隔离，避免切换视频后内容错乱
- 增加中文章节、全屏笔记和多格式导出
- 移除对 YouTube 和 Supadata 的运行依赖（B 站不适用）
- 切换页面不中断转录（chrome.alarms 保温 + 服务端缓存 + 看门狗恢复）
- 繁体 → 简体自动归一化（zhconv）
- 切 B 站 tab 时清空侧栏旧内容（避免用户看到上一个视频的章节）

**感谢原作者公开项目和核心产品思路**。

完整双版权记录见 [`NOTICE`](NOTICE)。

---

## 🏷️ 项目历史

| 版本 | 时间 | 项目名 | 关键节点 |
| --- | --- | --- | --- |
| 0.x | 2026-06 ~ 2026-08-22 | bilidown | 初始 B 站适配版本 |
| V1.0 | 2026-08-23 | **Suikan 随看** | **项目重命名 + 定位升级为通用学习视频助手 + 双版权 NOTICE + 中文 i18n + MIT license 与 LICENSE 对齐** |

完整 changelog 见 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 📄 License

本项目使用 [MIT License](LICENSE)。

你可以自由使用、修改、Fork、二次开发、部署和商业使用，但需要保留 MIT License 要求的版权和许可声明，并尊重上游项目的原始许可证。

---

## 💬 项目理念

Suikan 不想只做一个"把字幕复制出来"的工具。

它更希望把长视频变成真正可以继续使用的资料：

```text
能读        能搜        能跳转
能总结      能记笔记    能导出
```

配置百炼 API Key 后，以 Fun-ASR 结果作为主要文字来源；没有配置时，再使用经过视频身份校验的原生字幕。

> **不自动消耗额度，不混淆不同视频，也不让中文用户拿到一套莫名其妙的英文章节。**

---

## ⭐ 如果这个项目对你有帮助

欢迎 Star、Fork、提交 Issue 或 Pull Request。

遇到问题时，请提供浏览器版本、扩展版本、视频链接、是否有官方字幕、错误提示及可公开的控制台日志，并先删除 API Key、Cookie 和个人账号信息。
