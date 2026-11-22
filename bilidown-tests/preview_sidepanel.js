/**
 * sidepanel 预览生成器 —— 给 sidepanel.html 注入一个 chrome stub，
 * 让它能在普通 file:// 页面里跑起来，方便用浏览器肉眼验证底栏 + 抽屉。
 *
 * ⚠️ 为什么这个文件不在扩展根目录（2026-11-22）：
 *   Chrome 加载 unpacked 扩展时，**根目录下任何以 "_" 开头的文件或目录都会
 *   让整个扩展加载失败**，报 "Cannot load extension with file or directory
 *   name _xxx. Filenames starting with "_" are reserved for use by the system."
 *   （子目录不受影响 —— 只查顶层。）
 *   这个生成器以前就放在根目录，产物也写在根目录（`_preview_sidepanel.html`），
 *   一跑就把扩展搞到加载不了。现在生成器放在开发目录，产物也写在这里。
 *
 *   用法：node bilidown-tests/preview_sidepanel.js
 *   产物：bilidown-tests/_preview_sidepanel.html（双击用浏览器打开即可）
 */
const fs = require("fs");
const path = require("path");

// 扩展根目录（开发目录的上一级）
const ROOT = path.resolve(__dirname, "..");
// 产物写在自己旁边 —— 绝不写进扩展根目录
const OUT = path.join(__dirname, "_preview_sidepanel.html");

let html = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");

const stub = `
<script>
(function () {
  const store = {
    ytd_settings: {
      provider: "deepseek",
      deepseekApiKey: "dk-test",
      minimaxApiKey: "mm-test",
      glmApiKey: "",
      kbEnabled: false,
    },
  };
  const noop = { addListener() {}, removeListener() {}, hasListener: () => false };
  const local = {
    get: (k, cb) => {
      const v = typeof k === "string" ? store[k] : { ...store };
      if (typeof cb === "function") cb(v);
      return Promise.resolve(v);
    },
    set: (o, cb) => { Object.assign(store, o); if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (k, cb) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  window.chrome = {
    storage: { local, session: local, sync: local, onChanged: noop },
    runtime: {
      sendMessage: (m) => (m && m.action === "checkConfig" ? Promise.resolve({ hasApiKey: true }) : Promise.resolve({})),
      onMessage: { addListener() {} }, onInstalled: noop, onStartup: noop, onConnect: noop, onSuspend: noop,
      getURL: (p) => p, openOptionsPage() {}, getManifest: () => ({ version: "1.0" }),
    },
    tabs: { query: () => Promise.resolve([]), create: () => Promise.resolve({ id: 1 }), sendMessage: () => Promise.resolve({}), onUpdated: noop, onRemoved: noop, onActivated: noop },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }), create: () => Promise.resolve({ id: 1 }), onFocusChanged: noop, WINDOW_ID_NONE: -1 },
    alarms: { create() {}, clear: () => Promise.resolve(true), getAll: () => Promise.resolve([]), onAlarm: noop },
    notifications: { create() {}, onClicked: noop },
    downloads: { download: (o, cb) => { if (cb) cb(1); return 1; }, open() {}, onChanged: noop, search: (q, cb) => { if (cb) cb([]); } },
    commands: { onCommand: noop }, contextMenus: { create() {}, removeAll: () => Promise.resolve(), onClicked: noop },
    action: { setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve(), onClicked: noop },
    scripting: { executeScript: () => Promise.resolve([]) },
    sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve(), open: () => Promise.resolve() },
    i18n: { getUILanguage: () => "zh-CN", getMessage: (k) => k },
    permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(false) },
  };
  window.fetch = () => Promise.reject(new Error("offline preview"));
})();
</script>
`;

html = html.replace('<link rel="stylesheet" href="sidepanel.css" />', stub + '\n    <link rel="stylesheet" href="sidepanel.css" />');
fs.writeFileSync(OUT, html, "utf8");
console.log("wrote " + OUT);
