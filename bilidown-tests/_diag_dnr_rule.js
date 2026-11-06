// Test the REAL DNR rule regex (read from the file Chrome will load).
const fs = require("fs");
const path = require("path");

const rulePath = path.join(__dirname, "..", "rules", "bililearn-audio.json");
const rules = JSON.parse(fs.readFileSync(rulePath, "utf8"));
const filter = rules[0].condition.regexFilter;
console.log("regexFilter:", filter);
console.log("length:", filter.length, "(DNR limit is 2048)");

// RE2-style semantics; JS RegExp is close enough for these patterns.
const re = new RegExp(filter);

const urls = [
  "https://xy106x41x209x207xy.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/99/91/x.m4s?a=1",
  "https://upos-sz-mirrorcos.bilivideo.com/v1/resource/upgcxcode/x.m4s",
  "https://upos-sz-mirrorcos.bilivideo.com:8082/v1/x.m4s",
  "https://cn-hangzhou-cs-1.bilivideo.com/v1/x.m4s",
  "https://upos-sz-mirrorcoso1.bilivideo.com/v1/x.m4s",
  "https://xy1a2b3c4.mcdn.bilivideo.cn:8082/v1/x.m4s",
  "https://x.akamaized.net/hls/x.m4s",
  "https://i0.hdslb.com/bfs/archive/x.m4s",
  "https://i0.hdslb.com:8080/bfs/archive/x.m4s",
];

let bad = 0;
for (const u of urls) {
  const hit = re.test(u);
  if (!hit) bad++;
  console.log(`  ${hit ? "MATCH" : "MISS "}  ${u}`);
}

// Hosts that must NOT be touched.
const untouched = [
  "https://api.bilibili.com/x/player/playurl?bvid=x",
  "https://www.bilibili.com/video/BV1x",
  "https://127.0.0.1:7860/transcribe",
  "https://api.minimaxi.com/v1/chat",
];
for (const u of untouched) {
  const hit = re.test(u);
  if (hit) bad++;
  console.log(`  ${hit ? "MATCH(!)" : "skip  "}  ${u}`);
}

console.log(bad === 0 ? "\nALL OK" : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
