// ============================================================
// Real service-worker boot simulation for bililearn background.js
// ------------------------------------------------------------
// What this does that `node --check` and the earlier JSDOM probe
// cannot:
//   1. Actually executes the REAL importScripts chain
//      (settings.js / kb-shared.js / kb-client.js / kb-queue.js)
//      plus background.js in ONE shared vm context — exactly like
//      the real SW. ReferenceErrors / undefined-call errors at
//      top level = service worker dead on arrival = sidepanel
//      gets "Could not establish connection" for checkConfig and
//      the whole DOMContentLoaded chain aborts (no tabs, no
//      welcome).
//   2. Fires onInstalled, then dispatches the sidepanel's
//      startup-critical messages in the real order:
//      checkConfig → getWhisperJobStatus → relayToContent/
//      getVideoInfo → fetchTranscript, then the NEW routes
//      (askAiChat, downloadWhisperNativeRegister).
//   3. Any listener throw / missing response is a FAIL — that is
//      precisely the user-visible "tabs never show" failure mode.
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const EXT_ID = "iecokifhclbnhmgbmadgggidofeeppjn";

// ---------- harness ----------
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// ---------- console capture ----------
const consoleBuffer = [];
function fmtArg(a) {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
const simConsole = {
  log: (...a) => consoleBuffer.push(["log", a.map(fmtArg).join(" ")]),
  info: (...a) => consoleBuffer.push(["info", a.map(fmtArg).join(" ")]),
  warn: (...a) => consoleBuffer.push(["warn", a.map(fmtArg).join(" ")]),
  error: (...a) => consoleBuffer.push(["error", a.map(fmtArg).join(" ")]),
  debug: (...a) => consoleBuffer.push(["debug", a.map(fmtArg).join(" ")]),
};

// ---------- FakeEvent ----------
const listenerErrors = [];
class FakeEvent {
  constructor(name) { this.name = name; this.listeners = []; }
  addListener(fn) { if (!this.listeners.includes(fn)) this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  hasListener(fn) { return this.listeners.includes(fn); }
  hasListeners() { return this.listeners.length > 0; }
  dispatch(...args) {
    let asyncChannel = false;
    for (const fn of this.listeners) {
      try {
        const r = fn(...args);
        if (r === true) asyncChannel = true;
      } catch (e) {
        listenerErrors.push({ event: this.name, error: e });
      }
    }
    return asyncChannel;
  }
}

// ---------- storage ----------
const localStorageData = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const storageArea = {
  async get(keys) {
    const out = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of localStorageData) out[k] = clone(v);
    } else if (typeof keys === "string") {
      if (localStorageData.has(keys)) out[keys] = clone(localStorageData.get(keys));
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (localStorageData.has(k)) out[k] = clone(localStorageData.get(k));
    } else if (typeof keys === "object") {
      for (const k of Object.keys(keys)) {
        out[k] = localStorageData.has(k) ? clone(localStorageData.get(k)) : clone(keys[k]);
      }
    }
    return out;
  },
  async set(items) {
    for (const [k, v] of Object.entries(items || {})) localStorageData.set(k, clone(v));
  },
  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) localStorageData.delete(k);
  },
  async clear() { localStorageData.clear(); },
  setAccessLevel: async () => {},
};

// ---------- tabs ----------
const SIM_TAB = {
  id: 1,
  index: 0,
  windowId: 10,
  active: true,
  highlighted: true,
  selected: true,
  status: "complete",
  url: "https://www.bilibili.com/video/BV1sim000000?p=1",
  title: "[sim] some bilibili video",
};
const tabsLog = [];
const tabsApi = {
  async query(q) {
    tabsLog.push(["query", JSON.stringify(q)]);
    return [SIM_TAB];
  },
  async get(id) {
    tabsLog.push(["get", id]);
    if (id === SIM_TAB.id) return SIM_TAB;
    throw new Error("no tab " + id);
  },
  async create(opts) { tabsLog.push(["create", JSON.stringify(opts)]); return { id: 99, ...opts }; },
  async update(id, opts) { tabsLog.push(["update", id]); return { id }; },
  async sendMessage(tabId, msg, a, b) {
    const cb = typeof a === "function" ? a : b;
    tabsLog.push(["sendMessage", tabId, JSON.stringify(msg).slice(0, 160)]);
    const action = msg && msg.action;
    let reply;
    if (action === "getVideoInfo") {
      reply = {
        success: true,
        response: {
          title: "[sim] video title",
          channelName: "[sim] channel",
          description: "[sim] description",
          duration: 123,
          pubdate: "2026-01-01",
        },
      };
    } else {
      reply = { success: true, response: {} };
    }
    if (cb) cb(reply);
    return reply;
  },
  onUpdated: new FakeEvent("tabs.onUpdated"),
  onActivated: new FakeEvent("tabs.onActivated"),
  onRemoved: new FakeEvent("tabs.onRemoved"),
};

// ---------- downloads ----------
const downloadsLog = [];
let nextDownloadId = 100;
const downloadsApi = {
  async search(q) {
    downloadsLog.push(["search", JSON.stringify(q)]);
    return [];
  },
  download(opts, cb) {
    downloadsLog.push(["download", JSON.stringify(opts).slice(0, 200)]);
    const id = nextDownloadId++;
    if (typeof cb === "function") cb(id);
    return Promise.resolve(id);
  },
  async open(id) { downloadsLog.push(["open", id]); },
  async removeFile(id, cb) { downloadsLog.push(["removeFile", id]); if (cb) cb(); },
  async erase(q, cb) { downloadsLog.push(["erase", JSON.stringify(q)]); if (cb) cb(); },
  onChanged: new FakeEvent("downloads.onChanged"),
};

// ---------- runtime ----------
const onInstalledEvent = new FakeEvent("runtime.onInstalled");
const onStartupEvent = new FakeEvent("runtime.onStartup");
const onMessageEvent = new FakeEvent("runtime.onMessage");
const runtimeSendLog = [];
const runtimeApi = {
  id: EXT_ID,
  getURL: (p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, "")}`,
  lastError: null,
  onInstalled: onInstalledEvent,
  onStartup: onStartupEvent,
  onMessage: onMessageEvent,
  async sendMessage(msg) {
    // Real Chrome: a SW's own runtime.sendMessage does NOT loop back to
    // its own onMessage (it targets extension pages). Capture only.
    runtimeSendLog.push(JSON.stringify(msg).slice(0, 160));
    return undefined;
  },
  async openOptionsPage() {},
  sendNativeMessage(host, payload, cb) {
    runtimeSendLog.push(`nativeMessage→${host}`);
    if (typeof cb === "function") cb({ ok: true, sim: true });
  },
  getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")),
};

// ---------- other namespaces ----------
const alarmsApi = {
  async create() {}, async clear() { return true; },
  async getAll() { return []; },
  onAlarm: new FakeEvent("alarms.onAlarm"),
};
const notificationsApi = {
  async create() { return "sim-notif"; },
  onClicked: new FakeEvent("notifications.onClicked"),
};
const scriptingApi = { async executeScript() { return []; } };
const actionApi = {
  onClicked: new FakeEvent("action.onClicked"),
  setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {},
  setTitle() {}, setIcon() {},
};

// ---------- chrome root with loud STUB-GAP detection ----------
const stubGaps = [];
function gapProxy(pathStr) {
  const fn = function () {
    stubGaps.push(`CALL ${pathStr}`);
    throw new Error(`STUB-GAP call: ${pathStr}`);
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => `STUB-GAP(${pathStr})`;
      return gapProxy(`${pathStr}.${String(prop)}`);
    },
  });
}
const chromeApi = new Proxy(
  {
    runtime: runtimeApi,
    tabs: tabsApi,
    storage: { local: storageArea, session: storageArea, sync: storageArea, onChanged: new FakeEvent("storage.onChanged") },
    downloads: downloadsApi,
    alarms: alarmsApi,
    notifications: notificationsApi,
    scripting: scriptingApi,
    action: actionApi,
    i18n: { getMessage: (k) => k, getUILanguage: () => "zh-CN" },
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      stubGaps.push(`ACCESS chrome.${String(prop)}`);
      return gapProxy(`chrome.${String(prop)}`);
    },
  },
);

// ---------- fetch stub ----------
const fetchLog = [];
async function fetchStub(url, init) {
  const u = String(url);
  fetchLog.push(`${(init && init.method) || "GET"} ${u.slice(0, 120)}`);
  if (u.startsWith("chrome-extension://")) {
    const rel = u.replace(/^chrome-extension:\/\/[^/]+\//, "").split("?")[0];
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) {
      const body = fs.readFileSync(p, "utf8");
      return {
        ok: true, status: 200, url: u,
        text: async () => body,
        json: async () => JSON.parse(body),
        headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "text/plain" : null) },
      };
    }
    return {
      ok: false, status: 404, url: u,
      text: async () => "", json: async () => ({}),
      headers: { get: () => null },
    };
  }
  // All network is "offline" in the sim: handlers must still respond.
  return {
    ok: false, status: 599, url: u,
    text: async () => "",
    json: async () => ({ code: -1, message: "[sim] offline" }),
    headers: { get: () => null },
  };
}

// ---------- sandbox ----------
const sandbox = {
  console: simConsole,
  chrome: chromeApi,
  fetch: fetchStub,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  AbortController, FormData, Headers, Request, Response,
  crypto: require("crypto").webcrypto,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  queueMicrotask,
  performance,
  setTimeout, clearTimeout, setInterval, clearInterval,
  navigator: { userAgent: "SimSW", onLine: true, language: "zh-CN", hardwareConcurrency: 4 },
  location: {
    href: `chrome-extension://${EXT_ID}/background.js`,
    origin: `chrome-extension://${EXT_ID}`,
    protocol: "chrome-extension:",
    host: EXT_ID,
    pathname: "/background.js",
  },
  structuredClone,
  __dirname: null,
  __filename: null,
  module: undefined,
  require: undefined,
  exports: undefined,
};
const ctx = vm.createContext(sandbox);
sandbox.self = sandbox;
sandbox.globalThis = sandbox; // vm already provides globalThis; keep pointer semantics simple

// Make timers non-keeping so the process can exit.
const origSetInterval = sandbox.setInterval;
sandbox.setInterval = (fn, ms, ...a) => { const h = origSetInterval(fn, ms, ...a); if (h && h.unref) h.unref(); return h; };

// importScripts: resolve relative to extension root, run in same context.
const importOrder = [];
sandbox.importScripts = (...files) => {
  for (const f of files) {
    const p = path.join(ROOT, f);
    importOrder.push(f);
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f });
  }
};

// ---------- dispatcher ----------
async function dispatch(msg, sender) {
  listenerErrors.length = 0;
  const responses = [];
  let responded = false;
  const sendResponse = (r) => { responded = true; responses.push(r); };
  const asyncChannel = onMessageEvent.dispatch(
    msg,
    sender || { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html` },
    sendResponse,
  );
  if (!responded && asyncChannel) {
    const start = Date.now();
    while (!responded && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  return {
    responded,
    response: responses[0],
    listenerErrors: listenerErrors.slice(),
  };
}

// ---------- main ----------
(async () => {
  const simSender = {
    id: EXT_ID,
    url: `chrome-extension://${EXT_ID}/sidepanel.html`,
    tab: { id: SIM_TAB.id, url: SIM_TAB.url },
  };

  // 1) BOOT: run background.js; its own importScripts pulls the chain.
  let bootError = null;
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, {
      filename: "background.js",
    });
  } catch (e) {
    bootError = e;
  }
  report(
    "SW boot: importScripts chain + background.js top-level, no throw",
    !bootError,
    bootError ? bootError.stack || String(bootError) : `imported: ${importOrder.join(", ")}`,
  );

  if (!bootError) {
    // 2) lifecycle events
    onInstalledEvent.dispatch({ reason: "update", previousVersion: "9.9.9" });
    report(
      "onInstalled('update') listeners did not throw",
      listenerErrors.length === 0,
      listenerErrors.map((e) => String(e.error)).join(" | "),
    );

    // 3) sidepanel boot order: checkConfig FIRST
    let r = await dispatch({ action: "checkConfig" }, simSender);
    report(
      "checkConfig responds (sidepanel DOMContentLoaded depends on it)",
      r.responded && r.response && typeof r.response.hasAiKey === "boolean",
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 200)
          : "NO RESPONSE (port closed without sendResponse)",
    );

    // 4) whisper resume path
    r = await dispatch({ action: "getWhisperJobStatus" }, simSender);
    report(
      "getWhisperJobStatus responds (maybeResumeWhisperJob path)",
      r.responded,
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 200)
          : "NO RESPONSE",
    );

    // 5) relayToContent/getVideoInfo
    r = await dispatch(
      { action: "relayToContent", payload: { action: "getVideoInfo" } },
      simSender,
    );
    report(
      "relayToContent(getVideoInfo) responds",
      r.responded,
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 200)
          : "NO RESPONSE",
    );

    // 6) fetchTranscript — cache-miss branch waits on this before tabsNav
    r = await dispatch(
      {
        action: "fetchTranscript",
        videoId: "BV1sim000000",
        pageNumber: 1,
        videoUrl: SIM_TAB.url,
      },
      simSender,
    );
    report(
      "fetchTranscript responds (tabsNav waits on this)",
      r.responded,
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 220)
          : "NO RESPONSE",
    );

    // 7) NEW route: askAiChat (offline fetch → expect graceful error reply)
    r = await dispatch(
      {
        action: "askAiChat",
        videoId: "BV1sim000000",
        messages: [{ role: "user", content: "你好" }],
      },
      simSender,
    );
    report(
      "askAiChat (new route) responds without killing dispatcher",
      r.responded,
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 220)
          : "NO RESPONSE",
    );

    // 8) NEW route: downloadWhisperNativeRegister
    r = await dispatch({ action: "downloadWhisperNativeRegister" }, simSender);
    report(
      "downloadWhisperNativeRegister (new route) responds",
      r.responded,
      r.listenerErrors.length
        ? "listener throw: " + (r.listenerErrors[0].error.stack || r.listenerErrors[0].error)
        : r.responded
          ? JSON.stringify(r.response).slice(0, 200)
          : "NO RESPONSE",
    );

    // 9) repeat checkConfig AFTER the new routes — dispatcher not poisoned
    r = await dispatch({ action: "checkConfig" }, simSender);
    report(
      "checkConfig STILL responds after new-route dispatches",
      r.responded && typeof r.response.hasAiKey === "boolean",
      r.responded ? "" : "dispatcher degraded after askAiChat/native dispatch",
    );
  }

  // ---------- summary ----------
  console.log("\n---- console.error/warn captured inside SW ----");
  for (const [lvl, line] of consoleBuffer) {
    if (lvl === "error" || lvl === "warn") console.log(`[${lvl}] ${line.slice(0, 300)}`);
  }
  if (stubGaps.length) {
    console.log("\n---- STUB-GAP (chrome API not stubbed) ----");
    for (const g of [...new Set(stubGaps)]) console.log(g);
  }
  console.log("\n---- fetch calls (first 15) ----");
  for (const f of fetchLog.slice(0, 15)) console.log(f);
  console.log("---- tabs calls (first 10) ----");
  for (const t of tabsLog.slice(0, 10)) console.log(t.join(" "));
  console.log("---- runtime.sendMessage (first 10) ----");
  for (const m of runtimeSendLog.slice(0, 10)) console.log(m);

  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} checks passed ====`);
  process.exitCode = fails ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS CRASH:", e);
  process.exitCode = 2;
});
