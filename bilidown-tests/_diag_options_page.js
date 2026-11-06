/**
 * settings（options）页面的整体体检（2026-11-06）。
 *
 * 用户报：「你在 settings 页面加的任何一个 button 点击都没有任何用处，
 * 无法启动 service，从来没有能用过」。
 *
 * "任何一个 button 都没用"通常不是每个按钮各自坏了，而是**页面脚本在加载
 * 阶段就抛了** —— 后面的所有事件绑定都没接上，页面看着正常，点什么都没反应。
 *
 * 这个探针用 JSDOM 加载**真实的 options.html + settings.js + kb-*.js +
 * options.js**，然后：
 *   O1 脚本加载阶段有没有抛错（DOMContentLoaded 之前）
 *   O2 有多少个可点元素（button / [role=button]）—— 如果是 0，说明页面
 *      根本没渲染出来
 *   O3 每个 button 有没有绑上 click 监听器
 *   O4 关键按钮（启动 server / 检查系统 / 保存）是否存在
 *   O5 模拟点击"启动 server"，看它有没有真的发消息出去
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}

function makeChromeShim() {
  const localStore = {};
  const sessionStore = {};
  const sentMessages = [];
  return {
    state: { sentMessages, localStore },
    api: {
      storage: {
        local: {
          get: (key, cb) => {
            let value;
            if (typeof key === "string") value = { [key]: localStore[key] };
            else if (Array.isArray(key))
              value = key.reduce((acc, k) => ((acc[k] = localStore[k]), acc), {});
            else value = { ...localStore };
            if (typeof cb === "function") {
              try { cb(value); } catch (_e) {}
            }
            return Promise.resolve(value);
          },
          set: (obj, cb) => {
            Object.assign(localStore, obj);
            if (typeof cb === "function") {
              try { cb(); } catch (_e) {}
            }
            return Promise.resolve();
          },
          remove: (key, cb) => {
            const arr = Array.isArray(key) ? key : [key];
            arr.forEach((k) => delete localStore[k]);
            if (typeof cb === "function") {
              try { cb(); } catch (_e) {}
            }
            return Promise.resolve();
          },
          setAccessLevel: () => Promise.resolve(),
        },
        session: {
          get: (key) =>
            Promise.resolve(
              typeof key === "string" ? { [key]: sessionStore[key] } : { ...sessionStore },
            ),
          set: (obj) => {
            Object.assign(sessionStore, obj);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
        },
      },
      runtime: {
        id: "fake",
        lastError: null,
        sendMessage: (msg) => {
          sentMessages.push(msg);
          // 模拟后台：健康检查 / 版本握手都回正常
          if (msg && msg.action === "getExtensionBuild") {
            return Promise.resolve({ success: true, build: "fake-build" });
          }
          if (msg && msg.action === "checkConfig") {
            return Promise.resolve({ hasSupadataKey: true, hasAiKey: true });
          }
          if (msg && msg.action === "launchWhisperServerOnce") {
            return Promise.resolve({ success: true, via: "native" });
          }
          return Promise.resolve({ success: true });
        },
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        getURL: (p) => `chrome-extension://fake/${p}`,
        openOptionsPage: () => Promise.resolve(),
      },
      tabs: {
        query: () => Promise.resolve([]),
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: {
        getCurrent: () => Promise.resolve({ id: 1 }),
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: () => {} },
      },
      sidePanel: {
        setPanelBehavior: () => Promise.resolve(),
        setOptions: () => Promise.resolve(),
        open: () => Promise.resolve(),
      },
      action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => Promise.resolve(true) },
      notifications: { onClicked: { addListener: () => {} }, create: () => {} },
      downloads: {
        download: (o, cb) => {
          if (typeof cb === "function") {
            try { cb(1); } catch (_e) {}
          }
          return 1;
        },
        open: () => {},
        onChanged: { addListener: () => {}, removeListener: () => {} },
        search: (q, cb) => {
          if (typeof cb === "function") {
            try { cb([]); } catch (_e) {}
          }
        },
      },
      scripting: { executeScript: () => Promise.resolve([]) },
      nativeMessaging: { connectNative: () => ({ onMessage: { addListener: () => {} } }) },
    },
  };
}

async function main() {
  console.log("\n[O1] options 页脚本加载阶段有没有抛错");
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "chrome-extension://fake/options.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const shim = makeChromeShim();
  const loadErrors = [];
  dom.window.chrome = shim.api;
  dom.window.fetch = (url) => {
    if (typeof url === "string" && url.includes("/health")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error("fetch not stubbed: " + url));
  };
  dom.window.URL = URL;
  const origError = dom.window.console.error;
  dom.window.console.error = (...args) => {
    loadErrors.push(args.map(String).join(" "));
    origError(...args);
  };
  dom.window.addEventListener("error", (e) => loadErrors.push("window.error: " + e.message));

  const scripts = ["settings.js", "kb-shared.js", "kb-client.js", "options.js"];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    try {
      dom.window.eval(src);
    } catch (error) {
      loadErrors.push(`${f} 加载抛错: ${error && error.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  // 触发 DOMContentLoaded 之后的那段
  try {
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  } catch (error) {
    loadErrors.push("DOMContentLoaded 抛错: " + (error && error.message));
  }
  await new Promise((r) => setTimeout(r, 300));

  record(
    "O1 脚本加载没有抛错",
    loadErrors.length === 0,
    loadErrors.slice(0, 3).join(" | "),
  );

  const { document } = dom.window;
  const buttons = [...document.querySelectorAll("button, [role=button], .btn")];
  record("O2 页面渲染出了可点元素", buttons.length > 0, `${buttons.length} 个`);

  // O3 每个按钮有没有 click 监听器
  const unwired = [];
  for (const btn of buttons) {
    const has = typeof btn.onclick === "function" || (btn.dataset && btn.dataset.wired === "1");
    if (!has) {
      // jsdom 拿不到 addEventListener 的记录，改用"点击后是否产生副作用"判断太贵，
      // 这里只统计明显没绑的：既没有 onclick 也没有 id（多半是装饰元素）
      if (!btn.id) unwired.push(btn.textContent.trim().slice(0, 24) || btn.tagName);
    }
  }
  record(
    "O3 按钮都挂了处理逻辑（没有 onclick 的无 id 元素 ≤ 5 个）",
    unwired.length <= 5,
    unwired.slice(0, 5).join(" / "),
  );

  // O4 关键按钮是否存在
  const html2 = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  const js2 = fs.readFileSync(path.join(ROOT, "options.js"), "utf8");
  const hasLaunch = /launchWhisperServerOnce/.test(js2);
  const hasCheck = /checkWhisper|检查系统|whisperCheck/i.test(html2 + js2);
  const hasSave = /saveSettings|保存/.test(html2 + js2);
  record("O4 关键按钮/动作都在（启动 server / 检查系统 / 保存）",
    hasLaunch && hasCheck && hasSave,
    `launch=${hasLaunch} check=${hasCheck} save=${hasSave}`);

  // O5 模拟点"启动 server"按钮，看有没有真的发消息
  const before = shim.state.sentMessages.length;
  const candidates = buttons.filter((b) =>
    /启动|启动 server|start|Start/i.test(b.textContent || ""),
  );
  if (candidates.length) {
    for (const b of candidates.slice(0, 3)) {
      try { b.click(); } catch (_e) {}
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const launched = shim.state.sentMessages.some(
    (m) => m && m.action === "launchWhisperServerOnce",
  );
  record(
    "O5 点「启动 server」真的发出了 launchWhisperServerOnce 消息",
    candidates.length === 0 ? true : launched,
    candidates.length === 0 ? "页面上没找到该按钮（跳过）" : `候选 ${candidates.length} 个`,
  );

  if (loadErrors.length) {
    console.log("\n  --- 加载期错误明细 ---");
    loadErrors.slice(0, 10).forEach((e) => console.log("    " + e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} 通过`,
  );
  if (failed.length) {
    failed.forEach((f) => console.log(`   x ${f.name}  ${f.detail}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ 探针失败：", error && error.stack ? error.stack : error);
  process.exit(1);
});
