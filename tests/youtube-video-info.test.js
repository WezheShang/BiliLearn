/**
 * Unit tests for content.js extractYouTubeVideoInfo() — the YouTube
 * watch-page title / channel / description / duration / pubdate extractor.
 *
 * Background (2026-10-04 user report):
 *   The previous selector list
 *     "h1.ytd-watch-metadata yt-formatted-string, " +
 *     "#title > h1 > yt-formatted-string, " +
 *     "#title yt-formatted-string, " +
 *     "h1.title yt-formatted-string"
 *   could latch onto a sibling section's `yt-formatted-string` after SPA
 *   hydration, so the sidepanel / notes / cache layer ended up with
 *   titles like "Comments" or "In this video". The fix is to read the
 *   authoritative `ytInitialPlayerResponse.videoDetails` JSON that
 *   YouTube inlines in the SSR HTML (always present, unique per video
 *   id) and only fall back to the DOM if that JSON is missing.
 *
 * These tests use jsdom to load three synthetic watch pages and call
 * extractYouTubeVideoInfo() directly:
 *   1. real-player-response + hydration-distraction DOM
 *      → must return the real title from videoDetails, not the
 *        distraction "Comments" / "Up next" text
 *   2. no-player-response + DOM filled with section-header trap text
 *      → DOM fallback must NOT return "Comments" / "Up next"; must
 *        return "" so callers know metadata is missing instead of
 *        latching onto noise.
 *   3. no-player-response + DOM showing the real main title
 *      → DOM fallback must pick up the real title.
 *
 * Run: `node tests/youtube-video-info.test.js`
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_PATH = path.join(ROOT, "content.js");

// ---------- minimal test framework ----------
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? "  -- " + detail : ""}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEqual ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`assertTrue failed: ${label}`);
}

// ---------- load only the bits of content.js we need ----------
//
// content.js is a Chrome extension content script — it references
// chrome.runtime, window.*, DOM globals, etc. We can't `require` it
// directly. Instead we extract the two functions by slicing the file
// and `eval` them inside the jsdom window. This mirrors the
// "bilibili-errors.test.js" pattern of isolating pure-logic functions
// and exercising them in a node harness.
function extractBlock(source, fnName) {
  // Find `function <fnName>(...)` or `async function <fnName>(...)` and
  // return its body — but balance braces because the helper contains
  // nested function declarations that we DON'T want to include.
  const startRe = new RegExp(
    `(?:async\\s+)?function\\s+${fnName}\\s*\\(`,
  );
  const startMatch = startRe.exec(source);
  if (!startMatch) {
    throw new Error(`Could not find function ${fnName} in content.js`);
  }
  // Walk forward from the opening paren to find the matching closing
  // paren, then the opening brace, then balance braces until depth=0.
  let i = source.indexOf("(", startMatch.index);
  let depthP = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") depthP++;
    else if (ch === ")") {
      depthP--;
      if (depthP === 0) {
        i++;
        break;
      }
    }
    i++;
  }
  // Now i points just past the closing `)`. Find the opening `{`.
  while (i < source.length && source[i] !== "{") i++;
  if (i >= source.length) {
    throw new Error(`Could not find body of ${fnName}`);
  }
  const bodyStart = i;
  let depth = 0;
  let inString = false;
  let escape = false;
  let inComment = false; // single-line
  let inBlockComment = false;
  let inRegex = false;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = false;
      i++;
      continue;
    }
    if (inComment) {
      if (ch === "\n") inComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inRegex) {
      // Inside a regex literal: only `/` closes it (and only when not
      // escaped). For our content.js this is rare (only inside the
      // regex literals the two functions use), but handle it.
      if (ch === "\\") {
        escape = true;
      } else if (ch === "/") {
        inRegex = false;
      }
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
      i++;
      continue;
    }
    i++;
  }
  return source.substring(startMatch.index, i);
}

const source = fs.readFileSync(CONTENT_PATH, "utf8");
const playerResponseFn = extractBlock(source, "extractYouTubePlayerResponse");
const videoInfoFn = extractBlock(source, "extractYouTubeVideoInfo");

// ---------- fixture builder ----------
//
// Builds a synthetic watch-page HTML that includes either:
//   - a full <script> var ytInitialPlayerResponse = {videoDetails:{...}, ...};
//     (the SSR-shipped authoritative metadata source), and/or
//   - post-hydration DOM placeholders under `#title` / `ytd-channel-name`
//     / etc. that mirror what YouTube renders AFTER hydration.
//
// We always include the SSR `<div id="title" class="text-shell skeleton-
// bg-color">` placeholder to mirror the empty skeleton that real YouTube
// SSR ships (this is what made the old DOM-only path fragile in the
// first place).
function buildWatchPage({ playerResponse, dom }) {
  const scriptBlob = playerResponse
    ? `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>`
    : "";
  const meta = playerResponse?.microformat?.playerMicroformatRenderer
    ? `<meta itemprop="datePublished" content="${playerResponse.microformat.playerMicroformatRenderer.publishDate || playerResponse.microformat.playerMicroformatRenderer.uploadDate || ""}">`
    : "";
  return `<!DOCTYPE html>
<html>
<head>${meta}</head>
<body>
  <!-- SSR ships an empty skeleton placeholder; SPA hydration replaces
       its children after JS runs. The old DOM-only path could not tell
       these placeholders apart from the hydrated real nodes. -->
  <div id="title" class="text-shell skeleton-bg-color"></div>
  ${dom || ""}
  ${scriptBlob}
</body>
</html>`;
}

// ---------- harness ----------
//
// Loads HTML into jsdom and evaluates the two extracted functions inside
// the window scope so `document.querySelector(...)` resolves to the jsdom
// document.
function loadAndRun(html) {
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  const win = dom.window;
  // eslint-disable-next-line no-eval
  win.eval(playerResponseFn);
  // eslint-disable-next-line no-eval
  win.eval(videoInfoFn);
  return {
    document: win.document,
    extractPlayerResponse: () => win.eval("extractYouTubePlayerResponse()"),
    extractVideoInfo: () => win.eval("extractYouTubeVideoInfo()"),
  };
}

// ---------- fixtures ----------
const REAL_PLAYER_RESPONSE = {
  videoDetails: {
    videoId: "dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
    author: "Rick Astley",
    lengthSeconds: "213",
    shortDescription:
      "The official video for “Never Gonna Give You Up” by Rick Astley.",
  },
  microformat: {
    playerMicroformatRenderer: {
      publishDate: "2009-10-24T23:57:33-07:00",
      uploadDate: "2009-10-25",
    },
  },
};

// Hydrated DOM that the OLD selector list would mistake for the title —
// "Comments" / "Up next" / "In this video" all sit inside an
// `h1.title` / `yt-formatted-string`. With the fix, these must be
// ignored in favour of videoDetails.title.
const HYDRATED_TRAP_DOM = `
  <ytd-watch-metadata>
    <h1 class="title style-scope ytd-watch-metadata">
      <yt-formatted-string class="style-scope ytd-watch-metadata">
        Comments
      </yt-formatted-string>
    </h1>
  </ytd-watch-metadata>
  <div id="secondary">
    <ytd-compact-video-renderer>
      <h1 class="title">
        <yt-formatted-string>Up next</yt-formatted-string>
      </h1>
    </ytd-compact-video-renderer>
    <ytd-compact-video-renderer>
      <h1 class="title">
        <yt-formatted-string>In this video</yt-formatted-string>
      </h1>
    </ytd-compact-video-renderer>
  </div>
`;

// Hydrated DOM where the real main title is rendered correctly under
// `#title > h1 > yt-formatted-string`. Used to verify the DOM fallback
// path still picks up the right element when playerResponse is missing.
const HYDRATED_REAL_DOM = `
  <div id="title">
    <h1>
      <yt-formatted-string>
        Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)
      </yt-formatted-string>
    </h1>
  </div>
  <ytd-channel-name>
    <a href="/@RickAstley">Rick Astley</a>
  </ytd-channel-name>
  <ytd-text-inline-expander id="description-inline-expander">
    The official video for "Never Gonna Give You Up" by Rick Astley.
  </ytd-text-inline-expander>
`;

// ---------- tests ----------
console.log("\n=== extractYouTubeVideoInfo — authoritative source ===");

// Case 1: real playerResponse present + DOM full of trap headers.
// The fix MUST prefer videoDetails.title and ignore "Comments" /
// "Up next" / "In this video" from the DOM.
{
  const h = loadAndRun(
    buildWatchPage({
      playerResponse: REAL_PLAYER_RESPONSE,
      dom: HYDRATED_TRAP_DOM,
    }),
  );
  const info = h.extractVideoInfo();
  record(
    "real playerResponse + trap DOM → title is videoDetails.title",
    info.title === REAL_PLAYER_RESPONSE.videoDetails.title,
    `got: ${JSON.stringify(info.title)}`,
  );
  record(
    "real playerResponse + trap DOM → channelName is videoDetails.author",
    info.channelName === REAL_PLAYER_RESPONSE.videoDetails.author,
    `got: ${JSON.stringify(info.channelName)}`,
  );
  record(
    "real playerResponse + trap DOM → duration is lengthSeconds",
    info.duration === 213,
    `got: ${info.duration}`,
  );
  record(
    "real playerResponse + trap DOM → description is shortDescription",
    info.description === REAL_PLAYER_RESPONSE.videoDetails.shortDescription,
    `got: ${JSON.stringify(info.description)}`,
  );
  record(
    "real playerResponse + trap DOM → pubdate is publishDate",
    info.pubdate === "2009-10-24",
    `got: ${JSON.stringify(info.pubdate)}`,
  );
}

// Case 2: no playerResponse + DOM full of trap headers. The DOM
// fallback must REFUSE to return "Comments" / "Up next" /
// "In this video" — it should return empty string so callers don't
// persist a wrong title into the cache / notes.
{
  const h = loadAndRun(
    buildWatchPage({
      playerResponse: null,
      dom: HYDRATED_TRAP_DOM,
    }),
  );
  const info = h.extractVideoInfo();
  record(
    "no playerResponse + trap DOM → title is empty (not 'Comments')",
    info.title === "",
    `got: ${JSON.stringify(info.title)}`,
  );
  record(
    "no playerResponse + trap DOM → channelName falls back to href slug",
    // `<ytd-channel-name>` anchor with no text → falls back to href slug.
    // No anchor present here, so empty string.
    info.channelName === "",
    `got: ${JSON.stringify(info.channelName)}`,
  );
}

// Case 3: no playerResponse + DOM correctly showing the main title.
// The DOM fallback must still pick up the right element. This guards
// against an over-aggressive fix that throws away the DOM entirely.
{
  const h = loadAndRun(
    buildWatchPage({
      playerResponse: null,
      dom: HYDRATED_REAL_DOM,
    }),
  );
  const info = h.extractVideoInfo();
  record(
    "no playerResponse + real DOM → title is the main video title",
    info.title === REAL_PLAYER_RESPONSE.videoDetails.title,
    `got: ${JSON.stringify(info.title)}`,
  );
  record(
    "no playerResponse + real DOM → channelName picks up channel anchor text",
    info.channelName === "Rick Astley",
    `got: ${JSON.stringify(info.channelName)}`,
  );
  record(
    "no playerResponse + real DOM → description picks up inline-expander text",
    info.description.includes("Never Gonna Give You Up"),
    `got: ${JSON.stringify(info.description)}`,
  );
}

// Case 4: helper itself works directly — we should be able to read
// videoDetails out of the page state for any script tag.
{
  const h = loadAndRun(
    buildWatchPage({ playerResponse: REAL_PLAYER_RESPONSE, dom: "" }),
  );
  const pr = h.extractPlayerResponse();
  record(
    "extractYouTubePlayerResponse returns parsed JSON",
    pr && pr.videoDetails && pr.videoDetails.title === REAL_PLAYER_RESPONSE.videoDetails.title,
    `videoId: ${pr?.videoDetails?.videoId}`,
  );
}

// Case 5: only-microformat scenario — when videoDetails is missing
// but microformat has the publishDate, pubdate should still resolve.
{
  const h = loadAndRun(
    buildWatchPage({
      playerResponse: {
        microformat: {
          playerMicroformatRenderer: {
            publishDate: "2024-06-01T10:00:00-08:00",
          },
        },
      },
      dom: "",
    }),
  );
  const info = h.extractVideoInfo();
  record(
    "microformat-only playerResponse → pubdate extracted",
    info.pubdate === "2024-06-01",
    `got: ${JSON.stringify(info.pubdate)}`,
  );
  record(
    "microformat-only playerResponse → title empty (no videoDetails)",
    info.title === "",
    `got: ${JSON.stringify(info.title)}`,
  );
}

// ---------- summary ----------
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(
  `\n=== summary: ${passed} passed, ${failed} failed, ${results.length} total ===`,
);
if (failed > 0) process.exit(1);