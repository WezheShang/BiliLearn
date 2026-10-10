// kb-client.js — whisper_server /kb/* 端点的轻量 fetch 封装。
// 三端可用：sidepanel / options（<script>）与 background（importScripts）。
// Base URL 默认 127.0.0.1:7860；消费方可先 KbClient.setBaseUrl(settings.whisperUrl)
// 与 ASR 通道保持一致（settings.js:157 DEFAULTS.whisperUrl）。
(function (global) {
  "use strict";

  let KB_SERVER_BASE = "http://127.0.0.1:7860";

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(KB_SERVER_BASE + path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error("KB_SERVER_OFFLINE");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `KB_HTTP_${res.status}`);
    return data;
  }

  const enc = encodeURIComponent;

  global.KbClient = {
    setBaseUrl(url) {
      if (typeof url === "string" && url.trim()) {
        KB_SERVER_BASE = url.trim().replace(/\/+$/, "");
      }
    },
    // → null 表示 server 不在线
    async health() {
      try { return await call("GET", "/health"); } catch { return null; }
    },
    pickRoot: () => call("POST", "/kb/pick_root", {}),
    list: (root) => call("GET", `/kb/list?root=${enc(root)}`),
    videos: (root, kb) => call("GET", `/kb/videos?root=${enc(root)}&kb=${enc(kb)}`),
    queue: (root, kb, state) => call("GET", `/kb/queue?root=${enc(root)}&kb=${enc(kb)}&state=${enc(state || "pending")}`),
    read: (root, path) => call("GET", `/kb/read?root=${enc(root)}&path=${enc(path)}`),
    create: (root, name, buildMethod, defaultSpeaker) =>
      call("POST", "/kb/create", { root, name, build_method: buildMethod, default_speaker: defaultSpeaker || "" }),
    write: (root, path, content) => call("POST", "/kb/write", { root, path, content }),
    deletePath: (root, path, recursive) => call("POST", "/kb/delete", { root, path, recursive: !!recursive }),
    move: (root, from, to) => call("POST", "/kb/move", { root, from, to }),
  };
})(typeof self !== "undefined" ? self : globalThis);
