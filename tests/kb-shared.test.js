// tests/kb-shared.test.js
// Run: node tests/kb-shared.test.js
// Pure-function unit tests for kb-shared.js (2026-10-03 KB feature).
const assert = require("assert");
require("../kb-shared.js");
const S = globalThis.KbShared;
assert.ok(S, "KbShared namespace missing after require");

// parseVideoId: B站 12+ 字符 BV 号, page 从 @p 后缀解析
assert.deepStrictEqual(S.parseVideoId("BV1NdMx6gEo5@p2"), { id: "BV1NdMx6gEo5", page: 2, platform: "bilibili" });
// YouTube 11 字符 ID
assert.deepStrictEqual(S.parseVideoId("dQw4w9WgXcQ@p1"), { id: "dQw4w9WgXcQ", page: 1, platform: "youtube" });
// 无 @p 后缀 → page 1
assert.deepStrictEqual(S.parseVideoId("BV1abc"), { id: "BV1abc", page: 1, platform: "bilibili" });

// sanitizeKbName: 非法字符替换、尾部点清除
assert.strictEqual(S.sanitizeKbName('宏观/研究:2026*'), "宏观_研究_2026_");
assert.strictEqual(S.sanitizeKbName("宏观."), "宏观");
assert.strictEqual(S.sanitizeKbName("宏观 "), "宏观");
assert.strictEqual(S.sanitizeKbName("").length, 0);
// 超长截断到 60
assert.strictEqual(S.sanitizeKbName("宏".repeat(80)).length, 60);

// videoFileName: 标题清洗（全角标点保留）+ YYYYMMDD + 多P后缀
assert.strictEqual(S.videoFileName("7月宏观重点：黄金是否筑底？（2）", "2026-07-07", 1), "7月宏观重点：黄金是否筑底？（2）_20260707.md");
assert.strictEqual(S.videoFileName("t", "2026-07-07", 2), "t_20260707_P2.md");
// ASCII 非法字符清洗为空格
assert.strictEqual(S.videoFileName('a/b\\c', "2026-07-07", 1), "a b c_20260707.md");
// date 缺失 → fallback 今天
assert.ok(/^\d{8}\.md$/.test(S.videoFileName("t", "", 1).split("_")[1] + ""));

// dedupKey
assert.strictEqual(S.dedupKey("BV1x@p2"), "BV1x@p2");
assert.strictEqual(S.dedupKey("BV1x"), "BV1x@p1");

// compactDate
assert.strictEqual(S.compactDate("2026-07-07"), "20260707");
assert.strictEqual(S.compactDate("2026-07-07T12:00:00Z"), "20260707");
assert.ok(/^\d{8}$/.test(S.compactDate("")));

// buildKbDocument: frontmatter 字段齐全 + 段落格式 + from/to 与 start/end 兼容
const doc = S.buildKbDocument(
  { speaker: "姜汁汽水", author: "战国时代_姜汁汽水", platform: "bilibili", bvid: "BV1x",
    cid: 123456, page: 1,
    date: "2026-07-07", dateSource: "pubdate", addedAt: "2026-10-03T13:05:00+08:00",
    lang: "zh", topic: "黄金", url: "https://www.bilibili.com/video/BV1x", durationS: 1354 },
  [{ from: 0.1, to: 2.2, text: "第一句" }, { start: 2.2, end: 4.5, text: "第二句" }]
);
assert.ok(doc.startsWith("---\nspeaker: 姜汁汽水\n"), "frontmatter head");
assert.ok(doc.includes("author: 战国时代_姜汁汽水"));
assert.ok(doc.includes("platform: bilibili\nbvid: BV1x"));
assert.ok(doc.includes("cid: 123456"));
assert.ok(doc.includes("page: 1"));
assert.ok(doc.includes("date: 2026-07-07\ndate_source: pubdate"));
assert.ok(doc.includes("added_at: 2026-10-03T13:05:00+08:00"));
assert.ok(doc.includes("duration_s: 1354"));
assert.ok(doc.includes("## 段 1  [0.10s → 2.20s]\n\n第一句"), "segment 1 from/to");
assert.ok(doc.includes("## 段 2  [2.20s → 4.50s]\n\n第二句"), "segment 2 start/end");
assert.ok(doc.includes("# 黄金"), "body title");

// topic 含双引号 → YAML 转义
const doc2 = S.buildKbDocument(
  { topic: '说"黄金"', platform: "bilibili", bvid: "b", date: "2026-01-01", addedAt: "x" }, []
);
assert.ok(doc2.includes('topic: "说\\"黄金\\""'), "yaml quote escape");

// date fallback 标注
const doc3 = S.buildKbDocument(
  { topic: "t", platform: "youtube", bvid: "AbCdEfGhIjK", date: "2026-10-03",
    dateSource: "fallback_today", addedAt: "x" }, []
);
assert.ok(doc3.includes("date_source: fallback_today"));
assert.ok(doc3.includes("platform: youtube"));

// compressSegmentsForLlm: 120 段 → 3 块，块首保留段号区间
const segs = Array.from({ length: 120 }, (_, i) => ({ from: i, to: i + 1, text: `s${i}` }));
const c = S.compressSegmentsForLlm(segs, 50);
assert.strictEqual((c.match(/### 段/g) || []).length, 3);
assert.ok(c.includes("### 段 1-50"));
assert.ok(c.includes("### 段 51-100"));
assert.ok(c.includes("### 段 101-120"));
// 默认 chunkSize 50
const c2 = S.compressSegmentsForLlm(segs.slice(0, 60));
assert.strictEqual((c2.match(/### 段/g) || []).length, 2);

// 常量
assert.deepStrictEqual(S.KB_BUILD_METHODS, ["karpathy", "nvwa", "raw"]);
assert.deepStrictEqual(S.KB_UPDATE_MODES, ["realtime", "manual", "daily"]);

console.log("kb-shared.test.js ALL PASS");
