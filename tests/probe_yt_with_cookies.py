"""Real end-to-end test:
   1. Use Chrome cookies API equivalent (via sqlite + DPAPI-free
      extraction in miniconda3) to grab YouTube cookies
   2. Format them as Netscape
   3. Pass to yt-dlp and see if we can get past Sign-in wall

   Note: Windows Chrome cookies are encrypted with DPAPI. miniconda3
   does not have win32crypt by default. We try a simpler path:
   chromium uses 'encrypted_value' BLOB with AES-GCM + a key from
   'Local State' file (also DPAPI encrypted). Full decryption is
   non-trivial.

   Alternative: skip the Chrome cookie probe, instead mock a session
   cookie and confirm the cookiesText path accepts it without 403.

   For this video, however, we cannot bypass without real auth.
   Best we can do: confirm the chain logic when info() succeeds.
"""
import os
import sys
import json
import time

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

# Quick sanity: try yt-dlp on a video KNOWN to NOT require auth,
# with our cookies code path. Use the Rick Astley fallback.
import yt_dlp

URL_PUBLIC = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
PROXY = "http://127.0.0.1:15236"

# Write a tiny fake cookies file in Netscape format and verify
# yt-dlp accepts the cookiefile option.
NetscapeFake = (
    "# Netscape HTTP Cookie File\n"
    "# Generated for testing\n"
    "\n"
    ".youtube.com\tTRUE\t/\tFALSE\t0\tCONSENT\tYES\n"
    ".youtube.com\tTRUE\t/\tFALSE\t0\tPREF\ttest_pref\n"
)
fake_path = r"C:\Users\shangweizhe\bilidown\tests\fake_cookies.txt"
with open(fake_path, "w", encoding="utf-8") as f:
    f.write(NetscapeFake)

print(f"Wrote fake cookies to {fake_path}")
print()

# Test 1: confirm yt-dlp can read this Netscape format (file-based)
opts = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "proxy": PROXY,
    "cookiefile": fake_path,
    "extractor_args": {
        "youtube": {
            "player_client": ["tv_embedded", "web_safari", "android_vr"],
            "skip": ["translated_subs", "dash"],
        }
    },
}

with yt_dlp.YoutubeDL(opts) as ydl:
    info = ydl.extract_info(URL_PUBLIC, download=False)

print(f"=== Public video (Rick Astley) with FAKE cookies ===")
print(f"title: {info.get('title')!r}")
manual = info.get("subtitles") or {}
auto = info.get("automatic_captions") or {}
print(f"manual: {list(manual.keys())[:5]}")
print(f"auto: {len(auto)} langs")

# Now look at the auth-required video
print()
print("=" * 60)
print(f"=== Auth-required video (7zKd4ZRkUBQ) with FAKE cookies ===")
print("=" * 60)
URL_AUTH = "https://www.youtube.com/watch?v=7zKd4ZRkUBQ"
try:
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(URL_AUTH, download=False)
    print(f"OK title={info.get('title')!r}")
except yt_dlp.utils.DownloadError as e:
    msg = str(e)[:500]
    if "Sign in to confirm" in msg:
        print("STILL FAILS — fake cookies can't bypass YouTube auth wall")
        print("  (expected — would only work with real user cookies)")
    else:
        print(f"OTHER ERROR: {msg}")