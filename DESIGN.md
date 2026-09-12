# bililearn 设计风格规范

> 适用范围：bililearn Chrome 扩展 options 页 + 任何后续要做 / 复用的产品。
> 最后更新：2026-09-02（v1）

---

## 1. 颜色 Token

CSS 变量统一在 `options.css` 顶部声明，跨产品沿用同一份。

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#f6f7f8` | 页面背景 |
| `--surface` | `#ffffff` | 卡片 / 弹窗背景 |
| `--text` | `#18191c` | 主要正文 |
| `--text-secondary` | `#5b6068` | 次要文字 |
| `--muted` | `#7a7f87` | 辅助 / 状态文字 |
| `--border` | `#e3e5e7` | 浅灰边框（默认按钮 / 卡片描边） |
| `--accent` | `#fb7299` | **品牌粉**（B 站粉红）—— hover / 强调边 |
| `--accent-hover` | `#ff5f8f` | 品牌粉的 hover 加深色 |
| `--danger` | `#9f2d2d` | 危险文字（保留按钮的「红字」感） |

**派生语义色**（按需，不要新造名字）：

| 用途 | 颜色 |
|---|---|
| 成功绿 | `#1ba954`（带 `.muted-scheme` 处理后） |
| 警告橙 | `#d98a00` |
| 错误红（粗） | `#e02525` |
| 信息蓝 | `#00aeec` |

---

## 2. 字体

- 全栈系统字体栈，**不嵌入网络字体**：
  ```css
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  ```
- 标题：`font-weight: 700`（中英文一致）
- 正文：`font-weight: 400`
- 按钮 / 复选框文字：`font-weight: 700`（永远加粗，与正文拉开层级）
- 等宽（code / 路径 / 副 ID）：`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

---

## 3. 圆角

- **胶囊按钮**：`border-radius: 999px`（这是页面绝大多数按钮的形状）
- **小卡片 / 标签**：`border-radius: 6px`
- **大卡片**：`border-radius: 12px`（settings card）
- **永远不要**用 0 圆角——会显得像控制台系统控件

---

## 4. 间距

- 卡片之间垂直：`16px`（不要更小，会显得挤）
- 卡片内 padding：`18px` 左右
- 标签 ↔ 控件：`8px`
- help 文字距上方控件：`8px`

---

## 5. 按钮

**所有非主操作按钮统一三态**（粉红 hover + 灰边白底）。其他产品沿用同一份规则。

### 5.1 普通按钮 `.secondary`
- 默认：白底 + 浅灰边（`#fff` / `var(--border)`）+ 黑色加粗字
- Hover：白底 + **粉红边**（`var(--accent)`）+ 黑字（背景不变）
- Active / Focus：粉红边加深 1px 或 outline 1px
- 形状：胶囊（`border-radius: 999px`）+ `padding: 10px 15px`
- 字号 / 字重：继承 + `font-weight: 700`

```css
button.secondary { background:#fff; border-color: var(--border); }
button.secondary:hover { background:#fff; border-color: var(--accent); }
```

### 5.2 主操作按钮 `.primary`
- **整个页面只用一个**（典型 = 表单底部的「保存设置」）
- 默认：实色粉红（`var(--accent)`）+ 白字
- Hover：实色加深（`var(--accent-hover)`）
- 形状：胶囊
- 不能在 section 中混用——其他 section 的按钮都是 `.secondary` / `.danger`

```css
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.primary:hover { background: var(--accent-hover); }
```

### 5.3 危险按钮 `.danger`
- 用于**不可逆 / 易误点的操作**（清空笔记、重置数据、删除）
- 默认：白底 + 浅灰边 + **红色字**（`var(--danger)`）
- Hover：白底 + **粉红边**（与 secondary 相同，不让危险按钮在 hover 时跳出来）
- 形状：胶囊
- 文字仍 `font-weight: 700`

```css
button.danger { background:#fff; border-color: var(--border); color: var(--danger); }
button.danger:hover { background:#fff; border-color: var(--accent); }
```

> 原则：危险按钮的「危险感」**只在文字颜色**——不允许用红边 + 红字 + 浅红底这种
> 组合，会跟「未保存修改」的红 banner 视觉撞色。

### 5.4 绝对不要出现的样式
- 实色红按钮（`background: var(--danger)` + 白字）—— 跟「错误」语义绑死
- 渐变按钮
- 带 emoji 前缀的按钮（emoji 留给「卡片标题 / 状态行」用，不进按钮）
- 文字按钮（无背景无边框）—— 跟链接混淆

---

## 6. 折叠块（collapsible）

**所有「不常用 / 配置完成后可以收起」的高级块都用浏览器原生 `<details>`**，不用 JS 写折叠状态。

### 6.1 适用块
- 本地环境准备（setup panel，4 个 step + 检查系统按钮）
- 任何「设置完成后很久才回来一次」的 section

### 6.2 不适用块 / 已删除块
- 通知 section（只有 2 个 checkbox + 1 行说明——折叠反而是负担）
- 通知 section 当前永远展开
- **2026-09-04 反例**：「开机自启 Whisper server」块（原本是 §6.1 里的折叠块候选）
  已从 `options.html` **整体删除**——不再用折叠收起来，而是直接没有这页 UI。
  原因：用户已通过 `setup_whisper_autostart_system.ps1` + `manage_whisper_server.bat` 完成默认安装，
  设置页里只展示「状态 + 复制安装/卸载命令」对用户无意义（装好就装好了）。
  这个规则升级为：**「不常配置」≠「必须留着 UI」**——如果默认就能跑通，UI 块就删掉，不要为了"完整性"硬留在页面上。

### 6.3 实现模板
```html
<details class="collapsible-block" data-default-collapsed="true">
  <summary>
    <span class="summary-title">标题</span>
    <span class="summary-hint">一句话说明这玩意是干什么的</span>
  </summary>
  <div class="collapsible-body">
    <!-- 内容 -->
  </div>
</details>
```

```css
.collapsible-block > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  /* Plain text on the page background — NO extra border, NO background
     fill, NO rounded box. */
}
.collapsible-block > summary::-webkit-details-marker { display: none; }
.collapsible-block > summary::before {
  content: "▸";
  display: inline-block;
  margin-right: 6px;
  flex: 0 0 auto;
  transition: transform 120ms ease;
}
.collapsible-block[open] > summary::before { transform: rotate(90deg); }
.collapsible-block > summary > .summary-hint {
  margin-left: 10px;
  color: var(--muted);
  font-weight: 400;
  font-size: 0.92em;
}
```

**折叠块的 summary 必须有「标题 + 副标题」两段**（标题加粗，副标题灰色细字）：
- 标题 = 这块叫什么（autostart → "开机自启（SYSTEM 账户，隐藏窗口）"）
- 副标题 = 这块**干什么用的**（"让 whisper server 在每次 Windows 开机时自动启动"）
- 没有副标题，折叠时只看到标题，**用户不知道这玩意有什么用**（2026-09-04 反馈）

### 6.4 折叠块的「外层 wrapper」必须是透明的
- `<details>` 外面如果再包一层 `<div>` 充当 wrapper（用来挂其他 class、加 margin 等），
  **wrapper 自身不能加 border / background / padding / border-radius**
- 只允许 wrapper 提供 `margin: 上下间距`，所有视觉样式集中在 `<details>` + `<summary>` 自身
- 否则两个 `<details>` 块（一个用 wrapper、一个不用）会出现**一个有框一个没框**的
  视觉不一致（实测场景：本地环境准备用了 `.setup-panel` wrapper，开机自启没包，
  2026-09-02 用户反馈两个折叠块看起来不一样）
- 反例 `.setup-panel { padding: 14px 16px; border: 1px solid ...; background: ...; }`
  —— 修法：只留 `margin`

---

## 7. 卡片

```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
}
```

- 卡片内 h2：不需要再加边框 / 底色——`margin-top: 0` 即可
- 卡片之间永远用 `margin-bottom: 16px`，不要 `gap`（IE/Edge legacy 兼容）
- **卡片内部永远是扁平的**——不要在 card 里再嵌 `<fieldset>` 加边框
  - 如果语义上需要分组（form 关联 / accessibility），用 `<fieldset>` 但 CSS 强制
    `border: 0; padding: 0;`，让 legend 当成普通小标题渲染
  - 嵌套边框 / 嵌套背景会让一个 section 看起来比相邻 section 更「深」，
    视觉深度不一致 = 风格不一致
- 卡片不要套卡片

---

## 8. 输入控件

### 8.1 text / textarea
- `border: 1px solid var(--border)`
- `border-radius: 6px`（不是胶囊）
- `padding: 11px 12px`
- 焦点态：`border-color: var(--accent)` + `outline: none`（用 border 表达焦点）

### 8.2 select
- 同 text，但 `appearance: none` + 自绘 `▾` 箭头：
  ```css
  background: #fff url("data:image/svg+xml,...") no-repeat right 12px center;
  padding-right: 32px;
  ```

### 8.3 checkbox
- 自绘样式：14×14，`border-radius: 3px`
- 选中：粉红底 + 白勾（用 CSS `::after` 画勾，不用图片）

---

## 9. i18n 双语

- 任何用户可见文案都走 `data-i18n` 属性
- 英文 / 中文两份必须在同一文件定义（en 块 + zh 块）
- 翻译键用语义化英文命名（`notifyOnTranscribeLabel`），不要用 `label1` / `btn1`
- 翻译表在 `options.js` 顶部 `translate()` 函数

---

## 10. 暗色模式（TODO / 未实现）

预留 CSS 变量结构，未来通过 `prefers-color-scheme: dark` 自动切换：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1014;
    --surface: #1a1b1f;
    --text: #e8e9eb;
    --text-secondary: #aab0b8;
    --muted: #6f747c;
    --border: #2a2c30;
    /* accent 保持不变（品牌粉在暗底下也亮） */
  }
}
```

---

## 11. 反馈 / 状态文字

- 操作成功：「✓ …」（绿勾 + 简短中文）
- 操作失败：「✗ …」（红叉）
- 操作中：「… 中」（省略号结尾）
- 状态行（`#saveStatus` / `#copyStatus`）：`color: var(--muted)` + `font-size: 13px`，不要大字号

---

## 12. 复盘 / 教训（2026-09-02）

1. **折叠时**别留 `.help` 文字当「副标题」——用户会以为那行就是 section 的全部内容。
   折叠态要彻底藏非 h2 内容。
2. **危险按钮的 hover 跟普通按钮一致**——红字已经表达危险，hover 再跳出来反而
   抢了真正主操作（保存按钮）的视觉权重。
3. **`primary` 按钮全页只一个**——多 primary 等于无 primary（视觉锚点失效）。
4. **统一规则进 DESIGN.md**，而不是每次口头说——这样新加按钮时不会又冒出第三种风格。

---

## 13. Sidepanel 状态诚实原则（2026-08-30）

> 用户原话：「AI model 不能用，应该都是 failure，不应该下面还在提取。
> 应该直接出现那个标准错误页面。」+「把这个写到设计的 principal 里面」

### 13.1 标准错误页接管整个 tab
- 任何 LLM 请求失败（summary / overview / 校正） → 整个 tab 切到**标准错误页**
  - 隐藏所有 section（chapters / summary body / loading placeholder / toolbar）
  - 居中显示：失败原因 + 重试按钮（保留可恢复性）
- 不允许「上面红 banner 错误，下面的章节区还在 loading」这种半截状态

### 13.2 状态诚实
- UI 任何时刻**只能展示**与当前真实状态一致的内容
- 失败的请求 → 删掉它留下的所有 loading 占位（「正在提取…」「正在总结…」）
  - 残留下来的占位会被用户当成「还在跑」——比报错还误导
  - 规则：失败后**不留任何**残留 loading 占位

### 13.3 过渡态必须真实可见
- 加载中 → 显示「正在 XX…」（明示在跑）
- 加载成功 → 内容
- 加载失败 → 立即清掉 loading 字样 + 切标准错误页

### 13.4 切视频清旧错误页
- 用户切换视频（`startBililearn` 检测到 videoId 变化）时：
  - 清掉所有 `hidePanelError(...)` 标记
  - 不让上一个视频的「失败状态」污染新视频的初次加载
  - cached content 路径也必须显式 hidePanelError 后再渲染

---

## 14. 检查清单（新页面交付前）

- [ ] 所有非主操作按钮是 `.secondary`（白底浅灰边）
- [ ] 危险操作（删除/重置/清空）是 `.danger`（白底浅灰边+红字）
- [ ] 全页只有一个 `.primary`（dialog 内的 Keep / Cancel 例外）
- [ ] 高级块用 `<details>` 折叠
- [ ] 通知 / 概览 / 总结用「单 toggle 一起开关」模式
- [ ] 所有用户可见文案在 en + zh 块都有对应 key
- [ ] sidepanel 失败请求会切到标准错误页（不留 loading 占位）
- [ ] 切视频会清掉旧 tab 的标准错误页标记
- [ ] 跑全量回归 24/24 +0 fail
