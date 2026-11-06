# -*- coding: utf-8 -*-
"""
native launcher 的 restart 命令探针（2026-11-05）

背景：用户报"点 Whisper 转录 → 500 LocalEntryNotFoundError: ConnectTimeout"。

实测根因：跑着的 whisper server 是**开机自启任务拉起来的 SYSTEM 实例**
（PID 14516，11/03 启动，跑的是旧代码）：
  - 普通用户权限杀不掉（taskkill: Access is denied）
  - schtasks /query 也 Access is denied
  - 旧代码不解析本地 HF 缓存 → 每次去 huggingface.co 下载 → 本机直连
    不通 → ConnectTimeout → 500

所以"让用户去管理员终端重启"虽然是老办法，但用户经常忘/懒得做。
自动修复的方案：在**备用端口**（7861）用当前用户身份拉起一个新实例，
扩展改连它 —— 全程不需要管理员权限。

这个探针直接**跑 native launcher 的 restart 分支**，验证：
  R1 launcher 能用 restart 命令在备用端口拉起实例
  R2 新实例的 /health 报告 model_resolution（新代码标志）
  R3 新实例能真正转录（500 已修复）
  R4 转录走的是本地模型快照（不是联网下载）

跑法（用带 faster-whisper 的解释器）：
    "%USERPROFILE%\miniconda3\python.exe" -B bilidown-tests\_diag_native_restart.py
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(ROOT, "bililearn_whisper_launcher.ps1")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  PASS  %s" % name)
    else:
        FAIL.append((name, detail))
        print("  FAIL  %s  %s" % (name, detail))


def send_native(cmd_payload, timeout=30):
    """按 native messaging 协议给 launcher 发一帧，收一帧。"""
    payload = json.dumps(cmd_payload).encode("utf-8")
    header = struct.pack("<I", len(payload))
    proc = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            LAUNCHER,
        ],
        input=header + payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    out = proc.stdout
    if len(out) < 4:
        raise RuntimeError("launcher 没回帧：%r / err=%r" % (out[:80], proc.stderr[:200]))
    length = struct.unpack("<I", out[:4])[0]
    body = out[4 : 4 + length]
    return json.loads(body.decode("utf-8"))


def make_wav(path, seconds=2.0, rate=16000):
    import math
    import wave
    n = int(rate * seconds)
    frames = bytearray()
    for i in range(n):
        frames += struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / rate)))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def wait_health(port, timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=5) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5)
    raise RuntimeError("server never healthy: %s" % last)


def main():
    if not os.path.exists(LAUNCHER):
        print("找不到 launcher: %s" % LAUNCHER)
        return 1

    print("=== native launcher restart 命令探针 ===")
    port = 7861
    tmp = tempfile.mkdtemp(prefix="native_restart_")
    proc_pid = None
    try:
        # ---- R1: restart 命令被接受 ----
        resp = send_native({"cmd": "restart", "port": port})
        print("  launcher 回应: %s" % json.dumps(resp, ensure_ascii=False)[:300])
        check("R1 launcher 接受 restart 命令", bool(resp.get("success")),
              json.dumps(resp, ensure_ascii=False)[:200])
        check("R1b 回包里带上了目标端口", int(resp.get("port") or 0) == port,
              str(resp.get("port")))
        proc_pid = resp.get("pid")

        # ---- R2: 新实例就绪且是新代码 ----
        health = wait_health(port)
        check("R2 备用端口上的新实例已就绪", health.get("ok") is True,
              json.dumps(health)[:200])
        check("R2b 新实例带 model_resolution（新代码标志）",
              bool(health.get("model_resolution")),
              "（旧代码没有这个字段）")
        mr = health.get("model_resolution") or {}
        check("R2c HF 缓存指向用户目录（模型在这儿）",
              "shangweizhe" in str(mr.get("hf_hub_cache") or "").lower(),
              str(mr.get("hf_hub_cache")))
        local_tiny = (mr.get("local_models") or {}).get("tiny")
        check("R2d tiny 模型解析到本地快照（离线可用）", bool(local_tiny),
              str(local_tiny))

        # ---- R3: 真正转录一次（500 已修复）----
        wav = os.path.join(tmp, "tone.wav")
        make_wav(wav)
        body = json.dumps({
            "audio_path": wav,
            "model": "tiny",
            "language": "zh",
        }).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:%d/transcribe" % port,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                payload = json.loads(r.read().decode("utf-8"))
                status = r.status
        except urllib.error.HTTPError as exc:
            payload = {"error": exc.read().decode("utf-8", errors="replace")}
            status = exc.code
        elapsed = time.time() - t0
        print("  /transcribe -> %s (%.1fs) %s" % (
            status, elapsed, json.dumps(payload, ensure_ascii=False)[:160]))
        check("R3 转录返回 200（用户报的 500 已修复）", status == 200,
              "status=%s %s" % (status, json.dumps(payload, ensure_ascii=False)[:200]))
        check("R3b 转录没有 ConnectTimeout / LocalEntryNotFoundError",
              "ConnectTimeout" not in json.dumps(payload)
              and "LocalEntryNotFoundError" not in json.dumps(payload))

        # ---- R4: 日志里证明是离线加载 ----
        # bat 自己往 logs\whisper_server.log 追加（--log 模式），launcher
        # 回包里的 log 字段是按端口命名的那份 —— 两个路径都看一遍。
        candidates = []
        if resp.get("log"):
            candidates.append(resp["log"])
        candidates.append(os.path.join(ROOT, "logs", "whisper_server.log"))
        log = ""
        used = ""
        for path in candidates:
            if path and os.path.exists(path):
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                # 只看本次启动之后的日志（含 7861 的那几行）
                if "7861" in content or "resolved to local snapshot" in content:
                    log = content
                    used = path
                    break
                if not log:
                    log = content
                    used = path
        print("  日志来源: %s" % used)
        check("R4 日志显示走了本地模型快照（离线加载）",
              "resolved to local snapshot" in log,
              log[-300:] if log else "(没读到日志)")
        check("R4b 日志里没有 huggingface.co 下载",
              "huggingface.co" not in log)
    finally:
        # 清理：把这次拉起的实例停掉（用户权限，可以杀）
        if proc_pid:
            subprocess.run(["taskkill", "/PID", str(proc_pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(tmp, ignore_errors=True)

    print("")
    print("=== %d passed, %d failed ===" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("  FAILED: %s  %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
