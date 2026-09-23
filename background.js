/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching Bilibili transcripts via Supadata API
 * 3. Calling minimax to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = true;
const formatTimestamp = (seconds) => {
  const secs = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(secs / 60);
  const rem = Math.floor(secs % 60);
  return `${mins}:${String(rem).padStart(2, "0")}`;
};
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
// Streaming responses reset the idle watchdog on every chunk, so the hard
// cap now only bounds genuinely runaway requests. Long summaries (8192
// output tokens) legitimately take 1-3 minutes to stream.
const AI_PROVIDER_HARD_TIMEOUT_MS = 600_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Module-level flag: tracks whether we've already warned once about
// "Receiving end does not exist" for relay messages. The sidepanel's
// playback tracker fires getCurrentTime every second, so without this
// gate the console would get spammed with one error per tick. Resetting
// the SW (e.g. via "Reload" in chrome://extensions) clears the flag.
let relayNoReceiverWarned = false;

// Prevent the Bilibili content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
//
// 2026-09-13 fix: chrome.storage.local.setAccessLevel is Chrome 136+ only
// (added 2025-05-20). On older Chromium builds (including the 125 install
// some users have on a second device) the method is undefined and the call
// throws a TypeError at SW startup, which kills the entire service worker
// before it can register listeners — manifesting as "Service worker
// registration failed. Status code: 15" AND "clicking the extension icon
// does nothing" (the latter because setPanelBehavior is never reached).
// Capability-detect before calling; on older builds we log a single warn
// and fall back to documented mitigations (no in-page reads; API keys
// live behind the trusted context boundary regardless).
if (typeof chrome.storage.local.setAccessLevel === "function") {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) =>
      console.warn(
        "[dk-bililearn] Could not restrict storage access:",
        error,
      ),
    );
} else {
  console.warn(
    "[dk-bililearn] chrome.storage.local.setAccessLevel unavailable on this Chrome build (<136). Trusted-context isolation skipped; B 站 content script sees the same storage view as before. Update Chrome for full protection.",
  );
}

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const normalized = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
  // 2026-09-16 (Irene directive): if the user has not set an explicit
  // subtitlesDir, transparently fill in an absolute default rooted at
  // the browser's configured Downloads directory. The previous default
  // was the relative path "BiliSubs" — whisper_server is a separate
  // Python process and resolved that against its own CWD, which almost
  // never matched the user's Downloads folder, so cache lookups silently
  // missed on a fresh install. By resolving once on first load (and
  // caching the result in chrome.storage.local under the
  // non-settings key "downloadsRootCache") we ship an absolute path the
  // Python server can actually use, without baking any build-machine
  // layout into the extension.
  if (!normalized.subtitlesDir) {
    const root = await resolveDownloadsRoot();
    if (root) {
      normalized.subtitlesDir = joinPath(root, "BiliSubs");
    }
  }
  return normalized;
}

// Lightweight path join that normalises to forward slashes (whisper_server
// uses os.path.join internally on either separator; this keeps the
// value uniform on the JS side).
function joinPath(...parts) {
  return parts.filter((p) => typeof p === "string" && p.length).join("/").replace(/[\\/]+/g, "/");
}

// Resolve the browser's configured Downloads root in three steps:
//
//   1. chrome.storage.local cache (key "downloadsRootCache"). The user
//      may have cleared history since the last resolve, so we still fall
//      through if the cached path no longer exists in the download
//      history — but using the cache keeps the common case cheap.
//
//   2. chrome.downloads.search() over recent history. The filename
//      field on completed downloads is an ABSOLUTE path; dirname gives
//      us the Downloads folder Chrome actually uses (which is whatever
//      the user set under chrome://settings/downloads). On a brand-new
//      profile with zero history this is empty.
//
//   3. Trigger a probe download of a 0-byte data URL into a hidden
//      filename. Chrome resolves it against the same Downloads root
//      and reports the absolute path via DownloadItem.filename. We
//      then remove the probe and return dirname.
//
// Returns null when the downloads API is unavailable (older Chrome,
// enterprise policy that disables downloads, etc.) — the consumer
// treats null as "no default; the user must set one explicitly".
let downloadsRootPromise = null; // memoised within a single tick
async function resolveDownloadsRoot() {
  if (!chrome.downloads || !chrome.downloads.search) return null;

  // Step 1: cache.
  try {
    const cached = await chrome.storage.local.get("downloadsRootCache");
    if (cached && typeof cached.downloadsRootCache === "string" && cached.downloadsRootCache) {
      return cached.downloadsRootCache;
    }
  } catch (_e) { /* storage may be denied; fall through */ }

  // Step 2: historical download with an absolute path.
  try {
    const items = await chrome.downloads.search({ limit: 20, orderBy: ["-startTime"] });
    for (const item of items) {
      if (!item || typeof item.filename !== "string") continue;
      // Windows: C:\Users\me\Downloads\<name>; POSIX: /Users/me/Downloads/<name>
      const m = item.filename.match(/^(.*[\/\\])(?:[^\\/]+)$/);
      if (m && m[1]) {
        const root = m[1].replace(/[\\/]+$/, "");
        chrome.storage.local.set({ downloadsRootCache: root }).catch(() => {});
        return root;
      }
    }
  } catch (_e) { /* fall through to probe */ }

  // Step 3: probe download (0-byte data URL, then remove it).
  if (typeof chrome.downloads.download === "function") {
    try {
      const probeId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: "data:text/plain;base64,",
            filename: ".bililearn-probe",
            conflictAction: "overwrite",
            saveAs: false,
          },
          (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          },
        );
      });
      // Wait briefly for the filename to be populated. onChanged fires
      // when the path is determined; we give it up to 5 seconds.
      const probePath = await new Promise((resolve) => {
        let resolved = null;
        const cleanup = () => {
          try { chrome.downloads.onChanged.removeListener(listener); } catch (_e) {}
          clearTimeout(timer);
          resolve(resolved);
        };
        const listener = (delta) => {
          if (delta.id !== probeId) return;
          if (delta.filename && delta.filename.current) {
            resolved = delta.filename.current;
            cleanup();
          }
        };
        chrome.downloads.onChanged.addListener(listener);
        // Fallback: query directly after a short delay in case the
        // listener misses the event on a slow first paint.
        const timer = setTimeout(async () => {
          if (resolved) return cleanup();
          try {
            const [item] = await chrome.downloads.search({ id: probeId });
            if (item && item.filename) resolved = item.filename;
          } catch (_e) { /* ignore */ }
          cleanup();
        }, 1500);
      });
      // Remove the probe — the user never sees a real file.
      try { chrome.downloads.removeFile(probeId, () => {}); } catch (_e) {}
      try { chrome.downloads.erase({ id: probeId }, () => {}); } catch (_e) {}
      if (probePath) {
        const m = probePath.match(/^(.*[\/\\])(?:[^\\/]+)$/);
        if (m && m[1]) {
          const root = m[1].replace(/[\\/]+$/, "");
          chrome.storage.local.set({ downloadsRootCache: root }).catch(() => {});
          return root;
        }
      }
    } catch (_e) { /* give up; return null below */ }
  }

  return null;
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  // indexOf("\n## ") also matches inside "\r\n## ", so it works for both LF and CRLF.
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  // Support both LF and CRLF line endings (Windows checkout via git autocrlf).
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  const activeKey = YTD_SETTINGS.activeApiKey(settings);
  if (!activeKey) {
    const error = new Error(
      "AI provider API key not configured. Open bililearn Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }

  // Debug logging for GLM troubleshooting
  if (settings.provider === "glm") {
    console.log("[dk-bililearn] GLM config:", {
      apiType: settings.glmApiType,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      keyPrefix: activeKey ? activeKey.substring(0, 8) + "..." : "empty",
    });
  }

  const body = {
    model: settings.aiModel,
    messages,
    // Streaming keeps the connection visibly alive while the model works:
    // every SSE delta resets the idle watchdog. Non-streaming requests send
    // no bytes until the whole completion is generated, so long videos on
    // thinking models (glm-4.6 reasons first) sat silent past the 50-second
    // no-bytes abort and were killed while still healthy (user report
    // 2026-08-30: "inactive for 50 seconds" on every long-video summary).
    stream: true,
  };
  // MiniMax uses `max_completion_tokens` and the `thinking` toggle to
  // suppress reasoning traces. OpenAI-compatible providers (DeepSeek,
  // GLM, etc.) use the standard `max_tokens` field. Sending the wrong
  // one is silently ignored on GLM (so we don't get a hard 400) but
  // wastes a field and may break on stricter providers.
  const isMinimax = settings.provider === "minimax";
  if (isMinimax) {
    body.max_completion_tokens = maxTokens;
    body.thinking = { type: "disabled" };
  } else {
    body.max_tokens = maxTokens;
  }
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${YTD_SETTINGS.activeApiKey(settings)}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the provider is still making progress. Some
    // providers (including minimax) may then send blank-line body chunks
    // while a non-streaming request queues.
    resetIdleTimeout();

    // Streaming (SSE) response: consume delta chunks as they arrive. Every
    // chunk resets the idle watchdog, so slow-but-healthy generations (long
    // videos, thinking models) never trip the no-bytes abort. Non-SSE
    // responses — provider error bodies (401/402/...), providers that
    // ignore `stream`, or test shims — fall through to the bounded JSON
    // read below and keep the existing error surfacing.
    const responseContentType =
      response.headers?.get?.("content-type") || "";
    if (response.ok && responseContentType.includes("text/event-stream")) {
      const streamedText = await readStreamedAiCompletion(
        response,
        resetIdleTimeout,
      );
      if (typeof streamedText !== "string" || !streamedText.trim()) {
        const error = new Error("AI provider returned an empty response.");
        error.code = "EMPTY_AI_RESPONSE";
        throw error;
      }
      return { text: streamedText, settings };
    }

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `AI provider error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "AI provider request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "AI provider request exceeded the 600-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including minimax's blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// Reads an OpenAI-compatible SSE stream (chat.completions chunk deltas) and
// returns the assembled assistant text. Every received chunk calls onActivity
// (resetting the idle watchdog), including GLM's `reasoning_content` deltas —
// thinking-model silence is exactly what used to trip the 50-second abort.
// Reasoning text counts as activity but is NOT part of the final answer.
// Byte-capped like the JSON path so a runaway stream cannot balloon memory.
async function readStreamedAiCompletion(response, onActivity) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let responseBytes = 0;
  let buffer = "";
  let text = "";
  const consumeLine = (line) => {
    if (!line || line.startsWith(":")) return; // SSE comments / keep-alives
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const chunk = JSON.parse(payload);
      const piece = chunk.choices?.[0]?.delta?.content;
      if (typeof piece === "string") text += piece;
    } catch {
      // A malformed/partial event — the next chunk completes it; skip.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    const byteLength = value?.byteLength ?? 0;
    responseBytes += byteLength;
    if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel?.().catch(() => {});
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer.replace(/\r$/, ""));
  return text;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 *
 * 2026-09-13 hardening (fresh-device report: "clicking the icon does
 * nothing"): the whole setup is guarded so a missing/partial
 * chrome.sidePanel (exotic Chromium builds, enterprise policy) can never
 * throw at service-worker startup and take every later registration
 * (onMessage relay, whisper jobs, notifications) down with it. Note the
 * panel itself cannot display on restricted pages — chrome:// pages, the
 * Web Store — so clicking the icon there legitimately opens nothing;
 * test on a normal http(s) page.
 */
try {
  // 2026-09-21 (Irene directive, new-device repro): chrome.action.onClicked
  // can be undefined on some Chromium builds (notably the user's other
  // machine where Chrome had set up the action button differently or the
  // API surface was reduced). Without optional chaining the SW
  // startup crashes here and Chrome shows the generic "could not load
  // extension" status — exactly the symptom reported after the most
  // recent commit.
  chrome.action?.onClicked?.addListener((tab) => {
    try {
      // Re-enable + open without awaiting — preserves user gesture context
      chrome.sidePanel?.setOptions({
        tabId: tab.id,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel?.open({ tabId: tab.id });
    } catch (clickError) {
      debugLog("[dk-bililearn] sidePanel click open failed:", clickError);
    }
  });

  /**
   * Allow the side panel to open on any page, but it's designed for Bilibili.
   */
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })?.catch?.(
    (behaviorError) =>
      debugLog("[dk-bililearn] setPanelBehavior rejected:", behaviorError),
  );
} catch (setupError) {
  debugLog("[dk-bililearn] side panel API unavailable:", setupError);
}

chrome.runtime?.onInstalled?.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Service worker bootstrap: rehydrate the in-memory whisper job from
 * chrome.storage.session and resume any job that was still running when
 * Chrome killed the previous worker. The user closes/reopens the
 * sidepanel constantly during multi-minute Whisper runs, so we MUST
 * survive a SW eviction.
 */
async function bootstrapWhisperJob() {
  let job = null;
  try {
    job = await loadWhisperJob();
  } catch {
    // storage.session may throw if the API isn't available; not fatal.
    return;
  }
  if (!job) {
    activeWhisperJob = null;
    return;
  }
  activeWhisperJob = job;
  const terminal = job.stage === WHISPER_STAGES.SUCCEEDED || job.stage === WHISPER_STAGES.FAILED;
  if (terminal) {
    // Don't re-run; let the sidepanel clear it via ackWhisperJobDone.
    debugLog("[dk-bililearn BG] resuming in terminal state:", job.stage);
    return;
  }
  // If we crashed mid-stage, just keep the in-memory record so the
  // sidepanel can render the right loading text. Re-running the whole
  // job from scratch would burn another 5+ minutes; the next user
  // action (closing/reopening panel) will trigger a manual retry.
  debugLog(
    "[dk-bililearn BG] rehydrated in-flight whisper job at stage:",
    job.stage,
    "for",
    job.videoId,
  );
}

bootstrapWhisperJob().catch((err) =>
  console.warn("[dk-bililearn BG] bootstrapWhisperJob failed:", err),
);

// Re-bootstrap on every cold start of the SW (e.g. after browser restart).
// chrome.runtime.onStartup is the right hook for that, but onInstalled +
// first message also covers the common "user reopens sidepanel" case.
chrome.runtime.onStartup?.addListener(() => {
  bootstrapWhisperJob().catch(() => {});
});

/**
 * Keep the side panel scoped to Bilibili tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make dk-bililearn behave like a Bilibili-only tool, we
 * enable the panel on Bilibili tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-Bilibili tab.
 */
function updatePanelForTab(tabId, url) {
  const isBilibili = /^https:\/\/www\.bilibili\.com\/video\//.test(url || "");
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: isBilibili })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs?.onActivated?.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId, message.videoUrl, message.pageNumber)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "triggerWhisperTranscription") {
    handleTriggerWhisperTranscription(
      message.videoId,
      message.videoUrl,
      message.pageNumber,
      message.videoTitle || "",
    )
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          success: false,
          error: err.message,
          // 把分类后的错误信息一起传给 sidepanel，UI 那边根据 type
          // 切换标题。message 字段仍然是兜底文案，老逻辑不挂。
          bilibiliError: err.bilibiliError || null,
        }),
      );
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps.
    // videoId/videoUrl ride along so a slow-run completion notification
    // (notifyAnalysisDoneIfSlow) can click through to the video.
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
      { videoId: message.videoId, videoUrl: message.videoUrl },
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "summaryTranscript") {
    // Convert the full transcript into a complete structured note.
    // videoId/videoUrl ride along so a slow-run completion notification
    // (notifySummaryDoneIfSlow) can click through to the video.
    handleSummarizeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      { videoId: message.videoId, videoUrl: message.videoUrl },
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using minimax.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveSummaryNote") {
    // Save the full summary note as a single note entry.
    handleSaveSummaryNote(
      message.videoId,
      message.videoTitle,
      message.channelName,
      message.summaryText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to minimax.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: true,
          hasAiKey: !!YTD_SETTINGS.activeApiKey(settings),
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "getWhisperJobStatus") {
    // The sidepanel asks "am I mid-transcription?" on open. We return
    // the current in-memory + storage job so it can restore the right
    // loading screen instead of showing the no-cache error.
    loadWhisperJob()
      .then((job) => sendResponse({ job: job || activeWhisperJob || null }))
      .catch((err) => sendResponse({ job: null, error: err.message }));
    return true;
  }

  if (message.action === "ackWhisperJobDone") {
    // The sidepanel has consumed a terminal SUCCEEDED state. Drop the
    // record so the next visit doesn't think we're still running.
    setWhisperJob(null).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getWhisperQueue") {
    // The sidepanel's queue panel pulls current state on open / tab switch.
    (async () => {
      try {
        const queue = await loadWhisperQueue();
        sendResponse({ queue, job: summarizeWhisperJob(activeWhisperJob) });
      } catch (err) {
        sendResponse({ queue: [], job: null, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "removeWhisperQueueEntry") {
    // Drop one queued entry (the queue panel's ✕ button). Never touches
    // the running job — only waiting entries can be removed.
    (async () => {
      try {
        const queue = await loadWhisperQueue();
        const rest = queue.filter(
          (e) =>
            !(
              e.videoId === message.videoId &&
              Number(e.pageNumber || 1) === Number(message.pageNumber || 1)
            ),
        );
        await saveWhisperQueue(rest);
        sendResponse({ success: true, removed: queue.length - rest.length });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "openOptions") {
    // Side-panel wizards pass an anchor (e.g. "aiProviderCard") so the
    // options page opens scrolled to the right section. openOptionsPage()
    // cannot carry a URL fragment, so manage the tab here: reuse an
    // existing options tab (hash-only navigation keeps unsaved form
    // state) or open a new focused tab. The synchronous sendResponse
    // below still acks the side panel immediately.
    const anchor =
      typeof message.anchor === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]*$/.test(message.anchor)
        ? message.anchor
        : "";
    const optionsUrl =
      chrome.runtime.getURL("options.html") +
      (anchor ? "#" + anchor : "");
    chrome.tabs.query(
      { url: chrome.runtime.getURL("options.html") + "*" },
      (tabs) => {
        const existing = Array.isArray(tabs) && tabs[0];
        if (existing) {
          chrome.tabs.update(
            existing.id,
            { active: true, url: optionsUrl },
            () => {
              if (existing.windowId != null) {
                try {
                  chrome.windows.update(
                    existing.windowId,
                    { focused: true },
                    () => void chrome.runtime.lastError,
                  );
                } catch (e) {
                  // focusing the owner window is best-effort
                }
              }
            },
          );
        } else {
          chrome.tabs.create({ url: optionsUrl, active: true });
        }
      },
    );
    sendResponse({ success: true });
    return false;
  }

  // 2026-09-13 (Irene directive): per-dependency action buttons on the
  // options page. Each one does ONE thing the user explicitly asked for.
  //  - openExternalUrl: open a download page (e.g. VC++ redist, Python
  //    installer) in a new tab. The user runs the installer themselves
  //    (these need UAC, which a service worker cannot trigger).
  //  - pipInstall: download a self-extracting .bat that pip-installs
  //    exactly the named package(s), then auto-open it so the user just
  //    clicks "Run" in the Windows confirmation. The same shape as
  //    installDepsBtn (options.js) but scoped to a single package.
  //  - copyBatPath: copy the local start_whisper_server.bat absolute path
  //    to the clipboard + show a modal telling the user where to paste
  //    (the path is in a real file location the user already installed).
  if (message.action === "openExternalUrl") {
    const url =
      message.payload && typeof message.payload.url === "string"
        ? message.payload.url.trim()
        : "";
    if (!/^https?:\/\//i.test(url)) {
      sendResponse({ success: false, error: "refused non-http(s) url" });
      return false;
    }
    chrome.tabs.create({ url }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true });
      }
    });
    return true;
  }

  if (message.action === "pipInstall") {
    const pkgs = Array.isArray(message.payload && message.payload.packages)
      ? message.payload.packages.filter((p) => typeof p === "string" && p.trim())
      : [];
    if (pkgs.length === 0) {
      sendResponse({ success: false, error: "no packages specified" });
      return false;
    }
    // Build a one-liner .bat that:
    //  1) finds python (where python > miniconda3 > python.org std paths)
    //  2) prints which interpreter it's about to use
    //  3) pip install --user <packages> (--user avoids system-pip locks
    //     without needing elevation)
    //  4) verifies the import and reports OK or the specific error
    // Source is plain text and reviewed in the Windows prompt before run.
    const pkgList = pkgs.map((p) => `"${p.replace(/"/g, "")}"`).join(" ");
    const batSource = [
      "@echo off",
      "setlocal",
      "REM bililearn one-shot pip install: " + pkgs.join(" "),
      "REM Generated " + new Date().toISOString() + " — review before running.",
      "REM Installs into the FIRST python.exe it can find (PATH > miniconda > python.org).",
      "echo === bililearn pip install ===",
      "echo Will install: " + pkgs.join(" "),
      "echo.",
      "set \"PYTHON_EXE=\"",
      "for /f \"delims=\" %%i in ('where python 2^>nul') do (",
      "  if not defined PYTHON_EXE set \"PYTHON_EXE=%%i\"",
      ")",
      "if not defined PYTHON_EXE (",
      "  for %%P in (",
      "    \"%USERPROFILE%\\miniconda3\\python.exe\"",
      "    \"%USERPROFILE%\\anaconda3\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python313\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python311\\python.exe\"",
      "    \"%LOCALAPPDATA%\\Programs\\Python\\Python310\\python.exe\"",
      "  ) do (",
      "    if not defined PYTHON_EXE if exist %%~P set \"PYTHON_EXE=%%~P\"",
      "  )",
      ")",
      "if not defined PYTHON_EXE (",
      "  echo [ERROR] No Python 3.10+ found. Install from https://www.python.org/downloads/ first.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo Using Python: %PYTHON_EXE%",
      "echo.",
      "echo Running: \"%PYTHON_EXE%\" -m pip install --user " + pkgList,
      "echo (--user avoids the system-pip lock so no elevation prompt)",
      "echo Source: PyPI (the official Python Package Index, files.pythonhosted.org).",
      "echo.",
      "\"%PYTHON_EXE%\" -m pip install --user " + pkgList,
      "if errorlevel 1 (",
      "  echo.",
      "  echo [ERROR] pip install failed. Network blocked? Try:",
      "  echo   \"https://mirrors.aliyun.com/pypi/simple/\" via -i flag.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo.",
      "echo Verifying import...",
      "\"%PYTHON_EXE%\" -c \"import " +
        pkgs
          .map((p) => p.replace(/-/g, "_").replace(/zhconv/, "zhconv"))
          .join(", ") +
        "; print('OK: " + pkgs.join(", ") + " ready')\"",
      "if errorlevel 1 (",
      "  echo [ERROR] Import failed after install. See traceback above.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo.",
      "echo === Done. Relaunch start_whisper_server.bat to pick up the new package. ===",
      "pause",
    ].join("\r\n");
    const safeName =
      "bililearn_install_" + pkgs.join("-").replace(/[^a-z0-9_-]/gi, "") + ".bat";
    if (chrome.downloads && typeof chrome.downloads.download === "function") {
      const dataUrl =
        "data:application/octet-stream;base64," +
        btoa(unescape(encodeURIComponent(batSource)));
      chrome.downloads.download(
        { url: dataUrl, filename: safeName, saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            sendResponse({
              success: false,
              error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "download failed",
            });
            return;
          }
          // Auto-open so the user only has to click "Run" in the Windows
          // confirmation. Same pattern as installDepsBtn in options.js.
          try {
            const listener = (delta) => {
              if (delta && delta.id === downloadId && delta.state) {
                if (delta.state.current === "complete") {
                  try {
                    chrome.downloads.open(downloadId);
                  } catch (_e) {}
                  try {
                    chrome.downloads.onChanged.removeListener(listener);
                  } catch (_e) {}
                } else if (delta.state.current === "interrupted") {
                  try {
                    chrome.downloads.onChanged.removeListener(listener);
                  } catch (_e) {}
                }
              }
            };
            chrome.downloads.onChanged.addListener(listener);
          } catch (_e) {}
          sendResponse({ success: true, downloadId });
        },
      );
      return true;
    }
    sendResponse({ success: false, error: "chrome.downloads API unavailable" });
    return false;
  }

  if (message.action === "copyBatPath") {
    // Resolve start_whisper_server.bat from the extension's own install
    // location (chrome.runtime.getURL points at our manifest, so the
    // bat lives next to it). Falls back to undefined when the file is
    // missing (e.g. user deleted it).
    let batPath = "";
    try {
      const url = chrome.runtime.getURL("start_whisper_server.bat");
      if (url.startsWith("file://")) {
        batPath = decodeURI(url.slice("file://".length));
        // Windows file:///C:/... → C:\...
        batPath = batPath.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
      }
    } catch (_e) {}
    (async () => {
      try {
        if (batPath && chrome.tabs && typeof chrome.tabs.create === "function") {
          // Pop a modal in the options page that names the absolute
          // path of the bat and offers a "copy path" + "open folder"
          // button. 2026-09-16: the previous copy just said "double-
          // click it in the extension folder" — the user (Irene)
          // couldn't find the bat because the modal didn't actually
          // exist (options.js had no handler for ?batModal=1); the
          // user saw a no-op options tab. The new options.html modal
          // is wired up to the same query string.
          await chrome.tabs.create({
            url: chrome.runtime.getURL(
              "options.html?batModal=1&batPath=" + encodeURIComponent(batPath),
            ),
          });
          // Also copy the path straight to the clipboard so the user
          // can paste it into File Explorer's address bar immediately,
          // without having to click the modal button.
          try {
            await (navigator.clipboard && navigator.clipboard.writeText
              ? navigator.clipboard.writeText(batPath)
              : Promise.resolve());
          } catch (_e) { /* clipboard denied — modal still works */ }
          sendResponse({ success: true, batPath });
        } else {
          sendResponse({
            success: false,
            error: "bat path not found in extension folder",
          });
        }
      } catch (e) {
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }

  // 2026-09-16 (Irene directive): open the folder containing
  // start_whisper_server.bat in the OS file manager. MV3 has no
  // native shell API; the most reliable cross-platform route is
  // chrome.downloads.show() on a sentinel download pointing at the
  // folder — Chrome pops up "show in folder" for the file. We also
  // best-effort use chrome.tabs.create with a file:// URL on Windows
  // (Chrome will open it in Explorer).
  if (message.action === "openBatFolder") {
    const batPath =
      message.payload && typeof message.payload.batPath === "string"
        ? message.payload.batPath.trim()
        : "";
    (async () => {
      try {
        if (!batPath) throw new Error("missing batPath");
        // Compute parent folder. Windows "C:\a\b\c.bat" → "C:\a\b";
        // POSIX "/a/b/c.bat" → "/a/b".
        const sep = batPath.includes("\\") ? "\\" : "/";
        const lastSep = batPath.lastIndexOf(sep);
        const folder = lastSep > 0 ? batPath.slice(0, lastSep) : batPath;
        // Try a no-op download pointing at the folder — downloads.show()
        // does NOT work with a folder URL, so this branch is a no-op on
        // most platforms. Kept as documentation; the real route below
        // is file:// open which Chromium honours on Windows.
        const fileUrl =
          "file:///" + folder.replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1");
        if (chrome.tabs && typeof chrome.tabs.create === "function") {
          await chrome.tabs.create({ url: fileUrl });
          sendResponse({ success: true });
          return;
        }
        throw new Error("tabs.create unavailable");
      } catch (e) {
        sendResponse({ success: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[dk-bililearn BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start bililearn (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startBililearnFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[dk-bililearn BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[dk-bililearn BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[dk-bililearn BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for Bilibili tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[dk-bililearn BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no Bilibili tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("bilibili.com/video/")) {
          tabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
            active: true,
          });
          debugLog("[dk-bililearn BG] Active Bilibili tabs:", tabs.length);
        }

        // Still nothing? Try any Bilibili tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
          debugLog("[dk-bililearn BG] Any Bilibili tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[dk-bililearn BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER Bilibili's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          // Bilibili metadata is read from the rendered page by content.js.

          debugLog("[dk-bililearn BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[dk-bililearn BG] No Bilibili tab found");
          sendResponse({ success: false, error: "No Bilibili tab found" });
        }
      } catch (err) {
        // "Receiving end does not exist" is the normal state when the
        // content script hasn't been injected yet (page just loaded,
        // tab is a non-Bilibili frame, extension was reloaded mid-session,
        // etc.). It is NOT actionable — the sidepanel's playback tracker
        // calls this every second, so logging at error level flooded
        // the console. Log once per service-worker lifetime at warn
        // level, then demote further occurrences to debug.
        const message = err?.message || String(err);
        const isExpectedNoReceiver =
          /Receiving end does not exist/i.test(message) ||
          /Could not establish connection/i.test(message);
        if (isExpectedNoReceiver) {
          if (!relayNoReceiverWarned) {
            relayNoReceiverWarned = true;
            console.warn(
              "[dk-bililearn BG] Relay: content script not present. " +
                "Further occurrences will be silent — this is normal " +
                "for tabs where the script hasn't injected yet.",
            );
          } else {
            debugLog("[dk-bililearn BG] Relay (silent):", message);
          }
        } else {
          console.error("[dk-bililearn BG] Relay error:", message);
        }
        sendResponse({ success: false, error: message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

// ============================================================
// TRANSCRIPT FETCHING VIA BILIBILI API
// ============================================================
// WHISPER JOB STATE (persisted across sidepanel / SW restarts)
// ============================================================
// When the user kicks off local Whisper, the audio download + ASR + AI
// correction can take minutes. The sidepanel can be closed/reopened
// during that window and the service worker can be evicted at any time.
// We persist the current job in chrome.storage.session so:
//   - background.js can resume the job after a SW restart
//   - the sidepanel can re-show the correct loading screen on reopen
const WHISPER_JOB_KEY = "whisper-job";
const WHISPER_STAGES = Object.freeze({
  STARTED: "started",
  DOWNLOADING: "downloading",
  READY_TO_TRANSCRIBE: "ready_to_transcribe",
  TRANSCRIBING: "transcribing",
  CORRECTING: "correcting",
  // terminal states
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});

// Keepalive/watchdog alarm. MV3 service workers are evicted after ~30s
// idle and an in-flight fetch does NOT reliably keep one alive — observed
// live: user starts Whisper, switches to another page (the sidepanel is
// force-closed per-tab), all message traffic stops, Chrome kills the SW,
// and the /transcribe POST dies with it. A repeating alarm both resets
// the idle timer while the pipeline is alive AND wakes the SW after an
// eviction so the watchdog below can recover the job from the server-
// side cache. periodInMinutes 0.5 is the Chrome 120+ floor; older
// builds clamp to 1min, which only slows recovery, never breaks it.
const WHISPER_KEEPALIVE_ALARM = "bililearn-whisper-keepalive";

// Transcribe queue (2026-08-29): whisper stays strictly single-job (parallel
// int8 CPU inference starves both pipelines — see the re-entry guard in
// handleTriggerWhisperTranscription). Instead of REFUSING a trigger for a
// different video while one runs, we enqueue it and auto-start the next
// entry when the current job reaches a terminal state. Entries live in
// storage.session: survives SW evictions, dies with the browser session —
// queued work is not worth a durable disk write.
const WHISPER_QUEUE_KEY = "whisperQueue";
const WHISPER_QUEUE_MAX = 10;

function ensureWhisperKeepalive() {
  try {
    // 2026-09-12: clear the old "bililearn-whisper-keepalive" name (if it
    // exists from a prior install) so the renamed keepalive below is the
    // only one Chrome sees. Without this, the user would carry an
    // orphan alarm that fires every 30 s and never gets handled (the
    // listener now matches the new name only).
    chrome.alarms.clear("bililearn-whisper-keepalive");
    chrome.alarms.create(WHISPER_KEEPALIVE_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5,
    });
  } catch (e) {
    debugLog("[dk-bililearn BG] keepalive alarm create failed:", e);
  }
}

function clearWhisperKeepalive() {
  try {
    chrome.alarms.clear(WHISPER_KEEPALIVE_ALARM);
  } catch (e) {
    // alarms API unavailable — nothing to clear.
  }
}

// True while this SW incarnation is executing the whisper pipeline
// (view fetch → audio download → /transcribe → correction → cache write).
let whisperPipelineActive = false;

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm?.name !== WHISPER_KEEPALIVE_ALARM) return;
  whisperWatchdogTick().catch((e) =>
    debugLog("[dk-bililearn BG] whisper watchdog tick failed:", e),
  );
});

/**
 * Runs every 30s while a whisper job exists. Two jobs in one:
 *  1. Keepalive — the alarm firing resets the SW idle timer, so a live
 *     pipeline survives page switches / closed sidepanels.
 *  2. Recovery — if the SW was evicted mid-job (pipeline flag false but
 *     the persisted job is non-terminal), poll the whisper server's own
 *     cache: the server finishes inference and writes the transcript
 *     server-side even when the client POST died, so the result is
 *     usually already there. Mark SUCCEEDED when found; keep waiting
 *     until the 30-minute cap, then FAIL.
 */
async function whisperWatchdogTick() {
  let job = null;
  try {
    job = await loadWhisperJob();
  } catch {
    return;
  }
  if (!job || !job.videoId) {
    clearWhisperKeepalive();
    // Queue (2026-08-29): slot is free — if the SW died between a terminal
    // write and the pump, queued entries are still waiting.
    pumpWhisperQueue().catch((e) =>
      debugLog("[dk-bililearn BG] watchdog queue pump failed:", e),
    );
    return;
  }
  const terminal =
    job.stage === WHISPER_STAGES.SUCCEEDED ||
    job.stage === WHISPER_STAGES.FAILED;
  if (terminal) {
    // Leave terminal records alone — the sidepanel acks them on view.
    clearWhisperKeepalive();
    pumpWhisperQueue().catch((e) =>
      debugLog("[dk-bililearn BG] watchdog terminal queue pump failed:", e),
    );
    return;
  }
  if (whisperPipelineActive) {
    // Pipeline alive in THIS worker; the alarm just kept us warm.
    return;
  }
  await recoverOrphanedWhisperJob(job);
}

async function recoverOrphanedWhisperJob(job) {
  const startedAt = Number(job.startedAt) || 0;
  const ageMs = startedAt ? Date.now() - startedAt : 0;
  if (ageMs > 30 * 60 * 1000) {
    await setWhisperJob({
      ...job,
      type: "whisper-job",
      stage: WHISPER_STAGES.FAILED,
      title: "Whisper 转录失败",
      subtitle:
        "后台任务中断且超过 30 分钟未能恢复。请重新点击转录（已完成的转写不受影响）。",
      stageStartedAt: Date.now(),
      finishedAt: Date.now(),
      error: "whisper watchdog: stale non-terminal job",
    });
    clearWhisperKeepalive();
    // Fire-and-ack：watchdog 判死也广播给开着的面板，别让它永远转圈。
    sendWhisperProgress(
      WHISPER_STAGES.FAILED,
      "Whisper 转录失败",
      "后台任务中断且超过 30 分钟未能恢复。请重新点击转录（已完成的转写不受影响）。",
    );
    return;
  }
  // Poll the server-side cache for the finished result.
  const meta = job.recoveryMeta || {};
  const settings = await getSettings();
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url || !meta.bvid || !meta.cid) {
    // No recovery info (pre-fix job record) — nothing we can do but wait
    // for the age cap above.
    return;
  }
  try {
    const qs = new URLSearchParams({
      bvid: meta.bvid,
      cid: String(meta.cid),
      title: meta.title || "",
      channel: meta.channel || "",
      pub_date: meta.pubDate || "",
      cache_dir: meta.cacheDir || settings.subtitlesDir || "",
    });
    const response = await fetch(`${url}/cache?${qs}`);
    if (response.ok) {
      const data = await response.json();
      if (data.ok && data.payload && Array.isArray(data.payload.transcript)) {
        await setWhisperJob({
          ...job,
          type: "whisper-job",
          stage: WHISPER_STAGES.SUCCEEDED,
          title: "Whisper 转录完成",
          subtitle: "正在加载字幕…",
          stageStartedAt: Date.now(),
          finishedAt: Date.now(),
          result: {
            success: true,
            source: data.payload.source || "local-whisper",
            language: data.payload.language || "unknown",
            transcriptLength: data.payload.transcript.length,
            cachePath: data.cache_path || "",
            recovered: true,
          },
        });
        // Tell any open panel so it re-renders from the cache.
        chrome.runtime
          .sendMessage({
            action: "transcriptProgress",
            stage: "succeeded",
            videoId: meta.bvid,
            title: "Whisper 转录完成",
            subtitle: "正在加载字幕…",
          })
          .catch(() => {});
        clearWhisperKeepalive();
        return;
      }
    }
    // Not there yet — the server may still be transcribing. Stay in a
    // "recovered watcher" state so the panel shows an honest subtitle.
    if (job.stage !== WHISPER_STAGES.TRANSCRIBING) {
      await setWhisperJob({
        ...job,
        type: "whisper-job",
        stage: WHISPER_STAGES.TRANSCRIBING,
        title: "Whisper 转录中",
        subtitle: "后台恢复模式：等待服务器完成转写",
        stageStartedAt: Date.now(),
        recovered: true,
      });
    }
  } catch (e) {
    debugLog("[dk-bililearn BG] watchdog cache poll failed:", e);
  }
}

// ============================================================
// TRANSCRIPTION-COMPLETE NOTIFICATION (2026-08-29)
// ============================================================
// A whisper transcription can run for tens of minutes while the user
// browses elsewhere (or closes the panel entirely). When the job
// reaches SUCCEEDED, pop a Chrome notification so they know the
// transcript is ready. Fired from setWhisperJob — the single funnel
// both completion paths go through (live pipeline finish + watchdog
// cache recovery). Clicking the notification focuses an already-open
// tab on the video, or opens one, so the panel renders the cached
// transcript right away.

const WHISPER_DONE_NOTIF_PREFIX = "whisper-done-";
const SUMMARY_DONE_NOTIF_PREFIX = "summary-done-";
const ANALYSIS_DONE_NOTIF_PREFIX = "analysis-done-";
let lastNotifiedWhisperKey = null;
// Shared by all three prefixes above: notifId -> { videoId, videoUrl }.
const notifVideoLinks = new Map();

// 2026-09-02: notification toggles live in chrome.storage. The background
// is the only consumer — sidepanel toggles are written on save, this is
// where they are honored. A per-call async read keeps the surface tiny
// (no in-memory mirror to drift from disk) at the cost of one storage
// hit per completion. Notifications are infrequent (one per video job)
// so the cost is negligible.
async function isNotificationEnabled(settingKey) {
  try {
    const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
    const settings = YTD_SETTINGS.normalize(
      stored[YTD_SETTINGS.STORAGE_KEY] || {},
    );
    // Strict false is the only way to suppress — see settings.js normalize
    // and the matching loadSettings branch. A missing key on a legacy
    // profile falls through to true (the user's first completion still
    // pops, exactly like the previous default).
    // 2026-09-02 migration safety net: when the caller asks for the
    // merged notifyOnSummaryAndAnalysis, also check the two legacy
    // keys (notifyOnSummary / notifyOnAnalysis) and suppress if any
    // of them is `false` on disk. Mirrors settings.js normalize's
    // OR-of-falsees — a user who turned the legacy toggle off in
    // a pre-merge build stays off even if a buggy upgrade path
    // overwrites the merged key with `true`. Defense in depth.
    if (settingKey === "notifyOnSummaryAndAnalysis") {
      if (settings.notifyOnSummary === false) return false;
      if (settings.notifyOnAnalysis === false) return false;
    }
    return settings[settingKey] !== false;
  } catch {
    return true;
  }
}

async function notifyWhisperDone(job) {
  if (!job || job.stage !== WHISPER_STAGES.SUCCEEDED) return;
  // 2026-09-02: user-toggleable. The transcribe toggle was added
  // alongside the summary/analysis ones; the old "always pop" behaviour
  // is now gated on the persisted setting. Cache-key dedup runs FIRST
  // so an explicit-off user is still protected from the very rare
  // double-finish duplicate.
  const key = `${job.videoId || "?"}@p${job.pageNumber || 1}:${job.finishedAt || 0}`;
  if (key === lastNotifiedWhisperKey) return;
  lastNotifiedWhisperKey = key;
  if (!(await isNotificationEnabled("notifyOnTranscribe"))) return;
  const meta = job.recoveryMeta || {};
  const videoTitle = meta.title || job.videoId || "视频";
  const channel = meta.channel ? ` · UP: ${meta.channel}` : "";
  const message = `《${videoTitle}》字幕已就绪${channel}，打开视频即可查看字幕与总结。`;
  const notifId = `${WHISPER_DONE_NOTIF_PREFIX}${job.videoId || "unknown"}-${key}`;
  notifVideoLinks.set(notifId, {
    videoId: job.videoId || "",
    videoUrl: job.videoUrl || "",
  });
  if (notifVideoLinks.size > 10) {
    // Bound the map — older notifications are long gone from the tray.
    notifVideoLinks.delete(notifVideoLinks.keys().next().value);
  }
  try {
    chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "bililearn · 转录完成",
      message,
      priority: 2,
    }, () => {
      // Swallow runtime.lastError noise (notification already closed…).
      void chrome.runtime.lastError;
    });
  } catch (e) {
    debugLog("[dk-bililearn BG] transcription-done notification failed:", e);
  }
}

// 2026-09-02 (user instruction "总结和概览生成结束那个不设时间要求"):
// summary/analysis completion notifications are no longer gated on
// elapsed time. The user's per-toggle preference in options
// (notifyOnSummary / notifyOnAnalysis) is the only gate. The slow-run
// threshold is intentionally not reintroduced — fast runs that the user
// missed while the sidepanel was unfocused are exactly the cases the
// notification is meant to surface. Fired from the success path of
// handleSummarizeTranscript / handleAnalyzeTranscript. Clicking focuses
// an already-open tab on the video (or opens one) so the cached summary
// or overview renders right away.

function formatDurationZh(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min} 分 ${String(sec).padStart(2, "0")} 秒` : `${sec} 秒`;
}

// Common shape for "slow-run completion" notifications. Slow is the
// pre-condition (>= threshold) AND the user toggle is on. Both are
// checked in the per-kind wrappers below; this is just the shared body
// that builds and fires the actual chrome.notifications call.
async function createCompletionNotification({
  prefix,
  settingKey,
  info,
  title,
  buildMessage,
}) {
  if (!(await isNotificationEnabled(settingKey))) return;
  const notifId = `${prefix}${info.videoId || "unknown"}-${Date.now()}`;
  notifVideoLinks.set(notifId, {
    videoId: info.videoId || "",
    videoUrl: info.videoUrl || "",
  });
  if (notifVideoLinks.size > 10) {
    notifVideoLinks.delete(notifVideoLinks.keys().next().value);
  }
  try {
    chrome.notifications.create(
      notifId,
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title,
        message: buildMessage(info),
        priority: 2,
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  } catch (e) {
    debugLog(`[dk-bililearn BG] ${prefix} notification failed:`, e);
  }
}

async function notifySummaryDoneIfSlow(info) {
  if (!info) return;
  await createCompletionNotification({
    prefix: SUMMARY_DONE_NOTIF_PREFIX,
    // 2026-09-02: summary + analysis are a single store value now.
    // isNotificationEnabled still consults the two legacy keys for
    // a user upgrading from a pre-merge build (defense in depth).
    settingKey: "notifyOnSummaryAndAnalysis",
    info,
    title: "bililearn · AI 总结完成",
    buildMessage: (i) => {
      const videoTitle = i.videoTitle || i.videoId || "视频";
      const channel = i.channelName ? ` · UP: ${i.channelName}` : "";
      return `《${videoTitle}》AI 总结已生成（耗时 ${formatDurationZh(i.elapsedMs)}）${channel}，打开视频即可查看。`;
    },
  });
}

// 2026-09-02: analysis (Overview) completion notification. Same shape
// as summary. Both wrappers consult the merged `notifyOnSummaryAndAnalysis`
// store key + the two legacy keys (see isNotificationEnabled's safety
// net). The function name still says "IfSlow" for source compatibility
// with tests, but the only gate is the toggle now (per user
// instruction "总结和概览生成结束那个不设时间要求").
async function notifyAnalysisDoneIfSlow(info) {
  if (!info) return;
  await createCompletionNotification({
    prefix: ANALYSIS_DONE_NOTIF_PREFIX,
    settingKey: "notifyOnSummaryAndAnalysis",
    info,
    title: "bililearn · AI 概览完成",
    buildMessage: (i) => {
      const videoTitle = i.videoTitle || i.videoId || "视频";
      const channel = i.channelName ? ` · UP: ${i.channelName}` : "";
      return `《${videoTitle}》AI 概览已生成（耗时 ${formatDurationZh(i.elapsedMs)}）${channel}，点击 Overview 标签页查看。`;
    },
  });
}

chrome.notifications?.onClicked?.addListener((notifId) => {
  if (
    !notifId ||
    (!notifId.startsWith(WHISPER_DONE_NOTIF_PREFIX) &&
      !notifId.startsWith(SUMMARY_DONE_NOTIF_PREFIX) &&
      !notifId.startsWith(ANALYSIS_DONE_NOTIF_PREFIX))
  ) return;
  const link = notifVideoLinks.get(notifId);
  notifVideoLinks.delete(notifId);
  if (!link) return; // SW was evicted since — nothing to open
  (async () => {
    try {
      // Prefer focusing an already-open tab on this video.
      const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
      const hit = tabs.find((t) => link.videoId && (t.url || "").includes(link.videoId));
      if (hit) {
        await chrome.tabs.update(hit.id, { active: true });
        if (hit.windowId != null) {
          await chrome.windows.update(hit.windowId, { focused: true });
        }
      } else if (link.videoUrl) {
        await chrome.tabs.create({ url: link.videoUrl });
      }
    } catch (e) {
      debugLog("[dk-bililearn BG] notification click open failed:", e);
    }
  })();
});

let activeWhisperJob = null; // in-memory mirror; source of truth is storage

function setWhisperJob(job) {
  activeWhisperJob = job;
  if (job === null) {
    clearWhisperKeepalive();
    return chrome.storage.session.remove(WHISPER_JOB_KEY);
  }
  const terminal =
    job.stage === WHISPER_STAGES.SUCCEEDED ||
    job.stage === WHISPER_STAGES.FAILED;
  // Keep the SW alive (and the watchdog armed) for the whole life of a
  // non-terminal job, regardless of which code path wrote the record.
  if (terminal) {
    clearWhisperKeepalive();
    // Transcription just finished (live pipeline or watchdog-recovered)
    // — tell the user even if the sidepanel is closed.
    notifyWhisperDone(job);
    // Queue (2026-08-29): a terminal write frees the single whisper slot —
    // start the next queued transcription, if any. Fire-and-forget: the
    // terminal write itself must not block on the next job's startup.
    pumpWhisperQueue().catch((e) =>
      debugLog("[dk-bililearn BG] queue pump after terminal failed:", e),
    );
  } else {
    ensureWhisperKeepalive();
  }
  return chrome.storage.session.set({ [WHISPER_JOB_KEY]: job });
}

/**
 * Coerce a transcript segment into the canonical {start, duration, text,
 * language} shape used by sidepanel renderers and the B站 official
 * subtitle path. The transcribe pipeline internally produces
 * {from, to, content}; without this, segments saved to the cache
 * (or returned inline) render as an empty list because
 * groupTranscriptEntries reads `entry.text` / `entry.start`.
 *
 * Idempotent: segments already in the canonical shape pass through.
 */
function normalizeSegment(seg) {
  if (!seg || typeof seg !== "object") return null;
  const start = Number(seg.start ?? seg.from) || 0;
  const end = Number(seg.to ?? seg.end ?? start) || start;
  // If the segment already carries an explicit `duration`, trust it —
  // recomputing from end-start silently degrades to 0 for inputs in the
  // canonical {start, duration, text} shape (e.g. JSON cache files we
  // wrote ourselves with normalizeSegment applied at write time).
  const explicitDuration = Number(seg.duration);
  const duration = Number.isFinite(explicitDuration) && explicitDuration >= 0
    ? explicitDuration
    : Math.max(0, end - start);
  const text = String(seg.text ?? seg.content ?? "").trim();
  if (!text) return null;
  return {
    start,
    duration,
    text,
    language: seg.language || null,
  };
}

async function loadWhisperJob() {
  const stored = await chrome.storage.session.get(WHISPER_JOB_KEY);
  return stored[WHISPER_JOB_KEY] || null;
}

// ============================================================
// WHISPER TRANSCRIBE QUEUE (2026-08-29)
// ============================================================
// One running job + a FIFO of waiting entries. The sidepanel's queue panel
// reads state via getWhisperQueue / whisperQueueUpdate broadcasts.

async function loadWhisperQueue() {
  try {
    const stored = await chrome.storage.session.get(WHISPER_QUEUE_KEY);
    return Array.isArray(stored[WHISPER_QUEUE_KEY]) ? stored[WHISPER_QUEUE_KEY] : [];
  } catch {
    return [];
  }
}

/**
 * Non-terminal summary of the current job for UI display. Terminal jobs
 * return null so the queue panel can hide the "进行中" row (the full record
 * stays in storage until the sidepanel acks it).
 */
function summarizeWhisperJob(job) {
  if (!job || !job.videoId) return null;
  if (job.stage === WHISPER_STAGES.SUCCEEDED || job.stage === WHISPER_STAGES.FAILED) {
    return null;
  }
  return {
    videoId: job.videoId,
    pageNumber: Number(job.pageNumber || 1),
    title: (job.recoveryMeta && job.recoveryMeta.title) || job.queuedTitle || job.videoId,
    stage: job.stage,
    stageTitle: job.title || "",
    stageSubtitle: job.subtitle || "",
    startedAt: job.startedAt || null,
  };
}

async function broadcastWhisperQueue() {
  let queue = [];
  try {
    const stored = await chrome.storage.session.get(WHISPER_QUEUE_KEY);
    if (Array.isArray(stored[WHISPER_QUEUE_KEY])) queue = stored[WHISPER_QUEUE_KEY];
  } catch {}
  chrome.runtime
    .sendMessage({
      action: "whisperQueueUpdate",
      queue,
      job: summarizeWhisperJob(activeWhisperJob),
    })
    .catch(() => {});
}

async function saveWhisperQueue(queue) {
  try {
    await chrome.storage.session.set({ [WHISPER_QUEUE_KEY]: queue });
  } catch {}
  broadcastWhisperQueue().catch(() => {});
}

/**
 * Enqueue a transcription request that arrived while another job is live.
 * Dedupes by videoId+page; caps the queue; returns the position for UI copy.
 */
async function enqueueWhisperEntry(videoId, videoUrl, pageNumber, title) {
  const queue = await loadWhisperQueue();
  const dupIndex = queue.findIndex(
    (e) => e.videoId === videoId && Number(e.pageNumber || 1) === pageNumber,
  );
  if (dupIndex >= 0) {
    return { success: true, alreadyQueued: true, position: dupIndex + 1 };
  }
  if (queue.length >= WHISPER_QUEUE_MAX) {
    return {
      success: false,
      error: `转录队列已满（最多 ${WHISPER_QUEUE_MAX} 个）。等前面的任务完成后再加。`,
    };
  }
  queue.push({
    videoId,
    videoUrl: videoUrl || "",
    pageNumber,
    title: title || "",
    queuedAt: Date.now(),
  });
  await saveWhisperQueue(queue);
  debugLog("[dk-bililearn BG] queued transcription for", videoId, "position", queue.length);
  return { success: true, queued: true, position: queue.length };
}

// Re-entrancy guard: setWhisperJob's terminal branch, the SW cold-start
// arming and watchdog ticks can all try to pump in quick succession.
let whisperQueuePumping = false;

/**
 * Start the next queued transcription if the whisper slot is free (no
 * fresh non-terminal job). Called from:
 *   - setWhisperJob's terminal branch (normal completion path)
 *   - top-level SW cold start (SW died between terminal write and pump)
 *   - watchdog ticks (recovery decided the job is dead)
 */
async function pumpWhisperQueue() {
  if (whisperQueuePumping) return;
  whisperQueuePumping = true;
  try {
    for (let guard = 0; guard <= WHISPER_QUEUE_MAX + 1; guard++) {
      let live = false;
      try {
        const job = await loadWhisperJob();
        const fresh =
          job &&
          job.videoId &&
          job.stage !== WHISPER_STAGES.SUCCEEDED &&
          job.stage !== WHISPER_STAGES.FAILED &&
          job.startedAt &&
          Date.now() - job.startedAt < 15 * 60 * 1000;
        live = Boolean(fresh);
      } catch {}
      if (live) return; // its terminal write re-arms the pump
      const queue = await loadWhisperQueue();
      if (!queue.length) return;
      const [next, ...rest] = queue;
      await saveWhisperQueue(rest);
      debugLog("[dk-bililearn BG] queue pump: starting next entry", next.videoId);
      let res = null;
      try {
        res = await handleTriggerWhisperTranscription(
          next.videoId,
          next.videoUrl,
          next.pageNumber,
          next.title,
        );
      } catch (e) {
        res = { success: false, error: e?.message || String(e) };
      }
      if (res && (res.started || res.alreadyRunning || res.queued || res.alreadyQueued)) {
        return; // slot now occupied — its terminal write re-arms the pump
      }
      debugLog(
        "[dk-bililearn BG] queue pump: entry failed to start:",
        res && res.error,
      );
      // Entry couldn't start (e.g. whisper no longer enabled) — drop it
      // and try the next one.
    }
  } finally {
    whisperQueuePumping = false;
  }
}

// Cold-start arming: if the SW died after a terminal write but before the
// pump could start the next entry, the queue sits orphaned (the keepalive
// alarm is cleared on terminal states, so nothing else would wake us).
// Top-level code runs on EVERY SW wake-up; the pump itself is a cheap no-op
// when the queue is empty or a job is live.
pumpWhisperQueue().catch((e) =>
  debugLog("[dk-bililearn BG] startup queue pump failed:", e),
);

function sendWhisperProgress(stage, title, subtitle, extras = {}) {
  // Update persisted job + broadcast to the sidepanel. Both are
  // best-effort: storage may fail (private mode) and the panel may
  // be closed — neither should break the running job.
  if (activeWhisperJob && activeWhisperJob.stage !== "succeeded" && activeWhisperJob.stage !== "failed") {
    const next = {
      ...activeWhisperJob,
      stage,
      title,
      subtitle,
      stageStartedAt: Date.now(),
      ...extras,
    };
    // Fire-and-forget; we don't want a slow storage write to stall ASR.
    setWhisperJob(next).catch(() => {});
  }
  chrome.runtime
    .sendMessage({
      action: "transcriptProgress",
      stage,
      // The panel needs to know WHICH video this progress belongs to so
      // it can ignore broadcasts for other videos when the user has
      // navigated elsewhere mid-transcription.
      videoId: activeWhisperJob?.videoId || extras.videoId || null,
      title,
      subtitle,
      ...extras,
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// B 站错误分类
// ---------------------------------------------------------------------------
//
// `view` 接口（x/web-interface/view）和 `playurl` 接口（x/player/playurl）
// 都会返回 code + message。我们把这些错误分成 4 类，给用户看的中文消息
// 完全不同，sidepanel 拿到 type 之后切换标题。
//
// NOT_LOGGED_IN       ——  没登录 B 站，扩展拿不到 cookie
// PAID_VIDEO          ——  充电视频 / 付费视频 / 合作视频
// PREMIERE_OR_LIMITED ——  大会员 / 单点付费，账号无权限
// NETWORK_OR_UNKNOWN  ——  兜底（CDN 抖动 / 接口限流 / 解析失败 / ...）
const BILIBILI_ERROR_TYPES = Object.freeze({
  NOT_LOGGED_IN: "NOT_LOGGED_IN",
  PAID_VIDEO: "PAID_VIDEO",
  PREMIERE_OR_LIMITED: "PREMIERE_OR_LIMITED",
  NETWORK_OR_UNKNOWN: "NETWORK_OR_UNKNOWN",
});

const BILIBILI_ERROR_USER_MESSAGES = Object.freeze({
  NOT_LOGGED_IN:
    "🔒 请先在 B 站登录后再打开视频页面，扩展需要你的 B 站 cookie 才能下载音轨。",
  PAID_VIDEO:
    "💰 这是一部付费/充电视频。请确认你已经为该 UP 主充电后，再打开视频页面重试。",
  PREMIERE_OR_LIMITED:
    "🚫 视频需要大会员/购买，你当前账号没有权限。请先在 B 站开通大会员或购买该视频。",
});

const BILIBILI_ERROR_TITLES = Object.freeze({
  NOT_LOGGED_IN: "B 站权限错误",
  PAID_VIDEO: "B 站权限错误",
  PREMIERE_OR_LIMITED: "B 站权限错误",
  NETWORK_OR_UNKNOWN: "Whisper 转录失败",
});

/**
 * 把 view / playurl 的返回结果归到 4 类错误之一。
 *
 * @param {Object} args
 * @param {Object|undefined} args.viewPayload    x/web-interface/view 的 JSON
 * @param {Object|undefined} args.playurlPayload x/player/playurl 的 JSON
 * @param {string|undefined} args.rawMessage     下载音轨失败时的原始 message
 * @returns {{ type: string, title: string, userMessage: string, source: string }}
 *
 * source 字段方便 audit log 判断是哪一步判断出来的：
 *   - "view.code"        view 接口自己报的错
 *   - "view.paid_flag"   view 返回了付费标记
 *   - "playurl.code"     playurl 接口自己报的错
 *   - "playurl.no_audio" playurl 返回但 audio 为空 + view 标记为付费
 *   - "audio_download"   上面都过了但下载失败
 *   - "default"          兜底
 */
function classifyBilibiliError({
  viewPayload,
  playurlPayload,
  rawMessage,
} = {}) {
  // 1. view 接口自己报错（未登录 / 视频不存在 / 大会员）
  if (viewPayload && typeof viewPayload === "object") {
    const code = Number(viewPayload.code);
    if (Number.isFinite(code)) {
      if (code === -101 || code === -400) {
        return {
          type: BILIBILI_ERROR_TYPES.NOT_LOGGED_IN,
          title: BILIBILI_ERROR_TITLES.NOT_LOGGED_IN,
          userMessage: BILIBILI_ERROR_USER_MESSAGES.NOT_LOGGED_IN,
          source: "view.code",
        };
      }
      if (code === -104) {
        return {
          type: BILIBILI_ERROR_TYPES.PREMIERE_OR_LIMITED,
          title: BILIBILI_ERROR_TITLES.PREMIERE_OR_LIMITED,
          userMessage: BILIBILI_ERROR_USER_MESSAGES.PREMIERE_OR_LIMITED,
          source: "view.code",
        };
      }
    }
  }

  // 2. view 返回了付费/充电视频标记
  const v0 =
    viewPayload && viewPayload.data && Array.isArray(viewPayload.data.videos)
      ? viewPayload.data.videos[0]
      : null;
  if (v0) {
    const isPaid =
      v0.is_upower_expert === 1 ||
      v0.is_ugc_pay === 1 ||
      v0.is_cooperation === 1;
    if (isPaid) {
      return {
        type: BILIBILI_ERROR_TYPES.PAID_VIDEO,
        title: BILIBILI_ERROR_TITLES.PAID_VIDEO,
        userMessage: BILIBILI_ERROR_USER_MESSAGES.PAID_VIDEO,
        source: "view.paid_flag",
      };
    }
  }

  // 3. playurl 自己报错
  if (playurlPayload && typeof playurlPayload === "object") {
    const code = Number(playurlPayload.code);
    if (Number.isFinite(code)) {
      if (code === -101 || code === -400) {
        return {
          type: BILIBILI_ERROR_TYPES.NOT_LOGGED_IN,
          title: BILIBILI_ERROR_TITLES.NOT_LOGGED_IN,
          userMessage: BILIBILI_ERROR_USER_MESSAGES.NOT_LOGGED_IN,
          source: "playurl.code",
        };
      }
      if (code === -104) {
        return {
          type: BILIBILI_ERROR_TYPES.PREMIERE_OR_LIMITED,
          title: BILIBILI_ERROR_TITLES.PREMIERE_OR_LIMITED,
          userMessage: BILIBILI_ERROR_USER_MESSAGES.PREMIERE_OR_LIMITED,
          source: "playurl.code",
        };
      }
    }
    // playurl 返回成功但 audio 列表为空 + view 标记为付费 → 充电视频
    const audioList = playurlPayload.data?.dash?.audio;
    const hasAudio = Array.isArray(audioList) && audioList.length > 0;
    if (!hasAudio && v0 && v0.is_upower_expert === 1) {
      return {
        type: BILIBILI_ERROR_TYPES.PAID_VIDEO,
        title: BILIBILI_ERROR_TITLES.PAID_VIDEO,
        userMessage: BILIBILI_ERROR_USER_MESSAGES.PAID_VIDEO,
        source: "playurl.no_audio",
      };
    }
  }

  // 4. 兜底：网络 / CDN / 解析失败
  return {
    type: BILIBILI_ERROR_TYPES.NETWORK_OR_UNKNOWN,
    title: BILIBILI_ERROR_TITLES.NETWORK_OR_UNKNOWN,
    userMessage: `⚠️ 网络或服务端错误：${rawMessage || "未知错误"}`,
    source: rawMessage ? "audio_download" : "default",
  };
}

/**
 * 构造带 bilibiliError 元信息的 Error。message 字段同时是 sidepanel 的
 * 兜底展示文案，所以保留人类可读信息。
 */
function bilibiliErrorToException(classified) {
  const err = new Error(classified.userMessage);
  err.bilibiliError = {
    type: classified.type,
    title: classified.title,
    userMessage: classified.userMessage,
    source: classified.source,
  };
  return err;
}

async function fetchBilibiliAudioBlob(videoId, cid, viewPayload) {
  const response = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(videoId)}&cid=${encodeURIComponent(cid)}&fnval=16&qn=16`,
    { credentials: "include" },
  );
  const payload = await response.json();
  // 先把 playurl 接口本身的错误（未登录 / 大会员 / 充电视频）归类出来
  // 再看 audio 列表是否为空 —— 充电视频的典型表现是 dash.video 有
  // 内容但 dash.audio 为空。
  if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    throw bilibiliErrorToException(
      classifyBilibiliError({ viewPayload, playurlPayload: payload }),
    );
  }
  const audioTracks = [...(payload.data?.dash?.audio || [])].sort(
    (a, b) =>
      (Number(a.bandwidth) || Number.MAX_SAFE_INTEGER) -
      (Number(b.bandwidth) || Number.MAX_SAFE_INTEGER),
  );
  // Speech recognition does not benefit from Bilibili's highest audio bitrate.
  // Selecting the smallest track cuts the CDN download.
  const audio = audioTracks[0];
  const candidates = [audio?.baseUrl, audio?.base_url, ...(audio?.backupUrl || []), ...(audio?.backup_url || [])].filter(Boolean);
  if (!candidates.length) {
    throw bilibiliErrorToException(
      classifyBilibiliError({ viewPayload, playurlPayload: payload, rawMessage: "无法获取B站音轨地址。" }),
    );
  }

  let lastError;
  // B站 CDN commonly returns ERR_CONNECTION_CLOSED for individual audio
  // chunks — try each candidate once, and on transient failures retry with
  // exponential backoff so a single bad request doesn't fail the whole job.
  const RETRY_DELAYS_MS = [0, 1000, 2000, 4000];
  for (const url of candidates) {
    let attempt = 0;
    let attemptError = null;
    while (attempt < RETRY_DELAYS_MS.length) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      try {
        const audioResponse = await fetch(url);
        if (!audioResponse.ok) throw new Error(`HTTP ${audioResponse.status}`);
        const expectedBytes = Number(audioResponse.headers.get("content-length")) || 0;
        const blob = await audioResponse.blob();
        if (!blob.size) throw new Error("音轨为空");
        // Surface stage progress only after we actually have the byte count
        // so the UI message isn't duplicated across retries.
        if (expectedBytes) {
          sendWhisperProgress(
            WHISPER_STAGES.DOWNLOADING,
            "正在下载B站音轨",
            `低码率音轨约 ${(expectedBytes / 1024 / 1024).toFixed(1)} MB`,
            { expectedBytes },
          );
        } else {
          sendWhisperProgress(
            WHISPER_STAGES.DOWNLOADING,
            "正在下载B站音轨",
            "请保持视频页面打开",
          );
        }
        return new Blob([blob], { type: "audio/mp4" });
      } catch (error) {
        attemptError = error;
        attempt += 1;
        debugLog(
          `[dk-bililearn BG] audio fetch attempt ${attempt} failed (${url.slice(0, 80)}…):`,
          error?.message,
        );
      }
    }
    lastError = attemptError;
    // Try the next candidate (e.g. backupUrl) once we've exhausted retries
    // on this one — the user might be able to fall back to a working CDN.
  }
  // 所有候选 URL 都重试完了还失败，分类成网络/CDN 错误
  throw bilibiliErrorToException(
    classifyBilibiliError({
      viewPayload,
      playurlPayload: payload,
      rawMessage: lastError?.message || "未知错误",
    }),
  );
}

// Cloud ASR path was retired 2026-09-11. See git history for the removed
// implementation. Users who configured a key in a previous build will
// silently fall through to local Whisper / official Bilibili subtitle paths;
// no migration needed.

/**
 * Fetches the transcript for a Bilibili video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from Bilibili videos. It handles all the complexity of parsing Bilibili's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The Bilibili video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function transcribeWithLocalWhisper(videoId, cid, settings, viewPayload) {
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url) {
    throw new Error("Local Whisper is selected as the ASR provider but whisperUrl is empty.");
  }
  // Stage 1 — audio download (with retry/backoff). The actual progress
  // update is emitted from inside fetchBilibiliAudioBlob so it can report
  // the byte count when it learns it.
  sendWhisperProgress(
    WHISPER_STAGES.DOWNLOADING,
    "正在下载B站音轨",
    "转录在后台进行，可随意切换页面",
  );
  const audioBlob = await fetchBilibiliAudioBlob(videoId, cid, viewPayload);
  const contentType = audioBlob.type || "audio/mp4";
  // Stage 2 — about to call whisper server. Bridging the gap between
  // "download done" and "server started" so the UI doesn't appear stuck.
  sendWhisperProgress(
    WHISPER_STAGES.READY_TO_TRANSCRIBE,
    "音频下载完成，准备调用 Whisper",
    `模型 ${settings.whisperModel || "base"} · ${url}`,
  );
  // Metadata headers: whisper_server persists the transcript to its own
  // cache the moment inference finishes (X-Bvid/X-Cid/X-Title/X-Channel/
  // X-Pubdate/X-Cache-Dir). If this SW is evicted before the POST
  // returns — page switch, extension reload, browser restart — the
  // watchdog recovers the finished result from that cache instead of
  // losing it. Values are encodeURIComponent'd to stay header-safe
  // (latin-1) with CJK titles; the server unquotes them.
  const metaTitle = encodeURIComponent(viewPayload?.data?.title || "");
  const metaChannel = encodeURIComponent(viewPayload?.data?.owner?.name || "");
  const metaPubDate = viewPayload?.data?.pubdate
    ? new Date(viewPayload.data.pubdate * 1000).toISOString().split("T")[0]
    : "";
  const headers = {
    "Content-Type": contentType,
    "X-Whisper-Model": settings.whisperModel || "base",
    "X-Bvid": videoId,
    "X-Cid": String(cid),
    "X-Title": metaTitle,
    "X-Channel": metaChannel,
    "X-Pubdate": metaPubDate,
    "X-Cache-Dir": encodeURIComponent(settings.subtitlesDir || ""),
  };
  if (settings.whisperLanguage) {
    headers["X-Whisper-Language"] = settings.whisperLanguage;
  }
  // Stage 3 — actually calling the whisper server. The POST is synchronous
  // from the SW's perspective; the user just sees "Whisper 转录中" until
  // the server responds.
  sendWhisperProgress(
    WHISPER_STAGES.TRANSCRIBING,
    "Whisper 转录中",
    "长视频通常需要几分钟，可在终端查看 whisper_server.py 日志",
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 30 min
  let response;
  try {
    response = await fetch(`${url}/transcribe`, {
      method: "POST",
      headers,
      body: audioBlob,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch (_e) {}
    throw new Error(
      `Whisper server returned ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(`Whisper server error: ${data.error}`);
  }
  // Normalise to the canonical transcript shape so the rest of the
  // pipeline (timestamp validation, AI correction, downstream consumers)
  // works unchanged.
  const rawSegments = (data.segments || []).map((seg) => ({
    from: Number(seg.start) || 0,
    to: Number(seg.end) || 0,
    content: String(seg.text || "").trim(),
  }));
  // Best-effort: ask the configured AI provider to fix Whisper's homophone
  // mistakes and tag chapter boundaries. If no AI key is configured, fall
  // back to the raw segments and signal `needsCorrection` so the UI can
  // optionally trigger it later.
  if (!YTD_SETTINGS.activeApiKey(settings)) {
    return {
      success: true,
      source: "local-whisper",
      language: data.language || "unknown",
      needsCorrection: true,
      transcript: rawSegments,
      transcriptText: rawSegments
        .map((seg) => `[${formatTimestamp(seg.from)}] ${seg.content}`)
        .join("\n"),
    };
  }
  // Stage 4 — AI correction over the raw segments. This is usually the
  // longest step for short videos (1-2k tokens of diff per 10 minutes),
  // so we surface it separately so the loading screen doesn't look frozen.
  sendWhisperProgress(
    WHISPER_STAGES.CORRECTING,
    "AI 校正专有名词中",
    `识别出 ${rawSegments.length} 段字幕，正在修正同音字错听`,
  );
  try {
    const { segments: corrected, chapters } = await correctWhisperTranscript(
      rawSegments,
      data.language || "unknown",
      settings,
    );
    return {
      success: true,
      source: "local-whisper-corrected",
      language: data.language || "unknown",
      chapters,
      transcript: corrected,
      transcriptText: corrected
        .map((seg) => `[${formatTimestamp(seg.from)}] ${seg.content}`)
        .join("\n"),
    };
  } catch (correctionError) {
    debugLog(
      "[dk-bililearn BG] whisper correction failed, returning raw:",
      correctionError,
    );
    return {
      success: true,
      source: "local-whisper",
      language: data.language || "unknown",
      needsCorrection: true,
      transcript: rawSegments,
      transcriptText: rawSegments
        .map((seg) => `[${formatTimestamp(seg.from)}] ${seg.content}`)
        .join("\n"),
    };
  }
}

/**
 * Look for local subtitle files by filename pattern: YYYY-MM-DD_videoTitle_upName.{txt,srt,md}
 * Parse the file content into transcript format.
 */
async function loadLocalSubtitleFile(bvid, videoTitle, channelName, pubDate, settings, cid) {
  const dir = settings && typeof settings.subtitlesDir === "string"
    ? settings.subtitlesDir.trim().replace(/[\\/]+$/, "")
    : "";
  if (!dir) return null;

  // Generate possible filenames
  const cleanTitle = (videoTitle || "")
    .replace(/[<>:"/\\|?*]/g, "_") // Replace invalid filename chars
    .trim()
    .substring(0, 100); // Limit length
  const cleanChannel = (channelName || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .substring(0, 50);

  const possibleFilenames = [];
  if (pubDate) {
    possibleFilenames.push(`${pubDate}_${cleanTitle}_${cleanChannel}.md`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}_${cleanChannel}.txt`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}_${cleanChannel}.srt`);
    // .json covers the bililearn-written Whisper cache (also saved with
    // the {date}_{title}_{UP}.json convention since 2026-08-22 so the
    // local-file path and the cache path agree on the same filename).
    possibleFilenames.push(`${pubDate}_${cleanTitle}_${cleanChannel}.json`);
    // Fallback without UP name (for files like YYYY-MM-DD_Title.md)
    possibleFilenames.push(`${pubDate}_${cleanTitle}.md`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}.txt`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}.srt`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}.json`);
  }
  // Fallback without date
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.md`);
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.txt`);
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.srt`);
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.json`);
  // Fallback without date and UP name
  possibleFilenames.push(`${cleanTitle}.md`);
  possibleFilenames.push(`${cleanTitle}.txt`);
  possibleFilenames.push(`${cleanTitle}.srt`);
  possibleFilenames.push(`${cleanTitle}.json`);

  try {
    // Pass 1: filename match (legacy behavior). Pass 2: bvid grep
    // (header match, covers up-master-report and any other pipeline
    // that writes `# Source: <bvid>` at the top of its subtitles).
    // The server tries filename first, then bvid, so this stays cheap.
    const qs = new URLSearchParams({
      filenames: possibleFilenames.join(","),
      bvid: bvid || "",
      // CID is the authoritative lookup key (unique per video part,
      // never repeats) — the server pins .json matches to the exact
      // part with it. Title-based filename matching stays as the
      // human-readable layer.
      cid: cid != null ? String(cid) : "",
      cache_dir: dir,
    });
    const response = await fetch(
      `${settings.whisperUrl}/local-file?${qs.toString()}`,
      { method: "GET" },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      debugLog("[dk-bililearn BG] local file lookup failed:", response.status);
      return null;
    }
    const data = await response.json();
    if (!data || !data.ok || !data.payload) return null;

    // Parse the file content
    const { content, filename } = data.payload;
    const transcript = parseLocalSubtitleContent(content, filename);
    if (!transcript) return null;

    return {
      ...transcript,
      source: "local-file",
      cachePath: `${dir}/${filename}`,
    };
  } catch (error) {
    debugLog("[dk-bililearn BG] local file load error:", error);
    return null;
  }
}

/**
 * Parse local subtitle content (txt/srt/md/json) into transcript format
 * Expected formats:
 *   - JSON (Whisper cache): { bvid, cid, transcript: [{from, to, content}, ...] }
 *   - Markdown: ## 段 N [0.00s → 29.70s] followed by text
 *   - SRT: [HH:MM:SS,mmm] text
 *   - Simple: [MM:SS] text
 */
function parseLocalSubtitleContent(content, filename) {
  const lowerName = (filename || "").toLowerCase();
  const isJson = lowerName.endsWith(".json");
  const isMarkdown = lowerName.endsWith(".md") || lowerName.endsWith(".markdown");
  const isSrt = lowerName.endsWith(".srt");

  // JSON branch: Whisper cache files (saved by the trigger flow as
  // {bvid, cid, source, language, savedAt, transcript: [{from, to, content}, ...]}).
  // Try first when extension is .json — the {from, to, content} shape is
  // distinct enough that a JSON.parse failure means "this isn't actually a
  // Whisper cache" and we can safely fall through to the line-based
  // parsers below. Reuses normalizeSegment so older caches (raw
  // {from, to, content}) and newer normalized ones ({start, duration,
  // text}) both render correctly.
  if (isJson) {
    try {
      const obj = JSON.parse(content);
      const rawSegments = Array.isArray(obj?.transcript) ? obj.transcript : null;
      if (rawSegments) {
        const segments = rawSegments.map(normalizeSegment).filter(Boolean);
        if (segments.length > 0) {
          let plain = "";
          let ts = "";
          for (const seg of segments) {
            plain += seg.text + " ";
            ts += `[${formatTimestamp(seg.start)}] ${seg.text}\n`;
          }
          return {
            transcript: segments,
            transcriptText: plain.trim(),
            transcriptTextTimestamped: ts.trim(),
            language: obj.language || "zh",
          };
        }
      }
    } catch (_) {
      // Not a Whisper cache JSON — fall through to line-based parsers
      // (someone may have named a .txt as .json by mistake; don't break
      // their workflow).
    }
  }

  const lines = content.split(/\r?\n/);
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  // Try to parse as Markdown format first
  if (isMarkdown) {
    let currentSegment = null;
    for (const line of lines) {
      const trimmed = line.trim();

      // Match header: ## 段 N [0.00s → 29.70s]
      const headerMatch = trimmed.match(/^##\s*段\s*\d+\s*\[\s*(\d+\.?\d*)s\s*→\s*(\d+\.?\d*)s\s*\]$/);
      if (headerMatch) {
        // Save previous segment if exists
        if (currentSegment && currentSegment.text) {
          transcript.push(currentSegment);
          transcriptTextPlain += currentSegment.text + " ";
          const timestamp = `${Math.floor(currentSegment.start / 60)}:${String(Math.floor(currentSegment.start % 60)).padStart(2, "0")}`;
          transcriptTextTimestamped += `[${timestamp}] ${currentSegment.text}\n`;
        }
        // Start new segment
        currentSegment = {
          start: parseFloat(headerMatch[1]),
          duration: parseFloat(headerMatch[2]) - parseFloat(headerMatch[1]),
          text: "",
          language: "zh",
        };
      } else if (currentSegment) {
        // Add text to current segment
        if (trimmed && !trimmed.startsWith("#")) {
          if (currentSegment.text) currentSegment.text += " ";
          currentSegment.text += trimmed;
        }
      }
    }
    // Don't forget the last segment
    if (currentSegment && currentSegment.text) {
      transcript.push(currentSegment);
      transcriptTextPlain += currentSegment.text + " ";
      const timestamp = `${Math.floor(currentSegment.start / 60)}:${String(Math.floor(currentSegment.start % 60)).padStart(2, "0")}`;
      transcriptTextTimestamped += `[${timestamp}] ${currentSegment.text}\n`;
    }

    if (transcript.length > 0) {
      return {
        transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: "zh",
      };
    }
  }

  // up-master-report format: [    0.0s ->     1.4s] text
  // Plain .txt, may have leading `# Source:` / `# Duration:` / etc. comment
  // lines (the bvid header is what let /local-file find the file in the
  // first place). Try this before the SRT/simple fallbacks so segments
  // get correct `duration` instead of all-zero.
  const rangeMatchRegex = /^\[\s*(\d+(?:\.\d+)?)s\s*->\s*(\d+(?:\.\d+)?)s\s*\]\s*(.+)$/;
  const rangeSegments = [];
  let rangeHeaderSkipped = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!rangeHeaderSkipped && trimmed.startsWith("#")) {
      // Skip leading comment block (e.g. # Source: BV..., # Duration: ...).
      rangeHeaderSkipped = true;
      continue;
    }
    if (trimmed.startsWith("#")) continue; // mid-file comments too
    const m = trimmed.match(rangeMatchRegex);
    if (!m) continue;
    const start = parseFloat(m[1]);
    const end = parseFloat(m[2]);
    const text = m[3].trim();
    if (!text) continue;
    rangeSegments.push({
      start,
      duration: Math.max(0, end - start),
      text,
      language: "zh",
    });
  }
  if (rangeSegments.length > 0) {
    let plain = "";
    let ts = "";
    for (const seg of rangeSegments) {
      plain += seg.text + " ";
      const minutes = Math.floor(seg.start / 60);
      const seconds = Math.floor(seg.start % 60);
      ts += `[${minutes}:${String(seconds).padStart(2, "0")}] ${seg.text}\n`;
    }
    return {
      transcript: rangeSegments,
      transcriptText: plain.trim(),
      transcriptTextTimestamped: ts.trim(),
      language: "zh",
    };
  }

  // Fall back to SRT/Simple format parsing
  const lineRegex = isSrt
    ? /^\[(\d{2}):(\d{2}):(\d{2}),(\d{3})\]\s*(.+)$/ // SRT: [00:01:23,456] text
    : /^\[(\d{1,2}):(\d{2})\]\s*(.+)$/; // Simple: [MM:SS] text

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(lineRegex);
    if (match) {
      let startSeconds;
      if (isSrt) {
        // SRT format: [HH:MM:SS,mmm]
        const [, hours, minutes, seconds, milliseconds] = match;
        startSeconds =
          parseInt(hours, 10) * 3600 +
          parseInt(minutes, 10) * 60 +
          parseInt(seconds, 10) +
          parseInt(milliseconds, 10) / 1000;
      } else {
        // Simple format: [MM:SS]
        const [, minutes, seconds] = match;
        startSeconds = parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
      }
      const text = match[match.length - 1].trim();
      if (!text) continue;

      const minutes = Math.floor(startSeconds / 60);
      const seconds = Math.floor(startSeconds % 60);
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

      transcript.push({
        text,
        start: startSeconds,
        duration: 0, // Duration unknown in simple format
        language: "zh", // Assume Chinese for local files
      });

      transcriptTextPlain += text + " ";
      transcriptTextTimestamped += `[${timestamp}] ${text}\n`;
    } else {
      // Try to match without brackets: 00:01:23 or 01:23 format
      const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.+)$/);
      if (timeMatch) {
        const [, minutes, seconds, extraSeconds, text] = timeMatch;
        let startSeconds = parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
        if (extraSeconds) {
          startSeconds += parseInt(extraSeconds, 10);
        }
        const cleanText = text.trim();
        if (!cleanText) continue;

        const timestamp = `${minutes}:${String(parseInt(seconds, 10)).padStart(2, "0")}`;

        transcript.push({
          text: cleanText,
          start: startSeconds,
          duration: 0,
          language: "zh",
        });

        transcriptTextPlain += cleanText + " ";
        transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
      }
    }
  }

  if (transcript.length === 0) return null;

  return {
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: "zh",
  };
}

async function loadCachedTranscript(bvid, cid, settings, videoTitle, channelName, pubDate) {
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url || !YTD_SETTINGS.whisperCachePath(settings, bvid, cid, videoTitle, channelName, pubDate)) {
    return null;
  }
  const cachePath = YTD_SETTINGS.whisperCachePath(settings, bvid, cid, videoTitle, channelName, pubDate);
  try {
    const qs = new URLSearchParams({
      bvid,
      cid: String(cid),
      cache_dir: settings.subtitlesDir || "",
    });
    // Pass video metadata so whisper_server can use the same
    // {date}_{title}_{UP}.json convention as .md/.txt/.srt lookups.
    // Falls back to legacy bvid_cid.json naming server-side if any
    // field is empty.
    if (videoTitle) qs.set("title", videoTitle);
    if (channelName) qs.set("channel", channelName);
    if (pubDate) qs.set("pub_date", pubDate);
    const response = await fetch(
      `${url}/cache?${qs.toString()}`,
      { method: "GET" },
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || !data.ok || !data.payload) return null;
    return { ...data.payload, cachePath };
  } catch (error) {
    debugLog("[dk-bililearn BG] cache load failed:", error);
    return null;
  }
}

async function saveCachedTranscript(bvid, cid, payload, settings, videoTitle, channelName, pubDate) {
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url) return null;
  try {
    const response = await fetch(`${url}/cache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bvid,
        cid: String(cid),
        cache_dir: settings.subtitlesDir || "",
        // Same metadata pass-through as the read path. whisper_server
        // uses these to pick {date}_{title}_{UP}.json when available,
        // bvid_cid.json as a fallback. Keeping the read + write
        // filenames in lockstep is what makes `loadLocalSubtitleFile`
        // (which searches by human-friendly name) able to find a file
        // we wrote ourselves.
        title: videoTitle || "",
        channel: channelName || "",
        pub_date: pubDate || "",
        payload,
      }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    debugLog("[dk-bililearn BG] cache write failed:", error);
    return null;
  }
}

async function correctWhisperTranscript(segments, language, settings) {
  const safeSegments = (segments || [])
    .map((seg) => ({
      from: Number(seg.from) || 0,
      to: Number(seg.to) || 0,
      content: String(seg.content || "").trim(),
    }))
    .filter((seg) => seg.content);
  if (safeSegments.length === 0) {
    return { segments: safeSegments, chapters: [] };
  }
  const systemPrompt = await loadPromptSection("whisper-correction", "System prompt");
  const userPromptTemplate = await loadPromptSection(
    "whisper-correction",
    "User prompt template",
  );
  const userPrompt = userPromptTemplate
    .replace("{videoTitle}", "未知（本地 Whisper 转写）")
    .replace("{channelName}", "未知")
    .replace("{segmentsJson}", JSON.stringify(safeSegments, null, 0));
  // requestAiCompletion uses messages=[{role:user}] which most providers
  // accept for one-shot tasks, but the cleaner shape is system + user.
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const result = await requestAiCompletion({
    messages,
    maxTokens: 8192,
    temperature: 0.2,
    responseFormat: { type: "json_object" },
  });
  const parsed = parseLooseJson(result.text) || {};
  const corrected = Array.isArray(parsed.segments)
    ? parsed.segments
        .map((seg) => ({
          from: Number(seg.from) || 0,
          to: Number(seg.to) || 0,
          content: String(seg.content || "").trim(),
        }))
        .filter((seg) => seg.content)
    : safeSegments;
  const chapters = Array.isArray(parsed.chapters)
    ? parsed.chapters
        .map((ch) => ({
          title: String(ch.title || "").trim(),
          from: Number(ch.from) || 0,
          to: Number(ch.to) || 0,
        }))
        .filter((ch) => ch.title)
    : [];
  return { segments: corrected, chapters };
}

async function handleTriggerWhisperTranscription(
  videoId,
  videoUrl = "",
  requestedPage = 1,
  videoTitle = "",
) {
  const settings = await getSettings();
  if (settings.asrProvider !== "whisper") {
    throw new Error("Local Whisper is not enabled. Open bililearn Settings.");
  }
  const requestedPageNumber = Math.max(1, Number(requestedPage) || 1);

  // Re-entry guard (2026-08-22): the extension can fire the same
  // transcription twice (double-click, reopened panel, regenerate while
  // running). Each duplicate ran a full parallel CPU inference on
  // whisper_server — observed live: 3 concurrent transcribes of the same
  // 5.5-minute audio, each slowing the others to a crawl and none
  // finishing. While ANY non-terminal job is <15 min old we either attach
  // to it (same video+page) or refuse (different video — parallel int8
  // CPU inference starves both jobs and the shared job record can only
  // track one pipeline).
  try {
    const existing = await loadWhisperJob();
    const existingFresh =
      existing &&
      existing.videoId &&
      existing.stage !== WHISPER_STAGES.SUCCEEDED &&
      existing.stage !== WHISPER_STAGES.FAILED &&
      existing.startedAt &&
      Date.now() - existing.startedAt < 15 * 60 * 1000;
    if (existingFresh) {
      const sameVideo =
        existing.videoId === videoId &&
        Number(existing.pageNumber || 1) === requestedPageNumber;
      if (sameVideo) {
        debugLog("[dk-bililearn BG] trigger blocked: job already running for", videoId);
        return { success: true, alreadyRunning: true };
      }
      debugLog("[dk-bililearn BG] trigger queued behind running job for", existing.videoId, "→", videoId);
      // Queue (2026-08-29): different video while busy → enqueue instead of
      // refusing. Whisper stays single-job; the pump starts this entry when
      // the current one reaches a terminal state.
      return await enqueueWhisperEntry(videoId, videoUrl, requestedPageNumber, videoTitle);
    }
  } catch {
    // storage.session unavailable — fall through and start normally.
  }

  // From here on the pipeline owns this worker. The flag tells the
  // keepalive watchdog "a live pipeline exists — just keep me warm"
  // instead of trying to recover an orphaned job record.
  whisperPipelineActive = true;

  // Persist a fresh job record BEFORE we touch the network, so a SW
  // eviction or extension reload during the next 5+ minutes still leaves
  // a job the sidepanel can resume from.
  const startedAt = Date.now();
  await setWhisperJob({
    type: "whisper-job",
    videoId,
    videoUrl: videoUrl || "",
    pageNumber: requestedPageNumber,
    // Queue panel display name until recoveryMeta.title lands (the view
    // fetch below is what fills the real title in).
    queuedTitle: videoTitle || "",
    stage: WHISPER_STAGES.STARTED,
    title: "启动 Whisper 转录",
    subtitle: "正在连接 B 站接口…",
    startedAt,
    stageStartedAt: startedAt,
  });

  // --- FIRE-AND-ACK (2026-08-29) ---
  // 转录 pipeline 从这里拆成 detached 后台任务：消息处理立即返回
  // {success:true, started:true}，进度与成败完全走 transcriptProgress
  // 广播 + storage job 恢复链。旧实现里 sendResponse 要等全程转录完成
  // （长视频 10 分钟+），窗口期内 SW 一旦被杀（扩展 reload / eviction），
  // sidepanel 只能收到 Chrome 原生 "A listener indicated an asynchronous
  // response... message channel closed" 错误。注意顺序：STARTED job 必须先
  // 落 storage 再 sendResponse，sidepanel 收到 started 后会立即
  // maybeResumeWhisperJob，两者颠倒了会resume到旧记录。
  runWhisperPipeline(videoId, videoUrl, requestedPageNumber, settings).catch(
    (e) => debugLog("[dk-bililearn BG] whisper pipeline detached error:", e?.message || e),
  );
  return { success: true, started: true };
}

async function runWhisperPipeline(videoId, videoUrl, requestedPageNumber, settings) {
  let view;
  try {
    // Look up the cid first so the cache file name is stable.
    const viewResponse = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`,
      { credentials: "include" },
    );
    view = await viewResponse.json();
    // view 接口自己报错（未登录 / 大会员 / 视频不存在）→ 归类后抛
    if (!viewResponse.ok || view.code !== 0 || !view.data) {
      throw bilibiliErrorToException(
        classifyBilibiliError({ viewPayload: view, rawMessage: view.message || "无法读取 B 站视频信息。" }),
      );
    }
    // 充电视频：view 返回成功但 videos[0] 带付费标记 → 提前拦截，避免
    // playurl 再走一次才在 audio 为空时发现。
    const v0Header = view.data.videos?.[0] || null;
    const preCheck = classifyBilibiliError({ viewPayload: view });
    if (
      preCheck.type === BILIBILI_ERROR_TYPES.PAID_VIDEO ||
      preCheck.type === BILIBILI_ERROR_TYPES.PREMIERE_OR_LIMITED
    ) {
      throw bilibiliErrorToException(preCheck);
    }
    // 把 view 里的付费/合作标记存到 job，方便事后 audit log 一眼看出
    // 这个视频到底卡在哪个分类上。空对象时也写一个空对象，避免
    // 后续逻辑误以为还没拉过 view。recoveryMeta 给 watchdog 用：
    // SW 被杀后恢复时按这些参数查服务端缓存。
    const part = requestedPageNumber;
    const page = view.data.pages?.[part - 1] || view.data.pages?.[0];
    if (!page?.cid) throw new Error("无法识别当前分 P 的 CID。");
    const recoveryTitle = view.data.title || "";
    const recoveryChannel = view.data.owner?.name || "";
    const recoveryPubDate = view.data.pubdate
      ? new Date(view.data.pubdate * 1000).toISOString().split("T")[0]
      : "";
    await setWhisperJob({
      ...(activeWhisperJob || {}),
      recoveryMeta: {
        bvid: videoId,
        cid: page.cid,
        title: recoveryTitle,
        channel: recoveryChannel,
        pubDate: recoveryPubDate,
        cacheDir: settings.subtitlesDir || "",
      },
      videoMeta: {
        is_upower_expert: v0Header?.is_upower_expert ?? 0,
        is_ugc_pay: v0Header?.is_ugc_pay ?? 0,
        is_cooperation: v0Header?.is_cooperation ?? 0,
        aid: v0Header?.aid ?? null,
        bvid: videoId,
        title: view.data.title || null,
      },
    });

    const result = await transcribeWithLocalWhisper(videoId, page.cid, settings, view);
    // Persist to cache so the next visit is instant. We always save the
    // segments we have, even if the AI correction step failed, so the user
    // gets something to read instead of being asked to re-transcribe.
    // The transcribe pipeline returns segments shaped {from, to, content},
    // but every downstream consumer (sidepanel groupTranscriptEntries,
    // renderTranscript, transcriptText) expects the canonical
    // {start, duration, text} shape used by B站 official subtitles.
    // Normalize at the cache boundary so a saved cache renders correctly
    // on the next visit.
    const canonicalTranscript = (result.transcript || []).map(normalizeSegment);
    const cachePayload = {
      bvid: videoId,
      cid: page.cid,
      source: result.source,
      language: result.language,
      savedAt: new Date().toISOString(),
      transcript: canonicalTranscript,
      chapters: result.chapters || [],
    };
    // Pass video metadata so the cache file is named with the same
    // {date}_{title}_{UP}.json convention that loadLocalSubtitleFile
    // searches for. Without this the write uses a bvid_cid.json name
    // that the human-friendly filename lookup can never find.
    const metaTitle = view.data.title || "";
    const metaChannel = view.data.owner?.name || "";
    const metaPubDate = view.data.pubdate
      ? new Date(view.data.pubdate * 1000).toISOString().split("T")[0]
      : "";
    const saved = await saveCachedTranscript(
      videoId,
      page.cid,
      cachePayload,
      settings,
      metaTitle,
      metaChannel,
      metaPubDate,
    );
    if (!saved) {
      // saveCachedTranscript swallows network/server errors and returns
      // null on failure. If we ignore that and continue, the trigger
      // returns success=true but the cache is empty — the next visit's
      // loadCachedTranscript will return null, the user lands back on
      // the "click Whisper to start" prompt, and they think nothing
      // happened. Surface the failure instead so they see a real error
      // and can retry / check whisper_server.
      throw new Error(
        "字幕缓存保存失败（whisper_server 写入错误）。请确认 whisper_server.py 仍在 7860 端口运行后重试。",
      );
    }
    // Mark the job as succeeded so the sidepanel can stop polling and
    // fall through to the normal transcript render path. The terminal
    // record is cleared in a follow-up tick to give the UI a chance to
    // notice the SUCCEEDED state.
    await setWhisperJob({
      ...activeWhisperJob,
      type: "whisper-job",
      stage: WHISPER_STAGES.SUCCEEDED,
      title: "Whisper 转录完成",
      subtitle: "正在加载字幕…",
      stageStartedAt: Date.now(),
      finishedAt: Date.now(),
      result: {
        success: true,
        source: result.source,
        language: result.language,
        transcriptLength: (result.transcript || []).length,
        cachePath: YTD_SETTINGS.whisperCachePath(settings, videoId, page.cid, metaTitle, metaChannel, metaPubDate),
      },
    });
    // Fire-and-ack：live pipeline 完成也广播 succeeded —— 旧实现在这里
    // 依赖 sendMessage 的最终 sendResponse 驱动 sidepanel 重渲染，拆成
    // detached 后这条线没了，改走与 watchdog 恢复完全相同的广播路径。
    // （sendWhisperProgress 对 terminal job 不再覆写 storage，只广播。）
    sendWhisperProgress(WHISPER_STAGES.SUCCEEDED, "Whisper 转录完成", "正在加载字幕…");
    return {
      ...result,
      transcript: canonicalTranscript,
      cachePath: YTD_SETTINGS.whisperCachePath(settings, videoId, page.cid, metaTitle, metaChannel, metaPubDate),
    };
  } catch (err) {
    // Persist a terminal FAILED state so the sidepanel can render an
    // error rather than spinning forever. 有 bilibiliError 的错误用
    // 它的 title / userMessage，否则退回通用文案。
    const classified = err?.bilibiliError;
    await setWhisperJob({
      ...(activeWhisperJob || {}),
      type: "whisper-job",
      videoId,
      videoUrl: videoUrl || "",
      pageNumber: requestedPageNumber,
      stage: WHISPER_STAGES.FAILED,
      title: classified?.title || "Whisper 转录失败",
      subtitle: classified?.userMessage || err?.message || String(err),
      stageStartedAt: Date.now(),
      finishedAt: Date.now(),
      error: err?.message || String(err),
      bilibiliErrorType: classified?.type || null,
    });
    // Fire-and-ack：失败也广播，开着的面板立刻看到错误而不是永远转圈。
    // sendWhisperProgress 此时不覆写 terminal job（见其内部 guard），只广播。
    sendWhisperProgress(
      WHISPER_STAGES.FAILED,
      classified?.title || "Whisper 转录失败",
      classified?.userMessage || err?.message || String(err),
    );
    throw err;
  } finally {
    // Pipeline done (success or failure) — the keepalive watchdog no
    // longer has a live pipeline to protect. Non-terminal records keep
    // the alarm armed so recovery can still kick in after an eviction.
    whisperPipelineActive = false;
  }
}

/**
 * Fetch B站's own subtitle track for a video (human-uploaded or ai-zh auto).
 * Returns a transcript payload in the same shape as `handleFetchTranscript`,
 * or `null` if the video has no subtitle track (so the caller can fall
 * through to local files / Whisper).
 *
 * Errors (network, bvid mismatch) bubble up so `handleFetchTranscript` can
 * report them, but a missing track is a normal "fall through" condition.
 */
async function fetchBilibiliOfficialSubtitle(videoId, cid) {
  const playerResponse = await fetch(
    `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(videoId)}&cid=${encodeURIComponent(cid)}`,
    { credentials: "include", cache: "no-store" },
  );
  const player = await playerResponse.json();
  if (!playerResponse.ok || player.code !== 0) {
    throw new Error(player.message || "无法读取 B 站字幕列表。");
  }
  if (
    String(player.data?.bvid || "") !== String(videoId) ||
    Number(player.data?.cid) !== Number(cid)
  ) {
    throw new Error("B 站返回的字幕信息与当前视频不匹配，请刷新后重试。");
  }

  const subtitles = player.data?.subtitle?.subtitles || [];
  // Prefer human-uploaded Chinese, then any Chinese (incl. ai-zh), then first track.
  const preferred =
    subtitles.find((item) => /^(zh|zh-CN|zh-Hans|zh-TW)/i.test(item.lan || "") && !/ai-zh/i.test(item.lan || "")) ||
    subtitles.find((item) => /zh|ai-zh/i.test(item.lan || "")) ||
    subtitles[0];
  if (!preferred?.subtitle_url) return null;

  const subtitleUrl = preferred.subtitle_url.startsWith("//")
    ? `https:${preferred.subtitle_url}`
    : preferred.subtitle_url;
  const subtitleResponse = await fetch(subtitleUrl, { credentials: "include" });
  if (!subtitleResponse.ok) throw new Error("B 站字幕文件下载失败。");
  const data = await subtitleResponse.json();

  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  if (data.body && Array.isArray(data.body)) {
    for (const chunk of data.body) {
      const cleanText = (chunk.content || "").trim();
      if (!cleanText) continue;

      const startSeconds = Math.max(0, Number(chunk.from) || 0);
      const minutes = Math.floor(startSeconds / 60);
      const seconds = startSeconds % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

      transcript.push({
        text: cleanText,
        start: startSeconds,
        duration: Math.max(0, (Number(chunk.to) || startSeconds) - startSeconds),
        language: preferred.lan || null,
      });
      transcriptTextPlain += cleanText + " ";
      transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
    }
  }

  if (transcript.length === 0) return null;

  return {
    success: true,
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: preferred.lan || null,
    source: "bilibili-subtitle",
  };
}

async function handleFetchTranscript(videoId, videoUrl = "", requestedPage = 1) {
  try {
    YTD_SETTINGS.canonicalBilibiliUrl(videoId);
    const viewResponse = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`,
      { credentials: "include" },
    );
    const view = await viewResponse.json();
    if (!viewResponse.ok || view.code !== 0 || !view.data) {
      throw new Error(view.message || "无法读取 B 站视频信息。");
    }

    let part = Math.max(1, Number(requestedPage) || 1);
    try {
      part = Math.max(part, Number(new URL(videoUrl).searchParams.get("p")) || 1);
    } catch {}
    const page = view.data.pages?.[part - 1] || view.data.pages?.[0];
    if (!page?.cid) throw new Error("无法识别当前分 P 的 CID。");

    // Extract video metadata for local file lookup
    const videoTitle = view.data.title || "";
    const channelName = view.data.owner?.name || "";
    const pubDate = view.data.pubdate
      ? new Date(view.data.pubdate * 1000).toISOString().split("T")[0]
      : "";

    // 2026-08-31 stale-title fix: stamp this BV-keyed view-API metadata
    // onto every success payload. The sidepanel's page-DOM read
    // (getVideoInfo) races Bilibili's SPA navigation and can return the
    // PREVIOUS video's title; this response is keyed to the exact video
    // id the panel asked for, so the sidepanel lets it win. Existing
    // fields on the inner result are preserved (|| fallback).
    const withVideoMeta = (result) => {
      if (result && typeof result === "object" && result.success) {
        result.videoTitle = result.videoTitle || videoTitle;
        result.channelName = result.channelName || channelName;
        result.pubDate = result.pubDate || pubDate;
      }
      return result;
    };

    // Cloud ASR key support retired 2026-09-11. Users with a leftover key in
    // chrome.storage keep the field (so the settings UI does not change shape
    // on them) but it is ignored here. Fall straight through to the B-station
    // official subtitle path.
    // 2026-09-12 regression fix: this call was `void (await getSettings())`,
    // which stopped assigning the settings object — every video without an
    // official subtitle then died below with `settings is not defined`
    // (ReferenceError) instead of reaching the local-file / whisper-cache
    // lookups and the WHISPER_NEEDED prompt.
    const settings = await getSettings();

    // B站官方字幕 (human or ai-zh) 优先于本地文件。本地字幕（up-master-report
    // 之类）可能跟视频实际内容对不上号（标题错配、bvid 错位），所以 B站自己有
    // 就别看本地。
    const bilibiliSubtitle = await fetchBilibiliOfficialSubtitle(videoId, page.cid);
    if (bilibiliSubtitle) {
      return withVideoMeta(bilibiliSubtitle);
    }

    // 本地文件 fallback：B站没字幕时才看本地（whisper 旧 cache / up-master-report
    // / bililearn 自己生成的 .md/.txt/.srt）
    if (settings.whisperUrl && settings.subtitlesDir) {
      const localFile = await loadLocalSubtitleFile(
        videoId,
        videoTitle,
        channelName,
        pubDate,
        settings,
        page.cid
      );
      if (localFile) {
        return withVideoMeta({
          success: true,
          source: "local-file",
          language: localFile.language || "unknown",
          chapters: localFile.chapters || [],
          transcript: Array.isArray(localFile.transcript) ? localFile.transcript : [],
          transcriptText: localFile.transcriptText || "",
          transcriptTextTimestamped: localFile.transcriptTextTimestamped || "",
          cachePath: localFile.cachePath,
        });
      }
    }

    // If local Whisper is enabled, look for a previously-cached transcript
    // before falling through to native subtitles. We do NOT auto-trigger
    // Whisper here — that requires an explicit user click — but we tell
    // the side panel which action is available.
    if (settings.asrProvider === "minimax") {
      // 2026-09-17 (Irene directive): MiniMax cloud ASR. Same download-
      // once-then-upload shape as whisper (downside already cached from a
      // previous whisper run is reused via the audio-cache layer); the
      // upload is to MiniMax's /v1/audio/transcriptions endpoint, auth is
      // a Bearer key. The server returns { text, segments?[] }; we map
      // segments to the canonical {start, end, text} shape the rest of
      // the pipeline expects, falling back to the plain text in a
      // single zero-length segment if segments are absent.
      if (!settings.minimaxAsrApiKey) {
        return {
          success: false,
          error: "MINIMAX_ASR_KEY_MISSING",
          message:
            "MiniMax cloud ASR is selected but no API key was filled in. Open bililearn Settings → 语音识别 → MiniMax 云端 ASR and paste your API key.",
        };
      }
      try {
        const audioBlob = await fetchBilibiliAudioBlob(videoId, page.cid, viewPayload);
        // 2026-09-17 (Irene directive, refined per official MiniMax docs):
        // The MiniMax ASR endpoint for users in mainland China is
        //   https://api.minimaxi.cn/v1/speech_to_text
        // (the .cn host, NOT api.minimaxi.com — a confusingly similar
        // hostname that resolves but always returns 404 for this path).
        // Model is the single "asr-1.0". The language hint goes in an
        // HTTP HEADER, not a multipart field. Segments only come back
        // when response_format is "verbose_json"; "json" returns the
        // joined text only.
        //
        // HARD LIMITS from the docs:
        //   - audio duration ≤ 500 seconds
        //   - file size ≤ 50 MB
        //   - supported formats: wav / aiff / flac / alac(m4a) / mp3 /
        //     aac / opus / ogg
        // Anything longer returns 400/413 and is NOT truncated. We do
        // NOT split the audio in this code path (per Irene — too much
        // surface area); we relay MiniMax's verbatim error message so
        // the user knows which limit they hit, and recommend switching
        // to local Whisper for longer videos.
        if (audioBlob && audioBlob.size > 50 * 1024 * 1024) {
          return {
            success: false,
            error: "MINIMAX_ASR_TOO_LARGE",
            message:
              "Audio is " +
              (audioBlob.size / 1024 / 1024).toFixed(1) +
              " MB but MiniMax cloud ASR rejects anything over 50 MB. Switch to 本地 Whisper for longer videos.",
          };
        }
        const form = new FormData();
        form.append("model", "asr-1.0");
        form.append("file", audioBlob, "bilibili.m4a");
        form.append("response_format", "verbose_json");
        const language = (settings.whisperLanguage || "").trim().toLowerCase();
        const headers = {
          Authorization: "Bearer " + settings.minimaxAsrApiKey,
        };
        if (language) headers.language = language;
        const ctrl = new AbortController();
        // 5-minute cap for the single upload. For a long network this
        // is tight, but the extension should surface the failure rather
        // than hang in an unawaitable state.
        const timer = setTimeout(() => ctrl.abort(), 5 * 60_000);
        let resp;
        try {
          resp = await fetch("https://api.minimaxi.cn/v1/speech_to_text", {
            method: "POST",
            headers,
            body: form,
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          // payload.error.message is the MiniMax-formatted reason
          // (e.g. "audio duration 623.4s exceeds the limit of 500s").
          const reason =
            payload.error && payload.error.message
              ? payload.error.message
              : "HTTP " + resp.status;
          return {
            success: false,
            error: "MINIMAX_ASR_HTTP_" + resp.status,
            message:
              "MiniMax cloud ASR refused the upload (" +
              reason +
              "). " +
              (resp.status === 400 || resp.status === 413
                ? "This usually means the audio is over 500 seconds or 50 MB; switch to 本地 Whisper for longer videos."
                : "Check the API key and the network."),
          };
        }
        const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
        const transcript = rawSegments
          .map((seg) => ({
            start: typeof seg.start === "number" ? seg.start : 0,
            end: typeof seg.end === "number" ? seg.end : 0,
            text: typeof seg.text === "string" ? seg.text : "",
          }))
          .filter((seg) => seg.text);
        // verbose_json should always include segments, but if for any
        // reason MiniMax returns only text we synthesise a single
        // 0-duration segment so the sidepanel still has something.
        if (!transcript.length && typeof payload.text === "string" && payload.text) {
          transcript.push({ start: 0, end: 0, text: payload.text });
        }
        const plainText = transcript.map((seg) => seg.text).join(" ");
        const timestampedText = transcript
          .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
          .join("\n");
        return withVideoMeta({
          success: true,
          source: "minimax-asr",
          language: payload.language || language || "unknown",
          chapters: [],
          transcript,
          transcriptText: plainText,
          transcriptTextTimestamped: timestampedText,
        });
      } catch (minimaxErr) {
        const aborted = minimaxErr && minimaxErr.name === "AbortError";
        return {
          success: false,
          error: aborted ? "MINIMAX_ASR_TIMEOUT" : (minimaxErr && minimaxErr.message) || "MINIMAX_ASR_FAILED",
          message: aborted
            ? "MiniMax cloud ASR timed out after 5 minutes."
            : "MiniMax cloud ASR failed: " + ((minimaxErr && minimaxErr.message) || "unknown error"),
        };
      }
    }

    if (settings.asrProvider === "whisper") {
      // Pass the same metadata the write path uses, so loadCachedTranscript
      // can resolve to the {date}_{title}_{UP}.json file instead of the
      // legacy bvid_cid.json name.
      const cached = await loadCachedTranscript(
        videoId,
        page.cid,
        settings,
        videoTitle,
        channelName,
        pubDate,
      );
      if (cached) {
        // Normalize at the read boundary too — older caches may have been
        // written with the {from, to, content} shape before this fix.
        const canonicalTranscript = (cached.transcript || [])
          .map(normalizeSegment)
          .filter(Boolean);
        // Both fields are needed by the sidepanel:
        //   transcriptText          -> currentTranscriptText (display / export)
        //   transcriptTextTimestamped -> currentTranscriptTimestamped (AI prompts)
        // The local-cache path only has the timestamped form, so we
        // derive the plain form by stripping the `[M:SS] ` prefix.
        const plainText = canonicalTranscript
          .map((seg) => seg.text)
          .join(" ");
        const timestampedText = canonicalTranscript
          .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
          .join("\n");
        return withVideoMeta({
          success: true,
          source: "local-cache",
          language: cached.language || "unknown",
          chapters: cached.chapters || [],
          transcript: canonicalTranscript,
          transcriptText: plainText,
          transcriptTextTimestamped: timestampedText,
          cachePath: cached.cachePath,
        });
      }
      // No cache: ask the user to opt in. sidepanel renders a button.
      return {
        success: false,
        error: "WHISPER_NEEDED",
        message:
          "没有找到官方字幕或本地字幕文件。点击下方按钮启动 Whisper 转写，结果会保存到字幕目录供下次直接使用。",
        cacheDir: settings.subtitlesDir || "",
      };
    }

    // Nothing else worked: bail.
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message: "B 站没有字幕，本地也没有缓存文件。",
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// MINIMAX ANALYSIS
// ============================================================

/**
 * Sends the transcript to minimax for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  videoMeta,
) {
  // 2026-09-02: slow-run notification clock (see
  // notifyAnalysisDoneIfSlow) — starts at handler entry so the
  // measured time matches what the user perceives as「概览在跑」.
  const analysisStartedAt = Date.now();
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured. Open bililearn Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[dk-bililearn] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    // Slow-run completion notification (2026-09-02) — same rule as the
    // summary one: a run that crossed the 1-minute line very likely
    // outlasted the user's attention in the panel, so ping them the same
    // way. Fast runs stay silent. The user can also disable the
    // notification entirely via the options page toggle.
    notifyAnalysisDoneIfSlow({
      videoId: (videoMeta && videoMeta.videoId) || "",
      videoUrl: (videoMeta && videoMeta.videoUrl) || "",
      videoTitle,
      channelName,
      elapsedMs: Date.now() - analysisStartedAt,
    });

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Converts the FULL transcript into a complete, structured study note
 * (Markdown) using minimax. Unlike the overview, this deliberately asks
 * for exhaustive coverage — every detail, data point and conclusion.
 *
 * @param {string} transcriptText - Transcript prefixed with [M:SS] markers
 * @param {string} videoTitle - Video title for context
 * @param {string} channelName - Channel/UP 主 name for context
 * @returns {Promise<{success: boolean, markdown?: string, error?: string, message?: string}>}
 */
async function handleSummarizeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoMeta,
) {
  // Slow-run notification clock (see notifySummaryDoneIfSlow): starts at
  // request entry so the measured time matches what the user perceives
  // as「总结在跑」.
  const summaryStartedAt = Date.now();
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured. Open bililearn Settings.",
      };
    }

    const promptVariables = {
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "summary.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "summary.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[dk-bililearn] Requesting transcript summary", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // A summary that crossed the 1-minute line very likely outlasted the
    // user's attention in the panel — ping them the same way a slow
    // transcription does. Fast runs stay silent (user is still watching).
    notifySummaryDoneIfSlow({
      videoId: (videoMeta && videoMeta.videoId) || "",
      videoUrl: (videoMeta && videoMeta.videoUrl) || "",
      videoTitle,
      channelName,
      elapsedMs: Date.now() - summaryStartedAt,
    });

    return {
      success: true,
      markdown: (responseText || "").trim(),
    };
  } catch (error) {
    console.error("Summary error:", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to summarize transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from minimax
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS moved to the top of the file so it
  // is available to all functions (including the early-declared local
  // Whisper integration).

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active Bilibili tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using minimax.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
) {
  try {
    const [bvid, partToken] = String(videoId || "").split("@p");
    const part = Math.max(1, Number(partToken) || 1);
    const canonicalVideoUrl = `${YTD_SETTINGS.canonicalBilibiliUrl(bvid)}${part > 1 ? `?p=${part}` : ""}`;
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the bililearn cache. The side panel
    // saves analyses to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      // Read under both the current prefix and the legacy (pre-rename)
      // prefix; sidepanel.loadFromCache handles the actual migration.
      const newKey = `bililearn_${videoId}`;
      const legacyKey = `bilidown_${videoId}`;
      const cached = await chrome.storage.local.get([newKey, legacyKey]);
      const entry = cached[newKey] || cached[legacyKey];
      if (entry?.transcript) {
        transcript = entry.transcript;
        debugLog("[dk-bililearn] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[dk-bililearn] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(bvid, canonicalVideoUrl, part);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with minimax.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}${canonicalVideoUrl.includes("?") ? "&" : "?"}t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[dk-bililearn] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Saves the full summary note as a single note entry.
 * Unlike handleSaveNote, the text is the raw AI-generated Markdown note —
 * no transcript lookup, no minimax cleanup needed.
 */
async function handleSaveSummaryNote(videoId, videoTitle, channelName, summaryText) {
  try {
    const [bvid, partToken] = String(videoId || "").split("@p");
    const part = Math.max(1, Number(partToken) || 1);
    const canonicalVideoUrl = `${YTD_SETTINGS.canonicalBilibiliUrl(bvid)}${part > 1 ? `?p=${part}` : ""}`;
    const text = typeof summaryText === "string" ? summaryText.trim() : "";

    if (!text) {
      return { success: false, error: "Empty summary" };
    }

    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: "全文",
      timestampSeconds: 0,
      timestampedUrl: canonicalVideoUrl,
      text: text,
      rawText: text,
      isFullNote: true,
      createdAt: Date.now(),
    };

    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[dk-bililearn] Save summary note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using minimax.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!YTD_SETTINGS.activeApiKey(settings)) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[dk-bililearn] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[dk-bililearn] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[dk-bililearn] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[dk-bililearn] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using minimax.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return { success: false, error: "AI provider API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // minimax JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[dk-bililearn] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single minimax call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
};
