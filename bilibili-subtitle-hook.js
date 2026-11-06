/**
 * bilibili-subtitle-hook.js —— B站官方字幕取数钩子（主世界 / world=MAIN）
 *
 * 2026-11-05 新增。
 *
 * 为什么需要这个文件（而不是在 content.js 里直接 fetch）：
 *
 *   B站只对**登录用户**下发字幕列表。未登录时 /x/player/wbi/v2 返回
 *   `need_login_subtitle: true` + 空列表（实测：无签名 / 旧版 / 正确
 *   wbi 签名三种调用结果完全一样，所以 wbi 签名不是问题，登录态才是）。
 *
 *   service worker 里 `credentials: "include"` 的跨站请求属于第三方
 *   上下文 → 浏览器默认挡第三方 cookie → 登录 cookie 送不出去 →
 *   扩展拿不到字幕轨 → 面板误判成"这视频没字幕"，直接叫用户上 Whisper。
 *   （用户看到的"过一会儿页面切来切去它自己出现了"，是 whisper 转录后
 *   落盘的本地文件命中了本地文件路径，不是官方字幕突然出现了。）
 *
 *   隔离世界（content.js 所在的世界）里 fetch 仍然算扩展上下文 ——
 *   B 站的 api.bilibili.com 只会回
 *   `Access-Control-Allow-Origin: https://www.bilibili.com`，对
 *   `chrome-extension://<id>` 不放行。
 *
 *   主世界（这个文件，manifest 里 world=MAIN）里的 fetch 就是**页面自己**
 *   的 fetch：Origin 是 www.bilibili.com、Referer 是页面地址、cookie 是
 *   这一份登录态 —— B 站自己的播放器就是这么读的。
 *
 * 通信：window.postMessage 双向。
 *   隔离世界 → 页面：{ source:"bililearn-bili-subtitle", type:"request",
 *                    id, bvid, cid } 或 { ..., url }
 *   页面 → 隔离世界：{ source:"bililearn-bili-subtitle", type:"reply",
 *                      id, ok, tracks|body|error }
 *
 * 与学堂在线的 xuetangx-hook.js 是同一套模式（那边是拦截页面自己的
 * fetch，这里是主动发请求）。
 */
(() => {
  if (window.__BILIBILI_SUBTITLE_HOOK__) return;
  window.__BILIBILI_SUBTITLE_HOOK__ = true;

  const CHANNEL = "bililearn-bili-subtitle";

  function reply(id, payload) {
    try {
      // payload 必须**嵌套**在 payload 字段里 —— 隔离世界的对端读的是
      // data.payload（见 content.js 的消息监听器）。平铺会让对端收到
      // undefined，于是回话被当成"空回话"丢掉。
      window.postMessage({ source: CHANNEL, type: "reply", id, payload }, "*");
    } catch (_e) {
      /* 页面正在卸载 —— 忽略 */
    }
  }

  /** 把 B 站的 "//host/path" 补成完整 https 地址。 */
  function absoluteUrl(raw) {
    if (!raw) return "";
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    return `https://${raw}`;
  }

  /**
   * 取字幕轨列表。
   * 不做签名 —— 实测该端点不校验 wbi 签名，三种调用方式结果一致。
   */
  async function fetchTracks(bvid, cid) {
    const url =
      "https://api.bilibili.com/x/player/wbi/v2" +
      `?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    let player;
    try {
      player = await res.json();
    } catch (_e) {
      throw new Error(`B 站字幕列表返回的不是 JSON（HTTP ${res.status}）。`);
    }
    if (!player || player.code !== 0) {
      throw new Error((player && player.message) || `无法读取 B 站字幕列表（HTTP ${res.status}）。`);
    }
    const data = player.data || {};
    const subtitles = (data.subtitle && data.subtitle.subtitles) || [];
    return {
      tracks: subtitles.map((item) => ({
        lan: item.lan || "",
        lanDoc: item.lan_doc || "",
        subtitleUrl: absoluteUrl(item.subtitle_url),
        isAi: /ai-zh|ai-generated|自动/i.test(
          `${item.lan || ""} ${item.lan_doc || ""} ${item.type || ""}`,
        ),
      })),
      needLogin: !!data.need_login_subtitle,
    };
  }

  /** 下载字幕文件本体，返回解析好的 body 数组。 */
  async function fetchSubtitleFile(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) {
      throw new Error(`B 站字幕文件下载失败（HTTP ${res.status}）。`);
    }
    let payload;
    try {
      payload = await res.json();
    } catch (_e) {
      throw new Error("B 站字幕文件不是合法 JSON。");
    }
    return { body: (payload && payload.body) || [] };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.type !== "request") return;

    const id = data.id;
    try {
      if (data.url) {
        const { body } = await fetchSubtitleFile(data.url);
        reply(id, { ok: true, body });
        return;
      }
      if (!data.bvid || !data.cid) {
        reply(id, { ok: false, reason: "missing_ids", error: "缺少 bvid 或 cid。" });
        return;
      }
      const { tracks, needLogin } = await fetchTracks(data.bvid, data.cid);
      reply(id, { ok: true, tracks, needLogin });
    } catch (error) {
      reply(id, {
        ok: false,
        reason: "page_fetch_failed",
        error: (error && error.message) || String(error),
      });
    }
  });
})();
