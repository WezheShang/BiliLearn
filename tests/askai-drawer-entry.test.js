/**
 * Ask AI 抽屉入口 + 模型记忆（2026-11-06）
 *
 * 覆盖用户提的两件事：
 *   1. 侧边栏最下面多一个常驻按钮 —— 以前 Ask AI 只有「选中文字 → 药丸 →
 *      💬 Ask AI」这一条门进，没有选区就开不了抽屉；
 *   2. 抽屉里的 model 下拉：初始用 settings（options 页）里选中的 provider，
 *      用户手动改过之后，**下次再打开抽屉**默认还是改过的那个（跨会话）。
 *
 * 测试怎么做到「跨会话」：
 *   同一个 in-memory chrome.storage.local 被两个独立的 JSDOM window 共用 ——
 *   第二个 window 就是「用户关掉面板又重新打开」的那一次。它拿到的是同一份
 *   storage，但内存里的 askAiSelectedModelKey 是全新的空值，所以能真正验证
 *   「记忆是从 storage 里读回来的」，而不是同一个 JS 上下文里的残留。
 *
 * 关键点：
 *   - settings.provider = deepseek，但用户手动换成了 minimax → 第二个窗口
 *     必须显示 minimax。如果只测同一个窗口，内存变量会骗过测试。
 *   - 记忆写在**独立键** ytd_askai_model_key 里，不能污染 ytd_settings
 *     （那个键的 provider 语义归 options 页管）。
 *
 * 任何失败退出非零。
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------- Test framework (minimal, no deps) ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertTrue(cond, label, detail = "") {
  record(label, !!cond, detail);
  if (!cond) throw new Error(`assertTrue failed: ${label}${detail ? " (" + detail + ")" : ""}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  record(label, ok, ok ? "" : `expected ${e}, got ${a}`);
  if (!ok) throw new Error(`assertEqual ${label}\n  expected: ${e}\n  actual:   ${a}`);
}

// ---------- Shared storage (两个窗口共用 = 跨会话) ----------
const localStore = {};

const noopEvent = {
  addListener: () => {},
  removeListener: () => {},
  hasListener: () => false,
};

function makeChromeShim() {
  const storage = {
    local: {
      get: (key, cb) => {
        const value =
          typeof key === "string" ? { [key]: localStore[key] }
          : Array.isArray(key) ? key.reduce((a, k) => { a[k] = localStore[k]; return a; }, {})
          : { ...localStore };
        if (typeof cb === "function") { try { cb(value); } catch (_e) {} }
        return Promise.resolve(value);
      },
      set: (obj, cb) => {
        Object.assign(localStore, obj);
        if (typeof cb === "function") { try { cb(); } catch (_e) {} }
        return Promise.resolve();
      },
      remove: (key, cb) => {
        (Array.isArray(key) ? key : [key]).forEach((k) => delete localStore[k]);
        if (typeof cb === "function") { try { cb(); } catch (_e) {} }
        return Promise.resolve();
      },
    },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    onChanged: noopEvent,
  };

  return {
    storage,
    runtime: {
      sendMessage: () => Promise.resolve({}),
      onMessage: { addListener: () => {} },
      onInstalled: noopEvent,
      onStartup: noopEvent,
      onConnect: noopEvent,
      onSuspend: noopEvent,
      getURL: (p) => `chrome-extension://fake/${p}`,
      openOptionsPage: () => {},
      getManifest: () => ({ version: "1.0" }),
    },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 1 }),
      sendMessage: () => Promise.resolve({}),
      onUpdated: noopEvent,
      onRemoved: noopEvent,
      onActivated: noopEvent,
    },
    windows: {
      getCurrent: () => Promise.resolve({ id: 1 }),
      create: () => Promise.resolve({ id: 1 }),
      onFocusChanged: noopEvent,
      WINDOW_ID_NONE: -1,
    },
    alarms: { create: () => {}, clear: () => Promise.resolve(true), getAll: () => Promise.resolve([]), onAlarm: noopEvent },
    notifications: { create: () => {}, onClicked: noopEvent },
    downloads: {
      download: (opts, cb) => { if (cb) { try { cb(1); } catch (_e) {} } return 1; },
      open: () => {},
      onChanged: noopEvent,
      search: (q, cb) => { if (typeof cb === "function") { try { cb([{ id: 1 }]); } catch (_e) {} } },
    },
    commands: { onCommand: noopEvent },
    contextMenus: { create: () => {}, removeAll: () => Promise.resolve(), onClicked: noopEvent },
    action: { setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve(), onClicked: noopEvent },
    scripting: { executeScript: () => Promise.resolve([]) },
    sidePanel: { setPanelBehavior: () => {}, setOptions: () => Promise.resolve(), open: () => Promise.resolve() },
    i18n: { getUILanguage: () => "zh-CN", getMessage: (k) => k },
    permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(false) },
  };
}

// ---------- Loaders ----------
async function loadSidepanel() {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8"), {
    url: "chrome-extension://fake-id/sidepanel.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = makeChromeShim();
  w.fetch = () => Promise.reject(new Error("no network in test"));
  w.URL = URL;
  // 真实加载顺序照抄 sidepanel.html：settings.js → kb-*.js → sidepanel.js
  w.eval(fs.readFileSync(path.join(ROOT, "settings.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "kb-shared.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "kb-client.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 60));
  return w;
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** 等某个条件成立（populateAskAiModels 是异步的，不能固定 sleep）。 */
async function waitFor(fn, label, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = fn(); } catch (_e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitFor timed out: ${label}`);
    }
    await settle(20);
  }
}

/** 打开抽屉并等模型下拉填好。 */
async function openDrawer(w) {
  w.setupEventListeners();
  w.document.getElementById("askAiOpenBtn").click();
  await waitFor(() => {
    const sel = w.document.getElementById("askAiModelSelect");
    return sel && sel.options.length > 0 && typeof sel.onchange === "function";
  }, "model select populated");
  return w.document.getElementById("askAiModelSelect");
}

// ---------- Fixtures ----------
const DS_KEY = "deepseek|deepseek-chat";
const MM_KEY = "minimax|MiniMax-M3";

function seedSettings() {
  localStore.ytd_settings = {
    provider: "deepseek",       // options 页里用户选中的 provider
    deepseekApiKey: "dk-test-key",
    minimaxApiKey: "mm-test-key",
    glmApiKey: "",
  };
}

// ---------- Main ----------
(async function main() {
  console.log("\n[1/5] 底栏常驻按钮 —— 无选区也能打开 Ask AI 抽屉");
  seedSettings();
  const sp = await loadSidepanel();

  const footer = sp.document.getElementById("panelFooter");
  const btn = sp.document.getElementById("askAiOpenBtn");
  assertTrue(!!footer, "面板底部有常驻底栏容器");
  assertTrue(!!btn, "底栏里有 Ask AI 按钮");
  assertTrue(!!btn.closest(".panel-footer"), "按钮在底栏容器里");
  assertTrue(
    !!btn.textContent.includes("Ask AI"),
    "按钮有可读的文案",
    btn.textContent.trim(),
  );
  // 位置：底栏必须在 .content 之后（面板最下面），不能插在内容中间
  const content = sp.document.getElementById("contentArea");
  assertTrue(
    !!(content.compareDocumentPosition(footer) & sp.Node.DOCUMENT_POSITION_FOLLOWING),
    "底栏排在内容区之后（面板最下面）",
  );

  console.log("\n[2/5] 点底栏按钮 → 抽屉真的打开了");
  assertTrue(
    !sp.document.getElementById("askAiDrawer"),
    "一开始没有抽屉（懒创建）",
  );
  const sel = await openDrawer(sp);
  const drawer = sp.document.getElementById("askAiDrawer");
  assertTrue(!!drawer, "抽屉被创建出来");
  assertTrue(drawer.classList.contains("open"), "抽屉处于打开状态");
  // 没有选区 → 不显示选区条（这次是「随便问」，不是「问这段」）
  const selBar = drawer.querySelector("#askAiSelection");
  assertEqual(selBar.style.display, "none", "无选区时选区条不显示");

  console.log("\n[3/5] 初始模型 = settings 里选中的 provider");
  assertEqual(sel.value, DS_KEY, "初始默认用 settings.provider（deepseek）");

  console.log("\n[4/5] 用户手动改过 → 被记住（独立键，不污染 settings）");
  sel.value = MM_KEY;
  sel.dispatchEvent(new sp.Event("change"));
  await waitFor(
    () => localStore.ytd_askai_model_key === MM_KEY,
    "model memory written",
  );
  assertEqual(localStore.ytd_askai_model_key, MM_KEY, "记住的模型写进了独立键");
  assertEqual(
    localStore.ytd_settings.ytd_askai_model_key,
    undefined,
    "ytd_settings 里没有被塞进模型记忆",
  );
  assertEqual(
    localStore.ytd_settings.provider,
    "deepseek",
    "ytd_settings.provider 没被侧边栏改掉",
  );

  console.log("\n[5/5] 下次打开抽屉（新会话）默认还是改过的那个");
  // 新窗口 = 用户关掉面板又重新打开：同一份 storage，全新的内存状态
  const sp2 = await loadSidepanel();
  const sel2 = await openDrawer(sp2);
  assertEqual(
    sel2.value,
    MM_KEY,
    "重新打开抽屉默认显示上次手动选的模型（不是 settings.provider）",
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("\nTEST FAILURE:", err.message);
  process.exit(1);
});
