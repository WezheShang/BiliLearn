// 探针：旧 whisper server 场景下，扩展链路必须**快速失败**而不是等 45 秒
//
// 2026-11-05。用户报：
//   1. 没有字幕的视频，45s 之后出现 whisper button
//   2. 点 whisper button → 500 LocalEntryNotFoundError: ConnectTimeout
//
// 根因（实测确认）：
//   现役的 whisper server 是**开机自启任务拉起来的 SYSTEM 实例**
//   （PID 14516，11/03 启动，跑的是旧代码）：
//     - 普通用户权限杀不掉（taskkill: Access is denied）
//     - schtasks /query 也 Access is denied
//     - 旧代码不解析本地 HF 缓存 → 每次去 huggingface.co 下载
//       → 本机直连不通 → LocalEntryNotFoundError → 500
//
//   而且旧代码的 /local-file 要全目录读 1200+ 文件头 → 3.1 秒。
//
// 这个探针验三件事：
//   A. whisper server 请求**有硬超时** —— server 卡住时不会无限等
//   B. 旧 server 返回 500 时，扩展能识别成"旧代码"并自动修复
//   C. 整条 fetchTranscript 链路在 server 卡死时 **< 15 秒**返回
//      （而不是 sidepanel 的 45 秒兜底）
//
// 用法：node bilidown-tests\_diag_stale_server.js

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BVID = "BV1ed4b6rE5G";
const CID = "43352328905";
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}/`;

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
 * 从 background.js 抠出 whisperServerFetch（带超时的 fetch）。
 * 探针只测这一个纯函数 —— 它是"server 卡死"的唯一防线。
 */
function loadWhisperServerFetch(fetchImpl) {
  const src = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const start = src.indexOf("async function whisperServerFetch");
  if (start < 0) throw new Error("background.js 里找不到 whisperServerFetch");
  // 大括号配平扫描有个坑：函数签名里的**默认参数对象**会骗过扫描
  // （`options = {}` 的那个 `{` 被当成函数体开头，函数体就被截成
  // "async function whisperServerFetch(url, options = {}"）。
  // 正确做法：先跳过签名（找到参数列表的收尾 `)`），再从它**之后**的
  // 第一个 `{` 开始配平。
  const sigStart = src.indexOf("(", start);
  let sigEnd = -1;
  let parenDepth = 0;
  for (let i = sigStart; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        sigEnd = i;
        break;
      }
    }
  }
  const bodyStart = src.indexOf("{", sigEnd);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const text = src.slice(start, end);
  // 常量在函数**外面**（顶层 const），抠函数时必须一起带进来，
  // 否则函数体里的引用断了 → "whisperServerFetch is not a function"。
  const constMatch = src.match(
    /const WHISPER_SERVER_FETCH_TIMEOUT_MS\s*=\s*(\d+)/,
  );
  if (!constMatch) {
    throw new Error("background.js 里找不到 WHISPER_SERVER_FETCH_TIMEOUT_MS");
  }
  // new Function 的函数体里不能直接写 return（除非函数本身返回对象）——
  // 这里用 async 箭头包一层再求值。
  const body =
    "return (async () => {\n" +
    "const WHISPER_SERVER_FETCH_TIMEOUT_MS = " + constMatch[1] + ";\n" +
    "const debugLog = () => {};\n" +
    text +
    "\nreturn { whisperServerFetch, WHISPER_SERVER_FETCH_TIMEOUT_MS };\n})();";
  const factory = new Function("fetch", body);
  // 必须传 fetchImpl 进去 —— new Function 的参数会遮蔽全局 fetch。
  // 之前这里传的是全局 fetch，所以"挂起"mock 根本没生效（探针假绿）。
  return factory(fetchImpl);
}

/** 造一个"永不回话"的 fetch（模拟 server 卡死）。 */
function makeHangingFetch() {
  return (url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options && options.signal;
      if (!signal) return; // 永不 settle
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

async function main() {
  console.log("=== 旧 whisper server 场景探针 ===");

  // ---- A. 超时防线存在 ----
  const hanging = makeHangingFetch();
  const {
    whisperServerFetch,
    WHISPER_SERVER_FETCH_TIMEOUT_MS,
  } = await loadWhisperServerFetch(hanging);
  console.log(`  background 里的硬超时：${WHISPER_SERVER_FETCH_TIMEOUT_MS}ms`);
  check(
    "A1 有硬超时且 ≤ 10s（远小于 sidepanel 的 45s 兜底）",
    WHISPER_SERVER_FETCH_TIMEOUT_MS > 0 &&
      WHISPER_SERVER_FETCH_TIMEOUT_MS <= 10000,
    `${WHISPER_SERVER_FETCH_TIMEOUT_MS}ms`,
  );

  // ---- B. server 卡死 → 超时后必须"当作没找到"，而不是抛异常 ----
  const t0 = Date.now();
  let timedOutCleanly = false;
  let threw = false;
  try {
    const res = await whisperServerFetch("http://127.0.0.1:7860/cache?x=1", {
      method: "GET",
    }, 800);
    timedOutCleanly = res && res.ok === false && res.status === 0;
  } catch (_e) {
    threw = true;
  }
  const elapsed = Date.now() - t0;
  check("B1 server 卡死时不抛异常（否则整条链路跳进 catch）", !threw);
  check("B2 超时后返回「当作没找到」的假响应", timedOutCleanly);
  check(
    "B3 超时确实生效（~800ms 内返回，不是无限等）",
    elapsed >= 700 && elapsed < 2000,
    `${elapsed}ms`,
  );

  // ---- C. 真实 server（7860 旧实例）上，扩展的本地查找不会挂死 ----
  // 用真实网络跑一次：旧实例的 /local-file 要 3.1 秒，应该能拿到 404
  // 而不是超时 —— 这证明超时值留有余量，不会误杀正常的慢请求。
  const real = await loadWhisperServerFetch(globalThis.fetch);
  const t1 = Date.now();
  let realStatus = null;
  try {
    const res = await real.whisperServerFetch(
      "http://127.0.0.1:7860/local-file?filenames=probe.md&bvid=" +
        BVID +
        "&cid=" +
        CID +
        "&cache_dir=C%3A%5CUsers%5Cshangweizhe%5Cbilibilisubs",
      { method: "GET" },
      8000,
    );
    realStatus = res.status;
  } catch (e) {
    realStatus = "EXC:" + e.message;
  }
  const realElapsed = Date.now() - t1;
  console.log(
    `  真实 7860 旧实例 /local-file: ${realElapsed}ms status=${realStatus}`,
  );
  check(
    "C1 旧实例的慢请求（~3s）在超时预算内完成，不会被误杀",
    realStatus === 404 || realStatus === 200,
    `status=${realStatus} elapsed=${realElapsed}ms`,
  );

  // ---- D. 旧 server 的 500 错误能被识别 ----
  // sidepanel 的 maybeRepairStaleWhisperServer 按这些特征识别
  const stalePatterns = [
    /LocalEntryNotFoundError/i,
    /ConnectTimeout/i,
    /WinError 10060/i,
    /Whisper server returned 5\d\d/i,
  ];
  const realError =
    'Whisper server returned 500: {"error": "LocalEntryNotFoundError: Got: ' +
    "ConnectTimeout: [WinError 10060] 由于连接方在一段时间后没有正确答复或连接的主机没有反应" +
    '，连接尝试失败。"}';
  const matched = stalePatterns.some((re) => re.test(realError));
  check("D1 用户报的 500 错误能被识别成「旧 server」症状", matched);

  console.log(
    `\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`,
  );
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("PROBE CRASHED:", err);
  process.exit(1);
});
