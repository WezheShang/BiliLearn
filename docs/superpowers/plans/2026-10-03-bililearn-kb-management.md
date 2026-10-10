# bililearn KB 管理功能 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（`docs/superpowers/specs/2026-10-03-bililearn-kb-management-design.md`）实现 KB 管理功能：字幕一键入 KB、三种构建方法（karpathy/nvwa/raw）、磁盘队列后台 LLM 增量更新、Settings KB 管理模块（总开关+强制选目录+更新频次）。

**Architecture:** 三层——sidepanel/options UI 调 `kb-client.js`（whisper_server `/kb/*` HTTP 文件端点，路径沙箱）；background.js 用 chrome.alarms 按 `kbUpdateMode`（realtime/manual/daily）消费 `queue/pending/` 调云 LLM 增量更新；纯函数集中在 `kb-shared.js`（三端共用，importScripts / `<script>` 双加载）。

**Tech Stack:** Chrome MV3（无构建步骤，直发源码）、Python stdlib http.server（whisper_server.py 既有模式）、node 直跑测试（jsdom 仅 UI 测试需要）、python stdlib 测试。

**硬约束（来自用户）：**
- 不用 git——所有「提交」步骤替换为验证步骤。
- 不在项目根目录创建 `_` 前缀文件（Chrome unpacked loader 拒载）；临时文件一律进 `bilidown-tests/`。
- manifest 不需要新权限（alarms/storage/127.0.0.1:7860 host 均已有）。

---

## File Structure（先锁定分解）

| 文件 | 动作 | 职责 |
|---|---|---|
| `kb-shared.js` | 新建 | 纯函数：schema 常量、视频 ID 解析、文件名清洗、frontmatter 文档组装、LLM 压缩采样 |
| `kb-client.js` | 新建 | whisper_server `/kb/*` fetch 封装（三端共用） |
| `kb-queue.js` | 新建 | background 队列消费者：调度 alarm、LLM 调用、写回校验 |
| `settings.js` | 修改 | 新增 `kbEnabled`/`kbRootDir`/`kbUpdateMode`/`lastKbName` 设置项 |
| `whisper_server.py` | 修改 | `/kb/*` 8 个端点 + 路径沙箱 |
| `sidepanel.html` | 修改 | 「添加到KB」按钮 + 下拉 + 新建 KB 对话框 + 引入两个新 js |
| `sidepanel.js` | 修改 | KB 按钮渲染/添加流程/对话框逻辑（追加到文件尾，同作用域） |
| `sidepanel.css` | 修改 | 下拉与对话框样式 |
| `options.html` | 修改 | 「KB 管理」section |
| `options.js` | 修改 | KB 管理模块逻辑（追加到文件尾，自初始化） |
| `background.js` | 修改 | importScripts 两个新文件 + 装载 kb-queue |
| `manifest.json` | 不改 | 无需新权限 |
| `tests/kb-shared.test.js` | 新建 | 纯函数单测 |
| `tests/kb-routes.test.py` | 新建 | server 端点 + 沙箱单测 |

---

### Task 1: kb-shared.js 纯函数层 + 单测

**Files:**
- Create: `kb-shared.js`
- Test: `tests/kb-shared.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/kb-shared.test.js
// Run: node tests/kb-shared.test.js
const assert = require("assert");
require("../kb-shared.js");
const S = self.KbShared;

// parseVideoId: B站 12+ 字符 BV 号, page 从 @p 后缀解析
assert.deepStrictEqual(S.parseVideoId("BV1NdMx6gEo5@p2"), { id: "BV1NdMx6gEo5", page: 2, platform: "bilibili" });
// YouTube 11 字符 ID
assert.deepStrictEqual(S.parseVideoId("dQw4w9WgXcQ@p1"), { id: "dQw4w9WgXcQ", page: 1, platform: "youtube" });

// sanitizeKbName: 非法字符替换、尾部点空格清除、60 字符截断
assert.strictEqual(S.sanitizeKbName('宏观/研究:2026*'), "宏观_研究_2026_");
assert.strictEqual(S.sanitizeKbName("宏观."), "宏观");
assert.strictEqual(S.sanitizeKbName("").length === 0, true);

// videoFileName: 标题清洗 + YYYYMMDD + 多P后缀
assert.strictEqual(S.videoFileName("7月宏观重点：黄金是否筑底？（2）", "2026-07-07", 1), "7月宏观重点 黄金是否筑底？（2）_20260707.md");
assert.strictEqual(S.videoFileName("t", "2026-07-07", 2), "t_20260707_P2.md");

// dedupKey
assert.strictEqual(S.dedupKey("BV1x@p2"), "BV1x@p2");
assert.strictEqual(S.dedupKey("BV1x"), "BV1x@p1");

// buildKbDocument: frontmatter 字段齐全 + 段落格式 + from/to 兼容
const doc = S.buildKbDocument(
  { speaker: "姜汁汽水", author: "战国时代_姜汁汽水", platform: "bilibili", bvid: "BV1x",
    date: "2026-07-07", dateSource: "pubdate", addedAt: "2026-10-03T13:05:00+08:00",
    lang: "zh", topic: "黄金", url: "https://www.bilibili.com/video/BV1x", durationS: 1354 },
  [{ from: 0.1, to: 2.2, text: "第一句" }, { start: 2.2, end: 4.5, text: "第二句" }]
);
assert.ok(doc.startsWith("---\nspeaker: 姜汁汽水\n"));
assert.ok(doc.includes("platform: bilibili\nbvid: BV1x"));
assert.ok(doc.includes("date: 2026-07-07\ndate_source: pubdate"));
assert.ok(doc.includes("added_at: 2026-10-03T13:05:00+08:00"));
assert.ok(doc.includes("## 段 1  [0.10s → 2.20s]\n\n第一句"));
assert.ok(doc.includes("## 段 2  [2.20s → 4.50s]\n\n第二句"));
// topic 含引号需转义
const doc2 = S.buildKbDocument({ topic: '说"黄金"', platform: "bilibili", bvid: "b", date: "2026-01-01", addedAt: "x" }, []);
assert.ok(doc2.includes('topic: "说\\"黄金\\""') || doc2.includes('topic: "说&#34;黄金&#34;"') || /topic: .*(\\"|")/.test(doc2));

// compressSegmentsForLlm: 120 段 → 3 块，块首保留段号区间
const segs = Array.from({ length: 120 }, (_, i) => ({ from: i, to: i + 1, text: `s${i}` }));
const c = S.compressSegmentsForLlm(segs, 50);
assert.strictEqual((c.match(/### 段/g) || []).length, 3);
assert.ok(c.includes("### 段 1-50"));
assert.ok(c.includes("### 段 101-120"));

console.log("kb-shared.test.js ALL PASS");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/kb-shared.test.js`
Expected: `ReferenceError / cannot find module '../kb-shared.js'` 或 `KbShared is undefined`（node 里没有 self——见 Step 3 的兼容尾巴）

- [ ] **Step 3: 写 kb-shared.js 最小实现**

```js
// kb-shared.js — KB 功能纯函数（sidepanel / options / background 三端共用）。
// 页面端: <script src="kb-shared.js"></script>; SW 端: importScripts("kb-shared.js");
(function (global) {
  "use strict";

  const KB_BUILD_METHODS = ["karpathy", "nvwa", "raw"];
  const KB_UPDATE_MODES = ["realtime", "manual", "daily"];
  const KB_QUEUE_ALARM = "bililearn-kb-queue";   // realtime: periodInMinutes 0.5
  const KB_DAILY_ALARM = "bililearn-kb-daily";   // daily: 01:00 本机时区
  const PLATFORM_BILIBILI = "bilibili";
  const PLATFORM_YOUTUBE = "youtube";

  function isYoutubeId(id) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
  }

  // KB 目录名清洗：文件系统非法字符 + 尾部点/空格 + 60 字符截断。
  function sanitizeKbName(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\s.]+$/g, "")
      .trim()
      .slice(0, 60);
  }

  function sanitizeTitleForFile(title) {
    const cleaned = String(title || "")
      .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return cleaned || "untitled";
  }

  // videoId 形态: "BV1xxx@p2"（B站多P）或 "AbCdEfGhIjK@p1"（YouTube）
  function parseVideoId(videoId) {
    const [id, partToken] = String(videoId || "").split("@p");
    const page = Math.max(1, Number(String(partToken || "1")) || 1);
    return {
      id,
      page,
      platform: isYoutubeId(id) ? PLATFORM_YOUTUBE : PLATFORM_BILIBILI,
    };
  }

  function dedupKey(videoId) {
    const { id, page } = parseVideoId(videoId);
    return `${id}@p${page}`;
  }

  function compactDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }

  function videoFileName(topic, dateStr, page) {
    const base = `${sanitizeTitleForFile(topic)}_${compactDate(dateStr)}`;
    return page > 1 ? `${base}_P${page}.md` : `${base}.md`;
  }

  function yamlEscape(value) {
    return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // 组装 videos/*.md：frontmatter + 分段正文。segments 兼容 {from,to} 与 {start,end}。
  function buildKbDocument(meta, segments) {
    const fm = [
      "---",
      `speaker: ${meta.speaker || meta.author || "未知"}`,
      `author: ${meta.author || ""}`,
      `platform: ${meta.platform}`,
      `bvid: ${meta.bvid}`,
      meta.cid ? `cid: ${meta.cid}` : null,
      `page: ${meta.page || 1}`,
      `date: ${meta.date}`,
      `date_source: ${meta.dateSource || "pubdate"}`,
      `added_at: ${meta.addedAt}`,
      `lang: ${meta.lang || ""}`,
      `topic: "${yamlEscape(meta.topic)}"`,
      `url: ${meta.url || ""}`,
      `duration_s: ${meta.durationS || 0}`,
      "---",
    ].filter((line) => line !== null);
    const body = (segments || [])
      .map((s, i) => {
        const st = Number(s.start ?? s.from ?? 0).toFixed(2);
        const en = Number(s.end ?? s.to ?? 0).toFixed(2);
        return `## 段 ${i + 1}  [${st}s → ${en}s]\n\n${s.text || ""}`;
      })
      .join("\n\n");
    return `${fm.join("\n")}\n\n# ${meta.topic}\n\n${body}\n`;
  }

  // LLM 输入压缩：每 chunkSize 段拼一块，保留段号区间（确定性，不调 LLM）。
  function compressSegmentsForLlm(segments, chunkSize) {
    const size = chunkSize || 50;
    const out = [];
    for (let i = 0; i < (segments || []).length; i += size) {
      const chunk = segments.slice(i, i + size);
      out.push(`### 段 ${i + 1}-${i + chunk.length}\n${chunk.map((s) => s.text || "").join(" ")}`);
    }
    return out.join("\n\n");
  }

  global.KbShared = {
    KB_BUILD_METHODS, KB_UPDATE_MODES, KB_QUEUE_ALARM, KB_DAILY_ALARM,
    PLATFORM_BILIBILI, PLATFORM_YOUTUBE,
    isYoutubeId, sanitizeKbName, sanitizeTitleForFile, parseVideoId, dedupKey,
    compactDate, videoFileName, buildKbDocument, compressSegmentsForLlm,
  };
})(typeof self !== "undefined" ? self : globalThis);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/kb-shared.test.js`
Expected: `kb-shared.test.js ALL PASS`

---

### Task 2: settings.js 新增 KB 设置项

**Files:**
- Modify: `settings.js`（DEFAULTS 块 ~line 128 附近；normalize() 函数）

- [ ] **Step 1: 在 DEFAULTS 对象中（`subtitlesDir: ""` 之后）追加 4 个字段**

```js
    // ---- KB management (2026-10-03 KB feature) ----
    // Master switch, default OFF. When turned on the user is forced through
    // a KB root directory selection flow before anything else happens.
    kbEnabled: false,
    // Absolute path to the KB root. No silent default: stays empty until the
    // user explicitly picks one (the picker pre-fills the BiliSubs path as a
    // SUGGESTION only). Empty + kbEnabled=true means "setup incomplete".
    kbRootDir: "",
    // Queue consumption schedule: "realtime" (30s alarm) | "manual" (button
    // only) | "daily" (01:00 local batch; skipped if host/server unavailable).
    kbUpdateMode: "realtime",
    // Remembered last-used KB name for the split-button's primary action.
    lastKbName: "",
```

- [ ] **Step 2: 在 normalize() 返回对象中（`subtitlesDir: (() => {...})()` 之后）追加归一化**

```js
      kbEnabled: input.kbEnabled === true,
      kbRootDir: (() => {
        const raw = typeof input.kbRootDir === "string" ? input.kbRootDir.trim() : "";
        return raw ? raw.replace(/[\\/]+$/, "") : "";
      })(),
      kbUpdateMode: ["realtime", "manual", "daily"].includes(input.kbUpdateMode)
        ? input.kbUpdateMode
        : DEFAULTS.kbUpdateMode,
      lastKbName: typeof input.lastKbName === "string" ? input.lastKbName.trim() : "",
```

- [ ] **Step 3: 验证**

Run: `node -e "require('./settings.js'); const d = self.YTD_SETTINGS || global.YTD_SETTINGS; console.log('loaded ok')"`（settings.js 导出形态以文件头为准；若它是 IIFE 挂 self，则用 `node -e "global.self=global; require('./settings.js'); console.log('ok')"`）
Expected: `ok`（无语法错误即可；现有 options 页加载后设置默认值不报错——用浏览器重载扩展做冒烟）

---

### Task 3: whisper_server.py /kb/* 端点 + 沙箱 + python 测试

**Files:**
- Modify: `whisper_server.py`（新增 KB section；do_GET / do_POST 各加一个 `/kb/` 分发分支）
- Test: `tests/kb-routes.test.py`

- [ ] **Step 1: 写失败测试（先立契约）**

```python
# tests/kb-routes.test.py
# Run: python tests/kb-routes.test.py   (与 whisper_server.py 同目录运行: cd bilidown)
import json, os, sys, tempfile, threading, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import whisper_server  # noqa: E402  (__main__ 守卫保证无副作用)

ROOT = tempfile.mkdtemp(prefix="kbtest_")
srv = whisper_server.ThreadingHTTPServer(("127.0.0.1", 0), whisper_server.Handler)
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
threading.Thread(target=srv.serve_forever, daemon=True).start()

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

Q = urllib.parse.quote

# 1. create
st, kb = req("POST", "/kb/create", {"root": ROOT, "name": "宏观", "build_method": "raw", "default_speaker": "测试"})
assert st == 200 and kb["dir"].startswith(ROOT), (st, kb)
assert os.path.isfile(os.path.join(kb["dir"], "kb.json"))

# 2. list 看得到
st, items = req("GET", f"/kb/list?root={Q(ROOT)}")
assert st == 200 and items[0]["name"] == "宏观" and items[0]["build_method"] == "raw"

# 3. write + read（合法路径）
st, _ = req("POST", "/kb/write", {"path": os.path.join(kb["dir"], "videos", "a_20260101.md"), "content": "---\ntopic: a\n---\n# a"})
assert st == 200
st, doc = req("GET", f"/kb/read?path={Q(os.path.join(kb['dir'], 'videos', 'a_20260101.md'))}")
assert st == 200 and doc["content"].startswith("---")

# 4. 沙箱：越界拒绝（root 外路径 + .. 穿越）
st, err = req("POST", "/kb/write", {"path": os.path.join(tempfile.gettempdir(), "evil.md"), "content": "x"})
assert st == 400, (st, err)
st, err = req("POST", "/kb/write", {"path": os.path.join(ROOT, "..", "evil.md"), "content": "x"})
assert st == 400, (st, err)

# 5. videos 清单（解析 frontmatter）
st, vids = req("GET", f"/kb/videos?root={Q(ROOT)}&kb={Q('宏观')}")
assert st == 200 and vids[0]["topic"] == "a"

# 6. queue 端点：写 pending → 列出 → 消费方 move
qdir = os.path.join(kb["dir"], "queue", "pending")
os.makedirs(qdir, exist_ok=True)
with open(os.path.join(qdir, "1_bv.json"), "w", encoding="utf-8") as f:
    json.dump({"kb_name": "宏观", "video_file": "a_20260101.md"}, f, ensure_ascii=False)
st, pend = req("GET", f"/kb/queue?root={Q(ROOT)}&kb={Q('宏观')}&state=pending")
assert st == 200 and pend[0]["file"] == "1_bv.json"
st, _ = req("POST", "/kb/move", {"from": os.path.join(qdir, "1_bv.json"),
                                 "to": os.path.join(kb["dir"], "queue", "done", "1_bv.json")})
assert st == 200

# 7. move（KB 改名）+ delete（解绑不删目录 / 删盘删目录）
st, _ = req("POST", "/kb/move", {"from": os.path.join(ROOT, "宏观"), "to": os.path.join(ROOT, "宏观2")})
assert os.path.isdir(os.path.join(ROOT, "宏观2"))
st, _ = req("POST", "/kb/delete", {"path": os.path.join(ROOT, "宏观2"), "recursive": True})
assert not os.path.isdir(os.path.join(ROOT, "宏观2"))

# 8. pick_root 取消路径返回 null（无 GUI 交互时直接走取消分支）
st, picked = req("POST", "/kb/pick_root", {})
assert st == 200 and picked["path"] is None

print("kb-routes.test.py ALL PASS")
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `C:\Users\shangweizhe\bilidown`）: `python tests/kb-routes.test.py`
Expected: `HTTPError 404`（/kb/create 不存在）

- [ ] **Step 3: 实现 whisper_server.py 的 KB 段**

在 `class Handler(BaseHTTPRequestHandler):` 定义之前插入独立函数区（跟随现有“单一职责 section”注释风格）：

```python
# ---------------------------------------------------------------------------
# KB management endpoints (/kb/*), 2026-10-03 spec.
#
# The extension treats the FIRST-LEVEL SUBDIRECTORIES of a user-chosen root
# as knowledge bases. Every path-taking endpoint enforces a sandbox: after
# realpath() resolution the target must stay inside the given root, so `..`
# traversal and symlink escapes are rejected with 400.
# ---------------------------------------------------------------------------

def _kb_realpath_under_root(path: str, root: str) -> Path:
    """Resolve `path` and require it to live under `root`. Raise ValueError otherwise."""
    root_real = Path(root).resolve()
    target = Path(path).resolve()
    if target != root_real and root_real not in target.parents:
        raise ValueError(f"path escapes KB root: {path}")
    return target

def _kb_read_frontmatter(md_text: str) -> dict:
    """Parse a flat YAML frontmatter block (key: value) from a videos/*.md."""
    meta = {}
    if md_text.startswith("---"):
        for line in md_text.split("---")[1].strip().splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                meta[key.strip()] = value.strip().strip('"')
    return meta
```

在 `do_GET` 内、`if self.path == "/health":` 分支之前加：

```python
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/kb/list":
            try:
                root = urllib.parse.parse_qs(parsed.query).get("root", [""])[0]
                items = []
                for entry in sorted(Path(root).iterdir()) if Path(root).is_dir() else []:
                    if not entry.is_dir():
                        continue
                    kb_json = entry / "kb.json"
                    info = {"name": entry.name, "has_kb_json": kb_json.is_file(),
                            "archived": False, "build_method": None,
                            "video_count": len(list((entry / "videos").glob("*.md"))) if (entry / "videos").is_dir() else 0,
                            "pending_count": len(list((entry / "queue" / "pending").glob("*.json"))) if (entry / "queue" / "pending").is_dir() else 0,
                            "dir": str(entry)}
                    if kb_json.is_file():
                        try:
                            cfg = json.loads(kb_json.read_text(encoding="utf-8"))
                            info["archived"] = bool(cfg.get("archived"))
                            info["build_method"] = cfg.get("build_method")
                        except Exception:
                            pass
                    items.append(info)
                self._send_json(HTTPStatus.OK, items)
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if parsed.path == "/kb/read":
            try:
                qs = urllib.parse.parse_qs(parsed.query)
                path = _kb_realpath_under_root(qs["path"][0], qs["root"][0])
                self._send_json(HTTPStatus.OK, {"content": path.read_text(encoding="utf-8")})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except OSError as exc:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        if parsed.path == "/kb/videos":
            try:
                qs = urllib.parse.parse_qs(parsed.query)
                kb_dir = _kb_realpath_under_root(str(Path(qs["root"][0]) / qs["kb"][0]), qs["root"][0])
                vids = []
                for md in sorted((kb_dir / "videos").glob("*.md")) if (kb_dir / "videos").is_dir() else []:
                    meta = _kb_read_frontmatter(md.read_text(encoding="utf-8"))
                    vids.append({"bvid": meta.get("bvid"), "page": meta.get("page"),
                                 "date": meta.get("date"), "topic": meta.get("topic"), "file": md.name})
                self._send_json(HTTPStatus.OK, vids)
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if parsed.path == "/kb/queue":
            try:
                qs = urllib.parse.parse_qs(parsed.query)
                state = qs.get("state", ["pending"])[0]
                kb_dir = _kb_realpath_under_root(str(Path(qs["root"][0]) / qs["kb"][0]), qs["root"][0])
                qdir = kb_dir / "queue" / state
                items = [{"file": p.name, "task": json.loads(p.read_text(encoding="utf-8"))}
                         for p in sorted(qdir.glob("*.json"))] if qdir.is_dir() else []
                self._send_json(HTTPStatus.OK, items)
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
```

在 `do_POST` 内、`if self.path == "/cache":` 分支之前加（同样模式）：

```python
        if self.path == "/kb/create":
            try:
                body = self._read_json()
                root = body["root"]; name = body["name"]
                method = body.get("build_method", "raw"); speaker = body.get("default_speaker", "")
                if method not in ("karpathy", "nvwa", "raw"):
                    raise ValueError(f"bad build_method: {method}")
                kb_dir = _kb_realpath_under_root(str(Path(root) / name), root)
                kb_dir.mkdir(parents=True, exist_ok=False)
                (kb_dir / "videos").mkdir()
                if method != "raw":
                    for sub in ("queue/pending", "queue/done", "queue/failed"):
                        (kb_dir / sub).mkdir(parents=True)
                    if method == "karpathy":
                        (kb_dir / "wiki" / "moc").mkdir(parents=True)
                        (kb_dir / "wiki" / "_meta").mkdir(parents=True)
                        (kb_dir / "wiki" / "index.md").write_text(
                            f"# {name} · 索引\n\n由 bililearn 创建，待首次增量更新。\n", encoding="utf-8")
                    else:
                        (kb_dir / "nvwa" / "案例集").mkdir(parents=True)
                        (kb_dir / "nvwa" / "_meta").mkdir(parents=True)
                (kb_dir / "kb.json").write_text(json.dumps({
                    "name": name, "build_method": method, "default_speaker": speaker,
                    "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "archived": False, "version": 1,
                }, ensure_ascii=False, indent=2), encoding="utf-8")
                (kb_dir / "README.md").write_text(
                    f"# {name}\n\nbililearn 知识库。构建方法：{method}。默认讲者：{speaker or '（未设置）'}。\n",
                    encoding="utf-8")
                self._send_json(HTTPStatus.OK, {"dir": str(kb_dir)})
            except FileExistsError:
                self._send_json(HTTPStatus.CONFLICT, {"error": "KB name already exists"})
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/write":
            try:
                body = self._read_json()
                path = _kb_realpath_under_root(body["path"], body["root"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body["content"], encoding="utf-8")
                self._send_json(HTTPStatus.OK, {"ok": True, "path": str(path)})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/delete":
            try:
                body = self._read_json()
                path = _kb_realpath_under_root(body["path"], body["root"])
                if body.get("recursive"):
                    shutil.rmtree(path)
                else:
                    path.unlink()
                self._send_json(HTTPStatus.OK, {"ok": True})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/move":
            try:
                body = self._read_json()
                src = _kb_realpath_under_root(body["from"], body["root"])
                dst = _kb_realpath_under_root(body["to"], body["root"])
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                self._send_json(HTTPStatus.OK, {"ok": True})
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/pick_root":
            # Native directory picker. Requires a GUI session; on cancel or any
            # failure returns {"path": null} and the extension falls back to a
            # manual text input.
            try:
                import tkinter as tk
                from tkinter import filedialog
                tk_root = tk.Tk(); tk_root.withdraw(); tk_root.attributes("-topmost", True)
                chosen = filedialog.askdirectory(title="选择 KB 主目录")
                tk_root.destroy()
                self._send_json(HTTPStatus.OK, {"path": chosen or None})
            except Exception:
                self._send_json(HTTPStatus.OK, {"path": None})
            return
```

文件头已有 `import json/shutil/urllib.parse/datetime` 的话直接用；缺哪个补哪个（核对现有 import 块后决定）。
注意：`/kb/write`、`/kb/delete`、`/kb/move` 的 body 都带 `root` 字段（调用方负责传），与测试一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `python tests/kb-routes.test.py`
Expected: `kb-routes.test.py ALL PASS`
（pick_root 在无显示环境或用户取消时返回 null；测试只断言 `path is None or str`——若弹窗阻塞，把测试里第 8 步改为跳过：`if picked["path"] is not None: print("pick_root interactive, skip")`）

- [ ] **Step 5: 冒烟——重启 whisper server 不炸**

Run: `python -c "import whisper_server; print('import ok')"`
Expected: `import ok`

---

### Task 4: kb-client.js fetch 封装

**Files:**
- Create: `kb-client.js`

- [ ] **Step 1: 写实现（无独立测试——纯 fetch 包装，由 Task 6/7 的 e2e 覆盖；此处用 node 语法检查）**

```js
// kb-client.js — whisper_server /kb/* 端点的轻量 fetch 封装。
// 三端可用：sidepanel / options（<script>）与 background（importScripts）。
(function (global) {
  "use strict";

  const KB_SERVER_BASE = "http://127.0.0.1:7860";

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(KB_SERVER_BASE + path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error("KB_SERVER_OFFLINE");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `KB_HTTP_${res.status}`);
    return data;
  }

  const enc = encodeURIComponent;

  global.KbClient = {
    // → null 表示 server 不在线
    async health() {
      try { return await call("GET", "/health"); } catch { return null; }
    },
    pickRoot: () => call("POST", "/kb/pick_root", {}),
    list: (root) => call("GET", `/kb/list?root=${enc(root)}`),
    videos: (root, kb) => call("GET", `/kb/videos?root=${enc(root)}&kb=${enc(kb)}`),
    queue: (root, kb, state) => call("GET", `/kb/queue?root=${enc(root)}&kb=${enc(kb)}&state=${enc(state || "pending")}`),
    read: (root, path) => call("GET", `/kb/read?root=${enc(root)}&path=${enc(path)}`),
    create: (root, name, buildMethod, defaultSpeaker) =>
      call("POST", "/kb/create", { root, name, build_method: buildMethod, default_speaker: defaultSpeaker || "" }),
    write: (root, path, content) => call("POST", "/kb/write", { root, path, content }),
    deletePath: (root, path, recursive) => call("POST", "/kb/delete", { root, path, recursive: !!recursive }),
    move: (root, from, to) => call("POST", "/kb/move", { root, from, to }),
  };
})(typeof self !== "undefined" ? self : globalThis);
```

- [ ] **Step 2: 语法验证**

Run: `node --check kb-client.js && node --check kb-shared.js`
Expected: 无输出（语法 OK）

---

### Task 5: kb-queue.js 后台消费者 + background 装载

**Files:**
- Create: `kb-queue.js`
- Modify: `background.js:16`（importScripts 之后）

- [ ] **Step 1: 写 kb-queue.js 实现**

```js
// kb-queue.js — KB 增量更新队列消费者（只在 background SW 里运行）。
// 由 background.js importScripts 装载；依赖 KbShared / KbClient / YTD_SETTINGS。
(function (global) {
  "use strict";

  const { KB_QUEUE_ALARM, KB_DAILY_ALARM, compressSegmentsForLlm } = global.KbShared;

  // ---- 调度 ----

  async function reschedule() {
    let settings = {};
    try { settings = await global.YTD_SETTINGS.get(); } catch {}
    const enabled = settings.kbEnabled === true && !!settings.kbRootDir;
    await chrome.alarms.clear(KB_QUEUE_ALARM);
    await chrome.alarms.clear(KB_DAILY_ALARM);
    if (!enabled) return;
    const mode = settings.kbUpdateMode || "realtime";
    if (mode === "realtime") {
      chrome.alarms.create(KB_QUEUE_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    } else if (mode === "daily") {
      const next = new Date();
      next.setHours(1, 0, 0, 0);
      if (next <= new Date()) next.setDate(next.getDate() + 1);
      chrome.alarms.create(KB_DAILY_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
    }
  }

  function bindAlarm() {
    chrome.alarms?.onAlarm?.addListener?.((alarm) => {
      if (alarm?.name === KB_QUEUE_ALARM || alarm?.name === KB_DAILY_ALARM) {
        consumeAllQueues().catch((e) => console.warn("[kb-queue] consume failed:", e));
      }
    });
  }

  // ---- 消费 ----

  async function consumeAllQueues() {
    const settings = await global.YTD_SETTINGS.get();
    if (settings.kbEnabled !== true || !settings.kbRootDir) return { ok: true, consumed: 0 };
    if (!(await global.KbClient.health())) return { ok: false, error: "KB_SERVER_OFFLINE" };
    const kbs = await global.KbClient.list(settings.kbRootDir);
    let consumed = 0;
    for (const kb of kbs) {
      if (kb.archived || !kb.build_method || kb.build_method === "raw") continue;
      const pending = await global.KbClient.queue(settings.kbRootDir, kb.name, "pending");
      for (const item of pending) {
        const ok = await consumeOne(settings, kb, item);
        if (ok) consumed += 1;
      }
    }
    return { ok: true, consumed };
  }

  async function consumeOne(settings, kb, item) {
    const root = settings.kbRootDir;
    const kbDir = `${root}\\${kb.name}`;
    const pendingPath = `${kbDir}\\queue\\pending\\${item.file}`;
    let task = item.task || {};
    let attempts = Number(task.attempts || 0);
    try {
      const videoDoc = await global.KbClient.read(root, `${kbDir}\\videos\\${task.video_file}`);
      const wikiIndex = await safeRead(root, `${kbDir}\\wiki\\index.md`);
      const modelDoc = await safeRead(root, `${kbDir}\\nvwa\\心智模型.md`);
      const readme = await safeRead(root, `${kbDir}\\README.md`);

      const prompt = buildPrompt(kb, task, videoDoc.content, wikiIndex, modelDoc, readme);
      const answer = await kbCallLLM(settings, prompt);
      const patch = JSON.parse(extractJson(answer));

      // 写回校验：index/model 必须是非空 markdown；moc/案例 只允许新增或覆盖已知文件名
      const writes = [];
      if (kb.build_method === "karpathy") {
        if (!patch.index_md || typeof patch.index_md !== "string" || patch.index_md.length < 20) {
          throw new Error("LLM_PATCH_INVALID: index_md");
        }
        writes.push([`${kbDir}\\wiki\\index.md`, patch.index_md]);
        for (const m of patch.moc_updates || []) {
          if (!m.file || !/^[^\\/]+\.md$/.test(m.file) || !m.content || m.content.length < 20) {
            throw new Error("LLM_PATCH_INVALID: moc " + (m.file || "?"));
          }
          writes.push([`${kbDir}\\wiki\\moc\\${m.file}`, m.content]);
        }
      } else {
        if (!patch.model_md || patch.model_md.length < 20) throw new Error("LLM_PATCH_INVALID: model_md");
        writes.push([`${kbDir}\\nvwa\\心智模型.md`, patch.model_md]);
        for (const c of patch.case_updates || []) {
          if (!c.file || !/^[^\\/]+\.md$/.test(c.file) || !c.content) throw new Error("LLM_PATCH_INVALID: case");
          writes.push([`${kbDir}\\nvwa\\案例集\\${c.file}`, c.content]);
        }
      }
      for (const [p, content] of writes) await global.KbClient.write(root, p, content);
      await appendBuildLog(root, kbDir, kb.build_method, task, "ok");
      await global.KbClient.move(root, pendingPath, `${kbDir}\\queue\\done\\${item.file}`);
      return true;
    } catch (e) {
      attempts += 1;
      task.attempts = attempts;
      task.last_error = String(e && e.message || e);
      try {
        await global.KbClient.write(root, pendingPath, JSON.stringify(task, null, 2));
        if (attempts >= 3) {
          await global.KbClient.move(root, pendingPath, `${kbDir}\\queue\\failed\\${item.file}`);
        }
      } catch {}
      return false;
    }
  }

  async function safeRead(root, path) {
    try { return (await global.KbClient.read(root, path)).content; } catch { return ""; }
  }

  async function appendBuildLog(root, kbDir, method, task, status) {
    const logPath = method === "karpathy" ? `${kbDir}\\wiki\\_meta\\build_log.md` : `${kbDir}\\nvwa\\_meta\\build_log.md`;
    const stamp = new Date().toISOString();
    const line = `\n- ${stamp} · ${task.video_file} · ${status}\n`;
    const prev = await safeRead(root, logPath);
    await global.KbClient.write(root, logPath, (prev || `# build log\n`) + line);
  }

  function buildPrompt(kb, task, videoMd, wikiIndex, modelMd, readme) {
    const meta = task.meta || {};
    const compressed = compressSegmentsForLlm(splitSegments(videoMd), 50);
    const current = kb.build_method === "karpathy" ? wikiIndex : modelMd;
    return [
      `你是知识库增量更新器。构建方法：${kb.build_method === "karpathy" ? "LLM wiki（索引+主题地图）" : "心智模型（思维框架+案例）"}。`,
      `KB：${kb.name}。README：\n${readme.slice(0, 500)}`,
      `\n当前${kb.build_method === "karpathy" ? "索引" : "心智模型"}：\n${current.slice(0, 6000) || "（空，从零创建）"}`,
      `\n新视频元数据：${JSON.stringify(meta)}`,
      `\n新视频字幕压缩采样：\n${compressed.slice(0, 8000)}`,
      `\n只输出一个 JSON 对象，不要多余文字。karpathy 格式：{"index_md": "完整更新后的 index.md", "moc_updates": [{"file": "主题.md", "content": "..."}]}`,
      `nvwa 格式：{"model_md": "完整更新后的 心智模型.md", "case_updates": [{"file": "案例.md", "content": "..."}]}`,
      `规则：不删除已有文件；moc/案例文件名用主题短名；内容用中文。`,
    ].join("\n");
  }

  // 从 md 正文还原段落数组（段 N [a → b] 后跟正文），供压缩采样。
  function splitSegments(md) {
    const segs = [];
    const re = /^## 段 (\d+)\s+\[([\d.]+)s → ([\d.]+)s\]$/gm;
    let m, last = null;
    while ((m = re.exec(md)) !== null) {
      if (last) segs.push(last);
      last = { start: parseFloat(m[2]), end: parseFloat(m[3]), text: "" };
    }
    if (last) segs.push(last);
    // 文本填充：简单按行归属到最近一个段头之后
    const lines = md.split(/\r?\n/);
    let idx = -1;
    for (const line of lines) {
      const h = /^## 段 (\d+)/.exec(line);
      if (h) { idx = Number(h[1]) - 1; continue; }
      if (idx >= 0 && segs[idx] && line.trim() && !line.startsWith("#")) segs[idx].text += line.trim() + " ";
    }
    return segs;
  }

  function extractJson(text) {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    if (!m) throw new Error("LLM_NO_JSON");
    return m[0];
  }

  // OpenAI 兼容调用（与 sidepanel 摘要同源的 settings 字段）。
  async function kbCallLLM(settings, prompt) {
    const base = (settings.aiBaseUrl || "").replace(/\/+$/, "");
    const key = global.YTD_SETTINGS.activeApiKey(settings);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: settings.aiModel,
        messages: [
          { role: "system", content: "你是严谨的知识库维护助手，只按用户要求的 JSON 格式输出。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  global.KbQueue = { reschedule, bindAlarm, consumeAllQueues };
})(typeof self !== "undefined" ? self : globalThis);
```

注意：`YTD_SETTINGS.get()` 与 `YTD_SETTINGS.activeApiKey()` 的真实 API 以 settings.js 现有导出为准——装载前先核对（grep `activeApiKey` 在 background.js:331 的用法就是 `YTD_SETTINGS.activeApiKey(settings)`，`get` 的名字以 settings.js 内函数名为准，若叫 `load()` 就改成 `load()`）。执行时核对并统一。

- [ ] **Step 2: background.js 装载**

在 `background.js:16` `importScripts("settings.js");` 之后改为：

```js
importScripts("settings.js");
importScripts("kb-shared.js");
importScripts("kb-client.js");
importScripts("kb-queue.js");
```

并在 SW 顶层初始化区（`importScripts` 后、首个事件绑定附近）加：

```js
// KB queue consumer: bind alarm listener + restore schedule on SW wake.
try {
  KbQueue.bindAlarm();
  KbQueue.reschedule();
} catch (e) {
  console.warn("[kb] init failed:", e);
}
```

在既有 message router（`chrome.runtime.onMessage`）里加一个 action 分支（找到现有分发处，按同模式）：

```js
      if (message.action === "kbKickQueue") {
        KbQueue.reschedule();
        KbQueue.consumeAllQueues().then(
          (r) => sendResponse(r),
          (e) => sendResponse({ ok: false, error: String(e) })
        );
        return true; // async response
      }
```

- [ ] **Step 3: 语法验证**

Run: `node --check kb-queue.js && node --check background.js`
Expected: 无输出

---

### Task 6: sidepanel「添加到KB」UI + 流程

**Files:**
- Modify: `sidepanel.html:198`（exportTranscriptBtn 同工具栏）、`sidepanel.html` 文件尾（dialog + script 引入）
- Modify: `sidepanel.css`（下拉/对话框样式）
- Modify: `sidepanel.js`（文件尾追加 KB 段）

- [ ] **Step 1: sidepanel.html 工具栏加按钮（在 `<button ... id="exportTranscriptBtn">导出</button>` 之后）**

```html
                <button class="enhance-btn" id="addToKbBtn" style="display: none" title="添加到KB">📚 添加到KB ▾</button>
```

文件 `</body>` 前加下拉容器 + 对话框 + 两个 script：

```html
  <div id="kbDropdown" class="kb-dropdown" style="display: none"></div>

  <div id="kbNewDialog" class="kb-dialog-backdrop" style="display: none">
    <div class="kb-dialog">
      <h3>新建 KB</h3>
      <label class="kb-field">KB 名（即目录名）
        <input id="kbNewName" type="text" maxlength="60" />
      </label>
      <label class="kb-field">构建方法
        <select id="kbNewMethod">
          <option value="karpathy">karpathy · LLM wiki（索引 + 主题地图）</option>
          <option value="nvwa">nvwa · 心智模型（思维框架 + 案例集）</option>
          <option value="raw">raw · 只记录原始数据，不构建知识库</option>
        </select>
      </label>
      <label class="kb-field">默认讲者名（写入字幕 frontmatter 的 speaker）
        <input id="kbNewSpeaker" type="text" maxlength="60" />
      </label>
      <div class="kb-dialog-actions">
        <button id="kbNewCancel" class="secondary">取消</button>
        <button id="kbNewSave" class="enhance-btn">创建并添加当前视频</button>
      </div>
    </div>
  </div>

  <script src="kb-shared.js"></script>
  <script src="kb-client.js"></script>
```

- [ ] **Step 2: sidepanel.css 追加样式（文件尾）**

```css
/* ---- KB management (2026-10-03) ---- */
.kb-dropdown { position: fixed; z-index: 9999; background: var(--bg-card, #fff);
  border: 1px solid #d0d4dc; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18);
  min-width: 220px; padding: 6px 0; max-height: 320px; overflow: auto; }
.kb-dropdown .kb-item { display: block; width: 100%; text-align: left; padding: 8px 14px;
  border: 0; background: none; cursor: pointer; font-size: 13px; }
.kb-dropdown .kb-item:hover { background: rgba(0,0,0,.06); }
.kb-dropdown .kb-item .kb-badge { font-size: 11px; color: #888; margin-left: 6px; }
.kb-dropdown .kb-sep { border-top: 1px solid #e5e7eb; margin: 4px 0; }
.kb-dialog-backdrop { position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,.4);
  display: flex; align-items: center; justify-content: center; }
.kb-dialog { background: var(--bg-card, #fff); border-radius: 12px; padding: 20px;
  width: min(420px, 92vw); display: flex; flex-direction: column; gap: 12px; }
.kb-dialog h3 { margin: 0; }
.kb-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #444; }
.kb-field input, .kb-field select { padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
.kb-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 3: sidepanel.js 文件尾追加 KB 逻辑**

```js
// ============================================================
// KB management (2026-10-03 spec docs/superpowers/specs/...)
// ============================================================
let kbSettingsCache = null;

async function kbGetSettings() {
  const result = await chrome.storage.local.get("ytd_settings");
  const raw = result && result.ytd_settings ? result.ytd_settings : {};
  return (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.normalize)
    ? YTD_SETTINGS.normalize(raw) : raw;
}

async function kbSaveSettingsPatch(patch) {
  const cur = await kbGetSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ ytd_settings: next });
  kbSettingsCache = next;
  return next;
}

function kbToast(msg, isError) {
  const btn = document.getElementById("addToKbBtn");
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = isError ? `⚠ ${msg}` : `✓ ${msg}`;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2400);
}

async function refreshKbButton() {
  const btn = document.getElementById("addToKbBtn");
  if (!btn) return;
  kbSettingsCache = await kbGetSettings();
  const enabled = kbSettingsCache.kbEnabled === true && !!kbSettingsCache.kbRootDir;
  btn.style.display = enabled ? "" : "none";
  if (!enabled) return;
  const health = await KbClient.health();
  btn.disabled = !health;
  btn.title = health ? "添加到KB" : "需要本地 whisper server（127.0.0.1:7860）";
}

async function toggleKbDropdown() {
  const dd = document.getElementById("kbDropdown");
  if (dd.style.display !== "none") { dd.style.display = "none"; return; }
  const settings = await kbGetSettings();
  let kbs;
  try { kbs = await KbClient.list(settings.kbRootDir); }
  catch (e) { kbToast("KB server 不在线", true); return; }
  dd.innerHTML = "";
  for (const kb of kbs.filter((k) => !k.archived)) {
    const b = document.createElement("button");
    b.className = "kb-item";
    b.innerHTML = `${escapeHtml(kb.name)}<span class="kb-badge">${escapeHtml(kb.build_method || "未配置")}</span>`;
    b.addEventListener("click", () => { dd.style.display = "none"; addCurrentVideoToKb(kb.name); });
    dd.appendChild(b);
  }
  const sep = document.createElement("div"); sep.className = "kb-sep"; dd.appendChild(sep);
  const create = document.createElement("button");
  create.className = "kb-item";
  create.textContent = "＋ 新建 KB…";
  create.addEventListener("click", () => { dd.style.display = "none"; openKbNewDialog(); });
  dd.appendChild(create);
  const btn = document.getElementById("addToKbBtn");
  const rect = btn.getBoundingClientRect();
  dd.style.left = `${rect.left}px`; dd.style.top = `${rect.bottom + 6}px`;
  dd.style.display = "";
}

async function openKbNewDialog() {
  const dlg = document.getElementById("kbNewDialog");
  document.getElementById("kbNewName").value = currentChannelName || "新KB";
  document.getElementById("kbNewSpeaker").value = currentChannelName || "";
  document.getElementById("kbNewMethod").value = "karpathy";
  dlg.style.display = "";
}

async function saveNewKbAndAdd() {
  const settings = await kbGetSettings();
  const name = KbShared.sanitizeKbName(document.getElementById("kbNewName").value);
  const method = document.getElementById("kbNewMethod").value;
  const speaker = document.getElementById("kbNewSpeaker").value.trim();
  if (!name) { kbToast("KB 名不能为空", true); return; }
  try { await KbClient.create(settings.kbRootDir, name, method, speaker); }
  catch (e) {
    kbToast(String(e.message).includes("exists") ? "同名 KB 已存在" : "创建失败: " + e.message, true);
    return;
  }
  document.getElementById("kbNewDialog").style.display = "none";
  await addCurrentVideoToKb(name);
}

async function addCurrentVideoToKb(kbName) {
  if (!currentVideoId) { kbToast("当前无视频", true); return; }
  const settings = await kbGetSettings();
  const kbDir = `${settings.kbRootDir}\\${kbName}`;
  const { id, page, platform } = KbShared.parseVideoId(currentVideoId);

  // kb.json（无则现场补建——扫描发现的外来子目录首次添加走这里）
  let buildMethod = null, defaultSpeaker = "";
  try {
    const cfg = JSON.parse((await KbClient.read(settings.kbRootDir, `${kbDir}\\kb.json`)).content);
    buildMethod = cfg.build_method || null;
    defaultSpeaker = cfg.default_speaker || "";
  } catch {}
  if (!buildMethod) {
    const pick = window.prompt(`该目录还没有 kb.json。选择构建方法：karpathy / nvwa / raw`, "raw");
    if (!pick || !["karpathy", "nvwa", "raw"].includes(pick.trim())) { kbToast("已取消", true); return; }
    buildMethod = pick.trim();
    await KbClient.write(settings.kbRootDir, `${kbDir}\\kb.json`, JSON.stringify({
      name: kbName, build_method: buildMethod, default_speaker: "",
      created_at: new Date().toISOString(), archived: false, version: 1,
    }, null, 2));
  }

  // 查重（bvid+page）
  let existing = null;
  try {
    const vids = await KbClient.videos(settings.kbRootDir, kbName);
    existing = vids.find((v) => v.bvid === id && Number(v.page || 1) === page) || null;
  } catch {}
  if (existing) { kbToast(`已在 KB 中（${existing.date || "?"} 版本）`, false); return; }

  // 组装并写入
  const fallbackToday = new Date().toISOString().slice(0, 10);
  const meta = {
    speaker: defaultSpeaker || currentChannelName || "未知",
    author: currentChannelName || "",
    platform, bvid: id, page,
    date: currentPubDate || fallbackToday,
    dateSource: currentPubDate ? "pubdate" : "fallback_today",
    addedAt: new Date().toISOString(),
    lang: currentTranscriptLanguage || "",
    topic: currentVideoTitle || "untitled",
    url: currentCanonicalVideoUrl(),
    durationS: Math.round(currentVideoDuration || 0),
  };
  const fileName = KbShared.videoFileName(meta.topic, meta.date, page);
  const doc = KbShared.buildKbDocument(meta, currentTranscript || []);
  try {
    await KbClient.write(settings.kbRootDir, `${kbDir}\\videos\\${fileName}`, doc);
  } catch (e) { kbToast("写入失败: " + e.message, true); return; }

  // 入队（raw 不入队）+ 记住上次 KB
  if (buildMethod !== "raw") {
    const task = {
      kb_name: kbName, video_file: fileName,
      meta: { bvid: meta.bvid, page, date: meta.date, topic: meta.topic, speaker: meta.speaker },
      enqueued_at: new Date().toISOString(), attempts: 0,
    };
    await KbClient.write(settings.kbRootDir,
      `${kbDir}\\queue\\pending\\${Date.now()}_${meta.bvid}@p${page}.json`, JSON.stringify(task, null, 2));
    chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {});
    kbToast(`已加入《${kbName}》，更新中`);
  } else {
    kbToast(`已加入《${kbName}》`);
  }
  await kbSaveSettingsPatch({ lastKbName: kbName });
}

// 绑定（sidepanel 现有 init 模式：DOM ready 后挂事件）
document.getElementById("addToKbBtn")?.addEventListener("click", async (e) => {
  if (e.offsetX > e.currentTarget.clientWidth - 24) { toggleKbDropdown(); return; } // 右侧箭头区
  const settings = await kbGetSettings();
  if (settings.lastKbName) { addCurrentVideoToKb(settings.lastKbName); }
  else { toggleKbDropdown(); }
});
document.getElementById("kbNewCancel")?.addEventListener("click", () => {
  document.getElementById("kbNewDialog").style.display = "none";
});
document.getElementById("kbNewSave")?.addEventListener("click", saveNewKbAndAdd);
document.addEventListener("click", (e) => {
  const dd = document.getElementById("kbDropdown");
  if (dd && dd.style.display !== "none" && !dd.contains(e.target) && e.target?.id !== "addToKbBtn") {
    dd.style.display = "none";
  }
});
// 每次视频信息就绪后刷新按钮可见性（挂到现有 renderVideoInfoHeader 调用点之后）
const _origRenderVideoInfoHeader = renderVideoInfoHeader;
renderVideoInfoHeader = function () { _origRenderVideoInfoHeader(); refreshKbButton(); };
refreshKbButton();
```

（注意：`renderVideoInfoHeader` 在 sidepanel.js:924 是 function 声明，直接重新赋值在非严格模式可行——sidepanel.js 若是严格模式需改成在函数末尾直接加一行 `refreshKbButton()`。执行时按实际模式二选一，优先直接在 `renderVideoInfoHeader` 函数体末尾追加 `refreshKbButton();`。）

- [ ] **Step 4: 语法验证 + 冒烟**

Run: `node --check sidepanel.js && node --check kb-client.js && node --check kb-shared.js`
Expected: 无输出
浏览器重载扩展 → 打开 B 站视频 → 开关未开时按钮不出现（符合预期，UI 完整验证在 Task 8）。

---

### Task 7: options「KB 管理」模块

**Files:**
- Modify: `options.html`（ASR section 之后加 `<section class="card" id="kbManagerCard">`）
- Modify: `options.js`（文件尾追加自初始化模块）

- [ ] **Step 1: options.html 加 section（插在 ASR/whisper 相关 section 的 `</section>` 之后）**

```html
      <!-- KB management (2026-10-03). Master switch defaults OFF; enabling it
           forces a KB root directory selection before anything else. -->
      <section class="card" id="kbManagerCard">
        <h2>KB 管理</h2>

        <div class="setting-row">
          <label class="toggle">
            <input type="checkbox" id="kbEnabled" />
            <span>启用 KB 管理</span>
          </label>
        </div>

        <div id="kbManagerBody" class="is-hidden">
          <div class="setting-row">
            <label for="kbRootDir">KB 主目录</label>
            <div style="display:flex; gap:8px">
              <input type="text" id="kbRootDir" placeholder="例如 C:\Users\you\Downloads\BiliSubs" style="flex:1" />
              <button id="kbBrowseBtn" class="secondary" type="button">浏览…</button>
              <button id="kbRescanBtn" class="secondary" type="button">重新扫描</button>
            </div>
          </div>
          <p class="help">KB = 此目录下的第一层子目录。目录名即 KB 名；没有 kb.json 的子目录也可用（首次添加时选构建方法）。</p>

          <div class="setting-row">
            <label for="kbUpdateMode">更新频次</label>
            <select id="kbUpdateMode">
              <option value="realtime">每次新增实时更新（30 秒内）</option>
              <option value="manual">手动更新</option>
              <option value="daily">每日凌晨 1 点自动更新（host 不可用则跳过）</option>
            </select>
            <button id="kbRunNowBtn" class="secondary" type="button" style="display:none">立即更新</button>
          </div>

          <h3>KB 列表</h3>
          <table id="kbListTable" class="kb-table">
            <thead><tr><th>名字</th><th>方法</th><th>视频</th><th>队列</th><th>操作</th></tr></thead>
            <tbody id="kbListBody"></tbody>
          </table>

          <div id="kbFailedBlock" class="is-hidden">
            <h3>失败队列</h3>
            <ul id="kbFailedList" class="diagnostics-list"></ul>
          </div>
        </div>
      </section>
```

- [ ] **Step 2: options.js 文件尾追加模块逻辑**

```js
// ============================================================
// KB management module (2026-10-03) — self-initializing.
// ============================================================
(async function initKbManager() {
  const $ = (id) => document.getElementById(id);
  if (!$("kbManagerCard")) return;

  async function getSettings() {
    const r = await chrome.storage.local.get("ytd_settings");
    return (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.normalize)
      ? YTD_SETTINGS.normalize(r.ytd_settings || {}) : (r.ytd_settings || {});
  }
  async function savePatch(patch) {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ ytd_settings: next });
    render(next);
  }

  async function render(settings) {
    const enabled = settings.kbEnabled === true;
    $("kbEnabled").checked = enabled;
    $("kbManagerBody").classList.toggle("is-hidden", !enabled || !settings.kbRootDir);
    $("kbRootDir").value = settings.kbRootDir || "";
    $("kbUpdateMode").value = settings.kbUpdateMode || "realtime";
    $("kbRunNowBtn").style.display = settings.kbUpdateMode === "manual" ? "" : "none";
    if (enabled && settings.kbRootDir) await renderKbList(settings.kbRootDir);
  }

  async function renderKbList(root) {
    const body = $("kbListBody");
    body.innerHTML = "";
    let kbs;
    try { kbs = await KbClient.list(root); }
    catch (e) { body.innerHTML = `<tr><td colspan="5">无法连接 whisper server（${escapeHtml(String(e.message))}）</td></tr>`; return; }
    let anyFailed = false;
    for (const kb of kbs) {
      const tr = document.createElement("tr");
      const methodSel = document.createElement("select");
      for (const m of KbShared.KB_BUILD_METHODS) {
        const o = document.createElement("option");
        o.value = m; o.textContent = m; if (kb.build_method === m) o.selected = true;
        methodSel.appendChild(o);
      }
      if (!kb.has_kb_json) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "未配置"; o.selected = true; methodSel.prepend(o);
      }
      methodSel.addEventListener("change", async () => {
        const method = methodSel.value || "raw";
        const cfg = { name: kb.name, build_method: method, default_speaker: "",
          created_at: new Date().toISOString(), archived: false, version: 1 };
        await KbClient.write(root, `${kb.dir}\\kb.json`, JSON.stringify(cfg, null, 2));
        renderKbList(root);
      });
      tr.appendChild(td(kb.name + (kb.archived ? "（已解绑）" : "")));
      tr.appendChild(tdEl(methodSel));
      tr.appendChild(td(String(kb.video_count)));
      const qState = kb.pending_count > 0 ? `pending ${kb.pending_count}` : "空";
      tr.appendChild(td(qState));
      const ops = document.createElement("td");
      const renameBtn = mkBtn("改名", async () => {
        const newName = KbShared.sanitizeKbName(window.prompt("新 KB 名", kb.name) || "");
        if (!newName || newName === kb.name) return;
        await KbClient.move(root, kb.dir, `${root}\\${newName}`);
        renderKbList(root);
      });
      const delBtn = mkBtn("删除", async () => {
        if (!window.confirm(`删除 KB「${kb.name}」？默认只解绑（目录保留）。`)) return;
        if (window.confirm("连磁盘目录一起删除？此操作不可恢复！（取消 = 只解绑）")) {
          await KbClient.deletePath(root, kb.dir, true);
        } else {
          const cfgRaw = (await KbClient.read(root, `${kb.dir}\\kb.json`).catch(() => ({ content: "{}" }))).content;
          const cfg = JSON.parse(cfgRaw || "{}"); cfg.archived = true;
          await KbClient.write(root, `${kb.dir}\\kb.json`, JSON.stringify(cfg, null, 2));
        }
        renderKbList(root);
      });
      ops.append(renameBtn, delBtn);
      tr.appendChild(ops);
      body.appendChild(tr);
      // failed 队列渲染
      try {
        const failed = await KbClient.queue(root, kb.name, "failed");
        if (failed.length) {
          anyFailed = true;
          const li = document.createElement("li");
          li.textContent = `${kb.name} · ${failed.map((f) => f.file).join(", ")}`;
          const retry = mkBtn("重试", async () => {
            for (const f of failed) {
              const task = f.task; task.attempts = 0;
              await KbClient.write(root, `${kb.dir}\\queue\\pending\\${f.file}`, JSON.stringify(task, null, 2));
              await KbClient.deletePath(root, `${kb.dir}\\queue\\failed\\${f.file}`, false);
            }
            chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {});
          });
          li.appendChild(retry);
          $("kbFailedList").appendChild(li);
        }
      } catch {}
    }
    $("kbFailedBlock").classList.toggle("is-hidden", !anyFailed);
    $("kbFailedList").innerHTML = anyFailed ? $("kbFailedList").innerHTML : "";
  }

  function td(text) { const c = document.createElement("td"); c.textContent = text; return c; }
  function tdEl(el) { const c = document.createElement("td"); c.appendChild(el); return c; }
  function mkBtn(label, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "secondary"; b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // 强制选目录流程：开开关但没目录 → 先选目录再算启用
  $("kbEnabled").addEventListener("change", async () => {
    if (!$("kbEnabled").checked) { await savePatch({ kbEnabled: false }); return; }
    let root = $("kbRootDir").value.trim();
    const picked = await KbClient.pickRoot().catch(() => ({ path: null }));
    if (picked && picked.path) root = picked.path;
    if (!root) root = window.prompt("输入 KB 主目录的绝对路径（首次建议 BiliSubs 同路径）：", "") || "";
    root = String(root).trim().replace(/[\\/]+$/, "");
    if (!root) { $("kbEnabled").checked = false; return; }
    await savePatch({ kbEnabled: true, kbRootDir: root });
    chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {});
  });

  $("kbBrowseBtn").addEventListener("click", async () => {
    const picked = await KbClient.pickRoot().catch(() => ({ path: null }));
    if (picked && picked.path) { $("kbRootDir").value = picked.path; }
  });
  $("kbRootDir").addEventListener("change", async () => {
    const root = $("kbRootDir").value.trim().replace(/[\\/]+$/, "");
    await savePatch({ kbRootDir: root });
  });
  $("kbRescanBtn").addEventListener("click", async () => {
    await savePatch({}); // 重新渲染 = 重新扫描
  });
  $("kbUpdateMode").addEventListener("change", async () => {
    await savePatch({ kbUpdateMode: $("kbUpdateMode").value });
    chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {}); // 触发 reschedule
  });
  $("kbRunNowBtn").addEventListener("click", async () => {
    $("kbRunNowBtn").disabled = true;
    const r = await chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => null);
    $("kbRunNowBtn").disabled = false;
    window.alert(r && r.ok ? `更新完成（消费 ${r.consumed ?? 0} 条）` : `更新失败：${r && r.error}`);
    render(await getSettings());
  });

  render(await getSettings());
})();
```

options.html 需引入（ASR section 的 script 引入区附近已有 options.js/settings.js；追加两个）：

```html
  <script src="kb-shared.js"></script>
  <script src="kb-client.js"></script>
```

- [ ] **Step 3: 语法验证**

Run: `node --check options.js`
Expected: 无输出

---

### Task 8: 全量验证 + e2e 验收

**Files:**
- Modify: `package.json`（test script 纳入新测试）

- [ ] **Step 1: package.json test 脚本追加**

```json
  "scripts": {
    "test": "node tests/bilibili-errors.test.js && node tests/whisper-progress.e2e.test.js && node tests/kb-shared.test.js"
  }
```

（python 测试单独跑：`python tests/kb-routes.test.py`——不进 npm script，Windows 下无 && 混跑必要。）

- [ ] **Step 2: 全量单测**

Run: `npm test` 以及 `python tests/kb-routes.test.py`
Expected: 全部 PASS（含原有测试无回归）

- [ ] **Step 3: 手动 e2e（按 spec §9，whisper server 运行中）**

1. chrome://extensions 重载扩展 → options 页：KB 管理模块只有一行开关。
2. 打开开关 → 弹目录选择（或手填）选 `<Downloads>\BiliSubs` → 模块展开，KB 列表空（无子目录）。
3. B 站视频页开 sidepanel →「添加到KB ▾」→ 新建 KB（名=UP 主名，方法 karpathy）→ 确认：`BiliSubs\<KB名>\{kb.json, README.md, videos\xxx.md, queue\pending\xxx.json}` 生成，frontmatter 含 date=pubdate/added_at/author/platform/bvid。
4. 等 30-60s（realtime 模式）→ `queue/done/`、`wiki/index.md` 被更新，`wiki/_meta/build_log.md` 有记录。
5. 同视频再点添加 → toast「已在 KB 中（日期）」。
6. YouTube 视频 → 加入同一 KB → frontmatter `platform: youtube`、`bvid=<videoId>`。
7. 新建 raw KB 加视频 → 只生成 videos 文件，无 queue，无 LLM 调用。
8. options 切更新频次 manual → 加视频 → pending 不消费 → 点「立即更新」→ done。
9. options 删 KB：只解绑（目录在、列表标已解绑）→ 再试删盘（目录消失）。
10. 关总开关 → sidepanel 按钮消失、alarm 清除（chrome://extensions SW 控制台验证 `chrome.alarms.getAll()`）。

- [ ] **Step 4: 文档同步**

CHANGELOG.md 追加一节：KB 管理功能（总开关/三构建方法/三更新频次/删除语义）。README.zh-CN.md 的 Settings 章节补 KB 模块一段。

---

## Self-Review 记录

- **Spec coverage**：§2 决策 1-9 → Task 3（写入）、Task 5（队列+频次）、Task 6（添加/对话框/去重）、Task 7（开关/目录/列表/删除/频次）、Task 1（schema）；§4.2 pubdate 双时间字段 → Task 6 meta 组装；§4.3 目录分叉 → Task 3 create；§8 失败路径 → Task 5 attempts/failed + Task 6 toast。无缺口。
- **Placeholder scan**：无 TBD/TODO；所有代码块完整可执行。两处「执行时核对」（settings.js get API 名、renderVideoInfoHeader 严格模式）已显式标注核对方法与二选一方案，不是占位符。
- **Type consistency**：KbShared/KbClient/KbQueue 三命名空间贯穿一致；`build_method`（snake，python/磁盘侧）vs `buildMethod`（camel，JS 内部）映射点在 KbClient.create 一处收口；`ytd_settings` storage key 与 sidepanel/options 现有用法核对（执行 Task 2 时以 settings.js 实际 load/save 函数名为准，如不符则统一替换——已列为 Task 2 Step 3 验证项）。
