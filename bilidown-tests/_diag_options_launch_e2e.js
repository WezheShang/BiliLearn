/**
 * settings（options）页「启动 server」按钮的**端到端**验证（2026-11-06）。
 *
 * 用户报：「你在 settings 页面加的任何一个 button 点击都没有任何用处，
 * 无法启动 service，从来没有能用过」。
 *
 * 这个探针把整条链真的串起来跑：
 *   options.html + options.js (真实)  --sendMessage-->  background.js (真实)
 *      --sendNativeMessage-->  bililearn_whisper_launcher.bat (真实)
 *      -->  whisper_server.py (真实)  -->  127.0.0.1:<port>/health
 *
 * 断言：
 *   E1 options 页脚本加载无异常
 *   E2 点「检查系统」能渲染出诊断行
 *   E3 server 不在时，「启动 server」按钮**确实被渲染出来**
 *   E4 点它 → 真的发出 launchWhisperServerOnce
 *   E5 native host 真的被调用（cmd=launch，端口 = 扩展配置的那个）
 *   E6 whisper server 真的在那个端口上起来了
 *   E7 按钮进入"等待就绪"状态（UI 有反馈，不是"点了没反应"）
 *
 * 用一个没人用的端口（默认 7865），不打扰用户正在跑的实例。
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TEST_PORT = Number(process.env.E2E_PORT || 7865);

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}

// ---------- 共享的 chrome 存储（options 页和 background 共用一份） ----------
const shared = {
  localStore: {
    // 语言是**顶层 key**，不是 ytd_settings 里的字段 —— 放错地方页面会退回英文
    language: "zh-CN",
    ytd_settings: {
      asrProvider: "whisper",
      whisperUrl: `http://127.0.0.1:${TEST_PORT}`,
      whisperModel: "base",
      whisperLanguage: "zh",
      subtitlesDir: "C:/Users/shangweizhe/bilibilisubs",
      exportDir: "C:/Users/shangweizhe/Downloads",
      aiApiKey: "",
      aiModel: "glm-4.6",
      aiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      language: "zh-CN",
      minimaxAsrApiKey: "",
      minimaxAsrModel: "asr-1.0",
      supadataApiKey: "",
    },
  },
  sessionStore: {},
  nativeCalls: [],
  bgMessages: [],
};

function storageArea(store) {
  return {
    get: (key, cb) => {
      let value;
      if (typeof key === "string") value = { [key]: store[key] };
      else if (Array.isArray(key))
        value = key.reduce((acc, k) => ((acc[k] = store[k]), acc), {});
      else value = { ...store };
      if (typeof cb === "function") {
        try { cb(value); } catch (_e) {}
      }
      return Promise.resolve(value);
    },
    set: (obj, cb) => {
      Object.assign(store, obj);
      if (typeof cb === "function") {
        try { cb(); } catch (_e) {}
      }
      return Promise.resolve();
    },
    remove: (key, cb) => {
      const arr = Array.isArray(key) ? key : [key];
      arr.forEach((k) => delete store[k]);
      if (typeof cb === "function") {
        try { cb(); } catch (_e) {}
      }
      return Promise.resolve();
    },
    setAccessLevel: () => Promise.resolve(),
  };
}

/** 按 Chrome 的 native messaging 协议真的把 .bat 跑起来。 */
function callNativeHost(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeInt32LE(body.length, 0);
  body.copy(frame, 4);
  const bat = path.join(ROOT, "bililearn_whisper_launcher.bat");
  const proc = spawnSync("cmd.exe", ["/c", bat], {
    input: frame,
    timeout: 120000,
    windowsHide: true,
  });
  const out = proc.stdout || Buffer.alloc(0);
  if (out.length < 4) {
    return { response: null, error: "native host 没回帧: " + String(proc.stderr || "") };
  }
  const n = out.readInt32LE(0);
  try {
    return { response: JSON.parse(out.slice(4, 4 + n).toString("utf8")), error: "" };
  } catch (e) {
    return { response: null, error: "native host 回包不是 JSON" };
  }
}

async function main() {
  console.log(
    `\n=== options 页「启动 server」端到端（真实 options.js + background.js + .bat）===\n` +
      `    测试端口：${TEST_PORT}`,
  );

  // ---------------- 1. 起 background（真实代码） ----------------
  const bgDom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://fake/background.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const bgListeners = [];
  bgDom.window.chrome = {
    storage: {
      local: storageArea(shared.localStore),
      session: storageArea(shared.sessionStore),
    },
    runtime: {
      id: "fake",
      lastError: null,
      sendMessage: () => Promise.resolve({ ok: true }),
      // 真的去调 native host
      sendNativeMessage: (name, payload, cb) => {
        shared.nativeCalls.push({ name, payload });
        const res = callNativeHost(payload);
        if (typeof cb === "function") cb(res.response);
      },
      onMessage: { addListener: (fn) => bgListeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `chrome-extension://fake/${p}`,
      openOptionsPage: () => Promise.resolve(),
    },
    tabs: {
      query: () => Promise.resolve([]),
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
    action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => Promise.resolve(true) },
    notifications: { onClicked: { addListener: () => {} }, create: () => {} },
    downloads: {
      download: (o, cb) => {
        if (typeof cb === "function") {
          try { cb(1); } catch (_e) {}
        }
        return 1;
      },
      open: () => {},
      onChanged: { addListener: () => {}, removeListener: () => {} },
      search: (q, cb) => {
        if (typeof cb === "function") {
          try { cb([]); } catch (_e) {}
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
  bgDom.window.fetch = (url, opts) => globalThis.fetch(url, opts);
  bgDom.window.importScripts = () => {};
  bgDom.window.console.error = () => {};
  const bgBundle = ["settings.js", "kb-shared.js", "kb-client.js", "kb-queue.js", "background.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n;\n");
  bgDom.window.eval(bgBundle);
  assertTrue(bgListeners.length > 0, "background 注册了 onMessage 监听器");

  // ---------------- 2. 起 options 页（真实代码） ----------------
  const optHtml = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  const optDom = new JSDOM(optHtml, {
    url: "chrome-extension://fake/options.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const optErrors = [];
  optDom.window.console.error = (...a) => optErrors.push(a.map(String).join(" "));
  optDom.window.addEventListener("error", (e) => optErrors.push("window.error: " + e.message));
  optDom.window.chrome = {
    storage: {
      local: storageArea(shared.localStore),
      session: storageArea(shared.sessionStore),
    },
    runtime: {
      id: "fake",
      lastError: null,
      // 真的转发给 background
      sendMessage: (msg) => {
        shared.bgMessages.push(msg);
        return new Promise((resolve) => {
          let settled = false;
          for (const fn of bgListeners) {
            const ret = fn(msg, { tab: { id: 1 } }, (resp) => {
              if (settled) return;
              settled = true;
              resolve(resp);
            });
            if (ret === true) continue;
          }
          if (!settled) resolve({ success: true });
        });
      },
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `chrome-extension://fake/${p}`,
      openOptionsPage: () => Promise.resolve(),
    },
    tabs: {
      query: () => Promise.resolve([]),
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      create: () => {},
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
    action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => Promise.resolve(true) },
    notifications: { onClicked: { addListener: () => {} }, create: () => {} },
    downloads: {
      download: (o, cb) => {
        if (typeof cb === "function") {
          try { cb(1); } catch (_e) {}
        }
        return 1;
      },
      open: () => {},
      onChanged: { addListener: () => {}, removeListener: () => {} },
      search: (q, cb) => {
        if (typeof cb === "function") {
          try { cb([]); } catch (_e) {}
        }
      },
    },
    scripting: { executeScript: () => Promise.resolve([]) },
  };
  // 真 fetch —— pingWhisper 靠它探 /health
  optDom.window.fetch = (url, opts) => globalThis.fetch(url, opts);
  optDom.window.URL = URL;
  optDom.window.AbortController = AbortController;

  for (const f of ["settings.js", "kb-shared.js", "kb-client.js", "options.js"]) {
    try {
      optDom.window.eval(fs.readFileSync(path.join(ROOT, f), "utf8"));
    } catch (error) {
      optErrors.push(`${f}: ${error && error.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  optDom.window.document.dispatchEvent(new optDom.window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 300));
  record("E1 options 页脚本加载无异常", optErrors.length === 0, optErrors.slice(0, 2).join(" | "));

  const doc = optDom.window.document;

  // ---------------- 3. 点「检查系统」 ----------------
  const checkBtn = doc.getElementById("whisperCheckBtn");
  assertTrue(!!checkBtn, "页面上有「检查系统」按钮");
  checkBtn.click();
  await new Promise((r) => setTimeout(r, 1200));
  const list = doc.getElementById("whisperCheckResults");
  const rows = list ? list.querySelectorAll("li").length : 0;
  record("E2 点「检查系统」渲染出诊断行", rows > 0, `${rows} 行`);
  // 把每一行原文打出来 —— 用户在页面上看到的就是这些
  if (list) {
    console.log("    --- 诊断行原文 ---");
    for (const li of list.querySelectorAll("li")) {
      const btns = [...li.querySelectorAll("button")].map((b) => `[${(b.textContent || "").trim()}]`);
      console.log(`    · ${(li.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150)} ${btns.join(" ")}`);
    }
    const urlShown = doc.getElementById("whisperUrlText");
    console.log(`    页面上显示的 whisperUrl: ${urlShown ? urlShown.textContent.trim() : "(没有这个元素)"}`);
    console.log(`    扩展配置里的 whisperUrl: ${shared.localStore.ytd_settings.whisperUrl}`);
  }

  // ---------------- 4. 找「启动 server」按钮 ----------------
  const allBtns = [...doc.querySelectorAll("button")];
  const startBtn = allBtns.find((b) =>
    /whisper server/i.test(b.textContent || "") && /start|启动/i.test(b.textContent || ""),
  );
  assertTrue(!!startBtn, "诊断区里有「启动 server」按钮");
  record("E3 server 不在时「启动 server」按钮被渲染出来", true,
    `按钮文案="${(startBtn.textContent || "").trim()}"`);

  // ---------------- 5. 点它，看整条链有没有动 ----------------
  const nativeBefore = shared.nativeCalls.length;
  startBtn.click();
  await new Promise((r) => setTimeout(r, 800));

  const launched = shared.bgMessages.some((m) => m && m.action === "launchWhisperServerOnce");
  record("E4 点按钮发出了 launchWhisperServerOnce", launched);

  const nativeCalled = shared.nativeCalls.length > nativeBefore;
  record("E5 native host 真的被调用", nativeCalled,
    nativeCalled ? JSON.stringify(shared.nativeCalls[shared.nativeCalls.length - 1].payload) : "没调用");
  if (nativeCalled) {
    const payload = shared.nativeCalls[shared.nativeCalls.length - 1].payload;
    assertEqual(Number(payload.port), TEST_PORT, "native host 收到的端口 = 扩展配置的那个");
    record("E5b native host 收到的是扩展配置的端口", true, `port=${payload.port}`);
  }

  // ---------------- 6. server 真的起来了吗 ----------------
  let up = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const r = await globalThis.fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const body = await r.json();
        if (body && body.ok) { up = true; break; }
      }
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  record("E6 whisper server 真的在那个端口上起来了", up, up ? "" : "90 秒内没起来");

  // ---------------- 7. 按钮有反馈吗 ----------------
  const label = (startBtn.textContent || "").trim();
  record("E7 按钮进入了「等待就绪」状态（UI 有反馈）", /等待|wait|checking|检查/i.test(label),
    `按钮现在写着 "${label}"`);

  // ---------------- 8. 清理 ----------------
  try {
    const { execSync } = require("child_process");
    const out = execSync(
      `(Get-NetTCPConnection -LocalPort ${TEST_PORT} -State Listen -ErrorAction SilentlyContinue)` +
        ` | Select-Object -ExpandProperty OwningProcess`,
      { encoding: "utf8", shell: "powershell.exe", timeout: 20000 },
    );
    for (const p of out.split(/\s+/).filter((x) => /^\d+$/.test(x))) {
      execSync(`taskkill /PID ${p} /F`, { stdio: "ignore", timeout: 20000 });
      console.log(`    cleaned pid ${p}`);
    }
  } catch (_e) {}

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} 通过`,
  );
  if (failed.length) {
    failed.forEach((f) => console.log(`   x ${f.name}  ${f.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`assertEqual ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

main().catch((error) => {
  console.error("\n❌ 端到端探针失败：", error && error.stack ? error.stack : error);
  process.exit(1);
});
