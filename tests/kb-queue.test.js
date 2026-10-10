// tests/kb-queue.test.js — kb-queue.js 纯函数（splitSegments / extractJson）单测。
// Run: node tests/kb-queue.test.js
// kb-queue.js 是 IIFE，依赖 chrome/YTD_SETTINGS/KbShared 全局；此处最小 mock 后 eval 装载。
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}${detail ? " :: " + detail : ""}`);
  }
}

// ---- load KbShared ----
global.self = global;
eval(fs.readFileSync(path.join(__dirname, "..", "kb-shared.js"), "utf8"));
check("KbShared loaded", typeof KbShared === "object");

// ---- load KbQueue with minimal mocks ----
global.chrome = { storage: { local: { get: async () => ({}) } } };
global.YTD_SETTINGS = { STORAGE_KEY: "ytd_settings", normalize: (x) => x || {} };
eval(fs.readFileSync(path.join(__dirname, "..", "kb-queue.js"), "utf8"));
check("KbQueue loaded", typeof KbQueue === "object");

// ---- splitSegments: parse a real buildKbDocument output ----
const doc = KbShared.buildKbDocument(
  {
    topic: "测试视频", author: "UP主", bvid: "BV1xx411c7mD", platform: "bilibili",
    date: "2026-01-01", lang: "zh",
  },
  [
    { start: 0, end: 5, text: "第一句" },
    { start: 5, end: 10, text: "第二句" },
    { start: 10, end: 15, text: "第三句" },
  ]
);
const segs = KbQueue._splitSegments(doc);
check("splitSegments count = 3", segs.length === 3, `got ${segs.length}`);
check("splitSegments texts", segs.map((s) => s.text.trim()).join("|") === "第一句|第二句|第三句",
  JSON.stringify(segs.map((s) => s.text)));
check("splitSegments times", segs[0].start === 0 && segs[2].end === 15, JSON.stringify(segs.map((s) => [s.start, s.end])));

// splitSegments on legacy from/to segments (kb-shared supports both shapes)
const doc2 = KbShared.buildKbDocument(
  { topic: "t2", author: "a", bvid: "dQw4w9WgXcQ", platform: "youtube", date: "2026-02-02" },
  [{ from: 0, to: 3, text: "legacy" }]
);
const segs2 = KbQueue._splitSegments(doc2);
check("splitSegments legacy from/to count = 1", segs2.length === 1, `got ${segs2.length}`);

// ---- extractJson ----
check("extractJson plain", KbQueue._extractJson('前缀 {"index_md":"x"} 后缀') === '{"index_md":"x"}');
check("extractJson nested", KbQueue._extractJson('```json\n{"a":{"b":1}}\n```') === '{"a":{"b":1}}');
let threw = false;
try { KbQueue._extractJson("no json here"); } catch (e) { threw = e.message === "LLM_NO_JSON"; }
check("extractJson no-json throws LLM_NO_JSON", threw);

// ---- verdict ----
if (failures) {
  console.error(`${failures} FAIL`);
  process.exit(1);
}
console.log("kb-queue.test.js ALL PASS");
