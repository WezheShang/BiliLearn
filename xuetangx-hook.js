/**
 * XUETANGX PAGE HOOK (学堂在线)
 *
 * Runs in the PAGE's MAIN world (manifest: content_scripts[].world = "MAIN",
 * run_at = "document_start") so it can see and patch the site's own
 * window.fetch / XMLHttpRequest BEFORE the Vue app issues its first request.
 *
 * WHY A HOOK INSTEAD OF CALLING THE API FROM THE EXTENSION
 * -------------------------------------------------------
 * 学堂在线的 learning API 全部要求登录态：
 *   GET  /api/v1/lms/learn/menu/?cid=&sign=        → {"detail":"身份认证信息未提供。"}
 *   GET  /api/v1/lms/learn/course/chapter?cid=&sign= → {"msg":"user is not login"}
 * 从扩展的 service worker 直接 fetch 会被拒（403 / 身份认证未提供）。
 * 但页面自己发出的请求是带登录 cookie 的 —— 所以最稳的办法是"搭便车"：
 * 页面请求什么，我们就把响应记下来。
 *
 * 关注的接口（全部来自学堂在线自己的前端 bundle src_views_courseAction_learnSpace_newItem_vue.js）：
 *   GET  /api/v1/lms/learn/leaf_info/{cid}/{leafId}/?sign=   → 小节详情（标题 + ccid）
 *   GET  /api/v1/lms/service/s_t_c/{leafId}/                → 该小节有没有字幕 + 默认语言
 *   POST /api/v1/lms/service/s_t_g_p/  body {c_d: ccid}     → 字幕文件 URL 列表
 *   GET  /api/v1/lms/service/playurl/{ccid}/?appid=10000    → 视频直链
 *   GET  /api/v1/lms/learn/menu/?cid=&sign=                → 课程目录（小节名 + id）
 *
 * 2026-10-27 补记 —— 讲稿与章节（真正管用的两个接口）
 * -------------------------------------------------------
 * s_t_g_p 那条字幕线反复试都不通（线上回 data:{}），最后在真机上直接翻出
 * 两个更靠谱的接口（都在 /c27/ 下，GET、不需要 CSRF、页面同源）：
 *
 *   GET /c27/online_courseware/leaf_lecture_note/{leafId}/
 *     → 逐段官方文字稿，每段带 startTime/endTime（**毫秒**）
 *   GET /c27/online_courseware/leaf_knowledge/{leafId}/
 *     → 官方 AI 章节摘要：headline + summary + 时间区间（毫秒）
 *
 * 讲稿直接当"官方字幕"交给后台（后台认 {subtitle_list:[…]} 那套结构），
 * 章节摘要当"章节时间线"（侧边栏用 AI 生成概览的那套格式渲染它，
 * 概览因此不用跑 AI）。
 *
 * 2026-10-27 补记 —— 知识图谱那条链已经不拉了
 * ------------------------------------------------
 * 原来还会拉 graph/convert → kg_basic_info → knowledge_graph/{id}/nodes/，
 * 那条链返回的是一棵 300KB+ 的**知识点树**（"Section 1 …"那种内容清单）。
 * 用户明确说概览里不需要这个 content 列表 —— 现在只留官方章节摘要。
 *
 * 2026-10-27 补记 —— 字幕探针矩阵（probeSubtitleMatrix）
 * -------------------------------------------------------
 * 线上 s_t_g_p({c_d: ccid}) 回的是 {"msg":"","success":true,"data":{}}：
 * data 是空对象，既不是数组也没有任何路径 —— 服务端"没匹配到主键"。
 * 但 s_t_c 明明回 d_l=1（有字幕）、a_d=true（允许下载），两边对不上。
 *
 * 光试一种姿势永远读不出来，而每种姿势的响应都得在真机上试才知道。所以
 * 这里一次把姿势全试完（不同主键 / 带语言参数 / 老字段名 / 另一个端点），
 * 命中最先返回的那个，并把每一步的结果记进 state.raw.probe。
 * 另外还会把"页面自己发出去的那次请求 + 它的响应"原样记下来
 * （state.raw.pageRequests / pageResponses）—— 那是标准答案，
 * 跟我们的一比就知道差在哪。
 *
 * 接口全空时，还有两条不依赖接口的路：
 *   1) 播放器 DOM（<track> / <video>.textTracks 的 cue）
 *   2) Vue 组件里的 captionSrc / captionData
 * 那是"页面此刻真在显示的字幕"，比任何接口都可靠。
 *
 * 跨世界通信：隔离世界（content.js）读不到主世界的 JS 对象，所以走
 * window.postMessage —— 事件数据是结构化克隆的，两个世界都能读。
 */

(function () {
  // 2026-10-27: 钩子版本号（整数，只增不改）。
  //
  // 扩展刷新（chrome://extensions 的刷新按钮）**不会**更新已经打开的页面里
  // 的这段 JS —— 页面里的旧钩子会一直活着、一直发状态，而扩展后台读到的是
  // 它的旧格式（2026-10-27 踩过：旧钩子的 state 没有 raw/诊断字段，
  // 字幕地址也没抓到，后台拿着一份"半新半旧"的状态排查了半天）。
  //
  // 所以：版本号写进 state，后台发现对不上就重新注入一次（守卫按版本判断，
  // 同一个版本不重复注入）；内容脚本也按版本号丢弃更旧钩子发来的状态。
  const HOOK_VERSION = 7;
  const HOOK_BUILD = "2026-10-27.7";

  if (window.__bililearnXuetangxHook === HOOK_VERSION) return;
  window.__bililearnXuetangxHook = HOOK_VERSION;

  const CHANNEL = "bililearn-xuetangx";

  const state = {
    hookVersion: HOOK_VERSION,
    hookBuild: HOOK_BUILD,
    // 课程维度（来自 URL）
    sign: "", // products_sign，例如 THU08261000810
    signCandidates: [], // 各课程不一定一样，逐个试
    cid: "", // classroom_id，例如 31377125
    pageUrl: "", // 当前页面地址（笔记/导出链接用）
    // 小节维度（来自接口捕获）
    leafId: "",
    ccid: "",
    leafTitle: "",
    courseTitle: "",
    // leaf_info 里另外两个可能当字幕主键的 id（不同课字段不一样，全存下来试）
    contentId: "", // content_info.id
    videoId: "", // content_info.media.video_id
    // 字幕
    hasSubtitle: false,
    subtitleUrl: "",
    subtitleLang: "", // "zh" | "en"
    subtitleLangName: "",
    subtitleBody: null, // 字幕文件本体（原始文本，解析交给 background）
    subtitleFileBody: "", // 真字幕文件的正文（人工校对，优先级高于讲稿）
    subtitleFileError: "", // 字幕文件抓取失败的原因（诊断用）
    subtitleSource: "", // 字幕来源标记："" / "lecture-note" / "subtitle-file"
    // 讲稿（官方逐段文字稿，带时间戳）—— 2026-10-27 真机上翻出来的接口
    lectureNote: [], // [{start, end, content}]（秒）
    lectureNoteSource: "", // "leaf_lecture_note"
    hasLectureNote: false,
    // 本节章节（官方 AI 章节摘要：标题 + 概要 + 时间区间）
    leafKnowledge: [], // [{title, body, start, end}]
    // 诊断：每一步接口的原始响应片段（各 2000 字以内）
    raw: {
      leafInfo: "",
      subtitleConfig: "",
      subtitleList: "",
      subtitleFile: "",
      notes: [],
      // 字幕探针矩阵：每个候选请求一行（标签 + 状态 + 结果摘要）
      probe: [],
      // 页面自己发出去的字幕请求（原样记下来，用来跟我们自己的请求对照）
      pageRequests: [],
      // 页面自己拿到的字幕响应
      pageResponses: [],
      // 讲稿 / 章节接口的原始响应（诊断用）
      lectureNote: "",
      leafKnowledge: "",
    },
    // 视频
    videoUrl: "",
    poster: "",
    duration: 0,
    // 元信息
    capturedAt: 0,
    resolving: null, // 主动补齐的 Promise（不参与 postMessage）
    resolved: false, // 主动补齐是否已跑完
    rerunRequested: false, // 补齐期间又来了请求 → 这一轮跑完再补跑一轮
    probedCcid: "", // 探针矩阵已经试过的 ccid（同一个不重复试）
    leaves: [], // [{id, name}] 目录，用于章节名
  };

  function now() {
    return Date.now();
  }

  function postState() {
    state.capturedAt = now();
    // resolving 是 Promise —— structuredClone 不支持，postMessage 会直接抛
    // DataCloneError，所以先摘掉。
    const payload = { ...state };
    delete payload.resolving;
    try {
      window.postMessage({ source: CHANNEL, type: "state", payload }, "*");
    } catch (_e) {
      /* 忽略：某些页面禁用了 postMessage */
    }
  }

  // -------------------------------------------------------------------------
  // URL 解析
  //
  // 学堂在线有两种页面形态：
  //   A) 学习页（真正的播放器页）
  //      /learn/space/{products_sign}/{course_sign}/{classroom_id}/video/{leaf_id}
  //   B) 课程页（带试看播放器）
  //      /course/{products_sign}/{classroom_id}
  // 另外还有 /lesson/… /training/… 等售卖形态。
  //
  // sign 到底取哪一段，各课程不一样（有的两段相同，有的不），所以这里
  // 收集候选，拿到 leaf_info 时逐个试。
  // -------------------------------------------------------------------------
  function parseLocation() {
    const path = window.location.pathname || "";
    // 记下当前页面地址 —— 笔记/导出链接直接用它，指到具体这一小节
    state.pageUrl = window.location.href;

    // A) 学习页
    let m = path.match(
      /\/learn\/space\/([^/]+)\/([^/]+)\/(\d+)\/video\/(\d+)/i,
    );
    if (m) {
      state.sign = decodeURIComponent(m[1] || "");
      state.cid = m[3] || "";
      // 2026-10-27: URL 里的 leaf 只是"入口猜测"。学堂在线切小节时地址栏
      // 不一定变，页面真正的当前小节以 leaf_info 捕获为准 —— 所以这里
      // 不能覆盖已经学到的 leafId（覆盖了就等于退回上一节）。
      if (!state.leafId) state.leafId = m[4] || "";
      state.signCandidates = [
        decodeURIComponent(m[1] || ""),
        decodeURIComponent(m[2] || ""),
      ];
      return true;
    }

    // A') 学习页（没有 space 段）
    m = path.match(/\/learn\/([^/]+)\/([^/]+)\/(\d+)(?:\/video\/(\d+))?/i);
    if (m) {
      state.sign = decodeURIComponent(m[1] || "");
      state.cid = m[3] || "";
      if (!state.leafId) state.leafId = m[4] || "";
      state.signCandidates = [
        decodeURIComponent(m[1] || ""),
        decodeURIComponent(m[2] || ""),
      ];
      return true;
    }

    // B) 课程页
    m = path.match(
      /^\/(?:course|lesson|training|program)\/([^/?#]+)(?:\/(\d+))?/i,
    );
    if (m) {
      state.sign = decodeURIComponent(m[1] || "");
      state.cid = m[2] || "";
      state.signCandidates = [decodeURIComponent(m[1] || "")];
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 响应分派
  // -------------------------------------------------------------------------
  function readCookie(name) {
    try {
      const hit = document.cookie
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(name + "="));
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
    } catch (_e) {
      return "";
    }
  }

  function absolute(url) {
    try {
      return new URL(url, window.location.href).toString();
    } catch (_e) {
      return String(url || "");
    }
  }

  // -------------------------------------------------------------------------
  // 诊断小工具
  // -------------------------------------------------------------------------

  // 我们自己发的请求计数。补丁 fetch / XHR 时用它把"页面自己的请求"和
  // "我们自己补的请求"分开 —— 页面自己的那一份才是标准答案。
  let selfRequestDepth = 0;

  /** 记一条诊断（条数封顶，免得把诊断文件撑爆）。 */
  function addNote(text) {
    state.raw.notes.push(String(text));
    while (state.raw.notes.length > 60) state.raw.notes.shift();
  }

  /** 记一行探针结果。 */
  function recordProbe(label, status, detail) {
    state.raw.probe.push(
      `${label} → ${status} ${String(detail || "").slice(0, 300)}`,
    );
    while (state.raw.probe.length > 80) state.raw.probe.shift();
  }

  /** 把一段数据描述成"长什么样"（数组几条 / 对象几个键 / 空）。 */
  function describeShape(data) {
    if (data === null || data === undefined) return "空";
    if (Array.isArray(data)) return `数组(${data.length})`;
    if (typeof data === "object") {
      const keys = Object.keys(data);
      return `对象(${keys.length}键${keys.length ? ": " + keys.slice(0, 6).join(",") : ""})`;
    }
    return `${typeof data}:${String(data).slice(0, 60)}`;
  }

  /** 页面自己的请求（方法 / URL / 请求体）—— 记下来对照我们自己的请求。 */
  function recordPageRequest(method, url, body) {
    const line = `${method} ${String(url || "").slice(0, 160)} body=${String(
      body || "",
    ).slice(0, 240)}`;
    state.raw.pageRequests.push(line);
    while (state.raw.pageRequests.length > 20) state.raw.pageRequests.shift();
  }

  /** 页面自己拿到的响应（尤其是字幕那几条）—— 标准答案，留档。 */
  function recordPageResponse(url, text) {
    state.raw.pageResponses.push(
      `${String(url || "").slice(0, 120)} → ${String(text || "").slice(0, 600)}`,
    );
    while (state.raw.pageResponses.length > 8) state.raw.pageResponses.shift();
  }

  // 只对"值得看一眼"的请求做 clone + 解析，避免给页面每个请求都加开销
  function isInterestingUrl(url) {
    if (!url) return false;
    // 学堂在线的前端用 axios baseURL "/api/v1"，所以 fetch 收到的是
    // 相对路径 —— 必须单独认出来，否则一个接口都拦不到。
    if (/^\/?api\/v1\/lms\//i.test(url)) return true;
    // 2026-10-27: 讲稿 / 章节 / 图谱走的是 /c27/ 与 /train_platform/ 前缀，
    // 同样是相对路径，不认就只能在主动拉取时才知道。
    if (/^\/?c27\//i.test(url)) return true;
    if (/^\/?train_platform\//i.test(url)) return true;
    if (/xuetangx\.com|yuketang\.cn|aliyuncs\.com/i.test(url)) return true;
    // 字幕文件可能挂在别的 CDN 上，按文件名特征再捞一次
    return /subtitle|caption|\.srt(\?|$)|\.vtt(\?|$)|subtitle_list/i.test(url);
  }

  function pickTitle(json) {
    if (!json || typeof json !== "object") return "";
    const d = json.data || {};
    return String(
      d.name || d.title || (d.content && d.content.name) || d.content_info?.title || "",
    ).trim();
  }

  function pickCcid(json) {
    const d = (json && json.data) || {};
    const media =
      d.content_info?.media || d.media || d.content?.content_info?.media || null;
    return String(media?.ccid || media?.ccurl || d.ccid || "").trim();
  }

  function pickPoster(json) {
    const d = (json && json.data) || {};
    const media = d.content_info?.media || d.media || {};
    return String(media?.poster || media?.cover || d.poster || "").trim();
  }

  function handleLeafInfo(url, json) {
    const m = url.match(/leaf_info\/(\d+)\/(\d+)/i);
    if (!m) return;
    const d = (json && json.data) || {};
    const leafId = m[2];
    const title = pickTitle(json);
    const ccid = pickCcid(json);
    state.raw.leafInfo = JSON.stringify(json).slice(0, 2000);
    // 字幕主键在不同课上不一定是 ccid —— 把另外两个可能的 id 也存下来，
    // 探针矩阵里挨个试。
    const media = d.content_info?.media || d.media || {};
    if (d.content_info?.id != null) state.contentId = String(d.content_info.id);
    if (media.video_id != null) state.videoId = String(media.video_id);
    if (m[1]) state.cid = m[1];

    // leafId 变了 = 换了小节 → 上一节的东西全部作废
    // （ccid 是"小节"级的，留着上一节的就会拿到上一节的字幕地址）
    const leafChanged = state.leafId !== leafId;
    if (leafChanged) {
      state.leafId = leafId;
      state.ccid = "";
      state.subtitleUrl = "";
      state.subtitleLang = "";
      state.subtitleLangName = "";
      state.subtitleBody = null;
      state.subtitleFileBody = "";
      state.subtitleFileError = "";
      state.hasSubtitle = false;
      state.subtitleSource = "";
      state.lectureNote = [];
      state.lectureNoteSource = "";
      state.hasLectureNote = false;
      state.leafKnowledge = [];
      state.videoUrl = "";
      state.resolved = false;
      // 探针矩阵对同一个 ccid 只跑一遍（十来个请求，别把人家接口打爆）；
      // 换小节时清掉，用户点"重试"时也会清。
      state.probedCcid = "";
    }
    // 本次响应里的标题 / ccid 就是当前小节的 —— 放在作废之后赋值
    if (title) state.leafTitle = title;
    if (ccid) state.ccid = ccid;

    // 深搜完整响应：字幕文件地址未必只在 s_t_g_p 里
    const foundSubs = scanSubtitleUrls(json);
    if (foundSubs.length) {
      recordProbe("leaf_info 深搜", "OK", foundSubs[0].slice(0, 160));
      state.subtitleUrl = absolute(foundSubs[0]);
      state.hasSubtitle = true;
      postState();
      captureSubtitleFile(state.subtitleUrl);
      return;
    }
    // 字幕主键到底是哪个 id —— 一次列全，别再猜
    const idSummary = summarizeIds(json).filter((s) =>
      /media|content_info|ccid|video/i.test(s),
    );
    if (idSummary.length) {
      recordProbe("leaf_info 里的 id 字段", "info", idSummary.join(" | "));
    }

    if (leafChanged) {
      postState();
      // 换小节后主动补齐一次（拿新小节的字幕地址）
      ensureResolved();
      return;
    }
    const poster = pickPoster(json);
    if (poster) state.poster = poster;
    const dur = Number(d.duration || d.content_info?.duration || 0);
    if (dur) state.duration = dur;
    postState();
  }

  function handleSubtitleConfig(url, json) {
    const m = url.match(/service\/s_t_c\/(\d+)/i);
    if (!m) return;
    const d = (json && json.data) || {};
    state.raw.subtitleConfig = JSON.stringify(json).slice(0, 2000);
    // d_l: 0 = 中文, 1 = 英文；没有这个字段 = 该小节没有字幕
    const has = d.d_l !== undefined && d.d_l !== null && d.d_l !== "";
    state.hasSubtitle = !!has;
    if (m[1]) state.leafId = m[1];
    postState();
  }

  function handleSubtitleList(url, json) {
    if (!/\/service\/s_t_g_p\//i.test(url)) return;
    state.raw.subtitleList = JSON.stringify(json).slice(0, 2000);
    const list = (json && json.data) || [];
    if (!Array.isArray(list) || !list.length) return;
    // lang: 0 = 中文, 1 = 英文
    const pick =
      list.find((it) => Number(it.lang) === 0) ||
      list.find((it) => Number(it.lang) === 1) ||
      list[0];
    const url0 = pick && pickSubtitleUrl(pick);
    if (!url0) return;
    state.subtitleUrl = absolute(url0);
    const lang = Number(pick.lang);
    state.subtitleLang = lang === 0 ? "zh" : lang === 1 ? "en" : "";
    state.subtitleLangName = String(pick.name || "");
    state.hasSubtitle = true;
    postState();
    // 页面自己会去 CDN 取字幕文件；我们在页面上下文里顺手再取一份，
    // 这样后台不用跨域下载（后台可能没那个 CDN 的权限 / 会被 403）。
    captureSubtitleFile(state.subtitleUrl);
  }

  /**
   * 字幕文件地址藏在哪个字段，各版本不太一样 —— 挨个试。
   * 而且 data 有可能本身还是一个数组（一个语言下多个文件）。
   */
  function pickSubtitleUrl(item) {
    if (!item) return "";
    const keys = [
      "data",
      "url",
      "src",
      "subtitle_url",
      "subtitleUrl",
      "file",
      "path",
      "href",
    ];
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
      if (Array.isArray(value) && value.length) {
        const first = value[0];
        const inner =
          typeof first === "string"
            ? first
            : pickSubtitleUrl(first);
        if (inner) return inner;
      }
      if (value && typeof value === "object") {
        const inner = pickSubtitleUrl(value);
        if (inner) return inner;
      }
    }
    return "";
  }

  /**
   * 在页面上下文里把字幕文件本体抓下来（带页面自己的 cookie / referer）。
   * 抓到了就存进 state.subtitleBody，解析交给 background。
   */
  async function captureSubtitleFile(url) {
    if (!url) return "";
    try {
      const response = await window.fetch(url, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        state.subtitleFileError = "HTTP " + response.status;
        return "";
      }
      const text = await response.text();
      state.raw.subtitleFile = String(text).slice(0, 4000);
      if (!text) return "";
      // 已经是字幕结构就直接用；否则留给 background 按 SRT/VTT 解析
      state.subtitleFileBody = text;
      state.subtitleBody = text;
      state.hasSubtitle = true;
      state.subtitleSource = "subtitle-file";
      postState();
      return text;
    } catch (error) {
      state.subtitleFileError = String((error && error.message) || error);
      return "";
    }
  }

  function handlePlayUrl(url, json) {
    const m = url.match(/service\/playurl\/([^/?]+)/i);
    if (!m) return;
    const found = deepFindMediaUrl(json);
    if (found) state.videoUrl = found;
    if (m[1] && !state.ccid) state.ccid = m[1];
    // playurl 的响应里也可能直接带字幕路径
    const foundSubs = scanSubtitleUrls(json);
    if (foundSubs.length && !state.subtitleUrl) {
      recordProbe("playurl 深搜", "OK", foundSubs[0].slice(0, 160));
      state.subtitleUrl = absolute(foundSubs[0]);
      state.hasSubtitle = true;
      captureSubtitleFile(state.subtitleUrl);
    }
    postState();
  }

  function handleMenu(url, json) {
    if (!/\/learn\/menu\//i.test(url)) return;
    const list = (json && json.data) || (json && json.data?.leaf_list) || [];
    if (!Array.isArray(list)) return;
    state.leaves = list
      .filter((it) => it && it.id != null)
      .map((it) => ({
        id: String(it.id),
        name: String(it.name || it.title || "").trim(),
        leafType: Number(it.leaf_type ?? it.leafType ?? 0),
      }));
    postState();
  }

  // playurl 的返回结构层级不固定，深搜一层找第一个像视频直链的字符串
  function deepFindMediaUrl(node, depth = 0) {
    if (!node || depth > 6) return "";
    if (typeof node === "string") {
      if (/^https?:\/\/\S+\.(?:m3u8|mp4|flv)/i.test(node)) return node;
      return "";
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = deepFindMediaUrl(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof node !== "object") return "";
    for (const key of Object.keys(node)) {
      const hit = deepFindMediaUrl(node[key], depth + 1);
      if (hit) return hit;
    }
    return "";
  }

  function handleApiResponse(url, json) {
    if (!json || typeof json !== "object") return;
    // 2026-10-27: 讲稿 / 章节 —— 页面自己拉的时候（用户点开"讲稿""知识点"
    // 面板）顺手收下，省一次主动请求。
    if (/leaf_lecture_note/i.test(url)) {
      const rows = parseLectureNote(json);
      if (rows.length) {
        state.raw.lectureNote = JSON.stringify(json).slice(0, 2000);
        applyLectureNote(rows, "leaf_lecture_note");
      }
      return;
    }
    if (/leaf_knowledge/i.test(url)) {
      const rows = parseLeafKnowledge(json);
      if (rows.length) {
        state.raw.leafKnowledge = JSON.stringify(json).slice(0, 2000);
        applyLeafKnowledge(rows, "leaf_knowledge");
      }
      return;
    }
    if (/leaf_info\//i.test(url)) return handleLeafInfo(url, json);
    if (/service\/s_t_c\//i.test(url)) return handleSubtitleConfig(url, json);
    if (/service\/s_t_g_p\//i.test(url)) return handleSubtitleList(url, json);
    if (/service\/playurl\//i.test(url)) return handlePlayUrl(url, json);
    if (/\/learn\/menu\//i.test(url)) return handleMenu(url, json);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 讲稿（leaf_lecture_note）与章节（leaf_knowledge）
  //
  // 2026-10-27 在真机上翻出来的两个接口 —— 比官方字幕接口可靠得多，也比
  // Whisper 转录省事得多（文本是现成的，还带时间戳）：
  //
  //   GET /c27/online_courseware/leaf_lecture_note/{leafId}/
  //     → {"msg":"","data":[{"formalParagraphText":"同学们好，…",
  //         "id":"8045034","startTime":21200,"endTime":38120,
  //         "paragraphId":"1724711001232500000","speakerId":""}],"success":true}
  //     逐段官方文字稿。**时间戳单位是毫秒**。
  //
  //   GET /c27/online_courseware/leaf_knowledge/{leafId}/
  //     → {"msg":"","data":[{"headline":"太极拳：起源、理念与全球影响",
  //         "summary":"太极源于《易传》…","startTime":21200,
  //         "endTime":378760,"chapterId":1,"id":"798799"}],"success":true}
  //     官方 AI 章节摘要（标题 + 概要 + 时间区间）—— 直接当"概览/章节"用，
  //     不用再花钱跑一遍 AI。
  //
  // 两个都是 GET、不需要 CSRF、页面同源（自带登录 cookie），一个请求就够。
  // -------------------------------------------------------------------------

  /**
   * 这两个接口的时间戳单位是毫秒。换算成秒之前先拿视频总长自检一次 ——
   * 万一某个课返回的是秒，不能照除 1000（那会把 21 秒变成 5 小时）。
   */
  function xtPickDivisor(maxRaw, durationSec) {
    if (!(durationSec > 0)) return 1000; // 不知道总长 → 相信接口契约（毫秒）
    const asMs = maxRaw / 1000;
    if (asMs >= durationSec * 0.3 && asMs <= durationSec * 1.5) return 1000;
    if (maxRaw >= durationSec * 0.3 && maxRaw <= durationSec * 1.5) return 1;
    return 1000;
  }

  /**
   * 把一批 {rawStart, rawEnd, ...} 的原始时间戳换算成秒。
   * 换算完顺带把 end 补齐（讲稿里偶尔缺 endTime 或 end < start）。
   */
  function xtRowsToSeconds(rows, durationSec) {
    if (!Array.isArray(rows) || !rows.length) return [];
    let maxRaw = 0;
    for (const row of rows) {
      maxRaw = Math.max(maxRaw, Number(row.rawStart) || 0, Number(row.rawEnd) || 0);
    }
    const divisor = xtPickDivisor(maxRaw, durationSec);
    const out = [];
    for (const row of rows) {
      const start = Math.max(0, (Number(row.rawStart) || 0) / divisor);
      let end = Math.max(0, (Number(row.rawEnd) || 0) / divisor);
      if (!end || end < start) end = start + 3;
      out.push({ ...row, start, end });
    }
    return out;
  }

  /** 讲稿正文（不同课字段名可能不一样，挨个试）。 */
  function pickLectureText(item) {
    if (!item || typeof item !== "object") return "";
    const keys = [
      "formalParagraphText",
      "paragraphText",
      "formalText",
      "text",
      "content",
      "value",
    ];
    for (const key of keys) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  /** 解析 leaf_lecture_note 的响应 → [{start, end, content}]（秒）。 */
  function parseLectureNote(json) {
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : [];
    const raw = [];
    for (const item of list) {
      const content = pickLectureText(item);
      if (!content) continue;
      raw.push({
        rawStart: Number(item.startTime ?? item.start_time ?? item.start ?? 0),
        rawEnd: Number(item.endTime ?? item.end_time ?? item.end ?? 0),
        content,
      });
    }
    if (!raw.length) return [];
    return xtRowsToSeconds(raw, state.duration).map((row) => ({
      start: row.start,
      end: row.end,
      content: row.content,
    }));
  }

  /** 解析 leaf_knowledge 的响应 → [{title, body, start, end}]（秒）。 */
  function parseLeafKnowledge(json) {
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : [];
    const raw = [];
    for (const item of list) {
      const title = String(
        item.headline ?? item.title ?? item.name ?? item.chapter_name ?? "",
      ).trim();
      const body = String(
        item.summary ?? item.content ?? item.description ?? item.brief ?? "",
      ).trim();
      if (!title && !body) continue;
      raw.push({
        title,
        body,
        rawStart: Number(item.startTime ?? item.start_time ?? item.start ?? 0),
        rawEnd: Number(item.endTime ?? item.end_time ?? item.end ?? 0),
      });
    }
    if (!raw.length) return [];
    return xtRowsToSeconds(raw, state.duration).map((row) => ({
      title: row.title,
      body: row.body,
      start: row.start,
      end: row.end,
    }));
  }

  /**
   * 把讲稿写进状态。
   *
   * 后台解析字幕正文认的是 {subtitle_list:[{start,end,content}]} 这套结构，
   * 所以直接照着写 —— 后台一行都不用改，讲稿就成了"官方字幕"。
   */
  function applyLectureNote(rows, source) {
    if (!Array.isArray(rows) || !rows.length) return false;
    state.lectureNote = rows.slice(0, 2000);
    state.lectureNoteSource = source || "leaf_lecture_note";
    state.hasLectureNote = true;
    // 真字幕文件（人工校对过的）优先于讲稿（机器转写，可能有错字）。
    // 只有在没有字幕文件的时候，讲稿才顶上来当字幕 —— 来源标记也跟着换。
    if (!state.subtitleFileBody) {
      state.subtitleBody = JSON.stringify({ subtitle_list: state.lectureNote });
      state.subtitleSource = "lecture-note";
    }
    state.hasSubtitle = true;
    state.subtitleLang = state.subtitleLang || "zh";
    recordProbe("讲稿 " + state.lectureNoteSource, "OK", `${rows.length} 段`);
    postState();
    return true;
  }

  /**
   * 把章节摘要写进状态。
   *
   * 2026-10-27: 这里**不再**往"知识导引"里塞 —— 知识图谱那套（graph/convert →
   * kg_basic_info → knowledge_graph/nodes）返回的是一棵 300KB+ 的知识点树，
   * 那是课程的内容清单，不是概览，用户明确说"不需要"。现在概览只认官方
   * 章节摘要这一份。
   */
  function applyLeafKnowledge(rows, source) {
    if (!Array.isArray(rows) || !rows.length) return false;
    state.leafKnowledge = rows.slice(0, 200);
    recordProbe(
      "章节 " + (source || "leaf_knowledge"),
      "OK",
      `${rows.length} 章`,
    );
    postState();
    return true;
  }

  /**
   * 主动拉讲稿（官方文字稿）。
   * GET、不需要 CSRF、页面同源 —— 一发就成了，是最省事的字幕来源。
   */
  async function collectLeafLectureNote() {
    const leafId = String(state.leafId || "").trim();
    if (!leafId) return false;
    const path = `/c27/online_courseware/leaf_lecture_note/${encodeURIComponent(
      leafId,
    )}/`;
    const res = await apiGetJson(path);
    const rows = parseLectureNote(res.json);
    if (rows.length) {
      state.raw.lectureNote = String(res.text || "").slice(0, 2000);
      return applyLectureNote(rows, "leaf_lecture_note");
    }
    recordProbe(
      "讲稿 leaf_lecture_note",
      res.status || "ERR",
      describeProbeResponse(res, res.json),
    );
    addNote(`讲稿接口 ${path} → 没有可用段落`);
    return false;
  }

  /**
   * 主动拉本节章节摘要（官方 AI 生成的那份）。
   * 有它就不必再自己跑 AI 生成概览 —— 直接用官方的。
   */
  async function collectLeafKnowledge() {
    const leafId = String(state.leafId || "").trim();
    if (!leafId) return false;
    const path = `/c27/online_courseware/leaf_knowledge/${encodeURIComponent(
      leafId,
    )}/`;
    const res = await apiGetJson(path);
    const rows = parseLeafKnowledge(res.json);
    if (rows.length) {
      state.raw.leafKnowledge = String(res.text || "").slice(0, 2000);
      return applyLeafKnowledge(rows, "leaf_knowledge");
    }
    recordProbe(
      "章节 leaf_knowledge",
      res.status || "ERR",
      describeProbeResponse(res, res.json),
    );
    return false;
  }

  /** 页面上下文里拉 JSON（不要求 success 字段，图谱接口格式不一样）。 */
  async function apiGetRaw(path) {
    selfRequestDepth++;
    try {
      const response = await window.fetch(path, {
        method: "GET",
        credentials: "include",
        headers: apiHeaders(),
        cache: "no-store",
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_e) {
      return null;
    } finally {
      selfRequestDepth--;
    }
  }

  /** 同上，POST 版本。也不要求 success 字段。 */
  async function apiPostRaw(path, body) {
    selfRequestDepth++;
    try {
      const response = await window.fetch(path, {
        method: "POST",
        credentials: "include",
        headers: apiHeaders(),
        body: JSON.stringify(body || {}),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_e) {
      return null;
    } finally {
      selfRequestDepth--;
    }
  }

  // -------------------------------------------------------------------------
  // 探针用的低层请求：把 HTTP 状态和原始文本都带回来，不抛异常。
  // （apiGetRaw / apiPostRaw 一失败就返回 null，排查时看不到"到底发生了什么"，
  //  所以探针走这两条。）
  // -------------------------------------------------------------------------

  /** 读一个响应头（拿不到就返回空串）。 */
  function readHeader(response, name) {
    try {
      if (response && response.headers && response.headers.get) {
        return response.headers.get(name) || "";
      }
    } catch (_e) {}
    return "";
  }

  /** GET，返回 {status, ok, json, text}。 */
  async function apiGetJson(path) {
    selfRequestDepth++;
    try {
      const response = await window.fetch(path, {
        method: "GET",
        credentials: "include",
        headers: apiHeaders(),
        cache: "no-store",
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_e) {
        json = null;
      }
      return {
        status: response.status,
        ok: response.ok,
        json,
        text,
        retryAfter: readHeader(response, "retry-after"),
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        json: null,
        text: "",
        error: String((error && error.message) || error),
      };
    } finally {
      selfRequestDepth--;
    }
  }

  /** POST，返回 {status, ok, json, text}。 */
  async function apiPostJson(path, body) {
    selfRequestDepth++;
    try {
      const response = await window.fetch(path, {
        method: "POST",
        credentials: "include",
        headers: apiHeaders(),
        body: JSON.stringify(body || {}),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_e) {
        json = null;
      }
      return {
        status: response.status,
        ok: response.ok,
        json,
        text,
        retryAfter: readHeader(response, "retry-after"),
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        json: null,
        text: "",
        error: String((error && error.message) || error),
      };
    } finally {
      selfRequestDepth--;
    }
  }
  // -------------------------------------------------------------------------
  // fetch 补丁
  // -------------------------------------------------------------------------

  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  function patchFetch() {
    if (!nativeFetch) return;
    window.fetch = function (...args) {
      const promise = nativeFetch(...args);
      try {
        const request = args[0];
        const url =
          typeof request === "string"
            ? request
            : request && request.url
              ? request.url
              : "";
        if (!isInterestingUrl(url)) return promise;
        const abs = absolute(url);
        // 我们自己补的请求 vs 页面自己的请求 —— 分开记。
        // 页面自己那份才是"标准答案"，拿来跟我们的一比就知道差在哪。
        const isSelf = selfRequestDepth > 0;
        const method = String(
          (args[1] && args[1].method) ||
            (request && request.method) ||
            "GET",
        ).toUpperCase();
        const reqBody = args[1] && args[1].body;
        if (!isSelf && /s_t_g_p|s_t_c|leaf_info|video\/subtitle/i.test(abs)) {
          recordPageRequest(method, abs, reqBody);
        }
        promise
          .then((response) => {
            try {
              response
                .clone()
                .text()
                .then((text) => {
                  try {
                    const json = safeJsonParse(text);
                    if (json) {
                      if (!isSelf && /s_t_g_p/i.test(abs)) {
                        recordPageResponse(abs, text);
                      }
                      handleApiResponse(abs, json);
                      maybeCaptureSubtitleFile(abs, text);
                    }
                  } catch (_e) {}
                })
                .catch(() => {});
            } catch (_e) {}
            return response;
          })
          .catch(() => {});
      } catch (_e) {}
      return promise;
    };
  }

  // -------------------------------------------------------------------------
  // XHR 补丁
  // -------------------------------------------------------------------------
  function patchXhr() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__bililearnXuetangxPatched) return;
    proto.__bililearnXuetangxPatched = true;

    const nativeOpen = proto.open;
    proto.open = function (method, url, ...rest) {
      try {
        this.__bililearnXuetangxUrl = absolute(url);
        this.__bililearnXuetangxMethod = String(method || "GET");
      } catch (_e) {}
      return nativeOpen.call(this, method, url, ...rest);
    };

    const nativeSend = proto.send;
    proto.send = function (...args) {
      try {
        const url = this.__bililearnXuetangxUrl || "";
        if (url && isInterestingUrl(url)) {
          // 我们自己补的请求 vs 页面自己的请求 —— 分开记。
          const isSelf = selfRequestDepth > 0;
          const method = this.__bililearnXuetangxMethod || "GET";
          const reqBody = args[0];
          if (!isSelf && /s_t_g_p|s_t_c|leaf_info|video\/subtitle/i.test(url)) {
            recordPageRequest(method, url, reqBody);
          }
          this.addEventListener("load", function () {
            try {
              const raw =
                this.responseType === "json"
                  ? this.response
                  : this.responseText;
              if (!raw) return;
              if (typeof raw === "string") {
                const json = safeJsonParse(raw);
                if (json) {
                  if (!isSelf && /s_t_g_p/i.test(url)) {
                    recordPageResponse(url, raw);
                  }
                  handleApiResponse(url, json);
                  maybeCaptureSubtitleFile(url, raw);
                }
              } else if (raw && typeof raw === "object") {
                if (!isSelf && /s_t_g_p/i.test(url)) {
                  recordPageResponse(url, JSON.stringify(raw));
                }
                handleApiResponse(url, raw);
              }
            } catch (_e) {}
          });
        }
      } catch (_e) {}
      return nativeSend.apply(this, args);
    };
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 字幕文件本体：页面播放器自己去抓的时候顺手留一份，省一次跨域请求
  // -------------------------------------------------------------------------
  function maybeCaptureSubtitleFile(url, text) {
    if (!text || typeof text !== "string") return;
    if (text.length > 4 * 1024 * 1024) return;
    const json = safeJsonParse(text);
    if (json && Array.isArray(json.subtitle_list)) {
      state.raw.subtitleFile = text.slice(0, 4000);
      state.subtitleFileBody = text;
      state.subtitleBody = text;
      state.hasSubtitle = true;
      state.subtitleSource = "subtitle-file";
      postState();
      return;
    }
    // SRT / VTT：时间轴特征
    if (/-->/.test(text)) {
      state.raw.subtitleFile = text.slice(0, 4000);
      state.subtitleFileBody = text;
      state.subtitleBody = text;
      state.hasSubtitle = true;
      state.subtitleSource = "subtitle-file";
      postState();
    }
  }

  // -------------------------------------------------------------------------
  // 主动补齐（2026-10-26）
  //
  // 被动捕获有个前提：钩子得比页面的第一次请求先跑。扩展刚装/刚更新、
  // 页面早就打开时，那几次请求就漏了 —— 于是拿不到 ccid 和字幕地址。
  //
  // 兜底办法：在主世界里主动调学堂在线自己的接口。跑在页面上下文里，
  // 带的自然是这个页面的登录 cookie，不需要扩展自己存任何凭据。
  // -------------------------------------------------------------------------

  /**
   * 页面语言。学堂在线的 axios 拦截器从 `django_language` cookie 里读
   * （不是 localStorage —— 这一点很容易搞错）。
   */
  function pageLanguage() {
    const raw = (readCookie("django_language") || "").trim();
    if (/^zh/i.test(raw)) return "zh";
    if (/^en/i.test(raw)) return "en";
    const nav = String((navigator && navigator.language) || "").toLowerCase();
    if (nav.indexOf("zh") === 0) return "zh";
    if (nav.indexOf("en") === 0) return "en";
    return "zh";
  }

  /**
   * 学堂在线的 axios 拦截器会带这几个头，我们跟它保持一致 ——
   * 服务端很可能按语言挑字幕（s_t_c 的 d_l：0 中文 / 1 英文），
   * 头不一致就可能挑不出现有的字幕行。
   */
  function apiHeaders() {
    const lang = pageLanguage();
    const headers = {
      "Content-Type": "application/json",
      "app-name": "xtzx",
      "terminal-type": "web",
      "x-client": "web",
      xtbz: "xt",
      "django-language": lang,
      "Accept-Language":
        lang === "zh" ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9,zh;q=0.8",
    };
    const csrf = readCookie("csrftoken");
    if (csrf) headers["X-CSRFToken"] = csrf;
    return headers;
  }

  async function apiGet(path) {
    selfRequestDepth++;
    try {
      const response = await window.fetch(path, {
        method: "GET",
        credentials: "include",
        headers: apiHeaders(),
        cache: "no-store",
      });
      if (!response.ok) return null;
      const json = await response.json();
      return json && json.success ? json : null;
    } catch (_e) {
      return null;
    } finally {
      selfRequestDepth--;
    }
  }

  async function apiPost(path, body) {
    try {
      const response = await window.fetch(path, {
        method: "POST",
        credentials: "include",
        headers: apiHeaders(),
        body: JSON.stringify(body || {}),
      });
      if (!response.ok) return null;
      const json = await response.json();
      return json && json.success ? json : null;
    } catch (_e) {
      return null;
    }
  }

  /** 逐个试候选 sign，拉当前小节的详情（拿到 ccid + 标题）。 */
  async function fetchLeafInfo() {
    if (!state.cid || !state.leafId) return null;
    const candidates =
      state.signCandidates && state.signCandidates.length
        ? state.signCandidates.slice()
        : [state.sign];
    // 有些课程 leaf_info 根本不校验 sign —— 没有 sign 的形态也要试。
    candidates.push("");
    for (const sign of candidates) {
      const suffix = sign ? `?sign=${encodeURIComponent(sign)}` : "";
      const json = await apiGetRaw(
        `/api/v1/lms/learn/leaf_info/${state.cid}/${state.leafId}/${suffix}`,
      );
      state.raw.notes.push(
        `leaf_info sign=${sign || "(空)"} → ${
          json && json.data ? "成功" : "失败"
        }`,
      );
      if (json && json.data) {
        state.sign = sign || state.sign;
        return json;
      }
    }
    return null;
  }

  /**
   * 从字幕列表里挑一条（优先中文），返回 {item, url}。
   * 前端约定：[{lang: 0|1, data: "字幕文件地址"}]，lang 0=中文 1=英文。
   */
  function pickSubtitleEntry(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const byLang = (lang) => list.find((it) => it && Number(it.lang) === lang);
    const pick = byLang(0) || byLang(1) || list[0];
    const url0 = pick && pickSubtitleUrl(pick);
    if (!url0) return null;
    return { item: pick, url: absolute(url0) };
  }

  /** 把挑中的字幕条目写进 state，并顺手把文件本体抓下来。 */
  async function applySubtitleEntry(picked) {
    if (!picked) return false;
    state.subtitleUrl = picked.url;
    const lang = Number(picked.item.lang);
    state.subtitleLang = lang === 0 ? "zh" : lang === 1 ? "en" : "";
    state.subtitleLangName = String(picked.item.name || "");
    state.hasSubtitle = true;
    postState();
    // 字幕文件本体在页面上下文里抓（带页面自己的 cookie / referer），
    // 后台不用跨域下载。
    await captureSubtitleFile(state.subtitleUrl);
    return true;
  }

  /**
   * 探针矩阵里两次请求之间的间隔（毫秒）。
   *
   * 2026-10-27 实测：第一发 200，之后全部 403 —— 服务端在拦"短时间连发"。
   * 不限速的话矩阵根本跑不完（除了第一发，其余全被判失败）。
   *
   * 做成可覆盖（window.__bililearnProbeGapMs）是为了让测试不用真等。
   */
  const PROBE_GAP_MS = Number(
    typeof window !== "undefined" &&
      window.__bililearnProbeGapMs !== undefined &&
      window.__bililearnProbeGapMs !== null
      ? window.__bililearnProbeGapMs
      : 700,
  );

  /** 撞到 403 之后等多久再重试。 */
  const PROBE_RETRY_WAIT_MS = Number(
    typeof window !== "undefined" &&
      window.__bililearnProbeRetryWaitMs !== undefined &&
      window.__bililearnProbeRetryWaitMs !== null
      ? window.__bililearnProbeRetryWaitMs
      : 2500,
  );

  /** 等一小会儿（探针限速用）。 */
  function probeSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 把一次响应的关键信息拼成一行诊断。
   * 出错时**正文才是关键** —— 403 可能是 CSRF 校验、可能是限流、也可能是
   * 路由不对，光看状态码猜不出来。
   */
  function describeProbeResponse(res, data) {
    const status = Number(res.status || 0);
    if (status >= 200 && status < 300) return describeShape(data);
    const body = String(res.text || "")
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const retryAfter = res.retryAfter ? ` retry-after=${res.retryAfter}` : "";
    return `${describeShape(data)} 正文=${body}${retryAfter}`;
  }

  /**
   * 字幕探针矩阵 —— 一次把所有可能的请求姿势都试一遍，逐个记录结果。
   *
   * 为什么需要矩阵：前端 bundle 写的是 s_t_g_p({c_d: ccid})，线上返回的却是
   * {"msg":"","success":true,"data":{}} —— data 是空对象，既不是数组也没有
   * 任何路径，像是"服务端没匹配到这个主键"。到底是 ccid 取错了、还得显式带
   * 语言参数、还是这堂课的字幕走的是另一条接口，光靠猜不行 —— 索性一次全试
   * 完，把每个结果记进诊断文件：一次刷新就能看清真相，不用再来回试错。
   */
  async function probeSubtitleMatrix(ccid) {
    const ids = [];
    const pushId = (name, value) => {
      const v = String(value || "").trim();
      if (v && !ids.some((it) => it.value === v)) ids.push({ name, value: v });
    };
    pushId("ccid", ccid);
    pushId("contentId", state.contentId);
    pushId("videoId", state.videoId);
    pushId("leafId", state.leafId);
    recordProbe(
      "主键候选",
      "info",
      ids.map((it) => `${it.name}=${it.value}`).join(" | "),
    );
    addNote(
      `s_t_g_p 探针矩阵：${ids.length} 个主键候选（${ids
        .map((it) => it.name)
        .join("/")}），逐个试参数（间隔 ${PROBE_GAP_MS}ms）`,
    );

    // —— A. s_t_g_p 的各种请求体 ——
    const bodies = [];
    for (const id of ids) {
      bodies.push({ label: `s_t_g_p c_d=${id.name}`, body: { c_d: id.value } });
    }
    for (const id of ids.slice(0, 2)) {
      bodies.push({
        label: `s_t_g_p c_d=${id.name}+d_l=0`,
        body: { c_d: id.value, d_l: 0 },
      });
      bodies.push({
        label: `s_t_g_p c_d=${id.name}+d_l=1`,
        body: { c_d: id.value, d_l: 1 },
      });
    }
    if (ccid) bodies.push({ label: "s_t_g_p ccid字段", body: { ccid } });
    if (ids.length) {
      bodies.push({
        label: "s_t_g_p c_d+cid+sign",
        body: { c_d: ids[0].value, cid: state.cid, sign: state.sign },
      });
    }

    for (const item of bodies) {
      await probeSleep(PROBE_GAP_MS);
      let res = await apiPostJson("/api/v1/lms/service/s_t_g_p/", item.body);
      let data =
        res.json && res.json.data !== undefined ? res.json.data : res.json;
      if (!state.raw.subtitleList && res.text) {
        state.raw.subtitleList = String(res.text).slice(0, 2000);
      }
      let picked = pickSubtitleEntry(data);
      recordProbe(
        item.label,
        res.status || "ERR",
        describeProbeResponse(res, data),
      );

      // 遇到 403 等一下重试一次。实测服务端会拦"短时间连发"，
      // 但如果重试还是 403（那就是别的原因，比如 CSRF），就别再往下试了
      // —— 后面全是 403，跑完只是浪费时间和触发更严的限流。
      if (res.status === 403) {
        await probeSleep(PROBE_RETRY_WAIT_MS);
        res = await apiPostJson("/api/v1/lms/service/s_t_g_p/", item.body);
        data =
          res.json && res.json.data !== undefined ? res.json.data : res.json;
        picked = pickSubtitleEntry(data);
        recordProbe(
          `${item.label} 重试`,
          res.status || "ERR",
          describeProbeResponse(res, data),
        );
        if (!picked && res.status === 403) {
          addNote("连续两次 403 —— 停止 POST 矩阵（正文见 probe）");
          break;
        }
      }
      if (picked) return applySubtitleEntry(picked);
    }

    // —— B. 另一个字幕端点（前端留着但没用的那个）——
    // GET 不受 CSRF 保护，就算 POST 全被 403 拦了，这条路还有可能通。
    for (const id of ids.slice(0, 3)) {
      await probeSleep(PROBE_GAP_MS);
      const res = await apiGetJson(
        `/api/v1/lms/learn/video/subtitle/${encodeURIComponent(id.value)}/`,
      );
      const data =
        res.json && res.json.data !== undefined ? res.json.data : res.json;
      const picked = pickSubtitleEntry(data);
      recordProbe(
        `GET learn/video/subtitle/${id.name}`,
        res.status || "ERR",
        describeProbeResponse(res, data),
      );
      if (picked) return applySubtitleEntry(picked);
    }

    return false;
  }

  /**
   * 播放器手里已经有的字幕 —— 比任何接口都可靠，因为那就是页面此刻在显示的。
   * 三条路：<track> 元素、<video> 的 textTracks cue、Vue 组件里的 captionSrc。
   */
  async function harvestPlayerCaptions() {
    // 1) <track> 元素
    try {
      const tracks = Array.from(document.querySelectorAll("track"));
      for (const track of tracks) {
        const src = track.getAttribute("src") || track.src || "";
        if (!src) continue;
        if (!/subtitle|caption|\.srt|\.vtt|\.json|\.ass/i.test(src)) continue;
        recordProbe("DOM track", "OK", src.slice(0, 160));
        state.subtitleUrl = absolute(src);
        state.hasSubtitle = true;
        postState();
        await captureSubtitleFile(state.subtitleUrl);
        return true;
      }
    } catch (_e) {}

    // 2) <video> 的 textTracks —— cue 已经加载进浏览器了，直接抄
    try {
      const video = document.querySelector("video");
      if (video && video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const tt = video.textTracks[i];
          const cues = tt.cues;
          if (!cues || !cues.length) continue;
          const rows = [];
          for (let j = 0; j < cues.length; j++) {
            const cue = cues[j];
            const content = String((cue && cue.text) || "").trim();
            if (!content) continue;
            rows.push({
              start: Number(cue.startTime || 0),
              end: Number(cue.endTime || 0),
              content,
            });
          }
          if (!rows.length) continue;
          recordProbe("video.textTracks", "OK", `${rows.length} 条 cue`);
          state.subtitleBody = JSON.stringify({ subtitle_list: rows });
          state.hasSubtitle = true;
          state.subtitleLang = String(tt.language || "");
          postState();
          return true;
        }
      }
    } catch (_e) {}

    // 3) Vue 组件里的 captionSrc / captionData（播放器拿到字幕后挂在组件上）
    try {
      const found = findVueCaptionSource();
      if (found) {
        recordProbe(
          "Vue 播放器组件",
          "OK",
          `${found.kind} ${found.items.length} 条`,
        );
        const picked = pickSubtitleEntry(found.items);
        if (picked) return applySubtitleEntry(picked);
        // captionData.text 是整串文字数组（前端就是这么读的）
        if (Array.isArray(found.items) && typeof found.items[0] === "string") {
          const rows = found.items
            .map((t, idx) => ({
              start: idx,
              end: idx + 1,
              content: String(t || "").trim(),
            }))
            .filter((r) => r.content);
          if (rows.length) {
            state.subtitleBody = JSON.stringify({ subtitle_list: rows });
            state.hasSubtitle = true;
            postState();
            return true;
          }
        }
      }
    } catch (_e) {}

    return false;
  }

  /** 在 Vue 组件树里找播放器持有的字幕数据。 */
  function findVueCaptionSource() {
    let el = document.querySelector("video");
    const visited = new Set();
    while (el && !visited.has(el)) {
      visited.add(el);
      let cur = el.__vue__;
      let depth = 0;
      while (cur && depth < 40) {
        const data = (cur && cur.$data) || {};
        const src = cur.captionSrc || data.captionSrc;
        if (Array.isArray(src) && src.length) {
          return { kind: "captionSrc", items: src };
        }
        const player = cur.player || data.player;
        if (player) {
          if (Array.isArray(player.captionSrc) && player.captionSrc.length) {
            return { kind: "player.captionSrc", items: player.captionSrc };
          }
          const cd = player.captionData;
          if (cd && Array.isArray(cd.text) && cd.text.length) {
            return { kind: "player.captionData", items: cd.text };
          }
        }
        cur = cur.$parent;
        depth++;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 像不像一个"能下载的文件地址"（绝对地址，或以字幕扩展名结尾的相对路径）。 */
  function looksLikeSubtitlePath(value) {
    const s = String(value || "").trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s)) return true;
    return /^\/?[^\s]*\.(srt|vtt|json|ass|sub)$/i.test(s);
  }

  /**
   * 在任意 JSON 里深搜"像字幕文件"的东西。
   *
   * 为什么需要：接口清单是从前端 bundle 抄来的，但字幕文件地址未必只在
   * s_t_g_p 里 —— leaf_info / playurl 的响应里也可能直接带字幕路径
   * （键名像 subtitle/caption，或者值是 .srt/.vtt/.json）。
   * 深搜一遍不费事，捞到了就能直接用。
   */
  function scanSubtitleUrls(node, out = [], depth = 0) {
    if (!node || depth > 8 || out.length > 20) return out;
    if (typeof node === "string") {
      if (
        /(subtitle|caption|\.srt|\.vtt|\.ass|\.sub)/i.test(node) &&
        looksLikeSubtitlePath(node)
      ) {
        out.push(node);
      }
      return out;
    }
    if (Array.isArray(node)) {
      for (const item of node) scanSubtitleUrls(item, out, depth + 1);
      return out;
    }
    if (typeof node === "object") {
      for (const key of Object.keys(node)) {
        const value = node[key];
        // 键名像字幕字段、值像个文件地址 → 直接收
        if (
          /(subtitle|caption|srt|vtt)/i.test(key) &&
          typeof value === "string" &&
          looksLikeSubtitlePath(value)
        ) {
          out.push(value);
          continue;
        }
        scanSubtitleUrls(value, out, depth + 1);
      }
    }
    return out;
  }

  /**
   * 把 leaf_info / playurl 的响应里"所有像 id 的字段"列出来 ——
   * 字幕主键到底该用哪个，一次看清（不用再猜 content_info.id 之类）。
   */
  function summarizeIds(node, out = [], depth = 0, path = "") {
    if (!node || depth > 5 || out.length > 40) return out;
    if (Array.isArray(node)) {
      for (const item of node) summarizeIds(item, out, depth + 1, path);
      return out;
    }
    if (typeof node !== "object") return out;
    for (const key of Object.keys(node)) {
      const value = node[key];
      const next = path ? `${path}.${key}` : key;
      if (
        /(^|_)id$/i.test(key) &&
        (typeof value === "string" || typeof value === "number")
      ) {
        out.push(`${next}=${String(value).slice(0, 60)}`);
      }
      summarizeIds(value, out, depth + 1, next);
    }
    return out;
  }

  /**
   * 该小节有没有字幕（s_t_c）→ 再拉字幕文件地址。
   *
   * 2026-10-27: 之前把 s_t_g_p 卡在 "d_l 存在" 后面 —— 万一 d_l 的位置
   * 跟预期不一样（有的是 data.d_l，有的是 data[0].d_l），就整个链路断掉，
   * 表现为"明明有字幕却读不到"。现在 s_t_g_p 无条件试：它没有字幕时本来
   * 就返回空列表，试一下不花钱。
   *
   * 2026-10-27（第二轮）：请求体按前端代码来是 {c_d: ccid}，但老接口
   * 用的是 {ccid: ccid} —— 两个都试。
   *
   * 2026-10-27（第三轮）：两个都对不上（线上回 data:{}），于是改成
   * 探针矩阵 —— 一次把所有可能的姿势试完并记录，见 probeSubtitleMatrix。
   */
  async function fetchSubtitleInfo(ccid) {
    if (!state.leafId || !ccid) return;
    const cfg = await apiGetRaw(
      `/api/v1/lms/service/s_t_c/${state.leafId}/`,
    );
    const d = (cfg && (cfg.data || cfg)) || {};
    const has = d.d_l !== undefined && d.d_l !== null && d.d_l !== "";
    state.hasSubtitle = !!has;
    state.raw.subtitleConfig = JSON.stringify(cfg).slice(0, 2000);
    addNote(
      `s_t_c d_l=${has ? d.d_l : "(无)"} → ${
        has ? "有字幕" : "接口说没字幕（仍然继续试 s_t_g_p）"
      }`,
    );

    // 接口矩阵：命中就收工
    const hit = await probeSubtitleMatrix(ccid);
    if (hit) return;

    // 接口全空 → 回头看播放器手里有没有（页面此刻真在用的字幕）
    addNote("接口矩阵全空，改从播放器 DOM/组件里找");
    await harvestPlayerCaptions();
  }

  /** 缺什么补什么；补齐后再推一次状态。 */
  function ensureResolved() {
    if (state.resolving) {
      // 正在补齐的时候又来请求（多半是用户刚换了小节）—— 记下来，
      // 这一轮跑完再补跑一次，免得新小节的字幕永远补不上。
      state.rerunRequested = true;
      return state.resolving;
    }
    state.resolving = (async () => {
      try {
        parseLocation();
        if (!state.leafId && state.ccid) state.leafId = "";
        if (!state.ccid) {
          const leaf = await fetchLeafInfo();
          if (leaf) {
            const title = pickTitle(leaf);
            const ccid = pickCcid(leaf);
            if (title) state.leafTitle = title;
            if (ccid) state.ccid = ccid;
            const poster = pickPoster(leaf);
            if (poster) state.poster = poster;
            // 视频总长 —— 讲稿/章节的时间戳是毫秒，换算成秒之前要拿它自检
            const dur = Number(
              leaf?.data?.duration || leaf?.data?.content_info?.duration || 0,
            );
            if (dur) state.duration = dur;
          }
        }
        // 2026-10-27: **讲稿优先**。
        //
        // leaf_lecture_note 返回的是官方逐段文字稿，带毫秒时间戳 ——
        // 比官方字幕接口（s_t_g_p 那条线一直读不出来）靠谱得多，
        // 也省掉整条字幕探针矩阵（十几个请求 + 限速，十来秒）。
        // 拿到讲稿就直接当作"官方字幕"交给后台，后台一行都不用改。
        if (!state.hasLectureNote) {
          await collectLeafLectureNote();
        }
        // 官方章节摘要 —— 有它概览就不用跑 AI 了。
        if (!state.leafKnowledge.length) {
          await collectLeafKnowledge();
        }
        // 讲稿没拿到 → 退到老的字幕探针矩阵（s_t_g_p 等）。
        if (
          state.ccid &&
          !state.subtitleBody &&
          !state.subtitleUrl &&
          state.probedCcid !== state.ccid
        ) {
          state.probedCcid = state.ccid;
          await fetchSubtitleInfo(state.ccid);
        }
        // 课程名（面板头部显示用，拿不到也不影响字幕）
        if (!state.courseTitle && state.cid && state.sign) {
          const info = await apiGet(
            `/api/v1/lms/learn/product/info?cid=${encodeURIComponent(
              state.cid,
            )}&sign=${encodeURIComponent(state.sign)}`,
          );
          const d = (info && info.data) || {};
          const name = d.name || d.course_name || d.title || "";
          if (name) state.courseTitle = String(name);
        }
        // 官方章节摘要：拉到了概览就不跑 AI（拉不到也不影响别的功能）。
      } catch (_e) {
        /* 补齐失败就维持现状，隔离世界会显示"没抓到小节" */
      } finally {
        state.resolving = null;
        state.resolved = true;
        postState();
        // 补跑一轮（换小节时来的请求会置位这个标记）
        if (state.rerunRequested) {
          state.rerunRequested = false;
          ensureResolved();
        }
      }
    })();
    return state.resolving;
  }

  // -------------------------------------------------------------------------
  // 与隔离世界通信
  // -------------------------------------------------------------------------
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    if (data.type === "request") {
      parseLocation();
      // force = 用户点了"重试" → 把探针的"已试过"标记清掉，重新跑一遍矩阵。
      if (data.force) {
        state.probedCcid = "";
        state.resolved = false;
        state.raw.probe = [];
        // 讲稿/章节也重新拉一遍（用户可能刚换了一节课）
        state.hasLectureNote = false;
        state.lectureNote = [];
        state.leafKnowledge = [];
      }
      postState();
      // 立刻回一次已知的，同时后台补齐（补完会再推一次）
      ensureResolved();
    }
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  parseLocation();
  patchFetch();
  patchXhr();

  // 页面自己加载完第一个小节后，主动补齐一次（覆盖"扩展后装"的情况）
  if (document.readyState === "complete") {
    ensureResolved();
  } else {
    window.addEventListener("load", () => ensureResolved(), { once: true });
  }

  // 暴露给隔离世界的备用读取口（仅调试用，隔离世界读不到）
  window.__bililearnXuetangxState = state;
  window.__bililearnXuetangxReadCsrftoken = readCookie;
})();
