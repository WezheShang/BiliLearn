// Content-script regression probe (2026-10-16 "1 个页面无响应").
//
// Two renderer-hang mechanisms are reproduced here against the real
// content.js, and both must now be impossible:
//
//   A. UNBOUNDED LISTENERS — Bilibili's Vue re-renders detach our floating
//      note button, sending us back through injectNoteButton()'s creation
//      path again and again. Before the fix each pass added three more
//      listeners to the same long-lived player container, so N rebuilds meant
//      N resetNoteButtonTimer() calls per mousemove -> unresponsive tab.
//
//   B. SELF-FEEDING OBSERVER — our own DOM writes are childList mutations on
//      a body we observe with subtree:true. The probe forces a runaway
//      callback rate and asserts the circuit breaker disconnects instead of
//      spinning.
//
//   C. One-time migration running on a mutation-driven hot path.
//
// Run: node bilidown-tests\_diag_content_hang.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const OBSERVER_COOLDOWN_SLACK = 2500; // must match OBSERVER_COOLDOWN_MS in content.js
// Override to prove the probe can actually catch the bug (red/green check):
// point it at a copy of content.js with the fixes reverted.
const CONTENT_FILE = process.env.CONTENT_UNDER_TEST || path.join(ROOT, "content.js");

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

// ---------- page skeleton that looks enough like a watch page ----------
const vc = new VirtualConsole();
const pageErrors = [];
vc.on("jsdomError", (e) => pageErrors.push(String((e && e.message) || e)));

const dom = new JSDOM(
  `<!doctype html><html><head><title>t</title></head><body>
     <div class="bpx-player-container"><video></video></div>
     <div id="app">
       <div id="toolbar">
         <div class="video-toolbar-left"><div class="video-share"><span>分享</span></div></div>
         <div id="view-source" style="width:40px;height:20px"></div>
       </div>
     </div>
   </body></html>`,
  {
    url: "https://www.bilibili.com/video/BV1hang00000",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  },
);
const { window } = dom;
const { document } = window;

// ---------- count listeners added to the player container ----------
const player = document.querySelector(".bpx-player-container");
const listenerLog = [];
const realAdd = player.addEventListener.bind(player);
player.addEventListener = function (type, fn, opts) {
  listenerLog.push(type);
  return realAdd(type, fn, opts);
};

// ---------- minimal chrome + browser stubs content.js expects ----------
class WEvent {
  constructor() { this.handlers = []; }
  addListener(fn) { this.handlers.push(fn); }
  removeListener(fn) { this.handlers = this.handlers.filter((h) => h !== fn); }
  hasListener(fn) { return this.handlers.includes(fn); }
}
window.chrome = {
  runtime: {
    id: "iecokifhclbnhmgbmadgggidofeeppjn",
    onMessage: new WEvent(),
    getURL: (p) => `chrome-extension://x/${String(p).replace(/^\//, "")}`,
    sendMessage: async () => ({ success: true }),
    lastError: null,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), set: async () => {} },
  },
};
if (!window.matchMedia) {
  window.matchMedia = (q) => ({
    matches: false, media: q, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
}

(async function main() {
  // ---------- load the real content.js ----------
  const evalErrors = [];
  try {
    window.eval(fs.readFileSync(CONTENT_FILE, "utf8"));
  } catch (e) {
    evalErrors.push(String((e && e.stack) || e));
  }
  report("content.js evaluates at top level", evalErrors.length === 0, evalErrors.join(" || ").slice(0, 300));
  report(
    "init exposed helpers on window",
    typeof window.injectNoteButton === "function" && typeof window.setupButtonObserver === "function",
  );

  // ============================================================
  // A. repeated re-injection must NOT accumulate listeners
  // ============================================================
  const REBUILDS = 12;
  for (let i = 0; i < REBUILDS; i++) {
    window.injectNoteButton();
    // Simulate Bilibili's Vue re-render stealing the floating button away.
    const btn = document.getElementById("ytd-note-button");
    if (btn && btn.parentElement) btn.parentElement.removeChild(btn);
  }
  const hoverListeners = listenerLog.filter(
    (t) => t === "mouseenter" || t === "mousemove" || t === "mouseleave",
  ).length;
  report(
    `A1. ${REBUILDS} rebuilds add exactly 3 hover listeners (no growth)`,
    hoverListeners === 3,
    `added=${hoverListeners} types=${JSON.stringify(listenerLog)}`,
  );
  report(
    "A2. bind marker set on the player container",
    player.dataset.bililearnNoteBound === "1",
    `marker=${JSON.stringify(player.dataset.bililearnNoteBound)}`,
  );

  // ============================================================
  // B. runaway observer callback rate must trip the circuit breaker
  // ============================================================
  const stats = window.__bililearnStats;
  report("B0. observer stats exposed for measurement", !!stats, `stats=${JSON.stringify(stats)}`);

  const tripsBefore = stats ? stats.trips : -1;
  // Churn spread across ticks so the observer really fires once per batch.
  for (let round = 0; round < 90; round++) {
    for (let i = 0; i < 5; i++) {
      document.body.appendChild(document.createElement("div"));
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  report(
    "B1. circuit breaker tripped on the runaway callback rate",
    stats && stats.trips > tripsBefore,
    `calls=${stats && stats.calls} trips=${stats && stats.trips}`,
  );
  report(
    "B2. observer disconnected while cooling down",
    stats && stats.pausedUntil > Date.now() - OBSERVER_COOLDOWN_SLACK,
    `pausedUntil=${stats && stats.pausedUntil} now=${Date.now()}`,
  );
  report("B3. own-UI mutation filter exists", typeof window.mutationsAreAllBililearnOwned === "function");
  const ownedTarget = document.createElement("div");
  ownedTarget.id = "ytd-note-button";
  document.body.appendChild(ownedTarget);
  report(
    "B4. filter recognises nodes we injected",
    window.mutationsAreAllBililearnOwned([{ target: ownedTarget }]) === true &&
      window.mutationsAreAllBililearnOwned([{ target: document.body }]) === false,
    "inside our own UI → filtered; page-level → not filtered",
  );

  // ============================================================
  // C. one-time migration must not run on the hot path
  // ============================================================
  const storageRemovals = [];
  const proto = Object.getPrototypeOf(window.localStorage);
  const origRemove = proto.removeItem;
  window.localStorage.removeItem = function (k) { storageRemovals.push(k); return origRemove.call(this, k); };
  for (let i = 0; i < 5; i++) window.injectBililearnButton();
  window.localStorage.removeItem = origRemove;
  report(
    "C1. legacy localStorage migration runs at most once across 5 reconciles",
    storageRemovals.length <= 1,
    `removeItem calls=${storageRemovals.length} keys=${JSON.stringify(storageRemovals)}`,
  );

  if (pageErrors.length) {
    console.log("\n---- page errors captured ----");
    for (const e of pageErrors.slice(0, 10)) console.log("· " + e.slice(0, 240));
  } else {
    console.log("\n---- no page errors captured ----");
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} checks passed ====`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS CRASH:", e);
  process.exit(2);
});
