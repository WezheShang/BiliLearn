/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for dk-bililearn: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// 2026-10-27: 构建指纹 —— 必须和 background.js 里的 BG_BUILD 一致。
// 启动时跟后台握手比对：对不上就说明后台 Service Worker 还在跑旧代码
// （改了文件不去 chrome://extensions 点"刷新"就是这样），这时候给用户
// 一句人话，比让旧后台把请求处理坏、报出 "Invalid Bilibili BV ID." 这种
// 完全看不懂的错要好得多。tests/xuetangx.test.js 里有一条用例守着这个
// 一致性 —— 以后改了任一边忘了改另一边，测试会直接挂。
const SP_BUILD = "2026-11-06.1";

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
const BILILEARN_CACHE_SCHEMA_VERSION = 4;
// chrome.storage.local key prefix for per-video transcript/analysis cache.
// Entries written before the bilidown→bililearn rename (2026-09) live under
// the legacy prefix; reads fall back to it and migrate, removes clear both.
const CACHE_KEY_PREFIX = "bililearn_";
const LEGACY_CACHE_KEY_PREFIX = "bilidown_";

// Clear a video's cache under both the current and the legacy (pre-rename)
// prefix. chrome.storage.local.remove on a missing key is a harmless no-op.
async function removeVideoCache(videoId) {
  if (!videoId) return;
  await chrome.storage.local.remove([
    `${CACHE_KEY_PREFIX}${videoId}`,
    `${LEGACY_CACHE_KEY_PREFIX}${videoId}`,
  ]);
}
let generation = 0;
let currentVideoUrl = null;
let currentAnalysis = null;
// 2026-10-27: 学堂在线课程自带的"知识导引"。有它就直接当概览用，
// 不再花钱跑 AI 概览（用户要求）。null = 这节课没有导引 → 照常走 AI。
let currentXuetangxChapters = null;
// 2026-10-27: 学堂在线的官方章节**试过一次没有**（用来决定要不要弹
// "配置AI"的引导 —— 有官方章节就不需要 AI）。
let xuetangxChaptersChecked = false;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptSource = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let currentPubDate = ""; // YYYY-MM-DD string from B站's metadata, used in export filenames
// 2026-09-12 cross-video race fix: in-flight LLM calls are tracked PER
// VIDEO, not as a single global boolean. The old globals (isAnalysisLoading
// / isSummaryLoading) blocked the NEXT video's lazy load while the
// PREVIOUS video's call was still running, and the triggers saved their
// result under whichever video was CURRENT at completion time — rendering
// video A's summary into video B's panel and poisoning B's cache entry
// permanently (user report 2026-09-12: 巴克莱 header + 中金铜矿 summary).
const analysisInFlight = new Set(); // videoId → analysis call running
const summaryInFlight = new Set();  // videoId → summary call running
let currentSummary = null; // Full-note summary (Markdown text) for this video
let bilibiliTabId = null; // Store the Bilibili tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

// ============================================================
// EXTENSION-CONTEXT WATCHDOG (2026-10-16)
// ============================================================
//
// Why the panel kept dying "every time I change code": changing ANY
// extension file means reloading the extension (chrome://extensions →
// reload). That kills the service worker and INVALIDATES every
// already-open extension document — but Chrome does NOT reload the side
// panel, so it freezes in place: DOMContentLoaded has long since fired,
// every chrome.* call throws "Extension context invalidated", and there
// is no way out except manually closing the panel. That is not a code
// bug; it is what reloading an extension does.
//
// So: detect the dead context and reload THIS document. Three
// independent triggers, because each covers a case the others miss:
//   1. an idle heartbeat (covers "nothing happened, panel just froze"),
//   2. window error / unhandledrejection (covers the moment it happens),
//   3. the boot chain itself (covers "it died before the panel ever
//      reached a working state").
//
// The auto-reload is capped and de-duplicated: a context that stays
// broken must not spin, it must show a button the user can click.

const CONTEXT_LOST_RE =
  /Extension context invalidated|Receiving end does not exist|message port closed before a response/i;
const RELOAD_COUNT_KEY = "bililearnPanelReloadCount";
const MAX_AUTO_RELOADS = 3;
const CONTEXT_WATCHDOG_MS = 2000;

let contextLostHandled = false;

function errorLooksLikeContextLoss(err) {
  const text = String((err && (err.message || err)) || err || "");
  return CONTEXT_LOST_RE.test(text);
}

function bumpReloadCount() {
  try {
    const next = (Number(sessionStorage.getItem(RELOAD_COUNT_KEY)) || 0) + 1;
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(next));
    return next;
  } catch {
    return 1;
  }
}

/**
 * Survived a reload: the new context is healthy, so let the next
 * incident reload freely again.
 */
function clearReloadCount() {
  try {
    sessionStorage.removeItem(RELOAD_COUNT_KEY);
  } catch {}
}

function showContextLostToast(message) {
  const id = "contextLostToast";
  if (!document.body) return;
  let toast = document.getElementById(id);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = id;
    toast.setAttribute("role", "status");
    Object.assign(toast.style, {
      position: "fixed",
      inset: "0 0 auto 0",
      zIndex: "2147483000",
      background: "#2f6df6",
      color: "#ffffff",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontSize: "12.5px",
      lineHeight: "1.5",
      padding: "9px 12px",
      textAlign: "center",
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  document.documentElement.setAttribute("data-panel-reloading", "1");
}

/**
 * The extension context is gone (extension reloaded / updated /
 * disabled). Reload this panel document so it can talk to the new
 * service worker again — capped, so a still-broken context falls back to
 * a manual button instead of a reload loop.
 */
function recoverFromContextLoss(reason) {
  if (contextLostHandled) return;
  contextLostHandled = true;
  const n = bumpReloadCount();
  console.warn(
    `[dk-bililearn Panel] extension context lost (${reason}) — panel self-reload #${n}`,
  );
  if (n <= MAX_AUTO_RELOADS) {
    showContextLostToast("扩展已更新，正在自动重载面板…");
    setTimeout(() => {
      try {
        location.reload();
      } catch (e) {
        console.error("[dk-bililearn Panel] self-reload failed:", e);
      }
    }, 300);
    return;
  }
  showContextLostToast(
    `面板已自动重载 ${MAX_AUTO_RELOADS} 次仍未恢复，请关闭再打开侧边栏，或点击扩展图标重新打开。`,
  );
}

// (1) Idle heartbeat. chrome.runtime.getPlatformInfo is answered by the
// browser process itself — it never wakes the service worker, and it
// still throws once the context has been invalidated.
setInterval(() => {
  if (contextLostHandled || document.hidden) return;
  try {
    const result = chrome.runtime.getPlatformInfo();
    if (result && typeof result.then === "function") {
      result.then(clearReloadCount, (err) => {
        if (errorLooksLikeContextLoss(err)) recoverFromContextLoss(err?.message);
      });
    } else {
      clearReloadCount();
    }
  } catch (err) {
    if (errorLooksLikeContextLoss(err)) recoverFromContextLoss(err?.message);
  }
}, CONTEXT_WATCHDOG_MS);

// (2) The moment it happens, even if the heartbeat hasn't ticked yet.
window.addEventListener("error", (event) => {
  if (errorLooksLikeContextLoss(event?.error || event?.message)) {
    recoverFromContextLoss(event?.message);
  }
});
window.addEventListener("unhandledrejection", (event) => {
  if (errorLooksLikeContextLoss(event?.reason)) {
    recoverFromContextLoss(event?.reason?.message);
  }
});

// Manual escape hatch: always available on the welcome screen.
document.addEventListener("click", (event) => {
  if (event.target && event.target.id === "reloadPanelBtn") {
    try {
      location.reload();
    } catch (e) {
      console.error("[dk-bililearn Panel] manual reload failed:", e);
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  void bootSidePanel();
});

// ============================================================
// BOOT / SELF-HEAL (2026-10-16)
// ============================================================
//
// User report: on ONE video page the sidebar never left the initial
// 「开始整理视频」 screen — no hint text, no tabs, no error. Every other
// page worked. The distinguishing detail was Chrome's 「从上次停下的地方
// 继续」 restore bar: that panel had been restored from a previous
// session, so it booted while the service worker was still asleep and
// `sendMessage({action:"checkConfig"})` rejected with "Could not
// establish connection".
//
// That call used to be the ONE unguarded await in the boot chain, so
// the rejection aborted everything downstream — `checkCurrentTab()`
// never ran, `showWelcome()` was never called (which is exactly why the
// hint was EMPTY: the welcome screen the user saw was the untouched
// HTML initial state, not any rendered message), and the panel sat
// there forever. The tab/window listeners further down this file DO
// recover it — but only once a tab/focus event fires.
//
// Three changes make this class of failure impossible to be silent:
//   1. each boot step is isolated — no single failure can abort the rest;
//   2. `checkConfig` retries once (letting the SW finish waking) and
//      then degrades to "no AI key", which is the state the wizard flow
//      already handles;
//   3. a panel still sitting on the empty initial welcome re-runs
//      detection on the next focus/visibility change.

let bootInFlight = false;
let bootRetryTimer = null;
let wizardBound = false;

async function bootSidePanel() {
  bootInFlight = true;
  try {
    setupEventListeners();
    initWhisperQueuePanel();
    await evictOldCacheEntries(20);

    // If a whisper job is in flight (or just finished) from before this
    // panel was last closed, restore the matching loading screen first so
    // we don't flash the "no cache, click to start" error. We do this
    // BEFORE the config check because the user has already kicked off a
    // long job — they shouldn't be bounced to the config error mid-run.
    const resumed = await maybeResumeWhisperJob();
    if (resumed) return;

    await runPanelDetection();
  } catch (error) {
    // A dead extension context (the panel was open when the extension got
    // reloaded) must self-heal, not sit there showing a cryptic message.
    if (errorLooksLikeContextLoss(error)) {
      recoverFromContextLoss(error?.message);
      return;
    }
    console.error("[dk-bililearn Panel] boot failed:", error);
    showWelcome("面板启动失败：" + ((error && error.message) || error));
  } finally {
    bootInFlight = false;
  }
}

/**
 * `checkConfig` with one retry. A panel restored by Chrome's session
 * restore can boot before the service worker finishes waking; the first
 * sendMessage then rejects and used to kill the boot chain. Retrying
 * once covers the wake race, and returning null degrades to
 * aiKeyMissing=true — the transcript tab needs no key at all.
 */
async function fetchConfigStatusWithRetry() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ action: "checkConfig" });
    } catch (error) {
      console.warn(
        `[dk-bililearn Panel] checkConfig attempt ${attempt} failed:`,
        error,
      );
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  return null;
}

function activeTabPanelName() {
  return (
    (document.querySelector(".tab-panel.active") || { dataset: {} }).dataset
      .panel || "transcript"
  );
}

/** Repeatable part of boot: AI-key state + "what am I looking at". */
async function runPanelDetection() {
  const configStatus = await fetchConfigStatusWithRetry();

  // Contextual-wizard flow (2026-08-28): a missing AI key no longer
  // blocks the whole panel. The transcript tab needs no key at all;
  // the Overview/Summary tabs show the AI-key wizard instead of firing
  // a doomed LLM request (see updateAiKeyWizard / switchTab).
  aiKeyMissing = !(configStatus && configStatus.hasAiKey);

  // One-shot: these bind DOM listeners, so a retry must not double-bind.
  if (!wizardBound) {
    setupWizardButtons();
    setupLongTranscribeConfirm();
    wizardBound = true;
  }
  // Key state may have flipped (user saved / cleared a key in options):
  // refresh the wizard + LLM section visibility for the active tab now,
  // instead of waiting for the next switchTab.
  updateAiKeyWizard(activeTabPanelName());

  await checkCurrentTab();
}

// 2026-08-29 user report: after saving a key in options and switching
// back, the wizard page never refreshed (even on tab switches) — the
// config check ran exactly once at panel open. Re-check whenever this
// panel becomes visible or focused again.
async function refreshAiKeyState() {
  let configStatus = null;
  try {
    configStatus = await chrome.runtime.sendMessage({ action: "checkConfig" });
  } catch {
    return; // service worker unreachable — keep the current state
  }
  const missing = !(configStatus && configStatus.hasAiKey);
  if (missing === aiKeyMissing) return; // nothing changed, no re-render
  aiKeyMissing = missing;
  updateAiKeyWizard(activeTabPanelName());
}

/**
 * The untouched initial welcome screen: welcome block visible AND no
 * hint text. Every state the app renders deliberately calls
 * showWelcome(<message>), so an empty hint can only mean the boot chain
 * never reached its first showState() call.
 */
function panelBootIncomplete() {
  const welcome = document.getElementById("welcomeState");
  if (!welcome || welcome.style.display === "none") return false;
  const hint = document.getElementById("welcomeHint");
  return !hint || !hint.textContent.trim();
}

/**
 * Self-heal: a panel frozen on the empty initial welcome re-runs
 * detection on the next focus / visibility change instead of waiting
 * for a tab switch that may never come.
 */
function scheduleBootRetry() {
  if (bootRetryTimer || bootInFlight || !panelBootIncomplete()) return;
  bootRetryTimer = setTimeout(() => {
    bootRetryTimer = null;
    if (bootInFlight || !panelBootIncomplete()) return;
    console.warn(
      "[dk-bililearn Panel] boot never completed — retrying detection",
    );
    bootInFlight = true;
    void (async () => {
      try {
        await runPanelDetection();
      } catch (error) {
        console.error("[dk-bililearn Panel] detection retry failed:", error);
        showWelcome("面板启动失败：" + ((error && error.message) || error));
      } finally {
        bootInFlight = false;
      }
    })();
  }, 400);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void refreshAiKeyState();
  scheduleBootRetry();
});
window.addEventListener("focus", () => {
  void refreshAiKeyState();
  scheduleBootRetry();
});

/**
 * On panel open, ask the background "are you still running a whisper
 * job for me?" If yes, jump straight to the loading state with the
 * last-known stage text. If the job already terminated (succeeded /
 * failed) we let the user see the result/failure then ack so we don't
 * keep re-reading the terminal state forever.
 */
async function maybeResumeWhisperJob() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ action: "getWhisperJobStatus" });
  } catch {
    return false;
  }
  const job = status && status.job;
  if (!job) return false;
  if (!job.videoId) return false; // malformed record, ignore

  // Only resume if the active tab is a B站/YouTube page whose video id
  // matches the job. If the user is on another site, a different video,
  // or we can't tell what tab they're on, fall through to the normal
  // flow — don't show another video's job state in someone else's
  // sidebar. 2026-09-30: readActiveBilibiliVideoId now returns the
  // @p-suffixed cache-key form (YouTube support), while job.videoId is
  // stored bare (the trigger message strips the suffix) — compare on
  // the bare id or the match can never succeed.
  const frontVideoId = await readActiveBilibiliVideoId();
  if (
    !frontVideoId ||
    String(frontVideoId).split("@p")[0] !== String(job.videoId).split("@p")[0]
  ) {
    return false;
  }

  // Show the loading screen with the persisted stage so the user knows
  // the job is still running for THIS video.
  showState("loading");
  updateLoading(
    job.title || "Whisper 转录中",
    job.subtitle || "转录在后台进行，可随意切换页面；回到本页会显示进度",
  );

  // 2026-10-11 hardening: the background watchdog caps non-terminal jobs
  // at 30 min. If a job is older than 35 min and STILL non-terminal, the
  // watchdog never fired (SW restart race, throttled alarm, extension
  // reload) — a zombie record must not hold this panel hostage with a
  // spinner and no tabs. Treat it as failed so the user gets an error +
  // retry instead of an eternal loading screen.
  const jobStartedAt = Number(job.startedAt) || 0;
  if (
    jobStartedAt &&
    Date.now() - jobStartedAt > 35 * 60 * 1000 &&
    job.stage !== "succeeded" &&
    job.stage !== "failed"
  ) {
    try {
      await chrome.runtime.sendMessage({ action: "ackWhisperJobDone" });
    } catch {}
    showError(
      "Whisper 转录已中断",
      "后台任务超过 35 分钟无进展，已按失败处理（原因可能是浏览器重启或扩展刷新打断了转写）。重新点击转录即可重试，已完成的转写不受影响。",
    );
    return true;
  }

  if (job.stage === "succeeded") {
    // Re-enter the normal flow so the new transcript renders. Drop the
    // terminal record so the next visit doesn't see a stale state.
    try {
      await chrome.runtime.sendMessage({ action: "ackWhisperJobDone" });
    } catch {}
    await startBililearn(frontVideoId, job.videoUrl || "");
    return true;
  }
  if (job.stage === "failed") {
    try {
      await chrome.runtime.sendMessage({ action: "ackWhisperJobDone" });
    } catch {}
    // 用 background 写入的 title / subtitle（带分类信息）覆盖默认标题
    showError(
      job.title || "Whisper 转录失败",
      job.subtitle || job.error || "未知错误",
    );
    return true;
  }
  // Otherwise: still running. The transcriptProgress handler below will
  // continue to update the loading text as the SW emits new stages.
  return true;
}

/**
 * Best-effort: read the bvid from the active tab's URL so we can tell
 * whether a stored whisper job still belongs to the current view. We
 * fall back to "" rather than throwing because the panel can run while
 * the user is on chrome:// or a new-tab page.
 */
async function readActiveBilibiliVideoId() {
  try {
    // 2026-09-12: panel-window scoped (see queryPanelActiveTab) — the old
    // lastFocusedWindow query misjudged "current view" whenever another
    // window held focus and skipped/attached the wrong whisper job.
    // 2026-09-27: also recognises YouTube — anything extractVideoId
    // can resolve goes through. Returns the @p-suffixed form so the
    // caller's "videoId === currentVideoId" comparison stays aligned
    // with the value `currentVideoId` itself holds.
    const tab = await queryPanelActiveTab();
    const url = tab && tab.url;
    if (!url) return "";
    return extractVideoId(url) || "";
  } catch {
    return "";
  }
}

// Listen for messages from the bililearn button on Bilibili page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startBililearnFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "bilibiliNavigation") {
    handleFrontTabUrl(message.url);
    sendResponse({ success: true });
  }
  if (message.action === "xuetangxVideoChanged") {
    // 2026-10-26: 学堂在线换小节时地址栏不变，所以靠 background 转来的
    // 页面状态通知刷新（重新拉一次字幕 / 概览）。
    scheduleBililearnRefresh();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed.
    // Also refresh the queue panel's running row (stage subtitles move
    // here), and on terminal stages the background may already have
    // started the next queued job — pull fresh queue state.
    refreshWhisperQueue();
    // We now carry an explicit `stage` (downloading / ready_to_transcribe
    // / transcribing / correcting) so the UI can pick more polished copy
    // than the background's title/subtitle pair — but the SW-provided
    // strings are always safe to render.
    const progressVideoId = message.videoId
      ? String(message.videoId).split("@p")[0]
      : null;
    const currentPlainId = currentVideoId
      ? String(currentVideoId).split("@p")[0]
      : null;
    const forThisVideo = !progressVideoId || progressVideoId === currentPlainId;
    if (forThisVideo) {
      updateLoading(message.title || "Whisper 转录中", message.subtitle || "");
    }
    if (message.stage === "succeeded" && forThisVideo && currentPlainId) {
      // The transcription finished (either the live pipeline returned or
      // the watchdog recovered it from the server-side cache). If this
      // panel is attached to the job's video — e.g. it re-attached via
      // maybeResumeWhisperJob and there is no trigger caller around to
      // re-enter startBililearn — do the re-entry ourselves so the
      // subtitles actually render instead of the loading screen sitting
      // there forever. (Async IIFE: this listener is not async and we
      // must not block sendResponse.)
      (async () => {
        try { await chrome.runtime.sendMessage({ action: "ackWhisperJobDone" }); } catch {}
        const vid = currentVideoId;
        if (!vid) return;
        // Drop any stale poisoned entry first, then refetch from the
        // (now-written) server cache.
        try { await chrome.storage.local.remove([`bililearn_${vid}`, `bilidown_${vid}`]); } catch {}
        startBililearn(vid, currentVideoUrl).catch(() => {});
      })();
    }
    if (message.stage === "failed" && forThisVideo) {
      // Fire-and-ack 转录启动后，失败改由广播驱动：面板挂上错误并 ack 掉
      // terminal 记录（与 maybeResumeWhisperJob 的 failed 分支行为一致）。
      (async () => {
        try { await chrome.runtime.sendMessage({ action: "ackWhisperJobDone" }); } catch {}
        showError(
          message.title || "Whisper 转录失败",
          message.subtitle || "转录中断，请重试。",
        );
      })();
    }
    sendResponse({ success: true });
  }
  if (message.action === "whisperQueueUpdate") {
    // Background says the transcribe queue changed (enqueue / remove /
    // pump started the next entry). Re-render the queue panel.
    renderWhisperQueue(
      Array.isArray(message.queue) ? message.queue : [],
      message.job || null,
    );
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT a B站 video -> show the "not on a B站 video"
//     state in the same sidebar. (We used to call window.close() here,
//     but that forced the user to click the extension icon again to
//     reopen the panel after every tab switch — too much friction.)
//   - Front tab IS a B站 video (same or different) -> refresh the
//     digest. Bilibili is a single-page app (clicking a video swaps
//     content without a reload), so we track URL changes; startBililearn()
//     caches per video, making re-checks instant and free for
//     already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
// Set when a new video's content has just been rendered into the panels.
// The first `switchTab` after this resets the side panel's scroll position
// to the top — so the user always sees the new video's Overview / Summary
// from the beginning, not from wherever the previous video was scrolled
// to. After firing once, it clears itself: subsequent tab switches within
// the same video don't yank the scroll (transcript auto-scroll would
// fight us otherwise). Starts true so the cold-start first switch also
// scrolls to top.
let tabScrollTopArmed = true;
// 2026-09-12: the tab the user last viewed on each video (recorded in
// switchTab). Restored when that video comes back from cache, so
// returning to a video you left on 总结 doesn't land you on whatever
// tab the previous video's whisper wizard left active.
const lastTabByVideo = new Map();
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

/**
 * The active tab of THIS panel's window — never `lastFocusedWindow`.
 * (2026-09-12) checkCurrentTab and readActiveBilibiliVideoId both used
 * lastFocusedWindow, so any check that fired while a DIFFERENT window
 * held OS focus (panel init, the page-button relay, the nav refresh
 * timer) judged the wrong window's tab and rendered 「当前页面不是
 * B 站视频」 for e.g. a localhost dev tab; nothing re-checked on pure
 * window refocus either (no tabs.onActivated fires), so the panel stayed
 * stuck on that error after the user switched back to their B站 tab.
 * Scope every "what's in front of me" query to the window hosting this
 * panel.
 */
async function queryPanelActiveTab() {
  let scopeWindowId = panelWindowId;
  if (scopeWindowId === null) {
    // Panel just opened: the module-scope windows.getCurrent() promise
    // may not have resolved yet. From a sidepanel page getCurrent()
    // returns the window hosting the panel.
    try {
      scopeWindowId = (await chrome.windows.getCurrent()).id;
    } catch {
      scopeWindowId = null;
    }
  }
  const tabs = await chrome.tabs.query(
    scopeWindowId !== null
      ? { active: true, windowId: scopeWindowId }
      : { active: true, lastFocusedWindow: true }, // unreachable in practice; startup safety net
  );
  return tabs && tabs[0] ? tabs[0] : null;
}

function scheduleBililearnRefresh() {
  // Small delay lets Bilibili finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: refresh on a new B站
 * video, otherwise show the "not on a B站 video" state. The sidebar
 * stays open — closing it on tab switch was a friction point.
 */
function handleFrontTabUrl(url) {
  // 2026-09-27: also accept YouTube watch / shorts / embed URLs.
  // `extractVideoId` returns null for anything else (including B站
  // list pages without a bvid, chrome:// pages, new-tab pages); those
  // fall through to the no-video state below.
  const isVideoUrl = (() => {
    if (!url) return false;
    try {
      return extractVideoId(url) !== null;
    } catch {
      return false;
    }
  })();
  if (!isVideoUrl) {
    // Not a supported video. Show the no-video state in the same sidebar —
    // closing it on every tab switch felt jarring and forced the user
    // to click the extension icon again to bring it back.
    if (typeof checkCurrentTab === "function") {
      checkCurrentTab();
    }
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleBililearnRefresh();
  }
}

// Fires when a tab's URL changes — including Bilibili's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

// 2026-09-12: refocusing THIS window without changing tabs (alt-tab /
// taskbar / title-bar click) fires no tabs.onActivated, so the panel
// used to stay stuck on a stale 「当前页面不是 B 站视频」 error that was
// rendered while another window was focused. Re-check when our window
// gains focus; scheduleBililearnRefresh's 600ms debounce absorbs focus
// churn.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  scheduleBililearnRefresh();
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startBililearn(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyFeishuBtn")
    ?.addEventListener("click", copyForFeishu);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Summary tab actions
  document.getElementById("copySummaryBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("copySummaryBtn");
    const original = btn.textContent;
    if (!currentSummary) {
      btn.textContent = "暂无内容";
      setTimeout(() => (btn.textContent = original), 1500);
      return;
    }
    const ok = await copyToClipboard(currentSummary);
    btn.textContent = ok ? "✓ 已复制" : "复制失败";
    setTimeout(() => (btn.textContent = original), 2000);
  });

  // Summary tab: save full note, export
  document
    .getElementById("saveSummaryNoteBtn")
    ?.addEventListener("click", saveFullSummaryAsNote);
  document
    .getElementById("exportSummaryBtn")
    ?.addEventListener("click", exportSummary);

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// XUETANGX OFFICIAL CHAPTERS (学堂在线官方章节)
// ============================================================

/**
 * 2026-10-27: 学堂在线每个小节都自带一份**官方章节摘要**
 * （leaf_knowledge：标题 + 概要 + 时间区间）。
 *
 * 它跟 AI 生成的"概览"是一回事 —— 用户明确要求：有官方章节就别再跑 AI。
 *
 * 2026-10-27 调整：这里原来还渲染"知识导引"（知识图谱那棵 300KB+ 的知识点
 * 树，"Section 1 …"那种 content 清单）。用户看过之后说概览里不需要这个
 * content 列表 —— 现在只留官方章节，而且**用跟 AI 概览一模一样的格式**
 * 渲染（时间戳 + 标题 + 概要，点击跳转）。
 */

/** 学堂在线的 videoId 形如 xt-{cid}-{leafId}。 */
function isXuetangxVideoId(videoId) {
  return /^xt-\d+-\d+$/i.test(String(videoId || "").split("@p")[0]);
}

/** 秒 → "M:SS"（概览里的时间戳样式）。 */
function formatGuideSeconds(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * 渲染官方章节到「章节时间线」。
 *
 * DOM 结构跟 renderAnalysisResults（AI 生成的章节）**完全一样** ——
 * 同样的 chapter-item / chapter-timestamp / chapter-content / chapter-title /
 * chapter-summary，同样的点击跳转。用户看到的样式和 AI 生成的一模一样。
 */
function renderOfficialChapters(chapters) {
  const chapterList = document.getElementById("chapterList");
  if (!chapterList) return 0;
  chapterList.innerHTML = "";
  const list = Array.isArray(chapters) ? chapters : [];
  let count = 0;
  for (const chapter of list) {
    const seconds = Number(chapter?.timestampSeconds ?? chapter?.start);
    const title = String(chapter?.title || "").trim();
    if (!Number.isFinite(seconds) || seconds < 0 || !title) continue;
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = seconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(formatGuideSeconds(seconds))}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter?.summary || chapter?.body || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog("[dk-bililearn Panel] Official chapter clicked:", seconds);
      seekTo(seconds);
    });
    chapterList.appendChild(li);
    count++;
  }
  return count;
}

/**
 * 概览页「章节时间线 / 关键观点」两节的可见性。
 *
 * 有官方章节 → 章节时间线显示、关键观点隐藏（没跑 AI，没有观点）。
 * 没有官方章节 → 照常走 AI 概览，两节都留着。
 */
function applyOverviewSections(options = {}) {
  const hasChapters = !!options.hasChapters;
  const chapterSection = document
    .getElementById("chapterList")
    ?.closest(".section");
  const quotesSection = document
    .getElementById("quotesList")
    ?.closest(".section");
  if (chapterSection) chapterSection.hidden = false;
  if (quotesSection) {
    // 官方章节模式下没有 AI 观点；但如果之前跑过 AI（观点还在）就别藏。
    const quotes = document.getElementById("quotesList");
    const hasQuotes = !!quotes?.querySelector(".quote-item");
    quotesSection.hidden = hasChapters && !hasQuotes;
  }
}

/**
 * 把官方章节应用进概览页。返回 true = 概览已经有内容了，不用跑 AI。
 */
function applyXuetangxChapters(chapters) {
  const count = renderOfficialChapters(chapters);
  if (!count) return false;
  applyOverviewSections({ hasChapters: true });
  return true;
}

/**
 * 去后台要当前小节的官方章节。拿不到就返回 null —— 调用方照常走 AI 概览。
 */
async function loadXuetangxChapters(videoId) {
  if (!isXuetangxVideoId(videoId)) return null;
  try {
    const res = await chrome.runtime.sendMessage({
      action: "getXuetangxKnowledgeGuide",
    });
    if (!res || !res.success) return null;
    const chapters = Array.isArray(res.chapters) ? res.chapters : [];
    if (!chapters.length) return null;
    return chapters;
  } catch (_e) {
    return null;
  }
}

// ============================================================
// VIDEO DETECTION
// ============================================================

/**
 * 2026-10-27: 后台版本握手。
 *
 * 改了 background.js 之后，浏览器里的 Service Worker 常常还在跑内存里的旧
 * 脚本 —— 必须去 chrome://extensions 点一次"刷新"才会换成新的；而侧边栏是
 * 每次打开都重新从磁盘读盘的。结果就是"面板是新的、后台是旧的"这种半新半旧
 * 的状态：侧边栏认得学堂在线的 id，旧后台却还不认识，于是把请求当 B 站处理，
 * 报出 "Invalid Bilibili BV ID." 这种天书。
 *
 * 所以这里在跑正事之前先跟后台对一下版本号，对不上就直接告诉用户去刷新扩展
 * —— 宁可给一句人话，也不要让旧后台把请求处理坏。
 *
 * @returns {Promise<boolean>} true = 后台版本正常，可以继续
 */
async function checkBackgroundBuild() {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ action: "getExtensionBuild" });
  } catch (_e) {
    res = null;
  }

  // 情况 1：后台明确报了版本号 —— 能直接比对。
  if (res && typeof res === "object" && typeof res.build === "string" && res.build) {
    if (res.build === SP_BUILD) return true;
    showBackgroundStaleNotice(res.build);
    return false;
  }

  // 情况 2：后台没报版本号 —— 可能是老版本（不认识 getExtensionBuild）。
  // 用老版本也认识的 checkConfig 探一下：
  //   · checkConfig 能回 → 后台活着但不认新 action = 老版本 → 拦住
  //   · checkConfig 也不回 → 后台整个联系不上，那不是"版本旧"的问题，
  //     让正常流程去报错，别在这里抢走整个面板。
  let alive = false;
  try {
    const probe = await chrome.runtime.sendMessage({ action: "checkConfig" });
    alive = !!(probe && typeof probe === "object");
  } catch (_e) {
    alive = false;
  }
  if (alive) {
    showBackgroundStaleNotice("(旧版本)");
    return false;
  }
  return true;
}

/**
 * 后台版本过旧时的全屏提示。给"重新检测"按钮一个动作，用户点一下就重新
 * 握手（点完扩展页的刷新按钮回来点它就行）。
 */
function showBackgroundStaleNotice(bgBuild) {
  showState("error");
  document.getElementById("errorTitle").textContent = "扩展需要重新加载";
  document.getElementById("errorMessage").textContent =
    "后台还是旧版本（" + (bgBuild || "未响应") + "），侧边栏已经是新版（" +
    SP_BUILD + "）。请打开 chrome://extensions → 找到 bililearn → 点刷新按钮" +
    "（圆形箭头）→ 再刷新课程页面。";
  const btn = document.getElementById("errorBtn");
  btn.textContent = "重新检测";
  btn.disabled = false;
  errorAction = () => {
    btn.disabled = true;
    btn.textContent = "检测中…";
    checkBackgroundBuild().then((ok) => {
      btn.disabled = false;
      btn.textContent = "重新检测";
      // 后台换新了 → 重新走一遍正常流程
      if (ok) scheduleBililearnRefresh();
    });
  };
}

async function checkCurrentTab() {
  try {
    // 2026-10-27: 先跟后台对版本号。后台是旧版本的话，后面所有请求都会
    // 被旧代码处理（学堂在线那次直接报 "Invalid Bilibili BV ID."），
    // 所以这里要先拦住，给用户一句"去刷新扩展"的人话。
    if (!(await checkBackgroundBuild())) return;

    // Only consider the user's actual current tab. We used to fall back
    // to "any Bilibili tab" when the active tab was non-B站, which made
    // the sidebar display the wrong video's subtitles after the user
    // switched away (e.g. opened a chat tab). Now we show a clear
    // "not on a Bilibili video" state instead.
    const tab = await queryPanelActiveTab();
    const url = tab?.url || "";

    debugLog("[dk-bililearn Panel] Active tab:", tab?.id, url);

    if (!url) {
      showWelcome(
        "当前标签页无法识别（B 站需要普通网页标签，不是扩展页/设置页）。"
      );
      return;
    }

    // 2026-09-12: 「稍后再看」/收藏夹播放页（https://www.bilibili.com/list/
    // watchlater?oid=...&bvid=BV...）也是真实播放器 — 只要带 bvid 就放行，
    // 由 extractVideoId 从 query 里取视频号。
    // 2026-09-27: also accept YouTube watch / shorts / embed URLs —
    // extractVideoId now understands both platforms and returns null for
    // anything else (including chrome:// pages).
    const isListPlaybackPage =
      /^https:\/\/(?:www\.)?bilibili\.com\/list\//.test(url) &&
      /[?&]bvid=BV[A-Za-z0-9]{10}(&|$)/.test(url);
    // 2026-10-26: 学堂在线 (xuetangx.com)
    //   课程播放页形如 https://www.xuetangx.com/course/{products_sign}/{classroom_id}
    //   （还有 /lesson/... /training/... 等售卖形态；小节切换时地址栏不变）
    // 这里放宽到整个站点：真正是不是"课程页"由内容脚本说了算 —— 它只
    // 在页面钩子抓到了当前小节时才给出 videoId，拿不到就显示"未匹配到
    // 视频地址"，不会误把首页当成视频页。
    const isXuetangxPage =
      /^(?:https?:\/\/)?(?:[^/]+\.)?xuetangx\.com\//i.test(url);
    const isSupported =
      /^https:\/\/(?:www\.)?bilibili\.com\/video\//.test(url) ||
      isListPlaybackPage ||
      /^https?:\/\/(?:[^/]+\.)?youtube\.com\//.test(url) ||
      /^https?:\/\/youtu\.be\//.test(url) ||
      isXuetangxPage;
    if (!isSupported) {
      showWelcome(
        "当前页面不是 B 站、YouTube 或学堂在线视频。\n当前页面: " + url +
        "\n提示：bililearn 支持 B 站视频页（https://www.bilibili.com/video/BV…）和 YouTube（https://www.youtube.com/watch?v=…）和学堂在线课程页（https://www.xuetangx.com/course/…）。"
      );
      return;
    }

    // 2026-10-26: 学堂在线的小节 id 不在 URL 里（换小节时 URL 不变），
    // 所以 videoId 先留空，等内容脚本把页面捕获到的小节 id 补上来。
    let videoId = extractVideoId(url);
    if (!videoId && !isXuetangxPage) {
      showWelcome(
        "未匹配到 B 站视频地址。\n当前页面: " + url +
        "\n提示：需要 https://www.bilibili.com/video/BV… 格式（暂不支持番剧/直播页）。"
      );
      return;
    }

    // Store the tab ID for reliable messaging later
    bilibiliTabId = tab.id;
    currentVideoUrl = url;

    // 2026-08-31 stale-title fix: the header must never carry the OLD
    // video's title into the new video's load. getVideoInfo below reads the
    // live page DOM, which can fail (relay race) or still show the old
    // video (SPA hasn't swapped the title element yet). Clear the info
    // state + header now; the authoritative title then lands from the
    // BV-keyed view API via the fetchTranscript response (see
    // startBililearn) or from the per-video cache.
    if (videoId !== currentVideoId) {
      currentVideoTitle = "";
      currentChannelName = "";
      currentVideoDescription = "";
      currentVideoDuration = 0;
      currentPubDate = "";
      renderVideoInfoHeader();
    }

    try {
      // Route through background script for reliable message passing
      const result = await chrome.runtime.sendMessage({
        action: "relayToContent",
        payload: { action: "getVideoInfo" },
      });
      debugLog("[dk-bililearn Panel] getVideoInfo result:", result);
      if (result.success && result.response) {
        currentVideoTitle = result.response.title || "";
        currentChannelName = result.response.channelName || "";
        currentVideoDescription = result.response.description || "";
        currentVideoDuration = result.response.duration || 0;
        currentPubDate = result.response.pubdate || "";
        // 2026-10-26: 学堂在线 —— 内容脚本带着页面捕获到的小节 id
        //（xt-{cid}-{leafId}），URL 里没有，用它当 videoId。
        if (!videoId && result.response.videoId) {
          videoId = result.response.videoId;
        }
      }
    } catch (e) {
      console.error("[dk-bililearn Panel] getVideoInfo error:", e);
      currentVideoTitle = "";
      currentChannelName = "";
      currentVideoDescription = "";
      currentVideoDuration = 0;
      currentPubDate = "";
    }

    if (!videoId) {
      showWelcome(
        "未匹配到视频地址。当前页面: " + url +
          "提示：需要 B 站视频页 / YouTube 播放页 / 学堂在线课程页。"
      );
      return;
    }

    startBililearn(videoId, url);
  } catch (error) {
    console.error("Tab check error:", error);
    showWelcome("检测出错: " + (error?.message || error));
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    // YouTube (2026-09-27). Canonical id = 11 chars. Accept the
    // common shapes: /watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID.
    // Suffix with "@p1" so the rest of the sidepanel's `currentVideoId`
    // cache key (`videoId@page`) keeps working unchanged for the
    // YouTube branch — there's only ever one "page" per YouTube video.
    if (
      urlObj.hostname === "www.youtube.com" ||
      urlObj.hostname === "m.youtube.com" ||
      urlObj.hostname === "youtu.be" ||
      urlObj.hostname.endsWith(".youtube.com")
    ) {
      let id = null;
      if (urlObj.hostname === "youtu.be") {
        id = urlObj.pathname.replace(/^\/+/, "").split("/")[0] || null;
      } else if (urlObj.pathname.startsWith("/watch")) {
        id = urlObj.searchParams.get("v");
      } else if (urlObj.pathname.startsWith("/shorts/")) {
        id = urlObj.pathname.split("/")[2] || null;
      } else if (urlObj.pathname.startsWith("/embed/")) {
        id = urlObj.pathname.split("/")[2] || null;
      }
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `${id}@p1`;
    }

    // 2026-10-26: 学堂在线 (xuetangx.com)
    //   学习页（真正的播放器页）：
    //     /learn/space/{products_sign}/{course_sign}/{classroom_id}/video/{leaf_id}
    //   课程页（带试看播放器）：
    //     /course/{products_sign}/{classroom_id}
    //   其它售卖形态：/lesson/… /training/…
    //
    // 小节 id（leaf_id）不一定在 URL 里（切小节时地址栏不变），那种
    // 情况返回 null，由内容脚本（页面接口捕获 / 主动解析）补上。
    if (urlObj.hostname === "xuetangx.com" || urlObj.hostname.endsWith(".xuetangx.com")) {
      // 学习页 —— URL 里直接带 classroom_id 和 leaf_id
      const learnSpace = urlObj.pathname.match(
        /\/learn\/space\/[^/]+\/[^/]+\/(\d+)\/video\/(\d+)/i,
      );
      if (learnSpace) {
        return `xt-${learnSpace[1]}-${learnSpace[2]}@p1`;
      }
      const learn = urlObj.pathname.match(
        /\/learn\/[^/]+\/[^/]+\/(\d+)(?:\/video\/(\d+))?/i,
      );
      if (learn) {
        if (learn[2]) return `xt-${learn[1]}-${learn[2]}@p1`;
        return null;
      }
      // 课程页
      const course = urlObj.pathname.match(
        /^\/(?:course|lesson|training|program)\/([^/]+)(?:\/(\d+))?/i,
      );
      if (course) {
        const cid = course[2] || "";
        const leaf =
          urlObj.searchParams.get("leaf_id") ||
          urlObj.searchParams.get("leafId") ||
          "";
        if (cid && leaf) return `xt-${cid}-${leaf}@p1`;
      }
      return null;
    }

    const match = urlObj.pathname.match(/\/video\/(BV[A-Za-z0-9]{10})/i);
    if (urlObj.hostname.endsWith("bilibili.com") && match) {
      const part = Math.max(1, Number(urlObj.searchParams.get("p")) || 1);
      return `${match[1]}@p${part}`;
    }

    // 「稍后再看」/收藏夹播放页：视频号在 query 里，不在 pathname 里。
    // https://www.bilibili.com/list/watchlater?oid=...&bvid=BV1mdYj6yEf1
    if (
      urlObj.hostname.endsWith("bilibili.com") &&
      /^\/list\//.test(urlObj.pathname)
    ) {
      const bvid = (urlObj.searchParams.get("bvid") || "").trim();
      if (/^BV[A-Za-z0-9]{10}$/.test(bvid)) return `${bvid}@p1`;
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// BILILEARN PIPELINE
// ============================================================

/**
 * Wipe the previous video's DOM from every panel container (2026-08-23).
 * Called at the top of `startBililearn` (cache-miss branch) right after the
 * in-memory state is cleared. Without this, the panel keeps showing the
 * OLD video's chapter list / quotes / summary text until the user clicks
 * the Overview or Summary tab — at which point lazy load overwrites it.
 * Extracted as a named function so the regression test can verify the
 * four containers in isolation, without standing up the full pipeline.
 */
function clearTabDomForNewVideo() {
  for (const id of ["transcriptList", "chapterList", "quotesList", "summaryContent"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  // 2026-10-27: 新视频 → 上一节的官方章节作废（概览会重新要一份）
  currentXuetangxChapters = null;
  xuetangxChaptersChecked = false;
  // 新视频 → 概览的两节恢复可见（上一节可能把「关键观点」藏了）。
  // 官方章节模式下要重新藏起来 —— 那由 applyXuetangxChapters 负责。
  applyOverviewSections({ hasChapters: false });
}

/**
 * Renders the video header from the CURRENT in-memory title/channel state.
 * UNCONDITIONALLY (2026-08-31 stale-title fix): the old guarded form
 * (`if (currentVideoTitle || ...) { ...text... }`) skipped the DOM write
 * when the new video's info hadn't arrived yet, so switching videos with a
 * failed/racy getVideoInfo left the PREVIOUS video's title text sitting in
 * the header above the new video's transcript. Writing unconditionally —
 * and hiding the block when both fields are empty — means the header can
 * never carry text that doesn't belong to the loaded video.
 */
function renderVideoInfoHeader() {
  const videoInfo = document.getElementById("videoInfo");
  if (!videoInfo) return;
  document.getElementById("videoTitle").textContent = currentVideoTitle || "";
  document.getElementById("videoChannel").textContent = currentChannelName || "";
  videoInfo.style.display =
    currentVideoTitle || currentChannelName ? "block" : "none";
  refreshKbButton();
}

async function startBililearn(videoId, videoUrl, options = {}) {
  const gen = ++generation;
  // Check if we already have this video loaded in memory. Focus-change
  // re-checks (chrome.windows.onFocusChanged → scheduleBililearnRefresh →
  // checkCurrentTab) and tab-URL events land here REPEATEDLY for the SAME
  // video. Falling through re-runs the whole cache load: it re-renders
  // every panel (the "概览页面不停刷新" flicker) and — before the per-video
  // in-flight sets — re-fired the lazy LLM triggers on every focus event
  // (2026-09-13 "后台还在不停调用AI" report). The panel already holds this
  // video's digest when the transcript is in memory AND any of: analysis
  // done, summary done, or an LLM call for THIS video still in flight
  // (its completion renders/parks itself; nothing to reload).
  // Note: transcript-only (no analysis/summary yet) intentionally falls
  // through — the poisoned-cache self-heal path relies on a full refetch.
  if (
    videoId === currentVideoId &&
    currentTranscriptTimestamped &&
    (currentAnalysis ||
      currentSummary ||
      analysisInFlight.has(videoId) ||
      summaryInFlight.has(videoId))
  ) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    // Stale transcript-tab wizards belong to the previous video's state.
    hideTranscriptWizards();
    // So do stale full-panel error pages: the next video may load from
    // cache (currentSummary set → the lazy trigger never fires to reset
    // the panel) and its cached content must not sit behind the previous
    // video's error page. updateAiKeyWizard re-applies the wizard state
    // for the active tab when the key is still missing (wizard owns the
    // panel, sections stay hidden).
    hidePanelError("overview");
    hidePanelError("summary");
    updateAiKeyWizard(
      (document.querySelector(".tab-panel.active") || { dataset: {} }).dataset
        .panel || "transcript",
    );
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (gen !== generation) return;
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentSummary = cached.summary || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    currentTranscriptSource = cached.transcriptSource || null;
    updateTranscriptLanguageModes();
    // (2026-09-12) per-video in-flight sets make a manual reset here
    // unnecessary: entries self-clean when their call completes, and a
    // reset would have hidden a genuinely running call for this video.

    // 2026-08-31 stale-title fix: the cache entry was written FOR this
    // video, so its title/channel beat the racy page-DOM read from
    // checkCurrentTab (which may still hold the previous video's title
    // if Bilibili hadn't swapped the DOM when getVideoInfo ran).
    currentVideoTitle = cached.videoTitle || currentVideoTitle;
    currentChannelName = cached.channelName || currentChannelName;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    renderVideoInfoHeader();

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    // Render summary if we have it cached
    if (currentSummary) {
      renderSummaryResults(currentSummary);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // 2026-09-12: restore the tab the user last viewed on THIS video —
    // e.g. they left on 总结, then transcribed another video elsewhere
    // whose wizard switched this panel to transcript; coming back should
    // reopen 总结, not the wizard's leftover tab. Runs BEFORE the scroll
    // arm below so the user's next manual switch still scrolls to top.
    const rememberedTab = lastTabByVideo.get(videoId);
    if (rememberedTab) switchTab(rememberedTab);

    // Arm the "next tab switch scrolls to top" flag — this branch has
    // already rendered transcript/analysis/summary into the panels, so
    // the next switchTab the user makes should land them at the top
    // of the new tab instead of wherever the OLD video's scroll lived.
    tabScrollTopArmed = true;

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();

    // 2026-10-27: 缓存命中也要把学堂在线的官方章节取回来（概览用）
    currentXuetangxChapters = null;
    xuetangxChaptersChecked = false;
    if (isXuetangxVideoId(videoId)) {
      const videoIdAtGuide = videoId;
      loadXuetangxChapters(videoIdAtGuide).then((chapters) => {
        if (videoIdAtGuide !== currentVideoId) return;
        xuetangxChaptersChecked = true;
        if (!chapters) return;
        currentXuetangxChapters = chapters;
        applyXuetangxChapters(chapters);
      });
    }
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentSummary = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  currentTranscriptSource = null;
  // (2026-09-12) no loading-flag reset needed — in-flight tracking is
  // per video now (see analysisInFlight / summaryInFlight).

  // Wipe stale DOM from the previous video on every panel (2026-08-23).
  // renderTranscript() bails early when currentTranscript is null,
  // and renderAnalysisResults / renderSummaryResults aren't called at
  // all when their backing state is null — so without this explicit
  // clear, switching to a new B站 video leaves the *previous* video's
  // chapter list / quotes list / summary content sitting in the
  // Overview and Summary tabs until the user clicks one of those tabs
  // (which then triggers the lazy load + DOM overwrite).
  clearTabDomForNewVideo();

  renderVideoInfoHeader();

  showState("loading");
  updateLoading("正在获取字幕", "");

  let transcriptResult = null;
  // 2026-10-27: 后台有可能一直不回来（B 站接口被墙 / 风控黑洞 /
  // 消息通道半开），没有超时的话页面会永远停在"正在获取字幕"转圈。
  // 45 秒还没回话就按失败处理，走下面的 Whisper 出路。
  const FETCH_TIMEOUT_MS = 45000;
  let fetchTimer = null;
  try {
    transcriptResult = await Promise.race([
      chrome.runtime.sendMessage({
        action: "fetchTranscript",
        videoId: videoId.split("@p")[0],
        pageNumber: Math.max(
          1,
          Number(String(videoId.split("@p")[1] || "1").replace(/^p/i, "")) || 1,
        ),
        videoUrl: videoUrl,
        // 2026-10-27: 用户点了"重试" → 让学堂在线那边把字幕探针矩阵重跑一遍
        // （正常情况下探针对同一个 ccid 只跑一遍，免得把人家接口打爆）。
        force: !!options.force,
      }),
      new Promise((_, reject) => {
        fetchTimer = setTimeout(
          () => reject(new Error(`读取字幕超时（${FETCH_TIMEOUT_MS / 1000} 秒没有响应）`)),
          FETCH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (sendError) {
    // 2026-10-27: sendMessage 抛错（后台刚被刷新 / 扩展上下文失效 /
    // 消息通道断了 / 超时）→ 以前这里会直接把整个 startBililearn 炸掉，
    // 页面永远停在"正在获取字幕"转圈，用户连 Whisper 这条出路都看不到。
    // 现在：照样给出路，并把原因写在页面上。
    const reason = (sendError && sendError.message) || String(sendError);
    if (gen !== generation || videoId !== currentVideoId) return;
    if (isXuetangxVideoId(videoId)) {
      showError(
        "学堂在线：没能拿到字幕",
        `后台没有响应：${reason}\n请刷新一下课程页面，然后重新打开侧边栏。`,
      );
      return;
    }
    showWhisperPrompt(
      videoId,
      videoUrl,
      await readConfiguredCacheDir(),
      `后台没有响应：${reason}`,
    );
    return;
  } finally {
    if (fetchTimer) clearTimeout(fetchTimer);
  }
  if (gen !== generation || videoId !== currentVideoId) return;

  // 后台静默没回话（消息通道断了）也当失败处理，同样给 Whisper 出路，
  // 不能让页面卡在转圈上。
  if (!transcriptResult || typeof transcriptResult !== "object") {
    if (isXuetangxVideoId(videoId)) {
      showError(
        "学堂在线：没能拿到字幕",
        "后台没有返回结果。请刷新一下课程页面，然后重新打开侧边栏。",
      );
      return;
    }
    showWhisperPrompt(
      videoId,
      videoUrl,
      await readConfiguredCacheDir(),
      "后台没有返回结果（扩展刚刚更新过的话，请到 chrome://extensions 刷新一次扩展）。",
    );
    return;
  }

  if (!transcriptResult.success) {
    const detail = transcriptResult.message || transcriptResult.error;
    if (transcriptResult.error === "WHISPER_NEEDED") {
      // Whisper is selected but this video has no subtitles. If the
      // local server is unreachable, the full-screen prompt's button
      // would just fail — show the setup wizard with a live ping
      // instead (2026-08-28).
      const serverUp = await pingWhisperServer();
      if (!serverUp) {
        if (gen !== generation) return;
        showWhisperSetupWizardState();
        return;
      }
      showWhisperPrompt(
        videoId,
        videoUrl,
        transcriptResult.cacheDir,
        transcriptResult.subtitleLookupError || "",
      );
      return;
    }
    if (transcriptResult.error === "MINIMAX_ASR_KEY_MISSING") {
      // 2026-09-17 (Irene directive): MiniMax cloud ASR is selected
      // but no API key was filled in. Don't surface this as "no
      // subtitles found" — guide the user straight to the settings
      // page so they can paste the key.
      if (gen !== generation) return;
      showError(
        "MiniMax 云端 ASR 未配置",
        transcriptResult.message ||
          "请到 bililearn 设置 → 语音识别 → MiniMax 云端 ASR 里填上 API Key。",
        {
          primary: { label: "打开设置", action: openOptionsPage },
        },
      );
      return;
    }
    if (transcriptResult.error === "NO_TRANSCRIPT") {
      // No subtitles anywhere and no ASR path will auto-run: guide the
      // user to pick an ASR source instead of a dead-end error (2026-08-28).
      if (gen !== generation) return;
      showAsrWizardState();
      return;
    }
    if (transcriptResult.error === "XUETANGX_STATE_MISSING") {
      // 2026-10-26: 学堂在线 —— 没拿到当前小节的信息。通常是扩展刚装/刚更新，
      // 页面早就加载完了，主世界钩子错过了第一次请求；刷新页面即可。
      if (gen !== generation) return;
      showError(
        "学堂在线：还没抓到当前小节",
        transcriptResult.message ||
          "请刷新一下学堂在线课程页面，然后重新打开侧边栏。",
      );
      return;
    }
    if (transcriptResult.error === "XUETANGX_SUBTITLE_MISSING") {
      // 2026-10-27: 官方字幕没读出来 —— 别只给一个"重试"把人堵死。
      // 主按钮改成「用 Whisper 转录」（这条路一定能走通：视频直链是有的），
      // 次要按钮保留"再试一次官方字幕"（force：让钩子把探针矩阵重跑一遍）。
      if (gen !== generation) return;
      const serverUp = await pingWhisperServer();
      if (gen !== generation) return;
      if (!serverUp) {
        // 本地 server 没起来 —— 先引导配置（面板会自己 ping，通了再回来）
        showWhisperSetupWizardState();
        return;
      }
      showError(
        "学堂在线：官方字幕没读出来",
        (transcriptResult.message ||
          "学堂在线官方字幕没读出来。") +
          "\n\n可以改用本地 Whisper 转录这一节（需要 whisper_server 在运行）。",
      );
      const btn = document.getElementById("errorBtn");
      btn.textContent = "🎙️ 用 Whisper 转录";
      btn.disabled = false;
      errorAction = () =>
        gateLongVideoTranscribe(async () => {
          btn.disabled = true;
          btn.textContent = "正在启动…";
          updateLoading("启动 Whisper 转录", "下载视频音轨并发送至本地 server");
          showState("loading");
          try {
            const result = await chrome.runtime.sendMessage({
              action: "triggerWhisperTranscription",
              videoId: videoId.split("@p")[0],
              pageNumber: Math.max(
                1,
                Number(
                  String(videoId.split("@p")[1] || "1").replace(/^p/i, ""),
                ) || 1,
              ),
              videoUrl,
              videoTitle: currentVideoTitle || "",
            });
            if (result && result.success) {
              if (result.queued || result.alreadyQueued) {
                updateLoading(
                  "已加入转录队列",
                  result.alreadyQueued
                    ? `该视频已在队列中（第 ${result.position} 位）`
                    : `当前排在第 ${result.position} 位`,
                );
                refreshWhisperQueue();
                return;
              }
              if (result.alreadyRunning || result.started) {
                const resumed = await maybeResumeWhisperJob();
                if (resumed) return;
              }
              await removeVideoCache(videoId);
              currentVideoId = null;
              await startBililearn(videoId, videoUrl);
            } else {
              showWhisperError(result);
              btn.disabled = false;
              btn.textContent = "🎙️ 用 Whisper 转录";
            }
          } catch (err) {
            showWhisperError(err);
            btn.disabled = false;
            btn.textContent = "🎙️ 用 Whisper 转录";
          }
        });

      // 次要按钮：再试一次官方字幕（探针矩阵重跑一遍）
      const secondary = document.getElementById("errorBtnSecondary");
      if (secondary) {
        secondary.style.display = "";
        secondary.textContent = "再试一次官方字幕";
        secondary.onclick = async () => {
          secondary.disabled = true;
          secondary.textContent = "正在重试…";
          await removeVideoCache(videoId);
          currentVideoId = null;
          startBililearn(videoId, videoUrl, { force: true });
        };
      }
      return;
    }
    // 2026-10-27: "Invalid Bilibili BV ID." 是"后台还在跑旧代码"的信号 ——
    // 旧后台不认识学堂在线的 videoId，把它当 B 站处理了。翻译成人话，别让用户
    // 对着一句天书发呆（正常情况下握手会先拦住，这里是第二道保险）。
    if (/Invalid Bilibili BV ID/i.test(String(detail || ""))) {
      if (gen !== generation) return;
      showError(
        "扩展后台需要重新加载",
        "当前后台还是旧版本，不认识学堂在线的视频号。请打开 chrome://extensions → " +
          "找到 bililearn → 点刷新按钮（圆形箭头）→ 再刷新课程页面。",
      );
      return;
    }
    showError(
      String(detail).includes("音轨")
        ? "语音识别失败"
        : "没有找到可靠字幕",
      detail,
    );
    errorAction = async () => {
      await removeVideoCache(videoId);
      currentVideoId = null;
      startBililearn(videoId, videoUrl);
    };
    return;
  }

  // 2026-08-31 stale-title fix: the fetchTranscript response carries
  // BV-keyed view-API metadata (videoTitle/channelName/pubDate, attached
  // by handleFetchTranscript in the background). Unlike getVideoInfo —
  // which reads the live page DOM and can race Bilibili's SPA swap —
  // this data is keyed to the exact video id we requested, so it wins.
  if (transcriptResult.videoTitle || transcriptResult.channelName) {
    currentVideoTitle = transcriptResult.videoTitle || currentVideoTitle;
    currentChannelName = transcriptResult.channelName || currentChannelName;
    currentPubDate = transcriptResult.pubDate || currentPubDate;
    renderVideoInfoHeader();
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;
  currentTranscriptSource = transcriptResult.source || "bilibili-subtitle";
  updateTranscriptLanguageModes();

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Arm the "next tab switch scrolls to top" flag — the transcript
  // has been rendered, so the next switchTab the user makes should
  // land them at the top of the new tab instead of wherever the OLD
  // video's scroll lived.
  tabScrollTopArmed = true;

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // 2026-10-27: 学堂在线 —— 顺手把课程自带的官方章节取回来（页面侧抓的，
  // 很快，不花 token）。用户点「概览」时直接用它，不跑 AI 概览。
  if (isXuetangxVideoId(videoId)) {
    const videoIdAtGuide = videoId;
    loadXuetangxChapters(videoIdAtGuide).then((chapters) => {
      if (videoIdAtGuide !== currentVideoId) return;
      xuetangxChaptersChecked = true;
      if (!chapters) return;
      currentXuetangxChapters = chapters;
      applyXuetangxChapters(chapters);
    });
  }

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[dk-bililearn Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="保存为笔记">📝 笔记</button>
          <button class="quote-copy-btn" title="复制观点">⧉ 复制</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[dk-bililearn Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ 已复制";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ 复制";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "保存中…";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ 已保存";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[dk-bililearn] Save quote as note failed:", result.error);
      btn.textContent = "失败";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[dk-bililearn] Save quote as note error:", error);
    btn.textContent = "失败";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const sourceLabel = currentTranscriptSource === "local-file"
    ? "本地字幕"
    : currentTranscriptSource === "local-cache"
    ? "本地 Whisper 缓存"
    : currentTranscriptSource === "local-whisper"
    ? "本地 Whisper 转写"
    : currentTranscriptSource === "local-whisper-corrected"
    ? "本地 Whisper（AI 修正）"
    : currentTranscriptSource === "xuetangx-lecture-note"
    ? "学堂在线官方讲稿"
    : currentTranscriptSource === "xuetangx-subtitle"
    ? "学堂在线官方字幕"
    : "B站视频字幕";

  let badgeContent = `<span class="source-dot source-dot--subs"></span> ${sourceLabel} · ${escapeHtml(getOriginalTranscriptLabel())}`;

  // Add "Regenerate" button for local files
  if (currentTranscriptSource === "local-file") {
    badgeContent += `<button id="regenerateWhisperBtn" class="regenerate-btn">🔄 重新生成</button>`;
  }

  badge.innerHTML = badgeContent;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Attach event listener to regenerate button
  const regenerateBtn = document.getElementById("regenerateWhisperBtn");
  if (regenerateBtn) {
    regenerateBtn.addEventListener("click", () => gateLongVideoTranscribe(async () => {
      regenerateBtn.disabled = true;
      regenerateBtn.textContent = "正在启动…";
      updateLoading("启动 Whisper 转录", "重新转写当前视频");
      showState("loading");
      try {
        const result = await chrome.runtime.sendMessage({
          action: "triggerWhisperTranscription",
          videoId: currentVideoId?.split("@p")[0] || "",
          pageNumber: Math.max(
            1,
            Number(String(currentVideoId?.split("@p")[1] || "1").replace(/^p/i, "")) || 1,
          ),
          videoUrl: currentVideoUrl || "",
          videoTitle: currentVideoTitle || "",
        });
        if (result && result.success) {
          if (result.queued || result.alreadyQueued) {
            // Another video is transcribing — this one joined the queue.
            // Stay on the loading screen; the pump's transcriptProgress
            // broadcasts take over when this entry starts running.
            updateLoading(
              "已加入转录队列",
              result.alreadyQueued
                ? `该视频已在队列中（第 ${result.position} 位），前序任务完成后自动开始`
                : `当前排在第 ${result.position} 位，前序任务完成后自动开始`,
            );
            refreshWhisperQueue();
            return;
          }
          if (result.alreadyRunning || result.started) {
            // Already running, OR fire-and-ack started (pipeline detached
            // on the background side): attach to the progress UI; terminal
            // state arrives via transcriptProgress broadcast.
            const resumed = await maybeResumeWhisperJob();
            if (resumed) return;
          }
          // Capture before nulling — startBililearn needs the id to refetch.
          const vid = currentVideoId;
          await removeVideoCache(vid);
          currentVideoId = null;
          await startBililearn(vid, currentVideoUrl);
        } else {
          showWhisperError(result);
        }
      } catch (err) {
        showWhisperError(err);
      }
    }));
  }

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function currentCanonicalVideoUrl() {
  const [vid, partToken] = String(currentVideoId || "").split("@p");
  // 2026-10-03: YouTube ids are exactly 11 chars of [A-Za-z0-9_-]
  // (same shape as background.js YT_ID_RE); B站 BV ids are 12+ chars
  // and BV-prefixed. Platform-aware so exports/notes link correctly.
  if (/^[A-Za-z0-9_-]{11}$/.test(vid)) {
    return `https://www.youtube.com/watch?v=${vid}`;
  }
  // 2026-10-26: 学堂在线 —— id 形如 xt-{classroomId}-{leafId}
  if (/^xt-\d+-\d+$/i.test(vid)) {
    // 页面地址本身就带小节 id，直接用它（最准）
    if (currentVideoUrl && /xuetangx\.com/i.test(currentVideoUrl)) {
      return currentVideoUrl;
    }
    const m = /^xt-(\d+)-(\d+)$/i.exec(vid);
    return m
      ? `https://www.xuetangx.com/course/${m[1]}?leaf_id=${m[2]}`
      : "https://www.xuetangx.com/";
  }
  return `https://www.bilibili.com/video/${vid}${Number(partToken) > 1 ? `?p=${Number(partToken)}` : ""}`;
}

function timestampLabel(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = Math.floor(safe % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function exportTranscriptEntries() {
  return groupTranscriptEntries(currentTranscript || []).map((entry) => ({
    ...entry,
    timestamp: timestampLabel(entry.start),
    url: `${currentCanonicalVideoUrl()}${currentCanonicalVideoUrl().includes("?") ? "&" : "?"}t=${Math.floor(entry.start)}s`,
  }));
}

function buildMarkdownExport() {
  const lines = [
    `# ${currentVideoTitle || "B站视频学习笔记"}`,
    "",
    `- **UP主：** ${currentChannelName || "未知"}`,
    `- **视频链接：** ${currentCanonicalVideoUrl()}`,
    `- **字幕语言：** ${currentTranscriptLanguage || "未知"}`,
  ];
  if (currentVideoDescription) lines.push("", "## 视频简介", "", currentVideoDescription);
  if (currentAnalysis?.chapters?.length) {
    lines.push("", "## AI 章节", "");
    currentAnalysis.chapters.forEach((chapter) => {
      lines.push(`### [${chapter.timestamp}] ${chapter.title}`, "", chapter.summary || "", "");
    });
  }
  if (currentAnalysis?.keyQuotes?.length) {
    lines.push("## 关键观点", "");
    currentAnalysis.keyQuotes.forEach((quote) => lines.push(`> **${quote.timestamp}** ${quote.quote}`, ""));
  }
  lines.push("## 完整字幕", "");
  exportTranscriptEntries().forEach((entry) => lines.push(`- [${entry.timestamp}](${entry.url}) ${entry.text}`));
  lines.push("", "---", "由 bililearn · WezeShang二次开发版导出");
  return lines.join("\n");
}

function buildHtmlExport() {
  const entries = exportTranscriptEntries();
  const chapters = (currentAnalysis?.chapters || []).map((chapter) => `
    <article class="chapter"><a href="${escapeHtml(currentCanonicalVideoUrl())}?t=${Number(chapter.timestampSeconds) || 0}s">${escapeHtml(chapter.timestamp)}</a><div><strong>${escapeHtml(chapter.title)}</strong><p>${escapeHtml(chapter.summary || "")}</p></div></article>`).join("");
  const quotes = (currentAnalysis?.keyQuotes || []).map((quote) => `
    <blockquote><b>${escapeHtml(quote.timestamp)}</b>${escapeHtml(quote.quote)}</blockquote>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(currentVideoTitle || "B站视频学习笔记")}</title><style>
  :root{--pink:#fb7299;--blue:#00aeec;--ink:#18191c;--muted:#61666d;--line:#e3e5e7}*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Segoe UI",sans-serif}.page{width:min(900px,calc(100% - 28px));margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:clamp(22px,5vw,54px);box-shadow:0 12px 36px rgba(24,25,28,.07)}h1{line-height:1.3;margin:0 0 14px}h2{margin-top:38px;padding-bottom:10px;border-bottom:2px solid rgba(251,114,153,.18)}.meta{color:var(--muted)}a{color:var(--pink);text-decoration:none}.chapter{display:flex;gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}.chapter a{flex:0 0 54px;font-weight:700}.chapter p{margin:4px 0;color:var(--muted)}blockquote{margin:12px 0;padding:14px 18px;border-left:4px solid var(--pink);background:rgba(251,114,153,.06);border-radius:0 10px 10px 0}blockquote b{margin-right:12px;color:var(--pink)}.line{display:grid;grid-template-columns:62px 1fr;gap:14px;padding:11px 0;border-bottom:1px solid var(--line)}.time{font-family:ui-monospace,monospace;font-weight:700}.footer{margin-top:38px;color:#9499a0;font-size:12px}@media(max-width:560px){.line{grid-template-columns:52px 1fr}.page{margin:12px auto}}
  </style></head><body><main class="page"><h1>${escapeHtml(currentVideoTitle || "B站视频学习笔记")}</h1><div class="meta">UP主：${escapeHtml(currentChannelName || "未知")} · <a href="${escapeHtml(currentCanonicalVideoUrl())}">打开原视频</a></div>${currentVideoDescription ? `<h2>视频简介</h2><p>${escapeHtml(currentVideoDescription)}</p>` : ""}${chapters ? `<h2>AI 章节</h2>${chapters}` : ""}${quotes ? `<h2>关键观点</h2>${quotes}` : ""}<h2>完整字幕</h2>${entries.map((entry) => `<div class="line"><a class="time" href="${escapeHtml(entry.url)}">${escapeHtml(entry.timestamp)}</a><div>${escapeHtml(entry.text)}</div></div>`).join("")}<div class="footer">由 bililearn · WezeShang二次开发版导出</div></main></body></html>`;
}

async function copyForFeishu() {
  const html = buildHtmlExport().match(/<main class="page">([\s\S]*?)<\/main>/)?.[1] || "";
  const plain = buildMarkdownExport();
  const btn = document.getElementById("copyFeishuBtn");
  const original = btn.textContent;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
    btn.textContent = "✓ 已复制，去飞书粘贴";
  } catch {
    await copyToClipboard(plain);
    btn.textContent = "✓ 已复制 Markdown";
  }
  setTimeout(() => (btn.textContent = original), 2500);
}

function exportTranscript() {
  const format = document.getElementById("exportFormat")?.value || "md";
  const filename = buildExportFilename(format);
  const mime = format === "html"
    ? "text/html;charset=utf-8"
    : "text/markdown;charset=utf-8";
  const text = format === "html" ? buildHtmlExport() : buildMarkdownExport();
  downloadTextFile(text, filename, mime);
}

// ============================================================
// SUMMARY TAB: EXPORT / FEISHU / SAVE-AS-NOTE
// ============================================================

/**
 * Builds the Markdown export for the Summary tab: video header + full note.
 */
function buildSummaryMarkdownExport() {
  const lines = [
    `# ${currentVideoTitle || "B站视频学习笔记"}`,
    "",
    `- **UP主：** ${currentChannelName || "未知"}`,
    `- **视频链接：** ${currentCanonicalVideoUrl()}`,
  ];
  if (currentVideoDescription) lines.push("", "## 视频简介", "", currentVideoDescription);
  lines.push("", currentSummary || "（暂无总结内容）", "", "---", "由 bililearn · WezeShang二次开发版导出");
  return lines.join("\n");
}

/**
 * Builds the HTML export for the Summary tab, reusing the transcript
 * export's visual style but rendering the Markdown note body.
 */
function buildSummaryHtmlExport() {
  const body = currentSummary ? renderMarkdown(currentSummary) : "<p>（暂无总结内容）</p>";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(currentVideoTitle || "B站视频学习笔记")}</title><style>
  :root{--pink:#fb7299;--blue:#00aeec;--ink:#18191c;--muted:#61666d;--line:#e3e5e7}*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Segoe UI",sans-serif}.page{width:min(900px,calc(100% - 28px));margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:clamp(22px,5vw,54px);box-shadow:0 12px 36px rgba(24,25,28,.07)}h1{line-height:1.3;margin:0 0 14px}.meta{color:var(--muted)}a{color:var(--pink);text-decoration:none}.note h1,.note h2,.note h3,.note h4{line-height:1.35;margin:22px 0 8px}.note h1{font-size:22px}.note h2{font-size:19px;padding-bottom:8px;border-bottom:2px solid rgba(251,114,153,.18)}.note h3{font-size:16px}.note p{margin:8px 0}.note ul,.note ol{margin:8px 0;padding-left:22px}.note li{margin:3px 0}.note blockquote{margin:12px 0;padding:14px 18px;border-left:4px solid var(--pink);background:rgba(251,114,153,.06);border-radius:0 10px 10px 0;color:var(--muted)}.note code{font-family:ui-monospace,monospace;font-size:.9em;background:rgba(24,25,28,.05);border-radius:4px;padding:1px 5px}.note pre{margin:12px 0;padding:14px 16px;background:rgba(24,25,28,.04);border:1px solid var(--line);border-radius:10px;overflow-x:auto}.note pre code{background:none;padding:0}.note hr{border:none;border-top:1px solid var(--line);margin:20px 0}.note strong{color:var(--ink)}.footer{margin-top:38px;color:#9499a0;font-size:12px}@media(max-width:560px){.page{margin:12px auto}}
  </style></head><body><main class="page"><h1>${escapeHtml(currentVideoTitle || "B站视频学习笔记")}</h1><div class="meta">UP主：${escapeHtml(currentChannelName || "未知")} · <a href="${escapeHtml(currentCanonicalVideoUrl())}">打开原视频</a></div>${currentVideoDescription ? `<h2>视频简介</h2><p>${escapeHtml(currentVideoDescription)}</p>` : ""}<div class="note">${body}</div><div class="footer">由 bililearn · WezeShang二次开发版导出</div></main></body></html>`;
}

/**
 * Downloads the summary note in the selected format (Markdown or HTML).
 */
function exportSummary() {
  const format = document.getElementById("summaryExportFormat")?.value || "md";
  const filename = buildExportFilename(format, "-总结");
  const mime = format === "html"
    ? "text/html;charset=utf-8"
    : "text/markdown;charset=utf-8";
  const text = format === "html" ? buildSummaryHtmlExport() : buildSummaryMarkdownExport();
  downloadTextFile(text, filename, mime);
}

/**
 * Saves the whole summary note as a single note entry (visible in the
 * Notes tab). Sends the raw Markdown so no AI cleanup is re-run.
 */
async function saveFullSummaryAsNote() {
  const btn = document.getElementById("saveSummaryNoteBtn");
  const original = btn.textContent;
  if (!currentSummary) {
    btn.textContent = "暂无内容";
    setTimeout(() => (btn.textContent = original), 1500);
    return;
  }
  if (!currentVideoId) {
    btn.textContent = "缺少视频信息";
    setTimeout(() => (btn.textContent = original), 1500);
    return;
  }
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveSummaryNote",
      videoId: currentVideoId,
      videoTitle: currentVideoTitle || "",
      channelName: currentChannelName || "",
      summaryText: currentSummary,
    });
    if (result?.success) {
      btn.textContent = "✓ 已保存至笔记";
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 2000);
    } else {
      btn.textContent = "保存失败";
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 2500);
      console.error("[dk-bililearn] Save summary note failed:", result?.error);
    }
  } catch (error) {
    btn.textContent = "保存失败";
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2500);
    console.error("[dk-bililearn] Save summary note error:", error);
  }
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showWelcome(message) {
  const hint = document.getElementById("welcomeHint");
  if (hint) {
    hint.style.display = message ? "block" : "none";
    hint.textContent = message || "";
  }
  showState("welcome");
}

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "重新尝试";
  // 2026-10-27: 次要按钮默认隐藏（只有学堂在线那条路需要第二条出路）
  const secondary = document.getElementById("errorBtnSecondary");
  if (secondary) {
    secondary.style.display = "none";
    secondary.onclick = null;
  }
}

/**
 * 把 background 抛回来的错误（带 bilibiliError 分类）翻译成 sidepanel
 * 能直接显示的 { title, message }。
 *
 * 兼容三种来源：
 *  1. triggerWhisperTranscription 的 result（带 bilibiliError 字段）
 *  2. catch 到的 Error（带 err.bilibiliError）
 *  3. 旧逻辑 / 字符串（直接当 message 显示）
 */
function classifyWhisperError(input) {
  // 1. 字符串：直接当 message，title 用默认
  if (typeof input === "string") {
    return { title: "Whisper 转录失败", message: input };
  }
  // 2. Error 对象
  if (input instanceof Error) {
    if (input.bilibiliError) {
      return { title: input.bilibiliError.title, message: input.bilibiliError.userMessage };
    }
    return { title: "Whisper 转录失败", message: input.message || String(input) };
  }
  // 3. result 对象
  if (input && typeof input === "object") {
    if (input.bilibiliError) {
      return { title: input.bilibiliError.title, message: input.bilibiliError.userMessage };
    }
    const message = input.message || input.error || "请检查 whisper_server.py 是否在运行。";
    return { title: "Whisper 转录失败", message };
  }
  return { title: "Whisper 转录失败", message: "未知错误" };
}

function showWhisperError(input) {
  const { title, message } = classifyWhisperError(input);
  showError(title, message);
  // 2026-11-05: 500 LocalEntryNotFoundError / ConnectTimeout 有一个非常
  // 具体的根因 —— 跑着的 whisper server 是**旧代码**（开机自启任务拉起
  // 的 SYSTEM 实例，普通用户权限杀不掉）。旧代码不会解析本地模型缓存，
  // 每次都去 huggingface.co 下载，本机直连不通 → ConnectTimeout。
  //
  // 光把天书般的英文报错甩给用户没用。这里直接检测 + 给一键修复。
  maybeRepairStaleWhisperServer(message);
}

/**
 * 如果报错像是"旧 server"的症状，就自动检测并在需要时修复。
 *
 * 修复方式不需要管理员权限：在备用端口（7861）用当前用户身份拉起一个
 * 新实例，然后让扩展改连它。旧实例变成无害僵尸。
 */
async function maybeRepairStaleWhisperServer(message) {
  const text = String(message || "");
  const looksStale =
    /LocalEntryNotFoundError/i.test(text) ||
    /ConnectTimeout/i.test(text) ||
    /WinError 10060/i.test(text) ||
    /Whisper server returned 5\d\d/i.test(text);
  if (!looksStale) return;

  try {
    const diag = await chrome.runtime.sendMessage({ action: "diagnoseWhisperServer" });
    if (!diag || !diag.success || !diag.stale) return;
    // 确实是旧代码 → 修
    const fix = await chrome.runtime.sendMessage({ action: "repairWhisperServer" });
    if (fix && fix.success) {
      const btn = document.getElementById("errorBtn");
      if (btn) {
        btn.textContent = "🔄 重新转录";
        btn.disabled = false;
      }
      const msg = document.getElementById("errorMessage");
      if (msg) {
        msg.textContent =
          "检测到 whisper server 跑的是旧版本（无法离线加载模型，转写会报 500）。" +
          "已自动启动新版本并切换过去 —— 现在再点一次「重新转录」即可。";
      }
      const title = document.getElementById("errorTitle");
      if (title) title.textContent = "whisper server 已修复";
    }
  } catch (_e) {
    /* 检测/修复失败 —— 保留原始报错，不制造噪音 */
  }
}

// ============================================================
// WHISPER TRANSCRIBE QUEUE PANEL (2026-08-29)
// ============================================================
// Expandable section at the bottom of the 字幕 tab. Shows the single
// running whisper job plus everything queued behind it (background keeps
// whisper strictly single-job and auto-starts the next queued entry when
// the current one finishes). State arrives via whisperQueueUpdate
// broadcasts; getWhisperQueue is the pull used on init / after actions.

let whisperQueueExpanded = false;

async function refreshWhisperQueue() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "getWhisperQueue" });
    if (res && typeof res === "object") {
      renderWhisperQueue(Array.isArray(res.queue) ? res.queue : [], res.job || null);
    }
  } catch {}
}

function renderWhisperQueue(queue, job) {
  const panel = document.getElementById("whisperQueuePanel");
  if (!panel) return;
  const list = document.getElementById("whisperQueueList");
  const running = document.getElementById("whisperQueueRunning");
  const count = document.getElementById("whisperQueueCount");
  const emptyHint = document.getElementById("whisperQueueEmpty");
  if (!list || !running || !count) return;

  // Whole panel hides when nothing runs and nothing is queued.
  panel.hidden = !job && queue.length === 0;
  // Badge counts the running job + queued entries (total workload).
  count.textContent = String(queue.length + (job ? 1 : 0));

  if (job) {
    running.innerHTML = `
      <div class="queue-row queue-row--running">
        <span class="queue-pos">▶</span>
        <div class="queue-row-main">
          <div class="queue-row-title"></div>
          <div class="queue-row-sub"></div>
        </div>
        <span class="queue-tag queue-tag--running">进行中</span>
      </div>`;
    running.querySelector(".queue-row-title").textContent =
      job.title || job.videoId || "当前任务";
    running.querySelector(".queue-row-sub").textContent =
      job.stageSubtitle || job.stageTitle || "转录进行中";
  } else {
    running.innerHTML = "";
  }

  list.innerHTML = "";
  queue.forEach((entry, idx) => {
    const li = document.createElement("li");
    li.className = "queue-row";
    li.innerHTML = `
      <span class="queue-pos"></span>
      <div class="queue-row-main">
        <div class="queue-row-title"></div>
        <div class="queue-row-sub"></div>
      </div>
      <button class="queue-remove" title="从队列移除" aria-label="从队列移除">✕</button>`;
    li.querySelector(".queue-pos").textContent = String(idx + 1);
    li.querySelector(".queue-row-title").textContent =
      entry.title || entry.videoId || "未命名视频";
    li.querySelector(".queue-row-sub").textContent =
      `${entry.videoId}${Number(entry.pageNumber) > 1 ? ` · P${entry.pageNumber}` : ""}`;
    li.querySelector(".queue-remove").addEventListener("click", async () => {
      try {
        await chrome.runtime.sendMessage({
          action: "removeWhisperQueueEntry",
          videoId: entry.videoId,
          pageNumber: entry.pageNumber,
        });
      } catch {}
      refreshWhisperQueue();
    });
    list.appendChild(li);
  });

  if (emptyHint) emptyHint.hidden = queue.length > 0;
}

function initWhisperQueuePanel() {
  const toggle = document.getElementById("whisperQueueToggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    whisperQueueExpanded = !whisperQueueExpanded;
    const body = document.getElementById("whisperQueueBody");
    const chevron = document.getElementById("whisperQueueChevron");
    if (body) body.hidden = !whisperQueueExpanded;
    if (chevron) chevron.classList.toggle("queue-chevron--open", whisperQueueExpanded);
    toggle.setAttribute("aria-expanded", String(whisperQueueExpanded));
  });
  refreshWhisperQueue();
}

/**
 * 读真实的字幕缓存目录。
 *
 * 2026-11-05：超时的两条路径（sendMessage reject / 后台没回包）以前把
 * cacheDir 硬编码成 ""，于是提示语永远是"请先在设置里配置字幕缓存目录"
 * —— 哪怕用户明明配了 C:\Users\shangweizhe\bilibilisubs。这是在说谎，
 * 用户会跑去设置页反复检查一个根本没问题的配置。
 *
 * 现在去问后台要真实值（后台有 getSettings 的默认值兜底逻辑：没配时
 * 自动落到 <下载目录>/BiliSubs）。读不到就返回空串，退回旧文案。
 */
async function readConfiguredCacheDir() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "getSubtitleCacheDir" });
    if (res && typeof res === "object" && res.success) {
      const dir = res.subtitlesDir || "";
      if (typeof dir === "string" && dir.trim()) return dir.trim();
    }
  } catch (_e) {
    /* 后台不可达 —— 退回空串 */
  }
  return "";
}

function showWhisperPrompt(videoId, videoUrl, cacheDir, reason = "") {
  // A whisper job may already be running for THIS video (user switched
  // to another page mid-transcription, then came back — the panel stayed
  // open through Bilibili's SPA navigation, so only checkCurrentTab→
  // startBililearn→fetchTranscript ran, NOT the panel-init resume path).
  // In that case attach to the job's loading UI instead of showing the
  // "no cache" prompt again, which would invite a duplicate trigger.
  maybeResumeWhisperJob().then((resumed) => {
    if (resumed) return;
    actuallyShowWhisperPrompt(videoId, videoUrl, cacheDir, reason);
  });
}

function actuallyShowWhisperPrompt(videoId, videoUrl, cacheDir, reason = "") {
  showState("error");
  document.getElementById("errorTitle").textContent =
    "本地没有缓存这个视频的字幕";
  const note = cacheDir
    ? `转录结果会保存到 ${cacheDir}，下次打开这个视频直接读缓存。`
    : "请先在设置里配置字幕缓存目录。";
  document.getElementById("errorMessage").textContent = reason
    ? `${note}\n（${reason}）`
    : note;
  const btn = document.getElementById("errorBtn");
  btn.textContent = "🎙️ 用 Whisper 转录";
  btn.disabled = false;
  // 2026-10-27: 次要按钮是学堂在线那条路专用的 —— 这里必须清掉，
  // 否则上一个学堂在线视频留下的「再试一次官方字幕」会跟着跑到
  // B 站页面上（按钮文案对不上，还带着学堂在线的重试动作）。
  const secondary = document.getElementById("errorBtnSecondary");
  if (secondary) {
    secondary.style.display = "none";
    secondary.onclick = null;
    secondary.textContent = "再试一次官方字幕";
    secondary.disabled = false;
  }
  errorAction = () => gateLongVideoTranscribe(async () => {
    btn.disabled = true;
    btn.textContent = "正在启动…";
    updateLoading("启动 Whisper 转录", "下载音轨并发送至本地 server");
    showState("loading");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "triggerWhisperTranscription",
        videoId: videoId.split("@p")[0],
        pageNumber: Math.max(
          1,
          Number(String(videoId.split("@p")[1] || "1").replace(/^p/i, "")) || 1,
        ),
        videoUrl,
        videoTitle: currentVideoTitle || "",
      });
      if (result && result.success) {
        if (result.queued || result.alreadyQueued) {
          // Another video is transcribing — this one joined the queue.
          // Keep the loading screen with the queue position; when the
          // pump starts this entry its transcriptProgress broadcasts
          // replace the copy, and succeeded re-renders the transcript.
          updateLoading(
            "已加入转录队列",
            result.alreadyQueued
              ? `该视频已在队列中（第 ${result.position} 位），前序任务完成后自动开始`
              : `当前排在第 ${result.position} 位，前序任务完成后自动开始`,
          );
          refreshWhisperQueue();
          return;
        }
        if (result.alreadyRunning || result.started) {
          // Already running, OR fire-and-ack started (pipeline detached on
          // the background side): attach to the running job's progress UI
          // instead of waiting on the sendMessage promise — the terminal
          // state arrives via transcriptProgress broadcast. Falls through
          // to startBililearn only if the job record is somehow unreadable.
          const resumed = await maybeResumeWhisperJob();
          if (resumed) return;
        }
        // Re-enter the normal flow so the new transcript renders with the
        // same UI as a first-time analysis.
        await removeVideoCache(videoId);
        currentVideoId = null;
        await startBililearn(videoId, videoUrl);
      } else {
        showWhisperError(result);
        btn.disabled = false;
        btn.textContent = "🎙️ 用 Whisper 转录";
      }
    } catch (err) {
      showWhisperError(err);
      btn.disabled = false;
      btn.textContent = "🎙️ 用 Whisper 转录";
    }
  });
}

// ============================================================
// CONTEXTUAL WIZARDS (2026-08-28)
// ============================================================
// Three non-blocking setup guides. No dismiss button and nothing is
// persisted: each wizard simply re-appears wherever its underlying
// config problem is still unfixed, and it never blocks other tabs.
//   #aiKeyWizard        — Overview/Summary tab + AI key missing
//   #asrWizard          — Transcript tab + video has no subtitles
//   #whisperSetupWizard — Transcript tab + Whisper selected + server down

let aiKeyMissing = false;
let whisperPingTimer = null;

function setupWizardButtons() {
  // Each wizard jumps straight to its matching options section via
  // options.html#<anchor> instead of just opening the page at the top.
  const WIZARD_OPTION_ANCHORS = {
    openOptionsForAsr: "asrSection",
    openOptionsForWhisper: "whisperSettings",
    openOptionsForAiKey: "aiProviderCard",
  };
  for (const id of Object.keys(WIZARD_OPTION_ANCHORS)) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({
          action: "openOptions",
          anchor: WIZARD_OPTION_ANCHORS[id],
        });
      });
    }
  }
}

async function pingWhisperServer() {
  let base = "http://127.0.0.1:7860";
  try {
    const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
    const settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY] || {});
    if (settings.whisperUrl) base = settings.whisperUrl;
  } catch {
    // fall back to the default URL
  }
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

function stopWhisperPing() {
  if (whisperPingTimer) {
    clearInterval(whisperPingTimer);
    whisperPingTimer = null;
  }
}

/**
 * Clean-page helpers (2026-08-29, user request "图一图二下面那几个按钮全去掉"):
 * while a contextual wizard is showing, the functional sections below it are
 * dead weight — their buttons (复制/导出/保存/重新生成…) have nothing to act
 * on yet. The wizard pages should look like the whisper prompt page: one
 * clean card, one action button. These helpers hide/restore the sections.
 */
function setTranscriptSectionHidden(hidden) {
  const section = document.getElementById("transcriptSection");
  if (section) section.hidden = hidden;
}

function setLlmSectionsHidden(hidden) {
  const panels = document.querySelectorAll(
    '.tab-panel[data-panel="overview"], .tab-panel[data-panel="summary"]',
  );
  for (const panel of panels) {
    for (const section of panel.querySelectorAll(":scope > .section")) {
      section.hidden = hidden;
    }
  }
}

/**
 * Error-aware variant of setLlmSectionsHidden(false): restores a panel's
 * sections only when its full-panel error page is NOT up. While an error
 * page owns the panel its sections stay hidden (DESIGN.md), so switching
 * tabs away and back must not resurrect empty sections behind the error.
 */
function restoreLlmSections() {
  const panels = document.querySelectorAll(
    '.tab-panel[data-panel="overview"], .tab-panel[data-panel="summary"]',
  );
  for (const panel of panels) {
    const errorPage = panel.querySelector(":scope > .error-hero-page");
    if (errorPage && !errorPage.hidden) continue;
    for (const section of panel.querySelectorAll(":scope > .section")) {
      section.hidden = false;
    }
  }
  // 2026-10-27: 有官方章节时，概览里的「关键观点」节要继续藏着 ——
  // 官方章节模式下我们根本没跑 AI，没有观点。
  if (currentXuetangxChapters?.length) {
    applyOverviewSections({ hasChapters: true });
  }
}

function hideTranscriptWizards() {
  const asr = document.getElementById("asrWizard");
  const wsp = document.getElementById("whisperSetupWizard");
  if (asr) asr.hidden = true;
  if (wsp) wsp.hidden = true;
  setTranscriptSectionHidden(false);
  stopWhisperPing();
}

/**
 * 概览这一步**是不是因为缺 AI key 而做不了**？
 *
 * 2026-10-27: 学堂在线有官方章节摘要 —— 章节是课程方给的，不花钱、
 * 也不需要 AI key。所以：
 *   - 有官方章节 → 不受影响（概览已经有内容了）
 *   - 学堂在线但还没查 → 不受影响（先拉官方章节，拉得到就不用 AI）
 *   - 其它站点 → 缺 key 就做不了
 */
function overviewRequiresAiKey(options = {}) {
  const {
    hasOfficialChapters = false,
    isXuetangx = false,
    aiKeyMissing = false,
  } = options;
  if (hasOfficialChapters) return false;
  if (isXuetangx) return false;
  return !!aiKeyMissing;
}

/**
 * Moves the single #aiKeyWizard node into the active Overview/Summary
 * panel and toggles visibility. One element, two panels: the wizard
 * always renders at the top of whichever LLM tab the user opened.
 */
function updateAiKeyWizard(tabName) {
  const wiz = document.getElementById("aiKeyWizard");
  if (!wiz) return;
  // 2026-10-27: 学堂在线有**官方章节**时，概览根本不需要 AI —— 不该弹
  // "配置AI模型和密钥"的引导。（总结页还是需要 AI，那一节照旧。）
  //
  // 学堂在线先按"可能有官方章节"处理（isXuetangx = 还没查过章节）：
  // 等章节拉回来、确认没有，才轮得到弹配置引导。
  const overviewSkipsAi =
    tabName === "overview" &&
    !overviewRequiresAiKey({
      hasOfficialChapters: !!currentXuetangxChapters?.length,
      isXuetangx:
        isXuetangxVideoId(currentVideoId) && !xuetangxChaptersChecked,
      aiKeyMissing,
    });
  if (
    !aiKeyMissing ||
    (tabName !== "overview" && tabName !== "summary") ||
    overviewSkipsAi
  ) {
    wiz.hidden = true;
    restoreLlmSections();
    return;
  }
  // Clean page: with the wizard up, the LLM sections below (章节/关键观点/
  // 总结操作行) render dead buttons over empty placeholders — hide them,
  // along with any stale full-panel error page from a failed run (the
  // wizard explains the more fundamental problem and owns the panel).
  setLlmSectionsHidden(true);
  hidePanelError("overview");
  hidePanelError("summary");
  const panel = document.querySelector(`.tab-panel[data-panel="${tabName}"]`);
  if (panel && wiz.parentElement !== panel) {
    panel.insertBefore(wiz, panel.firstChild);
  }
  wiz.hidden = false;
}

/** Results state with an empty transcript tab and the ASR picker wizard. */
function showAsrWizardState() {
  hideTranscriptWizards();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  const asr = document.getElementById("asrWizard");
  if (asr) asr.hidden = false;
  setTranscriptSectionHidden(true);
  switchTab("transcript");
}

/**
 * Results state with the Whisper setup wizard, plus a 5s ping loop.
 * When the server comes back online the loop re-enters the normal
 * flow so the user lands on the regular "用 Whisper 转录" prompt.
 */
function showWhisperSetupWizardState() {
  hideTranscriptWizards();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  const wsp = document.getElementById("whisperSetupWizard");
  if (wsp) wsp.hidden = false;
  setTranscriptSectionHidden(true);
  const statusEl = document.getElementById("whisperSetupStatus");
  if (statusEl) statusEl.textContent = "检查中…";
  switchTab("transcript");
  stopWhisperPing();
  whisperPingTimer = setInterval(async () => {
    const stillVisible = document.getElementById("whisperSetupWizard");
    if (!stillVisible || stillVisible.hidden) {
      stopWhisperPing();
      return;
    }
    const up = await pingWhisperServer();
    if (up) {
      stopWhisperPing();
      if (currentVideoId && currentVideoUrl) {
        await startBililearn(currentVideoId, currentVideoUrl);
      }
    } else if (statusEl) {
      statusEl.textContent = "仍未连上（每 5 秒自动重试）— 启动 server 后会自动继续";
    }
  }, 5000);
}

// ============================================================
// LONG-VIDEO WHISPER GATE (2026-08-29)
// ============================================================
// Local Whisper inference on a long video pegs the CPU/GPU for the
// whole playback duration (often tens of minutes) and noticeably
// degrades the machine. Past the 20-minute threshold the user must
// explicitly confirm before a transcription job is allowed to start.
// The gate wraps the two UI trigger points (the error-state "用
// Whisper 转录" button and the local-file "重新生成" button); resume
// paths (maybeResumeWhisperJob) attach to an already-running job and
// must never be gated.

const LONG_TRANSCRIBE_THRESHOLD_SEC = 20 * 60;
let pendingLongTranscribeAction = null;

function isLongVideoForTranscribe() {
  // Duration comes from the player via getVideoInfo (seconds). Unknown
  // (0 — metadata not loaded / live page) fails open: blocking the only
  // transcription button on missing metadata would dead-end the flow.
  return (Number(currentVideoDuration) || 0) > LONG_TRANSCRIBE_THRESHOLD_SEC;
}

function hideLongTranscribeConfirm() {
  const overlay = document.getElementById("longTranscribeConfirm");
  if (overlay) overlay.hidden = true;
  pendingLongTranscribeAction = null;
}

function showLongTranscribeConfirm(run) {
  const overlay = document.getElementById("longTranscribeConfirm");
  if (!overlay) {
    // Overlay markup missing (stale panel HTML): fail open.
    run();
    return;
  }
  pendingLongTranscribeAction = run;
  const minutes = Math.max(
    1,
    Math.round((Number(currentVideoDuration) || 0) / 60),
  );
  const msg = document.getElementById("longTranscribeMessage");
  if (msg) {
    msg.textContent =
      `当前视频约 ${minutes} 分钟。用本地 Whisper 转录长视频会长时间占用 ` +
      "CPU/GPU，电脑性能会明显下降，转录可能持续几十分钟。确定要继续吗？";
  }
  overlay.hidden = false;
}

function setupLongTranscribeConfirm() {
  const okBtn = document.getElementById("longTranscribeOk");
  const cancelBtn = document.getElementById("longTranscribeCancel");
  if (okBtn) {
    okBtn.addEventListener("click", () => {
      const run = pendingLongTranscribeAction;
      hideLongTranscribeConfirm();
      if (run) run();
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", hideLongTranscribeConfirm);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlay = document.getElementById("longTranscribeConfirm");
    if (overlay && !overlay.hidden) hideLongTranscribeConfirm();
  });
}

/**
 * Wraps a transcription trigger: short videos run immediately, videos
 * past the 20-minute threshold ask for explicit confirmation first.
 */
function gateLongVideoTranscribe(run) {
  if (isLongVideoForTranscribe()) {
    showLongTranscribeConfirm(run);
  } else {
    run();
  }
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // 2026-09-12: remember this video's last-viewed tab so a later return
  // from cache restores the view the user left (see startBililearn's
  // cache branch).
  if (currentVideoId) lastTabByVideo.set(currentVideoId, tabName);

  // If a new video just rendered, the first switchTab should land the
  // user at the top of the new tab — not where the previous video's
  // scroll position was (which would put the user somewhere in the
  // middle of e.g. the chapter list, with no idea how far down they
  // are). Fires once per new video, then disarms. (2026-08-23)
  if (tabScrollTopArmed) {
    const scroller = document.querySelector(".content");
    if (scroller) scroller.scrollTop = 0;
    tabScrollTopArmed = false;
  }

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Contextual AI-key wizard: the Overview/Summary panels show the
  // wizard at their top when no key is configured, and the lazy LLM
  // loads below are skipped so we never fire a doomed request.
  updateAiKeyWizard(tabName);

  // Lazy-load LLM analysis when user switches to Overview tab
  //
  // 2026-10-27: 学堂在线课程自带"官方章节摘要"的话，直接用它当概览 ——
  // 不要再跑 AI（用户要求，也省 token）。章节是页面侧抓的，很快，
  // 所以先要章节再决定要不要跑 AI。
  //
  // 注意：官方章节这条路**不需要 AI key** —— 所以这里不能拿 aiKeyMissing
  // 把整个分支掐掉，否则没配 key 的用户连官方章节都看不到。
  if (tabName === "overview" && !currentAnalysis && !analysisInFlight.has(currentVideoId)) {
    if (currentXuetangxChapters?.length) {
      // 官方章节已经在手 → 渲染它（AI 同款格式），不跑 AI
      applyXuetangxChapters(currentXuetangxChapters);
    } else if (isXuetangxVideoId(currentVideoId)) {
      const videoIdAtGuide = currentVideoId;
      loadXuetangxChapters(videoIdAtGuide).then((chapters) => {
        if (videoIdAtGuide !== currentVideoId) return;
        xuetangxChaptersChecked = true;
        if (chapters) {
          currentXuetangxChapters = chapters;
          applyXuetangxChapters(chapters);
          return;
        }
        // 没有官方章节 → 才轮到 AI（没 key 就显示配置引导）
        if (aiKeyMissing) {
          updateAiKeyWizard("overview");
          return;
        }
        triggerAnalysis();
      });
    } else if (!aiKeyMissing) {
      triggerAnalysis();
    }
  }

  // Lazy-load LLM summary when user switches to Summary tab
  if (tabName === "summary" && !currentSummary && !summaryInFlight.has(currentVideoId) && !aiKeyMissing) {
    triggerSummary();
  }

  // Close any lingering Explain UI when switching tabs. The modal is
  // position: fixed so it would otherwise keep overlaying the new tab's
  // content (the user sees an Explain modal stuck over the Overview/Notes
  // tabs they just opened and can't tell where it came from). The
  // tooltip can also be left behind if the mouseup that triggered
  // setupExplainFeature wasn't followed by another mouseup on a different
  // region — hide it defensively.
  const lingeringModal = document.getElementById?.("explainModal");
  if (lingeringModal) lingeringModal.remove();
  const lingeringTooltip = document.getElementById?.("explainTooltip");
  if (lingeringTooltip) lingeringTooltip.style.display = "none";
}

/**
 * Full-panel standard error pages (DESIGN.md, 2026-08-30 user request):
 * when an LLM request fails, the ENTIRE tab renders the centered hero
 * error page — content containers are cleared, the tab's `.section`s are
 * hidden. Never a mix of one failed block plus one forever-loading
 * placeholder (the old bug: 「正在提取关键观点…」 stayed up forever next
 * to the chapter error).
 */
const PANEL_ERROR_META = {
  overview: {
    pageId: "overviewError",
    containerIds: ["chapterList", "quotesList"],
  },
  summary: {
    pageId: "summaryError",
    containerIds: ["summaryContent"],
  },
};

function panelErrorPage(panelName) {
  const meta = PANEL_ERROR_META[panelName];
  if (!meta) return null;
  return document.getElementById(meta.pageId);
}

/**
 * Hides the panel's error page (sections are NOT touched — whoever renders
 * real content next restores them). Safe to call when nothing is showing.
 */
function hidePanelError(panelName) {
  const page = panelErrorPage(panelName);
  if (page) page.hidden = true;
}

/**
 * Shows the full-panel hero error page: clears the panel's content
 * containers, hides its sections, sets the raw error message verbatim
 * (error codes are never rewritten) and wires 重试 to first restore the
 * panel then re-run `retryFn`. Re-invoking the trigger functions is safe:
 * on failure `currentAnalysis` / `currentSummary` stay unset and the
 * loading flags are already reset, so the retry starts a fresh request.
 */
function showPanelError(panelName, message, retryFn) {
  const meta = PANEL_ERROR_META[panelName];
  const page = panelErrorPage(panelName);
  if (!meta || !page) return;

  const panel = page.closest(".tab-panel");
  if (panel) {
    for (const section of panel.querySelectorAll(":scope > .section")) {
      section.hidden = true;
    }
  }
  for (const id of meta.containerIds) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }

  const msg = page.querySelector(".error-hero-message");
  if (msg) msg.textContent = message;

  const btn = page.querySelector(".error-hero-btn");
  if (btn) {
    btn.onclick = () => {
      hidePanelError(panelName);
      if (panel) {
        for (const section of panel.querySelectorAll(":scope > .section")) {
          section.hidden = false;
        }
      }
      if (typeof retryFn === "function") retryFn();
    };
  }

  page.hidden = false;
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || analysisInFlight.has(currentVideoId) || currentAnalysis)
    return;
  // 2026-10-27: 已有学堂在线官方章节 → 概览用它，不再跑 AI。
  if (currentXuetangxChapters?.length) {
    applyXuetangxChapters(currentXuetangxChapters);
    return;
  }

  // 2026-09-12 cross-video race fix: this LLM call can outlive the user's
  // stay on this video. Capture WHO the result belongs to; on completion
  // either render (still here) or park it in the ORIGINAL video's cache
  // (user moved on) — never render or save into the wrong video.
  const videoIdAtStart = currentVideoId;
  // Click-through pair for the slow-run notification (see triggerSummary).
  const videoUrlAtStart = currentVideoUrl;

  // State honesty (DESIGN.md): a new load must never start behind a stale
  // error page from a previous video/attempt — and its loaders must land
  // in VISIBLE sections (see triggerSummary for the 2026-08-30 report).
  hidePanelError("overview");
  restoreLlmSections();
  analysisInFlight.add(videoIdAtStart);

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">正在生成章节…</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">正在提取关键观点…</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
      // 2026-09-02: slow-run (>1min) completion notification click-through,
      // captured at call start so id+url always name the owning video.
      videoId: videoIdAtStart || "",
      videoUrl: videoUrlAtStart || "",
    });

    if (videoIdAtStart !== currentVideoId) {
      // User switched away mid-call: park the result in the ORIGINAL
      // video's cache so returning to it is a free cache hit — no
      // re-render, no save into the CURRENT video's entry.
      if (analysisResult && analysisResult.success && analysisResult.analysis) {
        await mergeLlmResultToCache(videoIdAtStart, { analysis: analysisResult.analysis });
      }
      debugLog("[dk-bililearn Panel] analysis finished after video switch; parked in cache for", videoIdAtStart);
      return;
    }

    if (!analysisResult.success) {
      showPanelError(
        "overview",
        `Analysis failed: ${analysisResult.error || "Unknown error"}`,
        triggerAnalysis,
      );
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis. videoIdAtStart ===
    // currentVideoId here, and saveToCache builds its entry synchronously
    // before its first await — the entry cannot pick up a newer video's
    // state even if the user switches during the storage write.
    await saveToCache(videoIdAtStart);
  } catch (error) {
    console.error("[dk-bililearn Panel] Analysis error:", error);
    if (videoIdAtStart === currentVideoId) {
      showPanelError("overview", `Error: ${error.message}`, triggerAnalysis);
    }
  } finally {
    analysisInFlight.delete(videoIdAtStart);
  }
}

/**
 * Triggers the LLM summary (lazy-loaded when user clicks the Summary tab).
 * Converts the full transcript into a complete, structured study note.
 */
async function triggerSummary() {
  if (!currentTranscriptTimestamped || summaryInFlight.has(currentVideoId) || currentSummary)
    return;

  // 2026-09-12 cross-video race fix (same as triggerAnalysis): the LLM
  // call can outlive the user's stay; the result belongs to the video that
  // STARTED the call, not whichever video is on screen when it returns.
  const videoIdAtStart = currentVideoId;
  // Click-through target for the slow-run notification must match the
  // OWNING video too (videoId+videoUrl captured as a pair, so a mid-call
  // switch can't make the notification open the wrong video's page).
  const videoUrlAtStart = currentVideoUrl;

  // State honesty (DESIGN.md): a new load must never start behind a stale
  // error page from a previous video/attempt — and its loader must land in
  // a VISIBLE section. showPanelError hides the panel's sections; the lazy
  // tab-switch path never restores them (only the 重试 button did), so the
  // 「正在总结中…」 placeholder used to render inside a hidden section and
  // the tab stayed blank until the next tab switch (2026-08-30 report).
  // hidePanelError first, THEN restoreLlmSections: the restore is
  // error-aware and skips panels whose error page is still up.
  hidePanelError("summary");
  restoreLlmSections();
  summaryInFlight.add(videoIdAtStart);
  const summaryContent = document.getElementById("summaryContent");

  if (summaryContent) {
    summaryContent.innerHTML =
      '<div class="summary-placeholder" style="color: var(--text-muted);">正在根据完整字幕整理笔记…</div>';
  }

  try {
    const summaryResult = await chrome.runtime.sendMessage({
      action: "summaryTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      // Slow-run (>1min) completion notification click-through target,
      // captured at call start so it always names the owning video.
      videoId: videoIdAtStart || "",
      videoUrl: videoUrlAtStart || "",
    });

    if (videoIdAtStart !== currentVideoId) {
      // User switched away mid-call: park the finished summary in the
      // ORIGINAL video's cache (so returning to it is a free cache hit,
      // not another LLM call) and never render it into the wrong panel.
      if (summaryResult && summaryResult.success && summaryResult.markdown) {
        await mergeLlmResultToCache(videoIdAtStart, { summary: summaryResult.markdown });
      }
      debugLog("[dk-bililearn Panel] summary finished after video switch; parked in cache for", videoIdAtStart);
      return;
    }

    if (!summaryResult.success) {
      showPanelError(
        "summary",
        `Summary failed: ${summaryResult.error || "Unknown error"}`,
        triggerSummary,
      );
      return;
    }

    currentSummary = summaryResult.markdown || "";
    renderSummaryResults(currentSummary);

    // Save to cache now that we have summary. videoIdAtStart ===
    // currentVideoId here; saveToCache builds its entry synchronously
    // before its first await, so it cannot capture a newer video's state.
    await saveToCache(videoIdAtStart);
  } catch (error) {
    console.error("[dk-bililearn Panel] Summary error:", error);
    if (videoIdAtStart === currentVideoId) {
      showPanelError("summary", `Error: ${error.message}`, triggerSummary);
    }
  } finally {
    summaryInFlight.delete(videoIdAtStart);
  }
}

/**
 * Renders the summary Markdown into the Summary tab.
 */
function renderSummaryResults(markdown) {
  const summaryContent = document.getElementById("summaryContent");
  if (!summaryContent) return;
  if (!markdown) {
    summaryContent.innerHTML =
      '<div class="summary-placeholder" style="color: var(--text-muted);">没有生成内容。</div>';
    return;
  }
  summaryContent.innerHTML = renderMarkdown(markdown, { jumpLinks: true });
  // Chapter/section-title timestamps jump to that point in the video (same
  // interaction as the Overview tab; h2 chapters + h3 sections). Clamp to the
  // known video duration so a hallucinated stamp can't seek past the end.
  summaryContent.querySelectorAll(".md-jump").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.seconds);
      if (!Number.isFinite(target)) return;
      const max = Number(currentVideoDuration) || 0;
      const seconds =
        max > 0 ? Math.min(Math.max(0, target), Math.max(0, max - 1)) : target;
      debugLog(
        "[dk-bililearn Panel] Summary chapter jump:",
        btn.dataset.seconds,
        "→",
        seconds,
      );
      seekTo(seconds);
    });
  });
}

/**
 * Minimal, dependency-free Markdown -> HTML renderer for AI-generated notes.
 * Input is escaped first, so only the allowlisted syntax below can become
 * markup — no raw HTML, no attributes, no scripts.
 *
 * Supported: #..###### headings, ordered/unordered lists, blockquotes,
 * code fences, inline code, **bold**, *italic*, [text](url), --- rule,
 * GFM pipe tables (with :---/---:/:---: alignment), line breaks and
 * paragraphs.
 */
function renderMarkdown(markdown, opts = {}) {
  if (!markdown) return "";
  let lines = String(markdown).replace(/\r\n/g, "\n").split("\n");

  const escapeHtml = (text) => {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  };

  // Inline formatting, applied AFTER escaping. Only run on escaped text.
  const inline = (text) =>
    text
      .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );

  // "[M:SS]" / "[H:MM:SS]" → seconds; null when malformed. Feeds the summary
  // chapter-title jump chips (see the heading branch below).
  const timestampToSeconds = (ts) => {
    const parts = ts.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  };

  // ---- GFM table helpers ----
  // Split "| a | b |" into ["a","b"]; strips the outer pipes and honors
  // the escaped-pipe form "a \| b" so cell content may contain a literal |.
  const splitRow = (text) => {
    let t = text.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|").trim());
  };
  const isSeparatorCell = (c) => /^:?-{2,}:?$/.test(c);
  // A table header candidate needs a separator row right below it.
  const tableAt = (idx) => {
    if (idx + 1 >= lines.length) return null;
    const headerCells = splitRow(lines[idx]);
    const sepCells = splitRow(lines[idx + 1]);
    if (
      headerCells.length < 1 ||
      sepCells.length !== headerCells.length ||
      !sepCells.every(isSeparatorCell)
    ) {
      return null;
    }
    const aligns = sepCells.map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
    );
    const bodyRows = [];
    let j = idx + 2;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t || !t.includes("|")) break;
      bodyRows.push(splitRow(t));
      j++;
    }
    const th = headerCells
      .map(
        (c, k) =>
          `<th style="text-align:${aligns[k]}">${inline(escapeHtml(c))}</th>`,
      )
      .join("");
    const trs = bodyRows
      .map(
        (r) =>
          `<tr>${headerCells
            .map(
              (_h, k) =>
                `<td style="text-align:${aligns[k]}">${inline(escapeHtml(r[k] ?? ""))}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    return { html: `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`, nextIndex: j };
  };

  const html = [];
  let inFence = false;
  let fenceBuf = [];
  let listType = null; // "ul" | "ol"

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence
    if (/^```/.test(line)) {
      if (inFence) {
        html.push(`<pre><code>${escapeHtml(fenceBuf.join("\n"))}</code></pre>`);
        fenceBuf = [];
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      html.push("");
      continue;
    }

    // GFM pipe table (header | separator | body rows). Requires a valid
    // separator row below the candidate header, otherwise falls through
    // to the normal paragraph handling.
    if (trimmed.includes("|")) {
      const table = tableAt(i);
      if (table) {
        closeList();
        html.push(table.html);
        i = table.nextIndex - 1;
        continue;
      }
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      let headingText = headingMatch[2];
      let jumpHtml = "";
      // Summary chapter AND section titles carry the section's start time
      // ("## 一、会议概览与开场 [3:25]" / "### 开场数据 [3:25]"). With
      // jumpLinks on (summary tab), the trailing stamp renders as a jump
      // chip instead of literal text; other levels and surfaces keep it
      // verbatim.
      const tsMatch =
        opts.jumpLinks && (level === 2 || level === 3)
          ? headingText.match(/\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*$/)
          : null;
      if (tsMatch) {
        const seconds = timestampToSeconds(tsMatch[1]);
        if (seconds !== null) {
          jumpHtml =
            `<button type="button" class="md-jump" data-seconds="${seconds}"` +
            ` title="跳转到 ${tsMatch[1]}">▶ ${tsMatch[1]}</button>`;
          headingText = headingText.slice(0, tsMatch.index).replace(/\s+$/, "");
        }
      }
      html.push(
        `<h${level}>${inline(escapeHtml(headingText))}${jumpHtml}</h${level}>`,
      );
      continue;
    }

    // Horizontal rule
    if (/^(\*\*\*|---|___)$/.test(trimmed)) {
      closeList();
      html.push("<hr>");
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      closeList();
      html.push(`<blockquote>${inline(escapeHtml(trimmed.replace(/^>\s?/, "")))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (olMatch) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    // Plain paragraph
    closeList();
    html.push(`<p>${inline(escapeHtml(trimmed))}</p>`);
  }

  if (inFence && fenceBuf.length) {
    html.push(`<pre><code>${escapeHtml(fenceBuf.join("\n"))}</code></pre>`);
  }
  closeList();

  return html.join("\n");
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[dk-bililearn Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[dk-bililearn Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored Bilibili tab first (fastest/reliable)
    if (bilibiliTabId) {
      try {
        await chrome.tabs.sendMessage(bilibiliTabId, payload);
        debugLog("[dk-bililearn Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[dk-bililearn Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[dk-bililearn Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[dk-bililearn Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

/**
 * Save a text file to disk.
 *
 * Chrome's MV3 security model restricts `chrome.downloads.download` to
 * paths inside the user's default Downloads folder when `saveAs: false`.
 * To honor a custom export location set in options, we have to pop a
 * Save As dialog (`saveAs: true`) with the configured directory and
 * filename pre-filled. The user just clicks Save. This is the only way
 * to land a file at an arbitrary path without a native helper, and it
 * gives the user a confirmation of where the file is going.
 *
 * If no custom `exportDir` is set, the file lands in the
 * DEFAULT_EXPORT_SUBDIR subfolder of the browser's default Downloads
 * folder, silently (no dialog). A relative `filename` in
 * chrome.downloads.download() is resolved against the default download
 * directory on Windows/macOS/Linux alike, and Chrome creates missing
 * subfolders automatically — so the extension never needs to know the
 * absolute Downloads path (MV3 exposes no $HOME / %USERPROFILE% API).
 * If the user has changed the browser's download location, the relative
 * path follows that setting too.
 *
 * Requires the `downloads` permission.
 */
const DEFAULT_EXPORT_SUBDIR = "BiliSubs";

function defaultExportFilename(filename) {
  return `${DEFAULT_EXPORT_SUBDIR}/${filename}`;
}

async function downloadTextFile(text, filename, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });

  // chrome.downloads needs a URL (not a Blob). Convert the blob to a
  // data: URL via FileReader. data: URLs work in all Chrome contexts.
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });

  // Read the configured export directory from chrome.storage.local. We
  // can't reach into YTD_SETTINGS from here without taking a hard
  // dependency, so we read the same STORAGE_KEY the options page uses.
  let exportDir = "";
  try {
    const STORAGE_KEY = "ytd_settings";
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    exportDir = (stored?.[STORAGE_KEY]?.exportDir || "").trim();
    console.log("[dk-bililearn] Export directory from storage:", exportDir || "(default Downloads/BiliSubs)");
  } catch (_err) {
    // Storage might be locked or unavailable; fall through to default.
    console.error("[dk-bililearn] Failed to read exportDir from storage:", _err);
  }

  const downloadOptions = {
    url: dataUrl,
    filename: filename,
    conflictAction: "uniquify",
  };

  if (exportDir) {
    // Build the full path. Strip any trailing separator from exportDir
    // and use a forward slash — Chrome accepts forward slashes on
    // Windows, macOS, and Linux in the filename parameter.
    const fullPath = `${exportDir.replace(/[\\/]+$/, "")}/${filename}`;
    downloadOptions.filename = fullPath;
    downloadOptions.saveAs = true; // Show Save As dialog with path pre-filled
  } else {
    // No custom directory: relative filename resolves against the
    // browser's default Downloads folder; the BiliSubs subfolder is
    // created automatically on first export.
    downloadOptions.filename = defaultExportFilename(filename);
    downloadOptions.saveAs = false; // Silent download to Downloads/BiliSubs
  }

  try {
    const downloadId = await chrome.downloads.download(downloadOptions);
    console.log("[dk-bililearn] Download started, ID:", downloadId, "options:", downloadOptions);
  } catch (error) {
    console.error("[dk-bililearn] Failed to start download:", error);
    // Try a fallback: relative path into the default Downloads folder
    try {
      const fallbackId = await chrome.downloads.download({
        url: dataUrl,
        filename: defaultExportFilename(filename),
        saveAs: false,
        conflictAction: "uniquify",
      });
      console.log("[dk-bililearn] Fallback download started, ID:", fallbackId);
    } catch (fallbackError) {
      console.error("[dk-bililearn] Fallback download also failed:", fallbackError);
      alert("下载失败：\n" + error.message);
    }
  }
}

/**
 * Build a Windows-safe filename segment.
 *
 *   - Preserves Chinese characters, CJK punctuation, and emoji
 *   - Strips only the chars that are actually illegal on Windows:
 *     `< > : " / \ | ? *` and ASCII control chars (0x00-0x1F)
 *   - Collapses whitespace runs to a single hyphen
 *   - Trims leading/trailing dots and hyphens
 *   - Truncates to 50 chars to keep the final filename under
 *     practical limits
 *
 * The previous implementation `[^\w\s-]` was too aggressive: it
 * stripped all Chinese characters because `\w` is ASCII-only by
 * default, so users ended up with English-only filenames even
 * though their video titles were Chinese.
 */
function sanitizeFilename(str) {
  if (!str) return "";
  return String(str)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .substring(0, 50)
    .replace(/[.\-]+$/g, "");
}

/**
 * Build the export filename in the format the user wants:
 *
 *   YYYY-MM-DD_{title}【{upMaster}】{suffix}.{ext}
 *
 *   - The date is the video's published date (from B站's metadata),
 *     falling back to today's date when the metadata is missing
 *     (e.g. the user is on a non-video page, or the meta tag isn't
 *     present on this template).
 *   - The title and up-master are passed through sanitizeFilename
 *     so the result is a legal Windows filename.
 *   - When upMaster is missing, the 【】 wrapper is omitted entirely
 *     (so we don't end up with a stray `【】` block).
 *   - `suffix` is used by the summary exporter to disambiguate
 *     summary files from raw-transcript files: "-总结" for the
 *     summary tab, "" for the transcript tab.
 */
function buildExportFilename(ext, suffix = "") {
  const date = formatYmdForFilename(currentPubDate);
  const title = sanitizeFilename(currentVideoTitle) || "untitled";
  const upMaster = sanitizeFilename(currentChannelName);
  const upPart = upMaster ? `【${upMaster}】` : "";
  return `${date}_${title}${upPart}${suffix}.${ext}`;
}

function formatYmdForFilename(input) {
  let date;
  if (input) {
    const parsed = new Date(typeof input === "number"
      ? (input > 1e12 ? input : input * 1000)
      : String(input).replace(/\s/g, "T"));
    if (!isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling for the content tabs.
 * When user selects text in 字幕/概览/总结, shows a pill with two
 * actions: 💡 Explain and 💬 Ask AI.
 */

// Tabs where the selection pill may appear. Notes are the user's own
// writing (not video content), so they are deliberately excluded.
const PILL_TAB_PANELS = new Set(["transcript", "overview", "summary"]);

// The pill's buttons, kept as a template string so flashPillStatus can
// restore them verbatim after it borrows the container to show a save result.
const PILL_BUTTONS_HTML = `
  <button class="explain-btn" data-pill-action="explain">💡 Explain</button>
  <button class="explain-btn" data-pill-action="ask">💬 Ask AI</button>
  <button class="explain-btn explain-btn--icon" data-pill-action="note"
    title="添加到笔记" aria-label="添加到笔记">📝</button>
`;

// Pending flashPillStatus restore. Null when the pill shows its real buttons.
let pillFlashTimer = null;

/**
 * Returns the data-panel tab name when the selection lives inside a
 * pill-eligible panel (transcript/overview/summary), else null.
 * anchorNode can be a text node or an element — normalize to the
 * element first, then look for the enclosing .tab-panel.
 */
function selectionPillTab(selection) {
  const node = selection && selection.anchorNode;
  if (!node) return null;
  // 3 = Node.TEXT_NODE (literal keeps this testable without a DOM)
  const el = node.nodeType === 3 ? node.parentElement : node;
  const panel = el && el.closest ? el.closest(".tab-panel") : null;
  if (!panel) return null;
  const tab =
    (panel.dataset && panel.dataset.panel) ||
    (panel.getAttribute && panel.getAttribute("data-panel"));
  return PILL_TAB_PANELS.has(tab) ? tab : null;
}

function setupExplainFeature() {
  // The container is about to be replaced, so drop any pending flash restore —
  // it would otherwise fire against this new element and hide the fresh pill.
  cancelPillFlash();

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the selection pill: Explain opens the explanation modal,
  // Ask AI opens the bottom chat drawer, 📝 saves the selection as a note.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = PILL_BUTTONS_HTML;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  // Timestamp of the transcript row the selection starts in (null when the
  // selection came from 概览/总结). Captured alongside selectedText because the
  // live Selection is gone by the time the click handler runs.
  let selectedSeconds = null;

  // Interacting with the pill must NOT interfere with the browser's
  // built-in selection handling — the previous mousedown preventDefault
  // and mouseup stopPropagation blocked the user from being able to
  // right-click → Copy the selected text (the system context-menu would
  // open but the clipboard payload came out empty). The tooltip is now
  // also placed ABOVE the selection (see below), so it never covers the
  // text the user might want to copy. selectedText is captured into the
  // closure on mouseup, so the click handler can use it even if the
  // click itself ends up clearing the live Selection.
  tooltip.addEventListener("click", (event) => {
    const btn = event.target.closest
      ? event.target.closest("button[data-pill-action]")
      : null;
    if (!btn) return;
    event.stopPropagation();
    if (!selectedText) return;
    const captured = selectedText;
    const capturedSeconds = selectedSeconds;
    const action = btn.dataset.pillAction;
    // Remember where the pill sat: it hides itself on click, and the note
    // pill needs somewhere to flash its ✓/failure back to.
    const anchor = { top: tooltip.style.top, left: tooltip.style.left };
    tooltip.style.display = "none";
    if (action === "ask") {
      openAskAiDrawer(captured);
    } else if (action === "note") {
      saveSelectionAsNote(captured, capturedSeconds, anchor);
    } else {
      showExplanation(captured);
    }
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Show the pill for selections inside 字幕/概览/总结 (not notes,
    // not the rest of the panel chrome).
    const pillTab = text.length > 0 ? selectionPillTab(selection) : null;

    if (pillTab) {
      selectedText = text;
      selectedSeconds = selectionStartSeconds(selection);

      // Position the tooltip ABOVE the selection by default so it never
      // covers the selected text — this keeps right-click → Copy working
      // on the text underneath. Fall back to below when there isn't
      // enough room above (e.g. first row of the list, or scrolled near
      // the top of the panel).
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const tipHeight = tooltip.offsetHeight || 36;
      const spaceAbove = rect.top;
      const placeAbove = spaceAbove >= tipHeight + 12;
      const top = placeAbove
        ? rect.top + window.scrollY - tipHeight - 8
        : rect.bottom + window.scrollY + 8;

      // A save-status flash may still be holding the container; end it first
      // so the pill comes back with its buttons, not the ✓/error message.
      cancelPillFlash();

      tooltip.style.display = "flex";
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });
}

// ============================================================
// SELECTION → NOTE
// ============================================================

/**
 * Resolves the transcript timestamp a selection starts at.
 *
 * Transcript rows carry `data-seconds` (see renderTranscriptModeRows), so a
 * selection inside 字幕 anchors to its own row. A selection made in 概览/总结
 * has no row of its own — fall back to the row the player is currently
 * speaking (the active-playback highlight), which is the closest honest
 * answer. Returns null when neither exists (e.g. no transcript at all), which
 * makes the background save the note without a timestamp.
 */
function selectionStartSeconds(selection) {
  const range =
    selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const node = range ? range.startContainer : null;
  const el = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
  const row = el && el.closest
    ? el.closest(".transcript-entry[data-seconds]")
    : null;
  if (row) {
    const seconds = Number(row.dataset.seconds);
    if (Number.isFinite(seconds)) return seconds;
  }
  const active = document.querySelector(
    ".transcript-entry.active-playback[data-seconds]",
  );
  if (active) {
    const seconds = Number(active.dataset.seconds);
    if (Number.isFinite(seconds)) return seconds;
  }
  return null;
}

/**
 * Saves the selected text as a note. The pill hides itself on click, so both
 * the pending state and the outcome are flashed back in its place — otherwise
 * the save would be silent and the user would have to open the 笔记 tab to
 * learn whether it worked.
 */
async function saveSelectionAsNote(selectedText, seconds, anchor) {
  // Acknowledge the click immediately. The background round-trip includes
  // getSettings() — which probes the browser's download directory — plus a
  // best-effort mirror to the notes KB; against a stopped whisper server
  // that measured >1s, which reads as "the pill just vanished". holdMs is a
  // safety net only: the real result replaces it well before then.
  flashPillStatus("保存中…", anchor, 8000);

  let ok = false;
  if (!currentVideoId) {
    flashPillStatus("缺少视频信息", anchor);
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveSelectionNote",
      videoId: currentVideoId,
      videoTitle: currentVideoTitle || "",
      channelName: currentChannelName || "",
      text: selectedText,
      seconds: seconds,
    });
    ok = !!(result && result.success);
    if (!ok) {
      console.error(
        "[dk-bililearn] Save selection as note failed:",
        result && result.error,
      );
    }
  } catch (error) {
    console.error("[dk-bililearn] Save selection as note error:", error);
  }
  flashPillStatus(ok ? "✓ 已保存至笔记" : "保存失败", anchor);
  if (ok) loadNotes(currentVideoId);
}

/**
 * Shows a status message in place of the pill's buttons, then restores them —
 * the next selection must find the real buttons back, not an empty bar.
 *
 * @param {string} message
 * @param {{top: string, left: string}|null} anchor - the pill's last position
 * @param {number} holdMs - how long the message stays before reverting.
 */
function flashPillStatus(message, anchor, holdMs = 1400) {
  const tooltip = document.getElementById("explainTooltip");
  if (!tooltip) return;
  cancelPillFlash();
  tooltip.innerHTML = `<span class="explain-pill-status">${escapeHtml(message)}</span>`;
  if (anchor && anchor.top) tooltip.style.top = anchor.top;
  if (anchor && anchor.left) tooltip.style.left = anchor.left;
  tooltip.style.display = "flex";
  pillFlashTimer = setTimeout(() => {
    pillFlashTimer = null;
    const current = document.getElementById("explainTooltip");
    if (!current) return;
    current.innerHTML = PILL_BUTTONS_HTML;
    current.style.display = "none";
  }, holdMs);
}

/**
 * Ends a save-status flash early. Called before the pill is re-shown for a new
 * selection: without this, a selection made during the flash would find the
 * status span instead of buttons, and the pending restore would then hide the
 * pill the user had just opened.
 */
function cancelPillFlash() {
  if (pillFlashTimer) {
    clearTimeout(pillFlashTimer);
    pillFlashTimer = null;
  }
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip && tooltip.querySelector(".explain-pill-status")) {
    tooltip.innerHTML = PILL_BUTTONS_HTML;
  }
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// ASK AI DRAWER
// ============================================================
// Bottom drawer (~1/3 of the panel height) opened from the
// selection pill's "Ask AI" action. Multi-turn chat; each question
// is routed through the background's two-stage handler which
// decides whether the current video's context gets attached. The
// per-video conversation state guards itself by videoId, so the
// video-switch reset path needs no explicit hook.

let askAiState = null; // { videoId, messages: [{role, content}], selection }
let askAiBusy = false;
// 缓存当前 KB 选项 (open 填一次) 与缓存结果: askAiKbs = [{ name, dir, build_method, archived }]
let askAiKbs = [];
// Ask-AI 用临时覆盖 (不写 storage)。键名 = select 的 value "providerId|modelName"
let askAiSelectedModelKey = "";

// 列出所有「有对应 key」的 provider+model 选项。key 优先级:
//   minimax > deepseek > glm > other (settings.aiBaseUrl 兜底)
function listAskAiModelOptions(settings) {
  const opts = [];
  const presets = YTD_SETTINGS.PROVIDER_PRESETS || {};
  if (settings && typeof settings.minimaxApiKey === "string" && settings.minimaxApiKey.trim()) {
    opts.push({ key: "minimax|" + presets.minimax.model, label: "minimax · " + presets.minimax.model });
  }
  if (settings && typeof settings.deepseekApiKey === "string" && settings.deepseekApiKey.trim()) {
    opts.push({ key: "deepseek|" + presets.deepseek.model, label: "DeepSeek · " + presets.deepseek.model });
  }
  if (settings && typeof settings.glmApiKey === "string" && settings.glmApiKey.trim()) {
    const glmModel = settings.aiModel && presets.glm && settings.aiModel === presets.glm.model
      ? settings.aiModel
      : (presets.glm && presets.glm.model);
    opts.push({ key: "glm|" + glmModel, label: "GLM · " + glmModel });
  }
  // 其他任何已设的 aiBaseUrl+aiModel (other/custom) — 只在主 provider 都没 key 时显示, 避免歧义
  if (opts.length === 0 && settings && settings.aiBaseUrl && settings.aiModel) {
    opts.push({ key: "other|" + settings.aiModel, label: "Custom · " + settings.aiModel });
  }
  return opts;
}

function getActiveAskAiModelKey(settings) {
  // 默认选择: 用户 settings.provider 那个 (若它有 key)
  const opts = listAskAiModelOptions(settings);
  if (!opts.length) return "";
  // 用户手动切换过的优先
  if (askAiSelectedModelKey && opts.some((o) => o.key === askAiSelectedModelKey)) {
    return askAiSelectedModelKey;
  }
  // 退回 settings.provider
  const provider = settings && settings.provider;
  const presets = YTD_SETTINGS.PROVIDER_PRESETS || {};
  if (provider && presets[provider] && opts.some((o) => o.key.startsWith(provider + "|"))) {
    return opts.find((o) => o.key.startsWith(provider + "|")).key;
  }
  return opts[0].key;
}

async function populateAskAiModels(drawer) {
  const sel = drawer.querySelector("#askAiModelSelect");
  if (!sel) return;
  const settings = await kbGetSettings();
  // askAiGetSettings 路径已 ensure whisperUrl 等副作用, 这里直接复用同源 helper
  const raw = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const fullSettings = YTD_SETTINGS.normalize(raw[YTD_SETTINGS.STORAGE_KEY] || {});
  const opts = listAskAiModelOptions(fullSettings);
  sel.innerHTML = "";
  if (!opts.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "未配置任何模型 key";
    sel.appendChild(o);
    sel.disabled = true;
    askAiSelectedModelKey = "";
    return;
  }
  sel.disabled = false;
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.key; opt.textContent = o.label;
    sel.appendChild(opt);
  }
  const active = getActiveAskAiModelKey(fullSettings);
  sel.value = active;
  askAiSelectedModelKey = active;
  sel.onchange = () => { askAiSelectedModelKey = sel.value; };
}

async function populateAskAiKbSelect(drawer) {
  const sel = drawer.querySelector("#askAiKbSelect");
  if (!sel) return;
  const raw = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const fullSettings = YTD_SETTINGS.normalize(raw[YTD_SETTINGS.STORAGE_KEY] || {});
  const kbRoot = (fullSettings.kbRootDir || "").trim().replace(/[\\/]+$/, "");
  // KB 启用的开关未开时不填 (避免用户在 KB 关闭状态下选 KB 上下文)
  const kbEnabled = fullSettings.kbEnabled !== false;

  sel.innerHTML = "";
  askAiKbs = [];
  if (!kbEnabled || !kbRoot) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = kbEnabled ? "无关联 KB" : "KB 管理未启用";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  let kbs = [];
  try { kbs = await KbClient.list(kbRoot); }
  catch (e) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "whisper server 不在线";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  askAiKbs = kbs.filter((k) => !k.archived);
  // 可选的 KB: 非 raw (raw 上下文太大, 跳过)
  const selectable = askAiKbs.filter((k) => k.build_method && k.build_method !== "raw");
  // 默认 = 当前视频所属的 KB:
  //   1) channel 匹配 KB 名 → 选中
  //   2) 否则 = 当前 videoId 已经在的 KB (kb.videos 列表里有当前 bvid+page)
  const channel = (currentChannelName || "").trim();
  let autoKbName = "";
  if (channel && selectable.some((k) => k.name === channel)) {
    autoKbName = channel;
  } else {
    try {
      const videos = await KbClient.videos(kbRoot, "__probe__").catch(() => []);
      const curVid = String(currentVideoId || "").split("@p")[0];
      const curPage = Number((String(currentVideoId || "").match(/@p(\d+)/) || [])[1]) || 1;
      // 探测完一个 KB 再换下一个
      for (const kb of selectable) {
        try {
          const vs = await KbClient.videos(kbRoot, kb.name);
          if (vs.some((v) => v.bvid === curVid && Number(v.page || 1) === curPage)) {
            autoKbName = kb.name; break;
          }
        } catch {}
      }
    } catch {}
  }
  // 渲染选项: 默认加一个"无关联 KB"
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = "无关联 KB";
  sel.appendChild(placeholder);
  for (const kb of selectable) {
    const opt = document.createElement("option");
    opt.value = kb.name;
    opt.textContent = `${kb.name} · ${kb.build_method}${kb.name === autoKbName ? "  ·  自动选择" : ""}`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.value = autoKbName || "";
}

function getAskAiProviderOverride(settings) {
  // 从 askAiSelectedModelKey 解析 provider/model, 临时返回一段 settings 兼容字段
  const key = askAiSelectedModelKey || getActiveAskAiModelKey(settings);
  if (!key) return null;
  const pipe = key.indexOf("|");
  if (pipe < 0) return null;
  const provider = key.slice(0, pipe);
  const model = key.slice(pipe + 1);
  const presets = YTD_SETTINGS.PROVIDER_PRESETS || {};
  let baseUrl = "";
  let apiKey = "";
  if (provider === "minimax") {
    baseUrl = (presets.minimax && presets.minimax.baseUrl) || settings.aiBaseUrl || "";
    apiKey = settings.minimaxApiKey || "";
  } else if (provider === "deepseek") {
    baseUrl = (presets.deepseek && presets.deepseek.baseUrl) || settings.aiBaseUrl || "";
    apiKey = settings.deepseekApiKey || "";
  } else if (provider === "glm") {
    // GLM endpoint 取决于 glmApiType (settings 已 normalize), 用预设 + 验证 baseUrl
    baseUrl = YTD_SETTINGS.resolveGlmBaseUrl
      ? YTD_SETTINGS.resolveGlmBaseUrl(settings.glmApiType)
      : ((presets.glm && presets.glm.baseUrl) || settings.aiBaseUrl || "");
    apiKey = settings.glmApiKey || "";
  } else if (provider === "other") {
    baseUrl = settings.aiBaseUrl || "";
    apiKey = YTD_SETTINGS.activeApiKey(settings) || "";
  } else {
    return null;
  }
  if (!baseUrl || !apiKey || !model) return null;
  return { provider, baseUrl, model, apiKey };
}

function ensureAskAiDrawer() {
  let drawer = document.getElementById("askAiDrawer");
  if (drawer) return drawer;

  drawer = document.createElement("div");
  drawer.id = "askAiDrawer";
  drawer.className = "ask-ai-drawer";
  drawer.innerHTML = `
    <div class="ask-ai-resize-grip" title="拖动以调节高度" aria-label="拖动调节 Ask AI 抽屉高度"></div>
    <div class="ask-ai-header">
      <div class="ask-ai-title">💬 Ask AI</div>
      <select id="askAiModelSelect" class="ask-ai-model-select" title="选择模型"></select>
      <button class="ask-ai-close" id="askAiClose" title="关闭 (Esc)">✕</button>
    </div>
    <div class="ask-ai-selection" id="askAiSelection"></div>
    <div class="ask-ai-messages" id="askAiMessages"></div>
    <div class="ask-ai-input-row">
      <div class="ask-ai-kb-row">
        <select id="askAiKbSelect" class="ask-ai-kb-select" title="选择 KB 上下文"></select>
      </div>
      <div class="ask-ai-prompt-row">
        <textarea id="askAiInput" class="ask-ai-input" rows="1"
          placeholder="Ask anything… (Enter 发送 · Shift+Enter 换行)"></textarea>
        <button id="askAiSend" class="ask-ai-send">➤</button>
      </div>
    </div>
  `;
  document.body.appendChild(drawer);

  drawer.querySelector("#askAiClose").addEventListener("click", closeAskAiDrawer);
  drawer.querySelector("#askAiSend").addEventListener("click", sendAskAiMessage);
  const input = drawer.querySelector("#askAiInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAskAiMessage();
    }
  });

  // 2026-10-11: 顶部 grip 拖拽改高度。NS-cursor 视觉提示,
  // pointer 事件 + setPointerCapture 让鼠标就算拖出 grip 也持续生效。
  wireAskAiResizeGrip(drawer);

  // Esc closes the drawer no matter where the focus currently sits.
  document.addEventListener("keydown", (e) => {
    const openDrawer = document.getElementById("askAiDrawer");
    if (e.key === "Escape" && openDrawer && openDrawer.classList.contains("open")) {
      closeAskAiDrawer();
    }
  });

  return drawer;
}

// 2026-10-11: 顶部 grip → 拖动改 drawer 高度. 边界由 CSS 的 min/max-height
// 兜底; 这里用 CSS 变量喂值 (而不是直接 style.height) 以免覆盖 CSS 限制。
// 高度持久化在 chrome.storage.local[ytd_askai_drawer_height] 里, 下次开抽屉恢复。
function wireAskAiResizeGrip(drawer) {
  const grip = drawer.querySelector(".ask-ai-resize-grip");
  if (!grip || grip.dataset.bound === "1") return;
  grip.dataset.bound = "1";
  // 恢复上次保存的高度 (异步, 不阻塞首屏)
  try {
    chrome.storage.local.get("ytd_askai_drawer_height", (r) => {
      const h = r && r.ytd_askai_drawer_height;
      if (typeof h === "string" && /^\d+(\.\d+)?px$/.test(h)) {
        drawer.style.setProperty("--ask-ai-h", h);
      }
    });
  } catch {}

  let dragging = false;
  let startY = 0;
  let startH = 0;
  const minPx = 180; // 与 .ask-ai-drawer { min-height } 同步
  const maxVH = 0.8; // 与 .ask-ai-drawer { max-height } 同步

  const clamp = (h) => Math.max(minPx, Math.min(window.innerHeight * maxVH, h));

  grip.addEventListener("pointerdown", (e) => {
    if (!drawer.classList.contains("open")) return; // 关闭状态下不响应
    dragging = true;
    startY = e.clientY;
    startH = drawer.getBoundingClientRect().height;
    try { grip.setPointerCapture(e.pointerId); } catch {}
    grip.classList.add("is-dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    // drawer 在屏幕底部, 拖手柄向上 = 高度增大 → startY - clientY
    const dy = startY - e.clientY;
    const next = clamp(startH + dy);
    drawer.style.setProperty("--ask-ai-h", next + "px");
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove("is-dragging");
    try { if (e && e.pointerId != null) grip.releasePointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    // 持久化 (只在变化后保存一次, 不抖动)
    try {
      const h = drawer.style.getPropertyValue("--ask-ai-h").trim();
      if (h) chrome.storage.local.set({ ytd_askai_drawer_height: h });
    } catch {}
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);

  // 窗口缩放 / DPI 变化时, 已保存的高度若超过新 viewport 的 max, 自动夹住
  window.addEventListener("resize", () => {
    const cur = drawer.style.getPropertyValue("--ask-ai-h").trim();
    if (!cur) return;
    const px = parseFloat(cur);
    if (!Number.isFinite(px)) return;
    const clamped = clamp(px);
    if (clamped !== px) {
      drawer.style.setProperty("--ask-ai-h", clamped + "px");
      try { chrome.storage.local.set({ ytd_askai_drawer_height: clamped + "px" }); } catch {}
    }
  });
}

function openAskAiDrawer(selection) {
  const drawer = ensureAskAiDrawer();

  // New video → fresh conversation (guarded by videoId so no hook is
  // needed in the video-reset path).
  if (!askAiState || askAiState.videoId !== currentVideoId) {
    askAiState = { videoId: currentVideoId, messages: [], selection: "" };
  }
  if (selection) askAiState.selection = String(selection).trim();

  const selBar = drawer.querySelector("#askAiSelection");
  if (askAiState.selection) {
    selBar.textContent = `“${askAiState.selection.substring(0, 200)}${
      askAiState.selection.length > 200 ? "…" : ""
    }”`;
    selBar.style.display = "block";
  } else {
    selBar.style.display = "none";
  }

  populateAskAiModels(drawer);
  populateAskAiKbSelect(drawer);

  renderAskAiMessages(drawer);
  drawer.classList.add("open");
  drawer.querySelector("#askAiInput").focus();
}

function closeAskAiDrawer() {
  const drawer = document.getElementById("askAiDrawer");
  if (drawer) drawer.classList.remove("open");
}

async function sendAskAiMessage() {
  const drawer = document.getElementById("askAiDrawer");
  if (!drawer || askAiBusy || !askAiState) return;
  const input = drawer.querySelector("#askAiInput");
  const question = input.value.trim();
  if (!question) return;

  askAiBusy = true;
  input.value = "";
  askAiState.messages.push({ role: "user", content: question });
  renderAskAiMessages(drawer, true); // true → append the pending bubble

  // 拉取 settings 用于 provider override (同时决定是否传 KB 上下文)
  const raw = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const settings = YTD_SETTINGS.normalize(raw[YTD_SETTINGS.STORAGE_KEY] || {});
  const providerOverride = getAskAiProviderOverride(settings);
  const kbSelect = drawer.querySelector("#askAiKbSelect");
  const kbName = kbSelect ? kbSelect.value : "";
  const selectedKb = kbName ? askAiKbs.find((k) => k.name === kbName) : null;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "askAiChat",
      question,
      history: askAiState.messages.slice(0, -1), // turns before this question
      selection: askAiState.selection || "",
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      summary: currentSummary || "",
      transcript: currentTranscriptText || "",
      providerOverride, // null 表示用 settings.provider 默认
      kbContext: selectedKb ? { name: selectedKb.name, dir: selectedKb.dir, build_method: selectedKb.build_method } : null,
    });

    if (result && result.success) {
      askAiState.messages.push({ role: "assistant", content: result.answer });
    } else {
      const errMsg =
        (result && (result.message || result.error)) || "unknown error";
      askAiState.messages.push({
        role: "assistant",
        content: `⚠️ 请求失败：${errMsg}`,
      });
    }
  } catch (error) {
    askAiState.messages.push({
      role: "assistant",
      content: `⚠️ 请求失败：${error.message}`,
    });
  } finally {
    askAiBusy = false;
    renderAskAiMessages(drawer);
  }
}

// 2026-10-10: assistant 回复下方两个 icon —— 拷贝、添加到笔记。
// 用 SVG 而非 emoji, 与侧栏其它自绘控件 (note-cleanup / kb 一类) 风格一致;
// 颜色继承 currentColor 让暗色主题下也能自适应。
function askAiCopyIconSvg() {
  return (
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  );
}
function askAiNoteIconSvg() {
  return (
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    ' aria-hidden="true"><path d="M4 4h10l4 4v12a2 2 0 0 1-2 2H4z"/>' +
    '<path d="M14 4v4h4"/><line x1="8" y1="13" x2="14" y2="13"/>' +
    '<line x1="8" y1="17" x2="14" y2="17"/></svg>'
  );
}
function askAiBubbleActionBar() {
  return (
    '<div class="ask-ai-bubble-actions">' +
      '<button type="button" class="ask-ai-act ask-ai-copy" title="拷贝回复" aria-label="拷贝回复">' +
        askAiCopyIconSvg() +
      '</button>' +
      '<button type="button" class="ask-ai-act ask-ai-save-note" title="添加到笔记" aria-label="添加到笔记">' +
        askAiNoteIconSvg() +
      '</button>' +
    '</div>'
  );
}

// 点击 ack：在按钮里临时显示 ✓/✗，1.2s 后恢复 SVG。disabled 防双击。
function ackAskAiAct(btn, ok) {
  if (!btn) return;
  const original = btn.innerHTML;
  btn.innerHTML = ok ? "✓" : "✗";
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, 1200);
}

async function handleAskAiCopy(btn, text) {
  try {
    if (!text) {
      ackAskAiAct(btn, false);
      return;
    }
    await navigator.clipboard.writeText(text);
    ackAskAiAct(btn, true);
  } catch (e) {
    console.error("[ask-ai] clipboard copy failed:", e);
    ackAskAiAct(btn, false);
  }
}

async function handleAskAiSaveNote(btn, text) {
  try {
    if (!text) {
      ackAskAiAct(btn, false);
      return;
    }
    const r = await chrome.runtime.sendMessage({
      action: "saveAskAiNote",
      text,
      videoId: typeof currentVideoId === "string" ? currentVideoId : "",
      videoTitle: (typeof currentVideoTitle === "string" && currentVideoTitle) || "Ask AI 答复",
      channelName: (typeof currentChannelName === "string" && currentChannelName) || "bililearn-user",
    });
    ackAskAiAct(btn, !!(r && r.success));
  } catch (e) {
    console.error("[ask-ai] save to notes failed:", e);
    ackAskAiAct(btn, false);
  }
}

// 把 assistant bubble 下面的两个 icon 绑定到对应 message (data-msg-idx 索引)
// 与 click handler; user bubble / pending bubble 不挂 icon。
function wireAskAiBubbleActions(list, messages) {
  if (!list || !Array.isArray(messages)) return;
  const bubbles = list.querySelectorAll(
    ".ask-ai-bubble.assistant:not(.ask-ai-pending)",
  );
  bubbles.forEach((bubble) => {
    const idx = Number(bubble.dataset.msgIdx);
    const msg = Number.isInteger(idx) ? messages[idx] : null;
    if (!msg || msg.role !== "assistant") return;
    const copyBtn = bubble.querySelector(".ask-ai-copy");
    const saveBtn = bubble.querySelector(".ask-ai-save-note");
    if (copyBtn && !copyBtn.dataset.bound) {
      copyBtn.dataset.bound = "1";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAskAiCopy(copyBtn, msg.content);
      });
    }
    if (saveBtn && !saveBtn.dataset.bound) {
      saveBtn.dataset.bound = "1";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAskAiSaveNote(saveBtn, msg.content);
      });
    }
  });
}

function renderAskAiMessages(drawer, pending = false) {
  const list = drawer.querySelector("#askAiMessages");
  if (!list) return;
  const messages = (askAiState && askAiState.messages) || [];
  if (messages.length === 0 && !pending) {
    list.innerHTML = `<div class="ask-ai-empty">关于这个视频随便问 —— 会自动判断是否需要带上视频上下文。</div>`;
    return;
  }
  let html = messages
    .map((m, i) =>
      m.role === "assistant"
        ? `<div class="ask-ai-bubble assistant" data-msg-idx="${i}">${renderMarkdown(m.content)}${askAiBubbleActionBar()}</div>`
        : `<div class="ask-ai-bubble user" data-msg-idx="${i}">${escapeHtml(m.content)}</div>`,
    )
    .join("");
  if (pending) {
    html += `<div class="ask-ai-bubble assistant ask-ai-pending"><span class="loading-bar"></span></div>`;
  }
  list.innerHTML = html;
  wireAskAiBubbleActions(list, messages);
  list.scrollTop = list.scrollHeight;
}

// ============================================================
// CACHING
// ============================================================

/**
 * 2026-09-12 cross-video race fix: parks an LLM result (analysis/summary)
 * into the cache entry of the video that STARTED the call, after the user
 * has already switched to a different video. Reads that video's existing
 * entry from storage (never the in-memory globals — they belong to the
 * CURRENT video now), patches in the result, writes it back. Best-effort:
 * a missing/evicted entry just drops the result; it must never be written
 * into another video's slot.
 */
async function mergeLlmResultToCache(videoId, patch) {
  if (!videoId || !patch) return;
  try {
    const entry = await loadFromCache(videoId);
    if (!entry) {
      debugLog("[dk-bililearn Panel] mergeLlmResultToCache: no cache entry for", videoId, "— dropping result");
      return;
    }
    Object.assign(entry, patch, { timestamp: Date.now() });
    await chrome.storage.local.set({ [`${CACHE_KEY_PREFIX}${videoId}`]: entry });
    debugLog("Parked LLM result into cache for", videoId, Object.keys(patch).join(","));
  } catch (error) {
    console.error("[dk-bililearn Panel] mergeLlmResultToCache error:", error);
  }
}

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  // Guard against caching an unusable transcript (empty array is truthy,
  // so the old `!currentTranscript` check let empty/legacy-shaped
  // segments through and poisoned every future open of this video).
  const usableTranscript =
    Array.isArray(currentTranscript) &&
    currentTranscript.some(
      (seg) => seg && typeof seg.text === "string" && seg.text.trim().length > 0,
    );
  if (!videoId || !usableTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      schemaVersion: BILILEARN_CACHE_SCHEMA_VERSION,
      videoId,
      analysis: currentAnalysis, // May be null if not yet analyzed
      summary: currentSummary, // May be null if not yet summarized
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptSource: currentTranscriptSource,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`${CACHE_KEY_PREFIX}${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let bililearnKeys = Object.keys(allData).filter(
      (k) => k.startsWith(CACHE_KEY_PREFIX) || k.startsWith(LEGACY_CACHE_KEY_PREFIX),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = bililearnKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      bililearnKeys = bililearnKeys.filter((key) => !expiredSet.has(key));
    }

    if (bililearnKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = bililearnKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[dk-bililearn] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const cacheKey = `${CACHE_KEY_PREFIX}${videoId}`;
    const legacyKey = `${LEGACY_CACHE_KEY_PREFIX}${videoId}`;
    const result = await chrome.storage.local.get([cacheKey, legacyKey]);
    let cached = result[cacheKey] || result[legacyKey];

    if (!cached) return null;

    // Migrate a pre-rename entry so future reads hit the new key directly.
    if (!result[cacheKey] && result[legacyKey]) {
      try {
        await chrome.storage.local.set({ [cacheKey]: cached });
        await chrome.storage.local.remove(legacyKey);
      } catch (_e) {
        // Best-effort migration; the legacy entry still works without it.
      }
    }

    // Poisoned/legacy cache guard (2026-08-22): entries saved before the
    // background normalizeSegment fix store transcript segments in the raw
    // {from, to, content} shape. They render as an empty transcript list
    // AND short-circuit every future fetch (this function returning non-null
    // skips the network entirely), so a video hit by the old bug never
    // self-heals — the panel keeps "recognizing" the subtitle but shows
    // nothing. Treat "no segment carries usable text" as a cache miss so
    // the next open refetches and overwrites with a good entry.
    if (
      !Array.isArray(cached.transcript) ||
      !cached.transcript.some(
        (seg) =>
          seg && typeof seg.text === "string" && seg.text.trim().length > 0,
      )
    ) {
      debugLog("Rejecting poisoned/legacy cache entry for", videoId);
      return null;
    }

    // (2026-10-02) Removed the legacy wantsAsr guard that used to sit
    // here. It checked the long-dead asrApiKey field (DashScope era —
    // the asrProvider enum no longer even has a dashscope option) and
    // DELETED the video's cache entry on EVERY load when the key was
    // merely present in storage. With a leftover key, summaries and
    // analyses saved minutes earlier vanished the moment the user
    // switched away and returned, and the panel started a fresh LLM
    // run each time. A leftover key must never invalidate the cache:
    // nothing reads it at runtime (asrProvider === "none" default).
    // Same for its partner-in-crime mergeLlmResultToCache: with the
    // guard gone, a finished summary parked after a mid-call video
    // switch finds its entry and persists again.

    // Earlier Bilibili builds parsed "@p2" with Number("p2"), silently
    // fetching P1 and caching that transcript under another part. Never reuse
    // those records after the part-routing fix.
    if (
      cached.schemaVersion !== BILILEARN_CACHE_SCHEMA_VERSION ||
      cached.videoId !== videoId
    ) {
      await removeVideoCache(videoId);
      return null;
    }

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await removeVideoCache(videoId);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[dk-bililearn Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item" + (note.isFullNote ? " note-item--full" : "");
    const isFullNote = !!note.isFullNote;
    noteEl.innerHTML = `
      <div class="note-header">
        ${isFullNote
          ? `<span class="note-badge-full">📄 整篇笔记</span>`
          : `<span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>`}
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      ${isFullNote
        ? `<div class="note-text note-text-full">${renderMarkdown(note.text)}</div>`
        : `<div class="note-text">"${escapeHtml(note.text)}"</div>`}
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        ${isFullNote ? "" : `<button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>`}
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    const tsEl = noteEl.querySelector(".note-timestamp");
    if (tsEl) {
      tsEl.addEventListener("click", () => {
        playNote(note);
      });
    }

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped Bilibili link
    const copyLinkBtn = noteEl.querySelector(".note-copy-link");
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          copyLinkBtn.textContent = "✓ Copied!";
          setTimeout(() => {
            copyLinkBtn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });
    }

    // Play button (in this tab if it's the current video, else a new tab)
    const playBtn = noteEl.querySelector(".note-play");
    if (playBtn) {
      playBtn.addEventListener("click", () => {
        playNote(note);
      });
    }

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[dk-bililearn Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * Bilibili tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — Bilibili tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function originalTranscriptIsChinese() {
  return /^(zh|zh-|ai-zh|cn)/i.test(String(currentTranscriptLanguage || ""));
}

function updateTranscriptLanguageModes() {
  const chineseSource = originalTranscriptIsChinese();
  document
    .querySelectorAll('[data-transcript-mode="zh"], [data-transcript-mode="bilingual"]')
    .forEach((button) => {
      button.hidden = chineseSource;
    });
  const originalButton = document.querySelector('[data-transcript-mode="original"]');
  if (originalButton) {
    originalButton.textContent = chineseSource ? "中文字幕" : getOriginalTranscriptLabel();
  }
  if (chineseSource && currentTranscriptMode !== "original") {
    currentTranscriptMode = "original";
    setTranscriptModeButtons("original");
  }
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (originalTranscriptIsChinese() && mode !== "original") return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
};

// ============================================================
// KB management (2026-10-03 spec
// docs/superpowers/specs/2026-10-03-bililearn-kb-management-design.md)
// ============================================================
let kbSettingsCache = null;

async function kbGetSettings() {
  const result = await chrome.storage.local.get("ytd_settings");
  const raw = result && result.ytd_settings ? result.ytd_settings : {};
  const normalized = (typeof YTD_SETTINGS !== "undefined" && YTD_SETTINGS.normalize)
    ? YTD_SETTINGS.normalize(raw) : raw;
  if (normalized && normalized.whisperUrl) KbClient.setBaseUrl(normalized.whisperUrl);
  return normalized;
}

async function kbSaveSettingsPatch(patch) {
  const cur = await kbGetSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ ytd_settings: next });
  kbSettingsCache = next;
  return next;
}

function kbToast(msg, isError) {
  const btn = document.getElementById("addToKbBtn");
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = isError ? `⚠ ${msg}` : `✓ ${msg}`;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2400);
}

async function refreshKbButton() {
  const btn = document.getElementById("addToKbBtn");
  if (!btn) return;
  kbSettingsCache = await kbGetSettings();
  const disabled = kbSettingsCache.kbEnabled === false; // 用户显式关才隐藏
  btn.style.display = disabled ? "none" : "";
  if (disabled) return;
  const hasRoot = !!kbSettingsCache.kbRootDir;
  if (!hasRoot) { btn.disabled = true; btn.title = "请先在「设置 → KB 管理」里启用并选 KB 主目录"; return; }
  const health = await KbClient.health();
  btn.disabled = !health;
  btn.title = health ? "添加到KB" : "需要本地 whisper server（127.0.0.1:7860）";
}

async function toggleKbDropdown() {
  const dd = document.getElementById("kbDropdown");
  if (dd.style.display !== "none") { dd.style.display = "none"; return; }
  const settings = await kbGetSettings();
  let kbs;
  try { kbs = await KbClient.list(settings.kbRootDir); }
  catch (e) { kbToast("KB server 不在线", true); return; }
  dd.innerHTML = "";
  for (const kb of kbs.filter((k) => !k.archived)) {
    const b = document.createElement("button");
    b.className = "kb-item";
    b.innerHTML = `${escapeHtml(kb.name)}<span class="kb-badge">${escapeHtml(kb.build_method || "未配置")}</span>`;
    b.addEventListener("click", () => { dd.style.display = "none"; addCurrentVideoToKb(kb.name); });
    dd.appendChild(b);
  }
  const sep = document.createElement("div"); sep.className = "kb-sep"; dd.appendChild(sep);
  const create = document.createElement("button");
  create.className = "kb-item";
  create.textContent = "＋ 新建 KB…";
  create.addEventListener("click", () => { dd.style.display = "none"; openKbNewDialog(); });
  dd.appendChild(create);
  const btn = document.getElementById("addToKbBtn");
  const rect = btn.getBoundingClientRect();
  dd.style.left = `${rect.left}px`; dd.style.top = `${rect.bottom + 6}px`;
  dd.style.display = "";
}

function openKbNewDialog() {
  document.getElementById("kbNewName").value = currentChannelName || "新KB";
  document.getElementById("kbNewSpeaker").value = currentChannelName || "";
  document.getElementById("kbNewMethod").value = "raw";
  document.getElementById("kbNewDialog").style.display = "";
}

async function saveNewKbAndAdd() {
  const settings = await kbGetSettings();
  const name = KbShared.sanitizeKbName(document.getElementById("kbNewName").value);
  const method = document.getElementById("kbNewMethod").value;
  const speaker = document.getElementById("kbNewSpeaker").value.trim();
  if (!name) { kbToast("KB 名不能为空", true); return; }
  try { await KbClient.create(settings.kbRootDir, name, method, speaker); }
  catch (e) {
    kbToast(String(e.message).includes("exists") ? "同名 KB 已存在" : "创建失败: " + e.message, true);
    return;
  }
  document.getElementById("kbNewDialog").style.display = "none";
  await addCurrentVideoToKb(name);
}

async function addCurrentVideoToKb(kbName) {
  if (!currentVideoId) { kbToast("当前无视频", true); return; }
  const settings = await kbGetSettings();
  const kbDir = `${settings.kbRootDir}\\${kbName}`;
  const { id, page, platform } = KbShared.parseVideoId(currentVideoId);

  // kb.json（无则现场补建——扫描发现的外来子目录首次添加走这里）
  let buildMethod = null, defaultSpeaker = "";
  try {
    const cfg = JSON.parse((await KbClient.read(settings.kbRootDir, `${kbDir}\\kb.json`)).content);
    buildMethod = cfg.build_method || null;
    defaultSpeaker = cfg.default_speaker || "";
  } catch {}
  if (!buildMethod) {
    const pick = window.prompt("该目录还没有 kb.json。选择构建方法：karpathy / nvwa / raw", "raw");
    if (!pick || !["karpathy", "nvwa", "raw"].includes(pick.trim())) { kbToast("已取消", true); return; }
    buildMethod = pick.trim();
    await KbClient.write(settings.kbRootDir, `${kbDir}\\kb.json`, JSON.stringify({
      name: kbName, build_method: buildMethod, default_speaker: "",
      created_at: new Date().toISOString(), archived: false, version: 1,
    }, null, 2));
  }

  // 查重（bvid+page）
  let existing = null;
  try {
    const vids = await KbClient.videos(settings.kbRootDir, kbName);
    existing = vids.find((v) => v.bvid === id && Number(v.page || 1) === page) || null;
  } catch {}
  if (existing) { kbToast(`已在 KB 中（${existing.date || "?"} 版本）`, false); return; }

  // 组装并写入
  const fallbackToday = new Date().toISOString().slice(0, 10);
  const meta = {
    speaker: defaultSpeaker || currentChannelName || "未知",
    author: currentChannelName || "",
    platform, bvid: id, page,
    date: currentPubDate || fallbackToday,
    dateSource: currentPubDate ? "pubdate" : "fallback_today",
    addedAt: new Date().toISOString(),
    lang: currentTranscriptLanguage || "",
    topic: currentVideoTitle || "untitled",
    url: currentCanonicalVideoUrl(),
    durationS: Math.round(currentVideoDuration || 0),
  };
  const fileName = KbShared.videoFileName(meta.topic, meta.date, page);
  const segments = Array.isArray(currentTranscript) ? currentTranscript : [];
  const doc = KbShared.buildKbDocument(meta, segments);
  try {
    await KbClient.write(settings.kbRootDir, `${kbDir}\\videos\\${fileName}`, doc);
  } catch (e) { kbToast("写入失败: " + e.message, true); return; }

  // 入队（raw 不入队）+ 记住上次 KB
  if (buildMethod !== "raw") {
    const task = {
      kb_name: kbName, video_file: fileName,
      meta: { bvid: meta.bvid, page, date: meta.date, topic: meta.topic, speaker: meta.speaker },
      enqueued_at: new Date().toISOString(), attempts: 0,
    };
    await KbClient.write(settings.kbRootDir,
      `${kbDir}\\queue\\pending\\${Date.now()}_${meta.bvid}@p${page}.json`, JSON.stringify(task, null, 2));
    chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {});
    kbToast(`已加入《${kbName}》，更新中`);
  } else {
    kbToast(`已加入《${kbName}》`);
  }
  await kbSaveSettingsPatch({ lastKbName: kbName });
}

// 绑定（DOM ready 后挂事件）
document.getElementById("addToKbBtn")?.addEventListener("click", async (e) => {
  if (e.offsetX > e.currentTarget.clientWidth - 24) { toggleKbDropdown(); return; } // 右侧箭头区
  const settings = await kbGetSettings();
  if (settings.lastKbName) { addCurrentVideoToKb(settings.lastKbName); }
  else { toggleKbDropdown(); }
});
document.getElementById("kbNewCancel")?.addEventListener("click", () => {
  document.getElementById("kbNewDialog").style.display = "none";
});
document.getElementById("kbNewSave")?.addEventListener("click", saveNewKbAndAdd);
document.addEventListener("click", (e) => {
  const dd = document.getElementById("kbDropdown");
  if (dd && dd.style.display !== "none" && !dd.contains(e.target) && e.target?.id !== "addToKbBtn") {
    dd.style.display = "none";
  }
});
refreshKbButton();
