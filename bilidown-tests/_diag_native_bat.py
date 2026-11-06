# -*- coding: utf-8 -*-
"""native host 的 **.bat** 入口探针（2026-11-06）。

背景：用户报「settings 页面任何一个 button 点击都没有任何用处，无法启动 service」。
已知 native host 的注册、allowed_origins、扩展 ID 都是对的（已查过注册表）。
但前面的探针 (_diag_launch_port.py) 是**直接调 .ps1** 的，而 Chrome 实际
spawn 的是注册表里指向的 **.bat**（bililearn_whisper_launcher.bat）。
中间隔着一层 cmd.exe —— stdin/stdout 的二进制帧能不能原样穿过去，
必须实测。

这个探针按 Chrome 的方式驱动 .bat：
  L1 .bat 能回一个合法帧（4 字节小端长度 + UTF-8 JSON）
  L2 回包是 success:true
  L3 指定端口上真的起来了 whisper server（说明命令真的执行了）
  L4 不带端口的 launch 也回 success
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAT = os.path.join(ROOT, "bililearn_whisper_launcher.bat")
TEST_PORT = 7864

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  -- " + detail) if detail else ""))


def call_host(payload, timeout=90):
    body = json.dumps(payload).encode("utf-8")
    frame = len(body).to_bytes(4, "little") + body
    proc = subprocess.run(
        ["cmd.exe", "/c", BAT],
        input=frame,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    out = proc.stdout
    if len(out) < 4:
        raise RuntimeError(
            "host 没回帧: stdout=%r stderr=%r" % (out[:300], proc.stderr[:300])
        )
    n = int.from_bytes(out[:4], "little")
    return json.loads(out[4:4 + n].decode("utf-8", "replace")), proc


def health(port, timeout=3):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return None


def wait_health(port, deadline_s=45):
    end = time.time() + deadline_s
    while time.time() < end:
        h = health(port)
        if h and h.get("ok"):
            return h
        time.sleep(1.0)
    return None


def cleanup():
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


def main():
    print("=== Chrome 实际调用的入口：bililearn_whisper_launcher.bat ===")

    print("\n[L1] .bat 能回一个合法帧")
    try:
        resp, proc = call_host({"cmd": "launch", "port": TEST_PORT})
        check("L1 .bat 回了合法帧", isinstance(resp, dict),
              json.dumps(resp, ensure_ascii=False)[:200]
              + (" | stderr=" + proc.stderr.decode("utf-8", "replace")[:200]
                 if proc.stderr else ""))
    except Exception as e:
        check("L1 .bat 回了合法帧", False, str(e))
        cleanup()
        finish()
        return

    check("L2 回包 success=true", bool(resp.get("success")),
          json.dumps(resp, ensure_ascii=False)[:200])

    print("\n[L3] %d 端口上真的起来了 whisper server" % TEST_PORT)
    h = wait_health(TEST_PORT)
    check("L3 %d 上 server 已就绪" % TEST_PORT, bool(h and h.get("ok")),
          "没起来 —— 命令没执行或秒退")
    if h:
        check("L3b 新实例带 model_resolution（新代码标志）",
              bool(h.get("model_resolution")), "")

    print("\n[L4] 不带 port 的 launch 也回 success")
    resp2, _ = call_host({"cmd": "launch"})
    check("L4 不带 port 也回 success", bool(resp2.get("success")),
          json.dumps(resp2, ensure_ascii=False)[:200])

    print("\n[清理] 停掉测试用的 %d 实例" % TEST_PORT)
    cleanup()
    finish()


def finish():
    failed = [r for r in results if not r[1]]
    print("\n%d/%d 通过" % (len(results) - len(failed), len(results)))
    if failed:
        for name, _ok, detail in failed:
            print("  x %s  %s" % (name, detail))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
