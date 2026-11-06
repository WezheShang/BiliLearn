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
// KB management (2026-10-03 spec): shared pure helpers, server fetch
// wrapper, and the background queue consumer for incremental LLM updates.
importScripts("kb-shared.js");
importScripts("kb-client.js");
importScripts("kb-queue.js");

// KB queue consumer: bind alarm listener + restore schedule on SW wake.
try {
  KbQueue.bindAlarm();
  KbQueue.reschedule();
} catch (e) {
  console.warn("[kb] init failed:", e);
}
// 2026-10-10: bootstrap "notes" KB on SW wake so it always exists once the
// user has opted into KB management. Best-effort — server may be offline.
try {
  ensureNotesKbOnInit();
} catch (e) {
  console.warn("[kb-notes] ensure on init failed:", e);
}

const DEBUG = true;
// 2026-10-27: 构建指纹 —— 侧边栏启动时跟后台握手比对。
// 改了 background.js 之后，浏览器里的 Service Worker 可能还在跑内存里的
// 旧脚本（必须去 chrome://extensions 点一次"刷新"才会换），而侧边栏是每次
// 打开都重新读盘的 —— 于是出现"面板是新的、后台是旧的"这种半新半旧状态。
// 症状是报错长得莫名其妙：2026-10-27 学堂在线那次，旧后台不认识 xt- 开头的
// videoId，把它当 B 站处理，抛出 "Invalid Bilibili BV ID."。
// 版本对不上时侧边栏直接提示去刷新扩展，而不是让旧后台把请求处理坏。
const BG_BUILD = "2026-11-06.1";
const SW_STARTED_AT = Date.now();
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

/**
 * 合并写入设置（保留其它字段）。
 *
 * 2026-11-05: 自动修复旧 whisper server 时要把 whisperUrl 切到备用端口。
 * 之前没有这个辅助函数 —— 只有 options.js 的表单保存路径能写设置，
 * background 这边写不了。
 */
async function setSettings(patch) {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const previous = stored[YTD_SETTINGS.STORAGE_KEY] || {};
  const merged = YTD_SETTINGS.normalize({ ...previous, ...patch });
  await chrome.storage.local.set({ [YTD_SETTINGS.STORAGE_KEY]: merged });
  return merged;
}

/**
 * 从 whisperUrl 里取端口号，取不到就用默认的 7860。
 *
 * 2026-11-06：自动修复旧 server 时扩展会把 whisperUrl 切到备用端口 7861，
 * 所以"启动 server"必须知道用户当前配的是哪个端口 —— 否则拉起来的实例
 * 和扩展连的不是一个端口，永远连不上。
 */
function portFromWhisperUrl(url) {
  const m = /:(\d{2,5})(?:[\/?#]|$)/.exec(String(url || "").trim());
  return m ? Number(m[1]) || 7860 : 7860;
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
  // Optional: when present, bypass storage settings entirely (used by the
  // Ask-AI drawer's per-question provider switcher so picking a different
  // model in the dropdown doesn't mutate the user's global provider).
  settingsOverride,
  // 2026-10-16: ask the provider to skip its reasoning pass. Only honoured
  // for providers that document the field (see THINKING_CAPABLE below). This
  // exists because of the Ask-AI classifier: it asks for a bare YES/NO with
  // a tiny max_tokens budget, and a thinking model (glm-4.6) spends that
  // whole budget on `reasoning_content` and never emits `content` at all —
  // which surfaced to the user as "AI provider returned an empty response."
  disableThinking,
}) {
  const settings = settingsOverride || (await getSettings());
  const activeKey = settingsOverride
    ? settingsOverride.apiKey
    : YTD_SETTINGS.activeApiKey(settings);
  // 2026-10-16: 防御 —— 解析最终请求 URL, 任何环节掉链子 .replace() 都会抛
  // "Cannot read properties of undefined (reading 'replace')"。这是 9/3
  // 实测反复出现的 fail 模式 (用户 10/16 截图). 改用 chatCompletionsUrl() 单
  // 入口, 然后再 strip 末尾的 /chat/completions 得到 baseUrl; 任何一步返回
  // 空串 / 异常就抛 NO_BASE_URL 让上层能定位, 而不是 generic replace 错。
  let baseUrl = "";
  try {
    if (settingsOverride && settingsOverride.baseUrl) {
      baseUrl = String(settingsOverride.baseUrl);
    } else {
      const fullUrl = YTD_SETTINGS.chatCompletionsUrl(settings);
      baseUrl = String(fullUrl).replace(/\/chat\/completions$/, "");
    }
  } catch (e) {
    baseUrl = "";
  }
  if (!baseUrl || typeof baseUrl !== "string") {
    const error = new Error(
      "AI provider base URL is missing. Re-save AI Provider in options.",
    );
    error.code = "NO_BASE_URL";
    throw error;
  }
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
  // 2026-10-16: GLM (Zhipu) also understands `thinking.type = "disabled"`.
  // Only sent when the caller opted in AND the provider is known to accept
  // it — an unrecognised field is not worth risking a 400 on a provider that
  // validates strictly.
  const THINKING_CAPABLE = new Set(["minimax", "glm"]);
  if (
    disableThinking &&
    !isMinimax &&
    THINKING_CAPABLE.has(settings.provider)
  ) {
    body.thinking = { type: "disabled" };
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
    // 2026-10-16: 改用上面解析的 baseUrl, 不再依赖 settingsOverride.baseUrl
    // (那个值可能在某些 provider 路径下是 undefined, .replace 抛错).
    const apiUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(
      apiUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeKey}`,
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

// ---- Native messaging launcher (2026-10-10 rewrite) ----------------
// The old "launch whisper server" path (stage the .vbs into Downloads
// via chrome.downloads, then downloads.open) was dead on arrival twice:
// chrome.runtime.getURL() in MV3 ALWAYS returns chrome-extension:// URLs
// so the file:// co-location guard could never pass, and .vbs/.bat sit
// on Chrome's dangerous-file list so downloads.open() refuses them
// anyway. Native messaging is the one Chrome-sanctioned way for an
// extension to start a local program, so the whisper launch / autostart
// buttons now talk to a registered host (bililearn_whisper_launcher.bat
// in this repo). Registration is a one-time double-click of a generated
// .bat; see buildNativeRegisterBat below and the options-page card.
const NATIVE_HOST_NAME = "com.bililearn.launcher";

// Resolve sendNativeMessage's callback style into a promise. Never
// rejects: failures come back as {response:null, error:"..."} so callers
// can classify (not-registered vs host-side failure) in one place.
function sendNativeLaunch(payload, timeoutMs) {
  return new Promise((resolve) => {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      typeof chrome.runtime.sendNativeMessage !== "function"
    ) {
      resolve({
        response: null,
        error: "nativeMessaging API unavailable (extension needs reload)",
      });
      return;
    }
    let settled = false;
    const finish = (response, error) => {
      if (settled) return;
      settled = true;
      resolve({ response: response || null, error: error || "" });
    };
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
        const err =
          chrome.runtime.lastError && chrome.runtime.lastError.message
            ? chrome.runtime.lastError.message
            : "";
        finish(response, err);
      });
    } catch (e) {
      finish(null, String((e && e.message) || e));
    }
    setTimeout(
      () => finish(null, "native host timeout"),
      timeoutMs || 15000,
    );
  });
}

// True when the error text means "the host is not registered for THIS
// extension id" (never registered, stale id after a reinstall, or the
// nativeMessaging permission missing after an update) — all of which the
// options page answers with the one-time registration card. Matched
// against Chrome's own error phrasing only: a HOST-side failure such as
// "vbs not found" must NOT trigger the registration card.
function isNativeNotRegisteredError(errText) {
  return /native messaging host not found|forbidden|native host has exited|communicating with the native|nativeMessaging/i.test(
    String(errText || ""),
  );
}

// Build the one-time native-host registration .bat. Pure function (no
// chrome.* access) so the test suite can exercise it directly. `extId`
// is the calling extension's runtime id; `repoDir` is the on-disk
// extension folder, or "" — the bat then prompts interactively, because
// a page context has no other way to learn an unpacked extension's disk
// path. The bat writes the host manifest JSON (path escapes doubled for
// JSON via %BILILEARN_DIR:\=\\%) and the HKCU registry key; both are
// per-user, so no admin prompt is needed and no Chrome restart either.
function buildNativeRegisterBat(extId, repoDir) {
  const dir = String(repoDir || "")
    .replace(/["]+/g, "")
    .replace(/[\\]+$/, "");
  return [
    "@echo off",
    "setlocal enableextensions",
    "rem BiliLearn native launcher registration (one-time).",
    "rem Registers " +
      NATIVE_HOST_NAME +
      " for chrome-extension://" +
      extId +
      "/",
    "",
    'set "BILILEARN_DIR=' + dir + '"',
    "if not defined BILILEARN_DIR set /p BILILEARN_DIR=BiliLearn extension folder (e.g. C:\\Users\\you\\bilidown): ",
    'if "%BILILEARN_DIR%"=="" (echo No folder given. & pause & exit /b 1)',
    'if "%BILILEARN_DIR:~-1%"=="\\" set "BILILEARN_DIR=%BILILEARN_DIR:~0,-1%"',
    'if not exist "%BILILEARN_DIR%\\start_whisper_server_silent.vbs" (echo That folder does not look like the BiliLearn extension - start_whisper_server_silent.vbs not found. & pause & exit /b 1)',
    "",
    'set "HOSTDIR=%LOCALAPPDATA%\\bililearn-native"',
    'if not exist "%HOSTDIR%" mkdir "%HOSTDIR%"',
    "",
    '>"%HOSTDIR%\\com.bililearn.launcher.json" echo {"name":"com.bililearn.launcher","description":"BiliLearn whisper server launcher","path":"%BILILEARN_DIR:\\=\\\\%\\\\bililearn_whisper_launcher.bat","type":"stdio","allowed_origins":["chrome-extension://' +
      extId +
      '/"]}',
    "",
    'reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' +
      NATIVE_HOST_NAME +
      '" /ve /t REG_SZ /d "%HOSTDIR%\\com.bililearn.launcher.json" /f >nul',
    "if errorlevel 1 (echo Failed to write the registry key. & pause & exit /b 1)",
    "",
    "echo.",
    "echo Registered! Go back to the BiliLearn options page and press the start button again.",
    "pause",
  ].join("\r\n");
}

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  // 2026-10-27: 版本握手。侧边栏靠它判断"后台是不是还在跑旧代码"。
  if (message.action === "getExtensionBuild") {
    sendResponse({ success: true, build: BG_BUILD, startedAt: SW_STARTED_AT });
    return false;
  }

  // 2026-10-27: 学堂在线官方章节摘要（leaf_knowledge）。
  // 课程自带的章节 → 直接当「章节时间线」用，不跑 AI。
  // 数据是页面上下文里抓的（带页面自己的 cookie），这里只做转发。
  if (message.action === "getXuetangxKnowledgeGuide") {
    (async () => {
      try {
        const tabId = await findXuetangxTabId();
        const state = await getXuetangxStateForTab(tabId);
        const chapters = pickXuetangxOfficialChapters(state);
        sendResponse({
          success: true,
          // chapters = 官方章节（AI 概览同款形状）
          chapters,
          // guide 保留字段但恒为 null —— 知识图谱那套 content 列表已经不用了
          guide: null,
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: (error && error.message) || String(error),
        });
      }
    })();
    return true;
  }

  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(
      message.videoId,
      message.videoUrl,
      message.pageNumber,
      { force: !!message.force },
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  // 2026-10-26: 学堂在线 —— 内容脚本（隔离世界）转来的页面状态。
  // 换小节时 URL 不变，侧边栏靠这条消息知道"要重新加载了"。
  if (message.action === "xuetangxStateChanged") {
    const tabId = sender?.tab?.id;
    const state = message.state || null;
    if (typeof tabId === "number" && state) {
      rememberXuetangxState(tabId, state);
      const videoId = state.videoId || `xt-${state.cid || "0"}-${state.leafId || "0"}`;
      debugLog(
        "[dk-bililearn BG] xuetangx state changed:",
        tabId,
        videoId,
        state.leafTitle || "",
      );
      // 通知侧边栏刷新（换小节 = 换视频）
      try {
        const p = chrome.runtime.sendMessage({
          action: "xuetangxVideoChanged",
          tabId,
          videoId,
        });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_e) {}
    }
    sendResponse({ success: true });
    return false;
  }

  // KB queue: sidepanel/options ask the SW to consume pending LLM updates
  // right away (manual mode button, or after adding a video).
  if (message.action === "kbKickQueue") {
    KbQueue.reschedule();
    KbQueue.consumeAllQueues().then(
      (r) => sendResponse(r),
      (e) => sendResponse({ ok: false, error: String(e && e.message || e) })
    );
    return true; // async response
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

  if (message.action === "askAiChat") {
    // Ask AI drawer chat — LLM decides per question whether the video
    // context is needed (two-stage: classifier call, then answer).
    handleAskAiChat(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
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

  if (message.action === "saveAskAiNote") {
    // 2026-10-10: ask-AI drawer's "save answer to notes" icon. Same shape as
    // saveSummaryNote but routed through handleSaveAskAiNote so we tag the
    // note with source="ask-ai" and a deterministic id prefix.
    handleSaveAskAiNote(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "saveSelectionNote") {
    // 2026-10-16: the 📝 pill on the text-selection bar (字幕/概览/总结).
    // Saves the selection verbatim, anchored to a transcript timestamp when
    // one is available. Routed to its own handler because the note shape
    // differs from both saveSummaryNote and saveAskAiNote: it keeps the
    // quote-style note schema so ▶ Play / 🔗 Copy timestamp stay usable.
    handleSaveSelectionNote(message)
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

  if (message.action === "getSubtitleCacheDir") {
    // 2026-11-05: 侧边栏的"读字幕超时"路径要把真实的字幕缓存目录显示
    // 出来。以前那条路径硬编码空串，于是提示语永远是"请先在设置里配置
    // 字幕缓存目录" —— 哪怕用户明明配了。getSettings 里有默认值兜底
    // （没配时落到 <下载目录>/BiliSubs），所以这里返回的一定是可用的
    // 绝对路径。
    getSettings()
      .then((settings) =>
        sendResponse({
          success: true,
          subtitlesDir: settings.subtitlesDir || "",
        }),
      )
      .catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
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

  // One-click "start Whisper server now". History: the 2026-09-23
  // version staged the silent vbs into Downloads and called
  // chrome.downloads.open on completion — that path never worked (see
  // the native-launcher comment above the sendNativeLaunch helper for
  // the two reasons), so the button was dead from birth.
  // 2026-10-10 rewrite: the whisper-server launch button now goes
  // through the registered native messaging host (see
  // sendNativeLaunch above). The response shape the options page acts
  // on: {success:true, via:"native"} on a clean launch;
  // {success:false, nativeNotRegistered:true, error} when the host
  // isn't registered for this extension (one-time registration card);
  // {success:false, error} for host-side failures (missing vbs, etc).
  if (message.action === "launchWhisperServerOnce") {
    (async () => {
      try {
        // 2026-11-06: 端口感知 + 自愈。
        //
        // ① 端口感知：扩展的 whisperUrl 可能被切到备用端口（7861）——
        //    当默认端口上跑的是旧代码（不会解析本地 HF 缓存 → 转写必 500）
        //    时，repairWhisperServer 会把扩展切过去。这时"启动 server"
        //    必须把 server 拉在**同一个端口**上，否则 server 起来了、扩展
        //    却还连着一个没人监听的端口 → 用户点一次启动、面板还是说
        //    "没在跑"，死循环。
        //
        // ② 自愈：开机自启任务（SYSTEM）永远把 server 拉在默认端口 7860，
        //    重启之后那上面跑的就是**新代码**了。所以"启动"的时候先探一下
        //    7860 —— 如果它在线、而且是新代码（/health 带 model_resolution
        //    字段），直接把 whisperUrl 切回去，连实例都不用再拉一个。
        const settings = await getSettings();
        const configuredUrl = (settings.whisperUrl || "").trim();
        const configuredPort = portFromWhisperUrl(configuredUrl);

        if (configuredPort !== 7860) {
          try {
            const r = await whisperServerFetch(
              "http://127.0.0.1:7860/health",
              { method: "GET" },
              3000,
            );
            if (r && r.ok) {
              const h = await r.json();
              if (h && h.model_resolution) {
                await setSettings({ whisperUrl: "http://127.0.0.1:7860" });
                sendResponse({
                  success: true,
                  via: "native",
                  switchedTo: 7860,
                  note:
                    "默认端口 7860 上的 server 已经是新代码，已直接切回去（不需要再拉实例）。",
                });
                return;
              }
            }
          } catch (_e) {
            /* 7860 上没有实例 → 下面按配置端口拉起 */
          }
        }

        const nat = await sendNativeLaunch({ cmd: "launch", port: configuredPort });
        if (nat.response && nat.response.success) {
          sendResponse({ success: true, via: "native", port: configuredPort });
          return;
        }
        const errText =
          nat.error ||
          (nat.response && nat.response.error) ||
          "native launch failed";
        sendResponse({
          success: false,
          via: "native",
          nativeNotRegistered: isNativeNotRegisteredError(errText),
          error: errText,
        });
      } catch (e) {
        sendResponse({
          success: false,
          error: String((e && e.message) || e),
        });
      }
    })();
    return true;
  }

  // 2026-11-05: 诊断 whisper server 的版本 + 自动修复旧实例。
  //
  // 用户报："点 Whisper 转录 → 500 LocalEntryNotFoundError: ConnectTimeout"
  // 根因：跑着的 server 是**开机自启任务拉起来的 SYSTEM 实例**，用的是
  // 旧代码 —— 旧代码不会解析本地 HF 缓存，每次都去 huggingface.co 下载，
  // 而本机直连不通 → ConnectTimeout。
  //
  // 那个进程普通用户权限杀不掉（taskkill: Access is denied），任务本身
  // 也查不了（schtasks: Access is denied）。所以"让用户去管理员终端重启"
  // 是唯一的老办法，但用户经常忘 / 懒得做。
  //
  // 这里做两件事：
  //   1) diagnoseWhisperServer —— 读 /health，看有没有 model_resolution
  //      字段（新代码才有）→ 判断跑的是不是旧代码。
  //   2) repairWhisperServer —— 在**备用端口**（7861）用用户权限拉起一个
  //      新实例，然后把 whisperUrl 切过去。完全不需要管理员权限。
  //      SYSTEM 那个旧进程变成无害僵尸，用户以后想清理再用管理员脚本。
  if (
    message.action === "diagnoseWhisperServer" ||
    message.action === "repairWhisperServer"
  ) {
    (async () => {
      const repair = message.action === "repairWhisperServer";
      try {
        const settings = await getSettings();
        const baseUrl = (settings.whisperUrl || "").replace(/\/+$/, "");
        let health = null;
        let reachable = false;
        try {
          const r = await whisperServerFetch(`${baseUrl}/health`, { method: "GET" }, 5000);
          if (r && r.ok) {
            reachable = true;
            health = await r.json();
          }
        } catch (_e) {
          /* server 不在线 */
        }
        // model_resolution 是 2026-11-05 新代码才有的字段。旧代码的
        // /health 没有它 → 判定为"跑的是旧代码"。
        const isStale = reachable && health && !health.model_resolution;
        const diag = {
          success: true,
          reachable,
          stale: !!isStale,
          baseUrl,
          health: health || null,
        };
        if (!repair) {
          sendResponse(diag);
          return;
        }

        // ---- 修复：备用端口起新实例 ----
        const sparePort = 7861;
        const spareUrl = `http://127.0.0.1:${sparePort}`;
        // 先看备用端口上是不是已经有健康的新实例了（避免重复拉起）
        try {
          const r = await whisperServerFetch(`${spareUrl}/health`, { method: "GET" }, 3000);
          if (r && r.ok) {
            const h = await r.json();
            if (h && h.model_resolution) {
              await setSettings({ whisperUrl: spareUrl });
              sendResponse({
                ...diag,
                success: true,
                repaired: true,
                alreadyRunning: true,
                whisperUrl: spareUrl,
              });
              return;
            }
          }
        } catch (_e) {
          /* 备用端口没有实例 —— 下面拉起 */
        }

        const nat = await sendNativeLaunch({ cmd: "restart", port: sparePort });
        if (!nat.response || !nat.response.success) {
          sendResponse({
            ...diag,
            success: false,
            error:
              nat.error ||
              (nat.response && nat.response.error) ||
              "启动新实例失败",
            nativeNotRegistered: isNativeNotRegisteredError(
              nat.error || (nat.response && nat.response.error) || "",
            ),
          });
          return;
        }
        // 等新实例就绪
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          try {
            const r = await whisperServerFetch(`${spareUrl}/health`, { method: "GET" }, 3000);
            if (r && r.ok) {
              const h = await r.json();
              if (h && h.model_resolution) {
                await setSettings({ whisperUrl: spareUrl });
                sendResponse({
                  ...diag,
                  success: true,
                  repaired: true,
                  whisperUrl: spareUrl,
                  port: sparePort,
                });
                return;
              }
            }
          } catch (_e) {
            /* 还没起来 */
          }
          await new Promise((res) => setTimeout(res, 1500));
        }
        sendResponse({
          ...diag,
          success: false,
          error: "新实例 60 秒内没有就绪，请查看 logs 目录下的日志。",
        });
      } catch (e) {
        sendResponse({
          success: false,
          error: String((e && e.message) || e),
        });
      }
    })();
    return true;
  }

  // One-time native-host registration: generate the register .bat with
  // THIS extension's runtime id baked in and hand it to Downloads. We
  // deliberately do NOT downloads.open it — .bat is on Chrome's
  // dangerous-file list (that is what killed the old launch button),
  // so the options card walks the user through opening Downloads and
  // double-clicking it once. After that the registry key exists and
  // every later "start" press goes straight through the native host.
  if (message.action === "downloadWhisperNativeRegister") {
    (async () => {
      try {
        const bat = buildNativeRegisterBat(
          chrome.runtime.id,
          (message.payload && message.payload.repoDir) || "",
        );
        const dataUrl =
          "data:application/octet-stream;base64," +
          btoa(unescape(encodeURIComponent(bat)));
        if (
          !chrome.downloads ||
          typeof chrome.downloads.download !== "function"
        ) {
          sendResponse({ success: false, error: "downloads API unavailable" });
          return;
        }
        chrome.downloads.download(
          {
            url: dataUrl,
            filename: "bililearn_register_native_launcher.bat",
            saveAs: false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
              sendResponse({
                success: false,
                error:
                  (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                  "download failed",
              });
              return;
            }
            sendResponse({ success: true, downloadId });
          },
        );
      } catch (e) {
        sendResponse({
          success: false,
          error: String((e && e.message) || e),
        });
      }
    })();
    return true;
  }

  // 2026-10-10 rewrite: auto-start install now goes through the same
  // registered native messaging host as the whisper launch button (the
  // old download-a-wrapper-ps1 path died on the same two bugs: the
  // file:// co-location guard that never passes in MV3, and a wrapper
  // that referenced setup_whisper_autostart_system.ps1 next to itself
  // in Downloads — where it never existed). The host spawns the real
  // setup ps1 from the extension folder with -Verb RunAs, so Windows
  // pops the same UAC prompt as before; the SYSTEM AtStartup task and
  // machine env var logic in that ps1 are unchanged.
  if (message.action === "installWhisperAutostart") {
    (async () => {
      try {
        const nat = await sendNativeLaunch({ cmd: "autostart", action: "install" });
        if (nat.response && nat.response.success) {
          // Mark in storage so the options page can flip its button to
          // an "uninstall" affordance next render.
          try {
            chrome.storage &&
              chrome.storage.local &&
              chrome.storage.local.set &&
              chrome.storage.local.set({
                bililearn_autostart_attempted: Date.now(),
              });
          } catch (_e) {}
          sendResponse({ success: true, via: "native" });
          return;
        }
        const errText =
          nat.error ||
          (nat.response && nat.response.error) ||
          "native autostart install failed";
        sendResponse({
          success: false,
          via: "native",
          nativeNotRegistered: isNativeNotRegisteredError(errText),
          error: errText,
        });
      } catch (e) {
        sendResponse({
          success: false,
          error: String((e && e.message) || e),
        });
      }
    })();
    return true;
  }

  // Uninstall counterpart — same native host, -Action uninstall. Same
  // UAC elevation (the setup ps1 silently no-ops if not admin). On a
  // clean launch we clear the local flag so the options page falls
  // back to showing "install" again.
  if (message.action === "uninstallWhisperAutostart") {
    (async () => {
      try {
        const nat = await sendNativeLaunch({ cmd: "autostart", action: "uninstall" });
        if (nat.response && nat.response.success) {
          try {
            chrome.storage &&
              chrome.storage.local &&
              chrome.storage.local.remove &&
              chrome.storage.local.remove(
                "bililearn_autostart_attempted",
              );
          } catch (_e) {}
          sendResponse({ success: true, via: "native" });
          return;
        }
        const errText =
          nat.error ||
          (nat.response && nat.response.error) ||
          "native autostart uninstall failed";
        sendResponse({
          success: false,
          via: "native",
          nativeNotRegistered: isNativeNotRegisteredError(errText),
          error: errText,
        });
      } catch (e) {
        sendResponse({
          success: false,
          error: String((e && e.message) || e),
        });
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
        // A tab can serve relay payloads if its content script handles
        // them: Bilibili video pages and YouTube watch pages.
        const isSupportedUrl = (u) => {
          if (!u) return false;
          return (
            u.includes("bilibili.com/video/") ||
            /^https:\/\/(www\.|m\.)?youtube\.com\/watch/.test(u) ||
            // 2026-10-26: 学堂在线课程播放页
            /(?:^|\.)xuetangx\.com\/(?:course|lesson|training)\//.test(u)
          );
        };

        // Query the active tab first to avoid side panel context issues;
        // fall back to broader queries to find the right tab.
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[dk-bililearn BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If the active tab isn't a supported video page, try any active
        // supported tab (the video may live in another window).
        if (!tabs[0] || !isSupportedUrl(tabs[0].url)) {
          tabs = await chrome.tabs.query({
            url: [
              "https://www.bilibili.com/video/*",
              "https://www.youtube.com/watch*",
              "https://m.youtube.com/watch*",
              "https://youtube.com/watch*",
              "https://*.xuetangx.com/*",
            ],
            active: true,
          });
          debugLog("[dk-bililearn BG] Active supported tabs:", tabs.length);
        }

        // Still nothing? Try any supported tab, active or not.
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({
            url: [
              "https://www.bilibili.com/video/*",
              "https://www.youtube.com/watch*",
              "https://m.youtube.com/watch*",
              "https://youtube.com/watch*",
              "https://*.xuetangx.com/*",
            ],
          });
          debugLog("[dk-bililearn BG] Any supported tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[dk-bililearn BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response;
          try {
            response = await chrome.tabs.sendMessage(
              tabs[0].id,
              message.payload,
            );
          } catch (sendErr) {
            const sendMsg = sendErr?.message || String(sendErr);
            const noReceiver =
              /Receiving end does not exist/i.test(sendMsg) ||
              /Could not establish connection/i.test(sendMsg);
            if (!noReceiver) throw sendErr;
            // The content script is orphaned — the page was loaded before
            // the extension (re)loaded, so the manifest-declared injection
            // never ran for it. Re-inject content.js on demand and retry
            // the message. This self-heals every relay path (getVideoInfo /
            // DOM transcript / playback polling) without requiring the
            // user to F5 the page. At most one re-inject attempt per tab
            // per service-worker lifetime — if it didn't take, further
            // failures flow to the outer catch as before.
            const reinjectedTabs = (globalThis.__bililearnRelayReinjectedTabs ??=
              new Set());
            if (!reinjectedTabs.has(tabs[0].id)) {
              reinjectedTabs.add(tabs[0].id);
              debugLog(
                "[dk-bililearn BG] No receiver on tab",
                tabs[0].id,
                "— re-injecting content.js, then retrying",
              );
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: tabs[0].id },
                  files: ["content.js"],
                });
              } catch (injectErr) {
                // Duplicate-load guard throw, world conflict, or injection
                // failure — fall through and retry the message anyway; if
                // the script really is alive the retry succeeds.
                debugLog(
                  "[dk-bililearn BG] Re-inject reported (may be benign):",
                  injectErr?.message || injectErr,
                );
              }
            }
            response = await chrome.tabs.sendMessage(
              tabs[0].id,
              message.payload,
            );
          }

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
          debugLog("[dk-bililearn BG] No supported tab found");
          sendResponse({ success: false, error: "No supported tab found" });
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
    const response = await whisperServerFetch(`${url}/cache?${qs}`, { method: "GET" });
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
 * @param {Object|undefined} args.view    x/web-interface/view 的 JSON
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
  view,
  playurlPayload,
  rawMessage,
} = {}) {
  // 1. view 接口自己报错（未登录 / 视频不存在 / 大会员）
  if (view && typeof view === "object") {
    const code = Number(view.code);
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
    view && view.data && Array.isArray(view.data.videos)
      ? view.data.videos[0]
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

async function fetchBilibiliAudioBlob(videoId, cid, view) {
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
      classifyBilibiliError({ view, playurlPayload: payload }),
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
      classifyBilibiliError({ view, playurlPayload: payload, rawMessage: "无法获取B站音轨地址。" }),
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
      view,
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
async function transcribeWithLocalWhisper(videoId, cid, settings, view) {
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
  const audioBlob = await fetchBilibiliAudioBlob(videoId, cid, view);
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
  const metaTitle = encodeURIComponent(view?.data?.title || "");
  const metaChannel = encodeURIComponent(view?.data?.owner?.name || "");
  const metaPubDate = view?.data?.pubdate
    ? new Date(view.data.pubdate * 1000).toISOString().split("T")[0]
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
    const response = await whisperServerFetch(
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

/**
 * 带硬超时的 fetch —— 用于所有对本地 whisper server 的请求。
 *
 * 2026-11-05（用户报"没字幕的视频要等 45 秒才出现 Whisper 按钮"）：
 *
 * 之前这些请求**完全没有超时**。fetch 只有在连接被拒/网络层出错时才会
 * 失败；server 进程"活着但卡住"（SYSTEM 账户跑旧代码、正在做 3 秒的
 * 全目录扫描、或在等一个永远不回的 socket）时，fetch 会**无限期挂着**。
 *
 * 后果链：background 的 handleFetchTranscript 一直 await → 永远不
 * sendResponse → sidepanel 的 45 秒 FETCH_TIMEOUT_MS 到点兜底 → 用户
 * 看到"正在获取字幕"转了 45 秒。
 *
 * 这个超时把"无限等"变成"最多等 N 秒就当没找到"，让链路能走到
 * WHISPER_NEEDED 提示。
 *
 * 注意：AbortError 要**吞掉**（当"没找到"处理），不能往上抛 ——
 * 否则整个 handleFetchTranscript 会跳进 catch，用户看到的是错误页
 * 而不是 Whisper 出路。
 */
const WHISPER_SERVER_FETCH_TIMEOUT_MS = 8000;

async function whisperServerFetch(url, options = {}, timeoutMs) {
  const limit = timeoutMs || WHISPER_SERVER_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      debugLog(
        `[dk-bililearn BG] whisper server request timed out after ${limit}ms:`,
        url,
      );
      // 返回一个"服务器没响应"的假响应，让调用方按 404/null 处理。
      return {
        ok: false,
        status: 0,
        statusText: "timeout",
        timedOut: true,
        json: async () => ({}),
        text: async () => "",
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
    const response = await whisperServerFetch(
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
  //
  // 2026-09-27: route by source — YouTube URLs / bare 11-char ids go
  // through runYouTubeWhisperPipeline (metadata + audio via yt-dlp on
  // the local whisper_server); everything else (BV... or bilibili.com)
  // falls back to the original B站 pipeline.
  const source = detectVideoSource(videoId) || detectVideoSource(videoUrl || "");
  if (source === "xuetangx") {
    // 2026-10-26: 学堂在线 —— 视频直链和字幕信息都在页面钩子捕获的状态里。
    const tabId = await findXuetangxTabId();
    const state = await getXuetangxStateForTab(tabId);
    if (!state) {
      throw new Error(
        "没拿到学堂在线当前小节的信息。请刷新课程页面后重试。",
      );
    }
    runXuetangxWhisperPipeline(state, settings).catch((e) =>
      debugLog(
        "[dk-bililearn BG] xuetangx whisper pipeline detached error:",
        e?.message || e,
      ),
    );
    return { success: true, started: true };
  }
  if (source === "youtube") {
    runYouTubeWhisperPipeline(videoId || videoUrl, settings).catch(
      (e) => debugLog("[dk-bililearn BG] youtube whisper pipeline detached error:", e?.message || e),
    );
    return { success: true, started: true };
  }
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
        classifyBilibiliError({ view: view, rawMessage: view.message || "无法读取 B 站视频信息。" }),
      );
    }
    // 充电视频：view 返回成功但 videos[0] 带付费标记 → 提前拦截，避免
    // playurl 再走一次才在 audio 为空时发现。
    const v0Header = view.data.videos?.[0] || null;
    const preCheck = classifyBilibiliError({ view: view });
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
 *
 * 2026-11-05: 改成**先走页面上下文，再走直连**。
 *
 * B站只对**登录用户**下发字幕列表；未登录时 /x/player/wbi/v2 返回
 * `need_login_subtitle: true` + 空列表（实测：无签名 / 旧版 / 正确 wbi
 * 签名三种调用方式结果完全一样 —— 问题不在签名，在登录态）。
 *
 * service worker 里 `credentials: "include"` 的跨站请求属于第三方上下文，
 * 浏览器默认挡第三方 cookie → 登录 cookie 送不出去 → 面板误判成
 * "这视频没有字幕"，直接叫用户上 Whisper。用户观察到的"明明有字幕，
 * sidebar 却让我用 whisper；过一会儿页面切来切去它自己出现了"，实际是
 * whisper 转录后落盘的本地文件命中了本地文件路径，不是官方字幕出现了。
 *
 * 所以第一优先：让**页面主世界**去取（Origin 是 www.bilibili.com、
 * cookie 是这一份登录态 —— B 站自己的播放器就是这么读的）。
 * 直连保留为兜底（比如用户没打开该 B 站视频页时）。
 */
async function fetchBilibiliOfficialSubtitle(videoId, cid) {
  // ---- 第一优先：页面上下文（带登录态） ----
  try {
    const pageResult = await fetchBilibiliOfficialSubtitleViaPage(videoId, cid);
    if (pageResult) return pageResult;
    // null = 页面上下文明确表示"这个视频没有字幕轨" → 不再往下试直连
    //（直连同样拿不到，白白多打一次接口）。
    return null;
  } catch (error) {
    debugLog(
      "[dk-bililearn BG] page-context subtitle lookup failed, falling back to direct:",
      error?.message || error,
    );
  }

  // ---- 兜底：service worker 直连 ----
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

  return buildBilibiliSubtitlePayload(data, preferred.lan || null, "direct");
}

/**
 * 2026-11-05: 通过**页面主世界**取 B站官方字幕。
 *
 * 链路：background → chrome.tabs.sendMessage → content.js（隔离世界）
 *        → window.postMessage → bilibili-subtitle-hook.js（主世界）
 *        → fetch(api.bilibili.com，带页面登录态）→ postMessage 回来。
 *
 * 返回：
 *   - transcript payload 对象 = 拿到了字幕
 *   - null                   = 页面上下文确认这个视频没有字幕轨（正常回退）
 *   - 抛异常                 = 链路本身坏了（没有 B 站标签页 / hook 没回话），
 *                               由调用方决定要不要退到直连。
 */
async function fetchBilibiliOfficialSubtitleViaPage(videoId, cid) {
  const tabId = await findBilibiliVideoTab(videoId);
  if (!tabId) {
    throw new Error("没有找到对应的 B 站视频标签页。");
  }

  // 第一发用短超时探测主世界钩子在不在。扩展刚更新/重载时，页面里
  // 早就存在的钩子不会被 manifest 重新注入（content_scripts 只在页面
  // 加载时跑一次），第一发必然超时 —— 这时我们自己注入一次钩子再重试，
  // 免得逼用户 F5 刷新页面。
  let response = await sendToBilibiliTab(tabId, {
    action: "getBilibiliOfficialSubtitles",
    bvid: videoId,
    cid: String(cid),
  });

  if (!response?.success && response?.reason === "hook_missing") {
    debugLog(
      "[dk-bililearn BG] Main-world hook missing on tab",
      tabId,
      "— injecting bilibili-subtitle-hook.js and retrying",
    );
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["bilibili-subtitle-hook.js"],
        world: "MAIN",
      });
    } catch (injectErr) {
      debugLog(
        "[dk-bililearn BG] Hook injection reported (may be benign):",
        injectErr?.message || injectErr,
      );
    }
    response = await sendToBilibiliTab(tabId, {
      action: "getBilibiliOfficialSubtitles",
      bvid: videoId,
      cid: String(cid),
      timeoutMs: 6000,
    });
  }

  if (!response) {
    throw new Error("B 站页面没有返回字幕列表。");
  }
  if (!response.success) {
    // no_tracks 是"确认没有字幕"，不是错误 → 正常回退，不抛。
    if (response.reason === "no_tracks") {
      debugLog(
        "[dk-bililearn BG] page context reports no subtitle tracks:",
        response.error,
      );
      return null;
    }
    throw new Error(response.error || "B 站页面取字幕失败。");
  }

  const tracks = Array.isArray(response.tracks) ? response.tracks : [];
  if (!tracks.length) return null;

  // 选轨顺序与直连一致：人工中文 → 任意中文（含 ai-zh）→ 第一条。
  const preferred =
    tracks.find((item) => /^(zh|zh-CN|zh-Hans|zh-TW)/i.test(item.lan || "") && !item.isAi) ||
    tracks.find((item) => /zh/i.test(item.lan || "")) ||
    tracks[0];
  if (!preferred?.subtitleUrl) return null;

  const payload = await downloadBilibiliSubtitleFile(
    preferred.subtitleUrl,
    videoId,
    cid,
  );
  if (!payload) return null;
  return buildBilibiliSubtitlePayload(payload, preferred.lan || null, "page-context");
}

/**
 * 发消息给 B 站标签页的内容脚本。
 * 内容脚本成孤儿（页面在扩展加载之前就打开了）时，先重新注入再试一次。
 *
 * 2026-11-05: 加**硬超时**。
 *
 * `chrome.tabs.sendMessage` 本身**没有超时机制** —— 如果内容脚本的
 * 监听器因为任何原因没有调用 sendResponse（页面正在跳转、监听器抛错、
 * 页面被冻结后恢复……），这个 Promise 会**无限期挂起**。
 *
 * 后果：sidepanel 的 fetchTranscript 有 45 秒兜底超时，但 45 秒一到就
 * 直接把整个读取判成失败 —— 而后台其实还挂在那里。用户看到的是
 * "load 半天 + 后台没有响应：读取字幕超时（45 秒没有响应）"，却拿不到
 * 任何有用的诊断信息（连"到底卡在哪一步"都看不到）。
 *
 * 这里给每次 sendMessage 加 8 秒上限：挂死就当"这次没通"，让上层走
 * 兜底路径（直连 / 报错），而不是把整个链路拖到 45 秒。
 */
const BILIBILI_TAB_MESSAGE_TIMEOUT_MS = 8000;

async function sendToBilibiliTab(tabId, message) {
  try {
    return await sendToBilibiliTabWithTimeout(tabId, message);
  } catch (sendErr) {
    const msg = sendErr?.message || String(sendErr);
    const noReceiver =
      /Receiving end does not exist/i.test(msg) ||
      /Could not establish connection/i.test(msg);
    if (!noReceiver) throw sendErr;

    // 孤儿内容脚本：重新注入 content.js（隔离世界）后重试。
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (injectErr) {
      debugLog(
        "[dk-bililearn BG] content.js re-inject reported (may be benign):",
        injectErr?.message || injectErr,
      );
    }
    // content.js 重新注入后，主世界钩子大概率还是旧的/没有的 —— 但
    // content.js 里的请求会自己带 hook_missing 标记，这里再抛上去，
    // 由上层决定要不要注入钩子。
    return await sendToBilibiliTabWithTimeout(tabId, message);
  }
}

/** 带硬超时的 tabs.sendMessage —— 超时按失败抛，不让调用方无限等。 */
function sendToBilibiliTabWithTimeout(tabId, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `B 站页面 ${BILIBILI_TAB_MESSAGE_TIMEOUT_MS / 1000} 秒没有回话（内容脚本可能卡住了）。`,
        ),
      );
    }, BILIBILI_TAB_MESSAGE_TIMEOUT_MS);
    try {
      Promise.resolve(chrome.tabs.sendMessage(tabId, message)).then(
        (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * 下载 B站字幕文件本体。
 *
 * 主路径：service worker 直连（manifest 里有 https://*.hdslb.com/* 的
 * host 权限，DNR 规则还给它补了 Referer）。
 * 备用：SW 直连失败（403 / 跨域被拦）→ 让页面主世界用页面的身份再试。
 */
async function downloadBilibiliSubtitleFile(subtitleUrl, videoId, cid) {
  try {
    const res = await fetch(subtitleUrl, { credentials: "include", cache: "no-store" });
    if (res.ok) return await res.json();
    debugLog("[dk-bililearn BG] SW subtitle download failed:", res.status, subtitleUrl);
  } catch (error) {
    debugLog("[dk-bililearn BG] SW subtitle download threw:", error?.message || error);
  }

  // 备用：页面主世界
  try {
    const tabId = await findBilibiliVideoTab(videoId);
    if (!tabId) return null;
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getBilibiliSubtitleFile",
      url: subtitleUrl,
      bvid: videoId,
      cid: String(cid),
    });
    if (response?.success && response.body) {
      return { body: response.body };
    }
  } catch (error) {
    debugLog(
      "[dk-bililearn BG] page-context subtitle file download failed:",
      error?.message || error,
    );
  }
  return null;
}

/**
 * 找当前打开的 B 站视频标签页（优先匹配 videoId 所在的那一个）。
 * 找不到返回 null —— 调用方据此退到直连。
 */
async function findBilibiliVideoTab(videoId) {
  const patterns = ["https://www.bilibili.com/video/*"];
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch (_e) {
    tabs = [];
  }
  if (!tabs.length) return null;

  // 优先：URL 里带这个 bvid 的标签页
  if (videoId) {
    const match = tabs.find((tab) => String(tab.url || "").includes(videoId));
    if (match) return match.id;
  }
  // 其次：当前活动标签页
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeMatch = active.find((tab) => String(tab.url || "").includes("bilibili.com/video/"));
    if (activeMatch) return activeMatch.id;
  } catch (_e) {
    /* ignore */
  }
  return tabs[0].id ?? null;
}

/**
 * 把 B站字幕文件（{ body: [{from,to,content}] }）转成统一的 transcript 形状。
 * via 用来标记这条字幕是从哪条链路拿到的（page-context / direct）。
 */
function buildBilibiliSubtitlePayload(data, language, via) {
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  const body = data && Array.isArray(data.body) ? data.body : [];
  for (const chunk of body) {
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
      language: language || null,
    });
    transcriptTextPlain += cleanText + " ";
    transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
  }

  if (transcript.length === 0) return null;

  return {
    success: true,
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: language || null,
    source: "bilibili-subtitle",
    via,
  };
}

// ---------------------------------------------------------------------------
// YouTube helpers (2026-09-27)
//
// Mirror of the B站 fetchers above, but every step goes through the local
// whisper_server (port 7860) because:
//   - youtube.com is reachable only via the system proxy (HKCU registry
//     ProxyEnable=1 → 127.0.0.1:15236); the SW cannot reach youtube.com
//     directly.
//   - yt-dlp lives in the server's Python (miniconda3) env.
//   - server has the cookies / format-selection / post-processing helpers.
//
// All functions take `(videoIdOrUrl, settings)` so the sidepanel can
// pass user-configured proxy + cookies file without the SW having to
// persist its own copy.
// ---------------------------------------------------------------------------

// Canonical YouTube video id = 11 chars from `[A-Za-z0-9_-]`. We accept
// EITHER a bare id (11 chars) OR a full youtube.com / youtu.be URL.
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_URL_ID_RE = /(?:youtu\.be\/|[?&]v=|\/(?:shorts|embed)\/)([A-Za-z0-9_-]{11})/;

function normalizeYouTubeInput(raw) {
  if (!raw) return null;
  const candidate = String(raw).trim();
  if (YT_ID_RE.test(candidate)) return { videoId: candidate, url: `https://www.youtube.com/watch?v=${candidate}` };
  const m = candidate.match(YT_URL_ID_RE);
  if (m) return { videoId: m[1], url: candidate };
  return null;
}

function detectVideoSource(raw) {
  // "bilibili" | "youtube" | "xuetangx" | null. The sidepanel uses this to
  // route transcripts / button-injection to the right pipeline.
  if (!raw) return null;
  // 2026-10-27: videoId 可能带 "@pN" 后缀（B站分 P / 学堂在线小节）。
  // 判定平台之前先把这个后缀摘掉 —— 否则 "xt-123-456@p1" 认不出来，
  // 会一路掉进 B 站分支，报出 "Invalid Bilibili BV ID." 这种天书。
  const s = String(raw).trim().replace(/@p\d+$/i, "");
  if (!s) return null;
  if (YT_ID_RE.test(s) || /youtube\.com|youtu\.be/.test(s)) return "youtube";
  if (/^BV[0-9A-Za-z]+$/i.test(s) || /bilibili\.com\/video\//.test(s)) return "bilibili";
  // 2026-10-26: 学堂在线。id 形如 xt-{classroomId}-{leafId}；
  // URL 形如 https://www.xuetangx.com/course/{products_sign}/{classroom_id}
  if (/^xt-\d+-\d+$/i.test(s) || /(?:^|\.)xuetangx\.com\//i.test(s)) {
    return "xuetangx";
  }
  return null;
}

// 2026-10-03: canonical watch URL for BOTH platforms. The note-save
// handlers (handleSaveNote / handleSaveSummaryNote) used to call
// canonicalBilibiliUrl unguarded, which threw "Invalid Bilibili BV ID."
// on 11-char YouTube ids — every "保存整篇至笔记" on a YouTube video
// failed with 保存失败. YouTube ids never contain "@p" (charset is
// [A-Za-z0-9_-]), so the split is bilibili-only, same as before.
function canonicalWatchUrlForVideoId(rawVideoId) {
  const [bvid, partToken] = String(rawVideoId || "").split("@p");
  if (detectVideoSource(bvid) === "youtube") {
    return `https://www.youtube.com/watch?v=${bvid}`;
  }
  // 2026-10-26: 学堂在线。id 形如 xt-{cid}-{leafId}，课程 URL 需要
  // products_sign —— 页面钩子捕获状态时记下来了，这里查表还原。
  if (detectVideoSource(bvid) === "xuetangx") {
    const meta = xuetangxMetaByVideoId.get(bvid);
    // 页面地址本身带小节 id，笔记/导出直接用它最准
    if (meta && meta.pageUrl) return meta.pageUrl;
    if (meta && meta.sign) {
      const leaf = meta.leafId ? `?leaf_id=${meta.leafId}` : "";
      return `https://www.xuetangx.com/course/${meta.sign}/${meta.cid}${leaf}`;
    }
    const m = /^xt-(\d+)-(\d+)$/i.exec(bvid);
    const cid = m ? m[1] : "";
    return cid
      ? `https://www.xuetangx.com/course/${cid}`
      : "https://www.xuetangx.com/";
  }
  const part = Math.max(1, Number(partToken) || 1);
  return `${YTD_SETTINGS.canonicalBilibiliUrl(bvid)}${part > 1 ? `?p=${part}` : ""}`;
}

async function whisperServerPostJson(path, body, signal) {
  const url = (settings_whisperUrl_get()).replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error(`whisper_server ${path} returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || payload.ok === false) {
    const detail = payload.error || `HTTP ${res.status}`;
    throw new Error(`whisper_server ${path} failed: ${detail}`);
  }
  return payload;
}

let _cachedWhisperUrl = null;
function settings_whisperUrl_get() {
  if (_cachedWhisperUrl !== null) return _cachedWhisperUrl;
  // Synchronous wrapper around getSettings(); used in async fns that
  // already have `settings` in scope, so this fallback should never
  // actually fire. It's here to keep the helper self-contained.
  return _cachedWhisperUrl || "http://127.0.0.1:7860";
}

async function fetchYouTubeVideoInfo(rawInput, settings) {
  const norm = normalizeYouTubeInput(rawInput);
  if (!norm) throw new Error("无效的 YouTube URL 或视频 ID。");
  const payload = {
    url: norm.url,
    proxy: settings.youtubeProxy || "",
  };
  // 2026-09-28 (Irene regression): /youtube/info also needs cookies
  // for "Sign in to confirm" videos, otherwise extract_info raises
  // before we ever get a `subtitles` dict back. Use the shared helper
  // so /info, /audio and /subtitle see identical cookie resolution.
  const cookies = await resolveYouTubeCookies(settings);
  applyYouTubeCookies(payload, cookies);
  return await postYouTubeWithCookieFallback("/youtube/info", payload);
}

// 2026-09-29: ask the content script running in the YouTube watch
// tab to read the transcript straight from the DOM. The content script
// clicks "Show transcript" if needed, waits for the segment list to
// render, and returns a segments array in the same envelope as
// fetchYouTubeOfficialSubtitle. Returns null when:
//   - no active YouTube watch tab is focused (sidepanel opened with
//     no YouTube tab in front)
//   - the focused tab is a YouTube page that isn't a watch page
//     (e.g. /feed/trending)
//   - the content script responds with success:false (button missing
//     = video has no transcript)
// In all of those cases the caller falls through to the whisper_server
// path (which uses yt-dlp + cookies + proxy). The DOM path always wins
// for videos the user has open in their browser because the browser
// already has a TLS identity YouTube accepts.
async function fetchYouTubeTranscriptFromDOM() {
  let targetTab = null;
  try {
    // 1. Find the active YouTube watch tab. `lastFocusedWindow: true`
    //    prefers the window the user is currently looking at; we then
    //    filter to the URL pattern of a watch page (covers
    //    /watch?v=, /shorts/<id>, youtu.be/<id>, /embed/<id>).
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTab && activeTab.id && isYouTubeWatchUrl(activeTab.url)) {
      targetTab = activeTab;
    } else {
      // 2. No active match — look across all windows for any open
      //    YouTube watch tab. The sidepanel may be opened in window
      //    A while the user has YouTube in window B.
      const allYouTube = await chrome.tabs.query({});
      const watchTab = allYouTube.find(
        (t) => t.url && isYouTubeWatchUrl(t.url),
      );
      if (watchTab) targetTab = watchTab;
    }
  } catch (e) {
    debugLog("[dk-bililearn BG] tab query failed:", e?.message || e);
    return null;
  }

  if (!targetTab) {
    debugLog("[dk-bililearn BG] no YouTube watch tab found for DOM transcript");
    return null;
  }

  // 3. Message the content script. Some browser versions throttle
  //    background→content messaging when the tab isn't visible, so
  //    we wrap with a Promise.race timeout — if the content script
  //    doesn't reply within 5s we fall back to whisper_server.
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(targetTab.id, {
        action: "getYouTubeTranscriptFromDOM",
      }),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 5000)),
    ]);
    if (!reply || reply.__timeout) {
      debugLog("[dk-bililearn BG] DOM transcript timed out for tab", targetTab.id);
      return null;
    }
    if (!reply.success) {
      debugLog(
        "[dk-bililearn BG] DOM transcript unavailable:",
        reply.reason || reply.error,
      );
      return null;
    }
    // Attach videoId so the sidepanel can key its cache on the same
    // id it would for the whisper_server path.
    const norm = normalizeYouTubeInput(targetTab.url);
    if (norm) reply.videoId = norm.videoId;
    return reply;
  } catch (e) {
    // No content script listening (e.g. sidepanel opened for a YouTube
    // tab where the manifest didn't inject content.js — e.g. an
    // embedded player). The catch-all returns null so the caller
    // falls back to whisper_server.
    debugLog(
      "[dk-bililearn BG] DOM transcript sendMessage failed:",
      e?.message || e,
    );
    return null;
  }
}

function isYouTubeWatchUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (
      host !== "www.youtube.com" &&
      host !== "youtube.com" &&
      host !== "m.youtube.com" &&
      host !== "youtu.be" &&
      !host.endsWith(".youtube.com")
    ) {
      return false;
    }
    // /watch?v=<id> OR /shorts/<id> OR /embed/<id> OR youtu.be/<id>
    if (u.pathname === "/watch") return !!u.searchParams.get("v");
    if (u.pathname.startsWith("/shorts/")) return true;
    if (u.pathname.startsWith("/embed/")) return true;
    if (host === "youtu.be" && u.pathname.length > 1) return true;
    return false;
  } catch {
    return false;
  }
}
// whisper_server endpoints (/info, /audio, /subtitle) need cookies
// when the video is gated by the "Sign in to confirm" wall; this
// helper returns the cookie payload the extension should pass to the
// server.
//
// Priority (2026-10-01, Irene: "make cookies automatic, like the
// Bilibili path"):
//   `settings.youtubeCookiesMode` selects the chain —
//   "auto"   (default) chrome.cookies auto-fetch FIRST — the
//            extension reads the user's YouTube cookies straight
//            from Chrome and forwards them as Netscape text. Zero
//            manual steps, exactly like the Bilibili fetches ride
//            on credentials:"include". Storage forensics
//            (2026-10-01, local Default profile): the full auth set
//            (SID / HSID / SSID / SAPISID / APISID / LOGIN_INFO /
//            __Secure-1PSID / __Secure-1PSIDTS) lives on
//            `.youtube.com` and is NOT CHIPS-partitioned
//            (top_frame_site_key empty), so the plain
//            chrome.cookies.getAll domain query reaches it. When no
//            auth cookies exist (Chrome not logged in) we send
//            nothing — yt-dlp tries unauthenticated, which works
//            for public videos on un-flagged IPs.
//   "manual" pasted text > cookies file path > the same auto-fetch
//            (the 2026-09-28 chain, but the paste no longer shadows
//            auto — auto is only consulted when manual fields are
//            empty, and ONLY in manual mode).
//   "none"   never send cookies — public videos only.
//
// NOT in the auto chain anymore: cookiesFromBrowser ("chrome") —
// server-side yt-dlp reads Chrome's SQLite cookie store directly.
// Sounded like the closest match to the Bilibili approach, but
// live-tested 2026-10-01: "ERROR: Could not copy Chrome cookie
// database" (yt-dlp issue #7271) whenever Chrome is running on
// Windows. Dead on arrival for the common case; the server endpoint
// still accepts the field for exotic setups.
//
// Returns `{cookiesFile?, cookiesText?}`. Both fields can be absent
// — the server still runs (yt-dlp tries unauthenticated) and
// surfaces a clean 403 for restricted videos.
async function resolveYouTubeCookies(settings) {
  const mode = settings.youtubeCookiesMode || "auto";
  if (mode === "none") return {};
  if (mode === "manual") {
    const text = (settings.youtubeCookiesText || "").trim();
    if (text) {
      // Length guard mirrors whisper_server's 64 KB cap so the user
      // gets the same error message at the extension layer instead
      // of only seeing the server's "invalid_input" raise.
      if (text.length > 64 * 1024) {
        console.warn(
          `[bililearn] youtubeCookiesText is ${text.length} bytes; whisper_server caps at 65536 — the field will be truncated.`,
        );
      }
      return { cookiesText: text };
    }
    const file = (settings.youtubeCookiesFile || "").trim();
    if (file) return { cookiesFile: file };
  }
  // auto mode (and manual mode with both manual fields empty):
  // read the browser's YouTube cookies directly. No auth cookies
  // found → empty object → unauthenticated attempt, which still
  // succeeds for public videos on IPs YouTube hasn't flagged.
  try {
    const netscape = await fetchYouTubeNetscapeCookies();
    if (netscape) return { cookiesText: netscape };
  } catch (e) {
    debugLog("[dk-bililearn BG] chrome.cookies fetch failed:", e?.message || e);
    // Fall through — return empty object so the server tries
    // unauthenticated and surfaces a 403 the user can read.
  }
  return {};
}

// Merge resolveYouTubeCookies() output into a /youtube/* request
// payload. One helper so the three fetch functions can never drift
// apart on which cookie fields they forward.
function applyYouTubeCookies(payload, cookies) {
  if (cookies.cookiesFromBrowser) payload.cookiesFromBrowser = cookies.cookiesFromBrowser;
  if (cookies.cookiesFromBrowserProfile) payload.cookiesFromBrowserProfile = cookies.cookiesFromBrowserProfile;
  if (cookies.cookiesFile) payload.cookiesFile = cookies.cookiesFile;
  if (cookies.cookiesText) payload.cookiesText = cookies.cookiesText;
  return payload;
}

// POST to a whisper_server /youtube/* endpoint with a one-shot
// cookie fallback (2026-10-01, Irene: "if a logged-out browser can
// see the subtitles, the extension must fetch them").
//
// When the request carried cookiesFromBrowser (auto mode) and the
// server fails with a cookie-STORE error — yt-dlp could not open /
// find / decrypt the browser's SQLite cookie DB — the browser-login
// path is dead on this machine, so retry once with NO cookies at
// all. Public videos then still work exactly like a logged-out
// browser visit. Video-level auth failures ("Sign in to confirm
// you're not a bot" 403, members-only, age gate) do NOT match the
// pattern and propagate untouched — retrying those without cookies
// would only double the wait for the same 403.
const YT_COOKIE_STORE_ERROR_RE =
  /cookies? (database|file)|could not find|unable to open|decrypt|cookiesfrombrowser|from browser|no such (browser|profile)/i;
async function postYouTubeWithCookieFallback(path, payload) {
  try {
    return await whisperServerPostJson(path, payload);
  } catch (e) {
    const msg = String(e?.message || "");
    if (payload.cookiesFromBrowser && YT_COOKIE_STORE_ERROR_RE.test(msg)) {
      debugLog(
        "[dk-bililearn BG] cookiesFromBrowser path failed on the server — retrying without cookies:",
        msg,
      );
      const retry = { ...payload };
      delete retry.cookiesFromBrowser;
      delete retry.cookiesFromBrowserProfile;
      return await whisperServerPostJson(path, retry);
    }
    throw e;
  }
}

// YouTube cookies via chrome.cookies API (2026-09-27)
//
// Replaces the previous "export cookies to a .txt file" workflow. The
// extension already holds the `cookies` permission + youtube.com
// host_permissions, so chrome.cookies.getAll gives us the user's own
// YouTube session cookies directly — no extra extension install, no
// manual export, no "where do I put the file" step.
//
// IMPORTANT (2026-10-01, live storage forensics — supersedes the
// 2026-09-28 note): this machine's full auth set (SID / HSID / SSID /
// SAPISID / APISID / LOGIN_INFO / __Secure-1PSID / __Secure-1PSIDTS)
// lives on `.youtube.com` itself and is NOT partitioned, so the plain
// domain query below reaches it. Auth cookies on `.google.com` /
// `.google.com.hk` also exist on some installs (mainland-network
// Google domain hop), so those domains stay in the query list. The
// manifest host_permissions must keep *.google.com /
// accounts.google.com, or chrome.cookies.getAll returns empty for
// those scopes.
//
// Output format: Netscape HTTP Cookie File (the same shape yt-dlp
// reads via its `cookiefile` option). See
// https://curl.haxx.se/rfc/cookie-spec.html for the spec.
async function fetchYouTubeNetscapeCookies() {
  // chrome.cookies.getAll has THREE query shapes and we use all of
  // them for maximum coverage:
  //
  //   { domain: X }   — returns cookies whose domain matches or is
  //                    a subdomain of X. Misses partitioned cookies
  //                    set during a YouTube/Google login flow.
  //   { url: U }      — returns cookies reachable from URL U,
  //                    INCLUDING partitioned cookies whose
  //                    partitionKey matches U's eTLD+1. Best
  //                    single-call API for our use case.
  //   { partitionKey: {topLevelSite: U}, domain: X } — explicit
  //                    partition query. Same as url= when the
  //                    url's eTLD+1 matches X; both forms required
  //                    by Chrome for cookies that are partitioned
  //                    under third-party cookie restrictions
  //                    (Chrome 113+ default).
  //
  // Background: 2026-10-01 live storage forensics (local Default
  // profile, Chrome 2026) corrected the earlier theory. The auth
  // cookies that survive YouTube's "Sign in to confirm you're not a
  // bot" wall — SID / HSID / SSID / SAPISID / APISID / LOGIN_INFO /
  // __Secure-1PSID / __Secure-1PSIDTS — are set directly on
  // `.youtube.com` during a first-party YouTube login, with
  // top_frame_site_key EMPTY (not CHIPS-partitioned). A plain
  // `{domain: ".youtube.com"}` query returns all of them. Only the
  // uninteresting public cookies (VISITOR_INFO1_LIVE / ROLLOUT_TOKEN
  // from third-party embeds) are partitioned. The `.google.com`
  // variants below stay for other login shapes, and `.google.com.hk`
  // covers mainland-network installs where Google properties hop to
  // the .hk domain (verified locally: full auth set present there
  // too).
  //
  // Each query is tried once per scope; results are deduped by
  // (name, domain, path).
  const queries = [
    // Non-partitioned fallback (older cookies, third-party embedded)
    { domain: ".google.com" },
    { domain: "google.com" },
    { domain: ".youtube.com" },
    { domain: "youtube.com" },
    // Mainland-network Google domain hop (2026-10-01: local machine
    // holds a full auth set on .google.com.hk as well).
    { domain: ".google.com.hk" },
    { domain: "google.com.hk" },
    // url-form: handles partitioned cookies whose partitionKey's
    // topLevelSite is the URL's eTLD+1.
    { url: "https://www.youtube.com/" },
    { url: "https://accounts.google.com/" },
    // Explicit partition form: the filter property is `partitionKey`
    // (NOT `partitioned` — that name makes chrome.cookies.getAll throw
    // "Unexpected property: 'partitioned'" and the query contributes
    // nothing). Chrome accepts topLevelSite with or without a trailing
    // slash; try both variants for coverage.
    {
      partitionKey: { topLevelSite: "https://accounts.google.com" },
      domain: ".google.com",
    },
    {
      partitionKey: { topLevelSite: "https://accounts.google.com/" },
      domain: ".google.com",
    },
    {
      partitionKey: { topLevelSite: "https://www.youtube.com" },
      domain: ".youtube.com",
    },
    {
      partitionKey: { topLevelSite: "https://www.youtube.com/" },
      domain: ".youtube.com",
    },
  ];
  const seen = new Set();
  const out = [];
  for (const details of queries) {
    let entries = [];
    try {
      entries = await chrome.cookies.getAll(details);
    } catch (e) {
      console.log(
        "[bililearn] chrome.cookies.getAll failed for",
        JSON.stringify(details),
        e?.message || e,
      );
      continue;
    }
    for (const c of entries) {
      // Dedupe on (name, domain, path) — same cookie can be reported
      // for overlapping domain queries.
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Netscape columns: domain, flag, path, secure, expiry, name, value
      const isSubdomainMatch = String(c.domain || "").startsWith(".");
      const secure = c.secure ? "TRUE" : "FALSE";
      const expiry = Number(c.expirationDate) ? Math.floor(c.expirationDate) : 0;
      out.push(
        [
          c.domain || ".youtube.com",
          isSubdomainMatch ? "TRUE" : "FALSE",
          c.path || "/",
          secure,
          String(expiry),
          c.name,
          c.value || "",
        ].join("\t"),
      );
    }
  }
  const sample = out
    .slice(0, 8)
    .map((l) => l.split("\t")[5])
    .join(",");
  console.log(
    `[bililearn] fetchYouTubeNetscapeCookies: ${out.length} cookies [${sample}${out.length > 8 ? ", ..." : ""}]`,
  );
  if (!out.length) return null;
  return [
    "# Netscape HTTP Cookie File",
    "# Generated by bililearn from chrome.cookies API (2026-09-27)",
    "",
    ...out,
  ].join("\n");
}

async function fetchYouTubeAudioBlob(rawInput, settings) {
  // Returns { blob, videoId, title, channel, uploadDate, duration }.
  // Same shape as fetchBilibiliAudioBlob's return value so the whisper
  // pipeline can use either transparently.
  const norm = normalizeYouTubeInput(rawInput);
  if (!norm) throw new Error("无效的 YouTube URL 或视频 ID。");
  const whisperUrl = (settings.whisperUrl || "http://127.0.0.1:7860").replace(/\/+$/, "");
  const requestPayload = {
    videoId: norm.videoId,
    url: norm.url,
    proxy: settings.youtubeProxy || "",
  };
  // 2026-09-28: shared cookie resolver (see resolveYouTubeCookies for
  // the 2026-10-01 auto-first flip). applyYouTubeCookies keeps all
  // three fetch functions forwarding the same fields.
  const cookies = await resolveYouTubeCookies(settings);
  applyYouTubeCookies(requestPayload, cookies);
  // Step 1 — tell server to download. yt-dlp writes to
  // %TEMP%/bililearn_youtube/<videoId>.m4a and returns the relative
  // audio URL.
  const triggerPayload = await postYouTubeWithCookieFallback("/youtube/audio", requestPayload);
  // Step 2 — fetch the actual bytes. Server has them cached for 1h
  // (see _YT_AUDIO_TTL_SEC); subsequent downloads for the same id are
  // a re-fetch, not a re-download.
  const audioResponse = await fetch(`${whisperUrl}${triggerPayload.audioUrl}`);
  if (!audioResponse.ok) {
    throw new Error(
      `whisper_server /youtube/audio stream returned HTTP ${audioResponse.status}`,
    );
  }
  const expectedBytes = Number(audioResponse.headers.get("content-length")) || 0;
  const blob = await audioResponse.blob();
  if (!blob.size) throw new Error("YouTube 音轨为空。");
  if (expectedBytes) {
    sendWhisperProgress(
      WHISPER_STAGES.DOWNLOADING,
      "正在下载 YouTube 音轨",
      `约 ${(expectedBytes / 1024 / 1024).toFixed(1)} MB`,
      { expectedBytes },
    );
  } else {
    sendWhisperProgress(
      WHISPER_STAGES.DOWNLOADING,
      "正在下载 YouTube 音轨",
      "请保持视频页面打开",
    );
  }
  return { blob, videoId: triggerPayload.videoId, ext: triggerPayload.ext };
}

async function fetchYouTubeOfficialSubtitle(rawInput, settings) {
  // Returns the same shape as fetchBilibiliOfficialSubtitle when a
  // subtitle track is found, OR null when the video has no caption at
  // any of the languages we tried (zh-Hans → zh-CN → zh → en →
  // long-tail). The null return is the signal for
  // handleFetchTranscript to fall through to the Whisper fallback —
  // we deliberately do NOT throw here, because "no caption" is a
  // normal outcome for some YouTube videos, not a hard error.
  // Hard errors (invalid URL, network, parse failure) still throw.
  const norm = normalizeYouTubeInput(rawInput);
  if (!norm) throw new Error("无效的 YouTube URL 或视频 ID。");
  const payload = {
    videoId: norm.videoId,
    url: norm.url,
    lang: settings.whisperLanguage || "",
    proxy: settings.youtubeProxy || "",
  };
  // 2026-09-28 (Irene regression): same cookie resolver as the audio
  // path. Without this, "Sign in to confirm" videos never return their
  // captions and always fall through to Whisper — which would still
  // fail at the audio download for the same reason. Cookies fix both
  // endpoints at once.
  const cookies = await resolveYouTubeCookies(settings);
  applyYouTubeCookies(payload, cookies);
  let data;
  try {
    data = await postYouTubeWithCookieFallback("/youtube/subtitle", payload);
  } catch (e) {
    // whisperServerPostJson throws when the server returns ok:false.
    // Inspect the message — if it's the "no_subtitle" error_type the
    // server already classified, just return null. Any other failure
    // is a real error and should propagate.
    const msg = String(e?.message || "");
    if (msg.includes("no_subtitle")) {
      debugLog("[dk-bililearn BG] YouTube video has no caption track");
      return null;
    }
    throw e;
  }
  const segments = (data.segments || []).map((seg) => {
    const start = Number(seg.start) || 0;
    const duration = Number(seg.duration) || 0;
    const text = String(seg.text || "").trim();
    return { text, start, duration, language: data.language };
  });
  if (!segments.length) return null;
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";
  for (const seg of segments) {
    transcriptTextPlain += seg.text + " ";
    const m = Math.floor(seg.start / 60);
    const s = Math.floor(seg.start % 60);
    transcriptTextTimestamped += `[${m}:${String(s).padStart(2, "0")}] ${seg.text}\n`;
  }
  return {
    success: true,
    transcript: segments,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: data.language || null,
    source: data.source === "yt-manual" ? "youtube-subtitle" : "youtube-auto-subtitle",
  };
}

async function transcribeYouTubeWithLocalWhisper(rawInput, settings, info) {
  // Mirrors transcribeWithLocalWhisper (the B站 version) but uses the
  // YouTube audio fetch + the B站 view shape populated from /youtube/info
  // so the rest of the pipeline (cache write, AI correction, sidepanel
  // render) sees the same canonical structure.
  const url = (settings.whisperUrl || "http://127.0.0.1:7860").replace(/\/+$/, "");
  if (!url) {
    throw new Error("Local Whisper is selected as the ASR provider but whisperUrl is empty.");
  }
  sendWhisperProgress(
    WHISPER_STAGES.DOWNLOADING,
    "正在下载 YouTube 音轨",
    "转录在后台进行，可随意切换页面",
  );
  const audioFetch = await fetchYouTubeAudioBlob(rawInput, settings);
  const contentType = audioFetch.blob.type || "audio/mp4";
  sendWhisperProgress(
    WHISPER_STAGES.READY_TO_TRANSCRIBE,
    "音频下载完成，准备调用 Whisper",
    `模型 ${settings.whisperModel || "base"} · ${url}`,
  );
  // Build the metadata headers exactly like transcribeWithLocalWhisper.
  // whisper_server's cache key uses bvid/cid/title/channel/pubdate; for
  // YouTube we substitute videoId as both "bvid" and a synthetic cid
  // ("yt-<videoId>"). The cache file naming pattern is preserved so
  // loadCachedTranscript's filename search still finds the right file.
  const title = info?.title || "";
  const channel = info?.channel || "";
  const uploadDate = info?.uploadDate || ""; // YYYYMMDD
  const headers = {
    "Content-Type": contentType,
    "X-Whisper-Model": settings.whisperModel || "base",
    "X-Bvid": audioFetch.videoId,
    "X-Cid": `yt-${audioFetch.videoId}`,
    "X-Title": encodeURIComponent(title),
    "X-Channel": encodeURIComponent(channel),
    "X-Pubdate": uploadDate,
    "X-Cache-Dir": encodeURIComponent(settings.subtitlesDir || ""),
  };
  if (settings.whisperLanguage) {
    headers["X-Whisper-Language"] = settings.whisperLanguage;
  }
  sendWhisperProgress(
    WHISPER_STAGES.TRANSCRIBING,
    "Whisper 转录中",
    "长视频通常需要几分钟，可在终端查看 whisper_server.py 日志",
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  let response;
  try {
    response = await fetch(`${url}/transcribe`, {
      method: "POST",
      headers,
      body: audioFetch.blob,
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
  const rawSegments = (data.segments || []).map((seg) => ({
    from: Number(seg.start) || 0,
    to: Number(seg.end) || 0,
    content: String(seg.text || "").trim(),
  }));
  const corrected = await correctWhisperTranscript(rawSegments, data.language, settings);
  return {
    transcript: corrected,
    language: data.language,
    source: "whisper-youtube",
  };
}

async function runYouTubeWhisperPipeline(rawInput, settings) {
  // Mirror of runWhisperPipeline, but for YouTube videos. Pulls
  // metadata via /youtube/info, then runs transcribeYouTubeWithLocalWhisper,
  // then saves to the same cache (loadCachedTranscript searches by
  // {date}_{title}_{UP}.json filenames, which the server's metadata
  // headers already populate).
  const info = await fetchYouTubeVideoInfo(rawInput, settings);
  await setWhisperJob({
    ...(activeWhisperJob || {}),
    recoveryMeta: {
      bvid: info.videoId,
      cid: `yt-${info.videoId}`,
      title: info.title || "",
      channel: info.channel || "",
      pubDate: info.uploadDate ? `${info.uploadDate.slice(0, 4)}-${info.uploadDate.slice(4, 6)}-${info.uploadDate.slice(6, 8)}` : "",
      cacheDir: settings.subtitlesDir || "",
    },
    videoMeta: {
      is_upower_expert: 0,
      is_ugc_pay: 0,
      is_cooperation: 0,
      aid: null,
      bvid: info.videoId,
      title: info.title || null,
    },
  });
  const result = await transcribeYouTubeWithLocalWhisper(rawInput, settings, info);
  const canonicalTranscript = (result.transcript || []).map(normalizeSegment);
  const cachePayload = {
    bvid: info.videoId,
    cid: `yt-${info.videoId}`,
    source: result.source,
    language: result.language,
    savedAt: new Date().toISOString(),
    transcript: canonicalTranscript,
    chapters: [],
  };
  const metaPubDate = info.uploadDate
    ? `${info.uploadDate.slice(0, 4)}-${info.uploadDate.slice(4, 6)}-${info.uploadDate.slice(6, 8)}`
    : "";
  const saved = await saveCachedTranscript(
    info.videoId,
    `yt-${info.videoId}`,
    cachePayload,
    settings,
    info.title || "",
    info.channel || "",
    metaPubDate,
  );
  if (!saved) {
    throw new Error(
      "字幕缓存保存失败（whisper_server 写入错误）。请确认 whisper_server.py 仍在 7860 端口运行后重试。",
    );
  }
  await setWhisperJob({
    ...activeWhisperJob,
    type: "whisper-job",
    stage: WHISPER_STAGES.SUCCEEDED,
    title: "Whisper 转录完成",
    subtitle: "正在加载字幕…",
    stageStartedAt: Date.now(),
    finishedAt: Date.now(),
    result: {
      videoId: info.videoId,
      pageNumber: 1,
      title: info.title || "",
      channel: info.channel || "",
      pubDate: metaPubDate,
      duration: info.duration || 0,
      source: result.source,
      language: result.language,
    },
  });
  setTimeout(() => clearWhisperJob(), 8000);
  return {
    videoId: info.videoId,
    pageNumber: 1,
    title: info.title || "",
    channel: info.channel || "",
    pubDate: metaPubDate,
    duration: info.duration || 0,
    transcript: canonicalTranscript,
    source: result.source,
    language: result.language,
  };
}

// ---------------------------------------------------------------------------
// 学堂在线 (xuetangx.com) 支持 —— 2026-10-26
// ---------------------------------------------------------------------------
//
// 学堂在线的学习接口全部要求登录态，从扩展的 service worker 直接调会被拒：
//   GET /api/v1/lms/learn/menu/          → {"detail":"身份认证信息未提供。"}
//   GET /api/v1/lms/learn/course/chapter → {"msg":"user is not login"}
//
// 所以我们不去复刻它的鉴权，而是让页面自己把数据带出来：
//   content.js（隔离世界）→ xuetangx-hook.js（主世界，document_start 注入）
//   → 拦截页面自己的 fetch/XHR，记下 leaf_info / s_t_c / s_t_g_p / playurl
//   → postMessage 回 content.js → 转发给 background（本文件的这一段）
//
// 于是这里拿到的 state 里已经有：cid / leafId / ccid / 小节名 /
// 字幕文件地址 / 视频直链。字幕文件本体再由 service worker 去下载
// （扩展有 host 权限，跨域没问题）。
// ---------------------------------------------------------------------------

const xuetangxStateByTab = new Map();
// videoId → {sign, cid, leafId}，用来拼出课程页 URL（notes / 导出链接）
const xuetangxMetaByVideoId = new Map();

// 2026-10-27: 我们期望的主世界钩子版本。扩展刷新**不会**更新已经打开的
// 页面里的钩子 JS —— 页面里的旧钩子会一直活着、一直发状态。后台读到旧版
// 状态时（版本号对不上）就重新注入一次：钩子的守卫按版本判断，所以新版
// 能装进去，同一个版本不会重复注入。
// （2026-10-27 踩过：页面里跑着第一版钩子，它的 state 没有诊断字段、字幕
//  地址也没抓到，后台拿着半新半旧的状态排查了很久。）
const XUETANGX_HOOK_VERSION = 7;

/** 找到承载当前学堂在线课程页的标签页 id。 */
async function findXuetangxTabId() {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const active = tabs && tabs[0];
    if (active && /(?:^|\.)xuetangx\.com\//i.test(active.url || "")) {
      return active.id;
    }
  } catch (_e) {}
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://*.xuetangx.com/*"],
      active: true,
    });
    if (tabs && tabs[0]) return tabs[0].id;
  } catch (_e) {}
  try {
    const tabs = await chrome.tabs.query({ url: ["https://*.xuetangx.com/*"] });
    if (tabs && tabs[0]) return tabs[0].id;
  } catch (_e) {}
  return null;
}

/** 记住某个标签页的学堂在线状态（换小节时更新）。 */
function rememberXuetangxState(tabId, state) {
  if (typeof tabId !== "number" || !state) return null;
  const normalized = {
    ...state,
    videoId: state.videoId || `xt-${state.cid || "0"}-${state.leafId || "0"}`,
  };
  xuetangxStateByTab.set(tabId, normalized);
  xuetangxMetaByVideoId.set(normalized.videoId, {
    sign: normalized.sign || "",
    cid: normalized.cid || "",
    leafId: normalized.leafId || "",
    pageUrl: normalized.pageUrl || "",
  });
  return normalized;
}

/** 向内容脚本要当前标签页的学堂在线状态。 */
async function getXuetangxStateForTab(tabId, options = {}) {
  if (typeof tabId !== "number") return null;
  const force = !!options.force;
  const cached = xuetangxStateByTab.get(tabId);
  const ask = async (askForce = false) => {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getXuetangxState",
      force: askForce,
    });
    if (response && response.success && response.state) {
      rememberXuetangxState(tabId, response.state);
      return response.state;
    }
    return null;
  };

  // 只注主世界钩子。content.js 在隔离世界里，重注会多出一个 onMessage
  // 监听器跟现有的抢响应权 —— 所以先只问，联系不上再补 content.js。
  const injectHook = async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["xuetangx-hook.js"],
        world: "MAIN",
      });
    } catch (error) {
      debugLog(
        "[dk-bililearn BG] xuetangx hook injection failed:",
        error?.message || error,
      );
    }
  };
  const injectContent = async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (error) {
      debugLog(
        "[dk-bililearn BG] xuetangx content.js injection failed:",
        error?.message || error,
      );
    }
  };

  const versionOk = (state) =>
    !!state && Number(state.hookVersion || 0) >= XUETANGX_HOOK_VERSION;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    let state = await ask(force);

    // 版本对不上（页面里跑的是旧钩子）→ 换新的，再等它就位。
    //
    // 2026-10-27 踩过：换完只问一次就放弃 —— 新钩子刚注进去还在跑它的
    // 字幕探针矩阵（十来个请求，要几秒），这一问肯定拿不到东西，
    // 于是"注入完就返回空"，谁都没等到结果。这里改成轮询到版本对上为止。
    if (!versionOk(state)) {
      await injectHook();
      // 2026-10-27: 探针矩阵带限速（每发 700ms + 403 重试 2.5s），
      // 跑完要十几秒 —— 12 秒不够，会把还在跑的结果判成"拿不到"。
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(500);
        state = await ask(false);
        if (versionOk(state)) break;
      }
    }

    // 还是联系不上 → 隔离世界的内容脚本压根没在（页面在扩展装好之前就打开的）
    if (!state) {
      await injectContent();
      await injectHook();
      state = await ask(force);
      if (!state) {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await sleep(500);
          state = await ask(false);
          if (state) break;
        }
      }
    }

    if (state) return state;
  } catch (error) {
    debugLog(
      "[dk-bililearn BG] getXuetangxState failed:",
      error?.message || error,
    );
  }

  return cached || null;
}

/** 学堂在线的时间串 → 秒。支持 "hh:mm:ss(.ms)" / "mm:ss" / 纯秒数。 */
function xuetangxTimeToSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // SRT 用逗号当毫秒分隔符（"00:00:01,000"），VTT 用点 —— 统一成点。
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(":").map((p) => Number(p) || 0);
  if (parts.length >= 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * 学堂在线字幕文件本体有两种形态：
 *   1. JSON：{ subtitle_list: [{ start, end, content }] }  ← 播放器用的是这种
 *   2. SRT / VTT 纯文本
 * 两种都归一成 {start, duration, text} 的标准形状。
 */
/**
 * 从一条字幕条目里抽出 {text, start, duration}。
 * 各家字段名五花八门（start/startTime/from/begin、content/text/value/c…），
 * 这里挨个试。
 */
function xuetangxRowFromEntry(item) {
  if (!item || typeof item !== "object") return null;
  const rawText = item.content ?? item.text ?? item.value ?? item.c ?? item.words;
  const text = String(
    typeof rawText === "object" && rawText
      ? rawText.text ?? rawText.content ?? ""
      : rawText ?? "",
  )
    .replace(/<[^>]+>/g, "")
    .trim();
  if (!text) return null;
  const start = xuetangxTimeToSeconds(
    item.start ?? item.startTime ?? item.from ?? item.begin ?? item.time ?? 0,
  );
  const end = xuetangxTimeToSeconds(
    item.end ?? item.endTime ?? item.to ?? item.finish ?? item.stop ?? item.start,
  );
  return { text, start, duration: Math.max(0, end - start) };
}

/**
 * 兜底：字幕文件的字段名各种各样（subtitle_list / data / subtitles / list…），
 * 深搜整棵 JSON 树，找"看起来像字幕条目"的数组。
 */
function deepFindXuetangxSubtitleRows(node, depth = 0, out = []) {
  if (!node || depth > 6 || out.length > 5000) return out;
  if (Array.isArray(node)) {
    const looksLikeRows =
      node.length > 0 &&
      node.every(
        (it) =>
          it &&
          typeof it === "object" &&
          !Array.isArray(it) &&
          (it.content != null ||
            it.text != null ||
            it.value != null ||
            it.c != null ||
            it.words != null) &&
          (it.start != null ||
            it.startTime != null ||
            it.from != null ||
            it.begin != null ||
            it.time != null),
      );
    if (looksLikeRows) {
      for (const it of node) {
        const row = xuetangxRowFromEntry(it);
        if (row) out.push(row);
      }
      return out;
    }
    for (const item of node) deepFindXuetangxSubtitleRows(item, depth + 1, out);
    return out;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node)) {
      deepFindXuetangxSubtitleRows(node[key], depth + 1, out);
    }
  }
  return out;
}

function parseXuetangxSubtitlePayload(raw) {
  const rows = [];
  if (!raw) return rows;

  const fromJson = (json) => {
    const list =
      (json && Array.isArray(json.subtitle_list) && json.subtitle_list) ||
      (json && Array.isArray(json.data) && json.data) ||
      (Array.isArray(json) ? json : null);
    if (!list) return false;
    for (const item of list) {
      if (!item) continue;
      const text = String(
        item.content ?? item.text ?? item.value ?? "",
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      if (!text) continue;
      const start = xuetangxTimeToSeconds(item.start ?? item.startTime ?? item.from);
      const end = xuetangxTimeToSeconds(
        item.end ?? item.endTime ?? item.to ?? item.start,
      );
      rows.push({ text, start, duration: Math.max(0, end - start) });
    }
    return rows.length > 0;
  };

  if (typeof raw === "object") {
    if (fromJson(raw)) return rows;
    // 2026-10-27: 快路径没命中 → 深搜整棵树（字段名不认识的兜底）
    const deep = deepFindXuetangxSubtitleRows(raw);
    if (deep.length) return deep;
    return rows;
  }

  const text = String(raw);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed);
      if (fromJson(json)) return rows;
      // 2026-10-27: 同上 —— 深搜
      const deep = deepFindXuetangxSubtitleRows(json);
      if (deep.length) return deep;
    } catch (_e) {
      /* 不是 JSON 就走 SRT */
    }
  }

  // SRT / VTT
  const blocks = trimmed
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [left, right] = timeLine.split("-->").map((s) => s.trim());
    const start = xuetangxTimeToSeconds(left);
    const end = xuetangxTimeToSeconds((right || "").split(" ")[0]);
    const body = lines
      .slice(lines.indexOf(timeLine) + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!body) continue;
    rows.push({ text: body, start, duration: Math.max(0, end - start) });
  }
  return rows;
}

/**
 * 学堂在线字幕抓不到时，把诊断信息落到本地磁盘
 * （下载目录下的 BiliSubs/xuetangx-debug.json）——
 * 卡在哪一步（sign 不对 / ccid 没拿到 / s_t_g_p 空 / 字幕文件下载失败）
 * 一眼可见，不用猜。
 */
async function dumpXuetangxDebug(state, reason) {
  try {
    if (!chrome.downloads || typeof chrome.downloads.download !== "function") return "";
    const raw = state?.raw || {};
    const payload = {
      时间: new Date().toISOString(),
      原因: reason,
      hookVersion: state?.hookVersion ?? null,
      hookBuild: state?.hookBuild || "",
      cid: state?.cid || "",
      leafId: state?.leafId || "",
      ccid: state?.ccid || "",
      contentId: state?.contentId || "",
      videoIdLeaf: state?.videoId || "",
      sign: state?.sign || "",
      signCandidates: state?.signCandidates || [],
      leafTitle: state?.leafTitle || "",
      courseTitle: state?.courseTitle || "",
      hasSubtitle: state?.hasSubtitle ?? null,
      subtitleLang: state?.subtitleLang || "",
      subtitleLangName: state?.subtitleLangName || "",
      subtitleUrl: state?.subtitleUrl || "",
      subtitleFileError: state?.subtitleFileError || "",
      subtitleSource: state?.subtitleSource || "",
      // 2026-10-27: 讲稿（leaf_lecture_note）与章节（leaf_knowledge）
      讲稿段数: Array.isArray(state?.lectureNote) ? state.lectureNote.length : 0,
      讲稿来源: state?.lectureNoteSource || "",
      章节数: Array.isArray(state?.leafKnowledge) ? state.leafKnowledge.length : 0,
      章节预览: Array.isArray(state?.leafKnowledge)
        ? state.leafKnowledge.slice(0, 5).map((c) => ({
            标题: c?.title || "",
            起点秒: c?.start ?? null,
            终点秒: c?.end ?? null,
          }))
        : [],
      讲稿首段: Array.isArray(state?.lectureNote) && state.lectureNote.length
        ? {
            起点秒: state.lectureNote[0]?.start ?? null,
            内容: String(state.lectureNote[0]?.content || "").slice(0, 120),
          }
        : null,
      subtitleBody长度: String(state?.subtitleBody || "").length,
      videoUrl: (state?.videoUrl || "").slice(0, 300),
      notes: raw.notes || [],
      rawLeafInfo: raw.leafInfo || "",
      rawSubtitleConfig: raw.subtitleConfig || "",
      rawSubtitleList: raw.subtitleList || "",
      rawSubtitleFile: raw.subtitleFile || "",
      // 2026-10-27: 字幕探针矩阵的每一步结果 —— 一次刷新就能看清
      // "到底是哪个姿势对上了 / 全都对不上"。
      probe: raw.probe || [],
      pageRequests: raw.pageRequests || [],
      pageResponses: raw.pageResponses || [],
    };
    const text = JSON.stringify(payload, null, 2);
    const dataUrl =
      "data:application/json;charset=utf-8;base64," +
      btoa(unescape(encodeURIComponent(text)));
    await new Promise((resolve) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: "BiliSubs/xuetangx-debug.json",
          conflictAction: "overwrite",
          saveAs: false,
        },
        () => resolve(),
      );
    });
    return "BiliSubs/xuetangx-debug.json";
  } catch (_e) {
    return "";
  }
}

/** 给用户看的一句人话：到底卡在哪一步。 */
function describeXuetangxState(state) {
  if (!state) return "没拿到页面状态";
  const bits = [];
  bits.push(`cid=${state.cid || "?"} leaf=${state.leafId || "?"}`);
  if (!state.ccid) bits.push("没拿到 ccid（sign 不对或 leaf_info 失败）");
  else bits.push("ccid✓");
  bits.push(state.hasSubtitle ? "接口说有字幕" : "接口说没字幕");
  if (state.subtitleUrl) bits.push("字幕地址✓");
  else bits.push("没拿到字幕文件地址");
  if (state.subtitleFileError) bits.push(`字幕文件抓取失败：${state.subtitleFileError}`);
  if (state.subtitleBody) bits.push(`字幕正文 ${String(state.subtitleBody).length} 字`);
  // 2026-10-27: 讲稿是官方逐段文字稿（带时间戳）—— 有它就等于拿到了字幕。
  const noteCount = Array.isArray(state.lectureNote)
    ? state.lectureNote.length
    : 0;
  if (state.hasLectureNote || noteCount) {
    bits.push(`官方讲稿 ${noteCount} 段`);
  } else {
    bits.push("没拿到官方讲稿");
  }
  const chapterCount = Array.isArray(state.leafKnowledge)
    ? state.leafKnowledge.length
    : 0;
  if (chapterCount) bits.push(`官方章节 ${chapterCount} 个`);
  // 2026-10-27: 把探针矩阵的结果也摆出来 —— 用户一眼能看出
  // "是全没试对"还是"试对了但文件挂了"。
  const probe = Array.isArray(state?.raw?.probe) ? state.raw.probe : [];
  if (probe.length) {
    const hit = probe.find((p) => /命中/.test(p));
    bits.push(
      hit
        ? `探针命中：${hit.slice(0, 60)}`
        : `探针 ${probe.length} 种姿势全未命中`,
    );
  }
  if (state?.staleHookSeen) bits.push("页面里还有旧版钩子在抢接口");
  return bits.join("；");
}

/**
 * 学堂在线的官方章节摘要（leaf_knowledge）。
 *
 * 2026-10-27: 原来这里挑的是"知识导引"（知识图谱那棵 300KB+ 的知识点树）。
 * 用户看过之后明确说概览里不需要那个 content 列表 —— 现在概览只认官方
 * 章节摘要：标题 + 概要 + 时间区间，足够填「章节时间线」。
 *
 * 归一化成 AI 概览同款形状（{title, summary, timestampSeconds, timestamp}），
 * 这样侧边栏可以用同一套渲染代码。
 */
function pickXuetangxOfficialChapters(state) {
  const list = Array.isArray(state?.leafKnowledge) ? state.leafKnowledge : [];
  const chapters = [];
  for (const item of list) {
    const seconds = Number(item?.start);
    const title = String(item?.title || "").trim();
    if (!Number.isFinite(seconds) || seconds < 0 || !title) continue;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    chapters.push({
      title: title.slice(0, 300),
      summary: String(item?.body || "").trim().slice(0, 1500),
      timestampSeconds: Math.floor(seconds),
      timestamp: `${mins}:${String(secs).padStart(2, "0")}`,
      endSeconds: Number.isFinite(Number(item?.end))
        ? Math.floor(Number(item.end))
        : null,
    });
  }
  return chapters.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
}

/**
 * 抓学堂在线官方字幕。
 * 优先用页面钩子顺手截到的字幕本体（省一次跨域请求），
 * 否则用钩子记下的字幕文件地址去下载。
 */
async function fetchXuetangxOfficialSubtitle(state) {
  if (!state) return null;

  let rows = [];
  let language = state.subtitleLang || "";

  if (state.subtitleBody) {
    rows = parseXuetangxSubtitlePayload(state.subtitleBody);
  }

  if (!rows.length && state.subtitleUrl) {
    try {
      const response = await fetch(state.subtitleUrl, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`学堂在线字幕文件下载失败（HTTP ${response.status}）。`);
      }
      const text = await response.text();
      if (state.raw && !state.raw.subtitleFile) {
        state.raw.subtitleFile = String(text).slice(0, 4000);
      }
      rows = parseXuetangxSubtitlePayload(text);
    } catch (error) {
      // 记下来，诊断文件里能看到"是下载挂了还是解析挂了"
      if (state.raw) {
        state.raw.subtitleFileError = String(
          (error && error.message) || error,
        );
      }
      throw error;
    }
  }

  if (!rows.length) return null;

  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";
  for (const row of rows) {
    const start = Math.max(0, Number(row.start) || 0);
    const minutes = Math.floor(start / 60);
    const seconds = Math.floor(start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    transcript.push({
      text: row.text,
      start,
      duration: Math.max(0, Number(row.duration) || 0),
      language: language || null,
    });
    transcriptTextPlain += row.text + " ";
    transcriptTextTimestamped += `[${timestamp}] ${row.text}\n`;
  }

  return {
    success: true,
    transcript,
    transcriptText: transcriptTextPlain.trim(),
    transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    language: language || "zh",
    // 2026-10-27: 讲稿（leaf_lecture_note）也是官方来源，但跟字幕文件
    // 不是一回事 —— 标出来，侧边栏/诊断里能看清到底拿到了什么。
    source:
      state.subtitleSource === "lecture-note"
        ? "xuetangx-lecture-note"
        : "xuetangx-subtitle",
    videoTitle: state.leafTitle || "",
    channelName: state.courseTitle || "",
    pubDate: "",
  };
}

/** 下载学堂在线视频直链（整段 mp4，含音轨）给 whisper_server 用。 */
async function fetchXuetangxVideoBlob(state) {
  const url = state?.videoUrl;
  if (!url) {
    throw new Error("没能拿到学堂在线的视频直链（页面可能还没开始播放）。");
  }
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`学堂在线视频下载失败（HTTP ${response.status}）。`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("学堂在线视频内容为空。");
  return blob;
}

/** 学堂在线版本的 Whisper 转录（结构对齐 B 站 / YouTube 两条链路）。 */
async function transcribeXuetangxWithLocalWhisper(state, settings) {
  const url = (settings.whisperUrl || "http://127.0.0.1:7860").replace(/\/+$/, "");
  if (!url) {
    throw new Error(
      "Local Whisper is selected as the ASR provider but whisperUrl is empty.",
    );
  }
  sendWhisperProgress(
    WHISPER_STAGES.DOWNLOADING,
    "正在下载学堂在线视频",
    "转录在后台进行，可随意切换页面",
  );
  const blob = await fetchXuetangxVideoBlob(state);
  sendWhisperProgress(
    WHISPER_STAGES.READY_TO_TRANSCRIBE,
    "音频下载完成，准备调用 Whisper",
    `模型 ${settings.whisperModel || "base"} · ${url}`,
  );

  const title = state.leafTitle || "";
  const channel = state.courseTitle || "";
  const headers = {
    "Content-Type": blob.type || "audio/mp4",
    "X-Whisper-Model": settings.whisperModel || "base",
    "X-Bvid": state.videoId || `xt-${state.cid || "0"}`,
    "X-Cid": `xt-${state.cid || "0"}-${state.leafId || "0"}`,
    "X-Title": encodeURIComponent(title),
    "X-Channel": encodeURIComponent(channel),
    "X-Pubdate": "",
    "X-Cache-Dir": encodeURIComponent(settings.subtitlesDir || ""),
  };
  if (settings.whisperLanguage) {
    headers["X-Whisper-Language"] = settings.whisperLanguage;
  }
  sendWhisperProgress(
    WHISPER_STAGES.TRANSCRIBING,
    "Whisper 转录中",
    "长视频通常需要几分钟，可在终端查看 whisper_server.py 日志",
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  let response;
  try {
    response = await fetch(`${url}/transcribe`, {
      method: "POST",
      headers,
      body: blob,
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
  const rawSegments = (data.segments || []).map((seg) => ({
    from: Number(seg.start) || 0,
    to: Number(seg.end) || 0,
    content: String(seg.text || "").trim(),
  }));
  const corrected = await correctWhisperTranscript(rawSegments, data.language, settings);
  return {
    transcript: corrected,
    language: data.language,
    source: "whisper-xuetangx",
  };
}

/** 学堂在线版本的 Whisper 管线（对齐 runWhisperPipeline / runYouTubeWhisperPipeline）。 */
async function runXuetangxWhisperPipeline(state, settings) {
  const videoId = state.videoId || `xt-${state.cid || "0"}-${state.leafId || "0"}`;
  const cid = `xt-${state.cid || "0"}-${state.leafId || "0"}`;
  await setWhisperJob({
    ...(activeWhisperJob || {}),
    recoveryMeta: {
      bvid: videoId,
      cid,
      title: state.leafTitle || "",
      channel: state.courseTitle || "",
      pubDate: "",
      cacheDir: settings.subtitlesDir || "",
    },
    videoMeta: {
      is_upower_expert: 0,
      is_ugc_pay: 0,
      is_cooperation: 0,
      aid: null,
      bvid: videoId,
      title: state.leafTitle || null,
    },
  });

  const result = await transcribeXuetangxWithLocalWhisper(state, settings);
  const canonicalTranscript = (result.transcript || []).map(normalizeSegment);
  const cachePayload = {
    bvid: videoId,
    cid,
    source: result.source,
    language: result.language,
    savedAt: new Date().toISOString(),
    transcript: canonicalTranscript,
    chapters: [],
  };
  const saved = await saveCachedTranscript(
    videoId,
    cid,
    cachePayload,
    settings,
    state.leafTitle || "",
    state.courseTitle || "",
    "",
  );
  if (!saved) {
    throw new Error(
      "字幕缓存保存失败（whisper_server 写入错误）。请确认 whisper_server.py 仍在 7860 端口运行后重试。",
    );
  }
  await setWhisperJob({
    ...activeWhisperJob,
    type: "whisper-job",
    stage: WHISPER_STAGES.SUCCEEDED,
    title: "Whisper 转录完成",
    subtitle: "正在加载字幕…",
    stageStartedAt: Date.now(),
    finishedAt: Date.now(),
    result: {
      videoId,
      pageNumber: 1,
      title: state.leafTitle || "",
      channel: state.courseTitle || "",
      pubDate: "",
      duration: Number(state.duration) || 0,
      source: result.source,
      language: result.language,
    },
  });
  setTimeout(() => clearWhisperJob(), 8000);
  return {
    videoId,
    pageNumber: 1,
    title: state.leafTitle || "",
    channel: state.courseTitle || "",
    pubDate: "",
    duration: Number(state.duration) || 0,
    transcript: canonicalTranscript,
    source: result.source,
    language: result.language,
  };
}

async function handleFetchTranscript(
  videoId,
  videoUrl = "",
  requestedPage = 1,
  options = {},
) {
  // 2026-10-27: 来源提到 try 外面 —— 外层 catch 也要用它来决定
  // "出错时给不给 Whisper 出路"（B 站这条路必须有，见下面 catch）。
  const source = detectVideoSource(videoId) || detectVideoSource(videoUrl || "");
  try {
    // 2026-09-27: route YouTube URLs / bare ids to the YouTube
    // subtitle path before any B站-specific work. The B站 path
    // (canonicalBilibiliUrl below) would otherwise throw on a bare
    // 11-char YouTube id, which is a fine fallback signal — but we
    // want a clean dispatch, not a thrown exception.
    if (source === "xuetangx") {
      // 2026-10-26: 学堂在线。字幕来自页面钩子捕获的字幕文件地址，
      // 拿不到就退回 Whisper（视频直链也在状态里）。
      const tabId = await findXuetangxTabId();
      const state = await getXuetangxStateForTab(tabId, {
        force: !!options.force,
      });
      if (!state) {
        return {
          success: false,
          error: "XUETANGX_STATE_MISSING",
          message:
            "没拿到学堂在线当前小节的信息。请刷新课程页面后重试（扩展刚安装/更新时需要刷新一次）。",
          transcript: [],
          transcriptText: "",
          language: null,
          source: "xuetangx-none",
        };
      }
      let subtitleError = "";
      try {
        const subtitle = await fetchXuetangxOfficialSubtitle(state);
        if (subtitle) {
          return {
            ...subtitle,
            videoTitle: subtitle.videoTitle || state.leafTitle || "",
            channelName: subtitle.channelName || state.courseTitle || "",
          };
        }
        subtitleError = "官方字幕接口/文件里没解析出内容";
      } catch (error) {
        subtitleError = (error && error.message) || String(error);
        debugLog(
          "[dk-bililearn BG] xuetangx subtitle fetch failed:",
          subtitleError,
        );
      }

      // 没有官方字幕 —— 先看 Whisper 之前有没有存过（第二次打开就该秒出）
      try {
        const settings = await getSettings();
        const cid = `xt-${state.cid || "0"}-${state.leafId || "0"}`;
        const cached = await loadCachedTranscript(
          state.videoId || cid,
          cid,
          settings,
          state.leafTitle || "",
          state.courseTitle || "",
          "",
        );
        if (cached) {
          const canonicalTranscript = (cached.transcript || [])
            .map(normalizeSegment)
            .filter(Boolean);
          const plainText = canonicalTranscript
            .map((seg) => seg.text)
            .join(" ");
          const timestampedText = canonicalTranscript
            .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
            .join("\n");
          return {
            success: true,
            source: "local-cache",
            language: cached.language || "unknown",
            chapters: cached.chapters || [],
            transcript: canonicalTranscript,
            transcriptText: plainText,
            transcriptTextTimestamped: timestampedText,
            cachePath: cached.cachePath,
            videoTitle: state.leafTitle || "",
            channelName: state.courseTitle || "",
            pubDate: "",
          };
        }
      } catch (error) {
        debugLog(
          "[dk-bililearn BG] xuetangx cached transcript lookup failed:",
          error?.message || error,
        );
      }

      // 2026-10-27: 官方字幕没拿到 → 把诊断信息落到本地磁盘，
      // 并给用户一句"到底卡在哪一步"的人话（而不是笼统的"没有字幕"）。
      const debugFile = await dumpXuetangxDebug(
        state,
        subtitleError || "官方字幕解析为空",
      );
      const diagnosis = describeXuetangxState(state);
      // 页面里还跑着旧版钩子的话，得明说 —— 旧钩子会跟新版一起打接口，
      // 请求量翻倍就被服务端限流（第一发 200、之后全 403）。
      const staleHint = state?.staleHookSeen
        ? "\n注意：页面里还活着一个旧版钩子，它在跟新版抢接口。请按 F5 刷新一次课程页面。"
        : "";
      let cacheDir = "";
      try {
        const s = await getSettings();
        cacheDir = s.subtitlesDir || "";
      } catch (_e) {}
      return {
        success: false,
        error: "XUETANGX_SUBTITLE_MISSING",
        message:
          `学堂在线官方字幕没读出来。${diagnosis}` +
          (subtitleError ? `（${subtitleError}）` : "") +
          (debugFile
            ? `\n诊断详情已存到下载目录：${debugFile}`
            : "") +
          staleHint,
        transcript: [],
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
        source: "xuetangx-none",
        cacheDir,
        xuetangxState: state,
        xuetangxDiagnosis: diagnosis,
        xuetangxDebugFile: debugFile,
        xuetangxStaleHook: !!state?.staleHookSeen,
      };
    }
    if (source === "youtube") {
      // 2026-09-29: try the browser's own DOM first — much cleaner
      // than yt-dlp through a proxy IP. The browser is already on
      // youtube.com with valid auth cookies + matching TLS fingerprint,
      // so opening "Show transcript" in the page always works for any
      // video the user can SEE captions for in their browser. yt-dlp
      // is the fallback for videos the user is NOT actively watching
      // (e.g. sidepanel opened on a video that's not in the focused
      // tab, or a video they want to capture via pasted URL only).
      const domTranscript = await fetchYouTubeTranscriptFromDOM();
      if (domTranscript && domTranscript.success) {
        return domTranscript;
      }
      const settings = await getSettings();
      const subtitle = await fetchYouTubeOfficialSubtitle(videoId || videoUrl, settings);
      if (subtitle) return subtitle;
      // No official / auto caption — tell the sidepanel to show the
      // WHISPER_NEEDED prompt. We use the same error string the B站
      // path emits so the sidepanel's `error === "WHISPER_NEEDED"`
      // branch catches both platforms.
      return {
        success: false,
        error: "WHISPER_NEEDED",
        message: "YouTube 视频无字幕，需要 Whisper 转录。",
        transcript: [],
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
        source: "youtube-none",
      };
    }
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
    //
    // 2026-10-27: 官方字幕**读取失败不能中断整条链路**。
    // 以前这里直接 await，接口一报错（风控 / 网络抖动 / 字幕文件 403 /
    // bvid-cid 对不上）整个 handleFetchTranscript 就跳进 catch，
    // 返回一个看不懂的 error —— 结果是：用户既拿不到字幕，
    // 连「🎙️ 用 Whisper 转录」那条出路都看不到（死路）。
    // 现在：失败只记录原因，然后继续往下走本地文件 / Whisper 缓存 /
    // WHISPER_NEEDED 提示，出路始终留着。
    let bilibiliSubtitle = null;
    let subtitleLookupError = "";
    try {
      bilibiliSubtitle = await fetchBilibiliOfficialSubtitle(videoId, page.cid);
    } catch (error) {
      const rawError = (error && error.message) || String(error);
      // 人话前缀：侧边栏会把这句原样显示在 Whisper 提示页上，
      // 用户要能一眼看出"卡在读官方字幕这一步"，而不是看到裸的英文报错。
      subtitleLookupError = `读取 B 站官方字幕时出错：${rawError}`;
      debugLog(
        "[dk-bililearn BG] bilibili official subtitle lookup failed:",
        rawError,
      );
    }
    if (bilibiliSubtitle) {
      return withVideoMeta(bilibiliSubtitle);
    }

    // 本地文件 fallback：B站没字幕时才看本地（whisper 旧 cache / up-master-report
    // / bililearn 自己生成的 .md/.txt/.srt）
    //
    // 2026-11-05: **两个本地查找并行发起**。
    //
    // 用户报"没字幕的视频要等很久才提示"。实测耗时（用户目录 911 个文件）：
    //   /local-file → 3.1s（要按文件名 + bvid 头匹配扫整个目录）
    //   /cache      → 0.6s（解析出的确切路径 + 兜底扫描）
    // 原来是**串行**的 → 3.7s 白等。两个请求彼此独立（一个找
    // up-master-report 导出的 .md/.txt，一个找 bililearn 自己写的
    // .json 缓存），没有任何数据依赖 —— 并行后总耗时 = max(3.1, 0.6)。
    const localFilePromise =
      settings.whisperUrl && settings.subtitlesDir
        ? loadLocalSubtitleFile(
            videoId,
            videoTitle,
            channelName,
            pubDate,
            settings,
            page.cid
          )
        : Promise.resolve(null);
    // whisper 分支要用的缓存查找也提前发起（下面用到 await 它的结果）。
    const whisperCachePromise =
      settings.asrProvider === "whisper"
        ? loadCachedTranscript(
            videoId,
            page.cid,
            settings,
            videoTitle,
            channelName,
            pubDate,
          )
        : Promise.resolve(null);

    const localFile = await localFilePromise;
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
        const audioBlob = await fetchBilibiliAudioBlob(videoId, page.cid, view);
        // 2026-09-23 (regression fix on top of 6a45b8d): The previous
        // commit switched the endpoint from api.minimaxi.com to
        // api.minimaxi.cn because a curl GET returned 404 — that 404
        // was actually because GET /speech_to_text is 404 on BOTH
        // hosts (this endpoint only accepts POST). With POST the
        // correct path returns 401 "login fail: Please carry the API
        // secret key" (i.e. reachable, just no key). The api.minimaxi.cn
        // host additionally has an EXPIRED TLS certificate as of
        // 2026-09-23, which Chrome refuses outright and surfaces to
        // background.js as a generic "Failed to fetch" — even though
        // the same POST to api.minimaxi.com reaches the server and
        // returns the expected 401. So api.minimaxi.com is the right
        // endpoint; .cn is to be avoided until they renew.
        //
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
          resp = await fetch("https://api.minimaxi.com/v1/speech_to_text", {
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
      // 这个请求在上面已经**并行发起**了（跟 /local-file 同时跑），
      // 这里只是等结果 —— 不要再发第二次，否则白等一遍 0.6s。
      const cached = await whisperCachePromise;
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
          "没有找到官方字幕或本地字幕文件。点击下方按钮启动 Whisper 转写，结果会保存到字幕目录供下次直接使用。" +
          (subtitleLookupError ? `\n（${subtitleLookupError}）` : ""),
        cacheDir: settings.subtitlesDir || "",
        subtitleLookupError,
      };
    }

    // Nothing else worked: bail.
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message:
        "B 站没有字幕，本地也没有缓存文件。" +
        (subtitleLookupError ? `\n（${subtitleLookupError}）` : ""),
      subtitleLookupError,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    const reason = (error && error.message) || "Failed to fetch transcript";
    // 2026-10-27: B 站这条路上任何一步炸了（风控 / 网络抖动 / bvid-cid
    // 对不上 / 字幕文件下载失败 / 视频信息读不出来），如果只回一句 error，
    // 侧边栏就只剩「重新尝试」一个按钮 —— 用户连 Whisper 这条出路都看不到，
    // 整条路成了死胡同。
    // 这里统一改成 WHISPER_NEEDED：侧边栏会渲染「🎙️ 用 Whisper 转录」，
    // 并把出错原因显示在页面里。视频直链是有的，Whisper 这条路一定能走通。
    if (source === "bilibili") {
      let cacheDir = "";
      try {
        const s = await getSettings();
        cacheDir = s.subtitlesDir || "";
      } catch (_e) {}
      return {
        success: false,
        error: "WHISPER_NEEDED",
        message: `读取 B 站字幕时出错：${reason}`,
        cacheDir,
        subtitleLookupError: reason,
        transcript: [],
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
        source: "bilibili-error",
      };
    }
    return {
      success: false,
      error: reason,
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
    // 2026-10-03: platform-aware URL — canonicalBilibiliUrl throws on
    // YouTube ids (see canonicalWatchUrlForVideoId).
    const canonicalVideoUrl = canonicalWatchUrlForVideoId(videoId);
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

    // 2026-10-10: best-effort mirror to notes KB. success even if it fails.
    try { await mirrorNoteToNotesKb(note); } catch (e) {
      debugLog("[notes-kb] mirror failed for note", note.id, ":", e && e.message || e);
    }
    try { chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {}); } catch {}

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
    // 2026-10-03: platform-aware URL — canonicalBilibiliUrl throws on
    // YouTube ids, which made 保存整篇至笔记 fail on every YouTube video.
    const canonicalVideoUrl = canonicalWatchUrlForVideoId(videoId);
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

    // 2026-10-10: best-effort mirror to notes KB so summary becomes Q&A material.
    try { await mirrorNoteToNotesKb(note); } catch (e) {
      debugLog("[notes-kb] mirror failed for summary:", e && e.message || e);
    }
    try { chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {}); } catch {}

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
    // 2026-10-10: best-effort mirror removal from "notes" KB videos/.
    // 失败也不影响 storage 已删的事实 —— 磁盘仅作 KB 索引源, 删除状态以
    // chrome.storage 为准.
    try { await removeNoteFromNotesKb(noteId); } catch (e) {
      debugLog("[notes-kb] delete mirror failed:", e);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 2026-10-10: bootstrap the system-owned "notes" KB on SW boot so it always
 * exists once the user has opted into KB management. Best-effort — server
 * may be offline, KB root may not be set, etc. None of those are errors.
 */
async function ensureNotesKbOnInit() {
  let settings;
  try { settings = await getSettings(); } catch { return; }
  if (!settings) return;
  if (settings.kbEnabled !== true || !settings.kbRootDir) return;
  if (settings.whisperUrl) KbClient.setBaseUrl(settings.whisperUrl);
  if (!(await KbClient.health())) return; // server offline, try again on next save
  try {
    const r = await KbClient.ensureNotes(settings.kbRootDir);
    debugLog("[notes-kb] ensure on init:", r);
  } catch (e) {
    debugLog("[notes-kb] ensure on init failed:", e && e.message || e);
  }
}

/**
 * 2026-10-10: take a chrome.storage "note" object and mirror it as a
 * karpathy-style video doc under notes/videos/. Frontmatter is synthesised
 * to match KbShared.buildKbDocument's shape (bvid = note_<id>, platform =
 * "note", date = YYYYMMDD compact of createdAt). 也往 queue/pending/ 投一份,
 * 让 karpathy LLM 在下次 alarm 触发时把这条新笔记并入 index.md / moc/*.md.
 *
 * @param {object} note - chrome.storage note entry.
 * @returns {Promise<void>} best-effort; never throws
 */
async function mirrorNoteToNotesKb(note) {
  if (!note || !note.id) return;
  let settings;
  try { settings = await getSettings(); } catch { return; }
  if (!settings || settings.kbEnabled !== true || !settings.kbRootDir) return;
  if (settings.whisperUrl) KbClient.setBaseUrl(settings.whisperUrl);
  if (!(await KbClient.health())) return;
  // Ensure skeleton exists (idempotent).
  try { await KbClient.ensureNotes(settings.kbRootDir); } catch {}
  const root = settings.kbRootDir;
  const sep = root.includes("/") ? "/" : "\\";
  const fileName = KbShared.noteFileName(note.id);
  const meta = {
    speaker: note.channelName || "bililearn-user",
    author: note.channelName || "bililearn-user",
    platform: "note",
    bvid: `note_${note.id}`,
    page: 1,
    date: KbShared.compactDate(new Date(note.createdAt || Date.now()).toISOString()),
    dateSource: "created",
    addedAt: new Date().toISOString().slice(0, 19),
    lang: "zh",
    topic: (note.videoTitle ? `关于「${String(note.videoTitle).slice(0, 60)}」` : "本地笔记"),
    url: note.timestampedUrl || "",
    durationS: 0,
  };
  // One segment with start=0,end=0,text=note body — karpathy/nvwa builder
  // treats any segment uniformly; no special-case code needed.
  const segments = [
    {
      start: 0, end: 0,
      text: String(note.text || "").trim() || (note.rawText || "").trim(),
    },
  ];
  const doc = KbShared.buildKbDocument(meta, segments);
  const videosPath = `${root}${sep}notes${sep}videos${sep}${fileName}`;
  await KbClient.write(root, videosPath, doc);
  // Enqueue a karpathy build task for this doc. task shape mirrors what
  // KbQueue.consumeOne expects.
  const sep2 = sep;
  const pendingDir = `${root}${sep}notes${sep}queue${sep}pending`;
  const taskFile = `${note.id}_${Date.now()}.json`;
  const task = {
    video_file: fileName,
    meta,
    attempts: 0,
    enqueued_at: new Date().toISOString(),
    source: "note",
  };
  await KbClient.write(root, `${pendingDir}${sep2}${taskFile}`, JSON.stringify(task, null, 2));
}

/**
 * 2026-10-10: mirror-delete: drop the file notes/videos/note_<id>.md and any
 * pending queue tasks that reference it. KB videos/* is rebuilt by the
 * karpathy daily alarm so this stays best-effort.
 */
async function removeNoteFromNotesKb(noteId) {
  if (!noteId) return;
  let settings;
  try { settings = await getSettings(); } catch { return; }
  if (!settings || settings.kbEnabled !== true || !settings.kbRootDir) return;
  if (settings.whisperUrl) KbClient.setBaseUrl(settings.whisperUrl);
  if (!(await KbClient.health())) return;
  const root = settings.kbRootDir;
  const sep = root.includes("/") ? "/" : "\\";
  const fileName = KbShared.noteFileName(noteId);
  const videosPath = `${root}${sep}notes${sep}videos${sep}${fileName}`;
  try { await KbClient.deletePath(root, videosPath, false); } catch {}
  // Drop any queued tasks that reference this note id.
  try {
    const pending = await KbClient.queue(root, "notes", "pending");
    for (const item of pending) {
      if (item && item.task && item.task.video_file === fileName) {
        await KbClient.deletePath(root, `${root}${sep}notes${sep}queue${sep}pending${sep}${item.file}`, false).catch(() => {});
      }
    }
  } catch {}
}

/**
 * 2026-10-10: saveAskAiNote — called from the Ask AI drawer's "copy-to-notes"
 * icon. Treats the LLM answer as a full markdown snippet (no transcript
 * cleanup), saves it to chrome.storage, and mirrors it into the notes KB.
 * 
 * Note object reuses the schema of `handleSaveSummaryNote` for consistency:
 * isFullNote=true, timestamp="全文", no timestampSeconds. The .id is unique
 * per ask-AI turn (note_<ms>) so deletes won't clash.
 */
async function handleSaveAskAiNote(message) {
  try {
    const text = String(message?.text || "").trim();
    if (!text) return { success: false, error: "EMPTY_TEXT" };
    const videoId = String(message?.videoId || "");
    const videoTitle = String(message?.videoTitle || "Ask AI 答复").slice(0, 500);
    const channelName = String(message?.channelName || "bililearn-user").slice(0, 300);
    const noteId = `note_${Date.now()}_askai`;
    const note = {
      id: noteId,
      videoId,
      videoTitle,
      channelName,
      timestamp: "全文",
      timestampSeconds: 0,
      timestampedUrl: videoId ? canonicalWatchUrlForVideoId(videoId) : "",
      text,
      rawText: text,
      isFullNote: true,
      source: "ask-ai",
      createdAt: Date.now(),
    };
    await saveNoteToStorage(note);
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
    // best-effort mirror to notes KB
    try { await mirrorNoteToNotesKb(note); } catch (e) {
      debugLog("[notes-kb] askai mirror failed:", e);
    }
    // kick queue so the new note gets picked up promptly when realtime mode
    try { chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {}); } catch {}
    return { success: true, note };
  } catch (error) {
    console.error("[dk-bililearn] saveAskAiNote error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * 2026-10-16: saveSelectionNote — the 📝 pill on the text-selection bar.
 * The user picked these exact words, so the text is stored as-is: no LLM
 * cleanup pass (unlike handleSaveNote, which re-writes a whole caption line).
 *
 * Shape note: this deliberately does NOT set isFullNote. The 笔记 tab renders
 * isFullNote notes as a "📄 整篇笔记" block with no timestamp and no ▶ Play,
 * which would be wrong here — a selection is a snippet anchored to a point in
 * the video. Keeping the regular-note schema means it renders as a quoted
 * line with a clickable timestamp, exactly like a player-saved note.
 *
 * @param {object} message - { text, videoId, videoTitle, channelName, seconds }
 *   `seconds` is the transcript row the selection started in, or null when the
 *   selection came from 概览/总结 (no row to anchor to).
 */
async function handleSaveSelectionNote(message) {
  try {
    const text = String(message?.text || "").trim();
    if (!text) return { success: false, error: "EMPTY_TEXT" };
    const videoId = String(message?.videoId || "");
    const videoTitle = String(message?.videoTitle || "").slice(0, 500);
    const channelName = String(message?.channelName || "").slice(0, 300);
    const rawSeconds = Number(message?.seconds);
    const seconds =
      Number.isFinite(rawSeconds) && rawSeconds >= 0 ? rawSeconds : null;

    const canonicalVideoUrl = canonicalWatchUrlForVideoId(videoId);
    const minutes = seconds === null ? 0 : Math.floor(seconds / 60);
    const secs = seconds === null ? 0 : Math.floor(seconds % 60);

    const note = {
      id: `note_${Date.now()}_sel`,
      videoId: videoId,
      videoTitle: videoTitle || "Untitled Video",
      channelName: channelName,
      timestamp:
        seconds === null ? "全文" : `${minutes}:${String(secs).padStart(2, "0")}`,
      timestampSeconds: seconds === null ? 0 : seconds,
      timestampedUrl:
        seconds === null
          ? canonicalVideoUrl
          : `${canonicalVideoUrl}${canonicalVideoUrl.includes("?") ? "&" : "?"}t=${seconds}s`,
      text: text,
      rawText: text,
      source: "selection",
      createdAt: Date.now(),
    };

    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    // best-effort mirror to notes KB so the snippet becomes Q&A material
    try { await mirrorNoteToNotesKb(note); } catch (e) {
      debugLog("[notes-kb] selection mirror failed:", e);
    }
    try { chrome.runtime.sendMessage({ action: "kbKickQueue" }).catch(() => {}); } catch {}

    return { success: true, note };
  } catch (error) {
    console.error("[dk-bililearn] saveSelectionNote error:", error);
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

    // Response language follows the browser/extension UI language, so
    // the explanation reads in the language the user actually runs
    // Chrome in (e.g. zh-CN → 中文, en-US → English). LLMs understand
    // BCP-47 tags directly.
    let uiLanguage = "";
    try {
      uiLanguage = chrome.i18n.getUILanguage();
    } catch {
      uiLanguage = typeof navigator !== "undefined" ? navigator.language : "";
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
      responseLanguage: uiLanguage || "zh-CN",
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
// ASK AI DRAWER — chat that auto-decides whether the current
// video's context is needed (two-stage: classifier, then answer)
// ============================================================

/**
 * Middle truncation for long context strings. Keeps the head (40%)
 * and the tail (60%) — the tail matters more while a video plays
 * (the user usually asks about what they just heard).
 */
function truncateMiddle(text, maxLen) {
  const str = String(text || "");
  if (str.length <= maxLen) return str;
  const headLen = Math.floor(maxLen * 0.4);
  const tailLen = maxLen - headLen;
  return (
    str.slice(0, headLen) +
    "\n…[中间内容省略]…\n" +
    str.slice(str.length - tailLen)
  );
}

/**
 * Parses the classifier's YES/NO verdict for the Ask AI drawer.
 * Anything that is not an unambiguous NO is treated as YES: a
 * wrongly-attached context only costs tokens, while a wrongly
 * dropped context breaks the answer ("拿不准时回答 YES").
 */
function parseContextDecision(raw) {
  const verdict = String(raw || "").trim().toUpperCase();
  if (/^NO\b/.test(verdict)) return false;
  return true;
}

/**
 * Flattens the drawer conversation into "user: …\nassistant: …"
 * lines for the classifier prompt (last maxTurns messages only).
 */
function buildConversationTail(messages, maxTurns = 6) {
  if (!Array.isArray(messages) || messages.length === 0) return "(无)";
  return messages
    .slice(-maxTurns)
    .map((m) => {
      const who = m && m.role === "assistant" ? "assistant" : "user";
      return `${who}: ${truncateMiddle(m && m.content, 800)}`;
    })
    .join("\n");
}

/**
 * Sanitizes the drawer conversation into OpenAI message format for
 * the answer call. Only user/assistant turns survive; the window is
 * capped so one giant paste cannot blow the context budget.
 */
function sanitizeAskAiHistory(messages, maxMessages = 8) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-maxMessages)
    .map((m) => ({ role: m.role, content: truncateMiddle(m.content, 2000) }));
}

/**
 * 2026-10-10: 把选定 KB 的内容从磁盘拉到拼好的 markdown 片段, 供 ask-AI 当 prompt
 * 上下文使用。
 *
 *   - karpathy: 拼 wiki/index.md + 各 moc/*.md (LLM 已经聚合好的内容)。
 *               如果 wiki 不存在 (新建 KB 还没首次 build), fallback 到 videos/*.md。
 *   - nvwa:    拼 nvwa/心智模型.md + 各案例集/*.md; 同上 fallback 到 videos/*.md。
 *   - raw:     直接拼所有 videos/*.md (无聚合, 内容可能很大, 所以走 truncate middle)。
 *
 * 内容可能很大, 因此有 KB_CONTEXT_MAX_CHARS 上限, 超长就中间截断。
 * KB dir 是 settings.kbRootDir/<kb.name>; 此函数假定 dir 已经被服务端沙箱过,
 * 直接读路径即可。
 *
 * @param {string} kbDir 服务器端的 kb json 路径 (kb.dir)
 * @param {string} buildMethod "karpathy" | "nvwa" | "raw"
 * @returns {Promise<string>} 拼好的 markdown 片段 (空字符串表示 nothing loaded)
 */
const KB_CONTEXT_MAX_CHARS = 30000; // ~30 KB 文本 -- 大约对应 8k 上下文窗口

async function loadKbContextText(kbDir, buildMethod) {
  if (!kbDir || typeof kbDir !== "string") return "";
  const settings = await getSettings();
  if (!settings || !settings.kbRootDir) return "";
  if (settings.whisperUrl) KbClient.setBaseUrl(settings.whisperUrl);
  if (!(await KbClient.health())) return ""; // server offline → context empty
  const root = settings.kbRootDir;
  const sep = root.includes("/") ? "/" : "\\";
  // kbDir 在 client 端是绝对路径; 三种风格交叉比对, 找第一层 KB 名。
  let kbName = kbDir.split(/[\\/]/).filter(Boolean).pop() || "";
  if (!kbName) return "";
  const kbPath = `${root}${sep}${kbName}`;

  const safeRead = async (rel) => {
    try {
      const r = await KbClient.read(root, `${kbPath}${sep}${rel}`);
      return (r && typeof r.content === "string") ? r.content : "";
    } catch { return ""; }
  };
  const safeList = async (rel) => {
    try {
      if (rel.endsWith(".md")) {
        // 个别 .md — 不真实, 我们走 KbClient.read
        return [];
      }
      // video metadata 列表不具备磁盘通配能力; 用 videos 端点拿文件清单
      if (rel === "videos") {
        const r = await KbClient.videos(root, kbName);
        return (Array.isArray(r) ? r : []).map((v) => v && v.file).filter(Boolean);
      }
      if (rel === "wiki/moc") {
        // 退化路径: 没 wiki 列表端点, 直接尝试常见的 moc 文件名
        // (real-world Karpathy wiki 主题页一般文件名不含扩展字符, 命中文件名由 LLM 决定)
        return [];
      }
      return [];
    } catch { return []; }
  };

  // Strategy 1: karpathy → wiki index + moc/*
  if (buildMethod === "karpathy") {
    const indexMd = (await safeRead("wiki/index.md")).trim();
    const videosList = await safeList("videos");
    const mocFiles = []; // TODO: 如果以后加 /kb/wiki_moc 端点, 这里枚举
    // 简单办法: 从 indexMd 里抓 [[moc name]] 链接; 解析后逐个读
    const mocNames = new Set();
    const linkRe = /\[\[([^\]\n]+?)\]\]/g;
    let m;
    while ((m = linkRe.exec(indexMd)) !== null) {
      const name = (m[1] || "").trim();
      if (name && !mocNames.has(name)) mocNames.add(name);
    }
    const parts = [];
    if (indexMd) parts.push(`# KB 索引\n${indexMd}`);
    if (videosList.length) parts.push(`# 包含的视频/笔记文件\n${videosList.map((f) => "- " + f).join("\n")}`);
    if (mocNames.size) {
      for (const name of mocNames) {
        const c = (await safeRead(`wiki${sep}moc${sep}${name}.md`)).trim();
        if (c) parts.push(`# 主题页: ${name}\n${c}`);
      }
    }
    let joined = parts.join("\n\n");
    if (joined.length > 100) return joined;
    // wiki 太空 (新建 KB 没首次 build), fallback 到原始 videos/*.md
  }
  if (buildMethod === "nvwa") {
    const modelMd = (await safeRead(`nvwa${sep}心智模型.md`)).trim();
    const videosList = await safeList("videos");
    // 案例集从 modelMd 里的链接或文件名解析 -- 走最简单的方式: 直接尝试常见主题
    const parts = [];
    if (modelMd) parts.push(`# 心智模型\n${modelMd}`);
    if (videosList.length) parts.push(`# 包含的视频/笔记文件\n${videosList.map((f) => "- " + f).join("\n")}`);
    let joined = parts.join("\n\n");
    if (joined.length > 100) return joined;
  }

  // Strategy 2: raw (或 fallback) → 拼所有 videos/*.md 原文
  const videosList = await safeList("videos");
  if (!videosList.length) return "";
  const docs = [];
  for (const file of videosList.slice(0, 50)) {
    const c = (await safeRead(`videos${sep}${file}`)).trim();
    if (c) docs.push(c);
  }
  let joined = docs.join("\n\n---\n\n");
  if (joined.length > KB_CONTEXT_MAX_CHARS) {
    joined = truncateMiddle(joined, KB_CONTEXT_MAX_CHARS);
  }
  return joined;
}

async function handleAskAiChat(message) {
  try {
    const question = String(message?.question || "").trim();
    if (!question) {
      return { success: false, error: "EMPTY_QUESTION" };
    }
    const history = sanitizeAskAiHistory(message.history);
    const selection = String(message.selection || "").trim();

    const settings = await getSettings();
    // The Ask-AI drawer may carry a per-question provider override
    // (selected from its dropdown) so the user can switch models for one
    // prompt without mutating the global settings. Build a transient
    // override object the requestAiCompletion helper recognises.
    const providerOverrideRaw = message && message.providerOverride;
    const settingsOverride = providerOverrideRaw
      ? {
          provider: providerOverrideRaw.provider,
          aiBaseUrl: providerOverrideRaw.baseUrl,
          aiModel: providerOverrideRaw.model,
          apiKey: providerOverrideRaw.apiKey,
        }
      : null;
    // 2026-10-13: 两层判断, 不依赖 settings.js 的 activeApiKey (那一条
    // 不区分 override 形态, 一旦 importScripts 缓存或扩展未刷新就会漏判)。
    // 错误信息也具体化: 告诉用户"抽屉选的是 X 但 storage 里没存 key"
    // 让他能自助定位哪个字段缺了, 而不是 generic "not configured"。
    const overrideApiKey =
      settingsOverride &&
      typeof settingsOverride.apiKey === "string"
        ? settingsOverride.apiKey.trim()
        : "";
    const settingsApiKey = YTD_SETTINGS.activeApiKey(settings);
    if (!overrideApiKey && !settingsApiKey) {
      const providerLabel =
        (settingsOverride && settingsOverride.provider) ||
        (settings && settings.provider) ||
        "(unknown)";
      return {
        success: false,
        error: "NO_AI_KEY",
        message: settingsOverride
          ? `Ask AI 抽屉选了 ${providerLabel}，但 chrome.storage.local[ytd_settings].${providerLabel}ApiKey 是空的 —— 请到 options 页 → AI Provider 区域重新填入 ${providerLabel} 的 key。`
          : `AI provider API key not configured。请到 options 页 → AI Provider 配置 ${providerLabel} 的 key。`,
      };
    }

    // Response language follows the UI language, same as Explain.
    let uiLanguage = "";
    try {
      uiLanguage = chrome.i18n.getUILanguage();
    } catch {
      uiLanguage = typeof navigator !== "undefined" ? navigator.language : "";
    }

    // ---- Stage 1: does this question need the video context? ----
    // A FIRST question typed right after selecting text is always
    // about that selection — skip the classifier call entirely.
    // Everything else goes through a tiny YES/NO classifier.
    const isFirstQuestion = history.length === 0;
    let needsContext = true;
    if (!(selection && isFirstQuestion)) {
      const decisionSystem = await loadPromptSection(
        "askai.md",
        "Context decision system",
      );
      const decisionUser = await loadPromptSection(
        "askai.md",
        "Context decision user",
        {
          conversationTail: buildConversationTail(history),
          question,
        },
      );
      // 2026-10-16: the classifier is an OPTIMISATION — it only decides
      // whether to attach the video context. It must never be able to fail
      // the user's question.
      //
      // It used to: maxTokens 8, temperature 0, and any error propagated to
      // the outer catch, so the whole turn died with "AI provider returned
      // an empty response." On glm-4.6 (a thinking model) that was every
      // time: the SSE stream spends the budget on `reasoning_content` and
      // never emits `content`, so the parser returns "" and throws
      // EMPTY_AI_RESPONSE. The user never even reached the answer stage.
      //
      // Two fixes: ask for no reasoning pass (disableThinking), and treat a
      // failure as "attach the context" — which is exactly what
      // parseContextDecision("") already returns, so a broken classifier now
      // degrades to the safe default instead of killing the turn.
      try {
        const { text: decisionRaw } = await requestAiCompletion({
          maxTokens: 32,
          temperature: 0,
          disableThinking: true,
          messages: [
            { role: "system", content: decisionSystem },
            { role: "user", content: decisionUser },
          ],
          settingsOverride,
        });
        needsContext = parseContextDecision(decisionRaw);
      } catch (classifierError) {
        console.warn(
          "[dk-bililearn] Ask AI context classifier failed; attaching video context by default:",
          classifierError && classifierError.message || classifierError,
        );
        needsContext = true;
      }
    }

    // ---- Stage 2: answer, with or without the video context block ----
    const answerSystem = await loadPromptSection("askai.md", "Answer system", {
      responseLanguage: uiLanguage || "zh-CN",
    });

    let finalQuestion = question;
    // KB override from the drawer's KB dropdown supersedes the
    // selection-first / classifier-driven decision: when a KB is picked,
    // the question is about THAT kb so context is always wanted. A raw
    // KB can't be selected from the dropdown, but defensively guard
    // here in case the caller passes one anyway.
    const kbContextRaw = message && message.kbContext;
    const hasKbContext =
      kbContextRaw &&
      typeof kbContextRaw === "object" &&
      kbContextRaw.name &&
      kbContextRaw.dir &&
      kbContextRaw.build_method &&
      kbContextRaw.build_method !== "raw";
    if (hasKbContext) {
      needsContext = true;
      // 2026-10-10: 之前 KB context 只在 prompt 里塞一行 KB 路径, LLM 看不到内容。
      // 现在把磁盘上的 KB 内容拉出来 (优先用 karpathy 索引/nvwa 模型, 缺则 fallback
      // 到 videos/*.md 全文), 拼到 prompt 里 —— 这样 Ask AI 才能真正"对着 KB 问答"。
      const kbContent = await loadKbContextText(kbContextRaw.dir, kbContextRaw.build_method);
      const kbBlock = await loadPromptSection(
        "askai.md",
        "KB context block",
        {
          selectionLine: selection
            ? `用户当前选中的文字："${selection}"`
            : "",
          videoTitle: message.videoTitle || "Unknown",
          channelName: message.channelName || "Unknown",
          kbName: kbContextRaw.name,
          kbPath: kbContextRaw.dir,
          buildMethod: kbContextRaw.build_method,
          kbContent: kbContent || "（KB 内容暂未加载 — 服务器离线或 KB 为空）",
        },
      );
      finalQuestion = kbBlock.trim() + "\n\n---\n\n" + question;
    } else if (needsContext) {
      const contextBlock = await loadPromptSection(
        "askai.md",
        "Video context block",
        {
          selectionLine: selection
            ? `用户当前选中的文字："${selection}"`
            : "",
          videoTitle: message.videoTitle || "Unknown",
          channelName: message.channelName || "Unknown",
          videoDescription: truncateMiddle(message.videoDescription, 2000),
          summary: truncateMiddle(message.summary, 6000),
          transcript: truncateMiddle(message.transcript, 20000),
        },
      );
      finalQuestion = contextBlock.trim() + "\n\n---\n\n" + question;
    }

    debugLog(
      "[dk-bililearn] Ask AI drawer request (context attached:",
      needsContext + ")",
    );
    const { text: answer } = await requestAiCompletion({
      maxTokens: 2048,
      messages: [
        { role: "system", content: answerSystem },
        ...history,
        { role: "user", content: finalQuestion },
      ],
      settingsOverride,
    });

    return {
      success: true,
      answer: answer.trim(),
      usedContext: needsContext,
    };
  } catch (error) {
    // 2026-10-16: 详细 stack 打印 —— 用户反馈 "老是出这种错" 但只看到 message,
    // 不知道是哪一行 .replace() 抛的。下次同样错能直接定位 (而不是再次猜
    // requestAiCompletion / chatCompletionsUrl / loadPromptSection 哪条路径).
    console.error("Ask AI chat error:", error && error.stack || error);
    return {
      success: false,
      error: error.message || "Failed to answer",
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
