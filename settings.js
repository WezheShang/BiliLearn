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
  const DEFAULT_PROVIDER = "minimax";

  // Chrome extensions cannot read $HOME / %USERPROFILE% directly, so we
  // keep a small lookup of the common homes for `~`-prefixed paths.
  // expandExportPath() picks the entry whose path exists on disk, falling
  // back to the first one. Update these if you move the extension to a
  // different machine or account.
  const KNOWN_HOMES = Object.freeze([
    "C:/Users/username",
    "/Users/username",
    "/home/username",
  ]);

  const DEFAULTS = Object.freeze({
    provider: DEFAULT_PROVIDER,
    deepseekApiKey: "",
    minimaxApiKey: "",
    glmApiKey: "",
    glmApiType: DEFAULT_GLM_API_TYPE,
    aiBaseUrl: PROVIDER_PRESETS[DEFAULT_PROVIDER].baseUrl,
    aiModel: PROVIDER_PRESETS[DEFAULT_PROVIDER].model,
    asrApiKey: "",
    supadataApiKey: "",
    // Local Whisper fallback (used when neither native B-station subtitles
    // nor Alibaba Bailian ASR produce useful text). Disabled by default —
    // the user must opt in and start whisper_server.py separately.
    whisperEnabled: false,
    whisperUrl: "http://127.0.0.1:7860",
    whisperModel: "base",
    whisperLanguage: "",
    // Where Whisper outputs and AI-corrected transcripts are cached on disk
    // so the user does not re-transcribe the same video on a later visit.
    // The path is user-configurable; we never write outside of it.
    subtitlesDir: "C:/Users/username/videoprocess/subtitles",
    // Where exported notes / summaries / reports are written. Defaults to
    // the system Downloads folder; the user can change it to any writable
    // directory (e.g. a project folder or the subtitles cache). Supports
    // `~/...` paths which the client expands using KNOWN_HOMES below.
    exportDir: "C:/Users/username/Downloads",
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
    const provider = normalizeProvider(input.provider);
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
      // diverged from the preset default.
      const glmUrl = resolveGlmBaseUrl(glmApiType);
      if (!rawBase || rawBase === preset.baseUrl) {
        resolvedBase = glmUrl;
      } else {
        resolvedBase = rawBase;
      }
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
      aiModel:
        typeof input.aiModel === "string" && input.aiModel.trim()
          ? input.aiModel.trim()
          : preset.model,
      asrApiKey:
        typeof input.asrApiKey === "string" ? input.asrApiKey.trim() : "",
      supadataApiKey: "",
      whisperEnabled: input.whisperEnabled === true,
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
      subtitlesDir:
        typeof input.subtitlesDir === "string" && input.subtitlesDir.trim()
          ? input.subtitlesDir.trim().replace(/[\\/]+$/, "")
          : DEFAULTS.subtitlesDir,
      exportDir:
        typeof input.exportDir === "string" && input.exportDir.trim()
          ? input.exportDir.trim().replace(/[\\/]+$/, "")
          : DEFAULTS.exportDir,
    };
  }

  function migrateLegacyCustom(input = {}) {
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

  // Resolve a deterministic, user-namespaced cache path for a B-station
  // (bvid, cid) pair. Returns null if the configured directory is empty —
  // callers must treat that as "no cache available" rather than writing
  // somewhere we don't intend to.
  function whisperCachePath(settings, bvid, cid) {
    const dir = settings && typeof settings.subtitlesDir === "string"
      ? settings.subtitlesDir.trim().replace(/[\\/]+$/, "")
      : "";
    if (!dir) return null;
    const safeBvid = String(bvid || "").replace(/[^A-Za-z0-9]/g, "");
    const safeCid = String(cid || "").replace(/[^0-9]/g, "");
    if (!safeBvid || !safeCid) return null;
    return `${dir}/${safeBvid}_${safeCid}.json`;
  }

  // Expand a `~`-prefixed path using KNOWN_HOMES. Returns the input
  // unchanged if it doesn't start with `~` or no home is configured.
  // Chrome MV3 has no API for $HOME / %USERPROFILE%, so we keep an
  // explicit list of homes we trust on this machine.
  function expandExportPath(value) {
    if (typeof value !== "string" || !value.startsWith("~")) return value || "";
    const rest = value.replace(/^~+/, ""); // drop the leading ~
    const sep = rest.startsWith("/") || rest.startsWith("\\") ? "" : "/";
    // Prefer the entry whose path actually exists on disk (the whisper
    // server can validate this for us via the filesystem, but the client
    // can also probe via fetch on a known sentinel — we keep it simple
    // and just pick the first configured home).
    for (const home of KNOWN_HOMES) {
      if (!home) continue;
      return `${home}${sep}${rest}`;
    }
    return value;
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
    expandExportPath,
    KNOWN_HOMES,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
