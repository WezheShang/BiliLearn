/**
 * 「启动 whisper server」必须认端口 —— 回归测试（2026-11-06）。
 *
 * 背景：扩展的 whisperUrl 会被 repairWhisperServer 切到**备用端口** 7861
 * （当默认端口 7860 上跑的是旧代码时：旧代码不解析本地 HF 缓存，每次都去
 * huggingface.co 下载 → 本机直连不通 → ConnectTimeout → 转写必 500）。
 *
 * 这时设置页/向导里的「启动 server」按钮如果还只会把 server 拉在 7860，
 * 用户点一次启动 → server 起来了 → 扩展却还连着 7861（没人监听）→ 面板
 * 还是说「没在跑」→ 死循环。
 *
 * 所以三处必须对齐：
 *   1. launcher 的 launch 命令要认 port（设 BILILEARN_WHISPER_PORT）
 *   2. background 的 launchWhisperServerOnce 要把当前配置的端口传过去
 *   3. .ps1 文件必须保持纯 ASCII —— PowerShell 5.1 读无 BOM 的 .ps1 时
 *      按 ANSI(GBK) 解码，中文注释会被解成乱码并**导致整个脚本解析失败**，
 *      native host 直接罢工（实测 5 个解析错误）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

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

const backgroundSource = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const launcherPs1 = fs.readFileSync(path.join(ROOT, "bililearn_whisper_launcher.ps1"), "utf8");
const serverBat = fs.readFileSync(path.join(ROOT, "start_whisper_server.bat"), "utf8");
const silentVbs = fs.readFileSync(path.join(ROOT, "start_whisper_server_silent.vbs"), "utf8");

console.log("\n[1] native launcher —— launch 命令要认端口");
{
  // 1) launch 分支里设置 BILILEARN_WHISPER_PORT
  const launchIdx = launcherPs1.indexOf("$cmd -eq 'launch'");
  const restartIdx = launcherPs1.indexOf("$cmd -eq 'restart'");
  assertTrue(launchIdx > 0, "找得到 launch 分支");
  assertTrue(restartIdx > launchIdx, "launch 分支在 restart 分支之前");
  const launchSeg = launcherPs1.slice(launchIdx, restartIdx);
  assertTrue(
    launchSeg.includes("BILILEARN_WHISPER_PORT"),
    "launch 分支要设 BILILEARN_WHISPER_PORT（server 才知道绑哪个端口）",
  );
  assertTrue(
    /\$msg\.port/.test(launchSeg),
    "launch 分支要读消息里的 port",
  );
  // 2) 旧的 restart 分支不能被改坏
  const restartSeg = launcherPs1.slice(restartIdx);
  assertTrue(
    restartSeg.includes("BILILEARN_WHISPER_PORT"),
    "restart 分支仍然设 BILILEARN_WHISPER_PORT",
  );
  record("1.1 launcher 的 launch 认端口", true);
}

console.log("\n[2] .ps1 / .bat / .vbs 必须是纯 ASCII（老解释器按 ANSI 读无 BOM 文件）");
{
  const nonAscii = [...launcherPs1].filter((ch) => ch.codePointAt(0) > 127);
  assertTrue(
    nonAscii.length <= 8,
    `launcher .ps1 里的非 ASCII 字符要控制在个位数（实际 ${nonAscii.length}）—— ` +
      "中文注释会被 GBK 解成乱码并让整个 native host 解析失败",
  );
  // 仓库里其它 .ps1 也应该都干净 —— 顺手全查一遍
  const ps1Files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".ps1"));
  for (const f of ps1Files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const bad = [...src].filter((ch) => ch.codePointAt(0) > 127).length;
    assertTrue(bad <= 8, `${f} 里的非 ASCII 字符过多（${bad}）`);
  }
  record(`2.1 ${ps1Files.length} 个 .ps1 全部保持 ASCII 注释`, true);

  // cmd.exe 读 .bat 按 OEM 代码页（中文系统 = GBK）；wscript 读 .vbs 按 ANSI。
  // 注释里的非 ASCII 字节会被解成乱码，某些字节组合还会让 cmd 的块解析
  // 直接报 ": was unexpected at this time."。
  assertTrue(
    [...serverBat].filter((ch) => ch.codePointAt(0) > 127).length === 0,
    "start_whisper_server.bat 必须是纯 ASCII",
  );
  assertTrue(
    [...silentVbs].filter((ch) => ch.codePointAt(0) > 127).length === 0,
    "start_whisper_server_silent.vbs 必须是纯 ASCII",
  );
  record("2.2 .bat / .vbs 保持纯 ASCII（cmd / wscript 按 ANSI 读）", true);
}

console.log("\n[3] background.js —— 启动时把当前端口传过去 + 自愈回 7860");
{
  // 1) 端口解析helper
  assertTrue(
    /function portFromWhisperUrl\(/.test(backgroundSource),
    "有 portFromWhisperUrl 辅助函数",
  );
  // 2) launchWhisperServerOnce 要传 port
  const idx = backgroundSource.indexOf('message.action === "launchWhisperServerOnce"');
  assertTrue(idx > 0, "找得到 launchWhisperServerOnce");
  const seg = backgroundSource.slice(idx, idx + 3500);
  assertTrue(
    /sendNativeLaunch\(\{\s*cmd:\s*"launch",\s*port:\s*configuredPort\s*\}\)/.test(seg),
    "启动时把配置端口传给 native host",
  );
  assertTrue(
    /configuredPort\s*=\s*portFromWhisperUrl\(/.test(seg),
    "端口从当前 whisperUrl 解析出来",
  );
  // 3) 自愈：7860 上跑的是新代码就切回去
  assertTrue(
    /http:\/\/127\.0\.0\.1:7860\/health/.test(seg),
    "启动前会探默认端口 7860",
  );
  assertTrue(
    /model_resolution/.test(seg) && /setSettings\(\{\s*whisperUrl/.test(seg),
    "7860 上是���代码（新代码标志 model_resolution）就把 whisperUrl 切回去",
  );
  record("3.1 启动路径端口感知 + 自愈", true);
}

console.log("\n[4] start_whisper_server.bat —— 日志按端口分级 + 修掉 cmd 的括号解析 bug");
{
  // 4) 端口从环境变量来，日志按端口分级
  assertTrue(
    /BILILEARN_WHISPER_PORT/.test(serverBat),
    "bat 从 BILILEARN_WHISPER_PORT 读端口",
  );
  assertTrue(
    /whisper_server_%WHISPER_PORT%\.log/.test(serverBat),
    "非默认端口用独立的日志文件（避免两个实例抢同一个文件）",
  );
  // 4b) 错误分支不能再用 "if errorlevel 1 ( ... )" 块
  //     cmd.exe 解析块时会数括号 —— 块里那条 python -c 带了
  //     "(no log file)"，块被提前截断，cmd 直接报
  //     ": was unexpected at this time."，真正的错误被吞掉。
  //     （只看真正执行的行，REM 注释里提到这个写法不算）
  const batCode = serverBat
    .split(/\r?\n/)
    .filter((line) => !/^\s*REM\b/i.test(line))
    .join("\n");
  assertTrue(
    !/if errorlevel 1 \(/.test(batCode),
    "错误分支不能用带括号的块（cmd 的括号解析 bug）",
  );
  assertTrue(
    /if errorlevel 1 goto :failed/.test(batCode),
    "错误分支用 goto + 平铺标签",
  );
  record("4.1 bat 日志按端口分级 + 错误分支不再被 cmd 截断", true);
}

console.log("\n[5] start_whisper_server_silent.vbs —— 端口靠环境变量一路传下去");
{
  assertTrue(
    /cmd \/c/.test(silentVbs) && /--log/.test(silentVbs),
    "vbs 仍然跑 bat 的 --log 模式",
  );
  assertTrue(
    /BILILEARN_WHISPER_PORT/.test(silentVbs),
    "vbs 说明端口靠环境变量继承（wscript → cmd → bat → python）",
  );
  record("5.1 vbs 链路说明与实际行为一致", true);
}

console.log("\n[6] settings 页语言偏好要有兜底（中文用户别被迫看英文页）");
{
  const optionsSource = fs.readFileSync(path.join(ROOT, "options.js"), "utf8");
  assertTrue(
    /LEGACY_LANGUAGE_STORAGE_KEY\s*=\s*"language"/.test(optionsSource),
    "认得老版本写的顶层 language key",
  );
  assertTrue(
    /readPreferredLanguage[\s\S]{0,1200}LEGACY_LANGUAGE_STORAGE_KEY/.test(optionsSource),
    "读语言偏好时会一起读老 key",
  );
  assertTrue(
    /detectBrowserLanguage/.test(optionsSource),
    "两个 key 都没有时跟随浏览器界面语言",
  );
  assertTrue(
    /readPreferredLanguage[\s\S]{0,1500}persistPreferredLanguage\(storage, legacy\)/.test(
      optionsSource,
    ),
    "老 key 里选过的语言会迁移到新 key（别再丢一次）",
  );
  record("6.1 语言偏好：新 key → 老 key → 浏览器语言", true);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} 通过`,
);
if (failed.length) {
  failed.forEach((f) => console.log(`   x ${f.name}`));
  process.exit(1);
}
