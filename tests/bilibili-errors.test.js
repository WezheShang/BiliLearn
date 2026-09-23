/**
 * Unit tests for B 站 error classification in background.js.
 *
 * 把 background.js 里和"错误分类"相关的常量 + 函数 (BILIBILI_ERROR_TYPES,
 * BILIBILI_ERROR_USER_MESSAGES, BILIBILI_ERROR_TITLES, classifyBilibiliError,
 * bilibiliErrorToException) 用文本切片的方式提出来，跑在 Node 上下文里。
 *
 * 这样不用真起一个 service worker / chrome.* shim 就能验证分类逻辑。
 *
 * 覆盖：
 *  - view.code === -101           → NOT_LOGGED_IN
 *  - view.code === -104           → PREMIERE_OR_LIMITED
 *  - view.data.videos[0].is_upower_expert === 1 → PAID_VIDEO
 *  - playurl.code === -101        → NOT_LOGGED_IN
 *  - playurl.audio=[] + view.is_upower_expert=1 → PAID_VIDEO
 *  - playurl.audio=[] 普通视频        → NETWORK_OR_UNKNOWN
 *  - CDN ERR_CONNECTION_CLOSED 4 次  → NETWORK_OR_UNKNOWN
 *
 * 跑法：`node tests/bilibili-errors.test.js`
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BG_PATH = path.join(ROOT, "background.js");

// ---------- Test framework (跟 whisper-progress.e2e.test.js 风格一致) ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEqual ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}

// ---------- 把 background.js 里的分类函数提出来 ----------
//
// background.js 顶部用了 importScripts / chrome.storage 调用，没法直接
// 在 Node 里 require。我们只取"分类"那段纯函数代码：
//   const BILIBILI_ERROR_TYPES ... }  (开头)
// 到
//   async function fetchBilibiliAudioBlob ... (下一个函数声明)
//
// 用文本切片 + eval，副作用是定义在当前 Node 上下文里的 BILIBILI_ERROR_TYPES
// / classifyBilibiliError / bilibiliErrorToException。
const bgSrc = fs.readFileSync(BG_PATH, "utf8");
const SECTION_START = "const BILIBILI_ERROR_TYPES";
const SECTION_END = "async function fetchBilibiliAudioBlob";
const startIdx = bgSrc.indexOf(SECTION_START);
const endIdx = bgSrc.indexOf(SECTION_END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  throw new Error(
    `无法在 background.js 里定位分类函数段 (startIdx=${startIdx}, endIdx=${endIdx})。` +
      `是不是 background.js 里的 BILIBILI_ERROR_TYPES / fetchBilibiliAudioBlob 改名了？`,
  );
}
const section = bgSrc.slice(startIdx, endIdx);
// eslint-disable-next-line no-eval
eval(section);

// ---------- 测试用例 ----------

function expectType(label, classified, expectedType) {
  assertEqual(classified.type, expectedType, `${label} → type`);
  assertTrue(
    typeof classified.title === "string" && classified.title.length > 0,
    `${label} → title 非空`,
  );
  assertTrue(
    typeof classified.userMessage === "string" &&
      classified.userMessage.length > 0,
    `${label} → userMessage 非空`,
  );
  assertTrue(
    typeof classified.source === "string",
    `${label} → source 字段存在`,
  );
}

function testViewCodeNotLoggedIn() {
  console.log("\n[1/7] view.code === -101 → NOT_LOGGED_IN");
  const view = { code: -101, message: "未登录" };
  const r = classifyBilibiliError({ view: view });
  expectType("view.code=-101", r, "NOT_LOGGED_IN");
  assertEqual(r.source, "view.code", "source=view.code");
  assertTrue(
    r.userMessage.includes("登录") || r.userMessage.includes("cookie"),
    "userMessage 提到登录/cookie",
  );
  record("1 view.code=-101 → NOT_LOGGED_IN", true);
}

function testViewCodePremiere() {
  console.log("\n[2/7] view.code === -104 → PREMIERE_OR_LIMITED");
  const view = { code: -104, message: "大会员" };
  const r = classifyBilibiliError({ view: view });
  expectType("view.code=-104", r, "PREMIERE_OR_LIMITED");
  assertEqual(r.source, "view.code", "source=view.code");
  assertTrue(
    r.userMessage.includes("大会员") || r.userMessage.includes("购买"),
    "userMessage 提到大会员/购买",
  );
  record("2 view.code=-104 → PREMIERE_OR_LIMITED", true);
}

function testViewPaidFlag() {
  console.log("\n[3/7] view.data.videos[0].is_upower_expert === 1 → PAID_VIDEO");
  const view = {
    code: 0,
    data: {
      bvid: "BV1test",
      title: "付费视频",
      videos: [{ aid: 1, bvid: "BV1test", is_upower_expert: 1 }],
      pages: [{ cid: 1, part: "1" }],
    },
  };
  const r = classifyBilibiliError({ view: view });
  expectType("view.is_upower_expert=1", r, "PAID_VIDEO");
  assertEqual(r.source, "view.paid_flag", "source=view.paid_flag");
  assertTrue(
    r.userMessage.includes("付费") || r.userMessage.includes("充电"),
    "userMessage 提到付费/充电",
  );
  // 也覆盖 is_ugc_pay 和 is_cooperation
  const v2 = classifyBilibiliError({
    view: {
      code: 0,
      data: { videos: [{ is_ugc_pay: 1 }] },
    },
  });
  expectType("is_ugc_pay=1", v2, "PAID_VIDEO");
  const v3 = classifyBilibiliError({
    view: {
      code: 0,
      data: { videos: [{ is_cooperation: 1 }] },
    },
  });
  expectType("is_cooperation=1", v3, "PAID_VIDEO");
  record("3 view paid flags → PAID_VIDEO (3 个标记都覆盖)", true);
}

function testPlayurlCodeNotLoggedIn() {
  console.log("\n[4/7] playurl.code === -101 → NOT_LOGGED_IN");
  const playurl = { code: -101, message: "未登录" };
  const r = classifyBilibiliError({ playurlPayload: playurl });
  expectType("playurl.code=-101", r, "NOT_LOGGED_IN");
  assertEqual(r.source, "playurl.code", "source=playurl.code");
  record("4 playurl.code=-101 → NOT_LOGGED_IN", true);
}

function testPlayurlNoAudioPaid() {
  console.log("\n[5/7] playurl.data.dash.audio=[] 且 view.is_upower_expert=1 → PAID_VIDEO");
  // 注意：view.is_upower_expert=1 会在 "view.paid_flag" 阶段就 catch，
  // source 字段是诊断信息，我们这里只断言 type。
  const view = {
    code: 0,
    data: { videos: [{ is_upower_expert: 1 }] },
  };
  const playurl = {
    code: 0,
    data: { dash: { audio: [], video: [{ id: 80 }] } },
  };
  const r = classifyBilibiliError({ view: view, playurlPayload: playurl });
  expectType("audio=[] + paid", r, "PAID_VIDEO");
  assertTrue(
    r.source === "view.paid_flag" || r.source === "playurl.no_audio",
    `source 是 view.paid_flag 或 playurl.no_audio 之一 (实际: ${r.source})`,
  );
  // 单独跑 playurl.no_audio 路径：view 没有付费标记但 audio 仍空 → 默认 NETWORK_OR_UNKNOWN
  const view2 = {
    code: 0,
    data: { videos: [{ is_upower_expert: 0 }] },
  };
  const r2 = classifyBilibiliError({
    view: view2,
    playurlPayload: playurl,
    rawMessage: "无法获取B站音轨地址。",
  });
  expectType("audio=[] view 无付费标记", r2, "NETWORK_OR_UNKNOWN");
  // 但如果手动传入 view.is_upower_expert=1 但 view.code 已经被前面处理过，
  // 模拟 "只检查 playurl.no_audio 分支" 的内部调用：让 view.code=0
  // 但 view.videos[0].is_upower_expert 单独满足条件 —— 这种情况实际不会
  // 发生（上面 view.paid_flag 会先 catch），但要保证分类器自身的逻辑
  // 不会出错。
  record("5 playurl no audio + paid → PAID_VIDEO", true);
}

function testPlayurlNoAudioFree() {
  console.log("\n[6/7] playurl.data.dash.audio=[] 普通视频 → NETWORK_OR_UNKNOWN");
  const view = {
    code: 0,
    data: { videos: [{ is_upower_expert: 0, is_ugc_pay: 0 }] },
  };
  const playurl = {
    code: 0,
    data: { dash: { audio: [] } },
  };
  const r = classifyBilibiliError({
    view: view,
    playurlPayload: playurl,
    rawMessage: "无法获取B站音轨地址。",
  });
  expectType("audio=[] 普通", r, "NETWORK_OR_UNKNOWN");
  assertEqual(r.title, "Whisper 转录失败", "title=Whisper 转录失败");
  assertTrue(
    r.userMessage.includes("无法获取B站音轨地址"),
    "userMessage 包含原始 message",
  );
  record("6 playurl no audio 普通 → NETWORK_OR_UNKNOWN", true);
}

function testCdnConnectionClosed4x() {
  console.log("\n[7/7] CDN ERR_CONNECTION_CLOSED 4 次 → NETWORK_OR_UNKNOWN");
  // 模拟 fetchBilibiliAudioBlob 跑完所有 candidate + 所有 retry 后
  // 调 classifyBilibiliError 的场景。rawMessage 来自最后一次 attempt。
  const view = {
    code: 0,
    data: { videos: [{ is_upower_expert: 0 }] },
  };
  const playurl = {
    code: 0,
    data: {
      dash: {
        audio: [
          { id: 30280, baseUrl: "https://cn-hbcd2-cu-v4.bilivideo.com/audio1", bandwidth: 128000 },
        ],
      },
    },
  };
  // 假装 4 次都失败，最后一次是 ERR_CONNECTION_CLOSED
  const lastErrorMessage = "TypeError: Failed to fetch (ERR_CONNECTION_CLOSED)";
  const r = classifyBilibiliError({
    view: view,
    playurlPayload: playurl,
    rawMessage: lastErrorMessage,
  });
  expectType("4x ERR_CONNECTION_CLOSED", r, "NETWORK_OR_UNKNOWN");
  assertEqual(r.title, "Whisper 转录失败", "title=Whisper 转录失败");
  assertTrue(
    r.userMessage.includes(lastErrorMessage),
    "userMessage 透传原始 message",
  );
  assertEqual(r.source, "audio_download", "source=audio_download");
  // 没有 view/playurl 上下文也应该是 NETWORK_OR_UNKNOWN
  const r2 = classifyBilibiliError({ rawMessage: lastErrorMessage });
  expectType("无 view/playurl 兜底", r2, "NETWORK_OR_UNKNOWN");
  record("7 CDN 4x retry 失败 → NETWORK_OR_UNKNOWN", true);
}

// ---------- 跑起来 ----------
async function main() {
  try {
    testViewCodeNotLoggedIn();
    testViewCodePremiere();
    testViewPaidFlag();
    testPlayurlCodeNotLoggedIn();
    testPlayurlNoAudioPaid();
    testPlayurlNoAudioFree();
    testCdnConnectionClosed4x();
  } catch (err) {
    console.error("\n[FAIL] test threw:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n========== ${results.length - failed.length}/${results.length} checks passed ==========`,
  );
  if (failed.length) {
    console.error("Failed checks:");
    for (const f of failed) console.error("  -", f.name, f.detail);
    process.exit(1);
  }
}

main();
