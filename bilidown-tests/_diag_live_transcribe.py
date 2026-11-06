# -*- coding: utf-8 -*-
"""对活的 whisper server 实例做一次真转写（2026-11-06）。

目的：用户报 "Whisper server returned 500: LocalEntryNotFoundError: ConnectTimeout"。
根因是跑着的实例是 SYSTEM 开机自启拉起的**旧代码**，不会解析本地 HF 缓存，
每次都去 huggingface.co 下载 → 本机直连不通 → 必超时。

新实例（7861）跑的是当前代码，应该能把 "base" 解析成本地快照、完全离线加载。
这个脚本验证：
  V1 POST /transcribe 返回 200（不是 500）
  V2 回包里有 segments / duration 等字段
  V3 服务端日志出现 "resolved to local snapshot"（证明走的离线本地模型）
  V4 日志里没有 ConnectTimeout / LocalEntryNotFoundError
  V5 整个过程没有联网（离线也能成）
"""
import json
import os
import sys
import time
import urllib.request
import wave
import struct
import math

PORT = int(os.environ.get("PROBE_PORT", "7861"))
HOST = "127.0.0.1"
MODEL = os.environ.get("PROBE_MODEL", "base")
LOG = r"C:\Users\shangweizhe\bilidown\logs\whisper_server.log"
TMP = os.environ.get("TEMP", r"C:\Users\shangweizhe\AppData\Local\Temp")

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  -- " + detail) if detail else ""))


def make_tone(path, seconds=2.0, rate=16000):
    """写一段 2 秒的 440Hz 正弦 —— 不会有文字，但足以让模型真正跑起来。"""
    frames = bytearray()
    n = int(rate * seconds)
    for i in range(n):
        v = int(12000 * math.sin(2 * math.pi * 440 * i / rate))
        frames += struct.pack("<h", v)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return path


def log_since(marker_len):
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as f:
            return f.read()[marker_len:]
    except OSError as e:
        return "<<读日志失败: %s>>" % e


def main():
    url = "http://%s:%d/transcribe" % (HOST, PORT)
    print("=== 目标：%s  model=%s ===" % (url, MODEL))

    # 记录日志当前长度，方便只看这次请求产生的新行
    try:
        marker = os.path.getsize(LOG)
    except OSError:
        marker = 0

    audio = make_tone(os.path.join(TMP, "bililearn_probe_tone.wav"))
    body = json.dumps({
        "audio_path": audio,
        "model": MODEL,
        "language": "zh",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            status = resp.status
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        elapsed = time.time() - t0
        check("V1 /transcribe 返回 200", False, "%s: %s (%.1fs)" % (type(e).__name__, e, elapsed))
        body_txt = ""
        if hasattr(e, "read"):
            try:
                body_txt = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                pass
        print("  响应体：%s" % body_txt)
        print("  --- 服务端日志 ---")
        print(log_since(marker))
        finish()
        return

    elapsed = time.time() - t0
    check("V1 /transcribe 返回 200", status == 200, "%.1fs" % elapsed)
    check("V2 回包含 segments / duration",
          isinstance(payload, dict) and "segments" in payload and "duration" in payload,
          "duration=%s segments=%d" % (payload.get("duration"),
                                       len(payload.get("segments") or [])))
    err = str(payload.get("error", ""))
    check("V2b 回包不是 500 错误", "ConnectTimeout" not in err
          and "LocalEntryNotFoundError" not in err, err[:200])

    time.sleep(0.6)
    new_log = log_since(marker)
    print("  --- 本次请求新增的服务端日志 ---")
    for line in new_log.strip().splitlines()[-15:]:
        print("    " + line)
    check("V3 日志出现 'resolved to local snapshot'（离线本地模型）",
          "resolved to local snapshot" in new_log)
    check("V4 日志无 ConnectTimeout", "ConnectTimeout" not in new_log)
    check("V4b 日志无 LocalEntryNotFoundError",
          "LocalEntryNotFoundError" not in new_log)
    check("V5 本次请求没有出现 'falling back to download'（说明没联网）",
          "falling back to download" not in new_log)
    finish()


def finish():
    failed = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(failed), len(results)))
    if failed:
        for name, _ok, detail in failed:
            print("  ✗ %s  %s" % (name, detail))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
