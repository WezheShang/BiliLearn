// 端到端探针：B站官方字幕「页面主世界」链路
//
// 2026-11-05。验证的链路：
//   background 模拟器 → chrome.tabs.sendMessage → content.js（隔离世界）
//     → window.postMessage → 主世界 hook → fetch(mock) → postMessage 回来
//     → content.js → 回给 background
//
// 实现说明：
//   真实 Chrome 里隔离世界与主世界是两个 JS realm，但共享同一个 window
//   的 DOM；postMessage 双向可达（学堂在线的 xuetangx-hook.js 就是这么
//   干的，见 content.js 的 handleXuetangxStateMessage）。探针里用**一个**
//   jsdom window 同时装下两个世界的代码，并接管 addEventListener("message")
//   与 postMessage，做一个确定性的消息总线 —— 这样不依赖 jsdom 对
//   MessageEvent.source 的具体实现（jsdom 给 null），行为与 Chrome 一致
//   （source === window）。
//
// 这个探针抓的是"接线错了"这一类 bug：channel 名对不上、message action
// 对不上、返回形状不对、hook 没回话、超时没兜底、选轨优先级写反等。

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra !== undefined ? " :: " + JSON.stringify(extra) : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 静态检查：源码里必须有的关键结构
// ---------------------------------------------------------------------------
console.log("\n== 静态结构检查 ==");
const contentSrc = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const hookSrc = fs.readFileSync(path.join(ROOT, "bilibili-subtitle-hook.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

check(
  "content.js 有 getBilibiliOfficialSubtitles 消息分支",
  contentSrc.includes('message.action === "getBilibiliOfficialSubtitles"'),
);
check(
  "content.js 有 getBilibiliSubtitleFile 消息分支",
  contentSrc.includes('message.action === "getBilibiliSubtitleFile"'),
);
check(
  "background.js 有 fetchBilibiliOfficialSubtitleViaPage",
  bgSrc.includes("fetchBilibiliOfficialSubtitleViaPage"),
);
check(
  "background.js 主世界注入用 world: MAIN",
  /files:\s*\["bilibili-subtitle-hook\.js"\]/.test(bgSrc) &&
    bgSrc.includes('world: "MAIN"'),
);
check(
  "background.js 走页面上下文优先于直连",
  bgSrc.indexOf("fetchBilibiliOfficialSubtitleViaPage") <
    bgSrc.indexOf("兜底：service worker 直连"),
);
check(
  "manifest 注册了 MAIN world 的 bilibili-subtitle-hook.js",
  manifest.content_scripts.some(
    (cs) =>
      (cs.js || []).includes("bilibili-subtitle-hook.js") && cs.world === "MAIN",
  ),
);
check(
  "manifest 的 hook 匹配 B 站视频页",
  manifest.content_scripts.some(
    (cs) =>
      (cs.js || []).includes("bilibili-subtitle-hook.js") &&
      (cs.matches || []).some((m) => m.includes("bilibili.com/video/")),
  ),
);

// ---------------------------------------------------------------------------
// 2. 测试脚手架：一个装了「主世界 hook + 隔离世界 content 代码」的页面
// ---------------------------------------------------------------------------

/** 接管 message 事件与 postMessage，做一个确定性的消息总线。 */
function installMessageBus(win) {
  const listeners = [];
  const originalAdd = win.addEventListener.bind(win);
  win.addEventListener = (type, fn, opts) => {
    if (type === "message") {
      listeners.push(fn);
      return undefined;
    }
    return originalAdd(type, fn, opts);
  };
  win.postMessage = (data) => {
    // 真实浏览器是异步派发；这里保持异步，避免重入。
    setTimeout(() => {
      for (const fn of listeners.slice()) {
        try {
          fn({
            source: win,
            origin: win.location.origin,
            data: JSON.parse(JSON.stringify(data)),
          });
        } catch (err) {
          console.error("    [bus] listener threw:", err.message);
        }
      }
    }, 0);
  };
  return win;
}

/**
 * @param {object} opts
 * @param {boolean} opts.loggedIn  B 站是否给登录态下发字幕轨
 * @param {Array}  opts.tracks     字幕轨（未登录时忽略）
 * @param {boolean} opts.withHook  页面里是否装了主世界 hook
 * @param {string} opts.hookSource     主世界 hook 源码（可注入变异版）
 * @param {string} opts.contentSource  隔离世界 content 源码（可注入变异版）
 */
function makePage({
  loggedIn,
  tracks = [],
  withHook = true,
  hookSource = hookSrc,
  contentSource = contentSrc,
}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><video></video></body></html>`,
    {
      url: "https://www.bilibili.com/video/BV1ed4b6rE5G/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const win = installMessageBus(dom.window);

  // 模拟 B 站 API —— 按登录态决定给不给字幕轨
  win.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/x/player/wbi/v2")) {
      const body = loggedIn
        ? {
            code: 0,
            data: {
              bvid: "BV1ed4b6rE5G",
              cid: 43352328905,
              subtitle: { subtitles: tracks },
            },
          }
        : {
            code: 0,
            data: {
              bvid: "BV1ed4b6rE5G",
              cid: 43352328905,
              need_login_subtitle: true,
            },
          };
      return { ok: true, status: 200, json: async () => body };
    }
    if (target.includes("subtitle-test.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          body: [
            { from: 0, to: 2.5, content: "第一句台词" },
            { from: 2.5, to: 5, content: "  第二句台词  " },
          ],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // 主世界 hook（先装，模拟 document_start 注入）
  if (withHook) win.eval(hookSource);

  // 隔离世界 content.js 的字幕代码块
  const chunk = extractContentSubtitleChunk(contentSource);
  win.eval(chunk);

  return {
    win,
    fetchTracks: (bvid, cid, timeoutMs) =>
      win.eval("fetchBilibiliSubtitleTracksInPage")(
        bvid,
        cid,
        timeoutMs,
      ),
    fetchFile: (url) => win.eval("fetchBilibiliSubtitleFileInPage")(url),
  };
}

/**
 * 从 content.js 里抽出字幕相关的那段代码（隔离世界）。
 * 源文件是 CRLF，所以按内容定位而不是按 "\n * " 找。
 */
function extractContentSubtitleChunk(src) {
  const startMarker = "const BILIBILI_SUBTITLE_CHANNEL";
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("content.js 里找不到 BILIBILI_SUBTITLE_CHANNEL");
  const endMarker = "Listen for messages from the side panel";
  const end = src.indexOf(endMarker);
  if (end < 0) throw new Error("content.js 里找不到监听器段落的结束标记");
  // 回退到结束标记前面最近的 "/**"
  const docStart = src.lastIndexOf("/**", end);
  return src.slice(start, docStart > start ? docStart : end);
}

// ---------------------------------------------------------------------------
// 3. 端到端用例
// ---------------------------------------------------------------------------
async function main() {

// --- 用例 A：登录用户 → 能拿到字幕轨 ---
console.log("\n-- 用例 A：登录用户，页面上下文取到字幕轨 --");
{
  const page = makePage({
    loggedIn: true,
    tracks: [
      {
        lan: "zh-CN",
        lan_doc: "中文（中国）",
        subtitle_url: "//aisubtitle.hdslb.com/subtitle-test.json",
        type: 0,
      },
    ],
  });
  const result = await page.fetchTracks("BV1ed4b6rE5G", "43352328905", 5000);
  check("A1 成功标记", result.success === true, result);
  check("A2 拿到 1 条字幕轨", (result.tracks || []).length === 1, result.tracks);
  check(
    "A3 subtitle_url 补成绝对地址",
    result.tracks?.[0]?.subtitleUrl === "https://aisubtitle.hdslb.com/subtitle-test.json",
    result.tracks?.[0]?.subtitleUrl,
  );
  check("A4 不误报 needLogin", result.needLogin === false, result);
  check("A5 人工中文轨 isAi=false", result.tracks?.[0]?.isAi === false, result.tracks?.[0]);
}

// --- 用例 B：未登录 → 明确报"没有字幕轨"，不是静默 ---
console.log("\n-- 用例 B：未登录，明确报 no_tracks --");
{
  const page = makePage({ loggedIn: false, tracks: [] });
  const result = await page.fetchTracks("BV1ed4b6rE5G", "43352328905", 5000);
  check("B1 明确失败", result.success === false, result);
  check("B2 reason=no_tracks", result.reason === "no_tracks", result.reason);
  check("B3 needLogin=true", result.needLogin === true, result);
  check(
    "B4 错误文案点明登录态",
    /need_login_subtitle|登录/.test(result.error || ""),
    result.error,
  );
}

// --- 用例 C：钩子不在（扩展刚重载）→ 报 hook_missing，不挂死 ---
console.log("\n-- 用例 C：主世界没有钩子，超时后报 hook_missing --");
{
  const page = makePage({ loggedIn: true, tracks: [], withHook: false });
  const started = Date.now();
  const result = await page.fetchTracks("BV1ed4b6rE5G", "43352328905", 300);
  const elapsed = Date.now() - started;
  check("C1 明确失败", result.success === false, result);
  check("C2 reason=hook_missing", result.reason === "hook_missing", result.reason);
  check("C3 没有无限挂死（<3s）", elapsed < 3000, `${elapsed}ms`);
}

// --- 用例 D：字幕文件下载（页面主世界备用路径） ---
console.log("\n-- 用例 D：主世界下载字幕文件 --");
{
  const page = makePage({ loggedIn: true, tracks: [] });
  const result = await page.fetchFile(
    "https://aisubtitle.hdslb.com/subtitle-test.json",
  );
  check("D1 成功标记", result.success === true, result);
  check("D2 拿到 body 数组", Array.isArray(result.body) && result.body.length === 2, result.body);
  check("D3 body 内容正确", result.body?.[0]?.content === "第一句台词", result.body);
}

// --- 用例 E：AI 字幕被标记出来（选轨要靠它排除人工轨优先级误判） ---
console.log("\n-- 用例 E：AI 字幕标记 --");
{
  const page = makePage({
    loggedIn: true,
    tracks: [
      {
        lan: "ai-zh",
        lan_doc: "中文（自动生成）",
        subtitle_url: "//aisubtitle.hdslb.com/subtitle-test.json",
        type: 1,
      },
    ],
  });
  const result = await page.fetchTracks("BV1ed4b6rE5G", "43352328905", 5000);
  check("E1 isAi=true", result.tracks?.[0]?.isAi === true, result.tracks?.[0]);
}

// --- 用例 F：background 的 payload 构造函数（真源码） ---
console.log("\n-- 用例 F：background 的 payload 构造 --");
{
  const build = extractFunction(bgSrc, "function buildBilibiliSubtitlePayload");
  const payload = build(
    {
      body: [
        { from: 0, to: 2.5, content: "你好" },
        { from: 2.5, to: 5, content: "  " },
        { from: 5, to: 9, content: "世界" },
      ],
    },
    "zh-CN",
    "page-context",
  );
  check("F1 payload 成功", payload?.success === true, payload);
  check("F2 跳过空行（2 条）", payload?.transcript?.length === 2, payload?.transcript?.length);
  check("F3 text 已 trim", payload?.transcript?.[0]?.text === "你好", payload?.transcript?.[0]);
  check("F4 start 是秒数", payload?.transcript?.[0]?.start === 0, payload?.transcript?.[0]);
  check("F5 duration 正确", payload?.transcript?.[0]?.duration === 2.5, payload?.transcript?.[0]);
  check(
    "F6 时间戳格式",
    /^\[\d+:\d\d\] /m.test(payload?.transcriptTextTimestamped || ""),
    payload?.transcriptTextTimestamped,
  );
  check("F7 via 标记", payload?.via === "page-context", payload?.via);
  check("F8 language 透传", payload?.language === "zh-CN", payload?.language);

  const empty = build({ body: [] }, "zh-CN", "page-context");
  check("F9 空 body 返回 null", empty === null, empty);
}

// --- 用例 G：选轨优先级（与 background 里真源码同序） ---
console.log("\n-- 用例 G：选轨优先级 --");
{
  const pick = (tracks) =>
    tracks.find((item) => /^(zh|zh-CN|zh-Hans|zh-TW)/i.test(item.lan || "") && !item.isAi) ||
    tracks.find((item) => /zh/i.test(item.lan || "")) ||
    tracks[0];

  check(
    "G1 人工中文优先于 AI 中文",
    pick([
      { lan: "en-US", isAi: false },
      { lan: "ai-zh", isAi: true },
      { lan: "zh-CN", isAi: false },
    ]).lan === "zh-CN",
  );
  check(
    "G2 只有 AI 中文时选 AI 中文",
    pick([
      { lan: "en-US", isAi: false },
      { lan: "ai-zh", isAi: true },
    ]).lan === "ai-zh",
  );
  check(
    "G3 没有中文时退回第一条",
    pick([{ lan: "en-US", isAi: false }]).lan === "en-US",
  );
}

// --- 用例 H：background 真源码里的选轨逻辑（防止改了真码探针还在过） ---
console.log("\n-- 用例 H：background 真源码选轨 --");
{
  const bgPickSrc = bgSrc.slice(
    bgSrc.indexOf("const preferred =", bgSrc.indexOf("fetchBilibiliOfficialSubtitleViaPage")),
  );
  const exprStart = bgPickSrc.indexOf("tracks.find");
  const exprEnd = bgPickSrc.indexOf(";", bgPickSrc.indexOf("tracks[0]", exprStart));
  const expr = bgPickSrc.slice(exprStart, exprEnd);
  const pick = new Function("tracks", `return (${expr});`);
  check(
    "H1 background 选轨：人工中文优先",
    pick([
      { lan: "en-US", isAi: false },
      { lan: "ai-zh", isAi: true },
      { lan: "zh-CN", isAi: false },
    ]).lan === "zh-CN",
  );
  check(
    "H2 background 选轨：只有 AI 中文时选 AI",
    pick([
      { lan: "en-US", isAi: false },
      { lan: "ai-zh", isAi: true },
    ]).lan === "ai-zh",
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 4. 反向验证（红）：把"守卫"改回坏的状态，探针必须失败
//
// 这一步是为了证明探针**真的能抓到 bug**，而不是永远绿。
// 每个变异都对应一个真实可能发生的接线错误。
// ---------------------------------------------------------------------------
console.log("\n== 反向验证（把守卫改坏，探针必须失败） ==");
{
  // 变异 1：hook 回话时把 payload 平铺（真实踩过的坑）
  const flatReply = hookSrc.replace(
    'window.postMessage({ source: CHANNEL, type: "reply", id, payload }, "*");',
    'window.postMessage({ source: CHANNEL, type: "reply", id, ...payload }, "*");',
  );
  check("R1 变异生效（hook 源码确实被改了）", flatReply !== hookSrc);
  const page = makePage({
    loggedIn: true,
    tracks: [
      {
        lan: "zh-CN",
        lan_doc: "中文（中国）",
        subtitle_url: "//aisubtitle.hdslb.com/subtitle-test.json",
        type: 0,
      },
    ],
    hookSource: flatReply,
  });
  const result = await page.fetchTracks("BV1ed4b6rE5G", "43352328905", 5000);
  check(
    "R2 payload 平铺 → 用例 A 必须失败（探针能抓到这个 bug）",
    result.success === false,
    result,
  );

  // 变异 2：channel 名对不上
  const wrongChannel = hookSrc.replace(
    'const CHANNEL = "bililearn-bili-subtitle";',
    'const CHANNEL = "bililearn-bili-subtitles";',
  );
  check("R3 变异生效（channel 名被改）", wrongChannel !== hookSrc);
  const page2 = makePage({
    loggedIn: true,
    tracks: [
      {
        lan: "zh-CN",
        lan_doc: "中文（中国）",
        subtitle_url: "//aisubtitle.hdslb.com/subtitle-test.json",
        type: 0,
      },
    ],
    hookSource: wrongChannel,
  });
  const result2 = await page2.fetchTracks("BV1ed4b6rE5G", "43352328905", 5000);
  check(
    "R4 channel 对不上 → 用例 A 必须失败",
    result2.success === false,
    result2,
  );

  // 变异 3：hook 完全不回复（模拟钩子没注入）
  const silentHook = hookSrc.replace(
    'window.addEventListener("message", async (event) => {',
    'window.addEventListener("message", async (event) => { return;',
  );
  check("R5 变异生效（hook 不回话）", silentHook !== hookSrc);
  const page3 = makePage({
    loggedIn: true,
    tracks: [],
    hookSource: silentHook,
  });
  const result3 = await page3.fetchTracks("BV1ed4b6rE5G", "43352328905", 400);
  check(
    "R6 hook 不回话 → 必须报 hook_missing 而不是挂死",
    result3.success === false && result3.reason === "hook_missing",
    result3,
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 5. background 编排层：真源码 + mock chrome（这一层逻辑最多）
//
// 覆盖：找标签页 → 发消息 → hook_missing 时注入钩子并重试 → 选轨 →
//       字幕文件下载（SW 直连，失败退页面上下文）→ 组装 payload。
// ---------------------------------------------------------------------------
console.log("\n== background 编排层 ==");
{
  /**
   * 把 background.js 里这一组函数抠出来，在一个带 mock chrome 的沙箱里跑。
   */
  async function loadBackgroundOrchestrator(chromeMock, fetchMock) {
    const names = [
      "fetchBilibiliOfficialSubtitleViaPage",
      "findBilibiliVideoTab",
      "downloadBilibiliSubtitleFile",
      "sendToBilibiliTab",
      "sendToBilibiliTabWithTimeout",
      "buildBilibiliSubtitlePayload",
    ];
    const parts = names.map((n) => {
      // 必须带上 async 前缀 —— 这些函数体里有 await，丢了 async
      // 关键字，"await is only valid in async functions" 就来了。
      const start = bgSrc.indexOf(`function ${n}`);
      if (start < 0) throw new Error(`background.js 里找不到 ${n}`);
      const isAsync = bgSrc.slice(Math.max(0, start - 6), start) === "async ";
      let depth = 0;
      let end = -1;
      for (let i = bgSrc.indexOf("{", start); i < bgSrc.length; i++) {
        if (bgSrc[i] === "{") depth++;
        else if (bgSrc[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      const text = bgSrc.slice(start, end);
      return isAsync ? "async " + text : text;
    });
    const sandbox = {
      chrome: chromeMock,
      fetch: fetchMock,
      debugLog: () => {},
      console,
      setTimeout,
      clearTimeout,
      // sendToBilibiliTabWithTimeout 用到的硬超时常量（background.js 里是
      // 顶层 const，探针只抽函数不抽常量，必须显式喂进去）
      BILIBILI_TAB_MESSAGE_TIMEOUT_MS: 8000,
    };
    // new Function 里不能直接写 await（不是 async 函数体），所以整个
    // 拼出来的函数集包进一个 async 箭头函数再求值。
    //
    // 注意：这里必须用普通字符串拼接，不能用模板字面量 —— background 的
    // 源码里含反引号模板字符串（`https://api.bilibili.com/...`），
    // 塞进模板字面量会把代码提前截断。
    const body =
      "return (async () => {\n" +
      parts.join("\n\n") +
      "\nreturn { fetchBilibiliOfficialSubtitleViaPage, findBilibiliVideoTab, downloadBilibiliSubtitleFile, sendToBilibiliTab, sendToBilibiliTabWithTimeout, buildBilibiliSubtitlePayload };\n})();";
    const factory = new Function(...Object.keys(sandbox), body);
    return await factory(...Object.values(sandbox));
  }

  const TRACKS = [
    {
      lan: "ai-zh",
      lan_doc: "中文（自动生成）",
      subtitleUrl: "https://aisubtitle.hdslb.com/subtitle-test.json",
      isAi: true,
    },
    {
      lan: "zh-CN",
      lan_doc: "中文（中国）",
      subtitleUrl: "https://aisubtitle.hdslb.com/subtitle-cn.json",
      isAi: false,
    },
  ];

  // --- 用例 I：正常路径（页面上下文直接给轨） ---
  {
    const injected = [];
    const chromeMock = {
      tabs: {
        query: async () => [
          { id: 7, url: "https://www.bilibili.com/video/BV1ed4b6rE5G/" },
        ],
        sendMessage: async (tabId, msg) => {
          if (msg.action === "getBilibiliOfficialSubtitles") {
            return { success: true, tracks: TRACKS, needLogin: false };
          }
          return { success: true };
        },
      },
      scripting: {
        executeScript: async (opts) => {
          injected.push(opts);
          return [];
        },
      },
    };
    const fetchMock = async (url) => {
      if (String(url).includes("subtitle-cn.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ body: [{ from: 0, to: 3, content: "背景里下的字幕" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const orch = await loadBackgroundOrchestrator(chromeMock, fetchMock);
    const payload = await orch.fetchBilibiliOfficialSubtitleViaPage(
      "BV1ed4b6rE5G",
      "43352328905",
    );
    check("I1 拿到 payload", payload?.success === true, payload);
    check("I2 选了人工中文轨（不是 ai-zh）", payload?.language === "zh-CN", payload?.language);
    check("I3 正文来自 SW 下载的字幕文件", payload?.transcript?.[0]?.text === "背景里下的字幕", payload?.transcript);
    check("I4 via=page-context", payload?.via === "page-context", payload?.via);
    check("I5 没有触发钩子注入（一次就通）", injected.length === 0, injected.length);
  }

  // --- 用例 J：钩子缺失 → 注入并重试 ---
  {
    const injected = [];
    let attempts = 0;
    const chromeMock = {
      tabs: {
        query: async () => [
          { id: 7, url: "https://www.bilibili.com/video/BV1ed4b6rE5G/" },
        ],
        sendMessage: async (tabId, msg) => {
          if (msg.action === "getBilibiliOfficialSubtitles") {
            attempts++;
            // 第一发：钩子不在（模拟扩展刚重载）
            if (attempts === 1) {
              return { success: false, reason: "hook_missing", error: "钩子没有回话" };
            }
            return { success: true, tracks: TRACKS, needLogin: false };
          }
          return { success: true };
        },
      },
      scripting: {
        executeScript: async (opts) => {
          injected.push(opts);
          return [];
        },
      },
    };
    const fetchMock = async (url) => {
      if (String(url).includes("subtitle-cn.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ body: [{ from: 0, to: 3, content: "重试后拿到的" }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const orch = await loadBackgroundOrchestrator(chromeMock, fetchMock);
    const payload = await orch.fetchBilibiliOfficialSubtitleViaPage(
      "BV1ed4b6rE5G",
      "43352328905",
    );
    check("J1 重试后拿到 payload", payload?.success === true, payload);
    check("J2 注入了一次钩子", injected.length === 1, injected.length);
    check("J3 注入的是 MAIN world 的 hook 文件", injected[0]?.world === "MAIN" && (injected[0]?.files || []).includes("bilibili-subtitle-hook.js"), injected[0]);
    check("J4 正文正确", payload?.transcript?.[0]?.text === "重试后拿到的", payload?.transcript);
  }

  // --- 用例 K：页面明确说没有字幕轨 → 返回 null（正常回退，不是错误） ---
  {
    const chromeMock = {
      tabs: {
        query: async () => [
          { id: 7, url: "https://www.bilibili.com/video/BV1ed4b6rE5G/" },
        ],
        sendMessage: async () => ({
          success: false,
          reason: "no_tracks",
          error: "B 站未返回任何字幕轨。",
        }),
      },
      scripting: { executeScript: async () => [] },
    };
    const orch = await loadBackgroundOrchestrator(chromeMock, async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    const payload = await orch.fetchBilibiliOfficialSubtitleViaPage(
      "BV1ed4b6rE5G",
      "43352328905",
    );
    check("K1 no_tracks → null（不是抛错）", payload === null, payload);
  }

  // --- 用例 L：SW 下载字幕文件失败 → 退到页面上下文 ---
  {
    const chromeMock = {
      tabs: {
        query: async () => [
          { id: 7, url: "https://www.bilibili.com/video/BV1ed4b6rE5G/" },
        ],
        sendMessage: async (tabId, msg) => {
          if (msg.action === "getBilibiliOfficialSubtitles") {
            return { success: true, tracks: TRACKS, needLogin: false };
          }
          if (msg.action === "getBilibiliSubtitleFile") {
            return {
              success: true,
              body: [{ from: 0, to: 3, content: "页面下载的字幕" }],
            };
          }
          return { success: true };
        },
      },
      scripting: { executeScript: async () => [] },
    };
    const fetchMock = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const orch = await loadBackgroundOrchestrator(chromeMock, fetchMock);
    const payload = await orch.fetchBilibiliOfficialSubtitleViaPage(
      "BV1ed4b6rE5G",
      "43352328905",
    );
    check("L1 SW 403 → 页面上下文兜底拿到字幕", payload?.success === true, payload);
    check("L2 正文来自页面上下文", payload?.transcript?.[0]?.text === "页面下载的字幕", payload?.transcript);
  }

  // --- 用例 M：找不到 B 站标签页 → 抛错（上层据此退到直连） ---
  {
    const chromeMock = {
      tabs: { query: async () => [], sendMessage: async () => ({}) },
      scripting: { executeScript: async () => [] },
    };
    const orch = await loadBackgroundOrchestrator(chromeMock, async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    let threw = false;
    try {
      await orch.fetchBilibiliOfficialSubtitleViaPage("BV1ed4b6rE5G", "43352328905");
    } catch (_e) {
      threw = true;
    }
    check("M1 没有标签页 → 抛错（不是静默 null）", threw === true);
  }
}

// ---------------------------------------------------------------------------
console.log(
  `\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`,
);
process.exit(fail ? 1 : 0);
}

/** 从源码里抠出一个函数定义并变成可调用对象。 */
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`源码里找不到 ${signature}`);
  // 源文件是 CRLF，所以不能找 "\n}\n"；找 "}\r\n" 或 "}\n" 都可能，
  // 改成按大括号配平扫描，最稳。
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`抠不出 ${signature} 的函数体`);
  const text = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${text})`)();
}

main().catch((err) => {
  console.error("PROBE CRASHED:", err);
  process.exit(1);
});
