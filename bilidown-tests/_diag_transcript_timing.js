// 计时探针：B站「确实没有字幕」的视频，fetchTranscript 到底耗时多久？
//
// 2026-11-05。用户报：真没字幕的视频要 load 半天（45 秒）才提示
// "请先在设置里配置字幕缓存目录 / 后台没有响应：读取字幕超时"。
//
// 这个探针用**真实的 background.js**（+ settings/kb-* 依赖）跑一遍
// handleFetchTranscript，在每个阶段打时间戳，定位到底哪一步在等。
//
// 关键模拟点：
//   - B 站 API 立刻返回（实测经代理 0.2s）
//   - 本地 whisper server 立刻 404（实测 0.8s）
//   - **页面上下文**：钩子在 / 不在，两种情况都测
//     · 不在 → content.js 探测超时 → background 注入钩子 → 重试
//     · 在   → 秒回 no_tracks
//
// 用法：node bilidown-tests\_diag_transcript_timing.js

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BVID = "BV1ed4b6rE5G";
const CID = "43352328905";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra !== undefined ? " :: " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra !== undefined ? " :: " + extra : ""}`);
  }
}

/**
 * 从 content.js 源码里读出真实的探测/重试超时值。
 *
 * 2026-11-05: 之前这里是写死的 3000/12000，content.js 改成 1500/6000
 * 之后探针还在用旧值 —— 探针"过期"会伪装成"产品没修好"。
 * 教训：超时值属于源码事实，探针必须动态读，不能抄。
 */
function readRealTimeouts() {
  const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const pick = (name) => {
    const m = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\d+)"));
    if (!m) throw new Error("content.js 里找不到 " + name);
    return Number(m[1]);
  };
  return {
    probeMs: pick("BILIBILI_SUBTITLE_PROBE_TIMEOUT_MS"),
    retryMs: pick("BILIBILI_SUBTITLE_TIMEOUT_MS"),
  };
}

const REAL_TIMEOUTS = readRealTimeouts();
console.log(
  "  （content.js 真实超时：探测 " +
    REAL_TIMEOUTS.probeMs +
    "ms / 重试 " +
    REAL_TIMEOUTS.retryMs +
    "ms）",
);

/**
 * @param {object} opts
 * @param {boolean} opts.hookPresent  主世界钩子是否已注入
 * @param {number}  opts.probeMs      content.js 的探测超时（默认读源码真实值）
 * @param {number}  opts.retryMs      注入后的重试超时（默认读源码真实值）
 */
function makeHarness(opts) {
  const messageListeners = [];
  const timeline = [];
  const t0 = Date.now();
  const mark = (label) => timeline.push({ label, ms: Date.now() - t0 });

  const api = {
    storage: {
      local: {
        get: (key, cb) => {
          const value = {
            ytd_settings: {
              whisperUrl: "http://127.0.0.1:7860",
              subtitlesDir: "C:/Users/shangweizhe/bilibilisubs",
              // 必须显式设 whisper —— background 只有在 asrProvider==="whisper"
              // 时才走 WHISPER_NEEDED 分支（否则落 NO_TRANSCRIPT → ASR 向导）。
              // 漏了这个字段，探针会误报成"产品 bug"。
              asrProvider: "whisper",
              aiApiKey: "",
              aiModel: "glm-4.6",
              aiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
              language: "zh-CN",
              minimaxAsrApiKey: "",
              minimaxAsrModel: "minimax-01",
              supadataApiKey: "",
            },
          };
          if (typeof cb === "function") cb(value);
          return Promise.resolve(value);
        },
        set: (obj, cb) => {
          if (typeof cb === "function") cb();
          return Promise.resolve();
        },
        remove: (k, cb) => {
          if (typeof cb === "function") cb();
          return Promise.resolve();
        },
        setAccessLevel: () => Promise.resolve(),
      },
      session: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
    },
    runtime: {
      id: "fake-extension-id",
      lastError: null,
      sendMessage: () => Promise.resolve({ ok: true }),
      getURL: (p) => `chrome-extension://fake/${p}`,
      openOptionsPage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    tabs: {
      query: (q, cb) => {
        const tabs = [{ id: 1, url: VIDEO_URL, active: true }];
        if (typeof cb === "function") cb(tabs);
        return Promise.resolve(tabs);
      },
      get: (id, cb) => {
        const tab = { id: 1, url: VIDEO_URL, active: true };
        if (typeof cb === "function") cb(tab);
        return Promise.resolve(tab);
      },
      // 关键：模拟内容脚本与主世界钩子的往返
      // 注意：真实 chrome.tabs.sendMessage 返回 Promise，回调只在老式
      // chrome.* API 里有。这里必须走 Promise，否则 background 侧的
      // await 拿到的会是 undefined（探针上一版就栽在这）。
      sendMessage: (tabId, msg) => {
        mark(`sendMessage:${msg.action}`);
        if (msg.action !== "getBilibiliOfficialSubtitles") {
          return Promise.resolve({ success: true });
        }
        // background 注入钩子后的重试请求会带 timeoutMs —— 记录下来，
        // 用来断言 background 的重试超时和 content.js 的长超时一致。
        if (typeof msg.timeoutMs === "number") {
          mark(`retry timeoutMs=${msg.timeoutMs}`);
        }
        // getBilibiliOfficialSubtitles
        if (!opts.hookPresent) {
          // 钩子不在 → content.js 探测超时后回 hook_missing
          const wait = opts.probeMs ?? REAL_TIMEOUTS.probeMs;
          return new Promise((resolve) => {
            setTimeout(() => {
              mark("content.js 回 hook_missing");
              resolve({
                success: false,
                reason: "hook_missing",
                error: "页面主世界钩子没有回话（扩展刚更新过，钩子需要重新注入）。",
                tracks: [],
              });
            }, wait);
          });
        }
        // 钩子在 → 秒回 no_tracks（这个视频确实没字幕）
        return new Promise((resolve) => {
          setTimeout(() => {
            mark("content.js 回 no_tracks");
            resolve({
              success: false,
              reason: "no_tracks",
              error: "B 站未返回任何字幕轨。",
              needLogin: false,
              tracks: [],
            });
          }, 20);
        });
      },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    windows: {
      getCurrent: () => Promise.resolve({ id: 1 }),
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: () => {} },
    },
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(),
      setOptions: () => Promise.resolve(),
      open: () => Promise.resolve(),
    },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: () => {},
      setTitle: () => {},
      setIcon: () => {},
    },
    alarms: {
      onAlarm: { addListener: () => {} },
      create: () => {},
      clear: () => Promise.resolve(true),
      getAll: () => Promise.resolve([]),
      onAlarm: { addListener: () => {} },
    },
    notifications: {
      onClicked: { addListener: () => {} },
      create: () => {},
    },
    downloads: {
      download: (o, cb) => {
        if (typeof cb === "function") cb(1);
        return 1;
      },
      open: () => {},
      onChanged: { addListener: () => {}, removeListener: () => {} },
      search: (q, cb) => {
        if (typeof cb === "function") cb([]);
      },
    },
    scripting: {
      executeScript: (opts, cb) => {
        mark(`executeScript:${(opts.files || []).join(",")}${opts.world ? ":" + opts.world : ""}`);
        // 注入 MAIN world 钩子后，钩子就真的在了 —— 后续请求会秒回。
        // （这一条决定了场景 B 的耗时：注入后不该再等一个探测周期。）
        opts.hookPresent = true;
        if (typeof cb === "function") cb([]);
        return Promise.resolve([]);
      },
    },
    declarativeNetRequest: {
      updateSessionRules: () => Promise.resolve(),
      getSessionRules: () => Promise.resolve([]),
    },
    nativeMessaging: { connectNative: () => ({ onMessage: { addListener: () => {} } }) },
  };

  const fakeFetch = (url) => {
    const u = String(url);
    mark(`fetch:${u.slice(0, 60)}`);
    if (u.includes("api.bilibili.com/x/web-interface/view")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            code: 0,
            data: {
              bvid: BVID,
              title: "测试视频",
              pubdate: 1700000000,
              owner: { name: "测试UP" },
              pages: [{ cid: CID, part: "1" }],
            },
          }),
      });
    }
    if (u.includes("api.bilibili.com/x/player/wbi/v2")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            code: 0,
            data: { bvid: BVID, cid: CID, subtitle: { subtitles: [] } },
          }),
      });
    }
    if (u.includes("127.0.0.1:7860/local-file")) {
      // 2026-11-05 实测（真实 server 打真实目录，1204 个文件）：
      //   优化前 3091ms → 优化后 178ms
      // 优化前这个探针把它当"立刻 404"，整条链路的耗时被低估了 3 秒 ——
      // 探针"绿"了，用户那边还是慢。这里按**优化后**的真实延迟模拟。
      mark("  ↳ 模拟 /local-file 真实延迟 ~180ms（优化前 3091ms）");
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
          180,
        ),
      );
    }
    if (u.includes("127.0.0.1:7860/cache")) {
      // 实测 ~55ms（优化前 633ms）
      mark("  ↳ 模拟 /cache 真实延迟 ~60ms（优化前 633ms）");
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
          60,
        ),
      );
    }
    if (u.includes("/health")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("fetch not stubbed: " + u));
  };

  return { api, fakeFetch, messageListeners, timeline, mark };
}

/**
 * 断言两个本地查找是**并行发起**的（2026-11-05 新增）。
 *
 * 背景：/local-file（3.1s）和 /cache（0.6s）原来是**串行**的 →
 * 3.7s 白等。现在必须同时发出，总耗时 = max 而不是 sum。
 *
 * 判据：两个请求的发出时刻差 < 200ms（而不是相差 3.1s）。
 */
function assertParallelFetch(harness) {
  const localMark = harness.timeline.find((t) =>
    t.label.includes("/local-file"));
  const cacheMark = harness.timeline.find((t) => t.label.includes("/cache?"));
  if (!localMark || !cacheMark) {
    return { ok: false, detail: "两个请求没有都发出" };
  }
  const gap = Math.abs(localMark.ms - cacheMark.ms);
  return {
    ok: gap < 200,
    detail: `发出时刻相差 ${gap}ms（local-file@${localMark.ms}ms, cache@${cacheMark.ms}ms）`,
  };
}

function loadBackground(harness) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://fake/background.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.chrome = harness.api;
  dom.window.fetch = harness.fakeFetch;
  dom.window.importScripts = () => {};
  dom.window.console.error = () => {};
  const bundle = ["settings.js", "kb-shared.js", "kb-client.js", "kb-queue.js", "background.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n;\n");
  dom.window.eval(bundle);
  return dom;
}

function sendMessage(dom, message, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const listeners = dom.window.__messageListeners || [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`消息超时：${message.action}`));
    }, timeoutMs);
    for (const fn of listeners) {
      const ret = fn(message, { tab: { id: 1 } }, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(resp);
      });
      if (ret === true) continue;
    }
    if (!settled && listeners.length === 0) {
      clearTimeout(timer);
      reject(new Error("background.js 没有注册 onMessage 监听器"));
    }
  });
}

async function runScenario(opts) {
  const harness = makeHarness(opts);
  const dom = loadBackground(harness);
  dom.window.__messageListeners = harness.messageListeners;
  const started = Date.now();
  const response = await sendMessage(dom, {
    action: "fetchTranscript",
    videoId: BVID,
    videoUrl: VIDEO_URL,
    pageNumber: 1,
  });
  return { response, harness, elapsed: Date.now() - started };
}

async function main() {
  // ---- 场景 A：钩子已在（用户已刷新过扩展 / 页面重新加载过）----
  console.log("\n== 场景 A：主世界钩子已注入 ==");
  {
    const { response, harness, elapsed } = await runScenario({ hookPresent: true });
    console.log("  时间线：");
    for (const t of harness.timeline) console.log(`    ${String(t.ms).padStart(6)}ms  ${t.label}`);
    console.log(`  总耗时 ${elapsed}ms`);
    check("A1 回包是 WHISPER_NEEDED", response?.error === "WHISPER_NEEDED", response?.error);
    check("A2 回了 cacheDir", String(response?.cacheDir || "").length > 0, response?.cacheDir);
    check("A3 没有超时（< 5s）", elapsed < 5000, `${elapsed}ms`);
    const par = assertParallelFetch(harness);
    check("A4 两个本地查找并行发出（不是串行 3.7s）", par.ok, par.detail);
    check(
      "A5 整条链路 < 5s（用户抱怨'正在获取字幕'卡很久）",
      elapsed < 5000,
      `${elapsed}ms`,
    );
  }

  // ---- 场景 B：钩子不在（扩展刚重载，页面还是旧的）----
  console.log("\n== 场景 B：主世界钩子缺失（扩展刚重载）==");
  {
    const { response, harness, elapsed } = await runScenario({ hookPresent: false });
    console.log("  时间线：");
    for (const t of harness.timeline) console.log(`    ${String(t.ms).padStart(6)}ms  ${t.label}`);
    console.log(`  总耗时 ${elapsed}ms`);
    check("B1 回包是 WHISPER_NEEDED", response?.error === "WHISPER_NEEDED", response?.error);
    check("B2 回了 cacheDir", String(response?.cacheDir || "").length > 0, response?.cacheDir);
    check("B3 触发了钩子注入", harness.timeline.some((t) => t.label.includes("bilibili-subtitle-hook.js")), harness.timeline.map((t) => t.label).join(" | "));
    check(
      "B4 没有超时（< 20s）",
      elapsed < 20000,
      `${elapsed}ms —— 这是用户抱怨的 45 秒超时的来源`,
    );
    // background 重试时的 timeoutMs 必须和 content.js 的长超时一致，
    // 否则一边 6s 一边 1.5s，重试会被 content.js 提前砍掉。
    const retryMark = harness.timeline.find((t) => t.label.startsWith("retry timeoutMs="));
    const retryTimeout = retryMark
      ? Number(retryMark.label.split("=")[1])
      : null;
    check(
      "B5 background 重试超时 = content.js 长超时",
      retryTimeout === REAL_TIMEOUTS.retryMs,
      `background=${retryTimeout} content.js=${REAL_TIMEOUTS.retryMs}`,
    );
    check(
      "B6 探测超时 < 3s（用户抱怨判断有无字幕要等 45s）",
      REAL_TIMEOUTS.probeMs <= 3000,
      `probe=${REAL_TIMEOUTS.probeMs}ms`,
    );
    const parB = assertParallelFetch(harness);
    check("B7 两个本地查找并行发出", parB.ok, parB.detail);
  }

  console.log(
    `\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`,
  );
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE CRASHED:", err);
  process.exit(1);
});
