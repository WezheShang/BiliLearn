// 红/绿反向验证：本地缓存查找必须**并行**（2026-11-05）
//
// 背景：用户报"没字幕的视频，'正在获取字幕'的状态还是很长时间"。
// 实测（真实 server 打真实目录，1204 个文件）：
//   /local-file → 3091ms（优化前）→ 178ms（优化后）
//   /cache      →  633ms（优化前）→  55ms（优化后）
// 两者在扩展里原来是**串行**的 → 3.7s 白等。
//
// 这个验证脚本把 background.js 抠出"本地查找怎么发起"这段，
// 分别跑**并行版**和**串行版**，确认：
//   绿：并行版两个请求同时发出，总耗时 = max(180, 60) ≈ 180ms
//   红：串行版两个请求前后脚，总耗时 = 180 + 60 = 240ms
//
// 用法：node bilidown-tests\_diag_parallel_local_lookup.js

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra !== undefined ? " :: " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra !== undefined ? " :: " + extra : ""}`);
  }
}

/**
 * 从 background.js 里抠出 handleFetchTranscript 里"两个本地查找怎么发起"
 * 这段，跑成一个最小可测函数。
 *
 * 不用真源码整段跑（依赖太多），只抠这两句 —— 判据聚焦在
 * "两个请求是不是同时发出"。
 */
function extractLookupBlock() {
  const src = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const start = src.indexOf("const localFilePromise =");
  if (start < 0) {
    throw new Error("background.js 里找不到 localFilePromise（并行改造没落地？）");
  }
  const end = src.indexOf("const localFile = await localFilePromise;", start);
  if (end < 0) {
    throw new Error("background.js 里找不到 await localFilePromise");
  }
  return src.slice(start, end + "const localFile = await localFilePromise;".length);
}

/** 串行版（= 修复前的写法）：先 await local-file，再发 cache。 */
const SERIAL_BLOCK = `
const localFile = await loadLocalSubtitleFile(videoId, videoTitle, channelName, pubDate, settings, page.cid);
const whisperCachePromise = loadCachedTranscript(videoId, page.cid, settings, videoTitle, channelName, pubDate);
await whisperCachePromise;
`;

async function runBlock(blockSrc, { serial }) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "chrome-extension://fake/background.html",
    runScripts: "outside-only",
  });
  const timeline = [];
  const t0 = Date.now();
  const mark = (label) => timeline.push({ label, ms: Date.now() - t0 });

  const fakeLoadLocal = () => {
    mark("发 /local-file");
    return new Promise((resolve) =>
      setTimeout(() => {
        mark("回 /local-file");
        resolve(null);
      }, 180),
    );
  };
  const fakeLoadCache = () => {
    mark("发 /cache");
    return new Promise((resolve) =>
      setTimeout(() => {
        mark("回 /cache");
        resolve(null);
      }, 60),
    );
  };

  const body =
    "return (async () => {\n" +
    (serial ? SERIAL_BLOCK : blockSrc) +
    "\nreturn { localFile: typeof whisperCachePromise !== 'undefined' ? localFile : localFile, whisperCachePromise: typeof whisperCachePromise !== 'undefined' ? whisperCachePromise : null };\n})();";
  const factory = new Function(
    "loadLocalSubtitleFile",
    "loadCachedTranscript",
    "videoId",
    "videoTitle",
    "channelName",
    "pubDate",
    "settings",
    "page",
    "Promise",
    body,
  );

  const started = Date.now();
  const result = await factory(
    fakeLoadLocal,
    fakeLoadCache,
    "BV1ed4b6rE5G",
    "t",
    "c",
    "2023-11-14",
    { whisperUrl: "http://127.0.0.1:7860", subtitlesDir: "C:\\x", asrProvider: "whisper" },
    { cid: "43352328905" },
    Promise,
  );
  return { timeline, elapsed: Date.now() - started, result };
}

async function main() {
  console.log("=== 红/绿反向验证：本地缓存查找并行 ===");

  const parallelBlock = extractLookupBlock();

  // ---- 绿：当前源码（并行）----
  const green = await runBlock(parallelBlock, { serial: false });
  console.log("  绿（当前源码）时间线：");
  for (const t of green.timeline) console.log(`    ${String(t.ms).padStart(5)}ms  ${t.label}`);
  const greenLocal = green.timeline.find((t) => t.label === "发 /local-file");
  const greenCache = green.timeline.find((t) => t.label === "发 /cache");
  check("G1 两个请求都发起了", !!greenLocal && !!greenCache);
  const greenGap = greenLocal && greenCache ? Math.abs(greenLocal.ms - greenCache.ms) : 9999;
  check("G2 两个请求同时发出（相差 < 100ms）", greenGap < 100, `相差 ${greenGap}ms`);
  check(
    "G3 总耗时 ≈ max(180,60) 而非 sum(180,60)",
    green.elapsed < 240,
    `${green.elapsed}ms（串行会是 240ms+）`,
  );

  // ---- 红：串行版（= 修复前）----
  const red = await runBlock(parallelBlock, { serial: true });
  console.log("  红（串行版 = 修复前）时间线：");
  for (const t of red.timeline) console.log(`    ${String(t.ms).padStart(5)}ms  ${t.label}`);
  const redLocal = red.timeline.find((t) => t.label === "发 /local-file");
  const redCache = red.timeline.find((t) => t.label === "发 /cache");
  const redGap = redLocal && redCache ? Math.abs(redLocal.ms - redCache.ms) : 0;
  check("R1 串行版确实前后脚（相差 > 100ms）—— 变异生效", redGap > 100, `相差 ${redGap}ms`);
  check("R2 串行版总耗时更长（> 240ms）", red.elapsed >= 240, `${red.elapsed}ms`);
  check(
    "R3 探针能区分并行/串行（绿版明显更快）",
    green.elapsed < red.elapsed,
    `并行 ${green.elapsed}ms vs 串行 ${red.elapsed}ms`,
  );

  console.log(
    `\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`,
  );
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE CRASHED:", err);
  process.exit(1);
});
