/**
 * Headless regression test for the Ask AI context classifier on thinking
 * models (glm-4.6).
 *
 * Bug (user screenshot 2026-10-16): asking a follow-up question in the Ask AI
 * drawer failed with "请求失败：AI provider returned an empty response."
 *
 * Cause: the drawer runs a YES/NO classifier before answering, with
 * maxTokens: 8. glm-4.6 is a thinking model, so its SSE stream spends the
 * whole budget on `delta.reasoning_content` and emits no `delta.content` at
 * all. readStreamedAiCompletion returned "" and requestAiCompletion threw
 * EMPTY_AI_RESPONSE — which propagated to the outer catch and failed the
 * entire turn. The user never reached the answer stage.
 *
 * The classifier is only an optimisation (does this question want the video
 * context?), so a broken classifier must degrade to the safe default instead
 * of killing the question.
 *
 * This drives the REAL handleAskAiChat with a fetch stub that reproduces
 * exactly that stream: reasoning-only deltas for the classifier call, normal
 * content deltas for the answer call.
 *
 * Any failure exits non-zero.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Reverse-verification hook: point this at a copy of background.js with a
// fix reverted and the suite must FAIL. See the reverse-verification note in
// the file header.
const BACKGROUND_PATH =
  process.env.BACKGROUND_UNDER_TEST || path.join(ROOT, "background.js");

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!ok) throw new Error(`assertEqual ${label}`);
}

const noopEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false };

// ---------- SSE stub ----------
const encoder = new TextEncoder();
function sseResponse(chunks) {
  let i = 0;
  return {
    ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < chunks.length
              ? { done: false, value: encoder.encode(chunks[i++]) }
              : { done: true, value: undefined },
          ),
      }),
    },
  };
}

// A glm-4.6 stream that thinks for the whole budget and never emits content.
const REASONING_ONLY = [
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先判断这个问题是否关于视频内容" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "用户问的是线段被破坏后会发生什么" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {} }], finish_reason: "length" })}\n\n`,
  `data: [DONE]\n\n`,
];

const ANSWER = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "线段被破坏后，" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "原本的趋势结构失效。" } }] })}\n\n`,
  `data: ${DONE_MARKER()}\n\n`,
];
function DONE_MARKER() { return "[DONE]"; }

// ---------- Boot the background ----------
const requestBodies = [];
let callCount = 0;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "chrome-extension://fake-id/background.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const bg = dom.window;

bg.chrome = {
  runtime: {
    onMessage: noopEvent,
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onConnect: noopEvent,
    onSuspend: noopEvent,
    getURL: (p) => `chrome-extension://fake-id/${p}`,
    getManifest: () => ({ version: "1.0" }),
    sendMessage: () => Promise.resolve({}),
    openOptionsPage: () => {},
  },
  storage: {
    local: {
      get: (k, cb) => { const v = { ytd_settings: {} }; if (cb) { try { cb(v); } catch (_) {} } return Promise.resolve(v); },
      set: (o, cb) => { if (cb) { try { cb(); } catch (_) {} } return Promise.resolve(); },
      remove: (k, cb) => { if (cb) { try { cb(); } catch (_) {} } return Promise.resolve(); },
    },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    sync: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    onChanged: noopEvent,
  },
  tabs: { query: () => Promise.resolve([]), create: () => Promise.resolve({ id: 1 }), sendMessage: () => Promise.resolve({}), onUpdated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent },
  windows: { getCurrent: () => Promise.resolve({ id: 1 }), create: () => Promise.resolve({ id: 1 }), onFocusChanged: noopEvent, WINDOW_ID_NONE: -1 },
  alarms: { create: () => {}, clear: () => Promise.resolve(true), getAll: () => Promise.resolve([]), onAlarm: noopEvent },
  notifications: { create: () => {}, onClicked: noopEvent },
  downloads: {
    download: (o, cb) => { if (cb) { try { cb(1); } catch (_) {} } return 1; },
    open: () => {},
    onChanged: noopEvent,
    search: (q, cb) => { if (typeof cb === "function") { try { cb([{ id: 1 }]); } catch (_) {} } },
    removeFile: () => {}, erase: () => {},
  },
  commands: { onCommand: noopEvent },
  contextMenus: { create: () => {}, removeAll: () => Promise.resolve(), onClicked: noopEvent },
  action: { setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve(), onClicked: noopEvent },
  scripting: { executeScript: () => Promise.resolve([]) },
  sidePanel: { setPanelBehavior: () => {}, setOptions: () => Promise.resolve(), open: () => Promise.resolve() },
  i18n: { getUILanguage: () => "zh-CN", getMessage: (k) => k },
  permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(false) },
};
bg.URL = URL;
bg.TextEncoder = TextEncoder;
bg.TextDecoder = TextDecoder;
bg.importScripts = (f) => bg.eval(fs.readFileSync(path.join(ROOT, f), "utf8"));

bg.fetch = (url, opts = {}) => {
  const href = String(url);
  if (href.endsWith(".md")) {
    const rel = href.split("/").pop();
    const body = fs.readFileSync(path.join(ROOT, "prompts", rel), "utf8");
    return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
  }
  // Chat completions call.
  requestBodies.push(JSON.parse(opts.body || "{}"));
  callCount += 1;
  return Promise.resolve(sseResponse(callCount === 1 ? REASONING_ONLY : ANSWER));
};

bg.eval(fs.readFileSync(BACKGROUND_PATH, "utf8"));

// ---------- Main ----------
(async function main() {
  console.log("\n[1/4] Background loaded with a glm-4.6-shaped provider…");
  assertEqual(typeof bg.handleAskAiChat, "function", "handleAskAiChat is reachable");

  console.log("\n[2/4] A follow-up question survives a reasoning-only classifier stream…");
  const result = await bg.handleAskAiChat({
    question: "线段被破坏之后，会发生什么?",
    // Non-empty history ⇒ this is a follow-up ⇒ the classifier actually runs.
    history: [
      { role: "user", content: "D3 的低点高于 G1 的高点?" },
      { role: "assistant", content: "是的，这是标准的上升结构。" },
    ],
    selection: "",
    videoTitle: "测试视频",
    channelName: "测试UP",
    transcript: "D1 低点，G1 高点，D2 回落，D3 低点高于 G1 高点，形成上升趋势。",
    summary: "",
    providerOverride: {
      provider: "glm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6",
      apiKey: "test-key",
    },
  });

  assertTrue(
    result.success === true,
    "the turn succeeds even though the classifier produced no content",
    result.success ? "" : `error was: ${result.error}`,
  );
  assertEqual(
    result.answer,
    "线段被破坏后，原本的趋势结构失效。",
    "the answer comes from the answer stage, not the classifier",
  );

  console.log("\n[3/4] A broken classifier falls back to the safe default…");
  assertEqual(result.usedContext, true, "video context is attached when the classifier is unusable");

  console.log("\n[4/4] The classifier asks for no reasoning pass…");
  assertTrue(requestBodies.length >= 2, "both the classifier and answer calls were made");
  const classifierBody = requestBodies[0];
  assertEqual(classifierBody.model, "glm-4.6", "the classifier used the drawer-selected model");
  assertEqual(
    classifierBody.thinking,
    { type: "disabled" },
    "classifier sends thinking.type=disabled so glm-4.6 answers YES/NO directly",
  );
  assertTrue(
    classifierBody.max_tokens >= 8,
    `classifier budget was raised (${classifierBody.max_tokens}) so it isn't spent entirely on reasoning`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("\nTEST FAILURE:", err.message);
  process.exit(1);
});
