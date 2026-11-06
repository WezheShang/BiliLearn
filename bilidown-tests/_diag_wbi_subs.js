// Compare B站 subtitle-list endpoints:
//   A. /x/player/v2       (unsigned, legacy)
//   B. /x/player/wbi/v2   (unsigned — what the extension actually calls)
//   C. /x/player/wbi/v2   (properly wbi-signed)
// Prints the subtitle track list for each.
const bvid = process.argv[2] || "BV1ed4b6rE5G";
const cid = process.argv[3] || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

async function j(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: `https://www.bilibili.com/video/${bvid}` },
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 200) };
  }
}

async function wbiKeys() {
  const nav = await j("https://api.bilibili.com/x/web-interface/nav");
  const wbi = nav.json?.data?.wbi_img;
  if (!wbi) return null;
  const img = wbi.img_url.split("/").pop().split(".")[0];
  const sub = wbi.sub_url.split("/").pop().split(".")[0];
  const raw = img + sub;
  return MIXIN_TAB.map((n) => raw[n]).join("").slice(0, 32);
}

function sign(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const q = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join("&");
  const raw = q + "&wts=" + wts;
  // md5
  const crypto = require("crypto");
  const hash = crypto.createHash("md5").update(raw).digest("hex");
  return `${q}&w_rid=${hash}&wts=${wts}`;
}

async function report(label, url) {
  const r = await j(url);
  const d = r.json?.data;
  const subs = d?.subtitle?.subtitles || [];
  console.log(`\n=== ${label} ===`);
  console.log("http:", r.status, "| code:", r.json?.code, r.json?.message || "");
  console.log("need_login_subtitle:", d?.need_login_subtitle, "| tracks:", subs.length);
  for (const s of subs) {
    console.log(
      `   lan=${s.lan} lan_doc=${s.lan_doc} ai_status=${s.ai_status} ai_type=${s.ai_type} ` +
        `url=${(s.subtitle_url || "").slice(0, 70)}`,
    );
  }
  if (!subs.length) {
    console.log("   (no subtitle track list in this response)");
  }
  return r;
}

async function main() {
  let cidArg = cid;
  if (!cidArg) {
    const view = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    cidArg = view.json?.data?.cid;
    console.log("cid:", cidArg);
  }
  const base = `bvid=${bvid}&cid=${cidArg}`;

  await report("A. /x/player/v2 (unsigned, legacy)", `https://api.bilibili.com/x/player/v2?${base}`);
  await report("B. /x/player/wbi/v2 (unsigned — EXTENSION'S ACTUAL CALL)", `https://api.bilibili.com/x/player/wbi/v2?${base}`);

  const key = await wbiKeys();
  if (!key) {
    console.log("\n[wbi] could not obtain wbi keys from /x/web-interface/nav");
  } else {
    const signed = sign({ bvid, cid: cidArg }, key);
    await report("C. /x/player/wbi/v2 (properly signed)", `https://api.bilibili.com/x/player/wbi/v2?${signed}`);
  }
}

main().catch((e) => console.log("ERROR:", e.message));
