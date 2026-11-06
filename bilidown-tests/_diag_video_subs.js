// Inspect what B站 actually exposes for a video: subtitle tracks, rights,
// and whether the player API needs login.
const bvid = process.argv[2] || "BV1ed4b6rE5G";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function j(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: `https://www.bilibili.com/video/${bvid}`, ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

async function main() {
  console.log("bvid:", bvid);
  const view = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const d = view.json?.data;
  if (!d) {
    console.log("view FAILED:", JSON.stringify(view.json || view.text).slice(0, 400));
    return;
  }
  console.log("title      :", d.title);
  console.log("owner      :", d.owner?.name);
  console.log("duration   :", d.duration, "s");
  console.log("cid        :", d.cid);
  console.log("aid        :", d.aid);
  console.log("rights     :", JSON.stringify(d.rights));
  console.log("stat.view  :", d.stat?.view);

  // ---- player/wbi/v2 — where the subtitle track list lives ----
  const v2 = await j(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${d.cid}`);
  console.log("\n[x/player/v2] code:", v2.json?.code, v2.json?.message || "");
  const subs = v2.json?.data?.subtitle?.subtitles || [];
  console.log("subtitle tracks (no login):", subs.length);
  for (const s of subs) {
    console.log(
      `   lan=${s.lan} | lan_doc=${s.lan_doc} | ai_status=${s.ai_status} | ` +
        `ai_type=${s.ai_type} | type=${s.type} | id=${s.id} | url=${(s.subtitle_url || "").slice(0, 80)}`,
    );
  }
  console.log("subtitle.allow_submit:", v2.json?.data?.subtitle?.allow_submit);
  console.log("need_login_subtitle:", v2.json?.data?.need_login_subtitle);
  console.log("login_mid:", v2.json?.data?.login_mid);
  console.log("is_upower_exclusive:", v2.json?.data?.is_upower_exclusive);
  console.log("is_electric:", v2.json?.data?.is_electric);

  // ---- playurl: does the audio even exist (paid/member gates)? ----
  const pu = await j(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${d.cid}&fnval=16&qn=16`,
  );
  console.log("\n[playurl] code:", pu.json?.code, pu.json?.message || "");
  const dash = pu.json?.data?.dash;
  console.log("audio tracks:", dash?.audio?.length || 0, "| video tracks:", dash?.video?.length || 0);
  if (dash?.audio?.length) {
    const a = [...dash.audio].sort((x, y) => (x.bandwidth || 0) - (y.bandwidth || 0))[0];
    console.log("   lowest audio:", a.id, "bw=", a.bandwidth, "host=", new URL(a.baseUrl).host);
  }
  if (!dash?.audio?.length) {
    console.log("   !! NO AUDIO — paid / member / premiere video");
  }
}

main().catch((e) => console.log("ERROR:", e.message));
