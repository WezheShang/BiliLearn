/**
 * Headless e2e for the selection pill's 📝 "添加到笔记" action.
 *
 * The real extension runs inside Chrome. This JSDOM harness wires the two
 * halves together over a single message bus (sidepanel ⇄ background) with one
 * in-memory chrome.storage.local shared by both, so the test drives exactly
 * the path a user drives:
 *
 *   select text in 字幕 → pill appears → click 📝 → the real background
 *   handler runs → note lands in storage → "noteSaved" broadcast → the 笔记
 *   tab re-renders with the selected text
 *
 * Test layout:
 *   1. Pill composition — three buttons, 📝 last, icon-only, labelled.
 *   2. Clicking 📝 stores the SELECTED TEXT (not the whole row / not the
 *      summary) and anchors it to the transcript row's timestamp.
 *   3. The note keeps the regular-note shape, so ▶ Play and 🔗 Copy
 *      timestamp survive — an isFullNote note loses both.
 *   4. The save outcome is flashed back where the pill was (it hides on
 *      click, so otherwise the save would be silent).
 *   5. A new selection made during that flash restores the buttons instead of
 *      leaving an empty pill.
 *   6. The 笔记 tab actually renders the selected text.
 *
 * Harness notes (why the setup looks like this):
 *   - `chrome.downloads.search` MUST invoke its callback. getSettings()
 *     awaits resolveDownloadsRoot() when no explicit subtitlesDir is set, and
 *     a search stub that never calls back hangs every settings read — which
 *     reads as "the note save never responds".
 *   - sidepanel.js is injected with window.eval, and jsdom gives each eval its
 *     own top-level lexical scope. A later eval("currentVideoId = ...")
 *     therefore creates a *different* binding that the running code never
 *     sees. Seeding state only works if the setter is compiled in the SAME
 *     eval as sidepanel.js, so __seed below is appended to that source.
 *
 * Any failure exits non-zero.
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

// ---------- Shared message bus (sidepanel ⇄ background) ----------
const noopEvent = {
  addListener: () => {},
  removeListener: () => {},
  hasListener: () => false,
};

const localStore = {};
const bgListeners = [];
const spListeners = [];

function dispatch(listeners, message, sender) {
  return new Promise((resolve) => {
    let done = false;
    let sawAsync = false;
    const sendResponse = (r) => {
      if (!done) { done = true; resolve(r); }
    };
    for (const fn of listeners.slice()) {
      let ret;
      try { ret = fn(message, sender, sendResponse); } catch (_e) {}
      if (ret === true) sawAsync = true;
    }
    if (!sawAsync && !done) { done = true; resolve(undefined); }
    setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, 5000);
  });
}

// ---------- chrome shim ----------
function makeChromeShim(which) {
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
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    sync: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    onChanged: noopEvent,
  };

  return {
    storage,
    runtime: {
      sendMessage: (msg) =>
        which === "sidepanel"
          ? dispatch(bgListeners, msg, { id: 1 })
          : dispatch(spListeners, msg, { id: 1 }),
      onMessage: {
        addListener: (fn) => (which === "sidepanel" ? spListeners : bgListeners).push(fn),
      },
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
      // Must call back — see the harness note at the top of this file.
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
  w.chrome = makeChromeShim("sidepanel");
  w.fetch = () => Promise.reject(new Error("no network in test"));
  w.URL = URL;
  // The seed setter MUST ride in this same eval — see the harness note.
  const seed =
    "\n;globalThis.__seed = function (id, t, c) {" +
    "  currentVideoId = id; currentVideoTitle = t; currentChannelName = c;" +
    "  return currentVideoId;" +
    "};";
  w.eval(fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8") + seed);
  await new Promise((r) => setTimeout(r, 60));
  return w;
}

function loadBackground() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://fake-id/background.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.chrome = makeChromeShim("background");
  w.fetch = () => Promise.reject(new Error("no network in test"));
  w.URL = URL;
  // The real service worker pulls these in via importScripts; load them for
  // real so the KB helpers the note path touches exist, as in Chrome.
  w.importScripts = (f) => { w.eval(fs.readFileSync(path.join(ROOT, f), "utf8")); };
  w.eval(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"));
  return w;
}

// ---------- Selection fixture ----------
const SELECTED_TEXT = "这是一段被选中的文字";
const ROW_SECONDS = 95;

function buildTranscriptDom(w) {
  const panel = w.document.createElement("div");
  panel.className = "tab-panel";
  panel.dataset.panel = "transcript";
  panel.innerHTML = `
    <div class="transcript-entry" data-seconds="${ROW_SECONDS}" data-segment-id="s1" data-segment-index="0">
      <span class="transcript-time">1:35</span>
      <span class="transcript-copy"><span class="transcript-original">${SELECTED_TEXT}</span></span>
    </div>
  `;
  w.document.body.appendChild(panel);
  return panel.querySelector(".transcript-original").firstChild;
}

function stubSelection(w, textNode, text = SELECTED_TEXT) {
  const range = {
    startContainer: textNode,
    endContainer: textNode,
    getBoundingClientRect: () => ({ top: 200, bottom: 220, left: 10, right: 100, width: 90, height: 20 }),
  };
  w.getSelection = () => ({
    anchorNode: textNode,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => text,
  });
}

function selectText(w) {
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
  return w.document.getElementById("explainTooltip");
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ---------- Main ----------
(async function main() {
  console.log("\n[1/6] Loading sidepanel + background over a shared bus…");
  const sp = await loadSidepanel();
  loadBackground();
  assertEqual(typeof sp.setupExplainFeature, "function", "sidepanel exposes setupExplainFeature");
  assertEqual(
    sp.__seed("BV1test12345", "测试视频", "测试UP"),
    "BV1test12345",
    "harness can seed the video the panel has loaded",
  );

  const textNode = buildTranscriptDom(sp);
  stubSelection(sp, textNode);
  sp.setupExplainFeature();

  console.log("\n[2/6] Pill composition — 📝 must be the third, icon-only button…");
  const pill = selectText(sp);
  assertTrue(!!pill, "pill element exists after a selection");
  assertEqual(pill.style.display, "flex", "pill becomes visible after a selection");
  const btns = [...pill.querySelectorAll("button[data-pill-action]")];
  assertEqual(btns.map((b) => b.dataset.pillAction), ["explain", "ask", "note"], "pill has explain, ask, note in order");
  assertEqual(btns[2].textContent.trim(), "📝", "note pill shows only the 📝 icon");
  assertEqual(btns[2].getAttribute("aria-label"), "添加到笔记", "note pill carries an accessible label");
  assertTrue(
    btns[0].textContent.includes("Explain") && btns[1].textContent.includes("Ask AI"),
    "the two existing pills kept their text labels",
  );

  console.log("\n[3/6] Clicking 📝 acknowledges immediately, then saves the SELECTED TEXT…");
  const tClick = Date.now();
  btns[2].click();
  // The pending state must land within a frame — the background round-trip
  // (getSettings' download probe + the KB mirror) is not instant, and a pill
  // that just vanishes reads as a dead click.
  await settle(20);
  const pending = pill.querySelector(".explain-pill-status");
  assertTrue(!!pending, "pill acknowledges the click straight away");
  assertEqual(
    pending.textContent.trim(),
    "保存中…",
    `pending state shows within ${Date.now() - tClick}ms instead of silence`,
  );

  const notes = localStore.ytd_notes;
  assertTrue(Array.isArray(notes) && notes.length === 1, "exactly one note was stored");
  assertEqual(notes[0].text, SELECTED_TEXT, "the stored note text IS the selected text");
  assertEqual(notes[0].videoId, "BV1test12345", "note is bound to the current video");
  assertEqual(notes[0].source, "selection", "note is tagged source=selection");

  console.log("\n[4/6] Anchored to the transcript row, regular-note shape kept…");
  assertEqual(notes[0].timestampSeconds, ROW_SECONDS, `note is anchored to the row (${ROW_SECONDS}s)`);
  assertEqual(notes[0].timestamp, "1:35", "note shows a readable M:SS timestamp");
  assertTrue(
    typeof notes[0].timestampedUrl === "string" && notes[0].timestampedUrl.includes(`t=${ROW_SECONDS}s`),
    "timestamped deep link points at the selection's position",
  );
  assertEqual(
    notes[0].isFullNote,
    undefined,
    "note is NOT isFullNote (that shape loses the timestamp and ▶ Play)",
  );

  console.log("\n[5/6] Save outcome is flashed back where the pill was…");
  await settle(2500);
  const status = pill.querySelector(".explain-pill-status");
  assertTrue(!!status, "pill shows a save-status message after the click");
  assertEqual(
    status.textContent.trim(),
    "✓ 已保存至笔记",
    `status reads as success (round-trip took ${Date.now() - tClick}ms)`,
  );

  console.log("\n[6/6] A new selection during the flash restores the buttons…");
  stubSelection(sp, textNode, "第二段被选中的文字");
  const pill2 = selectText(sp);
  assertEqual(pill2, pill, "same pill container is reused");
  assertTrue(
    !pill2.querySelector(".explain-pill-status"),
    "the stale success message is cleared",
  );
  assertEqual(
    [...pill2.querySelectorAll("button[data-pill-action]")].map((b) => b.dataset.pillAction),
    ["explain", "ask", "note"],
    "buttons are back, not replaced by the status span",
  );

  // ---------- The 笔记 tab actually shows it ----------
  await settle(400);
  const listHtml = sp.document.getElementById("notesList").innerHTML;
  assertTrue(listHtml.includes(SELECTED_TEXT), "the 笔记 tab renders the selected text");
  assertTrue(!listHtml.includes("整篇笔记"), "the note is NOT rendered as a 整篇笔记 block");
  assertTrue(listHtml.includes("1:35"), "the 笔记 tab shows the selection's timestamp");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("\nTEST FAILURE:", err.message);
  process.exit(1);
});
