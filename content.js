/**
 * CONTENT SCRIPT
 *
 * This script runs ON the Bilibili page itself. It can see and modify
 * the Bilibili page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto Bilibili's progress bar
 * 3. Adding a "bililearn" button to Bilibili's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the Bilibili tab,
 * reading the page and making small visual changes.
 */

// ============================================================
// RE-INJECTION GUARD
// ============================================================
// background.js re-injects this file via chrome.scripting.executeScript
// when a tab's content script is orphaned (extension reloaded after the
// page loaded → "Receiving end does not exist"). A fresh injection runs
// in a fresh isolated world, so the flag below is unset there and init
// proceeds normally. If this file is somehow evaluated twice in the SAME
// world, the throw aborts the duplicate before it can register a second
// set of listeners/buttons/timers.
//
// 2026-10-27: 改成**按版本**判断。同一个版本重复注入 → 照旧抛错跳过；
// 但版本变了（扩展更新后后台重新注入）→ 允许装新的，并且先把上一版
// 注册的消息监听器摘掉，避免两个监听器同时回话（Chrome 会报
// "sendResponse 被调用多次"）。
const BILILEARN_CONTENT_VERSION = 4;
if (globalThis.__BILILEARN_CONTENT_VERSION__ === BILILEARN_CONTENT_VERSION) {
  throw new Error(
    "[bililearn] content.js already loaded in this world — skipping duplicate injection",
  );
}
globalThis.__BILILEARN_CONTENT_VERSION__ = BILILEARN_CONTENT_VERSION;
if (globalThis.__BILILEARN_CONTENT_LISTENER__) {
  try {
    chrome.runtime.onMessage.removeListener(
      globalThis.__BILILEARN_CONTENT_LISTENER__,
    );
  } catch (_e) {
    /* 摘不掉就算了（旧监听器在新上下文里通常已经失效） */
  }
}

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdNoteFullscreenListenerAdded = false;
let ytdNotePlayerContainer = null;
let ytdBililearnButton = null;
let bililearnButtonObserver = null;
let bililearnButtonReconcileTimer = null;
let bililearnButtonResizeListenerAdded = false;
const BILILEARN_BUTTON_POSITION_KEY = "bililearnButtonPosition";

// 2026-10-16 anti-hang budget for the body observer. See setupButtonObserver.
// A watch page legitimately mutates constantly; the point is to catch the
// runaway case, not to throttle normal Bilibili rendering.
const OBSERVER_MAX_CALLS_PER_SEC = 60;
const OBSERVER_COOLDOWN_MS = 2000;
const observerStats = { calls: 0, trips: 0, window: [], pausedUntil: 0 };
// Exposed for DevTools inspection: __bililearnStats in the page console.
if (typeof window !== "undefined") {
  window.__bililearnStats = observerStats;
}
let legacyButtonPositionCleaned = false;

// ============================================================
// XUETANGX (学堂在线) STATE BRIDGE
// ============================================================
//
// 学堂在线的学习接口全部要求登录态，从扩展的 service worker 直接调会被拒
// （"user is not login" / "身份认证信息未提供。"）。所以我们不在扩展里复刻
// 这套鉴权，而是搭页面自己的便车：
//
//   主世界钩子 xuetangx-hook.js（document_start 注入，world=MAIN）
//     → 拦截页面自己的 fetch / XHR，记下 leaf_info / s_t_c / s_t_g_p /
//       playurl / menu 的响应
//     → 通过 window.postMessage 把状态推给隔离世界
//
//   本文件（隔离世界）
//     → 收到状态后缓存起来，并转告 background（换小节要通知侧边栏刷新）
//
// 隔离世界读不到主世界的 JS 对象，postMessage 的数据是结构化克隆的，
// 所以两个世界都能读。

const XUETANGX_HOST_RE = /(^|\.)xuetangx\.com$/i;
const XUETANGX_CHANNEL = "bililearn-xuetangx";
// 2026-10-27: 我们期望的主世界钩子版本。扩展刷新不会更新已打开页面里的
// 钩子 JS —— 页面里的旧钩子会一直活着并发状态。后台发现版本对不上会重新
// 注入；这里负责把"更旧版本钩子发来的状态"丢掉，避免新旧混在一起。
const XUETANGX_HOOK_VERSION = 7;
let xtState = null;
let xtStateReceivedAt = 0;
let xtNotifiedVideoId = "";
// 2026-10-27: 页面里同时活着新旧两个钩子的标记。旧钩子会跟新版一起打接口
// （请求量翻倍 → 被服务端按"刷接口"限流，2026-10-27 实测第一发 200、之后全 403）。
// 发现了就要明确告诉用户刷新页面，而不是让用户自己撞墙。
let xtStaleHookSeen = false;

function isXuetangxPage() {
  return XUETANGX_HOST_RE.test(window.location.hostname);
}

/**
 * 2026-11-05: 当前是不是 B 站视频页。
 * 官方字幕必须走页面主世界取（带登录态），只在 B 站页面上有意义。
 */
const BILIBILI_VIDEO_HOST_RE = /(^|\.)bilibili\.com$/i;
function isBilibiliVideoPage() {
  if (!BILIBILI_VIDEO_HOST_RE.test(window.location.hostname)) return false;
  return /\/video\//i.test(window.location.pathname);
}

/** 学堂在线的小节标识：优先 leaf_id，没有就用 ccid（视频本体标识）。 */
function xuetangxVideoId(state) {
  const s = state || xtState || {};
  const cid = String(s.cid || "").trim();
  const leaf = String(s.leafId || s.ccid || "").trim();
  if (!cid && !leaf) return "";
  return `xt-${cid || "0"}-${leaf || "0"}`;
}

function handleXuetangxStateMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== XUETANGX_CHANNEL || data.type !== "state") return;
  const next = data.payload || null;
  if (!next) return;
  // 旧钩子发来的状态一律忽略（页面里可能同时活着新旧两个钩子）
  const incoming = Number(next.hookVersion || 0);
  const current = Number(xtState?.hookVersion || 0);
  if (incoming < XUETANGX_HOOK_VERSION) {
    // 页面里还跑着旧版钩子 —— 记下来，后面提示用户刷新页面。
    xtStaleHookSeen = true;
  }
  if (incoming < current) return;
  if (incoming < XUETANGX_HOOK_VERSION && current >= XUETANGX_HOOK_VERSION) return;
  xtState = next;
  xtStateReceivedAt = Date.now();

  // 只在"换小节"时通知 background，避免接口每次返回都刷一次侧边栏。
  const videoId = xuetangxVideoId(xtState);
  if (videoId && videoId !== xtNotifiedVideoId) {
    xtNotifiedVideoId = videoId;
    try {
      const p = chrome.runtime.sendMessage({
        action: "xuetangxStateChanged",
        state: xtState,
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_e) {}
  }
}

/**
 * 向主世界钩子索要一次当前状态（钩子可能晚于页面加载才被注入）。
 * force = 用户点了"重试" → 让钩子把探针矩阵重新跑一遍。
 */
function requestXuetangxState(force) {
  try {
    window.postMessage(
      { source: XUETANGX_CHANNEL, type: "request", force: !!force },
      "*",
    );
  } catch (_e) {}
}

/**
 * 2026-10-27: 从页面 DOM 里找字幕文件地址。
 *
 * 播放器拿到 s_t_g_p 返回的字幕列表后，会把它挂进 <track>（或者以
 * 带字幕特征的文件名出现）。那是"页面此刻真在用的字幕"，比接口可靠 ——
 * 任何接口时序问题都不会影响它。
 */
function findXuetangxSubtitleUrl() {
  try {
    const tracks = document.querySelectorAll("track");
    for (const track of tracks) {
      const src = track.getAttribute("src") || track.src || "";
      if (src) return src;
    }
    // 有些播放器把字幕放在别的元素上（<source>、带 src 的 script/link）
    const nodes = document.querySelectorAll(
      'source[src], a[href], link[href], [data-src], [data-url]',
    );
    for (const node of nodes) {
      const src =
        node.getAttribute("src") ||
        node.getAttribute("href") ||
        node.getAttribute("data-src") ||
        node.getAttribute("data-url") ||
        "";
      if (/subtitle|caption|\.srt(\?|$)|\.vtt(\?|$)|\.json(\?|$)/i.test(src)) {
        return src;
      }
    }
  } catch (_e) {}
  return "";
}

/** 读 csrftoken cookie（隔离世界读得到普通 cookie）。 */
function readCsrftoken() {
  try {
    const hit = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("csrftoken="));
    return hit ? decodeURIComponent(hit.slice("csrftoken=".length)) : "";
  } catch (_e) {
    return "";
  }
}

/**
 * 2026-10-27: **完全独立**的字幕地址获取路径。
 *
 * 隔离世界和页面同源（origin 就是 www.xuetangx.com），所以 fetch 学堂在线的
 * 接口会带上这个页面的登录 cookie —— 跟主世界钩子能拿到的是同一份权限。
 * 区别是：这条路径**不依赖钩子**。钩子因为任何原因没跑起来（页面在扩展
 * 装好之前就打开了 / 钩子版本旧了 / MAIN world 注入被拒），这条路径照样
 * 能把字幕地址拿到。
 *
 * 前提是要有 ccid（视频本体标识），它同样可以自己拉 leaf_info 拿。
 */
async function fetchXuetangxSubtitleDirectly(state) {
  try {
    let ccid = String(state?.ccid || "").trim();
    const headers = {
      "Content-Type": "application/json",
      xtbz: "xt",
      "app-name": "xtzx",
      "terminal-type": "web",
      "x-client": "web",
    };
    const csrf = readCsrftoken();
    if (csrf) headers["X-CSRFToken"] = csrf;

    // 没有 ccid → 先用 leaf_info 换
    if (!ccid && state?.cid && state?.leafId) {
      const signs = [state.sign || "", ...(state.signCandidates || [])].filter(
        (v, i, arr) => arr.indexOf(v) === i,
      );
      for (const sign of signs) {
        const suffix = sign ? `?sign=${encodeURIComponent(sign)}` : "";
        const res = await fetch(
          `/api/v1/lms/learn/leaf_info/${state.cid}/${state.leafId}/${suffix}`,
          { method: "GET", credentials: "include", headers, cache: "no-store" },
        );
        if (!res.ok) continue;
        const json = await res.json();
        const media = json?.data?.content_info?.media;
        if (media?.ccid) {
          ccid = String(media.ccid);
          break;
        }
      }
    }
    if (!ccid) return "";

    // 拿字幕文件地址。线上 s_t_g_p({c_d: ccid}) 会回 data:{}（空对象），
    // 说明主键/参数没对上 —— 这里把几种常见姿势都试一遍，跟主世界钩子
    // 里的"探针矩阵"是同一套思路，只是少一些变体（这条是兜底路径，
    // 正常情况下钩子已经拿到了）。
    const ids = [ccid, String(state?.leafId || "").trim()].filter(Boolean);
    const bodies = [];
    for (const id of ids) bodies.push({ c_d: id });
    bodies.push({ c_d: ccid, d_l: 0 });
    bodies.push({ c_d: ccid, d_l: 1 });
    bodies.push({ ccid });

    for (const body of bodies) {
      const res = await fetch("/api/v1/lms/service/s_t_g_p/", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      if (!list.length) continue;
      const pick =
        list.find((it) => Number(it?.lang) === 0) ||
        list.find((it) => Number(it?.lang) === 1) ||
        list[0];
      const url = pick?.data || pick?.url || pick?.src;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }

    // 另一个字幕端点（前端留着但没用的那个）
    for (const id of ids) {
      const res = await fetch(`/api/v1/lms/learn/video/subtitle/${id}/`, {
        method: "GET",
        credentials: "include",
        headers,
        cache: "no-store",
      });
      if (!res.ok) continue;
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      if (!list.length) continue;
      const pick =
        list.find((it) => Number(it?.lang) === 0) ||
        list.find((it) => Number(it?.lang) === 1) ||
        list[0];
      const url = pick?.data || pick?.url || pick?.src;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
    }
  } catch (_e) {
    /* 拿不到就当没有 */
  }
  return "";
}

/**
 * 2026-10-27: **同源直取讲稿**。
 *
 * 钩子那边的主路径已经能拿到讲稿了（leaf_lecture_note），这条是它整个
 * 挂掉时的独立兜底 —— 隔离世界和页面同源，fetch 会带上这个页面的登录
 * cookie，权限跟主世界一样。
 *
 * 跟字幕文件那条路（fetchXuetangxSubtitleDirectly）相比，这条更靠谱：
 * 纯 GET、不需要 CSRF、一个请求就返回整篇带时间戳的文字稿。
 */
async function fetchXuetangxLectureNoteDirectly(state) {
  const leafId = String(state?.leafId || "").trim();
  if (!leafId) return null;
  try {
    const res = await fetch(
      `/c27/online_courseware/leaf_lecture_note/${encodeURIComponent(leafId)}/`,
      {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          xtbz: "xt",
          "app-name": "xtzx",
          "terminal-type": "web",
          "x-client": "web",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    const rows = [];
    for (const item of list) {
      const content = String(
        item?.formalParagraphText ?? item?.paragraphText ?? item?.text ?? "",
      ).trim();
      if (!content) continue;
      // 接口给的是毫秒
      const start = Math.max(0, Number(item?.startTime ?? 0) / 1000);
      let end = Math.max(0, Number(item?.endTime ?? 0) / 1000);
      if (!end || end < start) end = start + 3;
      rows.push({ start, end, content });
    }
    if (!rows.length) return null;
    return { rows };
  } catch (_e) {
    return null;
  }
}

/**
 * 交出状态前的最后一道：钩子没给字幕地址时，隔离世界自己同源拉一次。
 */
async function respondXuetangxState(sendResponse, state) {
  let finalState = state;
  // 讲稿正文已经在状态里（subtitleBody）→ 字幕已经有了，别再去找字幕文件。
  if (finalState && !finalState.subtitleUrl && !finalState.subtitleBody) {
    const fromDom = findXuetangxSubtitleUrl();
    if (fromDom) {
      finalState = { ...finalState, subtitleUrl: fromDom };
    } else {
      // 先试讲稿（GET，最容易成功），再退回字幕文件地址那条老路。
      const note = await fetchXuetangxLectureNoteDirectly(finalState);
      if (note) {
        finalState = {
          ...finalState,
          hasSubtitle: true,
          hasLectureNote: true,
          lectureNoteSource: "leaf_lecture_note",
          subtitleSource: "lecture-note",
          subtitleLang: finalState.subtitleLang || "zh",
          subtitleBody: JSON.stringify({ subtitle_list: note.rows }),
        };
      } else {
        const direct = await fetchXuetangxSubtitleDirectly(finalState);
        if (direct) finalState = { ...finalState, subtitleUrl: direct };
      }
    }
  }
  if (!finalState) {
    sendResponse({ success: false, state: null, videoId: "" });
    return;
  }
  sendResponse({
    success: true,
    state: finalState,
    videoId: finalState.videoId || "",
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handleXuetangxStateMessage);
}

/**
 * 学堂在线播放器的容器。笔记按钮按容器矩形定位，所以要找一个能代表
 * "播放器画面区域"的元素：<video class="xt_video_player"> 往上一层的
 * 有尺寸的包装元素。
 */
function findXuetangxPlayerContainer() {
  const video = document.querySelector("video.xt_video_player, video");
  if (!video) return null;
  let node = video.parentElement;
  for (let i = 0; i < 4 && node; i++) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 240 && rect.height > 120) return node;
    node = node.parentElement;
  }
  return video.parentElement || video;
}

/** 学堂在线的"课程 / 授课教师" —— DOM 只是兜底，接口捕获才是权威。 */
function pickXuetangxDomMeta() {
  const pick = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = (el?.textContent || "").trim();
      if (text) return text;
    }
    return "";
  };
  return {
    courseTitle: pick([
      "[class*='course-name']",
      "[class*='course_title']",
      "[class*='courseInfo'] h1",
      "[class*='courseInfo'] h2",
      "h1",
      "h2",
    ]),
    teacher: pick([
      "[class*='teacher_name']",
      "[class*='teacher-name']",
      "[class*='lecturer']",
      "[class*='teacher']",
    ]),
  };
}

/**
 * 学堂在线的视频信息。标题优先用接口捕获的小节名（leaf_info 的 name），
 * DOM 兜底 —— 因为学堂在线是 Vue SPA，标题节点在移动/桌面布局下类名不同，
 * 纯 DOM 抓取很脆。
 */
function extractXuetangxVideoInfo() {
  const state = xtState || {};
  const meta = pickXuetangxDomMeta();
  const video = document.querySelector("video");
  const docTitle = (document.title || "").split(" - ")[0].trim();

  const title =
    state.leafTitle || meta.courseTitle || docTitle || "学堂在线课程";
  const channelName = state.courseTitle || meta.teacher || "";
  const description = state.leafTitle
    ? `${state.courseTitle || meta.courseTitle || ""}｜${state.leafTitle}`.replace(
        /^｜/,
        "",
      )
    : meta.courseTitle || "";

  return {
    title,
    channelName,
    description,
    duration: Number(video?.duration) || Number(state.duration) || 0,
    pubdate: "",
    // 学堂在线没有 BV 号，用 cid + 小节 id 拼一个稳定 id
    videoId: xuetangxVideoId(state),
    source: "xuetangx",
    leafId: state.leafId || "",
    ccid: state.ccid || "",
    hasSubtitle: !!state.hasSubtitle,
    subtitleUrl: state.subtitleUrl || "",
    subtitleLang: state.subtitleLang || "",
  };
}

/**
 * 在学堂在线页面注入 "AI 总结" 按钮。
 * 优先放在 "加入学习" 按钮旁边 —— 那是课程信息区，位置稳定、语义正确；
 * 找不到就退回到播放器容器。
 */
function injectXuetangxButton() {
  const existing = document.getElementById("ytd-bililearn-button");
  const joinBtn = document.querySelector(".join-btn");
  const player = findXuetangxPlayerContainer();

  let host = null;
  let anchor = null;
  if (joinBtn && joinBtn.parentElement) {
    host = joinBtn.parentElement;
    anchor = joinBtn;
  } else if (player && player.parentElement) {
    host = player.parentElement;
    anchor = player;
  }
  if (!host) {
    debugLog("[dk-bililearn Content] xuetangx: no anchor for button yet");
    return false;
  }

  let button = existing;
  if (!button) {
    button = createBililearnButton();
    button.id = "ytd-bililearn-button";
    // 复用 B 站那套按钮工厂，但这里是"插进页面流"而不是"绝对定位浮层"
    button.style.position = "static";
    button.style.marginLeft = "10px";
    button.style.height = "34px";
    button.style.padding = "0 16px";
    button.style.boxShadow = "none";
  }

  if (button.parentElement !== host) {
    if (anchor && anchor.parentElement === host) {
      anchor.insertAdjacentElement("afterend", button);
    } else {
      host.appendChild(button);
    }
  }

  ytdBililearnButton = button;
  debugLog("[dk-bililearn Content] xuetangx button injected");
  return true;
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our bililearn button and Note button.
 * We wait a bit for Bilibili's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  if (!ytdNoteFullscreenListenerAdded) {
    document.addEventListener("fullscreenchange", handleNoteFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleNoteFullscreenChange);
    ytdNoteFullscreenListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectBililearnButton();
  tryInjectNoteButton();

  // 学堂在线：向主世界钩子要一次当前小节状态（钩子是 document_start 注入的，
  // 但页面可能比扩展先加载好，这时再问一次能补上状态）。
  if (isXuetangxPage()) {
    requestXuetangxState();
  }

  // Also set up an observer to handle Bilibili's dynamic content loading
  // (Bilibili is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupBililearnButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. Bilibili renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  const isXuetangx = isXuetangxPage();
  if (!isXuetangx && !window.location.pathname.includes("/video/")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = isXuetangx
      ? findXuetangxPlayerContainer()
      : document.querySelector(
          ".bpx-player-container, .bilibili-player, #bilibili-player",
        );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[dk-bililearn Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * 2026-11-05: B站官方字幕 —— 在**页面主世界**里取（main world hook）。
 *
 * 为什么必须在这里取：B站只对**登录用户**下发字幕列表。未登录时
 * /x/player/wbi/v2 返回 `need_login_subtitle: true` + 空列表（实测：
 * 无签名 / 旧版 / 正确 wbi 签名三种调用结果完全一样）。
 *
 * 而 service worker 里 `credentials: "include"` 的跨站请求属于第三方
 * 上下文 —— 现在浏览器默认挡第三方 cookie，登录 cookie 送不出去 →
 * 扩展拿不到字幕轨 → 面板误判成"这个视频没有字幕"，直接叫用户上
 * Whisper。用户看到的现象就是"明明有字幕，却让我用 whisper；过一会儿
 * 切来切去它自己出现了"（后来出现的是 whisper 转录后落盘的本地文件
 * 命中了本地文件路径）。
 *
 * 为什么是"主世界"而不是"隔离世界里的 content.js 直接 fetch"：
 * 隔离世界的 fetch 属于扩展上下文，B 站的 api.bilibili.com 对
 * `Origin: chrome-extension://<id>` 根本不会回 CORS 允许头
 * （实测只回 `Access-Control-Allow-Origin: https://www.bilibili.com`）。
 * 主世界里 fetch 就是页面自己的 fetch：Origin 是 www.bilibili.com、
 * Referer 是页面地址、cookie 是这一份登录态 —— B 站自己就是这么读的。
 *
 * 通道：主世界 hook（bilibili-subtitle-hook.js，manifest 里 world=MAIN）
 * 监听 window.postMessage，用 fetch 取数后 postMessage 回来；隔离世界
 * 这里只做中转。学堂在线的 xuetangx-hook.js 早就在用同一套模式。
 *
 * 返回形状与 background 的 fetchBilibiliOfficialSubtitle 一致。
 */
const BILIBILI_SUBTITLE_CHANNEL = "bililearn-bili-subtitle";
const BILIBILI_SUBTITLE_TIMEOUT_MS = 6000;
// 2026-11-05: 第一次请求用短超时做"钩子在不在"的探测。
// 扩展刚更新/重载时，页面里已有的 MAIN world 钩子不会被重新注入
// （manifest 的 content_scripts 只在页面加载时跑一次），第一发必然
// 超时。background 收到 "hook_missing" 后会主动注入钩子再重试一次
// （那时用长超时）。这样不用逼用户 F5 刷新页面。
//
// 探测周期不能太长：用户抱怨"判断一个视频有没有字幕要等 45 秒"。
// 钩子在的话是**秒回**（实测 40ms 内），钩子不在才是超时 —— 所以
// 1.5s 的探测足够区分两者，再长只是白白让用户等。
const BILIBILI_SUBTITLE_PROBE_TIMEOUT_MS = 1500;
let biliSubtitleSeq = 0;
const biliSubtitlePending = new Map();

// 主世界 hook 的回话（两条通道共用一个 listener）
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== BILIBILI_SUBTITLE_CHANNEL || data.type !== "reply") return;
  const pending = biliSubtitlePending.get(data.id);
  if (!pending) return;
  biliSubtitlePending.delete(data.id);
  clearTimeout(pending.timer);
  pending.resolve(data.payload || { ok: false, reason: "empty_reply", error: "页面没有回话。" });
});

/**
 * 向页面主世界发一条请求，等它的回话。
 * 超时按失败返回，绝不把调用方挂死。
 */
function requestBilibiliInPage(payload, timeoutMs = BILIBILI_SUBTITLE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!payload || typeof payload !== "object") {
      resolve({ ok: false, reason: "bad_request", error: "请求内容不合法。" });
      return;
    }
    const id = `bili-${Date.now()}-${++biliSubtitleSeq}`;
    const timer = setTimeout(() => {
      biliSubtitlePending.delete(id);
      resolve({ ok: false, reason: "timeout", error: "页面上下文取字幕超时。" });
    }, timeoutMs);
    biliSubtitlePending.set(id, { resolve, timer });
    try {
      window.postMessage({ source: BILIBILI_SUBTITLE_CHANNEL, type: "request", id, ...payload }, "*");
    } catch (error) {
      biliSubtitlePending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, reason: "post_failed", error: (error && error.message) || String(error) });
    }
  });
}

/**
 * 取 B 站官方字幕轨列表（在页面主世界里发请求，带上登录态）。
 * 返回 { success, tracks, needLogin } —— tracks 是字幕轨的元信息，
 * 字幕文件本体由 background 下载（那边有 host 权限和 DNR Referer 规则）。
 *
 * timeoutMs 由调用方给：第一次用短超时探测钩子在不在（超时 → 报
 * hook_missing，让 background 注入钩子后重试），第二次用长超时。
 */
async function fetchBilibiliSubtitleTracksInPage(bvid, cid, timeoutMs) {
  if (!bvid || !cid) {
    return { success: false, reason: "missing_ids", error: "缺少 bvid 或 cid", tracks: [] };
  }
  const reply = await requestBilibiliInPage(
    { bvid, cid },
    timeoutMs || BILIBILI_SUBTITLE_PROBE_TIMEOUT_MS,
  );
  if (!reply || !reply.ok) {
    const reason = (reply && reply.reason) || "page_failed";
    return {
      success: false,
      reason: reason === "timeout" ? "hook_missing" : reason,
      error:
        reason === "timeout"
          ? "页面主世界钩子没有回话（扩展刚更新过，钩子需要重新注入）。"
          : (reply && reply.error) || "页面上下文没有返回字幕列表。",
      tracks: [],
    };
  }
  const tracks = Array.isArray(reply.tracks) ? reply.tracks : [];
  if (!tracks.length) {
    return {
      success: false,
      reason: "no_tracks",
      error: reply.needLogin
        ? "B 站要求登录后才能下发字幕列表（need_login_subtitle=true）。"
        : "B 站未返回任何字幕轨。",
      needLogin: !!reply.needLogin,
      tracks: [],
    };
  }
  return { success: true, tracks, needLogin: !!reply.needLogin };
}

/**
 * 在页面主世界里下载字幕文件本体（备用路径）。
 * background 那边有 host 权限 + DNR Referer 规则，正常它自己就能下；
 * 万一它失败（403 / 跨域被拦），走这里用页面的身份再试一次。
 */
async function fetchBilibiliSubtitleFileInPage(url) {
  if (!url) {
    return { success: false, reason: "missing_url", error: "缺少字幕文件地址。" };
  }
  const reply = await requestBilibiliInPage({ url });
  if (!reply || !reply.ok) {
    return {
      success: false,
      reason: (reply && reply.reason) || "page_failed",
      error: (reply && reply.error) || "页面上下文没有返回字幕文件。",
    };
  }
  if (!reply.body) {
    return { success: false, reason: "empty_file", error: "字幕文件里没有正文。" };
  }
  return { success: true, body: reply.body };
}

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 *
 * 2026-10-27: 监听器挂到 globalThis 上 —— 后台重新注入新版 content.js 时
 * 要能把上一版摘掉，否则两个监听器同时回话。
 */
const bililearnContentListener = (message, sender, sendResponse) => {
  debugLog("[dk-bililearn Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[dk-bililearn Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "getXuetangxState") {
    // 2026-10-26: 学堂在线 —— background 需要当前小节的 ccid / 字幕地址 /
    // 视频直链。这些信息在主世界钩子里，这里做一次中转。
    if (!isXuetangxPage()) {
      sendResponse({ success: false, state: null });
      return false;
    }
    const buildState = () => {
      if (!xtState) return null;
      return {
        ...xtState,
        // 视频直链优先用 DOM 里 <video src> 的当前值：页面上那个带
        // auth_key 的地址才是"此刻能播"的那一个。
        videoUrl:
          document.querySelector("video")?.currentSrc ||
          document.querySelector("video")?.src ||
          xtState.videoUrl ||
          "",
        // 2026-10-27: 字幕地址的兜底 —— 播放器自己会把字幕做成 <track>
        // （或带字幕特征的元素）挂在 DOM 上，那是页面"此刻真在用的"字幕，
        // 比任何接口都可靠。钩子没抓到时用这个。
        subtitleUrl: xtState.subtitleUrl || findXuetangxSubtitleUrl(),
        videoId: xuetangxVideoId(xtState),
        receivedAt: xtStateReceivedAt,
        // 页面里还有旧版钩子在跑（会跟新版抢接口）
        staleHookSeen: xtStaleHookSeen,
      };
    };
    const existing = buildState();
    // force = 用户点了"重试" → 让钩子把字幕探针矩阵重新跑一遍。
    // 本地这份也先标成"未就绪"，否则 poll 会立刻把旧状态交出去，
    // 白白错过钩子重跑的结果。
    const force = !!message.force;
    if (force && xtState) {
      xtState = { ...xtState, resolved: false };
    }
    // 已经有就绪状态 → 立刻交出去。
    //
    // 2026-10-27: 这里**不判断版本**。内容脚本只管"把手上最新的状态交出来"，
    // 至于这份状态是不是旧钩子留下的，交给 background 判断（它发现版本旧
    // 会重新注入钩子并轮询）。内容脚本要是自己在这里等 12 秒，background
    // 的轮询就被拖死了 —— 2026-10-27 踩过：旧钩子的状态"已 resolved"，
    // 内容脚本立刻返回旧状态，background 拿到后直接用，新钩子虽然注入了
    // 却没人等。
    if (existing && existing.resolved && !force) {
      respondXuetangxState(sendResponse, existing);
      return true; // 异步响应（respond 里可能还要补一次同源请求）
    }
    // 还没有（补齐中的）状态：先向主世界钩子要一次，等它把当前小节补齐。
    // 扩展刚装/刚更新时页面早就加载完了，钩子错过了第一次请求 —— 这时
    // 钩子会主动调学堂在线的接口把数据补上（跑在页面上下文里，带页面
    // 自己的登录 cookie），所以要等它跑完而不是立刻回空。
    requestXuetangxState(force);
    const started = Date.now();
    // 2026-10-27: 探针矩阵现在带限速（每发之间隔 700ms + 403 重试 2.5s），
    // 跑完要十几秒 —— 8 秒的等待上限会把还在跑的结果判成"超时"。
    const deadline = started + 25000;
    const poll = () => {
      const state = buildState();
      if (state && state.resolved) {
        respondXuetangxState(sendResponse, state);
        return;
      }
      // 一点状态都没有 → 多半是主世界钩子压根没跑（扩展刚更新/页面先开）。
      // 早点回空，background 就能立刻补注入钩子再问一次。
      if (!state && Date.now() - started > 1200) {
        sendResponse({ success: false, state: null, videoId: "" });
        return;
      }
      if (Date.now() >= deadline) {
        // 超时也把手上有的交出去 —— 至少 leafId/ccid 可用时还能走 Whisper
        respondXuetangxState(sendResponse, state);
        return;
      }
      setTimeout(poll, 150);
    };
    setTimeout(poll, 150);
    return true; // 异步响应
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video");
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[dk-bililearn Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getYouTubeTranscriptFromDOM") {
    // 2026-09-29: the browser is already inside youtube.com — no
    // yt-dlp, no proxy fingerprint, no server round-trip. The
    // transcript comes from one of two equivalent paths, mirroring
    // how fetchBilibiliOfficialSubtitle hits B站's player/wbi/v2 API:
    //
    //   1. Page-state path (preferred): read the `ytInitialPlayerResponse`
    //      JSON that every watch page embeds in a <script>, look up
    //      `captions.playerCaptionsTracklistRenderer.captionTracks`,
    //      fetch the chosen track's `baseUrl` directly via the
    //      browser's trusted identity. Same as B站's
    //      `subtitle.subtitles[i].subtitle_url` — public, no auth
    //      dance when the user is already signed in.
    //   2. DOM path (fallback): click "Show transcript" if the page
    //      state didn't expose tracks (rare SPA layout shifts).
    //
    // Both paths return the canonical envelope; the background falls
    // through to whisper_server only when BOTH fail.
    extractYouTubeTranscriptFromPageState()
      .then(async (pageState) => {
        if (pageState && pageState.success) return pageState;
        // Page-state path failed — try the on-page transcript panel.
        const dom = await extractYouTubeTranscriptFromDOM();
        return dom;
      })
      .then((payload) => sendResponse(payload))
      .catch((err) =>
        sendResponse({
          success: false,
          reason: "exception",
          error: String(err?.message || err),
        }),
      );
    return true; // Async response.
  }

  if (message.action === "getBilibiliOfficialSubtitles") {
    // 2026-11-05: B站官方字幕 —— 必须在**页面主世界**取（带登录态）。
    // 隔离世界/SW 的跨站请求送不出登录 cookie，B 站会回
    // need_login_subtitle=true + 空列表 → 面板误判成"没字幕"。
    // 详见 fetchBilibiliSubtitleTracksInPage 上方的说明。
    if (!isBilibiliVideoPage()) {
      sendResponse({
        success: false,
        reason: "not_bilibili_page",
        error: "当前页面不是 B 站视频页。",
        tracks: [],
      });
      return false;
    }
    fetchBilibiliSubtitleTracksInPage(
      message.bvid,
      message.cid,
      Number(message.timeoutMs) || undefined,
    )
      .then((payload) => sendResponse(payload))
      .catch((err) =>
        sendResponse({
          success: false,
          reason: "exception",
          error: String(err?.message || err),
          tracks: [],
        }),
      );
    return true; // 异步响应
  }

  if (message.action === "getBilibiliSubtitleFile") {
    // 字幕文件本体的备用下载路径（background 自己下失败时走这里）
    fetchBilibiliSubtitleFileInPage(message.url)
      .then((payload) => sendResponse(payload))
      .catch((err) =>
        sendResponse({
          success: false,
          reason: "exception",
          error: String(err?.message || err),
        }),
      );
    return true; // 异步响应
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[dk-bililearn Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
};
globalThis.__BILILEARN_CONTENT_LISTENER__ = bililearnContentListener;
chrome.runtime.onMessage.addListener(bililearnContentListener);

// ============================================================
// BILILEARN BUTTON INJECTION
// ============================================================

/**
 * Injects a "bililearn" button into Bilibili's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the dk-bililearn side panel.
 */
function isVisibleBililearnHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * Bilibili keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findBililearnButtonHost() {
  const candidates = Array.from(
    document.querySelectorAll(
      ".video-toolbar-left, .video-toolbar-container .video-toolbar-left, .toolbar-left",
    ),
  );
  // Never fall back to document.body. Before Bilibili finishes rendering the
  // toolbar, a normal-flow button appended to body shifts the entire watch
  // page downward and leaves a large blank area above the video. The existing
  // MutationObserver will retry as soon as the real toolbar becomes visible.
  return candidates.find(isVisibleBililearnHost) || null;
}

function findShareButton(host) {
  const matched =
    host?.querySelector(
      ".video-share-wrap, .video-share, [class*='share-wrap'], [title*='分享']",
    ) || null;
  if (!matched) return null;

  // Bilibili's share icon contains several nested nodes. Dock beside the
  // complete toolbar item, never inside its icon/text implementation.
  let toolbarItem = matched;
  while (toolbarItem.parentElement && toolbarItem.parentElement !== host) {
    toolbarItem = toolbarItem.parentElement;
  }
  return toolbarItem.parentElement === host ? toolbarItem : matched;
}

function createBililearnButton() {
  const bililearnButton = document.createElement("button");
  bililearnButton.id = "ytd-bililearn-button";
  bililearnButton.type = "button";
  bililearnButton.setAttribute("aria-label", "打开 bililearn");
  bililearnButton.innerHTML = `
    <span class="ytd-bililearn-icon" style="font-size: 11px;">▶</span>
    <span class="ytd-bililearn-label">AI 总结</span>
  `;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among Bilibili's native action buttons.
  bililearnButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #fb7299;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    position: absolute;
    z-index: 9998;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    box-shadow: 0 4px 14px rgba(251, 114, 153, 0.3);
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  bililearnButton.addEventListener("mouseenter", () => {
    bililearnButton.style.background = "#ff5f8f";
    bililearnButton.style.transform = "scale(1.02)";
  });

  bililearnButton.addEventListener("mouseleave", () => {
    bililearnButton.style.background = "#fb7299";
    bililearnButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  bililearnButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[dk-bililearn] bililearn button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[dk-bililearn] openSidePanel response:", result);
    } catch (err) {
      console.error("[dk-bililearn] Failed to open side panel:", err);
    }
  });

  ytdBililearnButton = bililearnButton;
  return bililearnButton;
}

function positionBililearnButton(bililearnButton, shareButton) {
  if (!bililearnButton || !shareButton) return;
  const shareRect = shareButton.getBoundingClientRect();
  if (shareRect.width <= 0 || shareRect.height <= 0) return;

  bililearnButton.style.left = `${Math.round(window.scrollX + shareRect.right + 12)}px`;
  bililearnButton.style.top = `${Math.round(
    window.scrollY + shareRect.top + (shareRect.height - bililearnButton.offsetHeight) / 2,
  )}px`;
  bililearnButton.style.right = "auto";
}

/**
 * Reconciles the bililearn button with Bilibili's currently visible action row.
 * This is intentionally idempotent because Bilibili rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectBililearnButton() {
  // 学堂在线走自己的注入路径（页面结构完全不同）。
  if (isXuetangxPage()) {
    return injectXuetangxButton();
  }

  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-bililearn-button"),
  );

  if (!window.location.pathname.includes("/video/")) {
    existingButtons.forEach((button) => button.remove());
    ytdBililearnButton = null;
    return false;
  }

  const actionsContainer = findBililearnButtonHost();
  if (!actionsContainer) {
    debugLog("[dk-bililearn Content] Visible actions container not found yet");
    return false;
  }

  let bililearnButton = existingButtons.find(
    (button) => button === ytdBililearnButton,
  );

  if (!bililearnButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    bililearnButton = createBililearnButton();
  }

  existingButtons.forEach((button) => {
    if (button !== bililearnButton) button.remove();
  });

  // v1.1.7 allowed free dragging. Remove its saved viewport coordinate once.
  // Keep the button outside Bilibili's Vue-owned toolbar: inserting foreign
  // children there can corrupt its virtual DOM during responsive re-renders.
  // We strip both the new lowercase key and the old UPPERCASE_WITH_UNDERSCORES
  // key from v1.1.7 — anything still in localStorage from either era is dead
  // weight after this code stops honoring drag coordinates.
  //
  // 2026-10-16: this used to run on EVERY reconcile — that is, on every
  // observer batch. localStorage is disk-backed and synchronous, so a
  // mutation-driven hot path was paying sync disk I/O dozens of times a
  // second for a one-time migration. Now it runs exactly once.
  if (!legacyButtonPositionCleaned) {
    legacyButtonPositionCleaned = true;
    localStorage.removeItem(BILILEARN_BUTTON_POSITION_KEY);
    localStorage.removeItem("BILILEARN_BUTTON_POSITION_KEY");
  }

  const shareButton = findShareButton(actionsContainer);
  if (!shareButton) return false;
  if (bililearnButton.parentElement !== document.body) {
    document.body.appendChild(bililearnButton);
  }
  positionBililearnButton(bililearnButton, shareButton);

  debugLog("[dk-bililearn Content] bililearn button reconciled");
  return true;
}

function scheduleBililearnButtonReconciliation(delay = 80) {
  if (bililearnButtonReconcileTimer) {
    clearTimeout(bililearnButtonReconcileTimer);
  }

  bililearnButtonReconcileTimer = setTimeout(() => {
    bililearnButtonReconcileTimer = null;
    injectBililearnButton();
  }, delay);
}

function setupBililearnButtonResizeListener() {
  if (bililearnButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleBililearnButtonReconciliation(120);
    if (ytdNoteButton && ytdNotePlayerContainer) {
      positionNoteButton(
        ytdNoteButton,
        ytdNotePlayerContainer,
        document.fullscreenElement || document.webkitFullscreenElement || null,
      );
    }
  });
  bililearnButtonResizeListenerAdded = true;
}

/**
 * True when every mutation in this batch happened inside UI we injected
 * ourselves. Our own writes (creating the note button, appending the
 * bililearn button, reparenting into the fullscreen root) are childList
 * mutations on a page we observe with `subtree: true` — so without this
 * filter the observer reacts to its own output.
 */
function mutationsAreAllBililearnOwned(records) {
  const OWNED = "#ytd-note-button, #ytd-bililearn-button, #bililearn-toast";
  for (const record of records) {
    const target = record && record.target;
    if (!target || typeof target.closest !== "function") return false;
    if (!target.closest(OWNED)) return false;
  }
  return records.length > 0;
}

/**
 * Sets up a MutationObserver to watch for Bilibili's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 *
 * 2026-10-16: this observer is a main-thread hang risk, so it has two brakes:
 *
 *  1. It ignores batches produced entirely by our own injected nodes, which
 *     otherwise form a write -> observe -> write loop that never yields.
 *  2. It counts its own callbacks. A watch page mutates constantly (player,
 *     danmaku, comments), and if the injection path keeps writing, the callback
 *     rate climbs without bound. Past the budget the observer disconnects
 *     itself for a cooldown and reconnects after — the panel gets a stale
 *     button for a moment instead of the tab becoming unresponsive.
 */
function setupButtonObserver() {
  if (bililearnButtonObserver) return;

  bililearnButtonObserver = new MutationObserver((records) => {
    observerStats.calls++;
    const now = Date.now();
    observerStats.window.push(now);
    while (observerStats.window.length && now - observerStats.window[0] > 1000) {
      observerStats.window.shift();
    }

    if (observerStats.window.length > OBSERVER_MAX_CALLS_PER_SEC) {
      // Circuit breaker: stop observing rather than pin the renderer.
      observerStats.trips++;
      debugLog(
        `[dk-bililearn Content] observer circuit breaker tripped (${observerStats.window.length} callbacks/s) — pausing 2s`,
      );
      try {
        bililearnButtonObserver.disconnect();
      } catch {}
      observerStats.pausedUntil = now + OBSERVER_COOLDOWN_MS;
      setTimeout(() => {
        if (!bililearnButtonObserver) return;
        if (Date.now() < observerStats.pausedUntil) return;
        try {
          observeBody();
        } catch {}
      }, OBSERVER_COOLDOWN_MS + 50);
      return;
    }

    if (mutationsAreAllBililearnOwned(records)) return;

    // Check if we need to inject the buttons
    if (isXuetangxPage()) {
      scheduleBililearnButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
      return;
    }
    if (window.location.pathname.includes("/video/")) {
      scheduleBililearnButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  observeBody();
}

/** (Re)attach the observer to <body>. */
function observeBody() {
  // Watch the entire body for changes (Bilibili rebuilds large chunks of the DOM)
  bililearnButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the Bilibili video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  const isXuetangx = isXuetangxPage();
  if (!isXuetangx && !window.location.pathname.includes("/video/")) return;

  // Always use the live Bilibili player containing the active video. In native
  // fullscreen this element is inside document.fullscreenElement, so overlays
  // appended here remain visible above the video.
  const fullscreenRoot = document.fullscreenElement || document.webkitFullscreenElement;
  const scope = fullscreenRoot || document;
  // 学堂在线的播放器是 <video class="xt_video_player">，外面没有 B 站那种
  // 容器 class，所以单独找它的包装元素（笔记按钮按容器矩形定位）。
  const playerCandidates = isXuetangx
    ? [findXuetangxPlayerContainer()].filter(Boolean)
    : Array.from(
        scope.querySelectorAll?.(
          ".bpx-player-container, .bilibili-player, #bilibili-player",
        ) || [],
      );
  if (
    !isXuetangx &&
    scope.matches?.(".bpx-player-container, .bilibili-player, #bilibili-player")
  ) {
    playerCandidates.unshift(scope);
  }
  const playerContainer =
    playerCandidates.find((candidate) => candidate.querySelector("video")) || null;

  if (!playerContainer) {
    debugLog(
      "[dk-bililearn Content] Player container not found yet, will retry",
    );
    return;
  }

  const fullscreenElement =
    document.fullscreenElement || document.webkitFullscreenElement || null;
  const noteHost = fullscreenElement || document.body;

  // Keep the existing live button when possible, but move it between the
  // body-owned overlay layer and native fullscreen root when required.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton && ytdNoteButton === existingButton && existingButton.isConnected) {
    if (existingButton.parentElement !== noteHost) {
      noteHost.appendChild(existingButton);
    }
    ytdNotePlayerContainer = playerContainer;
    positionNoteButton(existingButton, playerContainer, fullscreenElement);
    return;
  }
  if (existingButton) existingButton.remove();

  debugLog("[dk-bililearn Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>记笔记</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #fb7299;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;
  ytdNotePlayerContainer = playerContainer;

  // 2026-10-16: bind the hover listeners ONCE per player container.
  //
  // Bilibili's Vue re-renders regularly detach our floating button (it lives
  // on document.body, not inside the player's virtual DOM), which sends us
  // back through this creation path — including via the 120ms retry below and
  // via the MutationObserver, which calls tryInjectNoteButton on every
  // mutation batch while the button is missing. Before this guard every one of
  // those passes added three MORE listeners to the same long-lived
  // .bpx-player-container, with no upper bound: after N rebuilds every mousemove
  // over the player ran N resetNoteButtonTimer() calls, and the renderer
  // stopped responding ("1 个页面无响应") exactly while the video was playing.
  if (playerContainer.dataset.bililearnNoteBound !== "1") {
    playerContainer.dataset.bililearnNoteBound = "1";

    // Show button when mouse enters or moves over the player.
    // Hide after 2 seconds of idle or when the mouse leaves.
    playerContainer.addEventListener("mouseenter", () => {
      showNoteButton();
      resetNoteButtonTimer();
    });

    playerContainer.addEventListener("mousemove", () => {
      showNoteButton();
      resetNoteButtonTimer();
    });

    playerContainer.addEventListener("mouseleave", () => {
      clearTimeout(ytdNoteButtonTimer);
      ytdNoteButtonTimer = null;
      hideNoteButton();
    });
  }

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#ff5f8f";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#fb7299";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  noteHost.appendChild(noteButton);
  positionNoteButton(noteButton, playerContainer, fullscreenElement);

  debugLog("[dk-bililearn Content] Note button injected");
}

function positionNoteButton(noteButton, playerContainer, fullscreenElement) {
  if (!noteButton || !playerContainer) return;

  if (fullscreenElement) {
    noteButton.style.top = "16px";
    noteButton.style.right = "16px";
    noteButton.style.left = "auto";
    return;
  }

  const rect = playerContainer.getBoundingClientRect();
  noteButton.style.top = `${Math.round(window.scrollY + rect.top + 16)}px`;
  noteButton.style.left = `${Math.round(
    window.scrollX + rect.right - noteButton.offsetWidth - 16,
  )}px`;
  noteButton.style.right = "auto";
}

function handleNoteFullscreenChange() {
  // Bilibili may replace or reparent the player when entering/exiting native
  // fullscreen. Re-resolve the active container after that DOM update settles.
  setTimeout(() => {
    if (ytdNoteButton && !ytdNoteButton.isConnected) ytdNoteButton = null;
    injectNoteButton();
    showNoteButton();
    resetNoteButtonTimer();
  }, 120);
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on Bilibili watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!window.location.pathname.includes("/video/")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent Bilibili's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[dk-bililearn] Saving note");

  const video = document.querySelector("video");
  if (!video) {
    console.error("[dk-bililearn] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const bvidMatch = window.location.pathname.match(/\/video\/(BV[A-Za-z0-9]{10})/i);
  const videoId = bvidMatch
    ? `${bvidMatch[1]}@p${getActiveBilibiliPart()}`
    : null;
  if (!videoId) {
    console.error("[dk-bililearn] Could not identify the current BV video");
    return;
  }

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[dk-bililearn] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[dk-bililearn] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#fb7299";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #fb7299;">📝 笔记已保存</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(note.timestampedUrl)}" style="color: #fb7299; font-weight: 600; text-decoration: none;">🔗 复制链接</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #e3e5e7;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(24, 25, 28, 0.16);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(note.timestampedUrl);
      e.target.textContent = "✓ Copied!";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from Bilibili's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // 2026-09-27: dispatch by host — B站 vs YouTube have wildly different
  // DOM structures and "title / channel / pubdate" come from entirely
  // different nodes on each.
  if (
    window.location.hostname === "www.youtube.com" ||
    window.location.hostname === "m.youtube.com" ||
    window.location.hostname.endsWith(".youtube.com")
  ) {
    return extractYouTubeVideoInfo();
  }
  // 2026-10-26: 学堂在线 (xuetangx.com) —— 第三方课程平台。
  if (isXuetangxPage()) {
    return extractXuetangxVideoInfo();
  }
  // B站 (default branch — unchanged from the previous behaviour).
  // The video title is in an h1 element inside the #title container
  const activePartTitle = document.querySelector(
    ".video-pod__item.active .title, .video-pod__item.active .video-pod__title, .video-episode-card__info-playing .video-episode-card__info-title",
  );
  const titleElement =
    activePartTitle || document.querySelector("h1.video-title, h1[title], .video-title");

  // The channel name is in the channel info section
  const channelElement = document.querySelector(".up-name, .up-name-container a, .username");

  // Video duration from the video element
  const videoElement = document.querySelector("video");

  // Video description — Bilibili has this in a few possible places
  const descriptionElement = document.querySelector(".desc-info-text, .video-desc-container, .desc-info");

  return {
    title: titleElement?.textContent?.trim() || "",
    channelName: channelElement?.textContent?.trim() || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
    pubdate: extractVideoPubDate(),
  };
}

function extractYouTubeVideoInfo() {
  // 2026-10-04 fix: the DOM-scrape path is unreliable. YouTube ships watch
  // pages as a skeleton (SSR HTML has zero `<h1>` / `<yt-formatted-string>`
  // nodes — only empty `<div id="title" class="text-shell skeleton-bg-color">`
  // placeholders), then hydrates everything client-side. Once hydrated, the
  // page contains the same `<yt-formatted-string>` custom element under
  // many siblings: the main video title, "Up next" cards, the description
  // expander, and the comments / chapters / "In this video" section
  // headers. The old selector list — `#title yt-formatted-string,
  // h1.title yt-formatted-string` — was a substring match against an
  // ambiguous id and a generic class, so depending on hydration order it
  // would latch onto "Comments" / "Up next" / "In this video" instead of
  // the real title.
  //
  // The authoritative source is the JSON blob YouTube inlines in the page
  // head as `var ytInitialPlayerResponse = { ..., videoDetails: { title,
  // author, lengthSeconds, shortDescription, ... } };`. That JSON is
  // always present in the SSR HTML (it is what the player itself reads),
  // and `videoDetails.title` is unique per video id. We prefer it; the
  // DOM is only a fallback for the rare SPA build where the script is
  // split or minified across tags we don't catch.
  const playerResponse = extractYouTubePlayerResponse();
  const details = playerResponse?.videoDetails || {};
  let title = (details.title || "").toString().trim();
  let channelName = (details.author || "").toString().trim();
  // lengthSeconds comes back as a numeric string ("213") — normalise to a
  // positive integer; 0 means "unknown" so downstream code can detect it.
  const playerDuration =
    details.lengthSeconds && Number.isFinite(+details.lengthSeconds)
      ? Math.max(0, Math.floor(+details.lengthSeconds))
      : 0;
  let description = (details.shortDescription || "").toString();
  // Publish date: SSR ships `<meta itemprop="datePublished" content="...">`
  // as ISO 8601. Prefer it; otherwise fall back to the player response's
  // microformat.publishDate (also ISO 8601). Normalise to YYYY-MM-DD.
  const pubdateMeta =
    document.querySelector('meta[itemprop="datePublished"]') ||
    document.querySelector('meta[itemprop="uploadDate"]');
  const microPublish =
    playerResponse?.microformat?.playerMicroformatRenderer?.publishDate ||
    playerResponse?.microformat?.playerMicroformatRenderer?.uploadDate ||
    "";
  const pubdateRaw = pubdateMeta?.getAttribute("content") || microPublish || "";
  const pubdate = pubdateRaw ? pubdateRaw.slice(0, 10) : "";

  // DOM fallback — only consulted when the player JSON didn't yield a
  // title. Selectors are tightened to the main metadata block AND the
  // raw textContent check rejects anything that looks like a section
  // header (Comments, Up next, In this video, Recommended, etc.).
  if (!title) {
    const SECTION_HEADER_RE =
      /^(comments?|description|up next|recommended|in this video|chapters?|people also (watched|viewed)|related|playlist|transcript|description ·|live chat|chat replay)$/i;
    // The main title lives inside `#title` (id, not class — id="title" is
    // unique to the primary info block on watch pages) and the yt-formatted-
    // string inside it has the actual title text. Avoid `h1.title yt-
    // formatted-string` because class="title" appears on multiple H1s.
    const domTitle =
      document.querySelector("#title h1 yt-formatted-string") ||
      document.querySelector("#title > h1 > yt-formatted-string") ||
      document.querySelector(
        "ytd-watch-metadata h1 yt-formatted-string",
      );
    const domTitleText = (domTitle?.textContent || "").trim();
    if (domTitleText && !SECTION_HEADER_RE.test(domTitleText)) {
      title = domTitleText;
    }
  }
  if (!channelName) {
    // `ytd-channel-name` is the owner block; inside it, the first
    // `yt-formatted-string` is the channel display name. The plain
    // `<a>` href carries the channel slug (/@handle) which is more
    // reliable than visible text when localisation splits the name.
    const channelAnchor =
      document.querySelector("ytd-channel-name a") ||
      document.querySelector("ytd-video-owner-renderer a") ||
      document.querySelector("#owner-name a");
    channelName =
      (channelAnchor?.textContent || "").trim() ||
      (channelAnchor?.getAttribute("href") || "")
        .replace(/^\//, "")
        .replace(/^@/, "")
        .split("/")
        .filter(Boolean)
        .join(" ") ||
      "";
  }
  if (!description) {
    const descriptionElement = document.querySelector(
      "ytd-text-inline-expander#description-inline-expander, " +
        'meta[name="description"], ' +
        'meta[property="og:description"]',
    );
    if (descriptionElement?.tagName === "META") {
      description = descriptionElement.getAttribute("content") || "";
    } else if (descriptionElement) {
      description = descriptionElement.textContent?.trim() || "";
    }
  }
  // Duration fallback: `<video>` is the actual <video> element rendered
  // in the player; its `duration` is NaN until metadata loads, which is
  // why we always coerce.
  const videoElement = document.querySelector("video");
  const domDuration =
    videoElement && Number.isFinite(videoElement.duration)
      ? Math.max(0, Math.floor(videoElement.duration))
      : 0;
  const duration = playerDuration || domDuration;

  return {
    title,
    channelName,
    duration,
    description,
    pubdate,
  };
}

// Extracts the `ytInitialPlayerResponse` JSON blob YouTube inlines in
// the watch page head. This is the same blob the YouTube player itself
// reads on first paint, so it is present in the SSR HTML (i.e. before
// any SPA hydration) and `videoDetails` is always keyed to the URL's
// video id. Returns the parsed object, or null when the page didn't
// expose one (rare — old / broken SPA builds).
//
// 2026-10-04: extracted from extractYouTubeTranscriptFromPageState so
// both the transcript path and the title/channel/description path can
// use the same canonical source. Avoids the drift where subtitles
// "know" the correct video metadata while the title fallback still
// scrapes the (post-hydration, unstable) DOM.
function extractYouTubePlayerResponse() {
  const scripts = Array.from(document.querySelectorAll("script"));
  for (const s of scripts) {
    const text = s.textContent || "";
    const idx = text.indexOf("ytInitialPlayerResponse");
    if (idx === -1) continue;
    // Walk forward to the opening brace of the JSON object.
    const eqIdx = text.indexOf("{", idx);
    if (eqIdx === -1) continue;
    // Brace-match to find the matching closing brace (the JSON object
    // is large and may contain nested objects/strings with braces).
    let depth = 0;
    let inString = false;
    let escape = false;
    let i = eqIdx;
    while (i < text.length) {
      const ch = text[i];
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      i++;
    }
    const blob = text.substring(eqIdx, i);
    try {
      return JSON.parse(blob);
    } catch {
      // JSON.parse failed — try the next script tag. This is normal
      // when there's a minified wrapper that splits the JSON across
      // multiple script elements.
    }
  }
  return null;
}

// 2026-09-29: DOM-based YouTube transcript extraction. Avoids the
// yt-dlp + proxy + cookies stack entirely for the common case where
// the user already opened the video in their browser — the transcript
// is rendered into the page the moment they click "Show transcript"
// under the description. yt-dlp through a proxy IP gets blocked by
// YouTube's TLS-fingerprint bot wall ("Sign in to confirm you're not
// a bot") even with valid auth cookies; reading the DOM uses the
// browser's already-trusted TLS identity, so it always works when
// the user can see captions in their browser.
//
// 2026-09-29 (Irene direction): B站 subtitles come from
// `api.bilibili.com/x/player/wbi/v2` (a clean public JSON API the
// browser calls directly — no server, no proxy, no auth dance).
// YouTube has the same shape: every watch page embeds a giant
// `ytInitialPlayerResponse = { ... }` blob in a <script> tag, and
// `captions.playerCaptionsTracklistRenderer.captionTracks[i].baseUrl`
// is the URL of the caption file for the i-th language. The browser
// can fetch that URL directly — same as B站 — and parse the response
// (`fmt=srv3` is the cleanest XML, `fmt=json3` is JSON). This is
// identical in spirit to fetchBilibiliOfficialSubtitle's pattern:
// public API → JSON / structured response → segments. No yt-dlp, no
// proxy cookies, no DPAPI, no TLS-fingerprint concern.
//
// extractYouTubeTranscriptFromPageState() below implements this path.
// It runs FIRST (before extractYouTubeTranscriptFromDOM); if the page
// state doesn't expose caption tracks (rare; e.g. very new SPA
// builds), we fall back to opening the on-page transcript panel.
//
// Returns:
//   { success: true, transcript: [{start, duration, text}], language, source }
//   { success: false, reason: "no-page-state" | "no-tracks" |
//                            "fetch-failed" | "parse-failed" |
//                            "no-button" | "empty" | "no-segments" }
async function extractYouTubeTranscriptFromPageState() {
  // 1. Locate `ytInitialPlayerResponse` in any <script> tag on the page.
  //    YouTube ships it inline as `var ytInitialPlayerResponse = {...};`
  //    early in the head. We share the JSON extraction with the title /
  //    channel / description path via extractYouTubePlayerResponse() so
  //    the two readers can't drift apart on parsing.
  const playerResponse = extractYouTubePlayerResponse();
  if (!playerResponse) {
    return { success: false, reason: "no-page-state" };
  }

  // 2. Find the caption track list. B站 returns a list of subtitle
  //    entries at `data.subtitle.subtitles`; YouTube is similar —
  //    `captions.playerCaptionsTracklistRenderer.captionTracks`.
  //    Each entry has `baseUrl`, `languageCode`, and `kind` (the
  //    empty string = uploader manual, "asr" = YouTube's auto
  //    speech recognition). We prefer manual over auto (more
  //    accurate), and prefer the user's language chain over English.
  const tracks =
    playerResponse.captions?.playerCaptionsTracklistRenderer
      ?.captionTracks || [];
  if (!tracks.length) {
    return { success: false, reason: "no-tracks" };
  }

  const langChain = ["zh-Hans", "zh-CN", "zh", "zh-Hant", "en"];
  let chosen = null;
  // Pass 1 — exact languageCode, manual (kind != asr).
  for (const lang of langChain) {
    chosen = tracks.find(
      (t) => t.languageCode === lang && t.kind !== "asr",
    );
    if (chosen) break;
  }
  // Pass 2 — exact languageCode, any kind (manual > asr).
  if (!chosen) {
    for (const lang of langChain) {
      chosen = tracks.find((t) => t.languageCode === lang);
      if (chosen) break;
    }
  }
  // Pass 3 — long-tail: take any manual track the video has, then
  // any track at all (so videos with only Korean captions still
  // get a transcript instead of falling through to Whisper).
  if (!chosen) chosen = tracks.find((t) => t.kind !== "asr") || tracks[0];

  // 3. Fetch the caption file. YouTube supports a few formats via
  //    the `fmt` query parameter; srv3 is XML with per-cue timing,
  //    json3 is JSON with the same data. We try json3 first (cleaner
  //    to parse) and fall back to srv3 if YouTube returns an
  //    unrecognised body. `kind` is preserved so the sidepanel can
  //    label the transcript manual vs auto.
  const baseUrl = chosen.baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  let jsonBody = null;
  let xmlBody = null;
  try {
    const j = await fetch(`${baseUrl}${sep}fmt=json3`, {
      credentials: "include",
    });
    if (j.ok) {
      jsonBody = await j.text();
    }
  } catch {
    // Network / CORS — ignore and try srv3.
  }
  if (!jsonBody) {
    try {
      const x = await fetch(`${baseUrl}${sep}fmt=srv3`, {
        credentials: "include",
      });
      if (x.ok) xmlBody = await x.text();
    } catch {
      /* empty */
    }
  }
  if (!jsonBody && !xmlBody) {
    return { success: false, reason: "fetch-failed" };
  }

  // 4. Parse whichever format we got. json3 → events[].segs[].utf8;
  //    srv3 → timedtext/p[@t][@d]. Returns the canonical envelope.
  const segments = jsonBody
    ? parseYTJson3(jsonBody)
    : parseYTSrv3(xmlBody);

  if (!segments.length) {
    return { success: false, reason: "parse-failed" };
  }

  return {
    success: true,
    // 2026-09-29 (Irene regression): the sidepanel consumes
    // `transcriptResult.transcript` (line 1151 of sidepanel.js) and
    // bails in renderTranscript() when that field is undefined — my
    // earlier code returned `segments` and the transcript panel
    // rendered as an empty shell with the action buttons but no
    // body. Match fetchBilibiliOfficialSubtitle's envelope so the
    // existing sidepanel render code works without modification.
    transcript: segments,
    transcriptText: segments.map((s) => s.text).join(" ").trim(),
    transcriptTextTimestamped: segments
      .map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${String(sec).padStart(2, "0")}] ${s.text}`;
      })
      .join("\n"),
    language: chosen.languageCode || null,
    source: chosen.kind === "asr" ? "youtube-auto-subtitle" : "youtube-subtitle",
  };
}

// json3 caption response parser (YouTube's structured format).
// Shape: { wireMagic: "pb3", events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
// `segs` may be missing for blank cues (silence). Multi-segment cues
// (rare, language overlays) are joined with no space — matches the
// behaviour yt-dlp / official YouTube transcript displays.
function parseYTJson3(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  const out = [];
  for (const ev of events) {
    const start = Math.max(0, Math.floor(Number(ev.tStartMs) || 0) / 1000);
    const dur = Math.max(
      0,
      Math.floor(Number(ev.dDurationMs) || 0) / 1000,
    );
    const segs = Array.isArray(ev.segs) ? ev.segs : [];
    const parts = segs
      .map((s) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
      .filter((s) => s.length > 0);
    // Strip newline markers (YouTube uses "\n" inside json3 to mark
    // line breaks within a single cue). Joining with "" preserves the
    // soft-break intent for downstream layout, matching yt-dlp's
    // default caption rendering.
    const joined = parts.join("").replace(/\\r\\n|\\n/g, " ").trim();
    if (!joined) continue;
    out.push({ start, duration: dur, text: joined });
  }
  return out;
}

// srv3 caption response parser (XML fallback when json3 isn't served).
// Shape: <timedtext><p t="0.000" d="2.500">Hello</p>...</timedtext>
// YouTube's t/d are floats in seconds; some older responses omit d
// (duration) — in that case we approximate from the next cue's t.
function parseYTSrv3(text) {
  if (!text) return [];
  const cues = [];
  const cueRe =
    /<p\s+t="([0-9.]+)"(?:\s+d="([0-9.]+)")?\s*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = cueRe.exec(text)) !== null) {
    const start = Number(m[1]) || 0;
    const explicitDur = m[2] != null ? Number(m[2]) : null;
    const inner = m[3]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (!inner) continue;
    cues.push({ start, dur: explicitDur, text: inner });
  }
  if (!cues.length) return [];
  // Fill in missing durations from the next cue's start.
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    let dur = c.dur;
    if (dur == null || !Number.isFinite(dur)) {
      const next = cues[i + 1];
      dur = next ? Math.max(0, next.start - c.start) : 0;
    }
    out.push({ start: c.start, duration: dur, text: c.text });
  }
  return out;
}

//   { success: true, transcript: [{start, duration, text}], language, source }
//   { success: false, reason: "no-button" | "empty" | "no-segments" }
async function extractYouTubeTranscriptFromDOM() {
  // 1. If the transcript panel is already open, skip the click.
  //    Otherwise find the button. YouTube has localised the label to
  //    dozens of languages; we pattern-match a few of the common ones
  //    ("Show transcript", "转写稿", "転写", etc.) plus the generic
  //    aria-label fallback. Failing the button lookup is a normal
  //    "video has no transcript" outcome, not an error.
  let panel = document.querySelector(
    "ytd-transcript-renderer, ytd-transcript-segment-list-renderer",
  );
  if (!panel) {
    const btn = findYouTubeTranscriptButton();
    if (!btn) {
      return { success: false, reason: "no-button" };
    }
    btn.click();
    panel = await waitForTranscriptPanel(3000);
    if (!panel) return { success: false, reason: "panel-timeout" };
  }

  // 2. Walk the segment list. YouTube uses custom elements
  //    (`ytd-transcript-segment-renderer`) with two child nodes we
  //    care about: a `.segment-timestamp` div (e.g. "1:23") and a
  //    `.segment-text` element. textContent works through the shadow
  //    boundary because YouTube flattens the children into the parent.
  const items = panel.querySelectorAll(
    "ytd-transcript-segment-renderer, yt-transcript-segment-renderer",
  );
  if (!items.length) {
    return { success: false, reason: "no-segments" };
  }

  const segments = [];
  for (const item of items) {
    const tsText = item.querySelector(".segment-timestamp")?.textContent?.trim() || "";
    const text = item.querySelector(".segment-text")?.textContent?.trim() || "";
    const start = parseYTTranscriptTimestamp(tsText);
    if (start === null || !text) continue;
    segments.push({ start, duration: 0, text });
  }
  if (!segments.length) {
    return { success: false, reason: "empty" };
  }

  // 3. Compute per-segment duration from consecutive starts. The
  //    last segment uses the video duration as the upper bound so the
  //    final cue doesn't appear to run forever.
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].duration = Math.max(
      0,
      segments[i + 1].start - segments[i].start,
    );
  }
  const video = document.querySelector("video");
  const lastStart = segments[segments.length - 1].start;
  if (video && Number.isFinite(video.duration) && video.duration > lastStart) {
    segments[segments.length - 1].duration = video.duration - lastStart;
  }

  // 4. Build the same envelope the whisper_server subtitle endpoint
  //    returns, so the rest of the pipeline (cache write, AI
  //    correction, sidepanel render) doesn't care which path produced
  //    it. `language` is unknown — YouTube labels the panel with the
  //    chosen language only after the user picks one from the
  //    settings menu; we leave it null and let the sidepanel decide.
  return {
    success: true,
    // 2026-09-29 (Irene regression): the sidepanel consumes
    // `transcriptResult.transcript` (line 1151 of sidepanel.js) and
    // bails in renderTranscript() when that field is undefined — my
    // earlier code returned `segments` and the transcript panel
    // rendered as an empty shell with the action buttons but no
    // body. Match fetchBilibiliOfficialSubtitle's envelope so the
    // existing sidepanel render code works without modification.
    transcript: segments,
    transcriptText: segments.map((s) => s.text).join(" ").trim(),
    transcriptTextTimestamped: segments
      .map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${String(sec).padStart(2, "0")}] ${s.text}`;
      })
      .join("\n"),
    language: null,
    source: "youtube-dom-transcript",
  };
}

// 2026-09-29: DOM-based YouTube transcript extraction. Avoids the
// yt-dlp + proxy + cookies stack entirely for the common case where
// the user already opened the video in their browser — the transcript
// is rendered into the page the moment they click "Show transcript"
// under the description. yt-dlp through a proxy IP gets blocked by
// YouTube's TLS-fingerprint bot wall ("Sign in to confirm you're not
// a bot") even with valid auth cookies; reading the DOM uses the
// browser's already-trusted TLS identity, so it always works when
// the user can see captions in their browser.

// Find the "Show transcript" trigger. YouTube sometimes renders it as
// a `<button>`, sometimes as a `[role="button"]` inside a menu, and
// the label is localised. We try the most reliable selectors first
// (aria-label, class hooks) and only fall back to text-content
// matching for the localised copies we know about.
function findYouTubeTranscriptButton() {
  // 1. aria-label / title hints
  const ariaSel = [
    'button[aria-label*="transcript" i]',
    'button[title*="transcript" i]',
    'yt-button-shape button[aria-label*="transcript" i]',
  ].join(", ");
  const ariaHit = document.querySelector(ariaSel);
  if (ariaHit) return ariaHit.closest("button") || ariaHit;

  // 2. Anchor / button with a known localised label. "Show transcript"
  //    is the en-US label; YouTube ships 80+ translations, but the
  //    most common ones in the wild are below. The substring match
  //    is intentionally permissive to absorb small UI variations.
  const labels = [
    "show transcript",
    "转写稿",
    "转录文本",
    "转录稿",
    "転写を表示",
    "show transcription",
    "show captions",
    "transcript",
  ];
  const candidates = document.querySelectorAll(
    'button, [role="button"], a[href*="transcript"]',
  );
  for (const el of candidates) {
    const txt = (el.textContent || "").trim().toLowerCase();
    if (!txt || txt.length > 40) continue;
    if (labels.some((l) => txt.includes(l))) return el;
  }
  return null;
}

// Poll for the transcript panel after clicking the trigger. YouTube
// re-renders the panel asynchronously (single-tick SPA swap), so a
// fixed delay isn't enough — we poll until the segment list appears
// or the budget runs out.
async function waitForTranscriptPanel(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sel = "ytd-transcript-renderer, ytd-transcript-segment-list-renderer";
  while (Date.now() < deadline) {
    const panel = document.querySelector(sel);
    if (panel && panel.querySelectorAll("ytd-transcript-segment-renderer, yt-transcript-segment-renderer").length > 0) {
      return panel;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Final check — panel might be open but empty (video with no transcript).
  return document.querySelector(sel);
}

// "0:00" / "1:23" / "1:23:45" → seconds. Returns null on bad input.
function parseYTTranscriptTimestamp(raw) {
  if (!raw) return null;
  const parts = raw.split(":").map((s) => parseInt(s, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Best-effort extraction of the video publish date (YYYY-MM-DD) so that
 * the export filename can include it. B站 surfaces the date in a few
 * different shapes depending on which template is rendering the page:
 *
 *   1. <meta itemprop="datePublished" content="2026-05-01T12:34:56">
 *   2. <meta itemprop="uploadDate"   content="2026-05-01T12:34:56">
 *   3. <span class="pubdate" date="2026-05-01 12:34">...</span>
 *   4. <meta name="pubdate" content="2026-05-01">
 *   5. <script>window.__INITIAL_STATE__ = { ... pubdate: 1714521600 ... }</script>
 *
 * The first source that yields a valid date wins. Returns "" when the
 * page is not a B站 video page (so the caller can fall back to "today").
 */
function extractVideoPubDate() {
  const metaSelectors = [
    'meta[itemprop="datePublished"]',
    'meta[itemprop="uploadDate"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[property="article:published_time"]',
  ];
  for (const selector of metaSelectors) {
    const raw = document.querySelector(selector)?.getAttribute("content");
    const normalized = normalizePubDateString(raw);
    if (normalized) return normalized;
  }

  // DOM text like "2026年05月01日" or "2026-05-01 12:34" — usually
  // rendered near the title or in the meta info strip.
  const textSelectors = [
    ".pubdate",
    ".video-pubdate",
    ".video-info .date",
    ".video-data .date",
  ];
  for (const selector of textSelectors) {
    const raw = document.querySelector(selector)?.textContent?.trim();
    const normalized = normalizePubDateString(raw);
    if (normalized) return normalized;
  }

  // Last resort: scrape window.__INITIAL_STATE__ which is embedded as
  // JSON in the page's initial HTML and contains the canonical pubdate
  // for SPA-rendered pages. We only look one level deep to keep this
  // cheap — a full deep search would be slow on long JSON blobs.
  try {
    const initialState = window.__INITIAL_STATE__;
    if (initialState && typeof initialState === "object") {
      const candidates = [
        initialState?.videoData?.pubdate,
        initialState?.videoData?.created,
        initialState?.videoData?.ctime,
        initialState?.aidVideoData?.pubdate,
        initialState?.aidVideoData?.created,
        initialState?.aidVideoData?.ctime,
      ];
      for (const c of candidates) {
        const normalized = normalizePubDateString(c);
        if (normalized) return normalized;
      }
    }
  } catch (_error) {
    // Ignore — __INITIAL_STATE__ is best-effort and not present on all pages.
  }

  return "";
}

function normalizePubDateString(input) {
  if (input === null || input === undefined) return "";
  // Numeric timestamps from B站's API are seconds since epoch.
  if (typeof input === "number") {
    const ms = input > 1e12 ? input : input * 1000;
    return formatYmd(new Date(ms));
  }
  const raw = String(input).trim();
  if (!raw) return "";
  // Try parsing as a date. The Date constructor accepts ISO 8601, the
  // Chinese "2026年05月01日" form (Chrome handles it), and several
  // other human formats. Bail out on invalid dates.
  const parsed = new Date(raw.replace(/\s/g, "T").replace(/(年|月)/g, "-").replace(/日/g, ""));
  if (isNaN(parsed.getTime())) return "";
  return formatYmd(parsed);
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to Bilibili's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - Bilibili's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the Bilibili video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video");
  if (!video) {
    console.error("[dk-bililearn Content] No video element found for seek");
    return;
  }

  debugLog("[dk-bililearn Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * Bilibili is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — Bilibili
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which Bilibili fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
function handleBilibiliNavigation() {
  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-bililearn-button")
    .forEach((button) => button.remove());
  ytdBililearnButton = null;
  if (bililearnButtonReconcileTimer) {
    clearTimeout(bililearnButtonReconcileTimer);
    bililearnButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  ytdNotePlayerContainer = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for Bilibili to render)
  setTimeout(() => {
    scheduleBililearnButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
}

function getActiveBilibiliPart() {
  const urlPart = Math.max(1, Number(new URL(window.location.href).searchParams.get("p")) || 1);
  const items = Array.from(
    document.querySelectorAll(".video-pod__item, .video-episode-card__info"),
  );
  const activeIndex = items.findIndex((item) =>
    item.matches(".active, .video-episode-card__info-playing") ||
    item.querySelector(".playing, .active"),
  );
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
  const activeHref =
    activeItem?.matches?.("a[href]")
      ? activeItem.getAttribute("href")
      : activeItem?.querySelector?.("a[href]")?.getAttribute("href");
  if (activeHref) {
    try {
      const hrefPart = Number(new URL(activeHref, window.location.href).searchParams.get("p"));
      if (hrefPart > 0) return hrefPart;
    } catch {}
  }
  return activeIndex >= 0 ? activeIndex + 1 : urlPart;
}

function getBilibiliNavigationUrl() {
  // Collections can switch to another BV item before the address bar settles.
  // Use the active card's real link when available instead of combining the
  // previous BV with the new card index.
  const activeItem = document.querySelector(
    ".video-pod__item.active, .video-episode-card__info-playing",
  );
  const activeAnchor = activeItem?.matches?.("a[href]")
    ? activeItem
    : activeItem?.querySelector?.("a[href*='/video/BV']");
  const activeHref = activeAnchor?.getAttribute?.("href");
  let url = new URL(window.location.href);
  if (activeHref) {
    try {
      const candidate = new URL(activeHref, window.location.href);
      if (/\/video\/BV[A-Za-z0-9]{10}/i.test(candidate.pathname)) url = candidate;
    } catch {}
  }
  const part = getActiveBilibiliPart();
  if (part > 1) url.searchParams.set("p", String(part));
  else url.searchParams.delete("p");
  return url.toString();
}

let lastBilibiliUrl = getBilibiliNavigationUrl();
setInterval(() => {
  const nextUrl = getBilibiliNavigationUrl();
  if (nextUrl !== lastBilibiliUrl) {
    lastBilibiliUrl = nextUrl;
    handleBilibiliNavigation();
    chrome.runtime
      .sendMessage({ action: "bilibiliNavigation", url: nextUrl })
      .catch(() => {});
  }
}, 800);
