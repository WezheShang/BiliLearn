// tests/kb-render-repro.test.js — 复现 options.js initKbManager 的并发竞态
// 跑: node tests/kb-render-repro.test.js
const fs = require("fs");
const path = require("path");

// minimal jsdom-less mock: 我们手工建一个 body + 拦截 KbClient/KbShared/YTD_SETTINGS/chrome
global.self = global;
global.YTD_SETTINGS = {
  STORAGE_KEY: "ytd_settings",
  normalize: (x) => x || {},
};
global.KbShared = { KB_BUILD_METHODS: ["karpathy", "nvwa", "raw"], sanitizeKbName: (s) => s };
global.KbClient = {
  _health: true,
  setBaseUrl: () => {},
  async health() { return this._health ? {ok:true} : null; },
  async list(root) {
    // 返回 4 个 KB
    return [
      {name:"output", dir: root + "\\output", has_kb_json:false, build_method:null, video_count:0, pending_count:0},
      {name:"up_1039025435", dir: root + "\\up_1039025435", has_kb_json:false, build_method:null, video_count:0, pending_count:0},
      {name:"up_131580584", dir: root + "\\up_131580584", has_kb_json:false, build_method:null, video_count:0, pending_count:0},
      {name:"up_1584562031", dir: root + "\\up_1584562031", has_kb_json:false, build_method:null, video_count:0, pending_count:0},
    ];
  },
  async queue() { return []; },
  async read() { return {content: "{}"}; },
  async write() { return {ok:true}; },
  async deletePath() { return {ok:true}; },
  async move() { return {ok:true}; },
  async pickRoot() { return {path:null}; },
};

const storage = { ytd_settings: { kbEnabled: true, kbRootDir: "C:/fake", kbUpdateMode: "realtime" } };
global.chrome = {
  storage: { local: { get: async (k) => ({ [k]: storage[k] }), set: async (o) => Object.assign(storage, o) } },
  runtime: { sendMessage: async () => ({ok:true, consumed:0}) },
};

// 模拟 DOM 节点
const makeEl = (id) => {
  const children = [];
  const el = {
    id, children,
    style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} },
    set innerHTML(v) { this._innerHTML = v; this.children.length = 0; },
    get innerHTML() { return this._innerHTML || ""; },
    appendChild(c) { children.push(c); return c; },
  append(...nodes) { nodes.forEach((n) => children.push(n)); return this; },
  prepend(c) { children.unshift(c); return c; },
    addEventListener(ev, fn) { this._on = this._on || {}; this._on[ev] = fn; },
    async _fire(ev, ...args) { if (this._on && this._on[ev]) await this._on[ev](...args); },
    set value(v) { this._value = v; }, get value() { return this._value; },
    set checked(v) { this._checked = v; }, get checked() { return this._checked; },
  };
  return el;
};
const ids = ["kbEnabled","kbRootDir","kbUpdateMode","kbRunNowBtn","kbBrowseBtn","kbRescanBtn","kbListTable","kbListBody","kbFailedList","kbFailedBlock"];
const dom = Object.fromEntries(ids.map(id => [id, makeEl(id)]));
const byId = (id) => dom[id];
global.document = {
  getElementById: byId,
  addEventListener: () => {},
  querySelector: () => null,
  createElement: (tag) => {
    const el = makeEl(undefined);
    el.tagName = tag.toUpperCase();
    el.appendChild = ((orig) => (c) => { el.children.push(c); return c; })(el.appendChild);
    return el;
  },
};
global.window = { prompt: () => null, confirm: () => false, alert: () => {} };

// 跑 initKbManager IIFE
const src = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
// 切掉最后的 IIFE 块: 从 "// KB management module" 开始的所有
const startIdx = src.indexOf("// KB management module");
if (startIdx < 0) throw new Error("initKbManager block not found");
const kbSrc = src.slice(startIdx);
eval(kbSrc);

// 等待 async init 跑完
setTimeout(() => {
  console.log("kbListBody children:", dom.kbListBody.children.length);
  console.log("expected: 4 (server returns 4 KBs)");
  process.exit(dom.kbListBody.children.length === 4 ? 0 : 1);
}, 200);
