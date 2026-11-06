/**
 * settings（options）页**逐个按钮**审计（2026-11-06）。
 *
 * 用户报：「你在 settings 页面加的任何一个 button 点击都没有任何用处」。
 * 这次不猜，把每一个按钮都点一遍，看它到底有没有产生可观察的效果：
 *   · 有没有真的发出 chrome.runtime.sendMessage
 *   · DOM 有没有变化（文案 / 状态行 / 新增卡片）
 *   · 有没有抛异常
 *
 * 判定「点了没反应」的标准：既没发消息、DOM 也没变、也没抛错。
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function makeStorage(seed) {
  const store = { ...seed };
  return {
    store,
    api: {
      get: (key, cb) => {
        let value;
        if (typeof key === "string") value = { [key]: store[key] };
        else if (Array.isArray(key))
          value = key.reduce((acc, k) => ((acc[k] = store[k]), acc), {});
        else value = { ...store };
        if (typeof cb === "function") {
          try { cb(value); } catch (_e) {}
        }
        return Promise.resolve(value);
      },
      set: (obj, cb) => {
        Object.assign(store, obj);
        if (typeof cb === "function") {
          try { cb(); } catch (_e) {}
        }
        return Promise.resolve();
      },
      remove: (key, cb) => {
        const arr = Array.isArray(key) ? key : [key];
        arr.forEach((k) => delete store[k]);
        if (typeof cb === "function") {
          try { cb(); } catch (_e) {}
        }
        return Promise.resolve();
      },
      setAccessLevel: () => Promise.resolve(),
    },
  };
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "chrome-extension://fake/options.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const sent = [];
  const errors = [];
  const storage = makeStorage({
    ytd_options_language: "zh-CN",
    ytd_options_first_run_dismissed: true,
    ytd_settings: {
      asrProvider: "whisper",
      whisperUrl: "http://127.0.0.1:7866",
      whisperModel: "base",
      subtitlesDir: "C:/tmp/BiliSubs",
      exportDir: "C:/tmp",
      aiApiKey: "",
      aiModel: "glm-4.6",
      aiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      language: "zh-CN",
      minimaxAsrApiKey: "",
      minimaxAsrModel: "asr-1.0",
      supadataApiKey: "",
    },
  });
  dom.window.chrome = {
    storage: { local: storage.api, session: makeStorage({}).api },
    runtime: {
      id: "fake",
      lastError: null,
      sendMessage: (msg) => {
        sent.push(msg);
        if (msg && msg.action === "getExtensionBuild") {
          return Promise.resolve({ success: true, build: "fake" });
        }
        if (msg && msg.action === "checkConfig") {
          return Promise.resolve({ hasSupadataKey: true, hasAiKey: true });
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
      create: (o) => { sent.push({ action: "__tabs.create", url: o && o.url }); },
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
        sent.push({ action: "__downloads.download", filename: o && o.filename });
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
  };
  dom.window.fetch = (url) => {
    // 探 /health 一律失败 → 走「server 不在」分支，按钮才会渲染出来
    if (typeof url === "string" && url.includes("/health")) {
      return Promise.reject(new Error("ECONNREFUSED"));
    }
    return Promise.reject(new Error("fetch not stubbed: " + url));
  };
  dom.window.URL = URL;
  dom.window.AbortController = AbortController;
  dom.window.console.error = (...a) => errors.push(a.map(String).join(" "));

  for (const f of ["settings.js", "kb-shared.js", "kb-client.js", "options.js"]) {
    try {
      dom.window.eval(fs.readFileSync(path.join(ROOT, f), "utf8"));
    } catch (e) {
      console.error(`加载 ${f} 抛错:`, e.message);
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 400));

  const doc = dom.window.document;
  // 触发一次「检查系统」，让依赖类按钮渲染出来
  const checkBtn = doc.getElementById("whisperCheckBtn");
  if (checkBtn) {
    checkBtn.click();
    await new Promise((r) => setTimeout(r, 800));
  }

  const buttons = [...doc.querySelectorAll("button")];
  console.log(`\n=== settings 页共 ${buttons.length} 个 button，逐个点 ===\n`);

  const dead = [];
  for (const btn of buttons) {
    const label = (btn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 46) || "(无文案)";
    const id = btn.id || "(无 id)";
    const before = sent.length;
    const domBefore = doc.body.innerHTML.length;
    const wasDisabled = btn.disabled;
    let threw = null;
    try {
      if (!wasDisabled) btn.click();
    } catch (e) {
      threw = e && e.message;
    }
    await new Promise((r) => setTimeout(r, 120));
    const sentNow = sent.slice(before);
    const domChanged = doc.body.innerHTML.length !== domBefore;
    const actions = sentNow.map((m) => (m && m.action) || "?").join(",");
    const effective = sentNow.length > 0 || domChanged || threw;
    const mark = effective ? "OK  " : "DEAD";
    console.log(
      `  [${mark}] ${label.padEnd(48)} id=${id.padEnd(26)} ` +
        `${actions || "(无消息)"}${domChanged ? " +DOM变了" : ""}${threw ? " 抛错:" + threw : ""}` +
        `${wasDisabled ? " (本来就是 disabled)" : ""}`,
    );
    if (!effective) dead.push({ label, id });
  }

  console.log(`\n点了完全没反应的按钮：${dead.length} 个`);
  dead.forEach((d) => console.log(`  x ${d.label}  (${d.id})`));
  console.log(`\n加载期错误：${errors.length} 条`);
  errors.slice(0, 5).forEach((e) => console.log("  " + e));
  process.exit(0);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
