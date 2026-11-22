/**
 * 「启动 Whisper server」按钮的端口判定与就绪回传 —— 回归测试（2026-11-22）。
 *
 * 用户报障：点「启动 Whisper server」→ 按钮显示"已拉起 — 等待服务就绪…"，
 * 然后报「Whisper server —— 未启动」。
 *
 * 真机现场（2026-11-22 17:20-17:30）：
 *   · 扩展的 whisperUrl 当时被留在备用端口 7861（11-06 的自动修复切的），
 *     而 7861 上什么都没有；
 *   · 7860 上跑着开机自启拉起的新代码实例（/health 带 model_resolution）；
 *   · 旧逻辑探到 7860 是新代码 → 把 whisperUrl 切回 7860 —— **但没有把
 *     新 URL 回传给调用方**。options 页于是继续拿**页面上的旧文本**
 *     （whisperUrlText 只在页面加载时写一次）去轮询 7861 → 90 秒超时 →
 *     明明自愈成功了，界面却说"未启动"。
 *
 * 第二个 bug（同一段代码）：旧逻辑只在 `configuredPort !== 7860` 时才探测，
 * 于是配置已经是 7860 时**盲目再拉一个实例**。Windows 的 SO_REUSEADDR
 * 允许两个进程绑同一个端口 → 两个 server 抢 7860 → 时好时坏。
 * （真机实测过：netstat 同时显示 7376 和 9708 都在 LISTENING 7860。）
 *
 * 这个测试用 JSDOM 加载**真实的 background.js**，用假 fetch 打桩各端口上
 * "/health 有什么"，用 chrome.runtime.sendNativeMessage 记录 native 启动
 * 调用，然后走真实的 onMessage 通道断言行为。
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------- 迷你断言框架（沿用仓库里其它测试的写法） ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assertEqual ${label}\n  expected: ${e}\n  actual:   ${a}`);
}

// 新代码的 /health：带 model_resolution。
const FRESH_HEALTH = {
  ok: true,
  model_resolution: {
    hf_hub_cache: "C:/Users/test/.cache/huggingface/hub",
    hf_home: "C:/Users/test/.cache/huggingface",
    search_roots: ["C:/Users/test/.cache/huggingface/hub"],
    local_models: ["base"],
  },
};
// 旧代码的 /health：没有 model_resolution 字段。
const STALE_HEALTH = { ok: true };

/**
 * @param {object} opts
 *   opts.whisperUrl  扩展当前配置的 whisperUrl
 *   opts.ports      { 7860: "fresh" | "stale" } —— 各端口上 /health 有什么；
 *                    没列出来的端口 = 连不上
 */
function makeHarness(opts = {}) {
  const settings = {
    asrProvider: "whisper",
    whisperUrl: opts.whisperUrl || "http://127.0.0.1:7860",
    whisperModel: "base",
    whisperLanguage: "",
    subtitlesDir: "C:/Users/test/Downloads/BiliSubs",
    exportDir: "C:/Users/test/Downloads",
    aiApiKey: "",
    aiModel: "glm-4.6",
    aiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    language: "zh-CN",
    minimaxAsrApiKey: "",
    minimaxAsrModel: "asr-1.0",
    supadataApiKey: "",
  };

  const localStore = { ytd_settings: settings };
  const sessionStore = {};
  const messageListeners = [];
  const nativeLaunchCalls = [];
  const launchedPorts = new Set();

  const api = {
    storage: {
      local: {
        get: (key, cb) => {
          let value;
          if (typeof key === "string") value = { [key]: localStore[key] };
          else if (Array.isArray(key))
            value = key.reduce((acc, k) => ((acc[k] = localStore[k]), acc), {});
          else value = { ...localStore };
          if (typeof cb === "function") {
            try {
              cb(value);
            } catch (_e) {}
          }
          return Promise.resolve(value);
        },
        set: (obj, cb) => {
          Object.assign(localStore, obj);
          if (typeof cb === "function") {
            try {
              cb();
            } catch (_e) {}
          }
          return Promise.resolve();
        },
        remove: (key, cb) => {
          const arr = Array.isArray(key) ? key : [key];
          arr.forEach((k) => delete localStore[k]);
          if (typeof cb === "function") {
            try {
              cb();
            } catch (_e) {}
          }
          return Promise.resolve();
        },
        setAccessLevel: () => Promise.resolve(),
      },
      session: {
        get: (key) =>
          Promise.resolve(
            typeof key === "string" ? { [key]: sessionStore[key] } : { ...sessionStore },
          ),
        set: (obj) => {
          Object.assign(sessionStore, obj);
          return Promise.resolve();
        },
        remove: (key) => {
          const arr = Array.isArray(key) ? key : [key];
          arr.forEach((k) => delete sessionStore[k]);
          return Promise.resolve();
        },
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
      // native 启动器：记录调用，并模拟"端口上的 server 起来了"。
      sendNativeMessage: (name, payload, cb) => {
        nativeLaunchCalls.push(payload);
        if (payload && payload.port) launchedPorts.add(Number(payload.port));
        if (typeof cb === "function") {
          setTimeout(() => cb({ success: true }), 0);
        }
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD" }]),
      get: () => Promise.resolve({ id: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD" }),
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
      setBadgeText: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setIcon: () => Promise.resolve(),
    },
    alarms: {
      onAlarm: { addListener: () => {} },
      create: () => {},
      clear: () => Promise.resolve(true),
    },
    notifications: { onClicked: { addListener: () => {} }, create: () => {} },
    downloads: {
      download: (o, cb) => {
        if (typeof cb === "function") {
          try {
            cb(1);
          } catch (_e) {}
        }
        return 1;
      },
      open: () => {},
      onChanged: { addListener: () => {}, removeListener: () => {} },
      search: (q, cb) => {
        if (typeof cb === "function") {
          try {
            cb([]);
          } catch (_e) {}
        }
      },
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    declarativeNetRequest: {
      updateSessionRules: () => Promise.resolve(),
      getSessionRules: () => Promise.resolve([]),
    },
    nativeMessaging: { connectNative: () => ({ onMessage: { addListener: () => {} } }) },
  };

  const fakeFetch = (url) => {
    const u = String(url);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/health$/.exec(u);
    if (m) {
      const port = Number(m[1]);
      const state = (opts.ports || {})[port];
      if (state === "fresh") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FRESH_HEALTH) });
      }
      if (state === "stale") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STALE_HEALTH) });
      }
      // 还没被拉起 → 连不上；被拉起过 → 起来了（新代码）。
      if (launchedPorts.has(port)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FRESH_HEALTH) });
      }
      return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:" + port));
    }
    return Promise.reject(new Error("fetch not stubbed: " + u));
  };

  return { api, fakeFetch, messageListeners, nativeLaunchCalls, localStore };
}

function loadBackground(harness) {
  const html = "<!doctype html><html><body></body></html>";
  const dom = new JSDOM(html, {
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

/** 通过真实的 onMessage 通道发一条消息并等回包。 */
function sendMessage(dom, message, timeoutMs = 15000) {
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

async function runAction(action, opts) {
  const harness = makeHarness(opts);
  const dom = loadBackground(harness);
  dom.window.__messageListeners = harness.messageListeners;
  const response = await sendMessage(dom, { action });
  return { response, harness };
}

async function main() {
  console.log("\n[1] 配置端口上已经跑着新代码 → 不能再拉一个实例（同端口双进程 = 时好时坏）");
  {
    const { response, harness } = await runAction("launchWhisperServerOnce", {
      whisperUrl: "http://127.0.0.1:7860",
      ports: { 7860: "fresh" },
    });
    assertTrue(response && response.success, "启动请求成功");
    assertEqual(response.alreadyRunning, true, "回包标明「已经在跑」");
    assertEqual(response.whisperUrl, "http://127.0.0.1:7860", "回包带上了生效的 URL");
    assertEqual(harness.nativeLaunchCalls.length, 0, "没有调用 native 启动器");
    record("1.1 已经在跑就不再拉第二个实例", true);
  }

  console.log("\n[2] 配置端口不通、7860 是新代码 → 自愈切回 7860，并把新 URL 回传（用户报的那个）");
  {
    const { response, harness } = await runAction("launchWhisperServerOnce", {
      whisperUrl: "http://127.0.0.1:7861",
      ports: { 7860: "fresh" },
    });
    assertTrue(response && response.success, "启动请求成功");
    assertEqual(response.switchedTo, 7860, "回包标明切到了 7860");
    // 这条是用户报障的根因：旧代码不回传 URL，options 页只能拿页面上的
    // 旧文本去轮询 → 一直打 7861 → 90 秒超时 → 报「未启动」。
    assertEqual(
      response.whisperUrl,
      "http://127.0.0.1:7860",
      "回包带上了切换之后的 URL（options 页据此轮询）",
    );
    assertEqual(
      harness.localStore.ytd_settings.whisperUrl,
      "http://127.0.0.1:7860",
      "存储里的 whisperUrl 也切回了 7860",
    );
    assertEqual(harness.nativeLaunchCalls.length, 0, "自愈不需要再拉实例");
    record("2.1 自愈切回 7860 并回传新 URL", true);
  }

  console.log("\n[3] 配置端口上跑的是旧代码 → 不在同一个端口再拉一个");
  {
    const { response, harness } = await runAction("launchWhisperServerOnce", {
      whisperUrl: "http://127.0.0.1:7860",
      ports: { 7860: "stale" },
    });
    assertTrue(response && response.success, "启动请求成功");
    assertEqual(harness.nativeLaunchCalls.length, 1, "拉起了一个新实例");
    const usedPort = Number(harness.nativeLaunchCalls[0].port);
    assertTrue(
      usedPort !== 7860,
      "新实例起在备用端口上，不在旧代码占着的 7860",
    );
    assertEqual(
      response.whisperUrl,
      `http://127.0.0.1:${usedPort}`,
      "回包带上了新实例的 URL",
    );
    record("3.1 旧代码端口不再叠实例，改用备用端口", true);
  }

  console.log("\n[4] 两边都不通 → 在配置端口上拉起");
  {
    const { response, harness } = await runAction("launchWhisperServerOnce", {
      whisperUrl: "http://127.0.0.1:7860",
      ports: {},
    });
    assertTrue(response && response.success, "启动请求成功");
    assertEqual(harness.nativeLaunchCalls.length, 1, "拉起了一个实例");
    assertEqual(Number(harness.nativeLaunchCalls[0].port), 7860, "起在配置端口上");
    assertEqual(
      response.whisperUrl,
      "http://127.0.0.1:7860",
      "回包带上了配置端口",
    );
    record("4.1 空端口上按配置端口拉起", true);
  }

  console.log("\n[5] repairWhisperServer：备用端口上已有健康新实例 → 不重复拉起");
  {
    const { response, harness } = await runAction("repairWhisperServer", {
      whisperUrl: "http://127.0.0.1:7860",
      ports: { 7860: "stale", 7861: "fresh" },
    });
    assertTrue(response && response.success, "修复请求成功");
    assertEqual(response.alreadyRunning, true, "回包标明「已经在跑」");
    assertEqual(response.whisperUrl, "http://127.0.0.1:7861", "切到了备用端口");
    assertEqual(harness.nativeLaunchCalls.length, 0, "没有重复拉起");
    record("5.1 备用端口已有新实例 → 直接切过去", true);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length) {
    console.log(`==== ${results.length - failed.length}/${results.length} checks passed ====`);
    process.exit(1);
  }
  console.log(`==== ${results.length}/${results.length} checks passed ====`);
}

main().catch((e) => {
  console.error("");
  console.error("❌ 测试失败：", e && e.message ? e.message : e);
  process.exit(1);
});
