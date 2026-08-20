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
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the Bilibili content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[dk-bilidown] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
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
      "AI provider API key not configured. Open bilidown Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }

  // Debug logging for GLM troubleshooting
  if (settings.provider === "glm") {
    console.log("[dk-bilidown] GLM config:", {
      apiType: settings.glmApiType,
      baseUrl: settings.aiBaseUrl,
      model: settings.aiModel,
      keyPrefix: activeKey ? activeKey.substring(0, 8) + "..." : "empty",
    });
  }

  const body = {
    model: settings.aiModel,
    messages,
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
        "AI provider request exceeded the 120-second limit. Please Retry.",
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

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for Bilibili.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to Bilibili tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make dk-bilidown behave like a Bilibili-only tool, we
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "summaryTranscript") {
    // Convert the full transcript into a complete structured note.
    handleSummarizeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
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

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[dk-bilidown BG] openSidePanel requested from tab:", tabId);

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
          // Broadcast to side panel to start bilidown (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startBilidownFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[dk-bilidown BG] openSidePanel error:", err);
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
                "[dk-bilidown BG] openSidePanel fallback error:",
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
    debugLog("[dk-bilidown BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for Bilibili tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[dk-bilidown BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no Bilibili tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("bilibili.com/video/")) {
          tabs = await chrome.tabs.query({
            url: "https://www.bilibili.com/video/*",
            active: true,
          });
          debugLog("[dk-bilidown BG] Active Bilibili tabs:", tabs.length);
        }

        // Still nothing? Try any Bilibili tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
          debugLog("[dk-bilidown BG] Any Bilibili tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[dk-bilidown BG] Sending to tab:",
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

          debugLog("[dk-bilidown BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[dk-bilidown BG] No Bilibili tab found");
          sendResponse({ success: false, error: "No Bilibili tab found" });
        }
      } catch (err) {
        console.error("[dk-bilidown BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

// ============================================================
// TRANSCRIPT FETCHING VIA BILIBILI API
// ============================================================

const BAILIAN_ASR_MODEL = "fun-asr";

async function fetchBilibiliAudioBlob(videoId, cid) {
  const response = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(videoId)}&cid=${encodeURIComponent(cid)}&fnval=16&qn=16`,
    { credentials: "include" },
  );
  const payload = await response.json();
  const audioTracks = [...(payload.data?.dash?.audio || [])].sort(
    (a, b) =>
      (Number(a.bandwidth) || Number.MAX_SAFE_INTEGER) -
      (Number(b.bandwidth) || Number.MAX_SAFE_INTEGER),
  );
  // Speech recognition does not benefit from Bilibili's highest audio bitrate.
  // Selecting the smallest track cuts both the CDN download and Bailian upload.
  const audio = audioTracks[0];
  const candidates = [audio?.baseUrl, audio?.base_url, ...(audio?.backupUrl || []), ...(audio?.backup_url || [])].filter(Boolean);
  if (!candidates.length) throw new Error("无法获取B站音轨地址。");

  let lastError;
  for (const url of candidates) {
    try {
      const audioResponse = await fetch(url);
      if (!audioResponse.ok) throw new Error(`HTTP ${audioResponse.status}`);
      const expectedBytes = Number(audioResponse.headers.get("content-length")) || 0;
      if (expectedBytes) {
        chrome.runtime.sendMessage({
          action: "transcriptProgress",
          title: "正在下载B站音轨",
          subtitle: `低码率音轨约 ${(expectedBytes / 1024 / 1024).toFixed(1)} MB`,
        }).catch(() => {});
      }
      const blob = await audioResponse.blob();
      if (!blob.size) throw new Error("音轨为空");
      return new Blob([blob], { type: "audio/mp4" });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`B站音轨下载失败：${lastError?.message || "未知错误"}`);
}

async function uploadAudioToBailian(blob, apiKey, videoId) {
  const policyResponse = await fetch(
    `https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(BAILIAN_ASR_MODEL)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const policyPayload = await policyResponse.json();
  if (!policyResponse.ok || !policyPayload.data) {
    throw new Error(policyPayload.message || "无法获取百炼临时上传凭证。");
  }
  const policy = policyPayload.data;
  const filename = `${videoId}-${Date.now()}.m4a`;
  const key = `${policy.upload_dir}/${filename}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id);
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("x-oss-object-acl", policy.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", blob, filename);
  const uploadResponse = await fetch(policy.upload_host, { method: "POST", body: form });
  if (!uploadResponse.ok) throw new Error(`音频上传百炼失败（${uploadResponse.status}）。`);
  return `oss://${key}`;
}

async function pollBailianAsrTask(taskId, apiKey) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const payload = await response.json();
    const status = payload.output?.task_status;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(payload.output?.message || payload.message || "百炼语音识别失败。");
    }
    if (status !== "SUCCEEDED") continue;
    const result = payload.output?.results?.[0];
    if (result?.subtask_status && result.subtask_status !== "SUCCEEDED") {
      throw new Error(result.message || "百炼语音识别子任务失败。");
    }
    if (!result?.transcription_url) throw new Error("百炼未返回转写结果地址。");
    const transcriptionResponse = await fetch(result.transcription_url);
    if (!transcriptionResponse.ok) throw new Error("无法下载百炼转写结果。");
    return transcriptionResponse.json();
  }
  throw new Error("百炼语音识别超时，请稍后重试。");
}

function normalizeBailianTranscript(data) {
  const sentences = data.transcripts?.flatMap((item) => item.sentences || []) || data.sentences || [];
  const transcript = sentences
    .map((sentence) => ({
      text: String(sentence.text || "").trim(),
      start: Math.max(0, Number(sentence.begin_time || 0) / 1000),
      duration: Math.max(0, (Number(sentence.end_time || sentence.begin_time || 0) - Number(sentence.begin_time || 0)) / 1000),
      language: sentence.language || "zh",
    }))
    .filter((sentence) => sentence.text);
  if (!transcript.length) throw new Error("百炼返回了空转写结果。");
  let plain = "";
  let timestamped = "";
  for (const sentence of transcript) {
    const minutes = Math.floor(sentence.start / 60);
    const seconds = Math.floor(sentence.start % 60);
    plain += `${sentence.text} `;
    timestamped += `[${minutes}:${String(seconds).padStart(2, "0")}] ${sentence.text}\n`;
  }
  return {
    success: true,
    transcript,
    transcriptText: plain.trim(),
    transcriptTextTimestamped: timestamped.trim(),
    language: "zh",
    source: "aliyun-fun-asr",
  };
}

async function transcribeWithBailian(videoId, cid, apiKey) {
  chrome.runtime.sendMessage({ action: "transcriptProgress", title: "正在下载B站音轨", subtitle: "请保持视频页面打开" }).catch(() => {});
  const blob = await fetchBilibiliAudioBlob(videoId, cid);
  chrome.runtime.sendMessage({ action: "transcriptProgress", title: "正在上传音轨", subtitle: "上传至阿里云百炼临时空间" }).catch(() => {});
  const fileUrl = await uploadAudioToBailian(blob, apiKey, videoId);
  const taskResponse = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({ model: BAILIAN_ASR_MODEL, input: { file_urls: [fileUrl] }, parameters: { language_hints: ["zh", "en"] } }),
  });
  const taskPayload = await taskResponse.json();
  const taskId = taskPayload.output?.task_id;
  if (!taskResponse.ok || !taskId) throw new Error(taskPayload.message || "无法提交百炼语音识别任务。");
  chrome.runtime.sendMessage({ action: "transcriptProgress", title: "正在识别语音", subtitle: "长视频通常需要几分钟" }).catch(() => {});
  return normalizeBailianTranscript(await pollBailianAsrTask(taskId, apiKey));
}

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
async function transcribeWithLocalWhisper(videoId, cid, settings) {
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url) {
    throw new Error("Local Whisper is selected as the ASR provider but whisperUrl is empty.");
  }
  const audioBlob = await fetchBilibiliAudioBlob(videoId, cid);
  const contentType = audioBlob.type || "audio/mp4";
  const headers = {
    "Content-Type": contentType,
    "X-Whisper-Model": settings.whisperModel || "base",
  };
  if (settings.whisperLanguage) {
    headers["X-Whisper-Language"] = settings.whisperLanguage;
  }
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
  // Normalise to the same shape as transcribeWithBailian so the rest of the
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
      "[dk-bilidown BG] whisper correction failed, returning raw:",
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
async function loadLocalSubtitleFile(bvid, videoTitle, channelName, pubDate, settings) {
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
    // Fallback without UP name (for files like YYYY-MM-DD_Title.md)
    possibleFilenames.push(`${pubDate}_${cleanTitle}.md`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}.txt`);
    possibleFilenames.push(`${pubDate}_${cleanTitle}.srt`);
  }
  // Fallback without date
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.md`);
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.txt`);
  possibleFilenames.push(`${cleanTitle}_${cleanChannel}.srt`);
  // Fallback without date and UP name
  possibleFilenames.push(`${cleanTitle}.md`);
  possibleFilenames.push(`${cleanTitle}.txt`);
  possibleFilenames.push(`${cleanTitle}.srt`);

  try {
    const qs = new URLSearchParams({
      filenames: possibleFilenames.join(","),
      cache_dir: dir,
    });
    const response = await fetch(
      `${settings.whisperUrl}/local-file?${qs.toString()}`,
      { method: "GET" },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      debugLog("[dk-bilidown BG] local file lookup failed:", response.status);
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
    debugLog("[dk-bilidown BG] local file load error:", error);
    return null;
  }
}

/**
 * Parse local subtitle content (txt/srt/md) into transcript format
 * Expected formats:
 *   - Markdown: ## 段 N [0.00s → 29.70s] followed by text
 *   - SRT: [HH:MM:SS,mmm] text
 *   - Simple: [MM:SS] text
 */
function parseLocalSubtitleContent(content, filename) {
  const lines = content.split(/\r?\n/);
  const transcript = [];
  let transcriptTextPlain = "";
  let transcriptTextTimestamped = "";

  // Detect format based on filename and content
  const isMarkdown = filename.endsWith(".md") || filename.endsWith(".markdown");
  const isSrt = filename.endsWith(".srt");

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

async function loadCachedTranscript(bvid, cid, settings) {
  const url = (settings.whisperUrl || "").replace(/\/+$/, "");
  if (!url || !YTD_SETTINGS.whisperCachePath(settings, bvid, cid)) return null;
  const cachePath = YTD_SETTINGS.whisperCachePath(settings, bvid, cid);
  try {
    const qs = new URLSearchParams({
      bvid,
      cid: String(cid),
      cache_dir: settings.subtitlesDir || "",
    });
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
    debugLog("[dk-bilidown BG] cache load failed:", error);
    return null;
  }
}

async function saveCachedTranscript(bvid, cid, payload, settings) {
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
        payload,
      }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    debugLog("[dk-bilidown BG] cache write failed:", error);
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
) {
  const settings = await getSettings();
  if (settings.asrProvider !== "whisper") {
    throw new Error("Local Whisper is not enabled. Open bilidown Settings.");
  }
  // Look up the cid first so the cache file name is stable.
  const viewResponse = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`,
    { credentials: "include" },
  );
  const view = await viewResponse.json();
  if (!viewResponse.ok || view.code !== 0 || !view.data) {
    throw new Error(view.message || "无法读取 B 站视频信息。");
  }
  const part = Math.max(1, Number(requestedPage) || 1);
  const page = view.data.pages?.[part - 1] || view.data.pages?.[0];
  if (!page?.cid) throw new Error("无法识别当前分 P 的 CID。");

  const result = await transcribeWithLocalWhisper(videoId, page.cid, settings);
  // Persist to cache so the next visit is instant. We always save the
  // segments we have, even if the AI correction step failed, so the user
  // gets something to read instead of being asked to re-transcribe.
  const cachePayload = {
    bvid: videoId,
    cid: page.cid,
    source: result.source,
    language: result.language,
    savedAt: new Date().toISOString(),
    transcript: result.transcript || [],
    chapters: result.chapters || [],
  };
  await saveCachedTranscript(videoId, page.cid, cachePayload, settings);
  return { ...result, cachePath: YTD_SETTINGS.whisperCachePath(settings, videoId, page.cid) };
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

    // When configured, ASR is the source of truth. This avoids incorrect
    // Bilibili ai-zh tracks and also covers videos without subtitle tracks.
    const settings = await getSettings();
    if (settings.asrApiKey) {
      return await transcribeWithBailian(videoId, page.cid, settings.asrApiKey);
    }

    // First, try to look for local subtitle files (YYYY-MM-DD_videoTitle_upName.{txt,srt,md})
    if (settings.asrProvider === "whisper" && settings.whisperUrl && settings.subtitlesDir) {
      const localFile = await loadLocalSubtitleFile(
        videoId,
        videoTitle,
        channelName,
        pubDate,
        settings
      );
      if (localFile) {
        return {
          success: true,
          source: "local-file",
          language: localFile.language || "unknown",
          chapters: localFile.chapters || [],
          transcript: Array.isArray(localFile.transcript) ? localFile.transcript : [],
          transcriptText: localFile.transcriptText || "",
          transcriptTextTimestamped: localFile.transcriptTextTimestamped || "",
          cachePath: localFile.cachePath,
        };
      }
    }

    // If local Whisper is enabled, look for a previously-cached transcript
    // before falling through to native subtitles. We do NOT auto-trigger
    // Whisper here — that requires an explicit user click — but we tell
    // the side panel which action is available.
    if (settings.asrProvider === "whisper") {
      const cached = await loadCachedTranscript(videoId, page.cid, settings);
      if (cached) {
        return {
          success: true,
          source: "local-cache",
          language: cached.language || "unknown",
          chapters: cached.chapters || [],
          transcript: Array.isArray(cached.transcript) ? cached.transcript : [],
          transcriptText: Array.isArray(cached.transcript)
            ? cached.transcript
                .map((seg) => `[${formatTimestamp(seg.from)}] ${seg.content}`)
                .join("\n")
            : "",
          cachePath: cached.cachePath,
        };
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

    // Whisper is disabled AND no Bailian key: nothing else can produce a
    // transcript for videos without native B-station subtitles.
    if (!settings.asrApiKey && settings.asrProvider === "none") {
      // (we still let the code fall through to native subtitles below —
      // many videos do have them.)
    }

    const playerResponse = await fetch(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(videoId)}&cid=${encodeURIComponent(page.cid)}`,
      { credentials: "include", cache: "no-store" },
    );
    const player = await playerResponse.json();
    if (!playerResponse.ok || player.code !== 0) {
      throw new Error(player.message || "无法读取 B 站字幕列表。");
    }
    if (
      String(player.data?.bvid || "") !== String(videoId) ||
      Number(player.data?.cid) !== Number(page.cid)
    ) {
      throw new Error("B 站返回的字幕信息与当前视频不匹配，请刷新后重试。");
    }

    const subtitles = player.data?.subtitle?.subtitles || [];
    const preferred =
      subtitles.find((item) => /zh|ai-zh/i.test(item.lan || "")) || subtitles[0];
    if (!preferred?.subtitle_url) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "这个视频没有可用的 B 站字幕。第一版暂不进行音频转写。",
      };
    }
    const subtitleUrl = preferred.subtitle_url.startsWith("//")
      ? `https:${preferred.subtitle_url}`
      : preferred.subtitle_url;
    const subtitleResponse = await fetch(subtitleUrl, { credentials: "include" });
    if (!subtitleResponse.ok) throw new Error("B 站字幕文件下载失败。");
    const data = await subtitleResponse.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.body && Array.isArray(data.body)) {
      for (const chunk of data.body) {
        if (chunk.content) {
          const cleanText = chunk.content.trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

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

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for minimax (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "B 站返回了空字幕。",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: preferred.lan || null,
      source: "bilibili-subtitle",
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
) {
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured. Open bilidown Settings.",
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

    debugLog("[dk-bilidown] Requesting video analysis", settings.aiModel);
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
) {
  try {
    const settings = await getSettings();
    if (!YTD_SETTINGS.activeApiKey(settings)) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI provider API key not configured. Open bilidown Settings.",
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

    debugLog("[dk-bilidown] Requesting transcript summary", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
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

    // First, try to get the transcript from the bilidown cache. The side panel
    // saves analyses to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`bilidown_${videoId}`);
      if (cached[`bilidown_${videoId}`]?.transcript) {
        transcript = cached[`bilidown_${videoId}`].transcript;
        debugLog("[dk-bilidown] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[dk-bilidown] No cached transcript, fetching...");
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
    console.error("[dk-bilidown] Save note error:", error);
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
    console.error("[dk-bilidown] Save summary note error:", error);
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
    debugLog("[dk-bilidown] Requesting note cleanup");
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
        "[dk-bilidown] JSON parse failed for note, stripping preambles:",
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
    console.error("[dk-bilidown] Cleanup error:", e);
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

    debugLog("[dk-bilidown] Requesting selection explanation");
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
    console.error("[dk-bilidown] Translation error:", error);
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
