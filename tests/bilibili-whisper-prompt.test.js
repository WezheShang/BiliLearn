/**
 * B 站「没有官方字幕 → 必须给出 Whisper 转录页」的后台端到端回归。
 *
 * 为什么要有这个测试（2026-10-27）：
 *   用户反馈「视频没有 B 站字幕的时候不出现 Whisper 转录页面」。
 *   之前这条链路只有源码级断言，没跑过真实的后台代码 ——
 *   万一 B 站分支里任何一步抛错（风控 / 网络 / bvid-cid 对不上），
 *   整条 handleFetchTranscript 会掉进外层 catch，只回一句 error，
 *   侧边栏就只剩「重新尝试」，Whisper 那条出路直接消失 = 死路。
 *
 * 这个测试用 JSDOM 加载**真实的 background.js**（连同 settings.js /
 * kb-*.js），用假 fetch 打桩 B 站接口和本地 whisper server，
 * 然后通过真实的 chrome.runtime.onMessage 通道发 fetchTranscript，
 * 断言后台的回包必须是 WHISPER_NEEDED。
 *
 * 覆盖四种场景：
 *   1. 官方字幕列表为空（正常「B 站没字幕」）→ WHISPER_NEEDED
 *   2. 官方字幕接口直接抛错（风控 / 断网）   → WHISPER_NEEDED + 原因
 *   3. 连视频信息接口都抛错（最外层 catch）   → WHISPER_NEEDED + 原因
 *   4. asrProvider = none（没选语音识别）      → NO_TRANSCRIPT
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

const BVID = "BV1xx411c7mD";
const CID = 62131;
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;

/**
 * 造一个最小可用的 chrome.* 垫片 + 假 fetch。
 * @param {object} opts
 *   opts.asrProvider      设置里的语音识别来源（whisper / none）
 *   opts.playerThrows     true = 官方字幕接口抛错
 *   opts.viewThrows       true = 视频信息接口抛错
 *   opts.playerSubtitles  官方字幕列表（默认空数组 = B 站没字幕）
 */
function makeHarness(opts = {}) {
  const settings = {
    asrProvider: opts.asrProvider || "whisper",
    whisperUrl: "http://127.0.0.1:7860",
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
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: VIDEO_URL }]),
      get: () => Promise.resolve({ id: 1, url: VIDEO_URL }),
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
    notifications: {
      onClicked: { addListener: () => {} },
      create: () => {},
    },
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

  const fetchCalls = [];
  const fakeFetch = (url) => {
    fetchCalls.push(String(url));
    const u = String(url);
    if (u.includes("api.bilibili.com/x/web-interface/view")) {
      if (opts.viewThrows) return Promise.reject(new Error("Failed to fetch"));
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
      if (opts.playerThrows) return Promise.reject(new Error("Failed to fetch"));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            code: 0,
            data: {
              bvid: BVID,
              cid: CID,
              subtitle: { subtitles: opts.playerSubtitles || [] },
            },
          }),
      });
    }
    // 本地 whisper server：本地文件 / 缓存都查不到（这是本测试的前提）
    if (u.includes("127.0.0.1:7860/local-file") || u.includes("127.0.0.1:7860/cache")) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    if (u.includes("/health")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("fetch not stubbed: " + u));
  };

  return { api, fakeFetch, fetchCalls, messageListeners };
}

/** 加载真实的 background.js（含它 importScripts 的依赖）到 JSDOM。 */
function loadBackground(harness) {
  const html = "<!doctype html><html><body></body></html>";
  const dom = new JSDOM(html, {
    url: "chrome-extension://fake/background.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.chrome = harness.api;
  dom.window.fetch = harness.fakeFetch;
  dom.window.importScripts = () => {}; // 依赖文件已经拼在下面了，import 本身是空操作
  dom.window.console.error = () => {}; // 预期的异常路径会打日志，测试里不刷屏

  const bundle = ["settings.js", "kb-shared.js", "kb-client.js", "kb-queue.js", "background.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n;\n");
  dom.window.eval(bundle);
  return dom;
}

/** 通过真实的 onMessage 通道发一条消息并等回包。 */
function sendMessage(dom, message, timeoutMs = 8000) {
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
      if (ret === true) continue; // 异步回包，等 sendResponse
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
  // 垫片里 addListener 会把监听器 push 进 messageListeners，
  // background.js 加载完就能拿到真实的监听器数组。
  dom.window.__messageListeners = harness.messageListeners;
  const response = await sendMessage(dom, {
    action: "fetchTranscript",
    videoId: BVID,
    videoUrl: VIDEO_URL,
    pageNumber: 1,
  });
  return { response, harness };
}

async function main() {
  console.log("\n[1/4] B 站没官方字幕（正常情况）→ 必须给出 Whisper 转录页…");
  {
    const { response } = await runScenario({});
    assertTrue(response, "后台有回包");
    assertEqual(response.success, false, "success 应为 false");
    assertEqual(
      response.error,
      "WHISPER_NEEDED",
      "没有字幕时必须回 WHISPER_NEEDED（侧边栏据此渲染 Whisper 按钮）",
    );
    assertTrue(
      String(response.cacheDir || "").length > 0,
      "回包要带 cacheDir（转录结果存哪）",
    );
    record("1.1 无官方字幕 → WHISPER_NEEDED", true);
  }

  console.log("\n[2/4] 官方字幕接口抛错（风控 / 断网）→ 仍然要给出 Whisper 转录页…");
  {
    const { response } = await runScenario({ playerThrows: true });
    assertEqual(
      response.error,
      "WHISPER_NEEDED",
      "官方字幕读失败不能变成死路，必须降级到 Whisper",
    );
    assertTrue(
      String(response.subtitleLookupError || "").length > 0,
      "要带上出错原因，页面上要能看见",
    );
    record(
      "2.1 官方字幕接口报错 → WHISPER_NEEDED + 原因",
      true,
      response.subtitleLookupError,
    );
  }

  console.log("\n[3/4] 连视频信息接口都抛错 → 最外层 catch 也必须给出 Whisper 转录页…");
  {
    const { response } = await runScenario({ viewThrows: true });
    assertEqual(
      response.error,
      "WHISPER_NEEDED",
      "最外层 catch 也不能只回一句 error（那会让侧边栏只剩「重新尝试」）",
    );
    assertTrue(
      String(response.subtitleLookupError || "").length > 0,
      "要带上出错原因",
    );
    record("3.1 视频信息接口报错 → WHISPER_NEEDED + 原因", true);
  }

  console.log("\n[4/4] asrProvider = none（用户没选语音识别）→ 走 ASR 选择向导…");
  {
    const { response } = await runScenario({ asrProvider: "none" });
    assertEqual(
      response.error,
      "NO_TRANSCRIPT",
      "没选语音识别时应该是 NO_TRANSCRIPT（侧边栏显示 ASR 选择向导）",
    );
    record("4.1 asrProvider=none → NO_TRANSCRIPT", true);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} 通过`,
  );
  if (failed.length) {
    failed.forEach((f) => console.log(`   ✗ ${f.name}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("\n❌ 测试失败：", error && error.stack ? error.stack : error);
  process.exit(1);
});
