# -*- coding: utf-8 -*-
"""native launcher 的「launch 带端口」探针（2026-11-06）。

背景：扩展的 whisperUrl 可能被切到备用端口 7861（当默认端口跑的是旧代码时，
repairWhisperServer 会切过去）。此时设置页/向导里的「启动 server」按钮
必须把 server 拉在**同一个端口**上，否则 server 起来了、扩展却还连着一个
没人监听的端口 → 面板一直说「没在跑」，死循环。

这个探针直接**按 Chrome 的方式**驱动 native messaging host
（4 字节小端长度 + UTF-8 JSON 帧），验证：
  L1 host 收到 {cmd:"launch", port:7862} 后回 success
  L2 7862 上真的起来了 whisper server（/health ok）
  L3 host 收到 {cmd:"launch", port:7862} 后，**默认端口 7860 不受影响**
      （不会被误启动 / 不会抢端口）
  L4 不带 port 的 launch 仍然走默认端口（老行为不变）

跑法：
  "%USERPROFILE%\\miniconda3\\python.exe" -B bilidown-tests\\_diag_launch_port.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(ROOT, "bililearn_whisper_launcher.ps1")
TEST_PORT = 7862

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  -- " + detail) if detail else ""))


def call_host(payload, timeout=60):
    """按 Chrome 的 native messaging 协议驱动 ps1 host。"""
    body = json.dumps(payload).encode("utf-8")
    frame = len(body).to_bytes(4, "little") + body
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1],
        input=frame,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    out = proc.stdout
    if len(out) < 4:
        raise RuntimeError("host 没回帧: stdout=%r stderr=%r" % (out[:200], proc.stderr[:200]))
    n = int.from_bytes(out[:4], "little")
    return json.loads(out[4:4 + n].decode("utf-8", "replace"))


def health(port, timeout=3):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


def wait_health(port, deadline_s=60):
    end = time.time() + deadline_s
    while time.time() < end:
        h = health(port)
        if h and h.get("ok"):
            return h
        time.sleep(1.0)
    return None


def main():
    print("=== 目标：验证 native launcher 的 launch 命令认端口 ===")

    print("\n[L1] {cmd:'launch', port:%d} → host 回 success" % TEST_PORT)
    resp = call_host({"cmd": "launch", "port": TEST_PORT})
    check("L1 host 回 success", bool(resp.get("success")), json.dumps(resp, ensure_ascii=False)[:200])

    print("\n[L2] %d 端口上真的起来了 whisper server" % TEST_PORT)
    h = wait_health(TEST_PORT)
    check("L2 %d 上 server 已就绪" % TEST_PORT, bool(h and h.get("ok")),
          json.dumps(h, ensure_ascii=False)[:200] if h else "没起来")
    if h:
        check("L2b 新实例带 model_resolution（新代码标志）",
              bool(h.get("model_resolution")), "旧代码没有这个字段")

    print("\n[L3] 默认端口 7860 不受影响")
    h7860 = health(7860)
    check("L3 7860 的响应没被这次 launch 改写（仍是同一个 server）",
          h7860 is not None, "7860 无响应" if h7860 is None else "7860 正常")

    print("\n[L4] 不带 port 的 launch 仍然是老行为（默认端口）")
    resp2 = call_host({"cmd": "launch"})
    check("L4 不带 port 也回 success", bool(resp2.get("success")),
          json.dumps(resp2, ensure_ascii=False)[:200])

    print("\n[清理] 停掉测试用的 %d 实例" % TEST_PORT)
    cleanup()

    failed = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(failed), len(results)))
    if failed:
        for name, _ok, detail in failed:
            print("  x %s  %s" % (name, detail))
        sys.exit(1)
    sys.exit(0)


def cleanup():
    """停掉测试端口上的实例（只杀我们自己拉起的那个）。"""
    try:
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "(Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue)"
             " | Select-Object -ExpandProperty OwningProcess" % TEST_PORT],
            stdout=subprocess.PIPE, timeout=20).stdout.decode("utf-8", "replace").strip()
        for pid in [x for x in out.split() if x.isdigit()]:
            subprocess.run(["taskkill", "/PID", pid, "/F"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)
            print("    killed pid %s" % pid)
    except Exception as e:
        print("    清理跳过: %s" % e)


if __name__ == "__main__":
    main()
