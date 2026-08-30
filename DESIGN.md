# bilidown 侧边面板设计原则（DESIGN.md）

> 2026-08-30 定稿。来源：用户对概览/总结失败态的反馈——「AI model 不能用，应该都是
> failure，不应该下面还在提取。应该直接出现那个标准错误页面。」
> 本文档是 UI 迭代的 single source of truth：改侧边面板 / options 页视觉前先读这里，
> 新增状态页时按这里的规格执行，测试（test_wizard_clean_page.js Part F/G）会守护关键规则。

## 1. 设计语言总则（hero 风）

- **居中 hero 布局**：空态 / 引导态 / 错误态一律整面板居中（flex column + align-items
  center + justify-content center），大留白（上下 30px+），不是卡片套卡片。
- **无框**：hero 页不套卡片框、不画分隔线、不加背景色块。页面本身就是容器。
  参照实现：`.error-container`（无字幕引导页）、`.wizard`（AI key / ASR / Whisper 向导）、
  `.error-hero-page`（整页错误）。
- **静态扁平，悬停浮起**：直接坐在面板背景上的列表项（`.chapter-item` / `.quote-item`）
  静态不带投影（`box-shadow: none`），hover 才出 `--shadow-sm` + 轻微上移。卡片不叠卡片，
  避免灰底上再垫白卡的层叠感。
- **主色粉**（B 站系）：`--accent: #fb7299`。强调元素（按钮、图标、进度、选中态）统一用它，
  不引入第二种彩色。

## 2. 标准错误页（整页规格）

**适用**：一个面板的核心功能失败时（概览分析失败 / 总结失败 / 无字幕引导）。不是局部的
一条错误消息，而是**整个面板变成错误页**。

**规格**（对应实现 `.error-hero-page` + `.error-hero-*`，sidepanel.css）：

1. 3D 感图标（`&#9888;` 喇叭/警示类，`--accent` 色）在最上方。
2. 深色大标题（display 字体、600）：「分析失败」/「总结失败」——中文短语，说明哪个功能挂了。
3. 灰色说明段（`--text-secondary`，12.5px，居中，最大宽 280px）：**原始错误信息原样保留**，
   错误码（如 `INVALID_AI_KEY`）不改写、不翻译、不隐藏。
4. 粉胶囊发光按钮「重试」（`--accent` 实底、`--r-pill` 圆角、
   `box-shadow: 0 4px 14px rgba(251, 114, 153, 0.26)`）。
5. 居中、无卡片框、大留白、浅灰底。

**实现契约**（sidepanel.js）：

- `showPanelError(panelName, message, retryFn)`：清空该面板内容容器 → 隐藏面板全部
  `:scope > .section` → 显示错误页 → 「重试」先复位（隐藏错误页 + 恢复 sections）再调
  `retryFn`。
- `hidePanelError(panelName)`：只隐藏错误页，不动 sections（由渲染内容方恢复）。
- 失败路径一律走 `showPanelError`；禁止再往单个容器里塞区块级错误块。

## 3. 状态诚实原则

- **失败后不得残留 loading 占位**：「正在提取关键观点…」「正在生成章节…」这类占位在请求
  结束（无论成败）后必须消失。失败 = 整页标准错误页，不允许出现「一个区块报错 + 另一个
  区块永远转圈」的组合。
- **AI 不可用 = 整页**：AI 模型不可用（无 key / key 失效）时，概览和总结 tab 要么显示
  AI key 向导（可修复的配置态），要么显示整页标准错误页（请求失败态）。不允许半可用视觉。
- **新加载不得叠在旧错误上**：`triggerAnalysis` / `triggerSummary` 开头先
  `hidePanelError(...)`，避免上一支视频的错误页挡住新视频的加载指示。
- **过渡态必须真实可见**（2026-08-30）：loading 占位（「正在根据完整字幕整理笔记…」
  「正在生成章节…」）必须落在**可见的 section** 里。`showPanelError` 会隐藏面板
  sections，而懒加载路径（切 tab 触发）不像「重试」按钮那样自带恢复——所以 trigger
  在 `hidePanelError(...)` 之后必须紧跟 `restoreLlmSections()`；顺序不能反（restore
  是错误页感知的，先藏错误页再恢复）。违反后果：loading 写进被藏掉的 section，
  页面全程空白、结果「突然出现」（2026-08-30 用户报告）。
- **切视频清旧错误页**（2026-08-30）：`startBilidown` 在视频变化时对两个 LLM 面板
  `hidePanelError(...)`——下一支视频可能命中缓存（`currentSummary` 已设、懒加载不再
  触发、没人复位面板），缓存内容不能躲在上一支视频的错误页后面；随后
  `updateAiKeyWizard(当前tab)` 重放向导状态（key 仍缺失时向导优先，sections 保持隐藏）。
- **长生成必须流式**（2026-08-30）：AI 请求一律带 `stream: true` 并逐 chunk 消费——每个
  SSE 增量都重置空闲看门狗。非流式请求在模型生成完毕前**一个字节都不回来**，思考型模型
  （glm-4.6 先 reasoning 再写）+ 长视频字幕的静默期轻易超过 50 秒，被自己的看门狗判死
  （用户报告：「inactive for 50 seconds」）。SSE 分支按 `content-type: text/event-stream`
  判定；非 SSE 响应（错误体 / 忽略 stream 的 provider / 测试桩）走原有 bounded JSON 路径。
  硬上限随之放宽到 600 秒——它现在只兜真正失控的请求，不再惩罚正常的慢生成。
- **空态文案说清「什么时候会有内容」**：「生成 AI 总结后，章节会显示在这里」，而不是干巴巴
  的「暂无数据」。

## 4. 按钮语言

- **主按钮**：粉实底胶囊 + 粉色发光（`box-shadow: 0 4px 14px rgba(251, 114, 153, .26)`），
  白字。每屏最多一个。范例：wizard 的「去设置」、错误页的「重试」。
- **次级按钮**：粉幽灵胶囊——透明底、`1px solid rgba(251, 114, 153, 0.45)` 边、
  `--accent` 文字，hover 变实粉白字。范例：`.action-btn` / `.enhance-btn` /
  `.export-format` / `.note-action-btn` / `.quote-copy-btn` / `.quote-save-note-btn`。
- **激活态**：`--accent-dim` 背景。范例：`.transcript-mode-btn.active`。
- 不用灰色实底按钮、不用直角按钮、不加图标堆砌。

## 5. 颜色与 token（:root，sidepanel.css）

| token | 值 | 用途 |
| --- | --- | --- |
| `--accent` | `#fb7299` | 主色：按钮、图标、选中态、强调线 |
| `--accent-hover` | hover 加深 | 主按钮 hover |
| `--accent-dim` | 低饱和粉 | 激活态背景 |
| `--r-pill` | `999px` | 胶囊圆角（按钮统一形态） |
| `--shadow-sm` / `--shadow-md` | 阴影 | 仅 hover / 浮层用，静态列表项不用 |
| `--text` / `--text-secondary` / `--text-muted` | 文本三档 | 标题 / 说明 / 占位 |

## 6. 修改守则

- 改视觉前先跑 `bilidown-tests\test_wizard_clean_page.js`（Part E/F 守护 hero 风与错误页
  契约）；改完跑全量 `run_all.js`。
- 新增面板状态时：先问「这是空态 / 引导态 / 错误态 / 内容态哪一种」，再套对应规格，不自创
  形态。
- 错误文案：中文标题 + 原始错误串，不吞错误码（见 §2.3）。
