"""Decisive test: does B站 hand out the subtitle track list when the request
carries the user's own logged-in cookies?

The cookie value is used in-process only and is NEVER printed.
"""
import base64
import ctypes
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import urllib.request
from ctypes import wintypes

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

USER_DATA = os.path.join(os.environ["LOCALAPPDATA"], "Google", "Chrome", "User Data")
PROFILES = ["Default", "Profile 1"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")


def dpapi_unprotect(data: bytes) -> bytes:
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    def blob(buf):
        b = DATA_BLOB(len(buf), ctypes.create_string_buffer(buf, len(buf)))
        return b, ctypes.byref(b)

    in_b, in_ref = blob(data)
    out_b = DATA_BLOB()
    out_ref = ctypes.byref(out_b)
    if not ctypes.windll.crypt32.CryptUnprotectData(
        in_ref, None, None, None, None, 0, out_ref
    ):
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(out_b.pbData, out_b.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_b.pbData)


def chrome_key():
    with open(os.path.join(USER_DATA, "Local State"), encoding="utf-8") as f:
        state = json.load(f)
    enc = base64.b64decode(state["os_crypt"]["encrypted_key"])
    return dpapi_unprotect(enc[5:])


def decrypt_value(key: bytes, host_key: str, value: bytes):
    if value[:3] not in (b"v10", b"v11"):
        return None
    raw = base64.b64decode(value[3:])
    nonce, ct = raw[:12], raw[12:]
    return AESGCM(key).decrypt(nonce, ct, b" ".join(("v10", host_key)).encode())


def load_bilibili_cookies():
    key = chrome_key()
    for profile in PROFILES:
        for rel in (("Network", "Cookies"), ("Cookies",)):
            src = os.path.join(USER_DATA, profile, *rel)
            if not os.path.exists(src):
                continue
            tmp = os.path.join(tempfile.gettempdir(), f"_ck_{profile.replace(' ', '_')}.db")
            # Chrome holds the SQLite file open; a plain byte read works
            # (FILE_SHARE_READ), while shutil.copy2 (CopyFile2) does not.
            with open(src, "rb") as fin:
                raw = fin.read()
            with open(tmp, "wb") as fout:
                fout.write(raw)
            con = sqlite3.connect(tmp)
            try:
                rows = con.execute(
                    "SELECT host_key, name, encrypted_value FROM cookies "
                    "WHERE host_key LIKE '%bilibili%' AND name IN "
                    "('SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','buvid3','sid')"
                ).fetchall()
            finally:
                con.close()
            if rows:
                jar = []
                for host_key, name, enc in rows:
                    try:
                        plain = decrypt_value(key, host_key, enc)
                    except Exception:
                        plain = None
                    if plain:
                        jar.append(f"{name}={plain.decode('utf-8', 'replace')}")
                if jar:
                    print(f"  [profile {profile}] 取到 {len(jar)} 个 cookie:",
                          ", ".join(n.split("=")[0] for n in jar))
                    return jar
    return []


def call_api(url, cookie_header=None):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Referer", "https://www.bilibili.com/")
    if cookie_header:
        req.add_header("Cookie", cookie_header)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def main():
    bvid = sys.argv[1] if len(sys.argv) > 1 else "BV1ed4b6rE5G"
    cid = sys.argv[2] if len(sys.argv) > 2 else "43352328905"

    view = call_api(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    cid = str(view["data"]["cid"])
    print("video:", view["data"]["title"][:40], "| cid:", cid)

    base = f"bvid={bvid}&cid={cid}"

    print("\n--- 无 cookie ---")
    d = call_api(f"https://api.bilibili.com/x/player/wbi/v2?{base}")["data"]
    subs = d.get("subtitle", {}).get("subtitles", []) or []
    print(f"  need_login_subtitle={d.get('need_login_subtitle')} tracks={len(subs)}")
    for s in subs:
        print(f"    lan={s.get('lan')} lan_doc={s.get('lan_doc')} ai_status={s.get('ai_status')}")

    jar = load_bilibili_cookies()
    if not jar:
        print("\n[!] 本机 Chrome 没找到 B 站登录 cookie（未登录或 profile 不同）")
        return
    cookie_header = "; ".join(jar)

    print("\n--- 带本机登录 cookie ---")
    d2 = call_api(f"https://api.bilibili.com/x/player/wbi/v2?{base}", cookie_header)["data"]
    subs2 = d2.get("subtitle", {}).get("subtitles", []) or []
    print(f"  need_login_subtitle={d2.get('need_login_subtitle')} tracks={len(subs2)}")
    for s in subs2:
        print(f"    lan={s.get('lan')} lan_doc={s.get('lan_doc')} ai_status={s.get('ai_status')}"
              f" url={(s.get('subtitle_url') or '')[:70]}")
    if subs2:
        s = subs2[0]
        url = s.get("subtitle_url") or ""
        if url.startswith("//"):
            url = "https:" + url
        print("\n--- 拉字幕文件 ---")
        body = call_api(url, cookie_header)
        lines = body.get("body", [])
        print(f"  条目数={len(lines)}")
        for line in lines[:3]:
            print("   ", line.get("from"), line.get("content"))


if __name__ == "__main__":
    main()
