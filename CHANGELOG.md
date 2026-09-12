# Changelog

bililearn 的所有可记录改动。按"用户能感知到的影响"维度写，不按 commit 维度。

## Unreleased

### 2026-08-22（夜）：CID 成为字幕查找的权威键

**用户观察**："查找字幕应该优先 CID，不会重复。"——在 B 站里一个 bvid 下的多 P 视频共享标题、UP、日期，所以 `{date}_{title}_{UP}` 文件名和 bvid grep 在多 P 视频下会互相拿错分P的字幕。

**修复**：

- `loadLocalSubtitleFile(bvid, videoTitle, channelName, pubDate, settings, cid)` 增加 `cid` 参数，调用方 (`handleFetchTranscript`) 传入 `page.cid`
- `/local-file` 服务端新增 `cid` 查询参数；.json 命中需 doc 内 `bcid+cid` 双匹配（`bvid` 不命中或 `cid` 不命中 → 跳过该 .json，不再回退到 bvid-only）；text 格式（.md/.txt/.srt）保持 bvid-header 旧行为
- `/cache` GET 在文件名解析失败时（标题清洗 JS/Python 漂移会触发）改用 `bvid+cid` 全目录扫描兜底，watchdog 恢复链路不再依赖标题
- `_handle_cache_get` 标题拼出的文件必须 doc 内 `bcid+cid` 双匹配才认账，多 P 标题撞车不会误返另一分P内容

**回归测试**：`test_server_cache_write.js` 新增两节（标题漂移仍命中 / 多 P cid 精确选 part / 错 cid 拒绝），全量 `run_all.js` 8/8 PASS。

改动文件：`background.js` (+27) / `whisper_server.py` (+52)

### 2026-08-22（晚）：切页面 / 开关 sidebar 不再切断 Whisper 转录

**根因**：转录的 HTTP POST 跑在扩展 Service Worker 里。MV3 的 SW 空闲 ~30 秒就被 Chrome 回收；切到别的页面时 `updatePanelForTab` 对非 B 站 tab 调 `setOptions({enabled:false})` 关掉面板，消息流量随之中断，SW 很快被杀，长 POST 被掐断。旧的 `bootstrapWhisperJob` 明确不恢复中断任务，用户切回来只能从头再来。

**修复：三层防线**

1. **保活（防死）**：非终态 whisper job 存在期间，`chrome.alarms` 每 30 秒唤醒一次 SW（`WHISPER_KEEPALIVE_ALARM`）——切页面、关 sidebar 都不再触发 SW 回收
2. **服务端落地（防丢）**：`/transcribe` 原始音频模式新增 `X-Bvid/X-Cid/X-Title/X-Channel/X-Pubdate/X-Cache-Dir` 头；服务端转写完成**立即**把结果写进字幕缓存（与扩展自己写的缓存同形状、同 `{date}_{title}_{UP}.json` 命名）——即使客户端彻底死了，结果也在磁盘上
3. **看门狗恢复（防卡）**：alarm tick 检查非终态 job——pipeline 还活着仅保温；SW 死过则用 job 里持久化的 `recoveryMeta` 轮询 `/cache`，命中即标记成功并广播带 videoId 的完成消息，sidepanel 收到后自动 ack + 渲染字幕；超 30 分钟未恢复判 FAILED 提示手动重试

**配套修复**：

- 同一时间只允许一个非终态转写任务（同视频→提示已在跑；异视频→中文报错"同一时间只能跑一个"，避免 CPU int8 并行互相拖慢）
- 转录进度广播带 `videoId`，面板按视频过滤，不再串台；完成广播由面板自行消费，不依赖当初触发它的页面还在
- `showWhisperPrompt` 先查进行中任务再弹提示，避免切回页面重复弹"点 Whisper 转录"
- "请保持视频页面打开"文案改为"转录在后台进行，可随意切换页面"（云端路径同步）

**已知局限**：若 SW 死在音轨下载阶段（转写 POST 尚未发出），该次无法恢复，等 30 分钟超时后手动重试。恢复能力依赖转写请求已到达服务端。

**用户操作**：manifest 新增了 `"alarms"` 权限——**必须 reload 扩展一次**才生效。

**回归测试**：新增 `test_server_cache_write.js`（TTS 合成真实语音 → 验证服务端缓存落盘 + `/cache` 恢复路径 + 负例 404；朗读文本带随机编号防 LRU 撞缓存）。套件现 8 个文件，`node C:\Users\username\bililearn-tests\run_all.js` 全绿。

### 2026-08-22：两个紧急 bug 修复 + 回归测试套件

**1. 「识别到字幕但面板空白」——缓存投毒自愈（BV1H88n6ME5w）**

- 根因：旧版本把 `{from,to,content}` 原始形状的 segments 存进了 `chrome.storage.local` 缓存；渲染层每段都跳过 → 空列表。更糟的是缓存命中后永远不再重新拉取，视频永远打不开
- 修复：`loadFromCache` 检测到无可用文本的缓存条目直接视为未缓存（下次打开重新拉取并覆盖）；`saveToCache` 拒绝写入不可用的 transcript，投毒不可能再发生
- 用户操作：reload 扩展后重新打开该视频即可，旧投毒缓存会被自动拒绝

**2. 新视频转写失败——并发转写去重（BV12Jg96sE6c）**

- 根因：同一音频被并发 POST `/transcribe` 三次（15:50:37 / 15:50:53 / 15:56:48），CPU int8 三路互相拖慢，几分钟内无一完成，未完成也不写缓存
- 修复：whisper_server 按 sha256(音频) 去重——并发的相同请求共享同一次转写结果（`reused: true`）；客户端 `alreadyRunning` 防重入 + sidepanel 挂接到进行中任务的进度 UI，不再重复触发
- 顺带修复：regenerate 按钮原代码先把 `currentVideoId` 置 null 再传给 `startBililearn`

**3. Whisper 缓存文件命名统一**

- .json 缓存文件从 `{bvid}_{cid}.json` 改为 `{pubDate}_{title}_{UP}.json`（与 .md/.txt/.srt 一致），缺 metadata 时 fallback `{bvid}_{cid}.json`
- `/local-file` 与 `parseLocalSubtitleContent` 现在能直接读 .json 和 .md 格式缓存

**4. 回归测试套件**

- 位置：`bililearn-tests/`（扩展目录外，Chrome 不扫描，避开 `_` 前缀保留字规则）
- 一键全跑：`node C:\Users\username\bililearn-tests\run_all.js`（7 个文件，全绿 exit 0；依赖 whisper_server 在 7860 端口）

改动文件：`background.js` (+262) / `sidepanel.js` (+347) / `settings.js` (+42) / `whisper_server.py` (+164)

### 本地 Whisper 转录：多阶段进度 + 状态持久化

> **状态：代码已就绪，未在真 Chrome 端到端验证。** 单元测试 (`tests/whisper-progress.e2e.test.js`) 8/8 PASS，但只覆盖了 message bus 契约，没有覆盖真实的 `chrome.storage.session` 时序、`chrome.runtime.sendMessage` 在真实 service worker 里的 resolve 行为、CDN 重试的真实 HTTP 表现。真机验证步骤见末尾"未验证项"。

#### 改了什么

**1. 多阶段进度 UI**

用户点 "🎙️ 用 Whisper 转录" 后，loading 页面会显示当前正在做的事，而不是一行 "启动 Whisper 转录" 撑 5 分钟。

| 阶段 | 文案 | 触发时机 |
|------|------|----------|
| `downloading` | "正在下载B站音轨" / "低码率音轨约 N MB" | 调用 `fetchBilibiliAudioBlob` 时（拿到 content-length 后再发，避免重试期间刷屏） |
| `ready_to_transcribe` | "音频下载完成，准备调用 Whisper" + "模型 base · URL" | 音轨 blob 拿到后、POST 到 whisper server 前 |
| `transcribing` | "Whisper 转录中" + "长视频通常需要几分钟" | POST `/transcribe` 期间（whisper server 当前不支持流式 progress，所以是固定文案） |
| `correcting` | "AI 校正专有名词中" + "识别出 N 段字幕" | 调 AI provider 修同音字 + 章节标记时 |

实现：background.js 的 `sendWhisperProgress(stage, title, subtitle)` 同时 (a) 广播 `chrome.runtime.sendMessage({action: "transcriptProgress", stage, ...})` 到 sidepanel，(b) 更新持久化 job 记录（见下）。

**2. 状态持久化（关掉 sidepanel 也不丢进度）**

之前 sidepanel 关闭或 Chrome 把 service worker 杀掉后，正在跑的 whisper job 状态全丢——用户回来只看到 "本地没有缓存这个视频的字幕" error 页面，得从头开始。现在：

- 用 `chrome.storage.session["whisper-job"]` 存当前 job
- SW 启动时 `bootstrapWhisperJob()` 把内存 mirror 从 storage 拉回来（不重跑——避免浪费 5+ 分钟）
- sidepanel 启动时 `maybeResumeWhisperJob()` 查 `getWhisperJobStatus`，如果还在跑就直接 `showState("loading")` + 用持久化的 stage 文案显示
- 终态（`succeeded` / `failed`）由 sidepanel 发 `ackWhisperJobDone` 清掉，避免下次访问看到残留

**3. B 站 CDN 重试（部分缓解 `ERR_CONNECTION_CLOSED`）**

`data.bilibili.com/v2...` 经常单次返回 `ERR_CONNECTION_CLOSED`（CDN chunk 不稳定），原本一次失败就把整个 job 抛掉。现在 `fetchBilibiliAudioBlob` 每个候选 URL 最多重试 4 次（延迟 0 / 1s / 2s / 4s），重试全失败才 fallback 到下一个 `backupUrl`，4 个 candidate 全失败才 throw。

> **诚实声明：这是缓解，不是修复。** CDN 不稳定是 B 站那边的事，我不能改它的服务器。如果 4 次重试 + 4 个 candidate 全失败（极少见但可能），loading 页面会卡约 7 秒然后弹 error，用户可以再点一次按钮重试（job 记录会从 storage 读出来，不会从零开始）。

#### 改动文件

- `background.js` (+~145 行)：whisper-job 持久化层、4 阶段 progress 注入、CDN 重试、新增 `getWhisperJobStatus` / `ackWhisperJobDone` 消息、SW 启动 bootstrap
- `sidepanel.js` (+~75 行)：`maybeResumeWhisperJob()`、transcriptProgress handler 读 stage 字段、终态 ack
- `tests/whisper-progress.e2e.test.js` (新建)：JSDOM headless 4 场景 / 8 assertion
- `package.json` + `package-lock.json` (新建)：jsdom dev dep for tests

#### 跑测试

```powershell
cd C:\Users\username\bililearn
node tests/whisper-progress.e2e.test.js
```

预期：`========== 8/8 checks passed ==========`

#### 未验证项（需要你在真 Chrome 里跑一次）

1. **Resume 流程**：打开无字幕视频 → 点 Whisper → **立即关掉 sidepanel** → 重新打开 sidepanel → 应该直接看到 loading 页面（不是 error），文案是最后阶段
2. **4 阶段文案更新**：从下载到 AI 校正，每阶段文案应该平滑切换
3. **CDN 重试触发**：DevTools Network 过滤 `bilivideo.com`，手动 throttle 让 1-2 个请求失败，看是否真的重试而不是直接报 `B站音轨下载失败`
4. **终态清理**：转录完成后 `chrome.storage.session.get("whisper-job")` 应该是 undefined（如果还有残留说明 ack 没发，下次启动会以为还在跑）
5. **DEV 警告**：观察 `chrome.runtime.lastError`，service worker 不会因为 sidepanel 关闭就报 `Receiving end does not exist`（已用 `.catch(() => {})` 兜底，但要肉眼确认）

如果真机跑出问题，截图发我看，告诉我哪一步。

#### 已知小问题（不影响功能但待清）

- `tests/_debug_disabled.js` 残留：开发时 debug 用的临时脚本，重命名后没删。Windows mavis-trash 在当前环境不可用，需要你手动 `del tests\_debug_disabled.js`
- 已下线的云端 ASR 路径曾用旧的 `chrome.runtime.sendMessage({action: "transcriptProgress"})` 直发，没走 `sendWhisperProgress()` 持久化层——这条路径通常 < 1 分钟，不需要 resume，所以不强制改造

---
