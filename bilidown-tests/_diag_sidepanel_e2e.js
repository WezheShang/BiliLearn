// ============================================================
// JSDOM end-to-end probe: does the REAL sidepanel.html + REAL
// script chain (settings.js → kb-shared.js → kb-client.js → // sidepanel.js) reach "#tabsNav display:flex" on a B站 video
// tab? This mirrors the user's exact boot path:
//   DOMContentLoaded → setupEventListeners → initWhisperQueuePanel
//   → evictOldCacheEntries → maybeResumeWhisperJob → checkConfig
//   → checkCurrentTab → startBililearn(cache-miss) →
//   fetchTranscript → renderTranscript → showState("results")
//   → tabsNav.style.display = "flex"   ← THE user-visible bug
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const EXT_ID = "iecokifhclbnhmgbmadgggidofeeppjn";
const SIM_TAB = {
  id: 1, index: 0, windowId: 10, active: true, highlighted: true,
  status: "complete",
  url: "https://www.bilibili.com/video/BV1sim000000?p=1",
  title: "[sim] bilibili video",
};

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " → " + detail : ""}`);
}

// ---------- storage ----------
const storageData = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function storageArea() {
  return {
    async get(keys) {
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of storageData) out[k] = clone(v);
      } else if (typeof keys === "string") {
        if (storageData.has(keys)) out[keys] = clone(storageData.get(keys));
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (storageData.has(k)) out[k] = clone(storageData.get(k));
      } else if (typeof keys === "object") {
        for (const k of Object.keys(keys)) {
          out[k] = storageData.has(k) ? clone(storageData.get(k)) : clone(keys[k]);
        }
      }
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items || {})) storageData.set(k, clone(v)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) storageData.delete(k); },
    async clear() { storageData.clear(); },
    setAccessLevel: async () => {},
  };
}

// ---------- message router ----------
const sentMessages = [];
let configCallCount = 0;

// 2026-11-05: 侧边栏现在会先跟后台对版本号（checkBackgroundBuild →
// getExtensionBuild）。探针之前没 stub 这个 action，后台就"不认识"
// getExtensionBuild，于是侧边栏判定"后台是旧版本"并提前 return ——
// 面板停在错误页，探针误报成"tab 不显示"。
// 这里从 sidepanel.js 里读出真实的 SP_BUILD 回给面板，版本号永远跟
// 源码同步，探针不会再因为产品加了新握手而误报。
const sidepanelSrc = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
const SP_BUILD = (sidepanelSrc.match(/const SP_BUILD\s*=\s*["']([^"']+)["']/) || [])[1] || "";

const handlers = {
  // CONFIG_FAIL / CONFIG_FAIL_ONCE reproduce the 2026-10-16 field bug: a
  // panel restored by Chrome's session restore boots before the service
  // worker finishes waking, so sendMessage rejects. Unguarded, that
  // rejection killed the whole boot chain and froze the panel on the
  // untouched initial welcome screen (no hint, no tabs, no error).
  checkConfig: () => {
    configCallCount++;
    const failAlways = !!process.env.CONFIG_FAIL;
    const failOnce = !!process.env.CONFIG_FAIL_ONCE && configCallCount === 1;
    if (failAlways || failOnce) {
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    }
    return { success: true, hasAiKey: true, hasSupadataKey: true, hasMinimaxKey: true };
  },
  getWhisperJobStatus: () => {
    if (process.env.STUCK_JOB || process.env.STUCK_JOB_STALE) {
      const stale = !!process.env.STUCK_JOB_STALE;
      return {
        job: {
          videoId: "BV1sim000000",
          videoUrl: SIM_TAB.url,
          stage: "transcribing",
          title: "Whisper 转录中",
          subtitle: "转录在后台进行，可随意切换页面；回到本页会显示进度",
          startedAt: stale ? Date.now() - 40 * 60 * 1000 : Date.now() - 2 * 60 * 1000,
        },
      };
    }
    return { job: null };
  },
  listWhisperQueue: () => ({ success: true, queue: [] }),
  // 2026-11-05: 版本握手。返回与侧边栏一致的 build → 正常流程继续。
  getExtensionBuild: () => ({ success: true, build: SP_BUILD }),
  relayToContent: () => ({
    success: true,
    response: { title: "[sim] title", channelName: "[sim] channel", description: "[sim] desc", duration: 60, pubdate: "2026-01-01" },
  }),
  fetchTranscript: () => ({
    success: true,
    transcript: [
      { start: 0, dur: 2, text: "你好世界", content: "你好世界", from: 0, to: 2 },
      { start: 2, dur: 3, text: "这是第二句", content: "这是第二句", from: 2, to: 5 },
    ],
    transcriptText: "你好世界 这是第二句",
    transcriptTextTimestamped: "0:00 你好世界\n0:02 这是第二句",
    language: "zh-CN",
    source: "bilibili-subtitle",
    videoTitle: "[sim] title",
    channelName: "[sim] channel",
    pubDate: "2026-01-01",
  }),
};
async function sendMessage(msg) {
  sentMessages.push((msg && msg.action) || String(msg));
  const h = handlers[msg && msg.action];
  return h ? h(msg) : { success: true };
}

// ---------- build DOM ----------
const rawHtml = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
// Strip script tags → we eval them manually AFTER installing chrome stubs,
// then re-dispatch DOMContentLoaded (jsdom already fired it during parse).
const htmlNoScripts = rawHtml.replace(/<script[^>]*src="[^"]*"[^>]*>\s*<\/script>/g, "");

const vc = new VirtualConsole();
const pageErrors = [];
const panelLogs = [];
vc.on("jsdomError", (e) => pageErrors.push(String(e && e.message || e)));
vc.on("error", (...a) => pageErrors.push("console.error: " + a.join(" ")));
vc.on("warn", (...a) => panelLogs.push("warn: " + a.join(" ")));
vc.on("log", (...a) => panelLogs.push("log: " + a.join(" ")));

const dom = new JSDOM(htmlNoScripts, {
  url: `chrome-extension://${EXT_ID}/sidepanel.html`,
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

// ---------- chrome stub on the window ----------
class WEvent {
  constructor(name) { this.name = name; this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  hasListener(fn) { return this.listeners.includes(fn); }
  dispatch(...args) { for (const fn of this.listeners) { try { fn(...args); } catch (e) { pageErrors.push(`listener throw on ${this.name}: ${e && e.message}`); } } }
}
const CONTEXT_LOST = !!process.env.CONTEXT_LOST;
window.chrome = {
  runtime: {
    id: EXT_ID,
    getURL: (p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, "")}`,
    lastError: null,
    onMessage: new WEvent("runtime.onMessage"),
    onInstalled: new WEvent("runtime.onInstalled"),
    sendMessage: (msg, maybeCb) => {
      // CONTEXT_LOST simulates the state a panel is left in after the user
      // reloads the extension: the document is still alive but its context
      // is invalid, so every extension call fails.
      const p = CONTEXT_LOST
        ? Promise.reject(new Error("Extension context invalidated."))
        : sendMessage(msg);
      if (typeof maybeCb === "function") p.then((r) => maybeCb(r)).catch(() => {});
      return p;
    },
    getPlatformInfo: () =>
      CONTEXT_LOST
        ? Promise.reject(new Error("Extension context invalidated."))
        : Promise.resolve({ os: "win", arch: "x86-64" }),
    openOptionsPage: async () => {},
  },
  tabs: {
    async query() { return [SIM_TAB]; },
    async get(id) { return id === SIM_TAB.id ? SIM_TAB : null; },
    async sendMessage() { return { success: true }; },
    onUpdated: new WEvent("tabs.onUpdated"),
    onActivated: new WEvent("tabs.onActivated"),
  },
  windows: {
    // Real Chrome sidepanel pages always have chrome.windows (the "tabs"
    // permission is in the manifest). The earlier TypeError at
    // sidepanel.js:529 was a stub gap, not a product bug.
    getCurrent: async () => ({ id: SIM_TAB.windowId, focused: true, state: "normal" }),
    getAll: async () => [{ id: SIM_TAB.windowId, focused: true }],
    onFocusChanged: new WEvent("windows.onFocusChanged"),
  },
  storage: { local: storageArea(), session: storageArea(), onChanged: new WEvent("storage.onChanged") },
  action: { onClicked: new WEvent("action.onClicked") },
};
if (!window.matchMedia) {
  window.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent() { return false; } });
}
window.addEventListener("error", (e) => pageErrors.push("window error: " + (e.message || e.error)));
process.on("unhandledRejection", (r) => pageErrors.push("unhandledRejection: " + (r && r.message || r)));

// ---------- observe panel self-reloads ----------
// jsdom's Location is unforgeable and refuses real navigation, so a reload
// attempt surfaces as a "Not implemented: navigation" jsdomError on the
// virtual console. That signal, plus the panel's own watchdog log, is what
// the context-lost assertions below rely on — no fake stub.

// ---------- run the real scripts in the real order ----------
const scriptOrder = ["settings.js", "kb-shared.js", "kb-client.js", "sidepanel.js"];
const evalErrors = [];
for (const f of scriptOrder) {
  try {
    window.eval(fs.readFileSync(path.join(ROOT, f), "utf8"));
  } catch (e) {
    evalErrors.push(`${f}: ${e && e.stack || e}`);
  }
}
report("4 scripts evaluated at top level, no throw", evalErrors.length === 0, evalErrors.join(" || ").slice(0, 400));

// ---------- re-dispatch DOMContentLoaded (fired during parse already) ----------
try {
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  report("DOMContentLoaded re-dispatched", true);
} catch (e) {
  report("DOMContentLoaded re-dispatched", false, String(e));
}

// ---------- wait for tabsNav ----------
(async () => {
  const deadline = Date.now() + 8000;
  let tabsDisplay = null;
  while (Date.now() < deadline) {
    tabsDisplay = window.document.getElementById("tabsNav")?.style.display || "";
    if (tabsDisplay === "flex") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const mode = process.env.CONTEXT_LOST ? "context-lost"
    : process.env.CONFIG_FAIL ? "config-fail"
    : process.env.CONFIG_FAIL_ONCE ? "config-fail-once"
    : process.env.STUCK_JOB ? "stuck-fresh"
    : process.env.STUCK_JOB_STALE ? "stuck-stale" : "clean";

  if (mode === "context-lost") {
    // The extension was reloaded while this panel was open. Nothing can
    // work any more, so the ONLY correct outcome is the panel reloading
    // itself. This is the 2026-10-16 watchdog.
    const watchdogLog = panelLogs.filter((l) => /panel self-reload/.test(l));
    report("dead extension context detected (watchdog fired)", watchdogLog.length >= 1,
      `watchdog activations=${watchdogLog.length}`);
    report("panel actually attempted location.reload()",
      pageErrors.some((e) => /Not implemented: navigation|self-reload failed/i.test(e)),
      `pageErrors=${pageErrors.length} (jsdom has no navigation; the not-implemented event IS the signal)`);
    report("context-loss notice shown to the user",
      /扩展已更新/.test(window.document.getElementById("contextLostToast")?.textContent || ""),
      `toast=${JSON.stringify((window.document.getElementById("contextLostToast")?.textContent || "").slice(0, 60))}`);
    report("self-reload is de-duplicated (no reload storm)", watchdogLog.length === 1,
      `watchdog activations=${watchdogLog.length} (contextLostHandled guard)`);
    report("manual escape hatch exists in the DOM",
      !!window.document.getElementById("reloadPanelBtn"),
      "welcome screen button #reloadPanelBtn");
    // Note: the MAX_AUTO_RELOADS loop cap lives in sessionStorage, which
    // jsdom refuses on the chrome-extension:// origin (SecurityError), so
    // the cap itself cannot be exercised here — the production code
    // degrades safely (bumpReloadCount falls back to 1).
  } else if (mode === "stuck-stale") {
    // Zombie job >35 min: the panel must NOT hang on the loading screen —
    // it acks the record and shows the error screen instead.
    const acked = sentMessages.includes("ackWhisperJobDone");
    report("stale zombie job: ackWhisperJobDone sent + error screen (not eternal spinner)", acked,
      acked ? "" : "no ack seen; chain: " + sentMessages.join(" → "));
    report("stale zombie job: tabsNav intentionally hidden (error state, no spinner hostage)", tabsDisplay !== "flex",
      `display=${JSON.stringify(tabsDisplay)}`);
  } else if (mode === "stuck-fresh") {
    // A genuinely running job (2 min old) MUST hijack the panel onto the
    // loading screen — that is the contract, not a bug. Only zombies older
    // than the 35-min guard get released, so this mode asserts the panel is
    // NOT acked and the transcript pipeline is NOT run.
    const loadingDisplay = window.document.getElementById("loadingState")?.style.display || "";
    report("fresh in-flight job: loading screen shown, tabs hidden",
      loadingDisplay === "block" && tabsDisplay !== "flex",
      `loading=${JSON.stringify(loadingDisplay)} tabs=${JSON.stringify(tabsDisplay)}`);
    report("fresh in-flight job: not acked (the run still owns the record)",
      !sentMessages.includes("ackWhisperJobDone"),
      `chain: ${sentMessages.join(" → ")}`);
  } else {
    report(`#tabsNav reached display:flex (user-visible symptom check)`, tabsDisplay === "flex",
      `current display=${JSON.stringify(tabsDisplay)} [mode=${mode}]`);
    const entries = window.document.querySelectorAll("#transcriptList .transcript-entry").length;
    report(`transcript rendered (#transcriptList .transcript-entry > 0)`, entries > 0, `entries=${entries}`);
  }

  if (mode === "config-fail" || mode === "config-fail-once") {
    // The whole point of the fix: a rejecting checkConfig must NOT strand
    // the panel on the empty initial welcome screen. The retry helper makes
    // 2 attempts; other code paths (wizard, focus refresh) also read config,
    // so assert "retried at least once" rather than an exact call count.
    report("checkConfig rejection was retried (>=2 attempts)", configCallCount >= 2,
      `checkConfig called ${configCallCount}×`);
    const hintText = (window.document.getElementById("welcomeHint")?.textContent || "").trim();
    report("panel left the initial welcome state despite SW rejection",
      window.document.getElementById("welcomeState")?.style.display === "none",
      `welcome display=${JSON.stringify(window.document.getElementById("welcomeState")?.style.display)} hint=${JSON.stringify(hintText.slice(0, 80))}`);
  }

  const msgChain = sentMessages.join(" → ");
  if (mode === "context-lost") {
    // Nothing could reach the extension — assert we never tried to fake a
    // working panel instead.
    report("no transcript pipeline was attempted on a dead context",
      !/fetchTranscript/.test(msgChain), msgChain || "(no messages sent)");
  } else if (mode === "stuck-fresh" || mode === "stuck-stale") {
    // Both whisper-resume modes deliberately short-circuit the boot chain
    // (one shows the spinner, the other acks + errors), so neither can
    // contain checkConfig/fetchTranscript. Assert the short-circuit instead.
    report("whisper-resume mode short-circuits boot (no duplicate transcript fetch)",
      /getWhisperJobStatus/.test(msgChain) && !/fetchTranscript/.test(msgChain), msgChain);
  } else {
    report("boot message chain in expected order",
      /checkConfig/.test(msgChain) && /fetchTranscript/.test(msgChain), msgChain);
  }

  if (pageErrors.length) {
    console.log("\n---- page errors captured ----");
    for (const e of pageErrors.slice(0, 20)) console.log("· " + e.slice(0, 300));
  } else {
    console.log("\n---- no page errors captured ----");
  }

  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} checks passed ====`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
