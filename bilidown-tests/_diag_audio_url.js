// Fetch a real B站 audio track URL (bilivideo CDN) so we can test it
// through the Veee proxy vs direct.
const bvid = process.argv[2] || "BV1GJ411x7h7";

async function main() {
  const viewRes = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" } },
  );
  const view = await viewRes.json();
  if (view.code !== 0) {
    console.log("view failed:", JSON.stringify(view).slice(0, 300));
    return;
  }
  const cid = view.data.cid;
  console.log("title:", view.data.title);
  console.log("cid:", cid);

  const puRes = await fetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=16`,
    { headers: { "User-Agent": "Mozilla/5.0", Referer: `https://www.bilibili.com/video/${bvid}` } },
  );
  const pu = await puRes.json();
  const audio = (pu?.data?.dash?.audio || []).sort(
    (a, b) => (Number(a.bandwidth) || 1e18) - (Number(b.bandwidth) || 1e18),
  )[0];
  if (!audio) {
    console.log("no audio track:", JSON.stringify(pu).slice(0, 400));
    return;
  }
  const candidates = [audio.baseUrl, audio.base_url, ...(audio.backupUrl || []), ...(audio.backup_url || [])].filter(Boolean);
  console.log("candidate hosts:", candidates.map((u) => new URL(u).host));
  console.log("AUDIO_URL=" + candidates[0]);
  console.log("BACKUP_URL=" + (candidates[1] || ""));
}

main().catch((e) => {
  console.log("ERROR:", e.message);
});
