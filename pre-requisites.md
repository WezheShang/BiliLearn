# bililearn — Pre-requisites & 首次启用 Local Whisper 检查清单

> 适用范围：用户首次启用「Speech recognition = Local Whisper」的完整依赖链。
> 撰写人：Mavis（Irene 口述落盘）；创建日：2026-09-13。
> 一句话：**设置页的「检查系统」按钮只读检测 / 列差异 / 提供一键安装按钮**——任何依赖**不**自动悄悄安装。

---

## 0. 默认路径与目录创建（写在最前面，因为每次都先踩）

### 0.1 Subtitle cache directory 默认值
**默认**：`%USERPROFILE%\Downloads\BiliSubs\`（Windows 上 = 浏览器默认下载目录的子目录）。
**理由**：Chrome MV3 extension 拿不到 `$HOME`，但 `chrome.downloads.download()` 会自动把
`BiliSubs/<filename>` 这种相对路径 resolve 到浏览器配置的 Downloads 目录，并在首次写入时
自动创建子目录。**不**写死绝对路径（避免把 build 机的布局 leak 到其他机器）。

### 0.2 启动时主动检测 + 创建
页面加载/保存时：
1. 读 `settings.subtitlesDir`；若为空，**回退到默认值** `~/Downloads/BiliSubs/`。
2. 用 `chrome.downloads` API 探测该目录可达（一次 dry-run 写 `.bililearn-write-probe`），
   或在用户首次保存时主动用 `<input type="file" webkitdirectory>` 让用户确认/挑选实际目录。
3. 缺失时主动 mkdir 失败 → 红 banner 提示「目录创建失败，请手动选一个有写权限的目录」。
4. **placeholder** 文本必须显示真实默认路径（`C:/Users/<登录名>/Downloads/BiliSubs`），
   不能用 `C:/Users/you/videoprocess/subtitles` 这种占位符（2026-09-13 用户原话
   「默认的路径，不应该是去读取系统的downloads 的路径，然后加上 bilisubs 的子目录么？」）。

### 0.3 用户改了路径怎么办
- 用户手填了别的绝对路径 → 沿用该路径，不再回退默认。
- 用户清空 → 重置为默认。
- 输入了 `~` 或 `${HOME}` → 通过 `KNOWN_HOMES` 展开（settings.js 已实现）。

---

## 1. Local Whisper 五项依赖（a → e 顺序，按你拍板的口径）

| # | 依赖 | 必需？ | 缺时按钮 | 检测来源 |
|---|---|---|---|---|
| **a** | **Microsoft Visual C++ 2015-2022 x64 Redistributable** | 必需 | 一个"打开微软下载页"按钮 → 用 `chrome.tabs.create({url: "https://aka.ms/vs/17/release/vc_redist.x64.exe"})` | 通过 `ctranslate2.dll` 加载结果倒推（faster-whisper 装好后才能实测，未装时显示 "待定"） |
| **b** | **Python 3.10+** | 必需 | 一个"安装 Python"按钮 → 打开 `https://www.python.org/downloads/` | 后台探针 `where python` + miniconda / Python.org 标准路径 |
| **c** | **faster-whisper** | 必需 | 一个"安装 faster-whisper"按钮 → 走后台 fetch 调 `python -m pip install --upgrade faster-whisper`，安装时 stdout 流回 UI | `/health` 端点 `deps.faster_whisper` 字段 |
| **d** | **Whisper server 是否在跑** (`start_whisper_server.bat`) | 必需 | 一个"启动 Whisper server"按钮 → 用 `chrome.tabs.create` + `chrome.tabs.executeScript` 不可行，**改用 `chrome.tabs.create({url: "file:///.../start_whisper_server.bat"})` 不被允许**——最稳：调 background.js 起一个隐藏 PowerShell 跑 `start_whisper_server.bat`（用 `chrome.runtime.connectNative` 不可行 + manifest 不允许；改用 background.js 起 `cmd.exe /c start ...` 也不允许，**最终方案是"按钮 = 弹 file:// 协议提示用户双击 bat" + "按钮旁附 bat 的绝对路径复制按钮"**） | `/health` 端点能 ping 通就 ✓ |
| **e** | **zhconv**（简繁转换） | **可选** | 一个"安装 zhconv"按钮（同样的 pip install 流），按钮旁标 `optional` 灰 badge | `/health` 端点 `deps.zhconv` 字段 |

> **关键约束**：按钮**不**静默装。安装前必须先弹一个"即将安装 X 到 Y（Python 路径）"的确认，
> 取消则 abort。这是 memory 8/30 transparency 规则的硬约束（user-explicit：agent 不能自作主张）。

---

## 2. 每个按钮的具体实现

### 2.1 a. VC++ 安装按钮
```js
chrome.tabs.create({ url: "https://aka.ms/vs/17/release/vc_redist.x64.exe" });
```
- 微软 .exe 直接下载到用户机器，UI 这一步**无能为力**（不是 pip）。
- 检测 VC++ 缺 = `whisper_server` 报 `ctranslate2.dll` 找不到（`OSError`/`FileNotFoundError`，
  已被 `whisper_server.py` 2026-09-04 patch 捕获并标 `vc_redist` missing）。

### 2.2 b. Python 3.10+ 安装按钮
```js
chrome.tabs.create({ url: "https://www.python.org/downloads/" });
```
- 引导用户去 python.org 下载；**不**自动从 winget 装（避开 UAC）。
- 提示文案：「勾选 'Add Python to PATH' 后重启浏览器」。

### 2.3 c. faster-whisper 安装按钮
- background.js 端：通过 `chrome.runtime.sendMessage({action: "pipInstall", packages: ["faster-whisper"]})`
  → background 找本机 Python（`where python` 优先 / miniconda 兜底）→ 起 child_process
  `python -m pip install --upgrade faster-whisper --user`（避免系统 pip 锁）→ 把 stdout/stderr
  流式推回 sidepanel/options 页 → 完成时弹桌面通知。
- 进度显示：行式日志 + 末尾 OK/FAIL。
- **失败处理**：网络/SSL 错 → 红 banner 提示「检查代理或换源 `pip install -i https://mirrors.aliyun.com/pypi/simple/ faster-whisper`」。

### 2.4 d. Whisper server 启动按钮
- **核心矛盾**：Chrome MV3 extension **不能**直接 `child_process.spawn('cmd.exe', ['/c', 'start_whisper_server.bat'])`——
  MV3 service worker 不允许 `child_process`（受 CSP / host_permissions 限制）。
- **现行方案**（沿用 2026-08-29）：按钮 = 弹一个 modal，告知用户「去这个路径双击 bat」+ 复制 bat 绝对路径。
  按钮行为：复制 bat 绝对路径到剪贴板 + 弹 modal「Windows 资源管理器 → 地址栏粘贴 → 回车 → 双击 `start_whisper_server.bat`」。
- 状态轮询：装好后用户点「检查系统」重新 ping `/health` → 立即 ✓。

### 2.5 e. zhconv 安装按钮（optional）
- 同 2.3（pip install 同一通道）。
- 按钮旁加 `optional` 灰 badge；缺时 whisper **仍可工作**（whisper_server 走 `zhconv=None` fallback，
  输出繁体字但不影响精度）。

---

## 3. 检查系统按钮的输出契约

5 行固定顺序（与 §1 表一致）：

```
1. Microsoft Visual C++ 2015-2022 x64     ✓ 运行库就位 / ✗ 缺，下载链接 / 灰 待装 faster-whisper 后实测
2. Python 3.10+                            ✓ 3.11.5 @ C:\Python311\python.exe / ✗ 缺，下载链接
3. faster-whisper                          ✓ 1.0.3 / ✗ 缺，一键安装按钮
4. Whisper server (start_whisper_server.bat) ✓ http://127.0.0.1:7860 reachable / ✗ 没起，启动按钮 + 复制 bat 路径
5. zhconv (optional)                       ✓ 1.4.3 / ✗ 缺（可选），一键安装按钮
```

每行有 3 个槽位：
- **状态图标**：✓（绿）/ ✗（红）/ 灰问号（待定）
- **状态文字**：版本号或缺漏说明
- **动作按钮**：根据 §1 表决定显隐

每行独立、可单独点；点 "Check system" 只刷新 5 行（不修任何东西，**read-only**）。

---

## 4. 为什么不是以前的版本

2026-09-13 用户反馈："你的这个 setup 的 guide 完全不可用。为什么不是以前的版本？"

**当前实现的状态**（你看到截图时）：
- 「Check system」按钮 **存在但默认不点**——5 行诊断结果 `hidden`，不点就看不到。
- 「Whisper server — Not running」红 X **是常驻顶行**（在 `whisperCheckResults` 之外），
  没说「点 Check system 看详情」= 用户**没意识到**有更详细的诊断。
- 「复制安装命令」「下载安装脚本」按钮**藏在诊断结果里**（5 行展开后才显示），
  用户**必须先点 Check system**才能看到这些按钮。
- placeholder `C:/Users/you/videoprocess/subtitles` 误导了用户去手填一个
  build 机的占位路径，**没自动用系统 Downloads + bilisubs 子目录**。

**修法（2026-09-13 起）**：
1. **把"5 行诊断 + 复制/下载/启动按钮"提到常驻位置**（不再藏在 `whisperCheckResults` 折叠区）。
   点 Check system 只是**刷新状态**，按钮**永远可见**。
2. **每个依赖一个独立安装按钮**（a→e 5 个），缺什么就亮什么，全部就绪就全绿。
3. **subtitle cache dir placeholder = 真实默认路径**（`C:/Users/<user>/Downloads/BiliSubs`），
   缺失时主动创建。

---

## 5. 跨项目复盘

- **CTranslate2 装完不能 import 的根因**（2026-08-30 → 09-04 经验）：
  ctranslate2 的 Windows wheel 依赖 VC++ 运行时的 3 个 DLL（msvcp140 / vcruntime140 / concrt140），
  fresh Windows 上**默认没有**。`whisper_server.py` 2026-09-04 patch 捕获 `OSError`
  并标 `vc_redist` missing 走专门的修复路径。
- **不能静默 pip install**（memory 8/30 规则）：agent 不能自作主张装包。
  每个安装按钮 = 显式确认 modal + 透明安装过程 + 失败原因原文。
- **可选 dep 不阻塞主流程**：zhconv 缺时 whisper 仍工作（输出繁体但精度不受影响）。
- **路径默认值不能写死绝对路径**（2026-09-12 经验）：会 leak build 机布局，
  一律走 `Downloads/<AppName>/` 子目录 + 浏览器自动创建。

---

## 6. 关联文件

- `options.html` — UI 容器（"Speech recognition" 段、"Subtitle cache directory" input）
- `options.js` — `renderWhisperCheckResults` 5 行诊断 + 按钮状态机
- `whisper_server.py` — `/health` 端点（VC++ / faster-whisper / zhconv 检测源）
- `start_whisper_server.bat` — 启动脚本（`MISSING_FW` / `MISSING_ZHCONV` 预检）
- `install_whisper_deps.ps1` — 手动安装脚本（被 `.bat` 引用，PowerShell 版）
- `DESIGN.md §5` — 按钮风格（.primary / .secondary / .danger）— 安装按钮统一用 `.secondary`
- `DESIGN.md §14` — info page 契约 — modal / 状态行不冲突
