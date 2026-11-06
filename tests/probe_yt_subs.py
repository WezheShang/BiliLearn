"""Probe yt-dlp info for the user-reported video."""
import os
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

import yt_dlp

URL = "https://www.youtube.com/watch?v=7zKd4ZRkUBQ"
PROXY = "http://127.0.0.1:15236"

opts = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "proxy": PROXY,
    "extractor_args": {
        "youtube": {
            "player_client": ["tv_embedded", "web_safari", "android_vr"],
            "skip": ["translated_subs", "dash"],
        }
    },
}

with yt_dlp.YoutubeDL(opts) as ydl:
    info = ydl.extract_info(URL, download=False)

manual = info.get("subtitles") or {}
auto = info.get("automatic_captions") or {}

print(f"title: {info.get('title')!r}")
print(f"uploader: {info.get('uploader')!r}")
print()
print(f"=== MANUAL subtitles ({len(manual)} langs) ===")
for k in sorted(manual.keys()):
    val = manual[k]
    n = len(val) if isinstance(val, list) else "?"
    print(f"  {k!r}: {n} format(s)")
print()
print(f"=== AUTOMATIC captions ({len(auto)} langs) ===")
for k in sorted(auto.keys()):
    val = auto[k]
    n = len(val) if isinstance(val, list) else "?"
    print(f"  {k!r}: {n} format(s)")