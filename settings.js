/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  // Supported AI providers. Each preset defines the OpenAI-compatible
  // chat-completions endpoint and a default model. Users can override the
  // endpoint and model after switching via custom fields in storage.
  // The "other" preset is a UI-only marker: it has no built-in endpoint or
  // model, and selecting it does not change the active API key. It surfaces
  // the local-remix customization prompt so users can wire up their own
  // provider via the coding-agent flow.
  const PROVIDER_PRESETS = Object.freeze({
    deepseek: Object.freeze({
      // DeepSeek's OpenAI-compatible endpoint lives at the root, no /v1 prefix.
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      displayName: "DeepSeek",
    }),
    minimax: Object.freeze({
      // minimax mounts its OpenAI-compatible routes under /v1. Hitting
      // /chat/completions directly returns an nginx 404 HTML page, which
      // looks like "<html><h1>404</h1>" and breaks JSON.parse in the
      // background worker.
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      displayName: "minimax",
    }),
    other: Object.freeze({
      // No preset endpoint — the user is expected to fork the extension
      // (or pass a custom aiBaseUrl/aiModel through storage) to wire up
      // any OpenAI-compatible service. Selecting "Other model" must NOT
      // blank an existing custom baseUrl/model the user already set.
      baseUrl: "",
      model: "",
      displayName: "Other model",
    }),
    // "none" = the user explicitly disabled AI features (2026-08-29).
    // No endpoint, no model; activeApiKey() returns "" so the sidepanel
    // keeps showing the configure-AI wizard until a real provider is picked.
    none: Object.freeze({
      baseUrl: "",
      model: "",
      displayName: "No AI model",
    }),
    glm: Object.freeze({
      // Zhipu AI / Z.AI (智谱清言). The provider ships two OpenAI-
      // compatible endpoints and the API keys are NOT interchangeable:
      //
      //   - "standard": pay-as-you-go key from bigmodel.cn → /api/paas/v4
      //   - "coding":   Coding Plan subscription key            → /api/coding/paas/v4
      //
      // The dropdown in options.html lets the user pick which one their
      // key works with. resolveGlmBaseUrl() picks the matching URL.
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6",
      displayName: "GLM (Zhipu)",
    }),
  });

  // GLM endpoint registry. Two keys are accepted by Zhipu's bigmodel.cn:
  // standard (pay-as-you-go) and coding (subscription / Coding Plan).
  // Each maps to a different base URL because the keys are NOT
  // interchangeable — using a Coding Plan key with the standard endpoint
  // (or vice versa) returns HTTP 401 INVALID_AI_KEY.
  const GLM_ENDPOINTS = Object.freeze({
    standard: "https://open.bigmodel.cn/api/paas/v4",
    coding: "https://open.bigmodel.cn/api/coding/paas/v4",
  });
  const GLM_API_TYPES = Object.freeze(Object.keys(GLM_ENDPOINTS));
  const DEFAULT_GLM_API_TYPE = "coding"; // most likely match for users
                                         // coming from MiniMax Token Plan

  function resolveGlmBaseUrl(apiType) {
    return GLM_ENDPOINTS[apiType] || GLM_ENDPOINTS[DEFAULT_GLM_API_TYPE];
  }

  function normalizeGlmApiType(input) {
    return GLM_API_TYPES.includes(input) ? input : DEFAULT_GLM_API_TYPE;
  }
  const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_PRESETS));
  // 2026-09-13: fresh installs default to "none" (No AI model). The
  // options page must not imply a provider the user never picked — the
  // sidepanel's configure-AI wizard guides them to choose one when they
  // want summaries. The old default "minimax" only survives via the
  // legacy migration in normalize() (pre-dropdown installs).
  const DEFAULT_PROVIDER = "none";

  // Known preset values, used to detect provider-switch residue in a
  // stored aiBaseUrl / aiModel (see normalize). A stored value that
  // exactly matches SOME provider's preset is residue from before the
  // switch, not a hand edit, so it follows the newly selected provider.
  // 2026-08-30 follow-up (user report, storage forensics): the set must
  // cover EVERY official base URL, not just the preset ones — after
  // deepseek → glm → deepseek the stored aiBaseUrl was the GLM CODING
  // endpoint (which lives only in GLM_ENDPOINTS, never in
  // PROVIDER_PRESETS), so it dodged the residue rule, a DeepSeek key was
  // sent to open.bigmodel.cn, and every summary failed with 401
  // INVALID_AI_KEY. DeepSeek documents two official base URLs (with and
  // without /v1); both count as known-official, so both are residue.
  const PRESET_BASE_URLS = new Set(
    [
      ...Object.values(PROVIDER_PRESETS).map((preset) => preset.baseUrl),
      ...Object.values(GLM_ENDPOINTS),
      "https://api.deepseek.com/v1",
    ].filter(Boolean),
  );
  const PRESET_MODELS = new Set(
    Object.values(PROVIDER_PRESETS)
      .map((preset) => preset.model)
      .filter(Boolean),
  );

  // Chrome extensions cannot read $HOME / %USERPROFILE% directly, so
  // `~`-prefixed paths can only be expanded against an explicit list of
  // homes. This list is intentionally EMPTY (2026-09-12): baking a real
  // username into the source leaks the build machine's layout and is
  // wrong for every other install. expandExportPath() returns "" when no
  // home is configured, so an unresolvable `~/...` value falls back to
  // the browser's default download directory instead of a broken path.
  // Populate locally (never commit) if you rely on `~/...` shorthand.
  const KNOWN_HOMES = Object.freeze([]);

  const DEFAULTS = Object.freeze({
    provider: DEFAULT_PROVIDER,
    deepseekApiKey: "",
    minimaxApiKey: "",
    glmApiKey: "",
    glmApiType: DEFAULT_GLM_API_TYPE,
    aiBaseUrl: PROVIDER_PRESETS[DEFAULT_PROVIDER].baseUrl,
    aiModel: PROVIDER_PRESETS[DEFAULT_PROVIDER].model,
    // Which speech-to-text engine to fall back on when B-station has no
    // usable native subtitles. "none" disables ASR entirely — the user
    // just sees B-station's own subtitles (or no transcript at all
    // for videos without one). "whisper" uses the local faster-whisper
    // server (whisper_server.py). "minimax" uses the cloud MiniMax ASR
    // API at https://api.minimax.chat/v1/audio/transcriptions (multipart
    // upload, model `speech-01` family, billed per character). 2026-09-10:
    // default flipped to "none" so a fresh install does not silently
    // require the user to set up a local whisper server before they can
    // use the extension — the first-run banner in options.html explains
    // how to turn whisper on (or pick minimax cloud ASR) if they need it.
    asrProvider: "none",
    supadataApiKey: "",
    // 2026-09-17 (Irene directive, refined per official MiniMax docs):
    // Used only when asrProvider === "minimax". The key and the model
    // field are both kept (the form still offers model selection on the
    // options page in case MiniMax ships more models) but the only
    // currently supported value is "asr-1.0" — earlier drafts offered
    // speech-01 / turbo / hd, which do not exist on the actual endpoint.
    minimaxAsrApiKey: "",
    minimaxAsrModel: "asr-1.0",
    // Local Whisper configuration (only used when asrProvider === "whisper").
    whisperUrl: "http://127.0.0.1:7860",
    whisperModel: "base",
    whisperLanguage: "",
    // Where Whisper outputs and AI-corrected transcripts are cached on disk
    // so the user does not re-transcribe the same video on a later visit.
    // 2026-09-16 (Irene directive, replaces 2026-09-13 "BiliSubs" default):
    // the previous default was the relative path "BiliSubs" — but the
    // whisper_server is a separate Python process that resolved it against
    // its own CWD, which almost never matched the user's Downloads folder,
    // so cache lookups silently missed on a fresh install. The background
    // script now resolves an ABSOLUTE default by sniffing
    // chrome.downloads (history → probe download), caches the result in
    // chrome.storage.local under "downloadsRootCache", and joins
    // "BiliSubs" onto it before the settings object is handed to
    // whisper_server. DEFAULTS stays empty here — leaving the field
    // empty is the signal for the background to do that resolution.
    // A user who sets a custom absolute path keeps it; a legacy user
    // who stored the relative "BiliSubs" value (pre-2026-09-16) is
    // migrated back to empty in normalize() below so the same resolver
    // path runs for them too.
    subtitlesDir: "",
    // Where exported notes / summaries / reports are written. Intentionally
    // NO hardcoded default path (2026-09-12, same rationale as
    // subtitlesDir above): a baked-in absolute path would leak this build
    // machine's layout onto every other install, and Chrome MV3 has no
    // API for $HOME. An empty value means "export into the DEFAULT
    // EXPORT SUBFOLDER of the browser's default download directory" —
    // the consumer passes a relative `BiliSubs/<file>` filename to
    // chrome.downloads.download(), which resolves it against the
    // browser-configured Downloads folder (Windows/macOS/Linux alike)
    // and creates the subfolder automatically on first export. Users who
    // want a fixed folder elsewhere set it once in options; `~/...`
    // values expand via KNOWN_HOMES only when that list is populated.
    exportDir: "",
    // Desktop completion notifications. Default ON (2026-09-02): all three
    // pop unconditionally when their job finishes — whisper transcription
    // fires on every SUCCEEDED job (no slow-run threshold anymore — keep
    // it simple, the user wants to know each video is done), the summary
    // and analysis still only fire on >=60s slow runs, the toggle just
    // gates whether ANY of these pop at all. Stored as booleans so a
    // missing or non-bool stored value falls back to ON, never silently
    // disables a notification the user was relying on. 2026-09-02:
    // notifyOnSummary + notifyOnAnalysis merged into a single field
    // (notifyOnSummaryAndAnalysis) — the user can only opt in/out of
    // both together because they are the same kind of LLM work over
    // the transcript. Migration: an existing `false` on EITHER old
    // field flips the merged one off, so a user who turned summary off
    // before doesn't get surprise notifications when this build lands.
    notifyOnTranscribe: true,
    notifyOnSummaryAndAnalysis: true,
    // 2026-09-10: first-run onboarding banner. `false` on a fresh
    // install — the options page reveals the banner and the user
    // clicks "got it" to flip this to `true`. Strict boolean default
    // (mirrors the notification-prefs pattern): undefined / 0 / "false"
    // all land on the show-banner side. Once dismissed the banner is
    // suppressed for the lifetime of this profile; no auto-reset.
    firstRunDismissed: false,
  });

  const WHISPER_MODELS = Object.freeze([
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "turbo",
  ]);

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalizeProvider(input) {
    return PROVIDER_IDS.includes(input) ? input : DEFAULT_PROVIDER;
  }

  function isLocalRemixProvider(input) {
    return normalizeProvider(input) === "other";
  }

  function normalize(input = {}) {
    // Backward compat: older settings stored a single aiApiKey. Treat it as
    // a minimax key when present so users who already configured a key
    // before the provider dropdown shipped aren't silently broken.
    const legacyAiKey =
      typeof input.aiApiKey === "string" ? input.aiApiKey.trim() : "";
    // 2026-09-13 default flip: fresh installs (no provider field) land on
    // DEFAULT_PROVIDER "none" — but pre-dropdown installs that stored the
    // old single aiApiKey field (or the old "custom" provider marker)
    // must keep working, so those legacy signals still resolve to
    // minimax exactly as before the flip.
    const legacyProviderSignal =
      !!legacyAiKey || input.provider === "custom";
    const provider =
      legacyProviderSignal && !PROVIDER_IDS.includes(input.provider)
        ? "minimax"
        : normalizeProvider(input.provider);
    const preset = PROVIDER_PRESETS[provider];
    const glmApiType = normalizeGlmApiType(input.glmApiType);
    // Migration: earlier builds saved minimax's base URL without the /v1
    // prefix ("https://api.minimaxi.com"). That path now returns an nginx
    // 404 HTML page, which crashes JSON.parse downstream. Upgrade saved
    // values transparently so users don't have to clear storage.
    const rawBase =
      typeof input.aiBaseUrl === "string" ? input.aiBaseUrl.trim() : "";
    let resolvedBase = rawBase || preset.baseUrl;
    if (
      provider === "minimax" &&
      /^https?:\/\/api\.minimax[ai]+\.com\/?$/.test(resolvedBase)
    ) {
      resolvedBase = "https://api.minimaxi.com/v1";
    }
    if (provider === "glm") {
      // GLM has two OpenAI-compatible endpoints whose API keys are NOT
      // interchangeable. The apiType dropdown is the source of truth;
      // we honor a hand-edited aiBaseUrl only if the user actually
      // diverged from every known preset (a stored base equal to some
      // provider's preset is switch residue, not a hand edit).
      const glmUrl = resolveGlmBaseUrl(glmApiType);
      resolvedBase = !rawBase || PRESET_BASE_URLS.has(rawBase) ? glmUrl : rawBase;
    } else if (PRESET_BASE_URLS.has(rawBase)) {
      // Provider-switch residue (user report 2026-08-30): after switching
      // to DeepSeek the stored minimax base URL kept serving the request,
      // so the brand-new deepseek key hit the minimax endpoint and got a
      // 401 INVALID_AI_KEY. A stored base that exactly equals some
      // provider's preset is just the previous provider's residue — it
      // follows the newly selected provider's preset. Truly custom bases
      // (e.g. MiniMax international) are not in the preset set and
      // survive the switch untouched.
      resolvedBase = preset.baseUrl;
    }
    return {
      provider,
      deepseekApiKey:
        typeof input.deepseekApiKey === "string"
          ? input.deepseekApiKey.trim()
          : "",
      minimaxApiKey:
        typeof input.minimaxApiKey === "string"
          ? input.minimaxApiKey.trim()
          : legacyAiKey,
      glmApiKey:
        typeof input.glmApiKey === "string" ? input.glmApiKey.trim() : "",
      glmApiType,
      aiBaseUrl: resolvedBase,
      // Same residue rule as aiBaseUrl: a stored model matching some
      // provider's preset follows the current preset (otherwise minimax's
      // MiniMax-M3 would be sent to the DeepSeek endpoint right after a
      // switch); a genuinely custom model name survives the switch.
      aiModel:
        typeof input.aiModel === "string" &&
        input.aiModel.trim() &&
        !PRESET_MODELS.has(input.aiModel.trim())
          ? input.aiModel.trim()
          : preset.model,
      asrProvider: ["whisper", "minimax", "none"].includes(input.asrProvider)
        ? input.asrProvider
        : DEFAULTS.asrProvider,
      asrApiKey:
        typeof input.asrApiKey === "string" ? input.asrApiKey.trim() : "",
      // 2026-09-17: MiniMax cloud ASR — same shape as asrApiKey above,
      // but kept under its own key so the LLM key (minimax / deepseek /
      // glm / other) and the ASR key can be rotated independently.
      minimaxAsrApiKey:
        typeof input.minimaxAsrApiKey === "string" ? input.minimaxAsrApiKey.trim() : "",
      minimaxAsrModel:
        typeof input.minimaxAsrModel === "string" && input.minimaxAsrModel.trim()
          ? input.minimaxAsrModel.trim()
          : DEFAULTS.minimaxAsrModel,
      supadataApiKey: "",
      whisperUrl:
        typeof input.whisperUrl === "string" && input.whisperUrl.trim()
          ? input.whisperUrl.trim().replace(/\/+$/, "")
          : DEFAULTS.whisperUrl,
      whisperModel: WHISPER_MODELS.includes(input.whisperModel)
        ? input.whisperModel
        : DEFAULTS.whisperModel,
      whisperLanguage:
        typeof input.whisperLanguage === "string"
          ? input.whisperLanguage.trim()
          : "",
      subtitlesDir: (() => {
        const raw = typeof input.subtitlesDir === "string" ? input.subtitlesDir.trim() : "";
        // 2026-09-16 (Irene directive): legacy "BiliSubs" (the relative
        // default pre-2026-09-16) is no longer usable — whisper_server
        // resolved it against its own CWD and silently missed the
        // user's Downloads folder. Collapse it back to empty so the
        // background resolver can fill in an absolute path. User-set
        // paths (anything else, including absolute paths the user
        // typed) pass through untouched.
        if (raw && raw !== "BiliSubs") return raw.replace(/[\\/]+$/, "");
        return DEFAULTS.subtitlesDir;
      })(),
      exportDir:
        typeof input.exportDir === "string" && input.exportDir.trim()
          ? input.exportDir.trim().replace(/[\\/]+$/, "")
          : DEFAULTS.exportDir,
      // Notification toggles (2026-09-02). Strict boolean coercion: a
      // stored 0 / "false" / null / undefined all normalize to true
      // (DEFAULT ON) — users who never touched the setting must not be
      // silently muted by a corrupt storage value. 2026-09-02:
      // notifyOnSummary + notifyOnAnalysis are now a single field.
      // The OR-of-falsees rule preserves any previous OFF the user
      // set on EITHER of the old keys.
      notifyOnTranscribe: input.notifyOnTranscribe === false ? false : true,
      notifyOnSummaryAndAnalysis:
        input.notifyOnSummaryAndAnalysis === false ||
        input.notifyOnSummary === false ||
        input.notifyOnAnalysis === false
          ? false
          : true,
      // 2026-09-10: first-run onboarding banner flag. Strict true
      // check; anything else means "fresh install, show the banner".
      firstRunDismissed: input.firstRunDismissed === true,
    };
  }

  function migrateLegacyCustom(input = {}) {
    // Older settings used a separate `whisperEnabled` boolean. Translate it
    // into the new `asrProvider` enum so existing users keep their choice.
    if (input && input.asrProvider == null) {
      let asrProvider = DEFAULTS.asrProvider;
      if (input.whisperEnabled === true) asrProvider = "whisper";
      input = { ...input, asrProvider };
    }
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function activeApiKey(settings) {
    if (!settings) return "";
    if (settings.provider === "deepseek") return settings.deepseekApiKey || "";
    if (settings.provider === "minimax") return settings.minimaxApiKey || "";
    if (settings.provider === "glm") return settings.glmApiKey || "";
    // "other" provider has no built-in key — the user wires their own
    // service via the local-remix prompt. Return "" so save validation
    // skips the "add a key" gate when provider === "other".
    return "";
  }

  function applyProviderPreset(settings, provider) {
    const normalized = normalizeProvider(provider);
    const preset = PROVIDER_PRESETS[normalized];
    return {
      ...settings,
      provider: normalized,
      // When switching to a built-in provider, snap the endpoint/model
      // back to the preset. When switching to "other", keep whatever
      // custom baseUrl/model the user already configured — the preset
      // has empty values and would otherwise wipe the saved ones.
      // GLM is special: its two endpoints share the same preset, so
      // we re-resolve from glmApiType to keep the right URL.
      aiBaseUrl:
        normalized === "other"
          ? (settings.aiBaseUrl || "")
          : normalized === "glm"
            ? resolveGlmBaseUrl(settings.glmApiType)
            : preset.baseUrl,
      aiModel: normalized === "other" ? (settings.aiModel || "") : preset.model,
    };
  }

  function providerPreset(provider) {
    return PROVIDER_PRESETS[normalizeProvider(provider)];
  }

  // Resolve a deterministic, user-namespaced cache filename for a B-station
  // video, in the same `{date}_{title}_{UP}.{ext}` convention the manual
  // Markdown export + up-master-report use. This keeps the bililearn-written
  // Whisper cache discoverable by the same lookup logic that finds .md /
  // .txt / .srt files in `loadLocalSubtitleFile`, instead of being its
  // own ad-hoc `bvid_cid.json` namespace.
  //
  // We prefer the human-friendly naming whenever videoTitle / channelName /
  // pubDate are available. If any of those are missing (e.g. the cache
  // was written before metadata was captured), fall back to the old
  // `bvid_cid.{ext}` form so reads don't lose track of the file.
  function subtitleCacheFilename(bvid, cid, videoTitle, channelName, pubDate, ext) {
    const safeExt = String(ext || "json").replace(/[^a-z0-9]/gi, "");
    if (pubDate && videoTitle && channelName) {
      const cleanTitle = String(videoTitle)
        .replace(/[<>:"/\\|?*]/g, "_")
        .trim()
        .substring(0, 100);
      const cleanChannel = String(channelName)
        .replace(/[<>:"/\\|?*]/g, "_")
        .trim()
        .substring(0, 50);
      if (cleanTitle && cleanChannel) {
        return `${pubDate}_${cleanTitle}_${cleanChannel}.${safeExt}`;
      }
    }
    // Fallback: bvid_cid naming for legacy / metadata-less writes.
    const safeBvid = String(bvid || "").replace(/[^A-Za-z0-9]/g, "");
    const safeCid = String(cid || "").replace(/[^0-9]/g, "");
    if (!safeBvid || !safeCid) return null;
    return `${safeBvid}_${safeCid}.${safeExt}`;
  }

  // Resolve a deterministic, user-namespaced cache path for a B-station
  // (bvid, cid) pair. Returns null if the configured directory is empty —
  // callers must treat that as "no cache available" rather than writing
  // somewhere we don't intend to.
  function whisperCachePath(settings, bvid, cid, videoTitle, channelName, pubDate) {
    const dir = settings && typeof settings.subtitlesDir === "string"
      ? settings.subtitlesDir.trim().replace(/[\\/]+$/, "")
      : "";
    if (!dir) return null;
    const filename = subtitleCacheFilename(bvid, cid, videoTitle, channelName, pubDate, "json");
    if (!filename) return null;
    return `${dir}/${filename}`;
  }

  // 2026-09-13 (Irene directive): the *effective* subtitles dir used at
  // write/read time. If the stored value is empty, the consumer should
  // fall back to the default "BiliSubs" (relative) — chrome.downloads
  // resolves that to <Downloads>/BiliSubs and creates the folder on
  // first write. Callers that need a guaranteed non-empty path use this;
  // callers that need to distinguish "user has not set anything" use
  // settings.subtitlesDir directly.
  function effectiveSubtitlesDir(settings) {
    const raw = settings && typeof settings.subtitlesDir === "string"
      ? settings.subtitlesDir.trim()
      : "";
    if (raw) return raw.replace(/[\\/]+$/, "");
    return DEFAULTS.subtitlesDir; // "BiliSubs"
  }

  // Expand a `~`-prefixed path using KNOWN_HOMES. Returns the input
  // unchanged if it doesn't start with `~`. When no home is configured
  // (the default — see KNOWN_HOMES), returns "" so the caller falls back
  // to the browser's default download directory rather than writing to a
  // literal `~/...` path that no filesystem understands.
  function expandExportPath(value) {
    if (typeof value !== "string" || !value.startsWith("~")) return value || "";
    const rest = value.replace(/^~+/, ""); // drop the leading ~
    const sep = rest.startsWith("/") || rest.startsWith("\\") ? "" : "/";
    for (const home of KNOWN_HOMES) {
      if (!home) continue;
      return `${home}${sep}${rest}`;
    }
    return "";
  }

  // Resolve the chat-completions URL from the live settings, not DEFAULTS,
  // so users can point at MiniMax international or any compatible endpoint
  // without patching the extension.
  function chatCompletionsUrl(settings) {
    const base = (settings && settings.aiBaseUrl) || DEFAULTS.aiBaseUrl;
    return `${base.replace(/\/+$/, "")}/chat/completions`;
  }

  function canonicalBilibiliUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^BV[A-Za-z0-9]{10}$/.test(normalized)) {
      throw new Error("Invalid Bilibili BV ID.");
    }
    return `https://www.bilibili.com/video/${normalized}`;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    PROVIDER_PRESETS,
    PROVIDER_IDS,
    DEFAULT_PROVIDER,
    WHISPER_MODELS,
    GLM_ENDPOINTS,
    GLM_API_TYPES,
    DEFAULT_GLM_API_TYPE,
    resolveGlmBaseUrl,
    normalizeGlmApiType,
    isLegacyCustom,
    isLocalRemixProvider,
    normalize,
    normalizeProvider,
    migrateLegacyCustom,
    activeApiKey,
    applyProviderPreset,
    providerPreset,
    chatCompletionsUrl,
    canonicalBilibiliUrl,
    whisperCachePath,
    effectiveSubtitlesDir,
    expandExportPath,
    KNOWN_HOMES,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
