# -*- coding: utf-8 -*-
"""whisper_server 端到端探针（2026-11-05）

真的起一个 whisper server 实例（换端口，不碰用户那个 SYSTEM 跑的
7860），然后 POST 一段真音频过去，验证：

  E1  /health 返回 ok:true（faster-whisper 可用）
  E2  /transcribe 真的返回 200 + segments（不再 500）
  E3  服务端日志里出现 "resolved to local snapshot" —— 证明走的是
      **离线本地模型**，没有联网下载
  E4  日志里**没有** ConnectTimeout / LocalEntryNotFoundError
  E5  离线模式下（HF_HUB_OFFLINE=1 + 断网模拟）依然能转录成功
      —— 这是最关键的一条：证明彻底不依赖 huggingface.co

跑法（必须 -B，且用带 faster-whisper 的那个解释器）：
    "%USERPROFILE%\\miniconda3\\python.exe" -B bilidown-tests\\_diag_whisper_e2e.py
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "whisper_server.py")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  PASS  %s" % name)
    else:
        FAIL.append((name, detail))
        print("  FAIL  %s  %s" % (name, detail))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def make_wav(path, seconds=2.0, rate=16000):
    """造一段 16kHz 单声道 WAV（1kHz 正弦）。够 faster-whisper 跑一遍。"""
    import math
    import struct
    import wave
    n = int(rate * seconds)
    frames = bytearray()
    for i in range(n):
        v = int(12000 * math.sin(2 * math.pi * 440 * i / rate))
        frames += struct.pack("<h", v)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def wait_health(port, timeout=60):
    url = "http://127.0.0.1:%d/health" % port
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5)
    raise RuntimeError("server never became healthy: %s" % last)


def post_transcribe(port, audio_path, model="tiny"):
    url = "http://127.0.0.1:%d/transcribe" % port
    body = json.dumps({
        "audio_path": audio_path,
        "model": model,
        "language": "zh",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw}


def make_before_fix_copy(dest_dir):
    """造一份"修复前"的 whisper_server.py 副本，用于忠实复现用户那次 500。

    等价于把本次修复 stash 掉：
      ① 删掉模块级的 `_bootstrap_hf_cache()` 调用（不纠正 HF 缓存指向）
      ② `_resolve_model_reference` 永远返回裸模型名（= 事故前的行为）

    两个坑（都踩过）：
      - 早期版本用"删掉整个函数体"的手术方式，误伤了中间夹着的 dedup
        常量块 → 模块 import 就炸。
      - 覆盖函数如果追加到文件**末尾**，会排在 `if __name__ ==
        "__main__": main()` 之后 —— main() 跑的时候旧函数还没被覆盖，
        覆盖等于没做。必须插到 `if __name__` 块**之前**。
    """
    with open(SERVER, "r", encoding="utf-8") as f:
        src = f.read()
    # ① 模块级引导调用（只在文件顶层出现一次）
    src = src.replace("\n_bootstrap_hf_cache()\n", "\n", 1)
    # ② 覆盖解析函数 —— 插在 `if __name__` 之前
    override = (
        "\n\n# --- before-fix simulation (2026-11-05 incident) ---\n"
        "def _resolve_model_reference(name):\n"
        "    return name or DEFAULT_MODEL\n"
    )
    anchor = 'if __name__ == "__main__":'
    idx = src.index(anchor)
    src = src[:idx] + override.lstrip("\n") + "\n\n" + src[idx:]
    path = os.path.join(dest_dir, "whisper_server_prefix.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    return path


def run_case(label, port, extra_env=None, break_model=False, before_fix=False):
    """起一个 server 实例，等它健康，返回 (proc, log_path, tmpdir)。

    break_model=True → 注入"坏状态"：把 _resolve_model_reference 打回
        原样返回裸模型名（模型名 → 联网查 hub → 撞直连超时）。
    before_fix=True → 完整复现 2026-11-05 事故前的状态：
        ① 用"修复前"的源码副本（无 bootstrap、无本地快照解析）
        ② HF_HOME / HF_HUB_CACHE 指向**空的** systemprofile 缓存
           （= server 以 SYSTEM 账户运行时的真实环境）
        ③ HF_HUB_OFFLINE=1 → 不联网，直接抛
           LocalEntryNotFoundError（用户看到的那一类错误），
           确定性且不拖时间
    """
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    tmpdir = tempfile.mkdtemp(prefix="whisper_e2e_")
    wrapper = os.path.join(tmpdir, "run_port.py")
    server_path = SERVER
    # env_patch 必须在 exec_module **之前**执行 —— huggingface_hub 在
    # import 时就把 HF_HUB_CACHE 读死了（whisper_server 的设计正是
    # 为了赶在 faster_whisper import 之前纠正它）。
    env_patch = ""
    post_patch = ""
    if before_fix:
        server_path = make_before_fix_copy(tmpdir)
        # 空缓存目录：用临时目录而不是 systemprofile —— 普通用户无权在
        # systemprofile 下建目录，而且"空"这件事跟路径无关。
        empty_cache = os.path.join(tmpdir, "empty_hf_cache")
        os.makedirs(empty_cache, exist_ok=True)
        env_patch = (
            "import os as _os\n"
            "_os.environ['HF_HOME'] = %r\n"
            "_os.environ['HF_HUB_CACHE'] = %r\n"
            "_os.environ['HF_HUB_OFFLINE'] = '1'\n" % (empty_cache, empty_cache)
        )
    elif break_model:
        post_patch = (
            "def _broken(name):\n"
            "    return name or 'tiny'\n"
            "mod._resolve_model_reference = _broken\n"
        )
    with open(wrapper, "w", encoding="utf-8") as f:
        f.write(
            "import importlib.util, sys\n"
            "%s"
            "spec = importlib.util.spec_from_file_location('ws', %r)\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "sys.modules['ws'] = mod\n"
            "spec.loader.exec_module(mod)\n"
            "%s"
            "mod.PORT = %d\n"
            "mod.main()\n" % (env_patch, server_path, post_patch, port)
        )
    if extra_env:
        env.update(extra_env)
    log_path = os.path.join(tmpdir, "server.log")
    logf = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-B", wrapper],
        stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=tmpdir,
    )
    return proc, log_path, tmpdir


def main():
    if not os.path.exists(SERVER):
        print("whisper_server.py not found")
        return 1

    print("=== whisper_server 端到端探针 ===")
    tmp = tempfile.mkdtemp(prefix="whisper_e2e_")
    proc = None
    log_path = None
    try:
        wav = os.path.join(tmp, "tone.wav")
        make_wav(wav)

        port = free_port()
        print("  starting server on port %d ..." % port)
        proc, log_path, srv_tmp = run_case("normal", port)

        health = wait_health(port)
        check("E1 /health ok:true", health.get("ok") is True, json.dumps(health)[:300])

        t0 = time.time()
        status, payload = post_transcribe(port, wav, model="tiny")
        elapsed = time.time() - t0
        print("  /transcribe -> %s (%.1fs) %s" % (
            status, elapsed, json.dumps(payload, ensure_ascii=False)[:200]))
        check("E2 /transcribe 返回 200（不再 500）", status == 200, "status=%s" % status)
        check("E2b /transcribe 返回体含 segments",
              isinstance(payload, dict) and "segments" in payload,
              json.dumps(payload, ensure_ascii=False)[:300])
        if status != 200:
            err = str(payload.get("error", ""))
            check("E2c 错误不是 ConnectTimeout", "ConnectTimeout" not in err, err[:200])
            check("E2d 错误不是 LocalEntryNotFoundError",
                  "LocalEntryNotFoundError" not in err, err[:200])

        # 读日志
        time.sleep(0.5)
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            log = f.read()
        print("  --- server log (tail) ---")
        for line in log.strip().splitlines()[-25:]:
            print("    " + line)

        check("E3 日志出现 'resolved to local snapshot'（走了离线本地模型）",
              "resolved to local snapshot" in log)
        check("E4 日志无 ConnectTimeout", "ConnectTimeout" not in log)
        check("E4b 日志无 LocalEntryNotFoundError",
              "LocalEntryNotFoundError" not in log)
        check("E4c 日志无 huggingface.co 下载痕迹",
              "huggingface.co" not in log, log[-500:])
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    # ---- E5: 断网模式（HF_HUB_OFFLINE=1）下依然能转录 -----------------
    print("")
    print("  --- E5: 离线模式（HF_HUB_OFFLINE=1）重测 ---")
    tmp2 = tempfile.mkdtemp(prefix="whisper_e2e_off_")
    proc2 = None
    try:
        wav2 = os.path.join(tmp2, "tone.wav")
        make_wav(wav2)
        port2 = free_port()
        proc2, log2, srv2 = run_case(
            "offline", port2,
            extra_env={
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                # 明确禁止任何代理可用性假设
                "HTTP_PROXY": "",
                "HTTPS_PROXY": "",
            },
        )
        h2 = wait_health(port2)
        check("E5a 离线模式 /health ok:true", h2.get("ok") is True,
              json.dumps(h2)[:200])
        status2, payload2 = post_transcribe(port2, wav2, model="tiny")
        print("  /transcribe(offline) -> %s %s" % (
            status2, json.dumps(payload2, ensure_ascii=False)[:200]))
        check("E5b 离线模式 /transcribe 返回 200", status2 == 200,
              "status=%s err=%s" % (status2, str(payload2)[:300]))
        check("E5c 离线模式返回体含 segments",
              isinstance(payload2, dict) and "segments" in payload2)
        # /health 必须暴露本地模型解析诊断 —— 用户靠它判断"跑的是不是
        # 新代码"。旧代码没有这个字段，一眼就能看出来。
        h2b = wait_health(port2)
        mr = h2b.get("model_resolution")
        check("E5d /health 暴露 model_resolution（用户判断新旧代码的依据）",
              isinstance(mr, dict), json.dumps(h2b)[:300])
        if isinstance(mr, dict):
            check("E5e model_resolution.hf_hub_cache 指向存在的目录",
                  bool(mr.get("hf_hub_cache")) and os.path.isdir(mr["hf_hub_cache"]),
                  str(mr.get("hf_hub_cache")))
            check("E5f local_models 里 tiny 解析到了本地快照",
                  bool((mr.get("local_models") or {}).get("tiny")),
                  json.dumps(mr.get("local_models"), ensure_ascii=False)[:300])
    finally:
        if proc2 is not None:
            proc2.terminate()
            try:
                proc2.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc2.kill()
        shutil.rmtree(tmp2, ignore_errors=True)

    # ---- E6: 红/绿反向验证 --------------------------------------------
    # 忠实复现用户 2026-11-05 的那次 500：
    #   用"修复前"的源码副本 + 空的 systemprofile 缓存 + 裸模型名
    #   → 必然触发 ConnectTimeout / LocalEntryNotFoundError。
    # 如果这里居然成功，说明探针是假阳性（E2 的 PASS 不可信）。
    print("")
    print("  --- E6: 红/绿反向验证（修复前源码 + SYSTEM 空缓存）---")
    tmp3 = tempfile.mkdtemp(prefix="whisper_e2e_bad_")
    proc3 = None
    try:
        wav3 = os.path.join(tmp3, "tone.wav")
        make_wav(wav3)
        port3 = free_port()
        proc3, log3, srv3 = run_case("broken", port3, before_fix=True)
        wait_health(port3)
        t3 = time.time()
        try:
            status3, payload3 = post_transcribe(port3, wav3, model="tiny")
        except Exception as exc:  # noqa: BLE001
            status3, payload3 = "EXC", {"error": str(exc)}
        el3 = time.time() - t3
        print("  /transcribe(before-fix) -> %s (%.1fs) %s" % (
            status3, el3, json.dumps(payload3, ensure_ascii=False)[:300]))
        broken_ok = (
            status3 != 200
            or "ConnectTimeout" in str(payload3)
            or "LocalEntryNotFoundError" in str(payload3)
        )
        check("E6 修复前确实失败（证明探针不是假阳性）", broken_ok,
              "status=%s payload=%s" % (status3, json.dumps(payload3, ensure_ascii=False)[:300]))
        time.sleep(0.3)
        with open(log3, "r", encoding="utf-8", errors="replace") as f:
            log3txt = f.read()
        print("  --- before-fix server log (tail) ---")
        for line in log3txt.strip().splitlines()[-12:]:
            print("    " + line)
        check("E6b 修复前日志里没有 'resolved to local snapshot'",
              "resolved to local snapshot" not in log3txt)
    finally:
        if proc3 is not None:
            proc3.terminate()
            try:
                proc3.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc3.kill()
        shutil.rmtree(tmp3, ignore_errors=True)

    # ---- E7: 量化收益 -------------------------------------------------
    # 修复前：模型加载要联网查 hub → 撞直连超时 → 26s+ 或直接报错
    # 修复后：直接加载本地 snapshot → <2s
    print("")
    print("  --- E7: 量化（修复后模型加载耗时）---")
    check("E7 修复后 /transcribe 全程 < 15s（修复前需 26s+ 或超时）",
          elapsed < 15, "elapsed=%.1fs" % elapsed)

    print("")
    print("=== %d passed, %d failed ===" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("  FAILED: %s  %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
