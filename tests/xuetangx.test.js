/**
 * Unit tests for 学堂在线 (xuetangx.com) support.
 *
 * 覆盖三块：
 *   1. xuetangx-hook.js（主世界钩子）—— 拦截页面自己的 fetch，把
 *      leaf_info / s_t_c / s_t_g_p 的响应抓下来。
 *   2. background.js 的字幕解析 —— 把学堂在线的字幕文件（JSON
 *      subtitle_list 或 SRT）归一成 {start, duration, text}。
 *   3. 站点识别 —— detectVideoSource / extractVideoId 能认出
 *      xt-{cid}-{leafId} 和 xuetangx.com 的课程页 URL。
 *
 * Run: `node tests/xuetangx.test.js`
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

// ---------- minimal test framework ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
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
function assertMatch(actual, re, label) {
  if (!re.test(String(actual))) {
    throw new Error(`assertMatch ${label}: ${actual} !~ ${re}`);
  }
}

/** 跑一个用例，成功记 PASS，失败记 FAIL（不中断后面的用例）。 */
function test(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

// ---------- extract a named function from a source file ----------
//
// The extension files are not modules (they reference chrome.*, window.*,
// DOM globals), so we can't require() them. We slice out the functions we
// care about and eval them in a controlled scope.
function extractFunction(source, fnName) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const m = startRe.exec(source);
  if (!m) throw new Error(`Could not find function ${fnName}`);
  let i = source.indexOf("(", m.index);
  let depthP = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") depthP++;
    else if (ch === ")") {
      depthP--;
      if (depthP === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  while (i < source.length && source[i] !== "{") i++;
  const bodyStart = i;
  let depth = 0;
  let inString = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inRegex = false;
  let inCharClass = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") escape = true;
      else if (ch === "[") inCharClass = true;
      else if (ch === "]" && inCharClass) inCharClass = false;
      else if (ch === "/" && !inCharClass) inRegex = false;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "/") {
      // regex literal vs division — look BACK past whitespace to the last
      // significant character: a regex can start right after an operator
      // even when there's a newline + indent in between.
      let j = i - 1;
      while (j >= 0 && /\s/.test(source[j])) j--;
      const prev = j >= 0 ? source[j] : "";
      if (!prev || /[({[,;:=!&|?+\-*%~<>]/.test(prev)) {
        inRegex = true;
        inCharClass = false;
        i++;
        continue;
      }
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  return source.slice(m.index, i);
}

const backgroundSource = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const sidepanelSource = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
const hookSource = fs.readFileSync(path.join(ROOT, "xuetangx-hook.js"), "utf8");
const contentSource = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

// ===========================================================================
// 1. background.js — 字幕解析 / 时间解析 / 站点识别
// ===========================================================================
// 与 background.js 里的 YT_ID_RE 保持一致（detectVideoSource 依赖它）
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const bgScope = {};
const bgFns = [
  ["detectVideoSource", ["YT_ID_RE"]],
  ["xuetangxTimeToSeconds", []],
  ["xuetangxRowFromEntry", ["xuetangxTimeToSeconds"]],
  ["deepFindXuetangxSubtitleRows", ["xuetangxRowFromEntry"]],
  ["parseXuetangxSubtitlePayload", ["xuetangxTimeToSeconds", "deepFindXuetangxSubtitleRows"]],
  ["pickXuetangxOfficialChapters", []],
];
for (const [name, deps] of bgFns) {
  // NOTE: 源码里可能含反引号（模板字符串），所以用普通字符串拼接，
  // 不能写成 eval(`...`) —— 那样会被里面的反引号截断。
  // 依赖通过 new Function 的形参注入（eval 出来的函数看不到对象属性）。
  const factory = new Function(
    ...deps,
    "return (" + extractFunction(backgroundSource, name) + ")",
  );
  bgScope[name] = factory(
    ...deps.map((dep) => (dep === "YT_ID_RE" ? YT_ID_RE : bgScope[dep])),
  );
}

console.log("\n[1] background.js —— 站点识别");
test("detectVideoSource 认出学堂在线", () => {
  const d = bgScope.detectVideoSource;
  assertEqual(d("xt-31377125-6195112"), "xuetangx", "xt id → xuetangx");
  assertEqual(
    d("https://www.xuetangx.com/course/THU08261000810/31377125"),
    "xuetangx",
    "xuetangx url → xuetangx",
  );
  assertEqual(d("https://www.youtube.com/watch?v=abcdefghijk"), "youtube", "youtube 不受影响");
  assertEqual(d("BV1xx411c7mD"), "bilibili", "B站 不受影响");
  assertEqual(d(""), null, "空串 → null");
});

test("detectVideoSource 认得带 @pN 后缀的 id（2026-10-27 回归）", () => {
  const d = bgScope.detectVideoSource;
  // 没有这条， "xt-31335364-84818568@p1" 会认不出来 → 掉进 B 站分支 →
  // 报出 "Invalid Bilibili BV ID."。
  assertEqual(d("xt-31335364-84818568@p1"), "xuetangx", "xt id + @p1");
  assertEqual(d("BV1xx411c7mD@p3"), "bilibili", "B站 id + @p3");
  assertEqual(d("abcdefghijk@p1"), "youtube", "YouTube id + @p1");
});

// 2026-10-27: 侧边栏 / 后台的构建指纹必须一致。不一致时侧边栏会提示
// "扩展需要重新加载" —— 这是本次 "Invalid Bilibili BV ID." 的根治手段
// （后台 SW 跑旧代码，侧边栏跑新代码）。改了一边忘了另一边，这里会挂。
test("background.js 的 BG_BUILD 与 sidepanel.js 的 SP_BUILD 一致", () => {
  const bg = /const\s+BG_BUILD\s*=\s*"([^"]+)"/.exec(backgroundSource);
  const sp = /const\s+SP_BUILD\s*=\s*"([^"]+)"/.exec(sidepanelSource);
  assertTrue(!!bg, "background.js 里能找到 BG_BUILD");
  assertTrue(!!sp, "sidepanel.js 里能找到 SP_BUILD");
  assertEqual(sp[1], bg[1], "两边版本号一致");
  // 握手 action 两边都得有：后台不认它就答不上来，侧边栏不认它就不问。
  assertTrue(
    backgroundSource.includes('"getExtensionBuild"'),
    "background.js 处理 getExtensionBuild",
  );
  assertTrue(
    sidepanelSource.includes('"getExtensionBuild"'),
    "sidepanel.js 发送 getExtensionBuild",
  );
});

// 2026-10-27: 钩子 / 内容脚本 / 后台三处的版本号必须一致 ——
// 后台靠它判断"页面里跑的是不是旧钩子"，对不上就会拿一份半新半旧的
// 状态继续排查（踩过）。改了一边忘了另一边，这里直接挂。
test("钩子 / 内容脚本 / 后台的钩子版本号一致", () => {
  const hook = /const\s+HOOK_VERSION\s*=\s*(\d+)/.exec(hookSource);
  const content = /const\s+XUETANGX_HOOK_VERSION\s*=\s*(\d+)/.exec(contentSource);
  const bg = /const\s+XUETANGX_HOOK_VERSION\s*=\s*(\d+)/.exec(backgroundSource);
  assertTrue(!!hook, "xuetangx-hook.js 里能找到 HOOK_VERSION");
  assertTrue(!!content, "content.js 里能找到 XUETANGX_HOOK_VERSION");
  assertTrue(!!bg, "background.js 里能找到 XUETANGX_HOOK_VERSION");
  assertEqual(content[1], hook[1], "内容脚本与钩子一致");
  assertEqual(bg[1], hook[1], "后台与钩子一致");
});

console.log("\n[2] background.js —— 时间解析");
test("xuetangxTimeToSeconds 解析各种时间串", () => {
  const t = bgScope.xuetangxTimeToSeconds;
  assertEqual(t("00:01:30"), 90, "hh:mm:ss");
  assertEqual(t("01:30"), 90, "mm:ss");
  assertEqual(t("12.5"), 12.5, "纯秒数");
  assertEqual(t(45), 45, "数字");
  assertEqual(t(""), 0, "空串");
  assertEqual(t("00:00:07.500"), 7.5, "带毫秒(点)");
  assertEqual(t("00:00:07,500"), 7.5, "带毫秒(逗号，SRT)");
});

console.log("\n[3] background.js —— 字幕文件归一化");
test("parseXuetangxSubtitlePayload 解析 JSON / SRT", () => {
  const parse = bgScope.parseXuetangxSubtitlePayload;

  const jsonRows = parse({
    subtitle_list: [
      { start: "00:00:00", end: "00:00:05", content: "第一句" },
      { start: "00:00:05", end: "00:00:11", content: "第二句" },
    ],
  });
  assertEqual(jsonRows.length, 2, "JSON 字幕条数");
  assertEqual(jsonRows[0].text, "第一句", "JSON 文本");
  assertEqual(jsonRows[0].start, 0, "JSON 起始");
  assertEqual(jsonRows[0].duration, 5, "JSON 时长");
  assertEqual(jsonRows[1].start, 5, "JSON 第二条起始");
  assertEqual(jsonRows[1].duration, 6, "JSON 第二条时长");

  const srtRows = parse(
    [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "hello world",
      "",
      "2",
      "00:00:04,000 --> 00:00:07,500",
      "second line",
      "",
    ].join("\n"),
  );
  assertEqual(srtRows.length, 2, "SRT 条数");
  assertEqual(srtRows[0].text, "hello world", "SRT 文本");
  assertEqual(srtRows[0].start, 1, "SRT 起始");
  assertEqual(srtRows[1].duration, 3.5, "SRT 时长");

  assertEqual(parse(null).length, 0, "null → 空");
  assertEqual(parse("").length, 0, "空串 → 空");
});

test("parseXuetangxSubtitlePayload 认得没见过的字段名（2026-10-27 深搜兜底）", () => {
  const parse = bgScope.parseXuetangxSubtitlePayload;
  // 字段名不是 subtitle_list / data 时，靠深搜整棵 JSON 树找字幕数组
  const odd = parse({
    subtitles: [{ startTime: 1, endTime: 4, text: "甲" }],
  });
  assertEqual(odd.length, 1, "深搜兜底条数");
  assertEqual(odd[0].text, "甲", "深搜兜底文本");
  assertEqual(odd[0].start, 1, "深搜兜底起始");
  assertEqual(odd[0].duration, 3, "深搜兜底时长");

  // 嵌套一层也要能挖出来
  const nested = parse({ payload: { result: { caption_list: [{ from: 2, to: 5, content: "乙" }] } } });
  assertEqual(nested.length, 1, "嵌套深搜条数");
  assertEqual(nested[0].text, "乙", "嵌套深搜文本");

  // 但 s_t_g_p 的响应（data 是一堆字幕文件描述）不能被误认成字幕条目
  const notSubs = parse({
    data: [{ lang: 0, name: "简体中文", data: "https://cdn.xuetangx.com/sub_zh.json" }],
  });
  assertEqual(notSubs.length, 0, "字幕文件列表不该被当成字幕条目");
});

// ===========================================================================
// 4. sidepanel.js —— extractVideoId 认学堂在线
// ===========================================================================
const spScope = {};
spScope.extractVideoId = eval(
  "(" + extractFunction(sidepanelSource, "extractVideoId") + ")",
);
spScope.isXuetangxVideoId = eval(
  "(" + extractFunction(sidepanelSource, "isXuetangxVideoId") + ")",
);
spScope.formatGuideSeconds = eval(
  "(" + extractFunction(sidepanelSource, "formatGuideSeconds") + ")",
);
spScope.overviewRequiresAiKey = eval(
  "(" + extractFunction(sidepanelSource, "overviewRequiresAiKey") + ")",
);

console.log("\n[4] sidepanel.js —— extractVideoId");
test("extractVideoId 认出学堂在线课程页", () => {
  const e = spScope.extractVideoId;
  assertEqual(
    e("https://www.xuetangx.com/learn/space/ecut04021005032intl/ecut04021005032intl/31335364/video/84818568?channel=i.area.course_list_all"),
    "xt-31335364-84818568@p1",
    "学习页（/learn/space/.../video/{leaf}）",
  );
  assertEqual(
    e("https://www.xuetangx.com/learn/space/ecut04021005032intl/ecut04021005032intl/31335364/video/84818568"),
    "xt-31335364-84818568@p1",
    "学习页（不带 channel 参数）",
  );
  assertEqual(
    e("https://www.xuetangx.com/course/THU08261000810/31377125?leaf_id=6195112"),
    "xt-31377125-6195112@p1",
    "带 leaf_id 的课程页",
  );
  assertEqual(
    e("https://www.xuetangx.com/course/THU08261000810/31377125"),
    null,
    "没有 leaf_id → null（交给内容脚本补）",
  );
  assertEqual(
    e("https://www.bilibili.com/video/BV1xx411c7mD?p=3"),
    "BV1xx411c7mD@p3",
    "B站 不受影响",
  );
  assertEqual(
    e("https://www.youtube.com/watch?v=abcdefghijk"),
    "abcdefghijk@p1",
    "YouTube 不受影响",
  );
});

test("sidepanel 的学堂在线小工具", () => {
  assertEqual(spScope.isXuetangxVideoId("xt-31335364-84818568"), true, "xt id");
  assertEqual(spScope.isXuetangxVideoId("xt-31335364-84818568@p1"), true, "xt id 带 @p");
  assertEqual(spScope.isXuetangxVideoId("BV1xx411c7mD"), false, "B站 不是");
  assertEqual(spScope.isXuetangxVideoId(""), false, "空串不是");
  assertEqual(spScope.formatGuideSeconds(0), "0:00", "0 秒");
  assertEqual(spScope.formatGuideSeconds(65), "1:05", "65 秒");
  assertEqual(spScope.formatGuideSeconds(3600), "60:00", "3600 秒");
});

// 2026-10-27: 官方章节这条路**不需要 AI key** —— 章节是课程方给的。
// 没配 key 的用户也必须能看到官方章节，不能被"配置AI"的引导挡住。
test("overviewRequiresAiKey：官方章节 / 学堂在线都不需要 AI key", () => {
  const req = spScope.overviewRequiresAiKey;
  assertEqual(
    req({ hasOfficialChapters: true, isXuetangx: true, aiKeyMissing: true }),
    false,
    "有官方章节 → 不需要 key",
  );
  assertEqual(
    req({ hasOfficialChapters: false, isXuetangx: true, aiKeyMissing: true }),
    false,
    "学堂在线还没查章节 → 先试官方章节，不需要 key",
  );
  assertEqual(
    req({ hasOfficialChapters: false, isXuetangx: false, aiKeyMissing: true }),
    true,
    "其它站点且没 key → 需要 key",
  );
  assertEqual(
    req({ hasOfficialChapters: false, isXuetangx: false, aiKeyMissing: false }),
    false,
    "其它站点但有 key → 不需要",
  );
});

console.log("\n[3b] background.js —— B 站没有字幕时必须还有出路");
test("B站官方字幕读取失败不再中断整条链路（2026-10-27 回归）", () => {
  const src = backgroundSource;
  // 1) 官方字幕的调用必须在 try/catch 里 —— 以前是裸 await，
  //    接口一报错整个 fetchTranscript 就跳进 catch，用户既拿不到字幕，
  //    也看不到「🎙️ 用 Whisper 转录」那条出路（死路）。
  const callIdx = src.indexOf(
    "await fetchBilibiliOfficialSubtitle(videoId, page.cid)",
  );
  assertTrue(callIdx > 0, "找得到官方字幕的调用点");
  const before = src.slice(Math.max(0, callIdx - 500), callIdx);
  assertTrue(/try\s*\{/.test(before), "调用点在 try 块里");
  assertTrue(
    src.includes("bilibili official subtitle lookup failed"),
    "读取失败有专门的日志",
  );
  // 2) 失败原因要一路带到 WHISPER_NEEDED 的返回里（让用户看得见）
  assertTrue(
    /error:\s*"WHISPER_NEEDED"[\s\S]{0,500}subtitleLookupError/.test(src),
    "WHISPER_NEEDED 里带了失败原因",
  );
  // 3) Whisper 提示页要把次要按钮清掉 —— 学堂在线那个
  //    「再试一次官方字幕」不能串到 B 站页面
  assertTrue(
    /function actuallyShowWhisperPrompt\([\s\S]{0,900}errorBtnSecondary[\s\S]{0,400}display = "none"/.test(
      sidepanelSource,
    ),
    "Whisper 提示页会清掉次要按钮",
  );
});

console.log("\n[3c] background.js / sidepanel.js —— 取字幕整条链路不许变成死路");
test("后台最外层 catch：B 站出错也要给出 Whisper 出路（2026-10-27 回归）", () => {
  const src = backgroundSource;
  const catchIdx = src.indexOf("Transcript fetch error:");
  assertTrue(catchIdx > 0, "找得到最外层 catch");
  const seg = src.slice(catchIdx, catchIdx + 1500);
  assertTrue(/source === "bilibili"/.test(seg), "最外层 catch 判断了来源");
  assertTrue(
    /error:\s*"WHISPER_NEEDED"/.test(seg),
    "B 站出错时回 WHISPER_NEEDED（不能只回一句 error）",
  );
  assertTrue(
    /subtitleLookupError/.test(seg),
    "出错原因要带到回包里（页面上要看得见）",
  );
});

test("侧边栏：sendMessage 抛错 / 空回包都不许死转圈（2026-10-27 回归）", () => {
  const src = sidepanelSource;
  const callIdx = src.indexOf('action: "fetchTranscript"');
  assertTrue(callIdx > 0, "找得到 fetchTranscript 的调用点");
  const before = src.slice(Math.max(0, callIdx - 400), callIdx);
  assertTrue(/try\s*\{/.test(before), "sendMessage 被 try 包住");
  assertTrue(
    /!transcriptResult \|\| typeof transcriptResult !== "object"/.test(src),
    "空回包有专门处理",
  );
  const reasonIdx = src.indexOf("后台没有响应");
  assertTrue(reasonIdx > 0, "找得到失败分支");
  assertTrue(
    /showWhisperPrompt\(/.test(
      src.slice(Math.max(0, reasonIdx - 1500), reasonIdx + 1500),
    ),
    "失败分支给出 Whisper 出路",
  );
  assertTrue(
    src.includes("后台没有返回结果"),
    "空回包也有中文提示",
  );
  assertTrue(
    /FETCH_TIMEOUT_MS/.test(src) && /Promise\.race/.test(src),
    "取字幕有超时兜底（后台不回来也不能永远转圈）",
  );
});

test("pickXuetangxOfficialChapters：官方章节归一成 AI 概览同款形状", () => {  const pick = bgScope.pickXuetangxOfficialChapters;
  const chapters = pick({
    leafKnowledge: [
      {
        title: "太极拳：起源、理念与全球影响",
        body: "太极源于《易传》，寓意宇宙万物本质",
        start: 21.2,
        end: 378.76,
      },
      {
        title: "太极拳的起源和发展",
        body: "起源众说纷纭",
        start: 379.42,
        end: 529.52,
      },
      // 脏数据：没有标题 → 丢掉
      { title: "", body: "孤儿", start: 600 },
    ],
  });
  assertEqual(chapters.length, 2, "有效章节数");
  assertEqual(chapters[0].title, "太极拳：起源、理念与全球影响", "标题");
  assertEqual(chapters[0].summary, "太极源于《易传》，寓意宇宙万物本质", "概要");
  assertEqual(chapters[0].timestampSeconds, 21, "起始秒（取整）");
  assertEqual(chapters[0].timestamp, "0:21", "时间戳格式跟 AI 生成的一致");
  assertEqual(chapters[1].timestamp, "6:19", "第二个章节时间戳");
  assertEqual(chapters[0].endSeconds, 378, "结束秒");
  assertEqual(pick({ leafKnowledge: [] }).length, 0, "没有章节 → 空数组");
  assertEqual(pick(null).length, 0, "没有状态 → 空数组");
});

// ===========================================================================
// 4b. xuetangx-hook.js —— 讲稿 / 章节的解析（2026-10-27 真机接口）
//
// 真机上翻出来的两个接口（都在 /c27/ 下，GET、不需要 CSRF、页面同源）：
//   GET /c27/online_courseware/leaf_lecture_note/{leafId}/
//     → [{formalParagraphText, startTime, endTime, ...}]  时间戳是**毫秒**
//   GET /c27/online_courseware/leaf_knowledge/{leafId}/
//     → [{headline, summary, startTime, endTime, ...}]
// 官方字幕（s_t_g_p）那条线一直读不出来，这两个是更靠谱的来源。
// ===========================================================================
const hookScope = { state: { duration: 888 } };
{
  const hookFns = [
    ["xtPickDivisor", []],
    ["xtRowsToSeconds", ["xtPickDivisor"]],
    ["pickLectureText", []],
    ["parseLectureNote", ["pickLectureText", "xtRowsToSeconds"]],
    ["parseLeafKnowledge", ["xtRowsToSeconds"]],
  ];
  for (const [name, deps] of hookFns) {
    const factory = new Function(
      ...deps,
      "state",
      "return (" + extractFunction(hookSource, name) + ")",
    );
    hookScope[name] = factory(
      ...deps.map((dep) => hookScope[dep]),
      hookScope.state,
    );
  }
}

// ===========================================================================
// 4c. sidepanel.js —— 官方章节渲染成「AI 概览同款」格式
//
// 用户要求：概览的时间线输出格式要和直接从 AI 生成的那种一样。
// 这里用 jsdom 把 renderOfficialChapters 跑一遍，断言产出的 DOM 结构
// 跟 renderAnalysisResults（AI 那条路）完全一致。
// ===========================================================================
console.log("\n[4c] sidepanel.js —— 官方章节渲染");
{
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="section"><ul class="chapter-list" id="chapterList"></ul></div>
      <div class="section"><div id="quotesList"></div></div>
    </body></html>`,
    { url: "https://www.xuetangx.com/", runScripts: "dangerously" },
  );
  const win = dom.window;
  // 侧边栏里那几个依赖：escapeHtml / formatGuideSeconds / seekTo / debugLog
  win.escapeHtml = (text) =>
    String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  win.formatGuideSeconds = spScope.formatGuideSeconds;
  win.seekTo = () => {};
  win.debugLog = () => {};
  win.eval(
    extractFunction(sidepanelSource, "renderOfficialChapters") +
      "\nwindow.__renderOfficialChapters = renderOfficialChapters;",
  );
  const chapters = bgScope.pickXuetangxOfficialChapters({
    leafKnowledge: [
      {
        title: "太极拳：起源、理念与全球影响",
        body: "太极源于《易传》",
        start: 21.2,
        end: 378.76,
      },
      {
        title: "太极拳的起源和发展",
        body: "起源众说纷纭",
        start: 379.42,
        end: 529.52,
      },
    ],
  });

  test("官方章节渲染成 chapter-item（跟 AI 概览同款结构）", () => {
    const count = win.__renderOfficialChapters(chapters);
    assertEqual(count, 2, "渲染了 2 个章节");
    const items = win.document.querySelectorAll("#chapterList .chapter-item");
    assertEqual(items.length, 2, "chapter-item 数量");
    // 结构跟 renderAnalysisResults 一模一样
    assertTrue(
      !!items[0].querySelector(".chapter-timestamp"),
      "有时间戳元素",
    );
    assertTrue(!!items[0].querySelector(".chapter-content"), "有内容容器");
    assertTrue(!!items[0].querySelector(".chapter-title"), "有标题元素");
    assertTrue(!!items[0].querySelector(".chapter-summary"), "有概要元素");
    assertEqual(
      items[0].querySelector(".chapter-timestamp").textContent,
      "0:21",
      "时间戳格式与 AI 生成的一致（M:SS）",
    );
    assertEqual(
      items[0].querySelector(".chapter-title").textContent,
      "太极拳：起源、理念与全球影响",
      "章节标题",
    );
    assertEqual(
      items[0].querySelector(".chapter-summary").textContent,
      "太极源于《易传》",
      "章节概要",
    );
    assertEqual(items[0].dataset.seconds, "21", "点击跳转用的秒数");
    assertEqual(
      items[1].querySelector(".chapter-timestamp").textContent,
      "6:19",
      "第二个章节时间戳",
    );
  });

  test("概览页不再有「知识导引」这一节（那个 content 列表已经去掉）", () => {
    const html = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
    assertTrue(
      !html.includes("knowledgeGuideSection"),
      "HTML 里没有知识导引 section",
    );
    assertTrue(
      !html.includes("knowledgeGuideList"),
      "HTML 里没有知识导引列表容器",
    );
    assertTrue(
      !/kg-note|kg-list|kg-item|kg-title|kg-time|kg-body/.test(
        fs.readFileSync(path.join(ROOT, "sidepanel.css"), "utf8"),
      ),
      "CSS 里没有知识导引样式",
    );
  });
}

console.log("\n[4b] xuetangx-hook.js —— 讲稿 / 章节解析");test("parseLectureNote 把毫秒时间戳换成秒", () => {
  const rows = hookScope.parseLectureNote({
    msg: "",
    success: true,
    data: [
      {
        formalParagraphText: "同学们好，今天我们的教学内容是太极拳的概述",
        id: "8045034",
        startTime: 21200,
        endTime: 38120,
      },
      {
        formalParagraphText: "太极一词最早出自易传",
        id: "8045035",
        startTime: 38360,
        endTime: 58920,
      },
    ],
  });
  assertEqual(rows.length, 2, "讲稿段数");
  assertEqual(rows[0].start, 21.2, "第一段起点（毫秒→秒）");
  assertEqual(rows[0].end, 38.12, "第一段终点");
  assertEqual(rows[1].start, 38.36, "第二段起点");
  assertEqual(
    rows[0].content,
    "同学们好，今天我们的教学内容是太极拳的概述",
    "讲稿正文",
  );
  assertEqual(hookScope.parseLectureNote(null).length, 0, "null → 空");
});

test("xtPickDivisor：接口用秒的时候不能照除 1000", () => {
  const pick = hookScope.xtPickDivisor;
  // 真机数据：视频 888 秒，最大时间戳 879780 毫秒 → 按毫秒换算
  assertEqual(pick(879780, 888), 1000, "毫秒口径");
  // 万一某个课返回的是秒（最大 880），就不能除 1000
  assertEqual(pick(880, 888), 1, "秒口径");
  // 不知道视频总长 → 相信接口契约（毫秒）
  assertEqual(pick(879780, 0), 1000, "无总长时按毫秒");
});

test("parseLeafKnowledge 取出标题 / 概要 / 时间区间", () => {
  const rows = hookScope.parseLeafKnowledge({
    msg: "",
    success: true,
    data: [
      {
        headline: "太极拳：起源、理念与全球影响",
        summary: "太极源于《易传》，寓意宇宙万物本质",
        startTime: 21200,
        endTime: 378760,
        chapterId: 1,
      },
      {
        headline: "太极拳的起源和发展",
        summary: "太极拳的起源众说纷纭",
        startTime: 379420,
        endTime: 529520,
        chapterId: 2,
      },
    ],
  });
  assertEqual(rows.length, 2, "章节数");
  assertEqual(rows[0].title, "太极拳：起源、理念与全球影响", "章节标题");
  assertEqual(rows[0].body, "太极源于《易传》，寓意宇宙万物本质", "章节概要");
  assertEqual(rows[0].start, 21.2, "章节起点（毫秒→秒）");
  assertEqual(rows[0].end, 378.76, "章节终点");
  assertEqual(rows[1].title, "太极拳的起源和发展", "第二个章节标题");
});

// ===========================================================================
// 5. xuetangx-hook.js —— 主世界钩子真的能抓到页面接口
// ===========================================================================
console.log("\n[5] xuetangx-hook.js —— 页面接口捕获");
{
  const dom = new JSDOM(
    "<!doctype html><html><body><video class='xt_video_player'></video></body></html>",
    {
      url: "https://www.xuetangx.com/course/THU08261000810/31377125",
      runScripts: "dangerously",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;

  const messages = [];
  window.addEventListener("message", (event) => {
    if (event.data && event.data.source === "bililearn-xuetangx") {
      messages.push(event.data);
    }
  });

  // 假的 fetch —— 模拟学堂在线自己的几个请求
  // 2026-10-27: ccid 按小节区分（ccid 是小节级的），这样才能验证
  // "换小节之后拿到的是新小节的字幕地址，而不是上一节的"。
  const leafInfoResponse = (leafId, title) => ({
    success: true,
    data: {
      id: Number(leafId),
      name: title,
      content_info: {
        media: {
          ccid: `ccid-${leafId}`,
          poster: "https://qn-c27.xuetangx.com/poster.jpeg",
        },
      },
    },
  });

  const resolveResponse = (url, init) => {
    if (url.includes("/api/v1/lms/learn/leaf_info/")) {
      const m = /leaf_info\/(\d+)\/(\d+)/.exec(url);
      return leafInfoResponse(m[2], m[2] === "6195112" ? "第一节 信号与系统" : "第二节 信号的描述");
    }
    if (url.includes("/api/v1/lms/service/s_t_c/")) {
      return { success: true, data: { d_l: 0, a_d: true } };
    }
    if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
      let ccid = "";
      try {
        ccid = JSON.parse((init && init.body) || "{}").c_d || "";
      } catch (_e) {
        ccid = "";
      }
      return {
        success: true,
        data: [
          {
            lang: 0,
            name: "简体中文",
            data: `https://qn-c27.xuetangx.com/sub_${ccid}.json`,
          },
          {
            lang: 1,
            name: "English",
            data: `https://qn-c27.xuetangx.com/sub_${ccid}_en.json`,
          },
        ],
      };
    }
    // 2026-10-27: 字幕文件本体（钩子会自己在页面里抓一份）
    if (url.includes("sub_ccid-")) {
      return {
        subtitle_list: [
          { start: "00:00:00", end: "00:00:05", content: "第一句" },
          { start: "00:00:05", end: "00:00:11", content: "第二句" },
        ],
      };
    }
    return null;
  };

  window.fetch = function (input, init) {
    const url = String(typeof input === "string" ? input : input.url);
    const payload = resolveResponse(url, init);
    if (!payload) {
      return Promise.reject(new Error("unexpected url " + url));
    }
    const body = JSON.stringify(payload);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(payload),
      clone() {
        return { text: () => Promise.resolve(body) };
      },
    });
  };

  // 探针矩阵默认每发之间隔 700ms（限速，避免被服务端按"刷接口"拦）。
  // 测试里把它调成 0 —— 不然每个用例都要真等好几秒。
  window.__bililearnProbeGapMs = 0;
  window.eval(hookSource);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = (url, init) => window.fetch(url, init);

  (async () => {
    await call("/api/v1/lms/learn/leaf_info/31377125/6195112/?sign=THU08261000810");
    await wait(30);
    await call("/api/v1/lms/service/s_t_c/6195112/");
    await wait(30);
    await call("/api/v1/lms/service/s_t_g_p/", {
      method: "POST",
      body: JSON.stringify({ c_d: "ccid-6195112" }),
    });
    await wait(60);

    test("钩子抓到 leaf_info / s_t_c / s_t_g_p 的响应", () => {
      const stateMsg = messages.filter((m) => m.type === "state").pop();
      assertTrue(!!stateMsg, "钩子至少推送过一次状态");
      const state = stateMsg.payload;

      assertEqual(state.cid, "31377125", "cid 从 URL 解析");
      assertEqual(state.sign, "THU08261000810", "sign 从 URL 解析");
      assertEqual(state.leafId, "6195112", "leafId 从 leaf_info 捕获");
      assertEqual(state.ccid, "ccid-6195112", "ccid 从 leaf_info 捕获");
      assertEqual(state.leafTitle, "第一节 信号与系统", "小节标题");
      assertEqual(state.hasSubtitle, true, "有字幕标记");
      assertEqual(
        state.subtitleUrl,
        "https://qn-c27.xuetangx.com/sub_ccid-6195112.json",
        "字幕文件地址（优先中文）",
      );
      assertEqual(state.subtitleLang, "zh", "字幕语言");
    });

    // 2026-10-27: 钩子要能在页面上下文里把字幕文件本体抓下来 ——
    // 后台不用跨域下载（后台可能没那个 CDN 的权限 / 会被 403）。
    test("钩子把字幕文件本体也抓下来了", () => {
      const stateMsg = messages.filter((m) => m.type === "state").pop();
      const state = stateMsg.payload;
      assertTrue(!!state.subtitleBody, "字幕正文已抓到");
      assertEqual(state.subtitleFileError, "", "抓取过程没有报错");
      const parsed = bgScope.parseXuetangxSubtitlePayload(state.subtitleBody);
      assertEqual(parsed.length, 2, "抓到的正文能解析出 2 条");
      assertEqual(parsed[0].text, "第一句", "第一条文本");
      assertEqual(parsed[1].start, 5, "第二条起始");
    });

    // 换小节 —— 旧小节的字幕地址必须作废，新小节要重新拿到自己的地址
    messages.length = 0;
    await call("/api/v1/lms/learn/leaf_info/31377125/6195113/?sign=THU08261000810");
    await wait(400);
    test("换小节后换成新小节的字幕地址", () => {
      const msg = messages.filter((m) => m.type === "state").pop();
      assertTrue(!!msg, "换小节后钩子推送了新状态");
      const afterSwitch = msg.payload;
      assertEqual(afterSwitch.leafId, "6195113", "换小节后 leafId 更新");
      assertEqual(afterSwitch.ccid, "ccid-6195113", "换小节后 ccid 跟着换了");
      // 2026-10-27: 之前 ccid 没清空 → 补齐逻辑拿旧 ccid 去查字幕地址 →
      // 拿到上一节的字幕。现在必须换成新小节的地址。
      assertEqual(
        afterSwitch.subtitleUrl,
        "https://qn-c27.xuetangx.com/sub_ccid-6195113.json",
        "换小节后字幕地址是新小节的",
      );
      assertTrue(
        !String(afterSwitch.subtitleUrl || "").includes("6195112"),
        "旧小节的字幕地址没有残留",
      );
    });

    // =====================================================================
    // 6. 主动补齐：页面自己一次请求都没发（扩展后装 / 页面先开），
    //    钩子要能自己把 leaf_info / s_t_c / s_t_g_p 拉回来。
    // =====================================================================
    const dom2 = new JSDOM(
      "<!doctype html><html><body></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/ecut04021005032intl/ecut04021005032intl/31335364/video/84818568?channel=i.area.course_list_all",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win2 = dom2.window;
    const messages2 = [];
    win2.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages2.push(event.data);
      }
    });

    const requested = [];
    win2.fetch = function (input) {
      const url = String(typeof input === "string" ? input : input.url);
      requested.push(url);
      let payload = null;
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "第1讲 课程导论",
            content_info: {
              media: { ccid: "aabbccddeeff0011", poster: "" },
            },
          },
        };
      } else if (url.includes("/api/v1/lms/service/s_t_c/")) {
        payload = { success: true, data: { d_l: 0 } };
      } else if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
        payload = {
          success: true,
          data: [
            { lang: 0, name: "简体中文", data: "https://qn-c27.xuetangx.com/s2_zh.json" },
            { lang: 1, name: "English", data: "https://qn-c27.xuetangx.com/s2_en.json" },
          ],
        };
      } else if (url.includes("/api/v1/lms/learn/product/info")) {
        payload = { success: true, data: { name: "国际课程" } };
      } else if (url.includes("/c27/online_courseware/instance/graph/convert/")) {
        payload = {
          success: true,
          data: { etag_id: "ETAG1", graph_id: "G1" },
        };
      } else if (url.includes("/api/v1/lms/kg/kg_basic_info/")) {
        payload = { success: true, data: { graph_id: "G1" } };
      } else if (url.includes("/api/v1/lms/kg/kg_learn_chapter/")) {
        payload = {
          success: true,
          data: {
            chapters: [
              {
                name: "第一章 导论",
                content: "课程导论的内容",
                children: [{ name: "1.1 背景", content: "背景说明" }],
              },
              { name: "第二章 方法", content: "方法说明" },
            ],
          },
        };
      } else if (url.includes("/train_platform/v1/knowledge_graph/G1/nodes/")) {
        payload = {
          success: true,
          data: {
            nodes: [{ name: "知识点甲", description: "甲的说明" }],
          },
        };
      } else if (url.includes("/train_platform/v1/knowledge_graph/G1/")) {
        payload = { success: true, data: { name: "图谱" } };
      } else if (url.includes("s2_zh.json")) {
        payload = {
          subtitle_list: [
            { start: "00:00:00", end: "00:00:04", content: "开场白" },
          ],
        };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const body = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(payload),
        clone() {
          return { text: () => Promise.resolve(body) };
        },
      });
    };

    // 探针矩阵默认每发之间隔 700ms（限速，避免被服务端按"刷接口"拦）。
    // 测试里把它调成 0 —— 不然每个用例都要真等好几秒。
    win2.__bililearnProbeGapMs = 0;
    win2.eval(hookSource);
    await wait(300);

    test("主动补齐：没收到页面请求也能把小节信息拉回来", () => {
      const msg = messages2.filter((m) => m.type === "state").pop();
      assertTrue(!!msg, "钩子推送了状态");
      const s = msg.payload;
      assertEqual(s.cid, "31335364", "cid 从 /learn/space 路径解析");
      assertEqual(s.leafId, "84818568", "leafId 从 /video/{id} 解析");
      assertEqual(s.ccid, "aabbccddeeff0011", "ccid 由主动拉取得到");
      assertEqual(s.leafTitle, "第1讲 课程导论", "小节标题由主动拉取得到");
      assertEqual(s.hasSubtitle, true, "有字幕标记");
      assertEqual(
        s.subtitleUrl,
        "https://qn-c27.xuetangx.com/s2_zh.json",
        "字幕地址由主动拉取得到",
      );
      assertEqual(s.courseTitle, "国际课程", "课程名");
      assertEqual(s.resolved, true, "补齐完成标记");
      assertTrue(
        requested.some((u) => u.includes("leaf_info/31335364/84818568")),
        "确实主动请求了 leaf_info",
      );
      assertTrue(
        requested.some((u) => u.includes("service/s_t_c/")),
        "确实主动请求了 s_t_c",
      );
      assertTrue(
        requested.some((u) => u.includes("service/s_t_g_p/")),
        "确实主动请求了 s_t_g_p",
      );
      assertTrue(
        requested.some((u) => u.includes("s2_zh.json")),
        "确实主动抓了字幕文件本体",
      );
      assertTrue(!!s.subtitleBody, "字幕正文已抓到");
    });

    // =====================================================================
    // 7. 知识图谱那条链**不再拉了**。
    //
    //    原来概览里会显示一棵 300KB+ 的知识点树（graph/convert →
    //    kg_basic_info → knowledge_graph/{id}/nodes/，内容是
    //    "Section 1 …"那种 content 清单）。用户看过之后明确说：
    //    概览里不需要这个 content 列表 —— 所以整条链都停了。
    //
    //    现在概览只认官方章节摘要（leaf_knowledge）。
    // =====================================================================
    test("知识图谱链已经停用：不再请求那批 content 列表接口", () => {
      assertTrue(
        !requested.some((u) => u.includes("graph/convert/")),
        "不再请求班级图谱实例接口",
      );
      assertTrue(
        !requested.some((u) => u.includes("kg/kg_basic_info/")),
        "不再请求图谱 id 接口",
      );
      assertTrue(
        !requested.some((u) => u.includes("kg/kg_learn_chapter/")),
        "不再请求图谱单元接口",
      );
      assertTrue(
        !requested.some((u) => u.includes("knowledge_graph/")),
        "不再请求知识图谱节点树（那棵 content 列表）",
      );
      // 钩子里也不该再有知识导引的代码标识符（只看代码，不看注释 ——
      // 注释里还留着这段历史，说明"为什么不再拉"）。
      assertTrue(
        !/kgGuides|collectKnowledgeGuide|rememberKnowledgeGuide|isKnowledgeGuideUrl|kgExtractTree/.test(
          hookSource,
        ),
        "钩子源码里已经没有知识图谱相关代码",
      );
    });

    // =====================================================================
    // 8. 钩子版本号 + 诊断痕迹。
    //    2026-10-27 踩过的坑：扩展刷新不会更新已打开页面里的钩子 JS，
    //    页面里跑着旧钩子 → 后台拿到半新半旧的状态，排查了半天。
    //    现在：钩子带版本号，后台对不上就重新注入；notes 非空则证明
    //    "正在跑的这版钩子"确实执行了主动补齐。
    // =====================================================================
    test("钩子带版本号 + 主动补齐留下诊断痕迹", () => {
      const msg = messages2.filter((m) => m.type === "state").pop();
      const s = msg.payload;
      assertEqual(typeof s.hookVersion, "number", "hookVersion 是数字");
      assertTrue(s.hookVersion >= 4, "hookVersion >= 4");
      assertTrue(!!s.raw, "state 带 raw 诊断字段");
      assertTrue(Array.isArray(s.raw.notes), "raw.notes 是数组");
      assertTrue(s.raw.notes.length > 0, "主动补齐留下了 notes");
      assertTrue(
        s.raw.notes.some((n) => /leaf_info/.test(n)),
        "notes 里有 leaf_info 的尝试记录",
      );
      assertTrue(
        s.raw.notes.some((n) => /s_t_g_p/.test(n)),
        "notes 里有 s_t_g_p 的尝试记录",
      );
      // 2026-10-27: 字幕探针矩阵 —— 一次把所有可能的请求姿势试完，
      // 每一步都记进 raw.probe，排查时一眼看清"到底是哪个姿势对上了"。
      assertTrue(Array.isArray(s.raw.probe), "raw.probe 是数组");
      assertTrue(s.raw.probe.length > 0, "探针矩阵留下了记录");
      assertTrue(
        s.raw.probe.some((p) => /s_t_g_p/.test(p)),
        "probe 里有 s_t_g_p 的请求结果",
      );
      assertTrue(
        String(s.raw.subtitleList || "").length > 0,
        "raw 里有 s_t_g_p 的原始响应",
      );
    });

    // =====================================================================
    // 9. 字幕探针矩阵 —— 2026-10-27 线上真实故障的回归测试。
    //
    //    真实情况：s_t_g_p({c_d: ccid}) 线上回的是
    //      {"msg":"","success":true,"data":{}}
    //    data 是空对象，不是数组 —— 服务端"没匹配到主键"。
    //    但 s_t_c 又明明说 d_l=1（有字幕）、a_d=true（允许下载）。
    //
    //    光试 {c_d: ccid} 一个姿势永远读不出来。所以钩子现在把各种姿势
    //    一次全试完（探针矩阵），命中最先返回的那个。
    //    这里用 mock 复现："只有带上 d_l 才给数据"。
    // =====================================================================
    const dom3 = new JSDOM(
      "<!doctype html><html><body><video class='xt_video_player'></video></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/SIGN1/SIGN2/31335364/video/84818568",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win3 = dom3.window;
    const messages3 = [];
    win3.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages3.push(event.data);
      }
    });

    const probeBodies = [];
    win3.fetch = function (input, init) {
      const url = String(typeof input === "string" ? input : input.url);
      let payload = null;
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "1.1 Overview of Tai Chi",
            content_info: {
              media: { ccid: "15E84ABF4B8AF8007E6C9CEE8B422289" },
            },
          },
        };
      } else if (url.includes("/api/v1/lms/service/s_t_c/")) {
        payload = { success: true, data: { d_l: 1, a_d: true } };
      } else if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
        let body = {};
        try {
          body = JSON.parse((init && init.body) || "{}");
        } catch (_e) {
          body = {};
        }
        probeBodies.push(body);
        // 复现线上行为：默认姿势回空对象；带上 d_l 才给字幕。
        if (body.d_l === undefined && body.ccid === undefined) {
          payload = { msg: "", success: true, data: {} };
        } else {
          payload = {
            success: true,
            data: [
              { lang: 0, name: "简体中文", data: "https://qn-c27.xuetangx.com/probe_zh.json" },
              { lang: 1, name: "English", data: "https://qn-c27.xuetangx.com/probe_en.json" },
            ],
          };
        }
      } else if (url.includes("probe_zh.json")) {
        payload = {
          subtitle_list: [{ start: "00:00:00", end: "00:00:03", content: "太极" }],
        };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const text = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(payload),
        clone() {
          return { text: () => Promise.resolve(text) };
        },
      });
    };

    win3.__bililearnProbeGapMs = 0;
    win3.eval(hookSource);
    await wait(600);

    test("探针矩阵：默认姿势拿不到时，换个姿势照样把字幕读出来", () => {
      const msg = messages3.filter((m) => m.type === "state").pop();
      assertTrue(!!msg, "钩子推送了状态");
      const s = msg.payload;
      assertEqual(s.ccid, "15E84ABF4B8AF8007E6C9CEE8B422289", "ccid 拿到了");
      assertEqual(
        s.subtitleUrl,
        "https://qn-c27.xuetangx.com/probe_zh.json",
        "探针矩阵换姿势后拿到了字幕地址",
      );
      assertTrue(
        String(s.subtitleBody || "").includes("太极"),
        "字幕文件本体也抓下来了",
      );
      assertTrue(probeBodies.length > 1, "确实试了不止一种姿势");
      assertTrue(
        probeBodies.some((b) => b.d_l !== undefined),
        "试过带 d_l 的请求体",
      );
      assertTrue(
        Array.isArray(s.raw.probe) && s.raw.probe.length > 1,
        "每一种姿势都记进了 probe",
      );
    });

    // 全空场景：所有姿势都拿不到 —— 不崩、也不瞎编，
    // 但诊断里能看出每个姿势的结果。
    const dom4 = new JSDOM(
      "<!doctype html><html><body></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/SIGN1/SIGN2/31335364/video/84818568",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win4 = dom4.window;
    const messages4 = [];
    win4.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages4.push(event.data);
      }
    });
    win4.fetch = function (input) {
      const url = String(typeof input === "string" ? input : input.url);
      let payload = null;
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "1.1 Overview of Tai Chi",
            content_info: { media: { ccid: "CCC" } },
          },
        };
      } else if (url.includes("/api/v1/lms/service/s_t_c/")) {
        payload = { success: true, data: { d_l: 1 } };
      } else if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
        payload = { msg: "", success: true, data: {} };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const text = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(payload),
        clone() {
          return { text: () => Promise.resolve(text) };
        },
      });
    };
    win4.__bililearnProbeGapMs = 0;
    win4.eval(hookSource);
    await wait(600);

    test("探针矩阵：全空时也不崩，诊断里能看出每个姿势的结果", () => {
      const msg4 = messages4.filter((m) => m.type === "state").pop();
      assertTrue(!!msg4, "钩子推送了状态");
      const s4 = msg4.payload;
      assertEqual(s4.subtitleUrl, "", "拿不到字幕时地址为空（不瞎编）");
      assertTrue(
        Array.isArray(s4.raw.probe) && s4.raw.probe.length >= 3,
        "全空时也把每个姿势记进了 probe",
      );
      assertTrue(
        s4.raw.probe.some((p) => /对象\(0键\)/.test(p)),
        "probe 里能看出响应是空对象",
      );
    });

    // =====================================================================
    // 10. 2026-10-27 线上实测：探针矩阵第一发 200、之后全被 403。
    //    这一条覆盖"403 的正文要被抓出来"和"403 要重试一次"。
    // =====================================================================
    const dom5 = new JSDOM(
      "<!doctype html><html><body></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/SIGN1/SIGN2/31335364/video/84818568",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win5 = dom5.window;
    const messages5 = [];
    win5.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages5.push(event.data);
      }
    });

    let s_t_g_pCalls = 0;
    win5.fetch = function (input, init) {
      const url = String(typeof input === "string" ? input : input.url);
      let payload = null;
      let status = 200;
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "1.1 Overview of Tai Chi",
            content_info: { media: { ccid: "CCC" } },
          },
        };
      } else if (url.includes("/api/v1/lms/service/s_t_c/")) {
        payload = { success: true, data: { d_l: 1 } };
      } else if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
        s_t_g_pCalls++;
        if (s_t_g_pCalls === 1) {
          // 第一次：服务端 403，正文是一段 HTML（CSRF / 限流页）
          status = 403;
          payload = "<html><body>403 Forbidden</body></html>";
        } else {
          payload = {
            success: true,
            data: [
              { lang: 0, name: "简体中文", data: "https://qn-c27.xuetangx.com/ok_zh.json" },
            ],
          };
        }
      } else if (url.includes("ok_zh.json")) {
        payload = {
          subtitle_list: [{ start: "00:00:00", end: "00:00:02", content: "有字幕" }],
        };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const text =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(text),
        json: () =>
          status >= 200 && status < 300
            ? Promise.resolve(JSON.parse(text))
            : Promise.reject(new Error("not json")),
        headers: { get: () => "" },
        clone() {
          return { text: () => Promise.resolve(text) };
        },
      });
    };
    win5.__bililearnProbeGapMs = 0;
    win5.__bililearnProbeRetryWaitMs = 0;
    win5.eval(hookSource);
    await wait(800);

    test("探针矩阵：403 会把正文记下来，并且重试一次能拿到字幕", () => {
      const msg5 = messages5.filter((m) => m.type === "state").pop();
      assertTrue(!!msg5, "钩子推送了状态");
      const s5 = msg5.payload;
      assertTrue(
        s5.raw.probe.some((p) => /403/.test(p) && /403 Forbidden/.test(p)),
        "probe 里记下了 403 的正文",
      );
      assertTrue(
        s5.raw.probe.some((p) => /重试/.test(p)),
        "probe 里记下了重试",
      );
      assertEqual(
        s5.subtitleUrl,
        "https://qn-c27.xuetangx.com/ok_zh.json",
        "重试之后拿到了字幕地址",
      );
    });

    test("探针矩阵默认限速（避免被服务端按刷接口拦掉）", () => {
      assertTrue(
        /__bililearnProbeGapMs[\s\S]{0,200}?\?\s*700|: 700/.test(hookSource),
        "默认间隔是 700ms",
      );
      assertTrue(
        hookSource.includes('"django-language"'),
        "请求头跟学堂在线的 axios 对齐（含 django-language）",
      );
      assertTrue(
        hookSource.includes('"Accept-Language"'),
        "请求头含 Accept-Language",
      );
    });

    // =====================================================================
    // 11. 2026-10-27 真机新接口：讲稿（leaf_lecture_note）+ 章节（leaf_knowledge）
    //
    //     线上 s_t_g_p 那条字幕线反复试都读不出来，最后在真机上翻出这两个
    //     接口：讲稿是逐段带时间戳的官方文字稿，章节是官方 AI 章节摘要。
    //     钩子必须优先用讲稿（一个 GET 就够），而且拿到讲稿后**不再**去跑
    //     那套十几个请求的字幕探针矩阵。
    // =====================================================================
    const dom6 = new JSDOM(
      "<!doctype html><html><body></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/SIGN1/SIGN2/31335364/video/84818568",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win6 = dom6.window;
    const messages6 = [];
    win6.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages6.push(event.data);
      }
    });

    const requested6 = [];
    win6.fetch = function (input) {
      const url = String(typeof input === "string" ? input : input.url);
      requested6.push(url);
      let payload = null;
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "1.1 Overview of Tai Chi",
            duration: 888,
            content_info: { media: { ccid: "CCC" } },
          },
        };
      } else if (url.includes("/c27/online_courseware/leaf_lecture_note/")) {
        payload = {
          msg: "",
          success: true,
          data: [
            {
              formalParagraphText: "同学们好，今天讲太极拳",
              id: "8045034",
              startTime: 21200,
              endTime: 38120,
            },
            {
              formalParagraphText: "太极一词最早出自易传",
              id: "8045035",
              startTime: 38360,
              endTime: 58920,
            },
          ],
        };
      } else if (url.includes("/c27/online_courseware/leaf_knowledge/")) {
        payload = {
          msg: "",
          success: true,
          data: [
            {
              headline: "太极拳：起源、理念与全球影响",
              summary: "太极源于《易传》",
              startTime: 21200,
              endTime: 378760,
              chapterId: 1,
            },
            {
              headline: "太极拳的起源和发展",
              summary: "起源众说纷纭",
              startTime: 379420,
              endTime: 529520,
              chapterId: 2,
            },
          ],
        };
      } else if (url.includes("/api/v1/lms/service/s_t_c/")) {
        payload = { success: true, data: { d_l: 1 } };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const text = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(payload),
        headers: { get: () => "" },
        clone() {
          return { text: () => Promise.resolve(text) };
        },
      });
    };
    win6.__bililearnProbeGapMs = 0;
    win6.eval(hookSource);
    await wait(500);

    test("讲稿接口：讲稿当字幕用，后台能直接解析出带时间的段落", () => {
      const msg6 = messages6.filter((m) => m.type === "state").pop();
      assertTrue(!!msg6, "钩子推送了状态");
      const s6 = msg6.payload;
      assertTrue(
        requested6.some((u) =>
          u.includes("/c27/online_courseware/leaf_lecture_note/84818568/"),
        ),
        "请求了讲稿接口",
      );
      assertEqual(s6.hasLectureNote, true, "拿到讲稿");
      assertEqual(s6.lectureNote.length, 2, "讲稿段数");
      assertEqual(s6.lectureNote[0].start, 21.2, "讲稿起点（毫秒→秒）");
      assertEqual(s6.subtitleSource, "lecture-note", "字幕来源标记");
      assertEqual(s6.hasSubtitle, true, "有字幕标记");
      // 后台的解析器认这套结构（不用改后台一行代码）
      const rows = bgScope.parseXuetangxSubtitlePayload(s6.subtitleBody);
      assertEqual(rows.length, 2, "后台能解析出 2 条");
      assertEqual(rows[0].text, "同学们好，今天讲太极拳", "后台拿到的文本");
      assertEqual(rows[0].start, 21.2, "后台拿到的起点");
    });

    test("讲稿优先：拿到讲稿就不再跑字幕探针矩阵", () => {
      assertTrue(
        !requested6.some((u) => u.includes("/api/v1/lms/service/s_t_g_p/")),
        "没有去打 s_t_g_p（讲稿已经够了）",
      );
    });

    test("章节接口：官方章节进状态，概览不用跑 AI", () => {
      const msg6 = messages6.filter((m) => m.type === "state").pop();
      const s6 = msg6.payload;
      assertTrue(
        requested6.some((u) =>
          u.includes("/c27/online_courseware/leaf_knowledge/84818568/"),
        ),
        "请求了章节接口",
      );
      assertEqual(s6.leafKnowledge.length, 2, "章节数");
      assertEqual(
        s6.leafKnowledge[0].title,
        "太极拳：起源、理念与全球影响",
        "章节标题",
      );
      assertEqual(s6.leafKnowledge[0].start, 21.2, "章节起点");
      assertEqual(s6.leafKnowledge[0].end, 378.76, "章节终点");
      // 概览只用官方章节，不再挂知识图谱那套
      assertTrue(
        !Array.isArray(s6.kgGuides) || s6.kgGuides.length === 0,
        "没有知识图谱导引了",
      );
    });

    // =====================================================================
    // 12. 真字幕文件 vs 讲稿 —— 谁优先？
    //
    //     页面自己拉到字幕文件时（人工校对过的），讲稿（机器转写，可能有
    //     错字）不能把它顶掉。这里复现"页面先给字幕文件、钩子后拿讲稿"
    //     的顺序，断言字幕正文仍然是字幕文件、来源标记也没被改。
    // =====================================================================
    const dom7 = new JSDOM(
      "<!doctype html><html><body></body></html>",
      {
        url: "https://www.xuetangx.com/learn/space/SIGN1/SIGN2/31335364/video/84818568",
        runScripts: "dangerously",
        pretendToBeVisual: true,
      },
    );
    const win7 = dom7.window;
    const messages7 = [];
    win7.addEventListener("message", (event) => {
      if (event.data && event.data.source === "bililearn-xuetangx") {
        messages7.push(event.data);
      }
    });

    const order7 = [];
    win7.fetch = function (input) {
      const url = String(typeof input === "string" ? input : input.url);
      let payload = null;
      // 讲稿接口故意慢 250ms —— 这样"页面先给字幕文件、钩子后拿讲稿"
      // 这个**风险顺序**一定会发生（否则测不到真正要防的那件事）。
      let delay = 0;
      let tag = "";
      if (url.includes("/api/v1/lms/learn/leaf_info/")) {
        payload = {
          success: true,
          data: {
            id: 84818568,
            name: "1.1 Overview of Tai Chi",
            duration: 888,
            content_info: { media: { ccid: "CCC" } },
          },
        };
      } else if (url.includes("/api/v1/lms/service/s_t_g_p/")) {
        payload = {
          success: true,
          data: [{ lang: 0, name: "简体中文", data: "https://qn-c27.xuetangx.com/good_zh.json" }],
        };
      } else if (url.includes("good_zh.json")) {
        tag = "字幕文件";
        payload = {
          subtitle_list: [{ start: "00:00:00", end: "00:00:03", content: "人工校对的字幕" }],
        };
      } else if (url.includes("/c27/online_courseware/leaf_lecture_note/")) {
        delay = 250;
        tag = "讲稿";
        payload = {
          msg: "",
          success: true,
          data: [
            {
              formalParagraphText: "机器转写的讲稿",
              id: "8045034",
              startTime: 21200,
              endTime: 38120,
            },
          ],
        };
      }
      if (!payload) return Promise.reject(new Error("unexpected " + url));
      const text = JSON.stringify(payload);
      const response = {
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(payload),
        headers: { get: () => "" },
        clone() {
          return { text: () => Promise.resolve(text) };
        },
      };
      // order7 记的是**响应送达**顺序（不是请求发出顺序）——
      // 钩子处理响应的先后顺序才是关键。
      if (!delay) {
        if (tag) order7.push(tag);
        return Promise.resolve(response);
      }
      return new Promise((resolve) =>
        setTimeout(() => {
          if (tag) order7.push(tag);
          resolve(response);
        }, delay),
      );
    };
    win7.__bililearnProbeGapMs = 0;
    win7.eval(hookSource);
    await wait(60);
    // 页面自己拉字幕列表（被动捕获路径）
    await win7.fetch("/api/v1/lms/service/s_t_g_p/", {
      method: "POST",
      body: JSON.stringify({ c_d: "CCC" }),
    });
    await wait(500);

    test("真字幕文件优先于讲稿（讲稿不顶掉人工校对的字幕）", () => {
      const msg7 = messages7.filter((m) => m.type === "state").pop();
      assertTrue(!!msg7, "钩子推送了状态");
      const s7 = msg7.payload;
      // 先确认这次真的踩到了"风险顺序"（字幕文件先到、讲稿后到），
      // 否则这条用例等于没测。
      assertEqual(
        order7.indexOf("字幕文件") < order7.indexOf("讲稿"),
        true,
        "确实先到字幕文件、后到讲稿",
      );
      assertEqual(s7.hasLectureNote, true, "讲稿也拿到了");
      assertEqual(s7.subtitleSource, "subtitle-file", "来源标记是字幕文件");
      const rows = bgScope.parseXuetangxSubtitlePayload(s7.subtitleBody);
      assertEqual(rows.length, 1, "字幕正文来自字幕文件");
      assertEqual(rows[0].text, "人工校对的字幕", "正文是字幕文件那一份");
    });

    // ---- 收尾 ----
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} passed`,
    );
    if (failed.length) {
      for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`);
      process.exit(1);
    }
    process.exit(0);
  })().catch((err) => {
    console.error("测试异常:", err);
    process.exit(1);
  });
}
