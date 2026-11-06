// tests/kb-save-repro2.test.js — 模拟用户在 KB enabled=true 时点 Save settings
const fs = require("fs");
const path = require("path");

global.self = global;
global.YTD_SETTINGS = {
  STORAGE_KEY: "ytd_settings",
  normalize: (x) => x || {},
  activeApiKey: () => "fake-key",
  DEFAULTS: {},
};
global.KbShared = { KB_BUILD_METHODS: ["karpathy", "nvwa", "raw"], sanitizeKbName: (s) => s };
global.KbClient = { setBaseUrl: () => {}, health: async () => null, list: async () => [], queue: async () => [], read: async () => ({content:"{}"}), write: async () => ({ok:true}), deletePath: async () => ({ok:true}), move: async () => ({ok:true}), pickRoot: async () => ({path:null}) };

const storage = { ytd_settings: { kbEnabled: true, kbRootDir: "C:/test/KB", kbUpdateMode: "realtime" } };
global.chrome = {
  storage: { local: { get: async (k) => ({ [k]: storage[k] }), set: async (o) => Object.assign(storage, o) } },
  runtime: { sendMessage: async () => ({ok:true, consumed:0}) },
};

const src = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
const startIdx = src.indexOf("const YTD_OPTIONS = (() =>");
const ytdSrc = src.slice(0, src.indexOf("// ============================================================\n// KB management module"));
eval(ytdSrc); // 这会把 YTD_OPTIONS 加载出来
console.log("YTD_OPTIONS keys:", Object.keys(YTD_OPTIONS || {}));
console.log("YTD_OPTIONS.normalize exists:", typeof (YTD_OPTIONS && YTD_OPTIONS.normalize));
console.log("YTD_OPTIONS.DEFAULTS.kbEnabled:", YTD_OPTIONS && YTD_OPTIONS.DEFAULTS && YTD_OPTIONS.DEFAULTS.kbEnabled);

// 直接调用 normalize 看实际行为
const normalized = YTD_OPTIONS.normalize(JSON.parse(JSON.stringify(storage.ytd_settings)));
console.log("normalized kbEnabled:", normalized.kbEnabled, "kbRootDir:", normalized.kbRootDir);
