// kb-shared.js — KB 功能纯函数（sidepanel / options / background 三端共用）。
// 页面端: <script src="kb-shared.js"></script>; SW 端: importScripts("kb-shared.js");
// Spec: docs/superpowers/specs/2026-10-03-bililearn-kb-management-design.md
(function (global) {
  "use strict";

  const KB_BUILD_METHODS = ["karpathy", "nvwa", "raw"];
  const KB_UPDATE_MODES = ["realtime", "manual", "daily"];
  const KB_QUEUE_ALARM = "bililearn-kb-queue"; // realtime: periodInMinutes 0.5
  const KB_DAILY_ALARM = "bililearn-kb-daily"; // daily: 01:00 本机时区
  const PLATFORM_BILIBILI = "bilibili";
  const PLATFORM_YOUTUBE = "youtube";

  // YouTube ids are exactly 11 chars of [A-Za-z0-9_-] (same shape as
  // background.js YT_ID_RE); B站 BV ids are 12+ chars.
  function isYoutubeId(id) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
  }

  // KB 目录名清洗：文件系统非法字符 → `_`，尾部点/空格清除，60 字符截断。
  function sanitizeKbName(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\s.]+$/g, "")
      .trim()
      .slice(0, 60);
  }

  // 视频标题 → 文件名片段：ASCII 非法字符转空格（全角标点保留），80 字符截断。
  function sanitizeTitleForFile(title) {
    const cleaned = String(title || "")
      .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return cleaned || "untitled";
  }

  // videoId 形态: "BV1xxx@p2"（B站多P）或 "AbCdEfGhIjK@p1"（YouTube）
  function parseVideoId(videoId) {
    const [id, partToken] = String(videoId || "").split("@p");
    const page = Math.max(1, Number(String(partToken || "1")) || 1);
    return {
      id,
      page,
      platform: isYoutubeId(id) ? PLATFORM_YOUTUBE : PLATFORM_BILIBILI,
    };
  }

  function dedupKey(videoId) {
    const { id, page } = parseVideoId(videoId);
    return `${id}@p${page}`;
  }

  // "YYYY-MM-DD"（或 ISO 前缀）→ "YYYYMMDD"；缺失时回退今天。
  function compactDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }

  function videoFileName(topic, dateStr, page) {
    const base = `${sanitizeTitleForFile(topic)}_${compactDate(dateStr)}`;
    return page > 1 ? `${base}_P${page}.md` : `${base}.md`;
  }

  function yamlEscape(value) {
    return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // 组装 videos/*.md：YAML frontmatter + 分段正文。
  // segments 兼容 {from,to}（B站官方字幕）与 {start,end}（whisper）两种字段名。
  function buildKbDocument(meta, segments) {
    const fm = [
      "---",
      `speaker: ${meta.speaker || meta.author || "未知"}`,
      `author: ${meta.author || ""}`,
      `platform: ${meta.platform}`,
      `bvid: ${meta.bvid}`,
      meta.cid ? `cid: ${meta.cid}` : null,
      `page: ${meta.page || 1}`,
      `date: ${meta.date}`,
      `date_source: ${meta.dateSource || "pubdate"}`,
      `added_at: ${meta.addedAt}`,
      `lang: ${meta.lang || ""}`,
      `topic: "${yamlEscape(meta.topic)}"`,
      `url: ${meta.url || ""}`,
      `duration_s: ${meta.durationS || 0}`,
      "---",
    ].filter((line) => line !== null);
    const body = (segments || [])
      .map((s, i) => {
        const st = Number(s.start ?? s.from ?? 0).toFixed(2);
        const en = Number(s.end ?? s.to ?? 0).toFixed(2);
        return `## 段 ${i + 1}  [${st}s → ${en}s]\n\n${s.text || ""}`;
      })
      .join("\n\n");
    return `${fm.join("\n")}\n\n# ${meta.topic}\n\n${body}\n`;
  }

  // LLM 输入压缩：每 chunkSize 段拼一块，保留段号区间（确定性采样，不调 LLM）。
  function compressSegmentsForLlm(segments, chunkSize) {
    const size = chunkSize || 50;
    const out = [];
    for (let i = 0; i < (segments || []).length; i += size) {
      const chunk = segments.slice(i, i + size);
      out.push(`### 段 ${i + 1}-${i + chunk.length}\n${chunk.map((s) => s.text || "").join(" ")}`);
    }
    return out.join("\n\n");
  }

  global.KbShared = {
    KB_BUILD_METHODS, KB_UPDATE_MODES, KB_QUEUE_ALARM, KB_DAILY_ALARM,
    PLATFORM_BILIBILI, PLATFORM_YOUTUBE,
    isYoutubeId, sanitizeKbName, sanitizeTitleForFile, parseVideoId, dedupKey,
    compactDate, videoFileName, buildKbDocument, compressSegmentsForLlm,
  };
})(typeof self !== "undefined" ? self : globalThis);
