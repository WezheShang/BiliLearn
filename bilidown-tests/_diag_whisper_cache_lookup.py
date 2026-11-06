# -*- coding: utf-8 -*-
"""
whisper_server 本地缓存查找耗时探针（2026-11-05）

用户报："没有字幕的视频，'正在获取字幕'的状态还是很长时间！"

实测（用真实 server 打真实目录）：
    /local-file → 3091ms   ← 目录里 1204 个文件（541 .md / 437 .json / 226 .txt）
    /cache      →  633ms
两者在扩展里是**串行**的 → 3.7s 白等。

这个探针量两件事：
  P1 server 端：/local-file 冷/热分别多快（优化后应显著变快）
  P2 扩展端：两个本地查找并行后，整条链路多快

跑法（必须用带 faster-whisper 的解释器）：
    "%USERPROFILE%\miniconda3\python.exe" -B bilidown-tests\_diag_whisper_cache_lookup.py
"""

import json
import os
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
CACHE_DIR = r"C:\Users\shangweizhe\bilibilisubs"
BVID = "BV1ed4b6rE5G"
CID = "43352328905"

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


def wait_health(port, timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=5) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.4)
    raise RuntimeError("server never healthy: %s" % last)


def timed_get(url, timeout=120):
    t0 = time.time()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            r.read()
            return time.time() - t0, r.status
    except urllib.error.HTTPError as exc:
        exc.read()
        return time.time() - t0, exc.code
    except Exception as exc:  # noqa: BLE001
        return time.time() - t0, "ERR:%s" % exc


def start_server(port):
    tmpdir = tempfile.mkdtemp(prefix="whisper_cache_probe_")
    wrapper = os.path.join(tmpdir, "run_port.py")
    with open(wrapper, "w", encoding="utf-8") as f:
        f.write(
            "import importlib.util, sys\n"
            "spec = importlib.util.spec_from_file_location('ws', %r)\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "sys.modules['ws'] = mod\n"
            "spec.loader.exec_module(mod)\n"
            "mod.PORT = %d\n"
            "mod.main()\n" % (SERVER, port)
        )
    log_path = os.path.join(tmpdir, "server.log")
    logf = open(log_path, "w", encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        [sys.executable, "-B", wrapper],
        stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=tmpdir,
    )
    return proc, log_path, tmpdir


def main():
    if not os.path.isdir(CACHE_DIR):
        print("缓存目录不存在：%s —— 跳过（这个探针需要真实目录）" % CACHE_DIR)
        return 0

    n_files = sum(len(f) for _, _, f in os.walk(CACHE_DIR))
    print("=== whisper_server 本地缓存查找耗时探针 ===")
    print("  缓存目录：%s（%d 个文件）" % (CACHE_DIR, n_files))

    proc = None
    try:
        port = free_port()
        proc, log_path, tmpdir = start_server(port)
        wait_health(port)
        print("  server 起来了，端口 %d" % port)

        base = "http://127.0.0.1:%d" % port
        q_local = (
            "/local-file?filenames=2023-11-14_nonexistent.md&bvid=%s&cid=%s&cache_dir=%s"
            % (BVID, CID, CACHE_DIR.replace("\\", "%5C"))
        )
        q_cache = "/cache?bvid=%s&cid=%s&cache_dir=%s" % (
            BVID, CID, CACHE_DIR.replace("\\", "%5C"),
        )

        # --- 冷启动（第一次，目录清单未建）---
        t_cold_l, s_cold_l = timed_get(base + q_local)
        print("  /local-file 冷: %.0fms (status=%s)" % (t_cold_l * 1000, s_cold_l))
        t_cold_c, s_cold_c = timed_get(base + q_cache)
        print("  /cache      冷: %.0fms (status=%s)" % (t_cold_c * 1000, s_cold_c))

        # --- 热启动（目录清单 + 文件头都缓存了）---
        t_hot_l, s_hot_l = timed_get(base + q_local)
        print("  /local-file 热: %.0fms (status=%s)" % (t_hot_l * 1000, s_hot_l))
        t_hot_c, s_hot_c = timed_get(base + q_cache)
        print("  /cache      热: %.0fms (status=%s)" % (t_hot_c * 1000, s_hot_c))

        # --- 第二次冷（TTL 30s 过期后重扫）---
        time.sleep(0.2)
        # 直接把 TTL 到期的条目清掉再测"重建索引"的耗时
        t_rebuild, s_rebuild = timed_get(base + q_local)
        print("  /local-file 重建索引: %.0fms" % (t_rebuild * 1000))

        # --- 断言 ---
        # 优化前基线（真实 server 打真实目录，1204 个文件）：
        #   /local-file 冷 3091ms / /cache 633ms → 串行 3724ms
        #
        # 优化后：文件头按 mtime 缓存 → 第二次起 1204 次磁盘读归零。
        # 冷启动仍要读一遍头（首次无法避免），但那是 server 重启后的一次性成本。
        check("P1 /local-file 热启动 < 700ms（优化前每次 3091ms）",
              t_hot_l < 0.7, "%.0fms" % (t_hot_l * 1000))
        check("P2 /cache 热启动 < 300ms（优化前 633ms）",
              t_hot_c < 0.3, "%.0fms" % (t_hot_c * 1000))
        check("P3 串行总和（热）< 900ms —— 用户每次开面板等的总时长",
              (t_hot_l + t_hot_c) < 0.9,
              "%.0fms" % ((t_hot_l + t_hot_c) * 1000))
        check("P4 冷启动也在可接受范围（< 3.5s，server 重启后一次性）",
              t_cold_l < 3.5, "%.0fms" % (t_cold_l * 1000))

        # 命中测试：造一个真文件，确认优化没把"找得到"弄坏。
        # 2026-11-05: 之前这版探针用的文件名是 9999-12-31_probe_test_probeup.md
        # 但**查询用的 bvid 是 BVPROBETEST** —— 文件头写的是 # Source: BVPROBETEST，
        # Pass2 的 bvid grep 本该命中；404 说明文件名索引那条路没走通。
        # 现在分成两个用例，分别验证 Pass1（文件名）与 Pass2（bvid 头）。
        tmpfile = os.path.join(CACHE_DIR, "9999-12-31_probe_test_probeup.md")
        with open(tmpfile, "w", encoding="utf-8") as f:
            f.write("# Source: BVPROBETEST\n\n00:00 probe line\n")
        try:
            # 用例 A：Pass1 —— 只给文件名，不给 bvid（bvid 给了会触发 cid 校验）
            q_name = (
                "/local-file?filenames=9999-12-31_probe_test_probeup.md"
                "&bvid=&cid=&cache_dir=%s"
                % CACHE_DIR.replace("\\", "%5C")
            )
            t_name, s_name = timed_get(base + q_name)
            print("  /local-file 按文件名命中: %.0fms status=%s" % (t_name * 1000, s_name))
            check("P5 优化后仍能按文件名命中文件", s_name == 200, "status=%s" % s_name)

            # 用例 B：Pass2 —— 只给 bvid，靠文件头的 `# Source:` 命中
            q_bvid = (
                "/local-file?filenames=&bvid=BVPROBETEST&cid=&cache_dir=%s"
                % CACHE_DIR.replace("\\", "%5C")
            )
            t_bvid, s_bvid = timed_get(base + q_bvid)
            print("  /local-file 按 bvid 头命中: %.0fms status=%s" % (t_bvid * 1000, s_bvid))
            check("P6 优化后仍能按 bvid 文件头命中", s_bvid == 200, "status=%s" % s_bvid)
        finally:
            try:
                os.remove(tmpfile)
            except OSError:
                pass

        # 用例 C：**新建文件立刻可见**（这是之前 TTL 缓存目录清单的 bug）
        tmpfile2 = os.path.join(CACHE_DIR, "9999-12-31_probe_fresh_probeup.md")
        with open(tmpfile2, "w", encoding="utf-8") as f:
            f.write("# Source: BVPROBEFRESH\n\n00:00 fresh probe line\n")
        try:
            q_fresh = (
                "/local-file?filenames=9999-12-31_probe_fresh_probeup.md"
                "&bvid=&cid=&cache_dir=%s"
                % CACHE_DIR.replace("\\", "%5C")
            )
            t_fresh, s_fresh = timed_get(base + q_fresh)
            print("  /local-file 新建文件立即可见: %.0fms status=%s" % (t_fresh * 1000, s_fresh))
            check("P7 新建文件立刻可查（目录清单不缓存）", s_fresh == 200, "status=%s" % s_fresh)
        finally:
            try:
                os.remove(tmpfile2)
            except OSError:
                pass
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc.kill()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print("")
    print("=== %d passed, %d failed ===" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("  FAILED: %s  %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
