/**
 * 扩展根目录卫生检查 —— Chrome 拒载防线（2026-11-22）。
 *
 * 背景（真实事故）：
 *   2026-11-22 用户在 chrome://extensions 点「加载已解压的扩展程序」，
 *   Chrome 直接报：
 *     Cannot load extension with file or directory name _preview_gen.js.
 *     Filenames starting with "_" are reserved for use by the system.
 *   整个扩展**加载不了**，用户什么都干不了。
 *
 * 根因：Chrome 加载 unpacked 扩展时，会检查**扩展根目录**的每个条目 ——
 *   任何以 "_" 开头的**文件或目录**都会让整个扩展加载失败。
 *
 *   ⚠️ 唯一的例外：**`_metadata`**。
 *      那是 Chrome 自己写的目录（manifest 声明了 declarative_net_request
 *      静态规则集 → Chrome 把编译后的规则集写进 <扩展目录>/_metadata/
 *      generated_indexed_rulesets/_ruleset1）。实测（2026-11-22）它存在时
 *      扩展**加载并正常运行**，所以不能把它当成违规项 —— 更不能删：
 *      删了会让已加载扩展的 DNR 规则失效（Chrome 自己会重新编译，但别赌）。
 *
 *   只查顶层，子目录不受影响：node_modules/**\/_utils.js、
 *     tests/_metadata_archive、bilidown-tests/_diag_* 都长期共存且不影响加载。
 *   同一个规则也解释了 `__pycache__` —— 它以 "_" 开头，放在扩展根目录一样
 *   会让 Chrome 拒载整个扩展。
 *
 * 为什么会踩：
 *   预览生成器 `_preview_gen.js` 以前就放在根目录，产物也写在根目录
 *   （`_preview_sidepanel.html`）。它是「用完即删」的一次性工具，
 *   结果某次跑完没删干净，就留在那儿了 —— 用户下一次加载扩展直接失败。
 *
 * 这个测试的作用：**在提交前就拦住**。只要根目录出现不该有的 "_" 开头条目，
 * npm test 立刻失败，错误信息直接告诉你是哪个文件。
 *
 * 顺带查 manifest 引用的文件是否都存在 —— 「改了 manifest 但文件没加」
 * 是同一类"用户装上才发现"的坑。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Chrome 自己的目录：manifest 声明了 DNR 静态规则集时，Chrome 会把编译后的
// 规则集写进 <扩展根目录>/_metadata/。它以 "_" 开头，但 Chrome 允许它存在
// （实测加载与运行都正常）—— 所以不能算违规。
const CHROME_OWNED = "_metadata";

// ---------- 迷你断言框架（沿用仓库里其它测试的写法） ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assertEqual ${label}\n  expected: ${e}\n  actual:   ${a}`);
}

console.log("\n[1] 扩展根目录不能有 _ 开头的条目（否则 Chrome 拒载整个扩展）");

const topEntries = fs.readdirSync(ROOT, { withFileTypes: true });
const underscoreEntries = topEntries
  .filter((e) => e.name.startsWith("_"))
  .map((e) => e.name);

// `_metadata` 是 Chrome 自己写的，不算违规 —— 但要说清楚它是什么，
// 免得以后有人"顺手清理"把它删了，弄坏 DNR 规则。
const chromeOwned = underscoreEntries.filter((n) => n === CHROME_OWNED);
const violations = underscoreEntries.filter((n) => n !== CHROME_OWNED);

if (violations.length) {
  console.log("  根目录下的违规 _ 开头条目：");
  for (const n of violations) console.log(`    - ${n}`);
  console.log("");
  console.log("  Chrome 会拒绝加载整个扩展。处理办法：");
  console.log("    · 一次性产物 → 删掉，或搬进 bilidown-tests/");
  console.log("    · 开发工具  → 搬到 bilidown-tests/ 再运行，产物也写在那里");
  console.log("    · Python 缓存 → 删掉 __pycache__（同一个 '_' 规则）");
}
record(
  "根目录没有 _ 开头的文件或目录（_metadata 除外）",
  violations.length === 0,
  violations.length ? violations.join(", ") : ""
);

// __pycache__ 是同一个坑的常见形态，单列一条，错误信息更明确
const hasPycache = fs.existsSync(path.join(ROOT, "__pycache__"));
record("根目录没有 __pycache__（Chrome 拒载的常见原因）", !hasPycache);

if (chromeOwned.length) {
  console.log("");
  console.log(`  ℹ️  根目录有 ${chromeOwned.join(", ")} —— 那是 Chrome 自己写的`);
  console.log("     （DNR 静态规则集的编译产物，manifest 声明了 declarative_net_request）。");
  console.log("     Chrome 允许它存在，实测不影响加载；**别删** —— 删了已加载扩展的");
  console.log("     DNR 规则会失效，直到 Chrome 重新编译。");
}

console.log("\n[2] 扩展根目录结构");

record("manifest.json 在根目录", fs.existsSync(path.join(ROOT, "manifest.json")));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
record("manifest.json 能解析（JSON 合法）", !!manifest && !!manifest.manifest_version);

console.log("\n[3] manifest 引用的文件必须都存在");

// 把 manifest 里所有指向本地文件的引用收集起来
const referenced = new Set();
const add = (p) => {
  if (typeof p === "string" && p && !/^(https?:|data:|\*)/.test(p)) referenced.add(p);
};

add(manifest.background && manifest.background.service_worker);
if (manifest.background && manifest.background.page) add(manifest.background.page);
(manifest.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach(add);
  (cs.css || []).forEach(add);
});
if (manifest.side_panel) {
  add(manifest.side_panel.default_path);
  (manifest.side_panel.paths || []).forEach(add);
}
if (manifest.options_page) add(manifest.options_page);
if (manifest.options_ui && manifest.options_ui.page) add(manifest.options_ui.page);
if (manifest.action && manifest.action.default_popup) add(manifest.action.default_popup);
if (manifest.devtools_page) add(manifest.devtools_page);
(manifest.web_accessible_resources || []).forEach((war) => {
  (war.resources || []).forEach(add);
});

const missing = [...referenced].filter((p) => !fs.existsSync(path.join(ROOT, p)));
record(
  `manifest 引用的 ${referenced.size} 个文件都存在`,
  missing.length === 0,
  missing.length ? "缺失: " + missing.join(", ") : ""
);

// manifest 引用的文件也不许以 "_" 开头（那样扩展能加载，但运行时才炸）
const underscoreRefs = [...referenced].filter((p) => path.basename(p).startsWith("_"));
record(
  "manifest 引用的文件不以 _ 开头",
  underscoreRefs.length === 0,
  underscoreRefs.length ? underscoreRefs.join(", ") : ""
);

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`==== ${results.length - failed.length}/${results.length} checks passed ====`);
  console.log("");
  console.log("❌ 扩展加载不了 —— 请先修掉上面的 FAIL 再提交。");
  console.log("   Chrome 报错原文：Cannot load extension with file or directory name X.");
  console.log("   Filenames starting with \"_\" are reserved for use by the system.");
  process.exit(1);
}
console.log(`==== ${results.length}/${results.length} checks passed ====`);
