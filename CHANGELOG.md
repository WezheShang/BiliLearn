# Changelog

bililearn 的所有可记录改动。按"用户能感知到的影响"维度写，不按 commit 维度。

## Unreleased

### 2026-11-06（第五轮）：「明明有字幕却逼我用 Whisper」「45 秒才出按钮」「Whisper 500」「转圈 3 秒」—— 四条用户可见的链路修复

这一轮修的全是**用户能直接感知**的东西，根因分四层，每层都有真机实测数据。

#### ① B 站明明有官方字幕，却硬把用户推到 Whisper

**根因**：官方字幕接口要**登录态**。Service Worker 和隔离世界（isolated world）的 `fetch` 都**带不上页面 cookie** —— 页面是登录的，后台拿到的却是 401/风控，于是判定"没字幕"。

**修法**：新增 `bilibili-subtitle-hook.js`，注册成 `content_scripts` 且 `world: "MAIN"`（**主世界**），在页面上下文里用页面自己的 cookie 取字幕，再 `postMessage` 回后台。回退顺序是 **页面上下文 → 后台直连 → 本地文件 → Whisper 缓存 → WHISPER_NEEDED**。

顺带把「hook 没注入」变成可自愈的：先用短超时探测，探不到就 `executeScript({world:"MAIN"})` 主动注入再重试一次。

> wbi 签名**不需要**实现 —— 三种调用方式（页面上下文 / 后台直连 / 带签名）拿到的结果完全一致，差别只在登录态上。

#### ② 没字幕的视频要等 45 秒才出现 Whisper 按钮

**根因**：`chrome.tabs.sendMessage` **本身没有超时**。内容脚本一旦不回话（页面还没 ready / 注入失败 / 上下文失效），后台就无限期挂起 —— 用户看到的就是那个转圈。

**修法**：
- `background.js` 新增 `sendToBilibiliTabWithTimeout()`，**8 秒硬超时**（`BILIBILI_TAB_MESSAGE_TIMEOUT_MS`）；
- `content.js` 的探测超时 3 秒 → **1.5 秒**，重试预算 12 秒 → **6 秒**。

现在没字幕的视频 **1 秒内**就该出现 Whisper 按钮。

#### ③ Whisper 500：`LocalEntryNotFoundError: Got: ConnectTimeout`

**根因是旧代码，不是不存在本地模型**。本机有 `faster-whisper` 的 tiny/base/small，但旧代码**不解析本地 HF 缓存**，每次都去 huggingface.co 下载 —— 而本机直连 huggingface.co 不通（curl 14.7 秒超时），于是必然超时。

**修法（三层）**：

1. **HF cache bootstrap**：在 `from faster_whisper import WhisperModel` **之前**把本地缓存目录灌进 `HF_HUB_CACHE`（huggingface_hub 在 import 时就把这个常量读死了，晚了就无效）；模型名解析到本地 snapshot 目录，**离线加载，零网络**。模型加载 **26.4 秒 → 0.6 秒**。
2. **旧 SYSTEM 进程自动绕开**：开机自启任务拉起的实例是 **SYSTEM 账户**（PID 14516，11/03 启动），普通权限 `taskkill` / `schtasks` 都是 Access is denied。新增 `diagnoseWhisperServer` / `repairWhisperServer`：靠 `/health` 里的 `model_resolution` 字段识别新旧代码，**在备用端口 7861 用用户权限拉起新实例**并把扩展切过去 —— **不需要管理员权限**。选项页 →「语音识别」里能看到「在线但跑的是旧代码」+「一键修好」。
3. **端口必须换，不能抢**：Windows 的 `SO_REUSEADDR` 允许两个进程绑同一个端口 → 抢端口会造成"有时能转录有时 Failed to fetch"。所以自愈走的是**换端口**，不是抢端口。

> 顺带修了一个 Windows 上的老坑：`.ps1` / `.bat` / `.vbs` 必须**纯 ASCII**。PowerShell 5.1 读无 BOM 的 `.ps1` 按 ANSI(GBK) 解码 → 中文注释变乱码 → **整个 native host 解析失败**（实测 5 个 parse error），Chrome 一按「启动 server」就完全没反应。cmd.exe 读 `.bat` 按 OEM 代码页、wscript 读 `.vbs` 按 ANSI，同理。

#### ④ 转圈 3 秒 —— 本地缓存查找是**串行**的

**根因**：`/local-file` 和 `/cache` 两个查找是串行发起的，而 `/local-file` 服务端每次都要遍历整个缓存目录、**逐个读 1204 个文件的头**。

实测拆解（用户缓存目录 `C:\Users\shangweizhe\bilibilisubs`，**1204 个文件**）：

| 动作 | 耗时 |
| --- | --- |
| `os.walk` 遍历 1204 个文件 | 22 ms |
| 读 1204 次文件头 | **~3000 ms** ← 元凶 |

**修法**：
- 服务端：文件头按 **mtime** 长期缓存（贵的才该缓存）；目录清单**每次重建**（22 ms，便宜的不该缓存 —— 缓存了就查不到新文件）。
- 扩展侧：`/local-file` 与 `/cache` **并行发起**。

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| `/local-file` | 3091 ms | **178 ms** |
| `/cache` | 633 ms | 55 ms |
| 扩展侧两次查找总耗时 | 3.7 s（串行） | **189 ms**（并行） |
| 整条 `fetchTranscript` | — | **252 ms** |

#### 顺带修的两个小问题

- **缓存目录误报**：超时路径硬编码了空字符串 → 明明配了目录却报"没配"。改成读真实 settings。
- **本地 server 的所有 fetch 都必须有硬超时**：`AbortError` 吞掉当"没找到"（抛出去会让链路跳 catch，用户就看不到 Whisper 出路了）。

#### 测试

- `npm test` 全绿：**7/7、10/10、4/4、7/7、26/26、8/8、kb-shared、kb-queue、13/13、33/33**（新增 `bilibili-whisper-prompt` / `whisper-server-launch` / `pill-note` / `askai-thinking-classifier` / `xuetangx` 五个测试文件并入 `npm test`）。
- 诊断探针（`bilidown-tests/`，全部**红/绿反向验证**过 —— 故意退回旧写法时必须变红，否则探针就是自欺欺人）：
  `_diag_bili_subtitle_page.js` **56/56**（主世界取数、hook 注入自愈）、`_diag_transcript_timing.js` **12/12**（1.5 秒探测 / 并行发出）、`_diag_parallel_local_lookup.js` **6/6**（并行 vs 串行 181 ms vs 267 ms）、`_diag_stale_server.js` **6/6**（旧实例识别）、`_diag_content_hang.js` **10/10**、`_diag_whisper_model_resolve.py` **20/20**、`_diag_whisper_cache_lookup.py` **7/7**、`_diag_whisper_e2e.py` **16/16**、`_diag_native_restart.py` **10/10**（真跑 launcher）。

**版本**：后台 `BG_BUILD=2026-11-06.1`，侧边栏 `SP_BUILD=2026-11-06.1`（两侧同时 +1，握手仍然相等）。版本对不上时侧边栏会直接提示「扩展需要重新加载」，不会让你对着半新半旧的状态猜。

**用户需要做的**：chrome://extensions → bililearn → 点**刷新**按钮（后台 Service Worker 换了新代码），然后刷新 B 站页面。**不需要管理员权限，也不需要重启 whisper server**（旧进程会自动绕开）。没字幕的视频应该 **1 秒内**出现 Whisper 按钮；第一次点 Whisper 可能会自动修复 server（几秒），**再点一次**就正常出字幕。

#### 仓库卫生

`.gitignore` 现在挡住：真实 cookie（`*cookies*.txt` / `*cookies*.json`）、浏览器 cookie 数据库（`*.db`）、`logs/` 运行时产物、探针下载的媒体文件、Python 缓存（`__pycache__/`）。**`tests/fake_cookies.txt` 也不入库** —— 磁盘上那份是 yt-dlp 从浏览器导出的真实 visitor cookie（`__Secure-YNID` / `__Secure-ROLLOUT_TOKEN`），而 `tests/probe_yt_with_cookies.py` 每次运行都会自己写一份假的，不需要入库。

### 2026-11-06：「启动 whisper server」按钮一直是死的 —— 日志抢占 + cmd 括号解析 + 启动不认端口

**症状**：点 Whisper 转录 → `Whisper server returned 500: {"error": "LocalEntryNotFoundError: Got: ConnectTimeout: [WinError 10060] …"}`。面板同时提示「Whisper server —— 在线，但跑的是旧代码……点下面的按钮拉起一个新实例」。

**第一层根因（11-05 已修）**：7860 上跑着的是**开机自启任务拉起的 SYSTEM 实例**（PID 14516，11/03 启动），用的是旧代码 —— 旧代码不解析本地 HF 缓存，每次都去 huggingface.co 下载，本机直连不通 → 必超时。自动修复的做法是在备用端口 7861 用用户权限拉一个新实例，扩展切过去（不需要管理员权限）。

**这一轮修的是「拉起新实例」这条路的三个真 bug** —— 按钮点了跟没点一样：

1. **日志文件被已运行的实例占着 → 第二个实例根本没启动**（`start_whisper_server.bat`）
   所有实例都往同一个 `logs\whisper_server.log` 追加。第一个实例把这个文件的句柄**一直握着**（stdout/stderr 就是它），于是第二个实例的 `>>` 重定向直接失败：
   ```
   cmd : The process cannot access the file because it is being used by another process.
   ```
   python 压根没跑起来 → 没有 server、没有监听端口。而这条链是 **wscript（静默）→ cmd → bat**，错误被完全吞掉，用户只看到"点了没反应"。
   **修法**：日志按端口分级 —— 默认端口仍是 `logs\whisper_server.log`，其它端口用 `logs\whisper_server_<port>.log`。两个实例再也不会抢同一个文件。

2. **cmd.exe 的括号解析把真正的错误吃掉了**（同一个 bat）
   错误分支原来是一个 `if errorlevel 1 ( … )` 块，里面那条 python 一行命令带了 `(no log file)` 的括号 —— **cmd 解析块时会数括号，连引号里的也算** → 块被提前截断，cmd 报 `: was unexpected at this time.`，而真正的原因（日志文件被占）被盖住了。
   **修法**：错误分支改成 `goto :failed` + 平铺标签，块里不放任何括号；日志尾巴改用 `powershell -NoProfile -Command "Get-Content … -Tail 30"`。

3. **「启动 server」不认扩展当前配的端口**（launcher + background）
   扩展的 whisperUrl 会被自动修复切到备用端口 7861，但 `launch` 命令只会把 server 拉在 7860 —— server 起来了，扩展却还连着一个没人监听的端口 → 用户点一次启动、面板还是说"没在跑"，**死循环**。
   **修法**：`bililearn_whisper_launcher.ps1` 的 `launch` 分支认 `port`（设 `BILILEARN_WHISPER_PORT`，这个环境变量一路继承 wscript → cmd → bat → python）；`background.js` 的 `launchWhisperServerOnce` 把当前配置的端口传过去（新增 `portFromWhisperUrl`）。

**顺手加的自愈**：启动之前先探一下默认端口 7860 —— 开机自启任务永远把 server 拉在 7860，**重启之后那上面跑的就是新代码了**。如果 7860 在线且 `/health` 带 `model_resolution` 字段（新代码标志），直接把 whisperUrl 切回去，连实例都不用再拉一个。

**一个必须记住的编码坑**：`.ps1` / `.bat` / `.vbs` 都要**纯 ASCII**。
- PowerShell 5.1 读无 BOM 的 `.ps1` 按 **ANSI(GBK)** 解码 → 中文注释被解成乱码 → **整个 native host 解析失败**（实测 5 个 parse error），Chrome 一按「启动 server」就完全没反应。
- cmd.exe 读 `.bat` 按 **OEM 代码页**，wscript 读 `.vbs` 按 **ANSI** → 同样会乱码，某些字节组合还会让 cmd 的块解析炸掉。

**实测验证**（都在真机上跑的，不是单测）：
- 活实例真转写（`bilidown-tests/_diag_live_transcribe.py`，**7/7**）：对 7861 发 `POST /transcribe` → **200 / 1.9s**，日志 `model base resolved to local snapshot: …\faster-whisper-base\snapshots\ebe41f70…` + `model loaded in 0.9s`，全程无 ConnectTimeout / LocalEntryNotFoundError，也没有 `falling back to download`（= 没联网）。
- native launcher 端口探针（`bilidown-tests/_diag_launch_port.py`，**5/5**）：按 Chrome 的 native messaging 协议（4 字节长度 + UTF-8 JSON 帧）驱动 host，`{cmd:"launch", port:7862}` → 7862 上真的起来了新代码实例（`/health` 带 `model_resolution`），默认端口 7860 不受影响。
- wscript → vbs → bat → python 整条链单独实测：端口 7863 起得来，日志落在 `logs\whisper_server_7863.log`。

**新增测试**：`tests/whisper-server-launch.test.js` **6/6**（已并入 `npm test`）—— 断言 launcher 的 launch 认端口、`.ps1/.bat/.vbs` 保持纯 ASCII、background 把配置端口传过去 + 7860 自愈、bat 的日志按端口分级、错误分支不再用带括号的块。

**当前状态**：扩展的 whisperUrl 已经是 `http://127.0.0.1:7861`，新实例在线并已跑通一次真转写。7860 上那个 SYSTEM 僵尸实例留着无害（普通用户权限杀不掉，需要管理员脚本才能退休）。

### 2026-11-06（补）：settings 页的「启动 server」按钮从来没成功过 —— 端到端验证 + 语言偏好兜底

**用户反馈**：「你在 settings 页面加的任何一个 button 点击都没有任何用处，无法启动 service！！从来没有能用过！！！！」

**先把"不是原因"的排除掉**（都是实测）：

| 怀疑 | 实测 | 结论 |
| --- | --- | --- |
| native host 没注册 | `HKCU\...\NativeMessagingHosts\com.bililearn.launcher` → `C:\Users\shangweizhe\AppData\Local\bililearn-native\com.bililearn.launcher.json`，`allowed_origins` 里的扩展 ID `iecokifhclbnhmgbmadgggidofeeppjn` 跟当前一致 | 注册没问题 |
| settings 页 JS 整体挂了 | JSDOM 加载真实 options.html + options.js：**0 个加载期错误**，23 个按钮，脚本加载正常 | 页面本身活着 |
| 按钮没绑事件 | 逐个点击审计：只有依赖 jsdom 缺能力的（clipboard / confirm / 文件选择器）才"没反应"，核心按钮都发得出消息 | 事件绑定正常 |
| native host 那条链断了 | 直接调 .ps1 和调 .bat **都通**（5/5） | 链是通的（修完之后） |

**真正的两个原因**（都在上一节那个"日志抢占 + 端口不认"里）：

1. **实例根本起不来**：`.bat` 把所有实例的日志写进同一个文件，被已运行的实例占着 → `>>` 重定向失败 → python 没启动；而这条链外面套着**静默的 wscript**，错误被完全吞掉 → 按钮点了像没点。
2. **起来了也连不上**：扩展的 whisperUrl 已被自动修复切到 7861，但 `launch` 不认端口、只在 7860 拉 → 健康检查一直探一个**没人监听的端口** → 90 秒后超时 → 又是"点了没用"。

**为什么"从来没有能用过"**：10-10 那次重写之前的路径（downloads.open + .vbs）本来就"dead from birth"；改成 native host 之后又踩上上面这两个坑。所以这个按钮从加进来到今天，**一次都没真正把服务拉起来过**。

**端到端验证（真实代码，真跑）**：新增 `bilidown-tests/_diag_options_launch_e2e.js` —— 把**真实的 options.js + 真实的 background.js + 真实的 .bat + 真实的 whisper_server.py** 串成一条链，在 JSDOM 里点「检查系统」→「启动 Whisper server（本会话）」，**8/8 通过**：

```
E1 options 页脚本加载无异常
E2 点「检查系统」渲染出诊断行（6 行）
E3 server 不在时「启动 server」按钮被渲染出来 —— 按钮文案="启动 Whisper server（本会话）"
E4 点按钮发出了 launchWhisperServerOnce
E5 native host 真的被调用 —— {"cmd":"launch","port":7865}
E5b native host 收到的是扩展配置的那个端口
E6 whisper server 真的在那个端口上起来了
E7 按钮进入了「等待就绪」状态（UI 有反馈）—— 按钮现在写着 "已拉起 — 等待服务就绪…"
```

**顺手修的另一个真问题：settings 页一直是英文**。用户的扩展存储里明明有顶层 key `language` = "zh-CN"（老版本写的），但这版读的是 `ytd_options_language` —— 读不到 → 每次打开 settings 页都退回**英文**。中文用户在英文页面里找「启动 Whisper server」按钮特别费劲，很容易以为按钮坏了。
现在语言偏好的读取顺序是：**新 key → 老 key（顺手迁移到新 key）→ 跟随浏览器界面语言**（中文系统直接给中文）。修完那页直接变成中文（见上面端到端输出里的中文行文案）。

**测试**：`tests/whisper-server-launch.test.js` 6/6 → **7/7**（新增语言偏好兜底的三条断言）。

**用户要做的**：chrome://extensions → bililearn → 点刷新按钮 → 打开设置页 → 点「检查系统」→ server 那行会出现「启动 Whisper server（本会话）」按钮 → 点它，几秒内 server 就起来了（按钮会变成「已拉起 — 等待服务就绪…」）。

### 2026-10-27（第九轮）：B 站没有官方字幕时，Whisper 转录页必须出现 —— 取字幕链路全面消除死路

**用户反馈**：「现在B站的视频的字幕获取出问题了。当视频不存在B站提供的字幕的时候现在不出现whisper转录的页面了。」

**先排除掉不是原因的几条**（都做了实测，不是猜）：

| 怀疑 | 实测结果 | 结论 |
| --- | --- | --- |
| B 站接口挂了 | `x/web-interface/view` code 0；`x/player/wbi/v2?bvid=BV1xx411c7mD&cid=62131` code 0、`subtitle.subtitles:[]`、bvid/cid 对得上 | 接口正常，无字幕时本该返回 null → 落到 WHISPER_NEEDED |
| 本地 Whisper 服务没启动 | `127.0.0.1:7860/health` → 200 `{"ok":true,…}`（faster_whisper 1.2.1 / zhconv 1.4.3 / yt_dlp 都在） | 服务活着 |
| 用户没选语音识别 | 直接读扩展存储里的 `ytd_settings`：`"asrProvider":"whisper"`、`"whisperUrl":"http://127.0.0.1:7860"`、`"whisperModel":"base"` 都对 | 设置没问题 |
| 侧边栏渲染链路坏了 | `tests/whisper-progress.e2e.test.js`（jsdom 跑真实 sidepanel.html + sidepanel.js）8/8 通过 | 链路完好 |
| 后台 B 站分支被改坏了 | 跟 git HEAD 逐行对比：`fetchBilibiliOfficialSubtitle` 一字未改，B 站分支的降级顺序也一致 | 没被改坏 |

**真正找到的三个死路**（都在"取字幕"这条链上，任何一步炸了用户就再也看不到 Whisper 按钮）：

1. **官方字幕接口抛错 → 整条链路死掉**（`background.js`）
   以前是裸 `await fetchBilibiliOfficialSubtitle(...)` —— 风控 / 网络抖动 / 字幕文件 403 / bvid-cid 对不上，任何一个报错都会让 `handleFetchTranscript` 直接跳进最外层 catch，只回一句看不懂的 error。结果：**既没有字幕，也没有 Whisper 出路**。
   现在：官方字幕的读取包在 try/catch 里，失败只记原因（`subtitleLookupError`，带中文前缀），然后**继续**往下走本地文件 → Whisper 缓存 → WHISPER_NEEDED。
2. **最外层 catch 把出路一起埋了**（`background.js`）
   即使前面的降级全失败，最外层 catch 现在也判断来源：B 站的视频一律回 `WHISPER_NEEDED`（附带出错原因和 `cacheDir`），而不是回一句只能让人干瞪眼的 error。**B 站这条路，Whisper 按钮必须永远在。**
3. **侧边栏自己把出路也丢了**（`sidepanel.js`）
   `await chrome.runtime.sendMessage({action:"fetchTranscript"})` 抛错（后台刚被刷新 / 扩展上下文失效 / 消息通道断了）时，以前整个 `startBililearn` 会炸掉，页面永远停在「正在获取字幕」转圈 —— 用户看到的是一个永远转圈的页面，连"重试"都没有。现在：抛错和"后台静默不回话"两种情况都直接落到 Whisper 提示页，并把原因写在页面上。另外加了 **45 秒超时兜底** —— 后台一直不回来（B 站接口黑洞 / 风控吞请求）时同样落到 Whisper 提示页，不会永远转圈。

**顺带的可见性改进**：Whisper 提示页现在会把失败原因原样显示出来（`读取 B 站官方字幕时出错：…`），就在「🎙️ 用 Whisper 转录」按钮下面，用户不用再猜卡在哪一步。

**测试**：

- 新增 `tests/bilibili-whisper-prompt.test.js`（**4/4**）—— 用 JSDOM 加载**真实的 background.js**（连同 settings.js / kb-*.js），假 fetch 打桩 B 站接口和本地 whisper server，走真实的 `chrome.runtime.onMessage` 通道发 `fetchTranscript`，断言四种场景的回包：无字幕 → WHISPER_NEEDED；官方字幕接口抛错 → WHISPER_NEEDED + 原因；视频信息接口抛错（最外层 catch）→ WHISPER_NEEDED + 原因；`asrProvider=none` → NO_TRANSCRIPT。
- `tests/whisper-progress.e2e.test.js` 8/8 → **10/10** —— 新增两条：`fetchTranscript` 抛错 / 空回包都不许停在转圈上，必须落到 Whisper 提示页。
- `tests/xuetangx.test.js` 30/30 → **33/33** —— 新增 [3c] 两条源码级断言（最外层 catch 对 B 站回 WHISPER_NEEDED；侧边栏 sendMessage 有 try/catch + 空回包处理）。

**版本**：后台 `BG_BUILD=2026-10-27.9`，侧边栏 `SP_BUILD=2026-10-27.9`（两侧同时 +1，握手仍然相等）。

**用户需要做的**：chrome://extensions → bililearn → 点刷新按钮（后台 Service Worker 换了新代码），然后刷新 B 站页面。侧边栏和后台版本号不一致时，面板会直接提示「扩展需要重新加载」，不会让你对着半新半旧的状态猜。

### 2026-10-27（第八轮）：概览不再显示 content 列表 —— 官方章节用 AI 同款格式渲染

**用户反馈**：「现在可以了，不过概览 tab 错误的把 content 列表页 load 出来了。不需要哦。另外，概览的时间线输出格式要和直接从 AI 生成的那种一样的格式。」

**那个 content 列表是什么**：上一轮把官方章节接进来之后，概览页多出来一大块内容清单 —— 那是**知识图谱的知识点树**。在真机上把接口地址当同源 URL 打开就看到了：

```
GET /train_platform/v1/knowledge_graph/97472/nodes/
→ {"msg":"","code":0,"data":[{"name":"Taiji Starts From Scratch","name_en":"",
   "taji":[...],"level":1,"children":[{"name":"Section 1 Overview of Tai Chi",…}]}]}
```

**单次 353KB**，内容是 "Section 1 … / Section 2 …" 这种课程内容清单 —— 不是概览，也不是章节时间线。

**为什么以前没暴露这个问题**：上一轮之前，学堂在线的字幕根本读不出来（一直卡在错误页），概览页压根没内容。这轮字幕通了，概览页第一次真正渲染出来，那块 content 列表才跟着露出来。

**改动**：

1. **整条知识图谱链停用**（`xuetangx-hook.js`）—— `graph/convert` → `kg_basic_info` → `kg_learn_chapter` → `knowledge_graph/{id}/nodes|video_info|brief_nodes` 七个接口**一个都不再请求**，相关的 250 行代码（`kgPickTitle` / `kgBuildTree` / `kgExtractTree` / `rememberKnowledgeGuide` …）整块删除。
   - 少拉 353KB、少 7 个请求，换小节时不再重拉 —— 现在概览只有**官方章节摘要**一个来源。
   - 顺带修掉一个"每换一节课就重拉 353KB"的浪费。
2. **概览页删掉「知识导引」那一节**（`sidepanel.html` + `sidepanel.css`）—— 连同 `kg-*` 样式和 `renderKnowledgeGuide` / `appendGuideEntries` 一起清掉。那个 content 列表从 UI 上彻底消失。
3. **官方章节改用 AI 概览同款格式**（`sidepanel.js` 的 `renderOfficialChapters`）—— DOM 结构跟 `renderAnalysisResults`（AI 那条路）**一模一样**：`chapter-item` → `chapter-timestamp`（`0:21` 这种 M:SS）+ `chapter-content` → `chapter-title` + `chapter-summary`，点击同样跳转视频对应位置。侧边栏上看到的样式和 AI 生成的一模一样。
4. **概览分区可见性重写**（`applyOverviewSections`）—— 有官方章节 → 「章节时间线」显示、「关键观点」隐藏（没跑 AI，没有观点）；没有官方章节 → 照常走 AI 概览，两节都留着。原来"有导引就把 AI 两节一起藏掉"的逻辑作废。
5. **官方章节这条路不需要 AI key**（`overviewRequiresAiKey`）—— 章节是课程方给的，不花钱也不需要 key。以前 `switchTab` 用 `!aiKeyMissing` 把整个概览分支掐掉，没配 key 的用户连官方章节都看不到；现在把"要不要 AI"和"要不要官方章节"拆开：学堂在线先试官方章节，确认没有才轮得到弹「配置AI」引导（总结页仍需要 AI，照旧）。
6. **后台接口改成返回章节**（`background.js`）—— `getXuetangxKnowledgeGuide` 现在返回 `{success, chapters, guide}`，`chapters` 是归一化后的官方章节（`{title, summary, timestampSeconds, timestamp, endSeconds}`，跟 AI 章节同款形状），`guide` 恒为 null（旧字段保留只为兼容旧侧边栏）。

**测试**：`tests/xuetangx.test.js` 扩到 **30/30** —— 新增/改写 5 条：
- 「知识图谱链已经停用：不再请求那批 content 列表接口」—— 断言那七个接口一个都没被请求，且钩子源码里已经没有知识图谱相关代码；
- 「pickXuetangxOfficialChapters：官方章节归一成 AI 概览同款形状」；
- 「官方章节渲染成 chapter-item（跟 AI 概览同款结构）」—— jsdom 里真跑一遍 `renderOfficialChapters`，断言产出的 DOM 结构、时间戳格式（`0:21`）、点击跳转用的秒数；
- 「概览页不再有「知识导引」这一节」—— 断言 HTML / CSS 里都没有那节和相关样式；
- 「overviewRequiresAiKey：官方章节 / 学堂在线都不需要 AI key」。

**版本**：钩子 `HOOK_VERSION=7`，内容脚本 / 后台 `XUETANGX_HOOK_VERSION=7`，后台 `BG_BUILD=2026-10-27.8`，侧边栏 `SP_BUILD=2026-10-27.8`。

### 2026-10-27（第七轮）：找到真正的字幕源 —— 官方「讲稿」接口（leaf_lecture_note）+ 官方章节摘要（leaf_knowledge）

**这一轮把根因找到了**。前六轮一直在 `s_t_g_p` 那条线上打转（各种主键 / 参数 / 姿势全试过），根子上是**方向错了**：学堂在线的字幕本来就不走那条接口。

在用户已登录的真机上，直接把接口地址当同源 URL 打开，读到了两个之前完全不知道的接口：

| 接口 | 返回 | 作用 |
| --- | --- | --- |
| `GET /c27/online_courseware/leaf_lecture_note/{leafId}/` | `{"msg":"","data":[{"formalParagraphText":"同学们好，今天我们的教学内容是太极拳的概述…","id":"8045034","startTime":21200,"endTime":38120,"paragraphId":"…","speakerId":""}],"success":true}` | **逐段官方文字稿，每段带毫秒时间戳**（14 分钟的课 ≈ 50 段 / 9.5KB） |
| `GET /c27/online_courseware/leaf_knowledge/{leafId}/` | `{"msg":"","data":[{"headline":"太极拳：起源、理念与全球影响","summary":"太极源于《易传》…","startTime":21200,"endTime":378760,"chapterId":1}],"success":true}` | **官方 AI 章节摘要**（标题 + 概要 + 时间区间） |
| `GET /c27/online_courseware/capability-conversation/leaf_timeline/?leaf_id={leafId}` | `{"data":[[5,18051],[378,18053],…]}` | AI 对话时间线（参数名 `leaf_id`，已实测） |

关键性质：**都是 GET、不需要 CSRF、页面同源（自带登录 cookie）、一个请求就够** —— 比 `s_t_g_p` 那条十几个请求 + 限速 + 403 重试的探针矩阵省事一个数量级。

**改动**：

1. **讲稿当官方字幕用**（`xuetangx-hook.js`）—— `collectLeafLectureNote()` 拉到讲稿后写成 `{subtitle_list:[{start,end,content}]}` 塞进 `state.subtitleBody`。后台认的就是这套结构，**后台一行都不用改**。转录来源标记为 `xuetangx-lecture-note`，面板上显示「学堂在线官方讲稿」。
2. **毫秒 → 秒的换算带自检**（`xtPickDivisor` / `xtRowsToSeconds`）—— 这两个接口的时间戳单位是毫秒，但万一某个课返回的是秒，照除 1000 会把 21 秒变成 5 小时。所以换算前先拿视频总长自检：总长已知时按两种假设分别验证（毫秒口径 `max/1000` 要落在总长附近，秒口径 `max` 要落在总长附近），都不沾就按接口契约（毫秒）走。
3. **章节摘要进知识导引**（`applyLeafKnowledge`）—— 官方章节就是现成的「概览」，直接挂进 `kgGuides`，侧边栏渲染它，**概览因此不用跑 AI**（跟知识图谱那份共存，两块都渲染）。
4. **讲稿优先，拿到就不再跑探针矩阵** —— `ensureResolved()` 里讲稿排第一；讲稿拿到了就**完全跳过** `s_t_g_p` 探针矩阵（省掉十几个请求和十几秒等待）。讲稿没有才退回老路。
5. **被动捕获也认这两个接口** —— `isInterestingUrl()` 补上 `/c27/` 与 `/train_platform/` 前缀（之前只认 `/api/v1/lms/`，页面自己拉讲稿时抓不到）；`handleApiResponse()` 里识别 `leaf_lecture_note` / `leaf_knowledge` 并复用同一套解析。
6. **content.js 加一条独立兜底**（`fetchXuetangxLectureNoteDirectly`）—— 隔离世界和页面同源，钩子整个挂掉时也能自己把讲稿拉回来。另外 `respondXuetangxState()` 的条件从「没有字幕地址」改成「没有字幕地址**且**没有字幕正文」—— 讲稿正文已经在状态里时，别再去做那一堆 `s_t_g_p` 请求。
7. **诊断文件加讲稿/章节字段** —— `讲稿段数` / `讲稿来源` / `章节数` / `章节预览` / `讲稿首段`，外加 `subtitleSource`；人话诊断里也加「官方讲稿 N 段」。
8. **侧边栏** —— 知识导引支持多块（`guide.blocks`），每块都渲染；章节条目显示时间区间（`0:21–6:19`）；转录来源徽标区分「学堂在线官方讲稿」/「学堂在线官方字幕」。

**测试**：`tests/xuetangx.test.js` 扩到 **27/27** —— 新增 8 条：
- 「pickXuetangxKnowledgeGuide：官方章节排前面，所有导引都返回」；
- 「parseLectureNote 把毫秒时间戳换成秒」「xtPickDivisor：接口用秒的时候不能照除 1000」「parseLeafKnowledge 取出标题 / 概要 / 时间区间」（钩子解析函数的单元测试）；
- 「讲稿接口：讲稿当字幕用，后台能直接解析出带时间的段落」「讲稿优先：拿到讲稿就不再跑字幕探针矩阵」「章节接口：官方章节进知识导引，概览不用跑 AI」（整条链路的集成测试）；
- 「真字幕文件优先于讲稿」—— 页面自己先给字幕文件、钩子后拿讲稿时，讲稿不能顶掉人工校对的字幕（这条测的是顺序依赖，不测就会悄悄出错字）。

（真机样例直接用线上原文：21200ms→21.2s、378760ms→378.76s、50 段讲稿、3 个章节。）

### 2026-10-27（第六轮）：探针被限流了 —— 限速 + 403 重试，并且给用户一条一定走得通的路

**症状**：上一轮加的探针矩阵跑起来了，但矩阵**几乎没跑完**就被拦了。诊断文件的 `probe` 段：

```
s_t_g_p c_d=ccid        → 200  对象(0键)     ← 第一发成功
s_t_g_p c_d=leafId      → 403  空
s_t_g_p c_d=ccid+d_l=0  → 403  空
s_t_g_p c_d=ccid+d_l=1  → 403  空
...（后面 5 发全是 403）
GET learn/video/subtitle/ccid    → 404 空
GET learn/video/subtitle/leafId  → 403 空
```

**第一发 200、之后全 403** —— 服务端在拦"短时间连发"。上一轮把矩阵写成了一串背靠背的请求，**除第一发以外全被判失败**，一个变体都没试成。另外 403 的正文不是 JSON，所以连"为什么 403"都没留下（`pageResponses` 是空的）。

**同时暴露了两个别的问题**：

1. `pageRequests` 里混进了一条 `{"ccid": ...}` 的 POST —— **只有旧版钩子（v4）会发这个 body**，说明**页面里 v4 和 v5 两个钩子同时活着**，两边一起打接口，请求量翻倍，更容易被限流。
2. **学堂在线官方字幕读不出时，面板上只有「重试」，没有「用 Whisper 转录」** —— B 站有这条路，学堂在线没有。用户被卡在一条死路上：官方字幕读不出 → 只能干等。

**改动**：

1. **探针限速**（`PROBE_GAP_MS = 700`）—— 每发之间隔 0.7 秒，不再触发"刷接口"拦截。
2. **403 会等 2.5 秒重试一次**；重试还是 403 就**停止 POST 矩阵**（后面必然也是 403，跑完只是浪费时间和招来更严的限流），但**继续试 GET 端点**（GET 不受 CSRF 保护，还有机会）。
3. **403 的正文抓进诊断**（`describeProbeResponse`）—— 状态码猜不出来的原因，正文能猜出来。顺带记 `Retry-After` 响应头。
4. **请求头跟学堂在线的 axios 完全对齐** —— 补上 `django-language` 和 `Accept-Language`（语言来自 `django_language` **cookie**，不是 localStorage）。服务端很可能按语言挑字幕（`s_t_c` 的 `d_l`：0 中文 / 1 英文），头不一致就挑不出现有的字幕行。
5. **新增一条线索：深搜完整响应**（`scanSubtitleUrls` / `summarizeIds`）—— 字幕文件地址未必只在 `s_t_g_p` 里，`leaf_info` / `playurl` 的响应里也可能直接带字幕路径。现在整棵 JSON 都会被扫一遍（带"像文件地址"的校验，不会乱认）。同时把 `leaf_info` 里所有像 id 的字段列出来 —— 字幕主键到底该用哪个，一次看清，不用再猜。
6. **检测"页面里还跑着旧钩子"** —— 内容脚本收到版本号更低的状态时记 `staleHookSeen`，面板会明说「页面里还活着一个旧版钩子，它在跟新版抢接口。请按 F5 刷新一次课程页面」。
7. **学堂在线官方字幕读不出时，主按钮改成「🎙️ 用 Whisper 转录」**（走学堂在线自己的 Whisper 管线：视频直链 → 本地 whisper_server），次要按钮保留「再试一次官方字幕」（`force` 重跑探针矩阵）。**这条路一定能走通** —— 视频直链是有的。
8. **知识导引改到最前面发起（不 await）** —— 之前它排在字幕探针矩阵后面，矩阵要十几秒，概览会一直空着。
9. **诊断里 `pageRequests` 干净了** —— 之前 `apiGetRaw` / `apiPostRaw` / `apiGet` 没标记"这是我们自己发的"，页面自己的请求和自己的请求混在一起分不清。现在全部带上计数。
10. **等待上限放宽** —— 探针带限速后跑完要十几秒，内容脚本 8 秒 / 后台 12 秒的上限会把还在跑的结果判成"超时"。分别放宽到 25 秒 / 30 秒。

**测试**：`tests/xuetangx.test.js` 扩到 **19/19** —— 新增两条直接复现本轮线上故障的回归测试：
- 「探针矩阵：403 会把正文记下来，并且重试一次能拿到字幕」—— mock 第一次 403（HTML 正文）、第二次 200，断言正文进了诊断、重试发生了、字幕拿到了；
- 「探针矩阵默认限速」—— 断言默认间隔 700ms、请求头含 `django-language` / `Accept-Language`。

（限速间隔和重试等待做成了可覆盖的 `window.__bililearnProbeGapMs` / `__bililearnProbeRetryWaitMs`，测试里调成 0，不用真等。）

### 2026-10-27（第五轮）：字幕探针矩阵 —— 一次把请求姿势全试完，不再靠猜

**症状**：字幕还是读不出来。但这一轮的诊断文件跟以前不一样，链路其实是通的：

```json
{ "hookVersion": 4, "hookBuild": "2026-10-27.4",
  "ccid": "15E84ABF4B8AF8007E6C9CEE8B422289", "leafTitle": "1.1  Overview of Tai Chi",
  "hasSubtitle": true, "subtitleUrl": "",
  "notes": ["leaf_info sign=ecut04021005032intl → 成功",
            "s_t_c d_l=1 → 有字幕",
            "s_t_g_p body={\"c_d\":\"15E84...\"} → 返回不是数组",
            "s_t_g_p body={\"ccid\":\"15E84...\"} → 返回不是数组"] }
```

`hookVersion: 4` —— **钩子在跑，链路是通的**：`leaf_info` 拿到了 ccid，`s_t_c` 明确回 `d_l=1`（有字幕）+ `a_d=true`（允许下载）。唯一卡住的是 `s_t_g_p`。

**根因（这次是真的定位到了）**：`s_t_g_p` 的线上响应不是"数组"，而是 **空对象**：

```json
{ "msg": "", "success": true, "data": {} }
```

`success: true` 说明请求本身是通的（CSRF、cookie、header 全对），`data` 是空对象说明**服务端没匹配到这个主键** —— 不是没有字幕，是**我们发的姿势它不认**。而 `s_t_c` 说得很清楚：字幕是有的。

从前端 bundle 逐字确认了契约（`src_views_courseAction_learnSpace_VideoComp_vue.js`）：

```js
s_t_g_p({ c_d: ccid }).then(function (res) {
  if (res.data && res.data.length) { res.data.forEach(item => ({ lang: item.lang, src: item.data })) }
})
```

`ccid` 也确认了取自 `compState.content.content_info.media.ccid`（跟我们的取法一致）。也就是说：**姿势只有这一种，而这一种线上不认**。再猜下去就是无限试错，所以改成一次全试完。

**改动**：

1. **字幕探针矩阵（`probeSubtitleMatrix`）** —— 一次把可能的姿势全试一遍，命中即止：
   - 主键候选：`ccid` / `content_info.id` / `media.video_id` / `leafId`（后两个这次新抓的，`leaf_info` 里本来就有）
   - 请求体：`{c_d}`、`{c_d, d_l:0}`、`{c_d, d_l:1}`、老字段名 `{ccid}`、`{c_d, cid, sign}`（主键冲突时服务端可能要课程上下文来消歧）
   - 另一个端点：`GET /api/v1/lms/learn/video/subtitle/{id}/`（前端 bundle 里留着但标了 unused 的那个）
   - **每个姿势的原始响应都记进 `state.raw.probe`** —— 一次刷新就能看清"到底是哪个姿势对上了"，不用再来回试错。
2. **记录页面自己发出去的那次请求 + 它的响应**（`state.raw.pageRequests` / `pageResponses`）—— 那是标准答案，跟我们的一比就知道差在哪（靠 `selfRequestDepth` 把我们自己补的请求排除掉）。
3. **播放器侧兜底（`harvestPlayerCaptions`）** —— 接口全空时还有三条不依赖接口的路：`<track>` 元素、`<video>.textTracks` 的 cue、Vue 组件里的 `captionSrc` / `captionData`。那是"页面此刻真在显示的字幕"，比任何接口都可靠。
4. **后台换成"注入 + 轮询"**（`getXuetangxStateForTab`）—— 以前换完钩子只问一次就放弃；新钩子刚注进去还在跑探针矩阵（十来个请求，要几秒），这一问必然拿不到。现在轮询到版本对上为止（12 秒）。
5. **重试按钮走 force 通道** —— 侧边栏「重试」会带上 `force`，让钩子把探针矩阵重跑一遍（平时对同一个 ccid 只跑一次，免得把人家接口打爆）。
6. **知识导引不再阻塞字幕** —— `collectKnowledgeGuide()` 改成不 await（它要连发 6 个请求，等它跑完会把字幕上报拖慢好几秒）。字幕优先。
7. **`raw.subtitleFile` 不再被无关响应污染** —— 之前任何"interesting URL"的响应都会往这个字段写，诊断里出现过课程产品信息，误导排查。现在只写真·字幕文件。

**验证**：从 bundle 逐字确认了 `s_t_g_p` 的真实契约（`res.data[].data` = 字幕地址）、`ccid` 的来源、`s_t_c` 的 `d_l` 语义（0 中文 / 1 英文）、axios 拦截器会带的 header（`X-CSRFToken` / `app-name` / `xtbz` / `x-client`）—— 我们的请求头跟它一致，所以不是鉴权问题，是主键/参数不匹配。

**测试**：`tests/xuetangx.test.js` 扩到 **17/17** —— 新增两条回归测试，直接复现这次线上故障：
- 「探针矩阵：默认姿势拿不到时，换个姿势照样把字幕读出来」—— mock 模拟"只有带 `d_l` 才给数据"，断言钩子照样读出字幕地址和正文；
- 「探针矩阵：全空时也不崩，诊断里能看出每个姿势的结果」—— 断言拿不到时不瞎编（地址为空），且 `raw.probe` 里能看到"响应是空对象"。

### 2026-10-27（第四轮）：根因 —— 页面里跑的是旧钩子

**症状**：字幕仍然读不出来。诊断文件（`Downloads/BiliSubs/xuetangx-debug.json`）给出了决定性线索：

```json
{ "ccid": "15E84ABF4B8AF8007E6C9CEE8B422289", "leafTitle": "1.1  Overview of Tai Chi",
  "hasSubtitle": true, "subtitleUrl": "", "subtitleBody长度": 0,
  "notes": [], "rawLeafInfo": "", "rawSubtitleList": "" }
```

`ccid` / `leafTitle` / `hasSubtitle` 都有（说明 leaf_info 和 s_t_c 抓到了），但 **`notes` 和所有 `raw*` 字段全空** —— 而这版钩子只要跑过主动补齐就必然会写 notes。**结论：扩展后台读到的是"第一版钩子"留下的旧状态。**

**根因**：**扩展刷新（chrome://extensions 的刷新按钮）不会更新已经打开的页面里的 JS**。页面主世界里的钩子是页面 JS，扩展刷新它完全不知道 —— 于是"后台是新的、页面里的钩子是旧的"，后台拿着半新半旧的状态一直排查。

（这跟第一轮那个"Service Worker 跑旧代码"是同一族问题，但发生在另一个生命周期：SW 靠点刷新按钮换，页面里的钩子只能靠**重新加载页面**换。）

**修复（根治这一整类）**：

1. **钩子带版本号**（`HOOK_VERSION = 4`），写进 state。后台拿到状态先看版本号：对不上就**重新注入一次**钩子（钩子的幂等守卫改成按版本判断 —— 同版本跳过、版本变了就装新的），再问一遍内容脚本。
2. **内容脚本按版本丢弃旧状态**：页面里新旧钩子可能同时活着，只认版本不低的那个。
3. **内容脚本的重复注入守卫也改成按版本**（原来是"注入过一次就永远抛错"，导致新版 content.js 装不进去），并且把上一版注册的 `onMessage` 监听器摘掉 —— 否则两个监听器同时回话，Chrome 会报 "sendResponse 被调用多次"。
4. **接口调用放宽**：`leaf_info` / `s_t_c` / `s_t_g_p` 都改用宽松解析（不再要求响应里有 `success: true`）；`s_t_g_p` 的请求体按前端代码是 `{c_d: ccid}`，老接口是 `{ccid: ccid}`，**两个都试**。
5. **DOM 兜底**：播放器拿到字幕列表后会把字幕挂进 `<track>`（或带字幕特征的元素）—— 那是"页面此刻真在用的字幕"，比任何接口都可靠。内容脚本在钩子没抓到时从 DOM 里找字幕地址。
6. **诊断文件带上 `hookVersion` / `hookBuild`** —— 下次一眼就能看出"后台读到的状态是不是最新钩子发的"。

**验证**：从前端 bundle 确认了接口的**真实形状**（`res.data[].data` = 字幕文件 URL；`ccid` 取自 `content_info.media.ccid`；`s_t_c` 的 `d_l` 是默认语言 0中文/1英文），跟实现一致 —— 所以问题不在猜接口，而在钩子版本。

**测试**：`tests/xuetangx.test.js` 扩到 15/15 —— 新增"钩子带版本号 + 主动补齐留下诊断痕迹"、"钩子/内容脚本/后台三处版本号必须一致"（改一边忘另一边直接挂）。

### 2026-10-27（第三轮）：学堂在线「知识导引」直接当概览用，不再跑 AI

**需求**：学堂在线有 knowledge guide（知识导引），跟我们要用 AI 生成的「概览」是一回事。有导引的视频，**直接从页面读出来填进概览页，不要再调用 AI**。

**接口链**（从前端 bundle 里挖出来的，全部在页面上下文里调，带页面自己的登录 cookie）：

| 接口 | 作用 |
| --- | --- |
| `GET /c27/online_courseware/instance/graph/convert/?source_type=1&source_id={cid}` | 班级图谱实例 → `etag_id` |
| `GET /api/v1/lms/kg/kg_basic_info/?cid=&sign=` | 图谱 id |
| `GET /api/v1/lms/kg/kg_learn_chapter/?etag_id=&cid=&sign=` | 按图谱组织的课程单元（章节） |
| `GET /train_platform/v1/knowledge_graph/{graphId}/` | 图谱基本信息 |
| `GET /train_platform/v1/knowledge_graph/{graphId}/nodes/` | 知识点树 |
| `GET /train_platform/v1/knowledge_graph/{graphId}/video_info/` | 当前小节的学习单元信息 |

> 注意 `baseURLs.xtbase = "lms/"` —— `kg/*` 这批接口的全路径是 `/api/v1/lms/kg/...`，而 `/c27/...` 和 `/train_platform/v1/...` 走的是 `/api/v1` 之外的路径。

**实现**：

- **`xuetangx-hook.js`** —— 被动捕获（页面自己拉的图谱响应）+ 主动补齐（`collectKnowledgeGuide()`，按上面的链路依次拉）。**结构化也在页面里做完**（`kgExtractTree` / `kgBuildTree` / `kgCompactTree`），只把「标题 / 正文 / 时间戳 / 层级」这种小结构发回扩展，不传原始 JSON —— 状态体积小，postMessage 和消息总线都轻松。字段名各家不统一（`name`/`title`/`node_name`…），挨个试；数组里六成以上有标题字段才认定是"目录"。
- **`background.js`** —— 新增 `pickXuetangxKnowledgeGuide()`（多份导引里取条目最多的那份）+ 新 action `getXuetangxKnowledgeGuide`。
- **`sidepanel.js`** —— 概览页新增「知识导引」区块（`renderKnowledgeGuide` / `appendGuideEntries`）；**有导引就不跑 AI 概览**：`switchTab` 的懒加载分支改成"先要导引，要不到再 `triggerAnalysis()`"，`triggerAnalysis()` 本身也加了守卫；有导引时把 AI 的「章节时间线 / 关键观点」两节藏掉（它们是空的，而且根本没跑 AI）；`restoreLlmSections()` 也会尊重导引状态，不会把空的两节放回来。
- **`sidepanel.html` / `sidepanel.css`** —— 概览页新增 `#knowledgeGuideSection` 与配套样式（`.kg-note` / `.kg-list` / `.kg-title` / `.kg-time` / `.kg-body`）。

**行为**：有没有导引是自动判断的 —— 课程没有导引就照旧走 AI 概览，不影响任何现有功能。

**测试**：`tests/xuetangx.test.js` 扩到 13/13 —— 新增"钩子主动拉图谱接口并结构化"（断言 4 个接口都被请求、导引条目 / 正文 / 子节点都对）和 sidepanel 两个小工具函数。

### 2026-10-27（第二轮）：学堂在线"明明有字幕却读不到"

**症状**：扩展跑起来了，但侧边栏报「学堂在线官方字幕没读出来」——而课程里确实有字幕。

**改动**（按"哪一环最可能是坏的"逐个拆掉）：

1. **字幕文件改由页面自己去抓**（`xuetangx-hook.js`）。之前是后台拿字幕文件地址去跨域下载 —— CDN 可能不给权限、可能 403。现在钩子在**页面上下文**里直接把字幕文件本体抓下来存进 `state.subtitleBody`，后台只负责解析。后台自己下载保留为兜底。
2. **字幕接口不再被 `d_l` 卡住**。`s_t_c`（有没有字幕）如果返回的结构跟预期不同（`data.d_l` vs `data[0].d_l`），整个链路就断了 —— 现在 `s_t_g_p`（字幕文件地址）**无条件试**：没有字幕时它本来也返回空列表，试一下不花钱。
3. **`leaf_info` 多试一种形态**：候选 sign 逐个试之外，再试一次**不带 sign**（有些课程根本不校验）。
4. **字幕地址字段名挨个试**：`data` / `url` / `src` / `subtitle_url` / `file` / `path` 都认；`data` 本身是数组也认。
5. **字幕文件结构深搜兜底**（`parseXuetangxSubtitlePayload`）：字段名不是 `subtitle_list` / `data` 时，深搜整棵 JSON 树找"有文本字段 + 有时间字段"的数组。SRT/VTT 照旧。
6. **真 bug：切小节后 `ccid` 没清空**。`ccid` 是**小节级**标识，留着上一节的 → 补齐逻辑拿旧 ccid 去查字幕地址 → 又拿回上一节的字幕。现在换小节时 ccid 连同字幕地址一起作废并重新解析。
7. **真 bug：URL 里的 leaf 会覆盖真实 leaf**。学堂在线切小节时地址栏不一定变，页面真正的小节以 `leaf_info` 捕获为准 —— 现在 URL 里的 leaf 只作"入口猜测"，不会覆盖已捕获的值。
8. **失败自动落诊断文件**：抓不到字幕时，扩展把每一步接口的原始响应片段（leaf_info / s_t_c / s_t_g_p / 字幕文件正文）+ 状态快照写到**下载目录 `BiliSubs/xuetangx-debug.json`**，并在面板上直接显示"卡在哪一步"（cid/leaf/ccid/字幕地址/错误原因）。不用猜。

**测试**：`tests/xuetangx.test.js` 扩到 11/11 —— 新增"钩子把字幕文件本体也抓下来了"、"非常规字段名的字幕文件也能解析"、"s_t_g_p 的响应不能被误认成字幕条目"、"换小节后换成新小节的字幕地址"。写测试时抓到第 6 条那个 ccid 真 bug。

### 2026-10-27：修复"改了代码却像没改"——后台 Service Worker 跑旧代码

**症状**：学堂在线侧边栏报「没有找到可靠字幕 / Invalid Bilibili BV ID.」。这串报错跟学堂在线毫无关系，是 B 站专属的校验（`settings.js` 的 `canonicalBilibiliUrl`）抛的。

**根因**：**扩展里的后台 Service Worker 还在跑内存里的旧脚本**。

改扩展文件后，Chrome 不会自动重新加载后台：

| | 重新读盘时机 | 结果 |
|---|---|---|
| 侧边栏 `sidepanel.js` | 每次打开面板 | ✅ 新的 |
| 后台 `background.js` | 只在 chrome://extensions 点「刷新」或 SW 自行重启 | ❌ 旧的 |

于是变成"面板是新的、后台是旧的"这种半新半旧状态：侧边栏认得 `xt-{cid}-{leafId}`，旧后台不认识，把它当 B 站视频处理 → `canonicalBilibiliUrl("xt-31335364-84818568")` → 抛 `Invalid Bilibili BV ID.`。

**验证方式**：用 Node 把磁盘上的 `handleFetchTranscript` 抽出来实跑一遍（`tests/` 下的临时探针，已删），传入用户的真实 videoId —— 返回的是 `XUETANGX_STATE_MISSING`，**根本走不到抛错的 B 站分支**。磁盘代码是对的，问题只在"浏览器里跑的不是这份代码"。

**修复（根治这类半新半旧）**：

1. **版本握手** —— background 新增 `getExtensionBuild` 动作，返回构建指纹 `BG_BUILD`；sidepanel 启动时先跟后台对版本号，对不上就**直接拦住整个面板**，显示「扩展需要重新加载 → chrome://extensions → 点刷新按钮 → 再刷新课程页面」，并给一个「重新检测」按钮。
   - 判定分三种情况，避免误伤：① 后台明确报了**不同的**版本号 → 拦；② 后台不认这个 action（老版本），但 `checkConfig` 能回（后台还活着）→ 拦；③ 连 `checkConfig` 都不回（后台整个联系不上）→ 不拦，让正常流程去报错，别抢走面板。
2. **错误翻译兜底** —— 万一握手没拦住（后台是旧代码，不认新 action），侧边栏见到 `Invalid Bilibili BV ID` 也翻译成「扩展后台需要重新加载」的人话，不再甩天书。
3. **`detectVideoSource` 加固** —— 判定平台前先摘掉 `@pN` 后缀。原来 `"xt-31335364-84818568@p1"` 认不出来，会一路掉进 B 站分支。
4. **测试守着一致性** —— `tests/xuetangx.test.js` 新增用例：`BG_BUILD` 与 `SP_BUILD` 必须相等、两边都得处理 `getExtensionBuild`、`detectVideoSource` 认得带 `@pN` 的 id。改了一边忘了另一边，测试直接挂。

**给用户的操作**：改完扩展代码，**必须**去 `chrome://extensions` 点一次「刷新」（圆形箭头），否则后台还是旧代码。

### 2026-10-26：支持学堂在线（xuetangx.com）课程视频

**新能力**：在学堂在线课程播放页（`https://www.xuetangx.com/course/{课程号}/{班级号}`）使用 bililearn —— 读官方字幕、生成中文概览/章节/关键观点、记笔记、导出。侧边栏、播放器笔记按钮、时间戳跳转全部可用。

**为什么这么绕**：学堂在线的学习接口全部要求登录态。从扩展的 service worker 直接请求会被拒（`{"msg":"user is not login"}` / `{"detail":"身份认证信息未提供。"}`），复刻它的鉴权也不现实（课程接口涉及 sessionid + csrftoken + WAF）。所以采用"搭页面便车"方案：页面自己发请求（带用户自己的登录 cookie），扩展只负责记下结果。

**实现**：

- **新增 `xuetangx-hook.js`** —— 页面**主世界**（manifest `content_scripts[].world = "MAIN"`，`run_at: "document_start"`）钩子。拦截页面自己的 `window.fetch` / `XMLHttpRequest`，记下四个接口的响应：
  - `GET  /api/v1/lms/learn/leaf_info/{cid}/{leafId}/` → 小节标题 + `content_info.media.ccid`
  - `GET  /api/v1/lms/service/s_t_c/{leafId}/` → 该小节有没有字幕 + 默认语言
  - `POST /api/v1/lms/service/s_t_g_p/`（body `{c_d: ccid}`）→ 字幕文件地址列表
  - `GET  /api/v1/lms/service/playurl/{ccid}/` → 视频直链
  - `GET  /api/v1/lms/learn/menu/` → 课程目录
  通过 `window.postMessage` 把状态推给隔离世界（跨世界只能传结构化克隆的数据，JS 对象读不到）。
- **`content.js`** —— 学堂在线分支：读状态、取标题/课程名/时长、注入「AI 总结」按钮（挂在"加入学习"旁）、笔记按钮挂到 `video.xt_video_player` 的包装元素上、换小节时通知 background。
- **`background.js`** —— 新增 `fetchXuetangxOfficialSubtitle`（字幕文件 → 标准 `{start, duration, text}`，兼容 `subtitle_list` JSON 与 SRT/VTT 两种形态）、`runXuetangxWhisperPipeline`（无字幕时下载视频直链交本地 whisper_server）、`detectVideoSource` 新增 `xuetangx` 分支、`canonicalWatchUrlForVideoId` 支持 `xt-{cid}-{leafId}`。
- **`sidepanel.js`** —— 放行 `*.xuetangx.com`；`extractVideoId` 认课程页 URL（URL 里没有小节 id 时由内容脚本补）；收到"换小节"通知后自动重新加载。
- **`manifest.json`** —— 新增 host 权限 `https://*.xuetangx.com/*`、`https://*.yuketang.cn/*`；新增两个 content script 条目（隔离世界 `content.js` + 主世界 `xuetangx-hook.js`）。

**已知限制**：没有官方字幕的小节走本地 Whisper。扩展刚安装/更新时如果课程页面已经打开，钩子会错过最初几次请求 —— 此时钩子会主动补齐（见下方"同日修正"），但首次打开仍建议刷新一次页面。

**同日修正（用户实测反馈）**：真实的学习页是 `/learn/space/{products_sign}/{course_sign}/{classroom_id}/video/{leaf_id}`，不是一开始以为的 `/course/{sign}/{cid}` —— 前者 URL 里直接带小节 id，后者不带。由此补了三处：

1. **URL 解析**：sidepanel `extractVideoId` 与钩子 `parseLocation` 都认新形态（`xt-{classroomId}-{leafId}`）；`sign` 到底取 `products_sign` 还是 `course_sign` 各课程不一，改成收集候选、`leaf_info` 逐个试。
2. **被动捕获 → 主动补齐**：光靠"拦截页面自己的请求"有个硬前提 —— 钩子得比页面第一次请求先跑。扩展后装/页面先开就抓不到，表现为侧边栏报"未匹配到视频地址"。现在钩子会在主世界里**主动调**学堂在线自己的接口（`leaf_info` → `s_t_c` → `s_t_g_p` → `product/info`）把当前小节补齐 —— 跑在页面上下文里，带的是页面自己的登录 cookie，扩展不存任何凭据。内容脚本的等待条件也从"固定 1.5 秒"改成"等补齐完成（上限 8 秒）"。
3. **笔记/导出链接**：直接用当前页面地址（带小节 id），不再自己拼课程 URL。

**测试**：`tests/xuetangx.test.js` 7/7 PASS（已并入 `npm test`）—— 覆盖站点识别、时间串解析、字幕文件归一化、URL 解析，以及在 jsdom 里跑真实钩子验证接口捕获、"换小节后旧字幕作废"、"主动补齐"。写测试时抓到钩子里一个真 bug：`handleLeafInfo` 用了未定义的 `d`，异常被 try/catch 吞掉导致状态永远不推送。

### 2026-10-03：KB 管理功能（字幕 → 知识库）

**新能力**：字幕 tab 一键把当前视频加入本地知识库；B 站与 YouTube 字段统一（`author`/`bvid`/`platform`/`date`=发布日）。总开关默认关闭，开启时强制先选 KB 主目录。

**三种构建方法**（新建或补建 kb.json 时三选一）：
- `karpathy`：LLM wiki（`wiki/index.md` 索引 + `wiki/moc/` 主题地图）
- `nvwa`：心智模型（`nvwa/心智模型.md` + `nvwa/案例集/`）
- `raw`：只落盘 `videos/*.md`（带 YAML frontmatter），零 LLM 调用

**更新频次三档**：realtime（30 秒 alarm，默认）/ manual（options「立即更新」按钮）/ daily（每日 01:00，whisper server 不可用则跳过）。增量更新走磁盘队列 `queue/pending → done|failed`（attempts≥3 进 failed，options 可重试），由 background service worker 消费；LLM 写回前校验 patch JSON 与文件名合法性。

**文件与端点**：新增 `kb-shared.js`（纯函数）/ `kb-client.js`（fetch 封装）/ `kb-queue.js`（后台消费者）；`whisper_server.py` 新增 `/kb/list|read|videos|queue|create|write|delete|move|pick_root`（路径沙箱：越界一律 400）；settings 新增 `kbEnabled`/`kbRootDir`/`kbUpdateMode`/`lastKbName`。

**删除语义**：默认解绑（kb.json 标 `archived`，目录保留）；二次红字确认才删盘。

**测试**：`tests/kb-shared.test.js`、`tests/kb-queue.test.js`（node，已并入 `npm test`）、`tests/kb-routes.test.py`（契约+沙箱）。

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
