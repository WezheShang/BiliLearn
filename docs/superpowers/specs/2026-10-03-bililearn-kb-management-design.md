# bililearn KB 管理功能 · 设计文档

- 日期：2026-10-03
- 状态：待用户审阅
- 范围：bililearn（bilidown）扩展 + whisper_server.py 本地服务
- 参考 KB：`C:\Users\shangweizhe\jin-kb\战国时代_姜汁汽水`（目录结构 / frontmatter schema 样例）

## 1. 背景与目标

bililearn 目前能把 B 站 / YouTube 视频变成可阅读、可保存的字幕资料，但资料散落在 BiliSubs 缓存里，无法按「知识库」组织，也没有增量维护机制。目标：

1. 字幕 tab 一键把当前视频字幕加入某个 KB（或现场新建 KB）。
2. KB 目录结构对齐现有 jin-kb 约定（Agent / Mavis 可直接消费），内容带完整元数据 schema。
3. 新内容入 KB 后，按该 KB 创建时选定的构建方法（karpathy LLM wiki / nvwa 心智模型 / raw 仅记录原始数据）处理：前两者由后台 LLM 增量更新知识库，raw 只落盘。
4. Settings 增加「KB 管理」模块：增删 KB、设置主目录、修改 KB 配置。

## 2. 已确认的关键决策

| # | 决策点 | 结论 | 备注 |
|---|--------|------|------|
| 1 | 文件写入机制 | whisper_server 加文件接口 | MV3 无法写 Downloads 以外路径；server 常驻（已有 autostart 方案） |
| 2 | 增量更新执行模型 | 磁盘队列 + 后台消费 | 队列文件落 KB 目录内，天然是 Agent 可读接口 |
| 3 | KB 列表来源 | **扫描主目录第一层子目录** | 磁盘即真相；无独立注册表；不去外部树（jin-kb 等）收编 |
| 4 | 平台范围 | B 站 + YouTube 都支持 | schema 字段统一（见 §4.2） |
| 5 | KB 粒度 | 一个 KB 可装多个 UP 主 | 条目级 speaker 独立记录，KB 级不校验 |
| 6 | 删除语义 | 默认解绑，可选删盘 | 解绑 = kb.json 标 archived + 下拉不再显示；目录默认保留 |
| 7 | KB 功能总开关 | Settings 内 master switch，**默认关闭**；开启时**强制选择 KB 主目录** | 选定目录后立即扫描子目录构建初始 KB 列表；未选目录前 KB 功能不可用 |
| 8 | 构建方法 | `karpathy` / `nvwa` / **`raw`** 三选一 | raw = 不构建知识库，只记录原始字幕数据，无 LLM 调用 |
| 9 | 更新频次 | `realtime` 实时 / `manual` 手动 / `daily` 每日凌晨 1 点 | 全局设置；daily 触发时浏览器未运行或 server 不在线 → 跳过本轮 |

## 3. 架构

```
UI 层        sidepanel 字幕tab「添加到KB」按钮 + 新建KB对话框 | options「KB管理」模块
扩展逻辑层   sidepanel.js：对话框与添加流程 | background.js：队列消费者（chrome.alarms 驱动）+ 云 LLM 调用
本地服务层   whisper_server.py 新增 /kb/* 文件端点（127.0.0.1:7860，路径沙箱）
```

- **KB 功能总开关**：新增 setting `kbEnabled`，默认 `false`。关闭时：字幕 tab 不渲染「添加到KB」按钮、background 清除全部消费 alarm、Settings 的 KB 管理模块收起为一行开关。**开启时强制进入主目录选择流程**（预填 BiliSubs 解析路径，「浏览…」调 `/kb/pick_root` 或手填绝对路径；server 校验存在/可写，不存在可选创建）→ 选定后立即扫描第一层子目录构建初始 KB 列表 → 注册消费 alarm。未完成目录选择前开关视为未生效。开关切换不影响磁盘数据。
- **KB 主目录**：setting `kbRootDir`，**无静默默认值**——开启总开关时必须显式设定一次（预填 BiliSubs 同路径仅作建议值）。设定后可改，改动后重新扫描。字幕缓存文件与 KB 子目录同层共存，互不冲突。
- **KB = 主目录下的第一层子目录**。每个子目录一个 KB，目录名即 KB 名（新建时清洗非法字符 `\/:*?"<>|` → `_`，重名追加 `-2`）。
- **chrome.storage.local 仅缓存**扫描结果（下拉秒开）；刷新时以磁盘为准，缓存与磁盘不一致以磁盘胜出。
- server 不在线时：按钮置灰、队列消费暂停、alarm 自动重试探测。

## 4. 数据设计

### 4.1 kb.json（每个 KB 目录根，插件配置 + Agent 消费入口）

```json
{
  "name": "宏观",
  "build_method": "karpathy",
  "default_speaker": "姜汁汽水",
  "created_at": "2026-10-03T13:00:00+08:00",
  "archived": false,
  "version": 1
}
```

- `build_method`: `karpathy` | `nvwa` | `raw`（不构建知识库，只落原始字幕数据，无 LLM 增量更新）。
- 主目录扫描发现的**无 kb.json 子目录**：同样出现在下拉列表（badge「未配置」）；首次向其添加内容时弹出构建方法三选一（karpathy / nvwa / raw）补建 kb.json。
- `archived: true` = 已解绑：下拉不显示、不参与扫描展示，磁盘目录原样保留。

### 4.2 字幕文档 schema（`videos/*.md` frontmatter）

统一字段，B 站 / YouTube 共用（YT channel = B 站 author，YT videoId = B 站 bvid）：

```yaml
---
speaker: 姜汁汽水              # 讲者显示名（新建 KB 时默认，条目级独立）
author: 战国时代_姜汁汽水       # B 站 UP 主名 / YT channel 名（同一字段）
platform: bilibili             # bilibili | youtube
bvid: BV1NdMx6gEo5             # B 站 BV 号 / YT videoId（同一字段）
cid: 123456                    # 仅 B 站多 P 视频有（分 P 标识）
date: 2026-07-07               # ★ 视频发布时间 pubdate（canonical 时间：文件名/排序/LLM 输入都用它）
added_at: 2026-10-03T13:05:00+08:00   # 采集时间（辅助字段）
lang: zh
topic: 7月宏观重点：黄金是否筑底？（2）
url: https://www.bilibili.com/video/BV1NdMx6gEo5
duration_s: 1354
---
（正文 = 字幕 tab 现行分段格式：`## 段 N [start → end]`）
```

- **去重键**：`bvid + cid`（YT 无 cid，用 bvid）。重复添加 → toast 提示既有版本的 date，跳过写入。
- **文件名**：`videos/<标题清洗>_<YYYYMMDD>.md`，日期取 pubdate；多 P 追加 `_P2`；标题超长截断 80 字符。
- **发布时间来源**：B 站 `pubdate`（videoDetails / view API），YT `publishDate`。拿不到时降级为当天并在 frontmatter 标注 `date_source: fallback_today`。

### 4.3 目录结构（按构建方法分叉）

```
<主目录>/<KB名>/
├── kb.json
├── README.md                  # KB 定位说明（LLM 生成维护；新建时由模板生成初版）
├── videos/*.md                # 字幕源文档（三种方法共用）
├── queue/                     # 增量更新队列（raw KB 不创建此目录，见 §6）
│   ├── pending/
│   ├── done/
│   └── failed/
└── (karpathy)  wiki/index.md + wiki/moc/*.md + wiki/_meta/build_log.md
└── (nvwa)      nvwa/心智模型.md + nvwa/案例集/*.md + nvwa/_meta/build_log.md
```

- **karpathy（LLM wiki）**：`wiki/index.md` 总索引 + `wiki/moc/*.md` 主题地图（Maps of Content），仿姜汁汽水 KB 的 wiki 结构。
- **nvwa（心智模型）**：`nvwa/心智模型.md` 核心思维框架 + 演化记录；`nvwa/案例集/*.md` 按主题沉淀案例。
- **raw（只记录原始数据）**：仅 `kb.json` + `README.md` + `videos/`，无 wiki/nvwa/queue 目录，零 LLM 调用；日后可在 Settings 改为 karpathy/nvwa，下次消费时基于已有 videos 清单从零生成初始 wiki/心智模型。

## 5. whisper_server 新端点（127.0.0.1:7860）

| 方法 | 路径 | 作用 | 参数 |
|------|------|------|------|
| GET | `/kb/list` | 列 KB | `root`（主目录）→ 第一层子目录数组：`{name, has_kb_json, archived, build_method, video_count, pending_count}` |
| POST | `/kb/pick_root` | 原生目录选择对话框 | server 端 tkinter 弹窗，返回所选绝对路径；取消返回 `null`。server 不在线时扩展侧降级为手填路径 |
| POST | `/kb/create` | 新建 KB | `{root, name, build_method, default_speaker}` → 建目录 + kb.json + 模板 README + 空子目录 |
| GET | `/kb/videos` | 列某 KB 的视频清单 | `root, kb` → 解析 `videos/*.md` frontmatter，返回 `[{bvid, cid, date, topic, file}]`（去重与列表展示共用） |
| POST | `/kb/write` | 写文件 | `{path, content}` |
| GET | `/kb/read` | 读文件 | `path` |
| POST | `/kb/delete` | 删除 | `{path, recursive}`（解绑走 kb.json 改写，不删目录） |
| POST | `/kb/move` | 改名/迁移 | `{from, to}` |

**沙箱规则（所有路径类端点强制）**：`os.path.realpath()` 解析后必须以配置的 KB 主目录为前缀，拒绝 `..` 越界与符号链接逃逸；无鉴权、仅 127.0.0.1（与现有 whisper 端点一致的本地信任模型）。

## 6. 添加流程与增量更新队列

### 6.1 添加流程（sidepanel）

```
点「添加到KB」→（选 KB 或新建）
  → ① 组装 md（frontmatter + 当前字幕正文）
  → ② 查重（GET /kb/videos 按 bvid+cid 比对）
  → ③ POST /kb/write 写 videos/*.md
  → ④（仅 karpathy / nvwa）POST /kb/write 写 queue/pending/<seq>_<bvid>.json（含视频元数据）；raw KB 无此步
  → ⑤ toast「已加入《KB名》，知识库后台更新中」/ raw KB「已加入《KB名》」
```

写入的内容版本 = **当前字幕 tab 加载/编辑后的版本**（官方字幕 / whisper 结果 / 用户编辑，哪个在面板里就存哪个）。转录进行中：按钮可点但 toast 提示「转录未完成，已保存当前已有字幕」。

### 6.2 队列消费者（background.js）

- **消费调度由全局更新频次 setting `kbUpdateMode` 驱动**（仅 `kbEnabled: true` 时生效；开关关闭清除全部 alarm，队列留在磁盘不动）：
  - `realtime`（默认）：30s 周期 alarm 扫描所有 KB 的 `queue/pending/`。
  - `manual`：不注册周期 alarm；Settings 的「立即更新」按钮触发一次性消费全部 pending。
  - `daily`：每日 01:00（本机时区）alarm 触发批量消费全部 pending。**触发时浏览器未运行或 server 不在线 → 本轮直接跳过**，pending 保留到下个窗口或手动触发，不补跑。
- **raw KB 永不消费**：无 queue 目录、无 pending 任务，扫描时跳过。
- 每条 pending：读新视频 md → 组装 LLM 输入 → 调已配置云 LLM（deepseek / minimax / glm，复用现有 provider 设置与密钥）→ 按 build_method 更新 `wiki/` 或 `nvwa/` → 移入 `queue/done/`。
- 失败重试 3 次（间隔递增），仍失败移 `queue/failed/`，Settings 里可见并可手动重试。
- **长字幕上下文策略**：不喂全文。输入 = frontmatter + 正文**确定性压缩采样**（每 50 段取首段 + 保留章节结构，不额外调 LLM）+ 当前 index/moc（或心智模型）全文 + README → LLM 输出增量 patch（新增/更新的 moc 条目、index diff）。
- **LLM 输出写回前校验**：必须是合法 markdown、不得删除已有 moc 文件（只增改），防 LLM 幻觉破坏 KB。
- 队列文件格式 JSON，字段自描述，Agent（Mavis）可直接消费同一队列做高质量重建——插件与 Agent 双通道共用磁盘协议。

## 7. UI 设计

### 7.1 字幕 tab：「📚 添加到 KB」split button

- **仅 `kbEnabled: true` 时渲染**；开关关闭时该按钮完全不出现（非置灰）。
- 主按钮 = 添加到**上次使用的 KB**；右侧下拉箭头展开：KB 列表（含「未配置」badge 项）+ 分隔线 +「+ 新建 KB…」。
- 状态反馈：成功（含 KB 名）/ 已存在（含既有版本日期）/ server 不在线（按钮置灰 + tooltip「需要本地 whisper server」）/ LLM 未配置（字幕照常入队，wiki 更新挂起并提示）。

### 7.2 新建 KB 对话框

| 字段 | 默认值 | 说明 |
|------|--------|------|
| KB 名 | 当前视频的 UP 主名（可改） | 即目录名，实时清洗非法字符并预览 |
| 构建方法 | karpathy | 三个 radio + 一句话说明：karpathy「LLM wiki：索引 + 主题地图」/ nvwa「心智模型：思维框架 + 案例集」/ raw「只记录原始数据，不构建知识库」 |
| 默认讲者名 | UP 主名（可改） | 写入条目 frontmatter 的 speaker |

保存 → `/kb/create` → 当前视频字幕立即走 §6.1 流程加入 → 入队。

### 7.3 Settings「KB 管理」模块

- **总开关**（模块首行）：`启用 KB 管理`，默认关。关闭时模块其余内容全部收起，只留这一行开关。**开启时强制进入主目录选择流程**（见 §3），未选定目录前开关不生效、模块停留在目录选择步骤。
- **主目录设置**：显示当前 `kbRootDir`，「浏览…」（`/kb/pick_root`）或手填可改；改动后重新扫描，列表变化需用户确认。
- **更新频次**：`每次新增实时更新`（默认）/ `手动更新` / `每日凌晨 1 点自动更新` 三选一；手动模式下显示「立即更新」按钮（一次性消费全部 pending 并显示进度）。
- **KB 列表**（每行）：名字 / 构建方法 badge / 相对路径 / 视频数 / 队列状态（pending N · failed N 红标）/ 操作按钮：
  - 改名：改 kb.json `name`；可选勾选「同步重命名物理目录」（走 `/kb/move`）。
  - 改保存目录：`/kb/move` 把 KB 迁到主目录下另一子目录（仅限主目录内，防越界）。
  - 改构建方法：下拉 karpathy / nvwa / raw 三选一。karpathy ↔ nvwa 只影响后续增量产物路径（已有产物保留）；**raw ↔ 构建方法互转**：转 raw 时已有 pending 由用户选择「丢弃或先消费完」；转出 raw 时下次消费基于已有 videos 清单从零生成初始 wiki/心智模型。
  - 删除：确认框默认**只解绑**（kb.json 标 archived，目录与内容原样保留，Agent 仍可读）；红字勾选框「同时删除磁盘目录」才调 `/kb/delete recursive`。
- **failed 队列**：逐条展示 + 「重试」按钮。

## 8. 失败路径

| 场景 | 行为 |
|------|------|
| server 不在线 | 按钮置灰；消费 alarm 探测恢复；已入队任务不丢（在磁盘） |
| LLM 未配置/配额耗尽 | 字幕照常落盘入队；更新挂起，Settings 与 toast 提示 |
| 写失败（权限/占用） | toast 报错，不入队 |
| pubdate 拿不到 | date 降级为当天 + `date_source: fallback_today` 标注 |
| storage 缓存与磁盘不一致 | 以磁盘扫描为准 |
| LLM 输出非法/幻觉 | 拒绝写回，任务重试，3 次失败进 failed |
| 删除后目录被外部修改 | 扫描时静默跳过不可读项，Settings 显示异常 badge |
| daily 01:00 触发时浏览器未运行 / server 不在线 | 本轮跳过，pending 保留，不补跑（次日窗口或手动触发） |
| 强制选目录时 server 不在线 | 只能手填绝对路径；目录校验推迟到 server 恢复后首次扫描 |

## 9. 测试与验收

- **测试基建**：沿用现有模式——node 直跑脚本（`node tests/xxx.test.js` + jsdom），server 侧 python unittest / 直跑脚本。
- **单测**：frontmatter 生成（B 站/YT/缺 pubdate 三态）、文件名清洗与截断、去重键、路径沙箱（越界/符号链接拒绝）。
- **手动 e2e 验收**：开启开关（验证强制选目录流程）→ 新建 KB → 连加 3 个视频（含 1 个重复、1 个 YT）→ 验证：目录结构 / frontmatter / 去重 / 队列消费 / wiki 或心智模型产出 / Settings 解绑与删盘语义全部符合本文档；另建 1 个 raw KB 验证只落盘零 LLM 调用；更新频次三档各切换一次验证消费行为（realtime 自动消费 / manual 点按钮才消费 / daily 01:00 批量消费）。

## 10. 范围外（本期不做）

- 不扫描/收编主目录以外（如 jin-kb）的既有 KB 目录。
- 不在插件内做 KB 全文检索/问答（KB 的消费者是 Agent）。
- 不实现 nvwa/karpathy 的全量重建（只做增量；全量重建留给 Agent 侧 skill）。
- 不改现有字幕抓取/转录/导出链路。
