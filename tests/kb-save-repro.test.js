// tests/kb-save-repro.test.js — 复现 settings 保存后重新打开 KB enabled 丢失
const fs = require("fs");
const path = require("path");

global.self = global;
global.YTD_SETTINGS = {
  STORAGE_KEY: "ytd_settings",
  normalize: (x) => x || {},
};
global.KbShared = { KB_BUILD_METHODS: ["karpathy", "nvwa", "raw"], sanitizeKbName: (s) => s };
global.KbClient = { setBaseUrl: () => {}, health: async () => null, list: async () => [], queue: async () => [], read: async () => ({content:"{}"}), write: async () => ({ok:true}), deletePath: async () => ({ok:true}), move: async () => ({ok:true}), pickRoot: async () => ({path:null}) };

const storage = { ytd_settings: {} };
let writeLog = [];
global.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: storage[k] }),
      set: async (o) => {
        writeLog.push(JSON.parse(JSON.stringify(o)));
        Object.assign(storage, o);
      },
    },
  },
  runtime: { sendMessage: async () => ({ok:true, consumed:0}) },
};

const makeEl = (id) => {
  const el = {
    id,
    children: [],
    style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._on = this._on || {})[ev] = fn; },
    async _fire(ev, ...args) { if (this._on && this._on[ev]) await this._on[ev](...args); },
    set value(v) { this._value = v; }, get value() { return this._value; },
    set checked(v) { this._checked = v; }, get checked() { return this._checked; },
    set innerHTML(v) { this._innerHTML = v; this.children.length = 0; },
    get innerHTML() { return this._innerHTML || ""; },
  };
  return el;
};
const ids = ["kbEnabled","kbRootDir","kbUpdateMode","kbRunNowBtn","kbBrowseBtn","kbRescanBtn","kbListTable","kbListBody","kbFailedList","kbFailedBlock"];
const dom = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
const byId = (id) => dom[id];
global.document = { getElementById: byId, addEventListener: () => {}, querySelector: () => null, createElement: makeEl };

const src = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const startIdx = src.indexOf("// KB management module");
const kbSrc = src.slice(startIdx);
eval(kbSrc);

setTimeout(async () => {
  // 模拟用户：开 checkbox → handler 调 pickRoot → 输入路径 → savePatch({kbEnabled:true, kbRootDir:root})
  console.log("INIT: enabled checkbox =", dom.kbEnabled.checked, "kbRootDir =", dom.kbRootDir.value);
  dom.kbEnabled.checked = true;
  dom.kbRootDir.value = "C:/Users/test/KB";
  await dom.kbEnabled._fire("change");
  console.log("AFTER change handler:");
  console.log("  storage.ytd_settings =", JSON.stringify(storage.ytd_settings));
  console.log("  dom.kbEnabled.checked =", dom.kbEnabled.checked);
  console.log("  dom.kbRootDir.value =", dom.kbRootDir.value);
  console.log("  writes log entries =", writeLog.length);

  // 模拟「再次进入 settings」: 重新渲染（直接再调 render）
  console.log("\n--- simulate second visit ---");
  // 强制重渲染: 清空 DOM 状态
  dom.kbEnabled.checked = false;
  // 重新跑 init IIFE（模拟第二次打开 options.html）
  eval(kbSrc);
  setTimeout(() => {
    console.log("AFTER re-init:");
    console.log("  storage.ytd_settings =", JSON.stringify(storage.ytd_settings));
    console.log("  dom.kbEnabled.checked =", dom.kbEnabled.checked);
    console.log("  dom.kbRootDir.value =", dom.kbRootDir.value);
    process.exit(0);
  }, 200);
}, 200);
