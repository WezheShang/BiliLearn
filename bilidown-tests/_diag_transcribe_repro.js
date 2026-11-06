// Reproduce the extension's /transcribe POST against a logging server
// instance, so a server-side traceback (if any) is actually visible.
//
// 2026-11-04: the production server's stderr goes to a hidden console
// window, so any exception was invisible — the extension only ever showed
// the client-side "TypeError: Failed to fetch".

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 7861;
const LOG = path.join(__dirname, "_diag_server.log");

const py = "C:\\Users\\shangweizhe\\miniconda3\\python.exe";

// A tiny launcher that binds the module's PORT to our test port.
const launcher = path.join(__dirname, "_diag_server_boot.py");
fs.writeFileSync(
  launcher,
  [
    "import sys, os",
    `sys.path.insert(0, r"${ROOT}")`,
    "import whisper_server as ws",
    `ws.PORT = ${PORT}`,
    "ws.main()",
    "",
  ].join("\n"),
  "utf8",
);

console.log("starting logging server instance on", PORT);
const srv = spawn(py, ["-B", "-I", launcher], {
  cwd: ROOT,
  env: { ...process.env, PYTHONUNBUFFERED: "1" },
});
const logChunks = [];
srv.stdout.on("data", (d) => logChunks.push(d));
srv.stderr.on("data", (d) => logChunks.push(d));

function serverLog() {
  return Buffer.concat(logChunks).toString("utf8");
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const health = await waitForHealth();
  if (!health) {
    console.log("server did not come up");
    console.log(serverLog());
    srv.kill();
    process.exit(2);
  }
  console.log("health ok:", health.ok, "| model:", health.current_model);

  // ---- 1. Preflight with the EXACT headers the extension sends ----
  const preflight = await fetch(`http://127.0.0.1:${PORT}/transcribe`, {
    method: "OPTIONS",
    headers: {
      Origin: "chrome-extension://iecokifhclbnhmgbmadgggidofeeppjn",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Private-Network": "true",
      "Access-Control-Request-Headers":
        "content-type,x-whisper-model,x-bvid,x-cid,x-title,x-channel,x-pubdate,x-cache-dir",
    },
  });
  const ph = {};
  preflight.headers.forEach((v, k) => (ph[k] = v));
  console.log("\n[1] preflight status:", preflight.status);
  console.log("    allow-headers :", ph["access-control-allow-headers"]);
  console.log("    allow-private-network:", ph["access-control-allow-private-network"]);
  const allowsX = /x-bvid/i.test(ph["access-control-allow-headers"] || "");
  const allowsPna = ph["access-control-allow-private-network"] === "true";
  console.log("    -> X-* headers allowed:", allowsX, "| PNA allowed:", allowsPna);

  // ---- 2. Real POST with the extension's headers (tiny silent audio) ----
  const audioPath = path.join(__dirname, "_diag_tiny.m4s");
  if (!fs.existsSync(audioPath)) {
    console.log("\n[2] skipped real POST: no local audio fixture");
  } else {
    const buf = fs.readFileSync(audioPath);
    const t0 = Date.now();
    let out;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": "audio/mp4",
          "X-Whisper-Model": "base",
          "X-Bvid": "BV1diag00000",
          "X-Cid": "1",
          "X-Title": encodeURIComponent("diag"),
          "X-Channel": encodeURIComponent("diag"),
          "X-Pubdate": "2026-01-01",
          "X-Cache-Dir": encodeURIComponent(path.join(ROOT, "logs", "_diag_cache")),
        },
        body: buf,
      });
      const text = await res.text();
      out = `status=${res.status} bytes=${text.length} head=${text.slice(0, 120)}`;
    } catch (e) {
      out = `THREW: ${e.name}: ${e.message}  <-- this is what the extension sees as "Failed to fetch"`;
    }
    console.log(`\n[2] POST /transcribe (${buf.length} bytes, ${Date.now() - t0}ms):`);
    console.log("    " + out);
  }

  console.log("\n---- server stdout/stderr ----");
  console.log(serverLog().slice(-3000) || "(empty)");
  srv.kill();
  fs.unlinkSync(launcher);
  process.exit(0);
}

main().catch((e) => {
  console.error("HARNESS CRASH:", e);
  console.log(serverLog().slice(-3000));
  srv.kill();
  process.exit(2);
});
