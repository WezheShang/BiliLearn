r"""
bililearn Whisper local server
=============================
A small HTTP server that exposes `faster-whisper` to the bililearn Chrome
extension. The extension downloads the B-station audio to a local file, then
POSTs the file path here; we return timestamped segments.

Endpoints
---------
GET  /health          -> {ok, version, python:{executable,version},
                          deps:{faster_whisper,zhconv}, missing?, install_hint?,
                          current_model, device, compute_type, available_models}
                         ok:false = limited mode (faster-whisper missing);
                         nothing is ever auto-installed.
GET  /models          -> list of whisper model sizes available
POST /transcribe       body: {audio_path, model?, language?, beam_size?}
                        -> {language, duration, segments:[{start,end,text}]}
                        503 + install command when deps are missing.

Start manually
--------------
    C:\Users\username\miniconda3\python.exe C:\Users\username\bililearn\whisper_server.py
    # or double-click start_whisper_server.bat

The first time you transcribe with a new model, faster-whisper downloads the
weights to %LOCALAPPDATA%\faster-whisper\... (~75MB for "base", ~1.5GB
for "large-v3"). Subsequent runs are cached.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# HF cache bootstrap (2026-11-05)
#
# **MUST run before `from faster_whisper import WhisperModel`.**
#
# huggingface_hub captures `HF_HUB_CACHE` into `huggingface_hub.constants`
# at *import time* — setting os.environ afterwards has no effect on where
# snapshots are looked up / downloaded. So the cache pointer has to be in
# place before the first import of faster_whisper (which pulls
# huggingface_hub in transitively).
#
# Why this matters: this server may run as **SYSTEM** (the auto-start
# path), and SYSTEM's HF cache
# (C:\Windows\System32\config\systemprofile\.cache\huggingface) is EMPTY,
# while the models the user actually downloaded live in the interactive
# user's cache (C:\Users\<user>\.cache\huggingface\hub). Compounding it,
# this machine **cannot reach huggingface.co directly** (curl direct =
# 14.7s timeout; through the system proxy = 1.2s OK), so every lookup
# became an online download that died with ConnectTimeout ->
# LocalEntryNotFoundError -> HTTP 500.
#
# Fix: point HF at the cache that actually contains the models, before
# anything imports huggingface_hub. Model *loading* then goes through an
# explicit local-snapshot path (see `_resolve_model_reference`) so it is
# fully offline.
# ---------------------------------------------------------------------------
import glob as _glob


def _hf_search_roots():
    """所有可能的 HuggingFace hub 缓存根，按"最可能有模型"排序。"""
    roots = []
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    roots.append(os.environ.get("HF_HOME"))
    roots.append(os.environ.get("HF_HUB_CACHE"))
    # 交互式用户的缓存（SYSTEM 运行时 USERPROFILE 指向 systemprofile）
    roots.append(os.path.join(home, ".cache", "huggingface", "hub"))
    drive = os.environ.get("SystemDrive", "C:")
    roots.append(
        os.path.join(
            drive + "\\", "Windows", "System32", "config", "systemprofile",
            ".cache", "huggingface", "hub",
        )
    )
    # 扫一遍所有用户 profile —— 比硬编码某个用户名更耐换机
    for profile in sorted(_glob.glob(os.path.join(drive + "\\", "Users", "*"))):
        candidate = os.path.join(profile, ".cache", "huggingface", "hub")
        if os.path.isdir(candidate):
            roots.append(candidate)
    # 去重但保序
    seen = set()
    ordered = []
    for r in roots:
        if not r:
            continue
        key = os.path.normcase(os.path.abspath(r))
        if key in seen:
            continue
        seen.add(key)
        ordered.append(r)
    return ordered


def _root_has_models(root):
    """这个 HF 缓存根里是否真的有**可离线加载**的 faster-whisper 模型。

    判据必须和 `_find_local_model_snapshot` 一致：快照目录里要有
    model.bin（CT2 权重本体）。只看 repo/snapshots 目录存在是不够的
    —— 下载中断的缓存会留下空快照目录，把它当成"有模型"就会让
    `_bootstrap_hf_cache` 指向一个残缺缓存，然后照样去联网下载。
    """
    try:
        names = os.listdir(root)
    except OSError:
        return False
    for n in names:
        if not n.startswith("models--Systran--faster-whisper-"):
            continue
        snapshots = os.path.join(root, n, "snapshots")
        try:
            entries = os.listdir(snapshots)
        except OSError:
            continue
        for entry in entries:
            if os.path.isfile(os.path.join(snapshots, entry, "model.bin")):
                return True
    return False


def _bootstrap_hf_cache():
    """把 HF_HOME / HF_HUB_CACHE 指向真的装得下模型的缓存根。

    必须早于 faster_whisper 的 import 调用。
    """
    fallback = None
    for root in _hf_search_roots():
        if not os.path.isdir(root):
            continue
        if fallback is None:
            fallback = root
        if _root_has_models(root):
            os.environ["HF_HOME"] = os.path.dirname(root.rstrip("/\\"))
            os.environ["HF_HUB_CACHE"] = root
            return root
    if fallback is not None:
        os.environ["HF_HUB_CACHE"] = fallback
        return fallback
    return None


_bootstrap_hf_cache()

# ---------------------------------------------------------------------------
# Transparent dependency handling (2026-08-30 rework).
#
# bililearn never silently pip-installs into the user's Python. If
# faster-whisper is missing we still START this server in "limited mode":
#   /health     -> ok:false + missing list + the exact python executable
#   /transcribe -> 503 with the exact install command
# so the extension options page (检查系统 button) can show the user
# precisely what is absent and let them decide how to install it.
# ---------------------------------------------------------------------------
FW_VERSION = None
WhisperModel = None
FW_IMPORT_ERROR = None
# 2026-09-04 (user report on Python 3.13): faster-whisper itself
# installs fine via pip (the wheel is pure-Python for faster_whisper),
# but importing it pulls in ctranslate2 — whose DLL load fails on a
# fresh Windows install that lacks the Visual C++ 2015-2022
# redistributable. The error surfaces as OSError (FileNotFoundError
# on a DLL), NOT ImportError, so the original except clause below
# misses it. We catch OSError too and tag the missing-dep list with
# "vc_redist" so the options page can show the user the right link.
FW_CTRANSLATE2_ERROR = None
try:
    from faster_whisper import WhisperModel, __version__ as FW_VERSION
except ImportError as exc:
    FW_IMPORT_ERROR = str(exc)
except OSError as exc:
    # ctranslate2.dll not found, or one of its native deps (msvcp140,
    # vcruntime140, concrt140) is missing — all caused by the absence
    # of the Visual C++ 2015-2022 x64 redistributable on Windows.
    FW_IMPORT_ERROR = f"ctranslate2 native deps missing: {exc}"
    FW_CTRANSLATE2_ERROR = str(exc)


def _zhconv_version():
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("zhconv")
    except Exception:
        try:
            import zhconv as _zc
            return getattr(_zc, "__version__", "installed")
        except Exception:
            return None


ZHCONV_VERSION = _zhconv_version()


# ---------------------------------------------------------------------------
# yt-dlp (YouTube downloader) — 2026-09-27
#
# Used by the /youtube/* endpoints to extract metadata + audio + auto
# captions from youtube.com / youtu.be URLs. Treated with the same
# "limited mode" philosophy as faster-whisper: if yt-dlp is missing we
# still START this server, but /youtube/* endpoints return 503 with an
# install hint and /health surfaces "yt_dlp" as a missing dep.
# ---------------------------------------------------------------------------
YTDLP_VERSION = None
YTDLP_IMPORT_ERROR = None
try:
    import yt_dlp
    YTDLP_VERSION = getattr(yt_dlp, "version", None).__version__ if hasattr(yt_dlp, "version") else None
    if YTDLP_VERSION is None:
        # yt-dlp 2024+ exposes version under yt_dlp.version.__version__
        from importlib.metadata import version as _pkg_version
        YTDLP_VERSION = _pkg_version("yt-dlp")
except ImportError as exc:
    YTDLP_IMPORT_ERROR = str(exc)


def _missing_deps():
    missing = []
    if FW_VERSION is None:
        missing.append("faster-whisper")
    if FW_CTRANSLATE2_ERROR is not None:
        # Surface this as a separate "vc_redist" dep so the options
        # page can show a different fix (install VC++ runtime) than
        # the "pip install faster-whisper zhconv" hint.
        missing.append("vc_redist")
    if YTDLP_VERSION is None:
        missing.append("yt-dlp")
    return missing

HOST = os.environ.get("BILILEARN_WHISPER_HOST", "127.0.0.1")
# 2026-11-05: 端口可由环境变量覆盖。
#
# 为什么需要：现役的 server 是**SYSTEM 账户**跑的（开机自启任务
# bililearn-whisper-server-autostart-system），普通用户权限杀不掉
# （taskkill 报 "Access is denied"）。用户改了代码之后，那个旧进程
# 仍然在跑**旧代码**，于是：
#   - 旧代码不认识本地模型解析 → 每次都去 huggingface.co 下载 →
#     本机直连不通 → LocalEntryNotFoundError → 500
#   - 旧代码的 /local-file 要全目录读 1200 多个文件头 → 3.1 秒
#
# 而 Windows 的 SO_REUSEADDR 允许两个进程绑同一个端口，两个 server
# 抢 7860 会随机分发连接（"有时能转录、有时 Failed to fetch"）。
#
# 所以：让**用户权限**的实例跑在备用端口（默认 7861），扩展连它。
# SYSTEM 那个旧进程就变成一个无害的僵尸 —— 用户随时可以用管理员
# 权限重启它，把一切恢复成单实例。
PORT = int(os.environ.get("BILILEARN_WHISPER_PORT", "7860"))
DEFAULT_MODEL = "base"
AVAILABLE_MODELS = [
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "turbo",
]

# ---------------------------------------------------------------------------
# 本地模型解析（2026-11-05）
#
# 事故：用户点 Whisper 转录 → server 回 500
#   LocalEntryNotFoundError: Got: ConnectTimeout: [WinError 10060]
#
# 根因：faster-whisper 认模型名 "base" 时会去 HuggingFace Hub 在线拉
# `Systran/faster-whisper-base`。这台机器**直连 huggingface.co 不通**
# （实测 curl 直连 14.7s 超时；经系统代理 1.2s 通），于是 huggingface_hub
# 抛 ConnectTimeout，最终包装成 LocalEntryNotFoundError。
#
# 雪上加霜的是：这个 server 可能以 **SYSTEM 账户**运行（开机自启那条
# 路径），而 SYSTEM 的 HF 缓存
# (C:\Windows\System32\config\systemprofile\.cache\huggingface) 是空的
# —— 模型明明已经在**用户**的缓存里
# (C:\Users\<user>\.cache\huggingface\hub\models--Systran--faster-whisper-*)
# 却找不到，于是每次都去下载，每次都超时。
#
# 修法（两道）：
#   1) 把 HF_HOME / HF_HUB_CACHE 指到"能找到的缓存"——优先用户缓存，
#      找不到才用自己账户的。已下载的模型直接离线加载，零网络。
#   2) 模型确实不在本地时，先试**本地快照目录**（snapshots/...），再
#      退回在线下载；下载走系统代理（huggingface_hub 会读
#      HTTPS_PROXY/requests 的 proxy 设置）。
#
# 目的：模型已下载时**绝不联网**（离线加载），从根上消除 ConnectTimeout。
# ---------------------------------------------------------------------------

# 用户缓存优先（SYSTEM 账户运行时也能找到用户已下好的模型）。
_USER_HOME = os.environ.get("USERPROFILE") or os.path.expanduser("~")
_MODEL_SEARCH_ROOTS = _hf_search_roots()


def _hf_repo_dir(model_name: str):
    """模型名 → HuggingFace cache 里的 repo 目录名。"""
    return "models--Systran--faster-whisper-%s" % model_name


def _find_local_model_snapshot(model_name: str):
    """在各个 HF 缓存根里找已经下载好的模型快照目录。

    返回 Path 或 None。快照目录里必须有 model.bin —— 那是 CT2 权重本体，
    没有它 faster-whisper 仍然会去网上拉。
    """
    repo_dir = _hf_repo_dir(model_name)
    for root in _MODEL_SEARCH_ROOTS:
        if not root:
            continue
        repo_path = os.path.join(root, repo_dir)
        snapshots = os.path.join(repo_path, "snapshots")
        if not os.path.isdir(snapshots):
            continue
        try:
            entries = sorted(os.listdir(snapshots))
        except OSError:
            continue
        for entry in entries:
            snap = os.path.join(snapshots, entry)
            if os.path.isfile(os.path.join(snap, "model.bin")):
                return Path(snap)
    return None


def _point_hf_at_local_cache():
    """把 HF_HOME / HF_HUB_CACHE 指到**真的装得下模型**的缓存根。

    这样即使没走本地快照的捷径，huggingface_hub 也能在缓存里命中已
    下载的文件，不会再去联网。

    注意：这里**直接覆盖**而不是 setdefault —— 以 SYSTEM 账户运行时
    进程里可能已经带着一个指向 systemprofile（空目录）的 HF_HOME，
    setdefault 不会纠正它，那正是本次 500 的一个诱因。
    """
    root = _bootstrap_hf_cache()
    if root is None:
        LOG.warning("no HuggingFace cache directory found; model download may fail")
        return None
    if _root_has_models(root):
        LOG.info("HF cache pointed at %s (contains models)", root)
    else:
        LOG.info("HF cache pointed at %s (no models found there)", root)
    return root


def _resolve_model_reference(name: str) -> str:
    """把 "base" 解析成"本地快照路径"（如果本机已经有）。

    找不到就原样返回模型名 —— 那时 faster-whisper 会走在线下载。
    """
    if not name or name in ("auto", "default"):
        name = DEFAULT_MODEL
    # 已经是本地目录（用户自建模型目录）→ 原样使用。
    try:
        if os.path.isdir(name):
            LOG.info("model reference is an existing directory: %s", name)
            return name
    except OSError:
        pass
    snapshot = _find_local_model_snapshot(name)
    if snapshot is not None:
        LOG.info("model %s resolved to local snapshot: %s", name, snapshot)
        return str(snapshot)
    LOG.info(
        "model %s not found in any local cache (%s); falling back to download",
        name,
        ", ".join(r for r in _MODEL_SEARCH_ROOTS if r),
    )
    return name

# ---------------------------------------------------------------------------
# /transcribe dedup — 2026-08-22
#
# The extension can fire the same transcription more than once (double-click
# on the trigger button, reopened sidepanel, "regenerate" while a run is in
# flight). whisper_server is a ThreadingHTTPServer, so each duplicate POST
# ran a FULL parallel CPU inference — observed live: three concurrent
# transcribes of the same 5.5-minute audio, each slowing the others down.
#
# Dedup key = sha256 of the audio bytes. First caller ("owner") runs the
# real transcription; concurrent callers with identical audio block on an
# event and receive the owner's result with `"reused": true`. Recent
# results are kept in a small LRU so a retry right after completion also
# reuses instead of re-running.
# ---------------------------------------------------------------------------
_TRANSCRIBE_LOCK = threading.Lock()
_TRANSCRIBE_JOBS = {}       # audio sha256 -> {"event", "result", "error"}
_TRANSCRIBE_JOB_ORDER = []  # insertion order for LRU pruning
_TRANSCRIBE_JOB_CAP = 8


def _transcribe_claim(audio_key):
    """Returns (is_owner, job). See the block comment above."""
    with _TRANSCRIBE_LOCK:
        job = _TRANSCRIBE_JOBS.get(audio_key)
        if job is None:
            job = {"event": threading.Event(), "result": None, "error": None}
            _TRANSCRIBE_JOBS[audio_key] = job
            _TRANSCRIBE_JOB_ORDER.append(audio_key)
            while len(_TRANSCRIBE_JOB_ORDER) > _TRANSCRIBE_JOB_CAP:
                _TRANSCRIBE_JOBS.pop(_TRANSCRIBE_JOB_ORDER.pop(0), None)
            return True, job
        return False, job
ALLOWED_AUDIO_DIRS = [
    Path(os.environ.get("TEMP", r"C:\Users\username\AppData\Local\Temp")),
    Path(r"C:\Users\username\bililearn\tmp"),
    Path(os.getcwd()),
]


# ---------------------------------------------------------------------------
# YouTube audio cache directory (2026-09-27).
#
# yt-dlp downloads land here as temporary files. The extension reads the
# audio bytes via GET /youtube/audio/<videoId>, then either forwards them
# to /transcribe or saves them for the user. Files older than
# _YT_AUDIO_TTL_SEC are swept on each new request.
#
# Lives under %TEMP% so ALLOWED_AUDIO_DIRS already covers it for
# /transcribe's path validation.
# ---------------------------------------------------------------------------
_YT_AUDIO_DIR = Path(os.environ.get("TEMP", r"C:\Users\username\AppData\Local\Temp")) / "bililearn_youtube"
_YT_AUDIO_TTL_SEC = 60 * 60  # 1 hour

# Lock held around `_YT_AUDIO_DIR.iterdir()` cleanup so two concurrent
# requests don't double-delete. YouTube downloads themselves are
# per-videoId so no need for a per-key lock — yt-dlp's
# `outtmpl` overwrites our previous download deterministically.
_YT_AUDIO_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# 字幕缓存目录扫描优化（2026-11-05）
#
# 用户报"没字幕的视频要等很久才提示"。实测（真实目录 1204 个文件）：
#   /local-file → 3091ms   ← 用户等的其实就是这段
#   /cache      →  633ms
# 两者在扩展里是**串行**的 → 3.7s 白等。
#
# 定位到瓶颈：**不是目录遍历，是逐个读文件头**。
#   os.walk 1204 个文件            →  22ms（几乎免费）
#   读 1204 个文件的头 2KB         → ~3000ms（1204 次磁盘读）
# Pass2 的 bvid grep 必须读每个文本文件的头（`# Source: BVxxx` /
# `"bvid": "BVxxx"` 都在文件顶部），所以这就是那 3 秒。
#
# 两个优化：
#   1) **文件头按 mtime 长期缓存**（_read_head_cached）—— 文件没改就
#      复用，第二次起这 1204 次磁盘读全部归零。
#   2) **目录清单每次重建**（只要 22ms）—— 不做 TTL 缓存。
#      之前用 30s TTL 缓存清单，结果"刚转录完的新文件 30 秒内查不到"
#      （探针 P6 抓到）—— 目录清单重建太便宜了，没理由缓存它。
#      真正该缓存的是文件**内容**，而内容有 mtime 把关。
# ---------------------------------------------------------------------------
_head_cache_lock = threading.Lock()
# Pass2 的 bvid grep 要读每个文本文件的头 —— 1200 多个文件就是 1200 多次
# 磁盘读，缓存住头内容能把这部分开销降到 0（mtime 没变就复用）。
_head_cache_store = {}
_HEAD_CACHE_MAX = 5000


def _read_head_cached(file_path):
    """读文件头 2KB，带 mtime 缓存。返回 str 或 None。

    mtime 变了就重读 —— 所以内容更新（比如刚转录完写入的文件）立刻可见，
    不存在"缓存过期"的问题。
    """
    try:
        stat = file_path.stat()
    except OSError:
        return None
    key = str(file_path)
    mtime = stat.st_mtime
    with _head_cache_lock:
        hit = _head_cache_store.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(2048)
    except OSError:
        return None
    with _head_cache_lock:
        if len(_head_cache_store) > _HEAD_CACHE_MAX:
            _head_cache_store.clear()
        _head_cache_store[key] = (mtime, head)
    return head


def _cache_index(cache_path):
    """返回 (文件名索引, 全量清单)。

    **每次都重建** —— os.walk 只要 ~22ms，而缓存清单会导致新建文件
    在 TTL 内查不到。真正贵的文件头读取由 _read_head_cached 负责缓存。
    """
    entries = []
    try:
        for root, _dirs, files in os.walk(cache_path):
            for filename in files:
                lower = filename.lower()
                if lower.endswith(".json"):
                    kind = "json"
                elif lower.endswith((".txt", ".md", ".srt", ".lrc")):
                    kind = "text"
                else:
                    continue
                entries.append((Path(root) / filename, lower, kind))
    except OSError:
        entries = []
    by_name = {}
    for path, lower, kind in entries:
        by_name.setdefault(lower, []).append(path)
    return by_name, entries


def invalidate_cache_index(cache_dir=None):
    """清掉文件头缓存（写完字幕后调用）。

    目录清单已经不缓存了（每次重建，~22ms），所以这里只需要清头缓存。
    头缓存靠 mtime 自校验，写完新文件后 mtime 会变 → 自动失效；
    但同路径覆写（同一文件改内容）时保险起见显式清一下。
    """
    with _head_cache_lock:
        if cache_dir is None:
            _head_cache_store.clear()
            return
        prefix = os.path.normcase(str(cache_dir))
        for key in [k for k in _head_cache_store
                    if os.path.normcase(k).startswith(prefix)]:
            _head_cache_store.pop(key, None)


def _yt_sweep_stale():
    """Delete audio files older than _YT_AUDIO_TTL_SEC. Best-effort."""
    cutoff = time.time() - _YT_AUDIO_TTL_SEC
    with _YT_AUDIO_LOCK:
        if not _YT_AUDIO_DIR.exists():
            return
        for entry in _YT_AUDIO_DIR.iterdir():
            try:
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink()
            except OSError:
                # File in use or already gone — ignore.
                pass

LOG = logging.getLogger("bililearn-whisper")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)


# Traditional → Simplified Chinese conversion for whisper output.
# whisper-tiny/base on Mandarin audio often produces Traditional
# characters (輸/別/體 instead of 输/别/体) — issue surfaced
# 2026-08-23. We normalize at the server so every downstream
# consumer (watchdog recovery, /cache, /local-file, client cache,
# future export) sees the same simplified form.
#
# `zhconv` is preferred (pure Python, no C extension, ~200KB).
# It is optional: if not installed we log a warning and write the
# raw text. Transcription must NEVER fail because of a missing
# normalization dep.
_T2S_WARN_ONCE = False


def _get_t2s_converter():
    """Return a callable that converts Traditional → Simplified Chinese.
    Falls back to identity if `zhconv` is not available.
    """
    global _T2S_WARN_ONCE
    try:
        from zhconv import convert as _zhc

        def _t2s(text):
            if not text:
                return text
            return _zhc(text, "zh-cn")

        return _t2s
    except ImportError:
        if not _T2S_WARN_ONCE:
            LOG.warning(
                "zhconv not installed — Traditional Chinese characters "
                "from whisper will NOT be normalized. Run: pip install zhconv"
            )
            _T2S_WARN_ONCE = True
        return lambda text: text

# Lazy model cache: keeps one model in memory and reloads only when size
# changes. Concurrent requests for the same model share the lock; a request
# for a different model waits for the swap.
_MODEL_LOCK = threading.Lock()
_CURRENT_MODEL_NAME: str | None = None
_CURRENT_MODEL: WhisperModel | None = None
_CURRENT_DEVICE: str | None = None
_CURRENT_COMPUTE: str | None = None


def _resolve_device() -> tuple[str, str]:
    """Return (device, compute_type) for the local hardware."""
    try:
        import torch  # noqa: F401  -- optional dependency
        if torch.cuda.is_available():
            return "cuda", "float16"
    except ImportError:
        pass
    return "cpu", "int8"


def _get_model(name: str):
    global _CURRENT_MODEL, _CURRENT_MODEL_NAME, _CURRENT_DEVICE, _CURRENT_COMPUTE
    if WhisperModel is None:
        raise RuntimeError(
            "faster-whisper is not installed "
            f"({FW_IMPORT_ERROR or 'import failed'}); run: "
            f'{sys.executable} -m pip install faster-whisper'
        )
    with _MODEL_LOCK:
        if _CURRENT_MODEL is not None and _CURRENT_MODEL_NAME == name:
            return _CURRENT_MODEL
        device, compute = _resolve_device()
        # 2026-11-05: 优先加载本地已下载的模型快照（离线，零网络）。
        # 本机直连 huggingface.co 不通，在线下载必然 ConnectTimeout →
        # LocalEntryNotFoundError → 500。快照不在才回落到在线下载。
        model_ref = _resolve_model_reference(name)
        LOG.info(
            "loading model=%s (ref=%s) device=%s compute=%s",
            name, model_ref, device, compute,
        )
        t0 = time.time()
        m = WhisperModel(model_ref, device=device, compute_type=compute)
        LOG.info("model loaded in %.1fs", time.time() - t0)
        _CURRENT_MODEL = m
        _CURRENT_MODEL_NAME = name
        _CURRENT_DEVICE = device
        _CURRENT_COMPUTE = compute
        return m


def _validate_audio_path(audio_path: str) -> Path:
    p = Path(audio_path).resolve()
    if not p.is_file():
        raise ValueError(f"audio file not found: {audio_path}")
    # Only accept files under known temp directories to avoid being an open
    # proxy that processes arbitrary paths on the user's machine.
    for allowed in ALLOWED_AUDIO_DIRS:
        try:
            p.relative_to(allowed.resolve())
            return p
        except ValueError:
            continue
    raise ValueError(
        f"audio path {p} is not under an allowed directory. "
        f"Place the file under one of: {[str(a) for a in ALLOWED_AUDIO_DIRS]}"
    )


def _serialize_segments(segments, info) -> dict:
    t2s = _get_t2s_converter()
    return {
        "language": info.language,
        "language_probability": float(info.language_probability),
        "duration": float(info.duration),
        "segments": [
            {
                "id": seg.id,
                "start": float(seg.start),
                "end": float(seg.end),
                "text": t2s(seg.text.strip()),
            }
            for seg in segments
        ],
    }


# ---------------------------------------------------------------------------
# YouTube helpers (2026-09-27).
#
# Single place where the YouTube-specific yt-dlp logic lives. Endpoints
# call these — never touch yt_dlp directly from the Handler.
#
# Errors raise `YtDlpError` so the route can translate to a stable
# `error_type` for the extension sidepanel (mirror of bilibili's
# classifyBilibiliError pattern).
# ---------------------------------------------------------------------------
class YtDlpError(Exception):
    """Raised by _yt_* helpers when yt-dlp can't satisfy the request."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# Canonical YouTube ID = 11 chars from `[A-Za-z0-9_-]`.
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _yt_normalize_video_id(raw: str) -> str:
    """Pull the 11-char video ID out of `youtu.be/ID`, `watch?v=ID`,
    `shorts/ID`, or a bare ID. Raises YtDlpError on bad input.
    """
    if not raw:
        raise YtDlpError("invalid_input", "empty video id")
    candidate = raw.strip()
    # Already bare ID?
    if _YT_ID_RE.match(candidate):
        return candidate
    # youtu.be/ID  → path-only ID
    m = re.search(r"youtu\.be/([A-Za-z0-9_-]{11})", candidate)
    if m:
        return m.group(1)
    # youtube.com/...?v=ID  or  /shorts/ID  or  /embed/ID
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", candidate)
    if m:
        return m.group(1)
    m = re.search(r"/(shorts|embed)/([A-Za-z0-9_-]{11})", candidate)
    if m:
        return m.group(2)
    raise YtDlpError("invalid_input", f"cannot extract YouTube video id from {raw!r}")


def _yt_check_available():
    """Raise YtDlpError('not_available') if yt-dlp isn't importable."""
    if YTDLP_VERSION is None:
        hint = (
            f"{sys.executable} -m pip install yt-dlp"
            if YTDLP_IMPORT_ERROR is None
            else f"{sys.executable} -m pip install yt-dlp ({YTDLP_IMPORT_ERROR})"
        )
        raise YtDlpError("not_available", f"yt-dlp is not installed. Hint: {hint}")


# Quoted yt-dlp progress lines look like
#   [download]  12.3% of  10.45MiB at  1.23MiB/s ETA 00:08
_YT_PROGRESS_RE = re.compile(r"\[download\]\s+(\d+\.\d+)%")


def _yt_quiet_opts(
    proxy: str | None = None,
    cookiefile: str | None = None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Base yt-dlp options that suppress noise and force safe defaults.

    `proxy` is optional: youtube.com is reachable from this machine only
    through the system proxy (HKCU registry ProxyEnable=1,
    127.0.0.1:15236). Direct connection times out. Callers that don't
    pass a proxy will get the documented "Connection to www.youtube.com
    timed out" error — the user can set the proxy in the options page
    and we re-fetch successfully.

    `cookiefile` (2026-09-28, Irene regression): absolute path to a
    Netscape cookies file yt-dlp should read. The caller owns the
    file (writes the temp file from cookies_text via
    `_yt_open_inline_cookies`, then calls `_yt_unlink_quietly` after
    the yt-dlp call). We never bake a hardcoded path here.

    `cookies_from_browser` (2026-09-29, second regression): yt-dlp
    reads cookies DIRECTLY from the named browser's SQLite DB at
    `%LOCALAPPDATA%/<browser>/User Data/<profile>/Network/Cookies`.
    This is the cleanest path for the "Sign in to confirm you're not
    a bot" wall: the cookies come from the exact same store the user's
    real Chrome session uses, so YouTube's risk engine sees an
    authentic cookie/IP/browser fingerprint combination. Takes
    precedence over `cookiefile` (the latter is the manual-export
    fallback). Supported browser keys: chrome, chromium, edge, firefox,
    brave, opera, safari, vivaldi — yt-dlp handles the platform
    paths internally.

    `cookies_from_browser_profile` (2026-09-29): optional profile
    directory name (Default / Profile 1 / etc.). Defaults to None,
    which yt-dlp resolves to the browser's default profile. The
    Windows-Chrome user on this machine has `Default` (verified in
    9/28 storage forensics) so we never need to set it; exposed for
    users with multiple Chrome profiles.
    """
    opts = {
        "quiet": True,
        "no_warnings": True,
        # Don't write description / info JSON / annotations next to audio.
        "writedescription": False,
        "writeinfojson": False,
        "writeannotations": False,
        # Skip the actual download — used by /youtube/info.
        "skip_download": True,
        # YouTube blocks the default `web` client when downloading actual
        # video segments (403 Forbidden on googlevideo.com). The
        # `tv_embedded` + `web_safari` pair is the most reliable bypass
        # as of yt-dlp 2026.06 — works without a logged-in cookie.
        # See https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube
        # 2026-09-28 (Irene regression through system proxy
        # 127.0.0.1:15236): tried expanding the client list to
        # `web_creator` + `ios` first, hoping a different bot-detection
        # fingerprint would slip through the datacentred-IP block.
        # Verified Rick Astley (dQw4w9WgXcQ, public for 17 years) and
        # the first-ever YouTube video (jNQXAC9IVRw) both still 502
        # "Sign in to confirm you're not a bot" — fingerprint rotation
        # does NOT bypass an IP-level block. Keeping the proven
        # tv_embedded-first list.
        "extractor_args": {
            "youtube": {
                "player_client": ["tv_embedded", "web_safari", "android_vr"],
                # Skip iOS TV — known to 403 on segment fetches.
                "skip": ["translated_subs", "dash"],
            }
        },
    }
    if proxy:
        opts["proxy"] = proxy
    if cookiefile:
        opts["cookiefile"] = cookiefile
    if cookies_from_browser:
        # yt-dlp expects a TUPLE of (browser, profile?, keyring?) — we
        # only ever pass the browser name + optional profile; never
        # ask yt-dlp to unlock a keyring (Chrome on Windows stores
        # cookies unencrypted in the SQLite DB, no keyring needed).
        profile_tuple = (
            (cookies_from_browser, cookies_from_browser_profile)
            if cookies_from_browser_profile
            else (cookies_from_browser,)
        )
        opts["cookiesfrombrowser"] = profile_tuple
    return opts


def _yt_open_inline_cookies(cookies_text: str, basename: str) -> Path:
    """Write a temp Netscape cookies file under _YT_AUDIO_DIR.

    `basename` is used as a filename prefix so the extension can tell
    `_cookies_<videoId>.txt` apart from any other test artifacts in the
    same directory. Caller MUST call `_yt_unlink_quietly` in a finally
    block so the auth cookies do not outlive the request. If
    `cookies_file` (an explicit path) is also provided by the caller,
    prefer that and never call this — see the priority order in
    `_yt_download_audio` / `_yt_extract_info`.
    """
    path = _YT_AUDIO_DIR / f"_cookies_{basename}_{os.getpid()}.txt"
    path.write_text(cookies_text, encoding="utf-8")
    return path


def _yt_unlink_quietly(path: Path | None) -> None:
    """Best-effort cleanup for the inline cookies temp file. Never
    raises — the request is already finished by the time we get here
    and a stuck file is harmless (under _YT_AUDIO_DIR, scoped to PID,
    swept by `_yt_sweep_stale`)."""
    if path is None:
        return
    try:
        path.unlink()
    except OSError:
        pass


def _extract_info_with_cookies(
    url: str,
    proxy: str | None,
    cookies_file: str | None,
    cookies_text: str | None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Run yt-dlp's extract_info(download=False) with optional cookies.

    Cookies priority (2026-09-29):
      1. `cookies_from_browser` (e.g. "chrome") — yt-dlp reads
         cookies directly from the browser's SQLite DB at runtime.
         This is the cleanest path for YouTube's bot wall: cookies
         come from the exact same store the user's real session uses,
         so the cookies/IP/browser-fingerprint combination matches
         what YouTube's risk engine expects to see.
      2. `cookies_file` — explicit absolute path to a cookies.txt the
         user exported manually (Netscape format, BOM-free ASCII).
      3. `cookies_text` — raw Netscape string (chrome.cookies.getAll
         output, or pasted into the options page textarea).
    When more than one is given, the higher-priority one wins and the
    lower ones are ignored. When none is set, yt-dlp tries
    unauthenticated — fine for most non-restricted videos, but
    YouTube's "Sign in to confirm you're not a bot" wall always
    returns 403 without auth.
    """
    _yt_check_available()
    inline_path: Path | None = None
    try:
        # 1st priority: cookies_from_browser takes the cake.
        cookiefile = None
        use_browser = bool(cookies_from_browser)
        if not use_browser:
            if cookies_file and cookies_text:
                cookies_text = None  # explicit path wins, drop inline
            if cookies_file:
                cookiefile = cookies_file
            elif cookies_text:
                inline_path = _yt_open_inline_cookies(cookies_text, basename="info")
                cookiefile = str(inline_path)
        opts = _yt_quiet_opts(
            proxy=proxy,
            cookiefile=cookiefile,
            cookies_from_browser=cookies_from_browser if use_browser else None,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )
        with yt_dlp.YoutubeDL(opts) as ydl:
            try:
                return ydl.extract_info(url, download=False)
            except yt_dlp.utils.DownloadError as exc:
                raise YtDlpError("unavailable", str(exc)) from exc
            except Exception as exc:  # noqa: BLE001
                raise YtDlpError("network", f"{type(exc).__name__}: {exc}") from exc
    finally:
        _yt_unlink_quietly(inline_path)


def _yt_extract_info(
    url: str,
    proxy: str | None = None,
    cookies_file: str | None = None,
    cookies_text: str | None = None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Metadata only — no download. Used by /youtube/info and as the
    pre-flight by /youtube/subtitle (so we know which manual / auto
    track to actually download before issuing a second yt-dlp call)."""
    return _extract_info_with_cookies(
        url, proxy, cookies_file, cookies_text,
        cookies_from_browser, cookies_from_browser_profile,
    )


def _yt_format_metadata(info: dict) -> dict:
    """Translate yt-dlp's dict into the stable shape the extension sees."""
    return {
        "videoId": info.get("id"),
        "title": info.get("title") or "",
        "channel": info.get("uploader") or info.get("channel") or "",
        "channelId": info.get("channel_id") or info.get("uploader_id") or "",
        "uploadDate": info.get("upload_date") or "",  # YYYYMMDD
        "duration": int(info.get("duration") or 0),
        "thumbnail": info.get("thumbnail") or "",
        "description": info.get("description") or "",
        # Available auto / manual caption tracks. yt-dlp uses BCP-47 codes
        # like "zh-Hans", "en", "ja". The extension prefers zh-Hans then en.
        "availableSubtitleLangs": list((info.get("subtitles") or {}).keys())
        + [k for k, v in (info.get("automatic_captions") or {}).items() if v],
        "webpageUrl": info.get("webpage_url") or "",
    }


def _yt_download_audio(
    video_id: str,
    url: str,
    proxy: str | None = None,
    cookies_file: str | None = None,
    cookies_text: str | None = None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Download audio-only to _YT_AUDIO_DIR/<videoId>.<ext>. Returns
    `{path, ext, videoId}` so the extension can stream it back via
    GET /youtube/audio/<videoId>.

    Picks the smallest audio-only format. Speech recognition doesn't
    benefit from high-bitrate audio — the same trade-off as
    fetchBilibiliAudioBlob's `audioTracks[0]` choice.

    Three ways to authenticate with YouTube (only one is needed):
      - `cookies_from_browser` (2026-09-29, preferred) — yt-dlp reads
        cookies directly from the named browser's SQLite DB at
        request time. Cleanest path: cookies come from the exact
        same store the user's real session uses, so YouTube's risk
        engine sees an authentic cookie/IP/browser combination.
      - `cookies_file` (optional) is an absolute path to a Netscape
        cookies.txt on disk. Used when the user explicitly exported
        cookies from a different browser profile.
      - `cookies_text` (optional) is the raw Netscape-format string
        the extension built from chrome.cookies.getAll. We write it
        to a temp file under _YT_AUDIO_DIR for yt-dlp to consume, then
        delete the file in a finally block.
    Required to bypass the 403 Forbidden that googlevideo.com returns
    to bot-flagged clients even when the metadata fetch succeeds.
    """
    _yt_check_available()
    if not cookies_from_browser:
        if cookies_file and cookies_text:
            # Defensive: caller passed both. Prefer the explicit path
            # (user override) and ignore the inline text.
            cookies_text = None
        if cookies_file:
            cpath = Path(cookies_file)
            if not cpath.is_file():
                raise YtDlpError(
                    "cookies_missing",
                    f"cookies file not found: {cookies_file}",
                )
    _yt_sweep_stale()
    _YT_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    outtmpl = str(_YT_AUDIO_DIR / f"{video_id}.%(ext)s")
    base_opts = _yt_quiet_opts(
        proxy=proxy,
        cookies_from_browser=cookies_from_browser,
        cookies_from_browser_profile=cookies_from_browser_profile,
    )
    opts = {
        **({k: v for k, v in base_opts.items() if k != "skip_download"}),
        # Best audio-only format (webm/m4a/whatever yt serves); fall back
        # to "best" if no audio-only is available (rare).
        "format": "bestaudio/best",
        # Post-process to m4a so the container is uniform for /transcribe
        # (faster-whisper accepts anything, but having a single extension
        # helps debugging).
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "m4a",
                "preferredquality": "128",  # 128kbps is plenty for ASR
            }
        ],
        "outtmpl": outtmpl,
        # Don't write the source video alongside.
        "keepvideo": False,
        "noprogress": True,
    }
    # cookies_text gets written to a temp file (via the shared helper
    # `_yt_open_inline_cookies`) so the same code path covers the
    # audio, subtitle, and info endpoints — all three need cookies
    # when the video is behind the "Sign in to confirm" wall.
    # cookies_from_browser (when set) already wired into opts via
    # `_yt_quiet_opts` above, so we skip the inline-cookies branch
    # entirely to avoid stomping on it.
    inline_cookies_path: Path | None = None
    try:
        if not cookies_from_browser:
            if cookies_file and cookies_text:
                # Both given — the explicit path is the user's deliberate
                # choice (manual export from a separate profile) and wins
                # over the inline text the extension built.
                cookies_text = None
            if cookies_file:
                opts["cookiefile"] = cookies_file
            elif cookies_text:
                inline_cookies_path = _yt_open_inline_cookies(cookies_text, basename=video_id)
                opts["cookiefile"] = str(inline_cookies_path)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        except yt_dlp.utils.DownloadError as exc:
            raise YtDlpError("unavailable", str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise YtDlpError("network", f"{type(exc).__name__}: {exc}") from exc
    finally:
        _yt_unlink_quietly(inline_cookies_path)

    # After post-processing the file extension is m4a. yt-dlp may leave
    # the original webm in place; prefer m4a, fall back to anything
    # matching videoId.*.
    expected = _YT_AUDIO_DIR / f"{video_id}.m4a"
    if expected.is_file():
        return {"path": str(expected), "ext": "m4a", "videoId": video_id}
    for entry in _YT_AUDIO_DIR.glob(f"{video_id}.*"):
        if entry.is_file():
            return {"path": str(entry), "ext": entry.suffix.lstrip("."), "videoId": video_id}
    raise YtDlpError("postprocess", "yt-dlp finished but no audio file was produced")


def _yt_download_subtitle(
    video_id: str,
    url: str,
    lang: str | None,
    proxy: str | None = None,
    cookies_file: str | None = None,
    cookies_text: str | None = None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Download the best caption track for `lang` and parse it into
    `{language, segments, source}` shaped like the transcribe endpoint
    output.

    Priority chain (per Irene's 2026-09-27 directive — YouTube official
    subs first, Whisper last):

      For each candidate language in
        requested → zh-Hans → zh-CN → zh → zh-Hant → en
      prefer MANUAL (`info["subtitles"]`) over AUTO
      (`info["automatic_captions"]`). Manual subtitles are
      uploader-supplied and far more accurate than the ASR-generated
      auto tracks. Both are still preferable to running Whisper
      locally, so the auto fallback only fires when no manual track
      exists for the chosen language.

    Lang matching (2026-09-28 fix): YouTube uses many BCP-47 variants
    (`zh-Hans`, `zh-Hant`, `zh-Hans-CN`, `zh-CN-orig`, `en-orig`,
    `en-US`, ...). Exact-string matching against our chain misses
    most of them. We normalise to lowercase + strip region prefix
    for matching: `zh` matches `zh-Hans` AND `zh-CN` AND `zh-Hant`,
    `en` matches `en-orig` AND `en-US`. The chosen lang is the
    EXACT key YouTube returns, so the downloaded file gets its real
    extension and yt-dlp's outtmpl hits.

    Why query info twice: yt-dlp's filename template doesn't expose an
    "auto vs manual" marker, so when both tracks exist for the same
    lang yt-dlp writes them with the same name and the second one
    silently overwrites the first. Querying `extract_info(download=
    False)` first lets us request only the track that wins, sidestep-
    ping the overwrite entirely. The 2nd call (`_yt_extract_info`)
    does NOT download anything; just the 2nd `YoutubeDL(opts).down-
    load()` does, and it's the same total byte cost as a single
    combined attempt.
    """
    _yt_check_available()
    _yt_sweep_stale()
    _YT_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1 — figure out what's actually available without downloading.
    # We need this BEFORE we know which lang/type to ask for, so the
    # subsequent yt-dlp download only writes the file we actually
    # want (avoids manual+auto filename collision).
    info = _yt_extract_info(
        url,
        proxy=proxy,
        cookies_file=cookies_file,
        cookies_text=cookies_text,
        cookies_from_browser=cookies_from_browser,
        cookies_from_browser_profile=cookies_from_browser_profile,
    )
    # yt-dlp populates `info["subtitles"][code]` as either a list of
    # format dicts (real track) OR sometimes `[]` (track listed but
    # no usable formats — happens for region-restricted captions when
    # the proxy isn't trusted). Filter to non-empty so we don't
    # bother yt-dlp with a request that has nothing to deliver.
    manual_langs = [
        k for k, v in (info.get("subtitles") or {}).items()
        if isinstance(v, list) and v
    ]
    auto_langs = [
        k for k, v in (info.get("automatic_captions") or {}).items()
        if isinstance(v, list) and v
    ]

    # Step 2 — build the language priority chain. Include the user's
    # explicit `lang` first, then Chinese variants (Simplified first,
    # then the ambiguous "zh-CN", then generic "zh", then Traditional
    # for completeness), then English.
    candidates: list[str] = []
    if lang:
        candidates.append(lang)
    for fallback in ("zh-Hans", "zh-CN", "zh", "zh-Hant", "en"):
        if fallback not in candidates:
            candidates.append(fallback)

    # Step 3 — for each chain candidate, find an EXACT key YouTube
    # actually returns that matches. Normalise to base lang (lowercase
    # + drop region) so `zh` matches `zh-Hans`, `zh-CN`, `zh-Hant`,
    # `zh-Hans-CN`, etc. Two-pass matching (exact before base) so
    # `zh-Hans` is preferred over `zh-CN` when both are available —
    # single-pass base matching would pick whatever comes first in
    # the dict.
    def _pick_match(available: list[str], code: str) -> str | None:
        # Pass 1 — exact match (most precise)
        for k in available:
            if k == code:
                return k
        # Pass 2 — base lang match (handles zh → zh-Hans / zh-CN / zh-Hant)
        code_base = code.lower().split("-")[0]
        for k in available:
            if k.lower().split("-")[0] == code_base:
                return k
        return None

    for attempt_code in candidates:
        manual_key = _pick_match(manual_langs, attempt_code)
        if manual_key is not None:
            return _yt_actually_download(
                video_id, url, proxy, manual_key, "yt-manual",
                cookies_file=cookies_file,
                cookies_text=cookies_text,
                cookies_from_browser=cookies_from_browser,
                cookies_from_browser_profile=cookies_from_browser_profile,
            )
        auto_key = _pick_match(auto_langs, attempt_code)
        if auto_key is not None:
            return _yt_actually_download(
                video_id, url, proxy, auto_key, "yt-auto",
                cookies_file=cookies_file,
                cookies_text=cookies_text,
                cookies_from_browser=cookies_from_browser,
                cookies_from_browser_profile=cookies_from_browser_profile,
            )
        # Neither manual nor auto has a match for this code — try
        # the next one in the chain.

    # Step 4 — long-tail fallback: nothing in our chain matched, but
    # the video has SOME caption. Take the first manual track if any,
    # else the first auto. This way a video uploaded only with Korean
    # captions still gets a transcript instead of falling through to
    # Whisper.
    if manual_langs:
        return _yt_actually_download(
            video_id, url, proxy, manual_langs[0], "yt-manual",
            cookies_file=cookies_file,
            cookies_text=cookies_text,
            cookies_from_browser=cookies_from_browser,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )
    if auto_langs:
        return _yt_actually_download(
            video_id, url, proxy, auto_langs[0], "yt-auto",
            cookies_file=cookies_file,
            cookies_text=cookies_text,
            cookies_from_browser=cookies_from_browser,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )

    raise YtDlpError("no_subtitle", "no caption track available")


def _yt_actually_download(
    video_id: str, url: str, proxy: str | None,
    lang_key: str, source: str,
    cookies_file: str | None = None,
    cookies_text: str | None = None,
    cookies_from_browser: str | None = None,
    cookies_from_browser_profile: str | None = None,
) -> dict:
    """Run the yt-dlp download for the chosen caption track + parse.
    Split out from `_yt_download_subtitle` so the matcher above stays
    readable. `cookies_file` / `cookies_text` (2026-09-28) are threaded
    from the subtitle endpoint for "Sign in to confirm" videos — see
    `_yt_download_audio` for the full priority + temp-file lifecycle
    explanation; we share the same `_yt_open_inline_cookies` /
    `_yt_unlink_quietly` helpers here.
    `cookies_from_browser` (2026-09-29) is the cleanest path: yt-dlp
    reads the user's real Chrome cookie DB at request time, so the
    cookies/IP/browser fingerprint combination matches what YouTube
    expects. See `_yt_quiet_opts` for the full priority order.
    """
    _YT_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    outtmpl = str(_YT_AUDIO_DIR / f"{video_id}.{lang_key}.%(ext)s")
    is_manual = source == "yt-manual"
    base_opts = _yt_quiet_opts(
        proxy=proxy,
        cookies_from_browser=cookies_from_browser,
        cookies_from_browser_profile=cookies_from_browser_profile,
    )
    opts = {
        **({k: v for k, v in base_opts.items() if k != "skip_download"}),
        "skip_download": True,
        "writesubtitles": is_manual,
        "writeautomaticsub": not is_manual,
        "subtitleslangs": [lang_key],
        "subtitlesformat": "vtt/srt/best",
        "outtmpl": outtmpl,
        "noprogress": True,
    }
    # cookies_from_browser takes precedence — it's already wired into
    # opts via _yt_quiet_opts above. Only fall back to cookiefile if
    # no browser was requested.
    inline_cookies_path: Path | None = None
    try:
        if not cookies_from_browser:
            if cookies_file and cookies_text:
                cookies_text = None
            if cookies_file:
                opts["cookiefile"] = cookies_file
            elif cookies_text:
                inline_cookies_path = _yt_open_inline_cookies(
                    cookies_text,
                    basename=f"{video_id}.{lang_key}",
                )
                opts["cookiefile"] = str(inline_cookies_path)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        except yt_dlp.utils.DownloadError as exc:
            raise YtDlpError("unavailable", str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise YtDlpError("network", f"{type(exc).__name__}: {exc}") from exc
    finally:
        _yt_unlink_quietly(inline_cookies_path)
    for ext in ("vtt", "srt"):
        for path in _YT_AUDIO_DIR.glob(f"{video_id}.{lang_key}.{ext}"):
            return {
                "language": lang_key,
                "segments": _parse_vtt(path) if ext == "vtt" else _parse_srt(path),
                "videoId": video_id,
                "ext": ext,
                "source": source,
            }
    raise YtDlpError("no_subtitle", f"yt-dlp ran but no {lang_key}.{{vtt,srt}} file produced")


def _yt_is_auto_caption(_url: str) -> tuple:
    """Removed in 2026-09-27 — we now distinguish manual vs auto by
    looking at `info["subtitles"]` vs `info["automatic_captions"]`
    BEFORE issuing the download (see _yt_download_subtitle above).
    Kept as a no-op for backward compatibility with any external
    callers; remove once audit confirms nothing imports it.
    """
    return ()


# VTT timestamp: HH:MM:SS.mmm  or  MM:SS.mmm
_VTT_TS_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(?P<end>\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})"
)


def _parse_vtt_ts(raw: str) -> float:
    """Parse 'HH:MM:SS.mmm' or 'MM:SS.mmm' into seconds (float)."""
    raw = raw.replace(",", ".")
    parts = raw.split(":")
    if len(parts) == 3:
        h, m, s = parts
    else:
        h, m, s = "0", parts[0], parts[1]
    return int(h) * 3600 + int(m) * 60 + float(s)


def _parse_vtt(path: Path) -> list[dict]:
    """Parse a WebVTT file into [{start, duration, text}] segments."""
    out: list[dict] = []
    raw = path.read_text(encoding="utf-8", errors="replace")
    # Cue blocks separated by blank line(s).
    blocks = re.split(r"\r?\n\r?\n", raw)
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip() and ln.strip() != "WEBVTT"]
        if not lines:
            continue
        m = _VTT_TS_RE.search(lines[0])
        if not m:
            continue
        start = _parse_vtt_ts(m.group("start"))
        end = _parse_vtt_ts(m.group("end"))
        # Remaining lines = caption text. Strip simple VTT tags like <c>.
        text_lines = []
        for ln in lines[1:]:
            cleaned = re.sub(r"<[^>]+>", "", ln).strip()
            if cleaned:
                text_lines.append(cleaned)
        if not text_lines:
            continue
        out.append(
            {
                "start": start,
                "duration": max(0.0, end - start),
                "text": " ".join(text_lines),
            }
        )
    return out


def _parse_srt(path: Path) -> list[dict]:
    """Parse a SubRip file into [{start, duration, text}] segments."""
    out: list[dict] = []
    raw = path.read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"\r?\n\r?\n", raw)
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        # First line is usually an index (1, 2, ...); the timestamp line
        # contains " --> ". Find whichever line has the arrow.
        ts_line = next((ln for ln in lines if "-->" in ln), None)
        if not ts_line:
            continue
        m = _VTT_TS_RE.search(ts_line)
        if not m:
            continue
        start = _parse_vtt_ts(m.group("start"))
        end = _parse_vtt_ts(m.group("end"))
        text_lines = [ln.strip() for ln in lines if ln != ts_line and not ln.strip().isdigit()]
        if not text_lines:
            continue
        out.append(
            {
                "start": start,
                "duration": max(0.0, end - start),
                "text": " ".join(text_lines),
            }
        )
    return out


# ---------------------------------------------------------------------------
# KB management endpoints (/kb/*), 2026-10-03 spec.
#
# The extension treats the FIRST-LEVEL SUBDIRECTORIES of a user-chosen root
# as knowledge bases. Every path-taking endpoint enforces a sandbox: after
# realpath() resolution the target must stay inside the given root, so `..`
# traversal and symlink escapes are rejected with 400.
# ---------------------------------------------------------------------------

def _kb_realpath_under_root(path: str, root: str) -> Path:
    """Resolve `path` and require it to live under `root`. Raise ValueError otherwise."""
    root_real = Path(root).resolve()
    target = Path(path).resolve()
    if target != root_real and root_real not in target.parents:
        raise ValueError(f"path escapes KB root: {path}")
    return target


def _kb_read_frontmatter(md_text: str) -> dict:
    """Parse a flat YAML frontmatter block (key: value) from a videos/*.md."""
    meta = {}
    if md_text.startswith("---"):
        for line in md_text.split("---")[1].strip().splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                meta[key.strip()] = value.strip().strip('"')
    return meta


# 2026-10-10: 与 kb-shared.js PROTECTED_KB_NAMES 镜像。whisper_server.py 是
# 文件系统的 source of truth —— 这里改完要把端口契约记在 commit message 里。
PROTECTED_KBS = {"notes"}


def _reject_if_protected(name: str, op: str) -> None:
    """Raise ValueError when `name` is in PROTECTED_KBS. `op` 用于错误提示。"""
    if name in PROTECTED_KBS:
        raise ValueError(f"KB '{name}' is protected and cannot be {op}")


def _kb_load_kbs(entry: Path) -> dict:
    """Build the /kb/list info dict for one first-level directory under root."""
    kb_json = entry / "kb.json"
    info = {
        "name": entry.name,
        "has_kb_json": kb_json.is_file(),
        "archived": False,
        "build_method": None,
        # 2026-10-10: protected flag drives UI to hide delete/rename/method
        # affordances for system-owned KBs (currently just "notes").
        "protected": entry.name in PROTECTED_KBS,
        "video_count": len(list((entry / "videos").glob("*.md"))) if (entry / "videos").is_dir() else 0,
        "pending_count": len(list((entry / "queue" / "pending").glob("*.json")))
        if (entry / "queue" / "pending").is_dir() else 0,
        "dir": str(entry),
    }
    if kb_json.is_file():
        try:
            cfg = json.loads(kb_json.read_text(encoding="utf-8"))
            info["archived"] = bool(cfg.get("archived"))
            info["build_method"] = cfg.get("build_method")
        except Exception:  # noqa: BLE001 - unreadable kb.json still lists the dir
            pass
    return info


class Handler(BaseHTTPRequestHandler):
    server_version = "bililearn-whisper/1.0"

    # Quieter logs -- only log requests, not every static asset.
    def log_message(self, fmt, *args):  # noqa: A003
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict | list):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        # PNA (Local Network Access): answer the actual request with the
        # private-network permission too, not just the preflight.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError(f"invalid JSON body: {exc}") from exc

    # ---------- GET ----------

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/kb/"):
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            if parsed.path == "/kb/list":
                try:
                    root = (qs.get("root") or [""])[0]
                    root_dir = Path(root)
                    items = [_kb_load_kbs(entry) for entry in sorted(root_dir.iterdir())
                             if entry.is_dir()] if root_dir.is_dir() else []
                    self._send_json(HTTPStatus.OK, items)
                except Exception as exc:  # noqa: BLE001
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            if parsed.path == "/kb/read":
                try:
                    path = _kb_realpath_under_root(qs["path"][0], qs["root"][0])
                    self._send_json(HTTPStatus.OK, {"content": path.read_text(encoding="utf-8")})
                except ValueError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                except OSError as exc:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
                except KeyError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"missing param: {exc}"})
                return
            if parsed.path == "/kb/videos":
                try:
                    kb_dir = _kb_realpath_under_root(str(Path(qs["root"][0]) / qs["kb"][0]), qs["root"][0])
                    vids_dir = kb_dir / "videos"
                    vids = []
                    if vids_dir.is_dir():
                        for md in sorted(vids_dir.glob("*.md")):
                            meta = _kb_read_frontmatter(md.read_text(encoding="utf-8"))
                            vids.append({"bvid": meta.get("bvid"), "page": meta.get("page"),
                                         "date": meta.get("date"), "topic": meta.get("topic"),
                                         "file": md.name})
                    self._send_json(HTTPStatus.OK, vids)
                except ValueError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                except KeyError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"missing param: {exc}"})
                except Exception as exc:  # noqa: BLE001
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            if parsed.path == "/kb/queue":
                try:
                    state = qs.get("state", ["pending"])[0]
                    if state not in ("pending", "done", "failed"):
                        raise ValueError(f"bad queue state: {state}")
                    kb_dir = _kb_realpath_under_root(str(Path(qs["root"][0]) / qs["kb"][0]), qs["root"][0])
                    qdir = kb_dir / "queue" / state
                    items = [{"file": p.name, "task": json.loads(p.read_text(encoding="utf-8"))}
                             for p in sorted(qdir.glob("*.json"))] if qdir.is_dir() else []
                    self._send_json(HTTPStatus.OK, items)
                except ValueError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                except KeyError as exc:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"missing param: {exc}"})
                except Exception as exc:  # noqa: BLE001
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": parsed.path})
            return
        if self.path == "/health":
            missing = _missing_deps()
            self._send_json(HTTPStatus.OK, {
                "ok": not missing,
                # Limited-mode details (ok:false): what is missing and which
                # python the server runs under, so the options page can show
                # an install command targeting exactly this interpreter.
                "reason": "missing_dependencies" if missing else None,
                "missing": missing,
                "install_hint": (
                    sys.executable + " -m pip install " + " ".join(missing + ["zhconv"])
                    if missing else None
                ),
                "python": {
                    "executable": sys.executable,
                    "version": sys.version.split()[0],
                },
                # Absolute path of this script — the options page derives the
                # full path of the sibling start_whisper_server.bat from it,
                # so its copy can point users at the exact file to double-click.
                "server_script": str(Path(__file__).resolve()),
                "deps": {
                    "faster_whisper": FW_VERSION,
                    "zhconv": ZHCONV_VERSION,
                    "yt_dlp": YTDLP_VERSION,
                },
                "version": FW_VERSION,
                "current_model": _CURRENT_MODEL_NAME,
                "device": _CURRENT_DEVICE,
                "compute_type": _CURRENT_COMPUTE,
                "available_models": AVAILABLE_MODELS,
                # 2026-11-05: 本地模型解析诊断。
                # server 可能是**旧代码**在跑（用户没重启），用户看到的
                # 500 就是"旧代码 + 空缓存 + 联网被墙"三件套。这里把
                # 解析结果直接暴露出来 —— 一眼就能看出跑的是不是新代码。
                "model_resolution": {
                    "hf_hub_cache": os.environ.get("HF_HUB_CACHE"),
                    "hf_home": os.environ.get("HF_HOME"),
                    "search_roots": [r for r in _MODEL_SEARCH_ROOTS if r],
                    "local_models": {
                        name: (str(_find_local_model_snapshot(name))
                               if _find_local_model_snapshot(name) else None)
                        for name in AVAILABLE_MODELS
                    },
                },
            })
            return
        if self.path == "/models":
            self._send_json(HTTPStatus.OK, {"models": AVAILABLE_MODELS})
            return
        if self.path.startswith("/cache?"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            bvid = (qs.get("bvid") or [""])[0]
            cid = (qs.get("cid") or [""])[0]
            cache_dir = (qs.get("cache_dir") or [None])[0]
            # Optional metadata for {date}_{title}_{UP}.json naming.
            video_title = (qs.get("title") or [None])[0] or None
            channel_name = (qs.get("channel") or [None])[0] or None
            pub_date = (qs.get("pub_date") or [None])[0] or None
            self._handle_cache_get(bvid, cid, cache_dir, video_title, channel_name, pub_date)
            return
        if self.path.startswith("/local-file?"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            filenames_str = (qs.get("filenames") or [""])[0]
            bvid = (qs.get("bvid") or [""])[0]
            cid = (qs.get("cid") or [""])[0]
            cache_dir = (qs.get("cache_dir") or [None])[0]
            self._handle_local_file_get(filenames_str, cache_dir, bvid, cid)
            return
        if self.path.startswith("/verify-path?"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            path_str = (qs.get("path") or [""])[0]
            self._handle_verify_path(path_str)
            return
        if self.path.startswith("/youtube/audio/"):
            # Streams the previously downloaded audio bytes back. The
            # download endpoint PUT the file under _YT_AUDIO_DIR/<id>.m4a;
            # we just open + chunk-transfer. Bound check is filename =
            # 11-char YouTube ID, no traversal possible.
            from urllib.parse import unquote
            video_id = unquote(self.path[len("/youtube/audio/"):]).strip("/")
            if not _YT_ID_RE.match(video_id):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid video id"})
                return
            self._handle_youtube_audio_stream(video_id)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": self.path})

    # ---------- POST ----------

    def do_POST(self):  # noqa: N802
        if self.path == "/kb/create":
            try:
                body = self._read_json()
                root = (body.get("root") or "").strip()
                name = (body.get("name") or "").strip()
                method = body.get("build_method") or "raw"
                speaker = (body.get("default_speaker") or "").strip()
                if not root or not name:
                    raise ValueError("root and name are required")
                if "/" in name or "\\" in name:
                    raise ValueError(f"bad KB name: {name}")
                # 2026-10-10: protected name → reserve for ensure_notes; refuse here.
                _reject_if_protected(name, "created manually")
                if method not in ("karpathy", "nvwa", "raw"):
                    raise ValueError(f"bad build_method: {method}")
                kb_dir = _kb_realpath_under_root(str(Path(root) / name), root)
                kb_dir.mkdir(parents=True, exist_ok=False)
                (kb_dir / "videos").mkdir()
                if method != "raw":
                    for sub in ("queue/pending", "queue/done", "queue/failed"):
                        (kb_dir / sub).mkdir(parents=True)
                    if method == "karpathy":
                        (kb_dir / "wiki" / "moc").mkdir(parents=True)
                        (kb_dir / "wiki" / "_meta").mkdir(parents=True)
                        (kb_dir / "wiki" / "index.md").write_text(
                            f"# {name} · 索引\n\n由 bililearn 创建，待首次增量更新。\n", encoding="utf-8")
                    else:
                        (kb_dir / "nvwa" / "案例集").mkdir(parents=True)
                        (kb_dir / "nvwa" / "_meta").mkdir(parents=True)
                from datetime import datetime
                (kb_dir / "kb.json").write_text(json.dumps({
                    "name": name, "build_method": method, "default_speaker": speaker,
                    "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "archived": False, "version": 1,
                }, ensure_ascii=False, indent=2), encoding="utf-8")
                (kb_dir / "README.md").write_text(
                    f"# {name}\n\nbililearn 知识库。构建方法：{method}。默认讲者：{speaker or '（未设置）'}。\n",
                    encoding="utf-8")
                self._send_json(HTTPStatus.OK, {"dir": str(kb_dir)})
            except FileExistsError:
                self._send_json(HTTPStatus.CONFLICT, {"error": "KB name already exists"})
            except (ValueError, KeyError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                LOG.exception("kb create failed")
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return
        if self.path == "/kb/write":
            try:
                body = self._read_json()
                path = _kb_realpath_under_root(body["path"], body["root"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body["content"], encoding="utf-8")
                self._send_json(HTTPStatus.OK, {"ok": True, "path": str(path)})
            except (ValueError, KeyError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/delete":
            try:
                body = self._read_json()
                path = _kb_realpath_under_root(body["path"], body["root"])
                # 2026-10-10: protected KB 的顶层目录不允许删，但 protected 内部的
                # 单文件（如过期笔记文件）应该能删——这是 notes mirror 必需的。
                # 判断标准: path 是 protected KB 一级子目录就拒，否则放行。
                root_real = Path(body["root"]).resolve()
                try:
                    rel = path.relative_to(root_real)
                    first_component = rel.parts[0] if rel.parts else ""
                except ValueError:
                    first_component = ""
                if first_component in PROTECTED_KBS and rel == Path(first_component):
                    raise ValueError(f"KB '{first_component}' is protected and cannot be deleted")
                if body.get("recursive"):
                    shutil.rmtree(path)
                else:
                    path.unlink()
                self._send_json(HTTPStatus.OK, {"ok": True})
            except (ValueError, KeyError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/move":
            try:
                body = self._read_json()
                src = _kb_realpath_under_root(body["from"], body["root"])
                dst = _kb_realpath_under_root(body["to"], body["root"])
                # 2026-10-10: protected KB 不能改名 / 挪走。比较 dst 第一层组件。
                root_real = Path(body["root"]).resolve()
                try:
                    dst_first = Path(dst).relative_to(root_real).parts[0] if dst != root_real else ""
                except ValueError:
                    dst_first = ""
                _reject_if_protected(dst_first, "renamed/moved into")
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                self._send_json(HTTPStatus.OK, {"ok": True})
            except (ValueError, KeyError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if self.path == "/kb/pick_root" or self.path.startswith("/kb/pick_root?"):
            # Native Windows folder picker (same FolderBrowserDialog as
            # /pick-dir). `?probe=1` short-circuits WITHOUT popping any
            # dialog so headless tests can verify the contract shape.
            # Cancel / failure -> {"path": null}; the extension then falls
            # back to a manual text input.
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length > 0:
                    _ = self.rfile.read(length)
            except (ValueError, OSError):
                pass
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            if qs.get("probe"):
                self._send_json(HTTPStatus.OK, {"path": None, "probe": True})
                return
            initial = self.headers.get("X-Initial-Dir") or ""
            title = self.headers.get("X-Dialog-Title") or "选择 KB 主目录"
            initial_ps = initial.replace("'", "''")
            title_ps = title.replace("'", "''")
            script = (
                "Add-Type -AssemblyName System.Windows.Forms | Out-Null;"
                "$owner = New-Object System.Windows.Forms.Form;"
                "$owner.TopMost = $true;"
                "$owner.Visible = $false;"
                "Add-Type -AssemblyName System.Drawing | Out-Null;"
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
                f"$f.Description = '{title_ps}';"
                f"if ('{initial_ps}' -ne '') {{ try {{ $f.SelectedPath = '{initial_ps}' }} catch {{ }} }};"
                "$r = $f.ShowDialog($owner);"
                "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"
            )
            try:
                completed = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", script],
                    capture_output=True, text=True, timeout=120,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except Exception:  # noqa: BLE001 - any picker failure is a soft null
                self._send_json(HTTPStatus.OK, {"path": None})
                return
            picked = completed.stdout.strip()
            self._send_json(HTTPStatus.OK, {"path": (picked.replace("\\", "/") or None) if picked else None})
            return
        if self.path == "/kb/ensure_notes":
            # 2026-10-10: bootstrap the system-owned "notes" KB on demand from
            # background / options.js. Idempotent — if it already exists under
            # `root`, just return the existing dir.  build_method fixed at
            # karpathy (per user spec). The .md files under videos/ are written
            # by background.js saveNote / saveAskAiNote hooks; this endpoint
            # only creates the skeleton.
            try:
                body = self._read_json()
                root = (body.get("root") or "").strip()
                if not root:
                    raise ValueError("root is required")
                root_dir = Path(root)
                if not root_dir.is_dir():
                    raise ValueError(f"root does not exist: {root}")
                kb_dir = root_dir / "notes"
                existed = kb_dir.is_dir()
                if not existed:
                    kb_dir.mkdir()
                    (kb_dir / "videos").mkdir()
                    for sub in ("queue/pending", "queue/done", "queue/failed"):
                        (kb_dir / sub).mkdir(parents=True)
                    (kb_dir / "wiki" / "moc").mkdir(parents=True)
                    (kb_dir / "wiki" / "_meta").mkdir(parents=True)
                    (kb_dir / "wiki" / "index.md").write_text(
                        "# notes · 索引\n\n由 bililearn 自动创建；本地笔记 KB。\n",
                        encoding="utf-8",
                    )
                    from datetime import datetime
                    (kb_dir / "kb.json").write_text(json.dumps({
                        "name": "notes",
                        "build_method": "karpathy",
                        "default_speaker": "",
                        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                        "archived": False,
                        "version": 1,
                        "protected": True,
                    }, ensure_ascii=False, indent=2), encoding="utf-8")
                    (kb_dir / "README.md").write_text(
                        "# notes\n\nbililearn 本地笔记 KB。用户保存到「笔记」tab 的内容会被 mirror 到这里，作为 Ask AI 的 KB 上下文候选。构建方法：karpathy（LLM 增量更新）。\n",
                        encoding="utf-8",
                    )
                self._send_json(HTTPStatus.OK, {"dir": str(kb_dir), "existed": existed})
            except (ValueError, KeyError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                LOG.exception("kb ensure_notes failed")
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return
        if self.path == "/cache":
            try:
                body = self._read_json()
                self._handle_cache_write(body)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                LOG.exception("cache write failed")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"{type(exc).__name__}: {exc}"},
                )
            return
        if self.path == "/pick-dir":
            try:
                self._handle_pick_dir()
            except Exception as exc:  # noqa: BLE001
                LOG.exception("pick-dir failed")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": f"{type(exc).__name__}: {exc}"},
                )
            return
        if self.path in ("/youtube/info", "/youtube/audio", "/youtube/subtitle"):
            try:
                body = self._read_json()
                if self.path == "/youtube/info":
                    self._handle_youtube_info(body)
                elif self.path == "/youtube/audio":
                    self._handle_youtube_audio(body)
                else:
                    self._handle_youtube_subtitle(body)
            except YtDlpError as exc:
                # Stable error envelope: extension categorises by exc.code
                status = HTTPStatus.SERVICE_UNAVAILABLE if exc.code == "not_available" else HTTPStatus.BAD_GATEWAY
                self._send_json(status, {
                    "ok": False,
                    "error_type": exc.code,
                    "error": exc.message,
                })
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                LOG.exception("youtube %s failed", self.path)
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"ok": False, "error_type": "internal",
                     "error": f"{type(exc).__name__}: {exc}"},
                )
            return
        if self.path != "/transcribe":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": self.path})
            return
        # Limited mode: no silent installs — tell the caller exactly what is
        # missing and how to install it, with an actionable status code.
        if FW_VERSION is None:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": (
                        "faster-whisper is not installed in this Python "
                        f"({sys.executable}). Install it with: "
                        f'"{sys.executable}" -m pip install faster-whisper zhconv'
                    ),
                    "missing": _missing_deps(),
                    "python": sys.executable,
                },
            )
            return
        try:
            content_type = (self.headers.get("Content-Type") or "").lower()
            if content_type.startswith("audio/") or content_type == "application/octet-stream":
                # Raw audio bytes mode: the extension downloads the audio and
                # POSTs it directly so we don't have to share filesystem paths.
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length <= 0:
                    raise ValueError("Content-Length required for raw audio mode")
                if length > 500 * 1024 * 1024:
                    raise ValueError(f"audio too large: {length} bytes (max 500MB)")
                model_name = self.headers.get("X-Whisper-Model") or DEFAULT_MODEL
                language = self.headers.get("X-Whisper-Language") or None
                beam_size = int(self.headers.get("X-Whisper-Beam-Size") or "5")
                audio_bytes = self.rfile.read(length)
                audio_key = hashlib.sha256(audio_bytes).hexdigest()
                # Optional metadata headers (all URL-encoded by the client
                # so CJK values survive the latin-1 header transport).
                # When present, the SERVER writes the transcript to its own
                # subtitle cache the moment inference finishes — so even if
                # the extension's service worker is evicted mid-POST (page
                # switch, extension reload), the finished result is on disk
                # and the client-side watchdog can recover it via /cache.
                from urllib.parse import unquote as _unquote_header
                cache_meta = {
                    "bvid": _unquote_header(self.headers.get("X-Bvid") or ""),
                    "cid": _unquote_header(self.headers.get("X-Cid") or ""),
                    "title": _unquote_header(self.headers.get("X-Title") or ""),
                    "channel": _unquote_header(self.headers.get("X-Channel") or ""),
                    "pub_date": _unquote_header(self.headers.get("X-Pubdate") or ""),
                    "cache_dir": _unquote_header(self.headers.get("X-Cache-Dir") or ""),
                }

                def _run_and_cache():
                    payload = self._transcribe_bytes(
                        audio_bytes, model_name, language, beam_size,
                        content_type.split(";", 1)[0].strip(),
                    )
                    if cache_meta["bvid"] and cache_meta["cid"]:
                        try:
                            cache_path = self._write_server_side_cache(payload, cache_meta)
                            payload["cache_path"] = str(cache_path)
                        except Exception as cache_exc:  # noqa: BLE001
                            # Cache write failure must never fail the
                            # transcription itself.
                            LOG.warning("server-side cache write failed: %s", cache_exc)
                    return payload

                self._transcribe_dedup(audio_key, _run_and_cache)
                return

            # JSON mode: caller passes a path to an audio file under an
            # allowed temp directory.
            body = self._read_json()
            audio_path = body.get("audio_path")
            if not audio_path:
                raise ValueError("audio_path is required for JSON mode")
            model_name = body.get("model") or DEFAULT_MODEL
            if model_name not in AVAILABLE_MODELS:
                raise ValueError(
                    f"unknown model '{model_name}'. Allowed: {AVAILABLE_MODELS}"
                )
            language = body.get("language")
            beam_size = int(body.get("beam_size", 5))
            vad_filter = bool(body.get("vad_filter", True))

            path = _validate_audio_path(audio_path)
            audio_key = hashlib.sha256(Path(path).read_bytes()).hexdigest()
            self._transcribe_dedup(
                audio_key,
                lambda: self._transcribe_path(path, model_name, language, beam_size, vad_filter),
            )
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            LOG.exception("transcribe failed")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": f"{type(exc).__name__}: {exc}"},
            )

    def _transcribe_dedup(self, audio_key, run):
        """Serialize identical transcriptions. `run` must RETURN the payload
        dict (not send it) so both the owner's response and the waiters'
        reused responses come from one source of truth."""
        owner, job = _transcribe_claim(audio_key)
        if not owner:
            LOG.info("transcribe dedup: waiting on in-flight job %s", audio_key[:12])
            if not job["event"].wait(timeout=3600):
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "duplicate transcription wait timed out", "reused": True},
                )
                return
            if job["error"] is not None:
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": job["error"], "reused": True},
                )
                return
            payload = dict(job["result"] or {})
            payload["reused"] = True
            LOG.info("transcribe dedup: reusing result for %s", audio_key[:12])
            self._send_json(HTTPStatus.OK, payload)
            return
        try:
            payload = run()
        except Exception as exc:  # noqa: BLE001
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["event"].set()
            raise
        job["result"] = payload
        job["event"].set()
        self._send_json(HTTPStatus.OK, payload)

    def _transcribe_bytes(self, audio_bytes, model_name, language, beam_size, content_type):
        if model_name not in AVAILABLE_MODELS:
            raise ValueError(
                f"unknown model '{model_name}'. Allowed: {AVAILABLE_MODELS}"
            )
        # Persist to a temp file so faster-whisper can stream-decode it.
        # faster-whisper probes the actual format from the bytes; the suffix
        # is only a hint.
        suffix = ".m4a" if "m4a" in content_type or "mp4" in content_type else ".bin"
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name
        try:
            return self._transcribe_path(tmp_path, model_name, language, beam_size, True)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _transcribe_path(self, path, model_name, language, beam_size, vad_filter):
        LOG.info("transcribe start: file=%s model=%s lang=%s", os.path.basename(str(path)), model_name, language)
        t0 = time.time()
        model = _get_model(model_name)
        segments_iter, info = model.transcribe(
            str(path),
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
        )
        segments = list(segments_iter)
        payload = _serialize_segments(segments, info)
        LOG.info(
            "transcribe done: %d segments, %.1fs audio, %.1fs wall",
            len(segments),
            info.duration,
            time.time() - t0,
        )
        return payload

    def _write_server_side_cache(self, payload, meta):
        """Persist a finished transcription to the subtitle cache.

        Called in the /transcribe raw-audio owner path when the client
        supplied X-Bvid/X-Cid (+ optional friendly-name metadata). The
        file shape mirrors what the extension's own saveCachedTranscript
        writes — {bvid, cid, source, language, savedAt, transcript:
        [{from, to, content}]} — so every read path (/cache GET,
        /local-file bvid-grep) treats it identically. The extension
        later overwrites this with the AI-corrected transcript when the
        correction step completes; until then this raw version already
        renders fine.

        Transcribed text is converted from Traditional to Simplified
        Chinese before write (whisper-tiny/base bias toward Traditional
        on Mandarin input — see issue 2026-08-23). Conversion runs only
        on the segment text; metadata fields (title, channel, pub_date)
        and the doc structure are untouched. Done at the server so
        every downstream consumer (watchdog recovery, client in-memory
        cache, /cache GET, /local-file bvid-grep, future export) sees
        the same simplified form. If `zhconv` is not installed we
        log a warning and write the original text — transcription
        must never fail because of a missing t2s dependency.
        """
        import datetime
        import json as _json
        segments = payload.get("segments") or []
        t2s = _get_t2s_converter()
        transcript = [
            {
                "from": float(seg.get("start") or 0),
                "to": float(seg.get("end") or 0),
                "content": t2s(str(seg.get("text") or "").strip()),
            }
            for seg in segments
            if str(seg.get("text") or "").strip()
        ]
        if not transcript:
            raise ValueError("no text segments to cache")
        cache_path = self._resolve_cache_path(
            meta["bvid"],
            meta["cid"],
            cache_dir=meta.get("cache_dir") or None,
            video_title=meta.get("title") or None,
            channel_name=meta.get("channel") or None,
            pub_date=meta.get("pub_date") or None,
        )
        doc = {
            "bvid": meta["bvid"],
            "cid": meta["cid"],
            "source": "local-whisper",
            "language": payload.get("language"),
            "savedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "transcript": transcript,
        }
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(_json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        # 2026-11-05: 写完要让目录清单 / 文件头缓存失效 —— 否则下一次
        # 查询还会用旧清单（30s TTL 内看不到刚写的文件）。
        invalidate_cache_index(str(cache_path.parent))
        LOG.info(
            "server-side cache write: %s (%d segments)",
            cache_path.name,
            len(transcript),
        )
        return cache_path

    # ---------- subtitle cache ----------

    def _resolve_cache_path(self, bvid, cid, cache_dir=None, video_title=None, channel_name=None, pub_date=None):
        from urllib.parse import unquote
        if not bvid or not cid:
            raise ValueError("bvid and cid are required")
        # Mirror the JS-side normaliser in settings.js: keep alnum only,
        # drop everything else (including path separators and ..).
        safe_bvid = re.sub(r"[^A-Za-z0-9]", "", unquote(bvid))
        safe_cid = re.sub(r"[^0-9]", "", unquote(cid))
        if not safe_bvid or not safe_cid:
            raise ValueError(f"invalid bvid/cid: {bvid!r}/{cid!r}")
        if cache_dir:
            candidate = Path(unquote(cache_dir))
            candidate_str = str(candidate.resolve())
            # Reject obvious traversal attempts.
            if ".." in candidate.parts:
                raise ValueError("cache_dir must not contain '..'")
            if not candidate_str or candidate_str == os.path.sep:
                raise ValueError("cache_dir is not absolute")
            target = candidate
        else:
            # No override: use the first allowed dir that ends with
            # "subtitles", or fall back to the first allowed dir.
            target = None
            for allowed in ALLOWED_AUDIO_DIRS:
                if str(allowed).lower().endswith("subtitles"):
                    target = allowed
                    break
            if target is None:
                target = ALLOWED_AUDIO_DIRS[0]
        target.mkdir(parents=True, exist_ok=True)
        # Prefer the same {date}_{title}_{UP}.json convention that
        # loadLocalSubtitleFile uses, so the bililearn-written cache
        # appears in the same human-friendly namespace as .md/.txt
        # exports. Falls back to the legacy bvid_cid.json name if any
        # of the metadata fields is missing.
        filename = self._subtitle_cache_filename(
            safe_bvid, safe_cid, video_title, channel_name, pub_date, "json",
        )
        return target / filename

    @staticmethod
    def _subtitle_cache_filename(safe_bvid, safe_cid, video_title, channel_name, pub_date, ext):
        """Mirror of `subtitleCacheFilename` in settings.js. Stays in
        lockstep so the read + write paths agree on the same filename
        for any given video — the bililearn cache is otherwise invisible
        to `loadLocalSubtitleFile`, which only matches human-friendly
        names.
        """
        if pub_date and video_title and channel_name:
            # Match the JS-side cleaner: drop Windows-forbidden filename
            # chars, trim, and clamp to settings.js' substring limits
            # (100 for title, 50 for channel).
            clean_title = re.sub(r'[<>:"/\\|?*]', "_", str(video_title)).strip()[:100]
            clean_channel = re.sub(r'[<>:"/\\|?*]', "_", str(channel_name)).strip()[:50]
            if clean_title and clean_channel:
                return f"{pub_date}_{clean_title}_{clean_channel}.{ext}"
        # Legacy / metadata-less fallback.
        if not safe_bvid or not safe_cid:
            return None
        return f"{safe_bvid}_{safe_cid}.{ext}"

    def _handle_cache_get(self, bvid, cid, cache_dir=None, video_title=None, channel_name=None, pub_date=None):
        try:
            resolved = self._resolve_cache_path(bvid, cid, cache_dir, video_title, channel_name, pub_date)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        # CID is the authoritative key (2026-08-22): a title-resolved hit
        # only counts when the doc pins the requested bvid+cid — titles are
        # NOT unique (multi-part videos share date+title+UP; the JS and
        # Python filename cleaners can drift on exotic characters), so a
        # title collision must not serve another part's payload. When ids
        # are pinned, a miss falls back to a directory scan by ids.
        path = None
        if resolved.is_file():
            if not (bvid and cid) or self._json_head_pins(resolved, bvid, cid):
                path = resolved
        if path is None and bvid and cid:
            path = self._scan_json_for_ids(bvid, cid, resolved.parent)
        if path is None:
            self._send_json(HTTPStatus.NOT_FOUND, {
                "ok": False,
                "cache_path": str(resolved),
                "reason": "not found",
            })
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, ValueError) as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "ok": False,
                "cache_path": str(path),
                "error": f"{type(exc).__name__}: {exc}",
            })
            return
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "cache_path": str(path),
            "payload": payload,
        })

    def _scan_json_for_ids(self, bvid, cid, root_dir):
        """Find a .json subtitle doc under root_dir pinning BOTH bvid+cid.

        Reads only file heads (bililearn docs start with bvid/cid), so
        scanning even a few hundred cache files stays cheap. Returns the
        winning Path or None.

        2026-11-05: 复用 _cache_index 的目录清单（带 TTL）+ _read_head_cached
        的文件头缓存 —— 以前这里是第二次 os.walk + 逐文件现读。
        """
        if not bvid or cid is None:
            return None
        try:
            _by_name, entries = _cache_index(Path(root_dir))
            for file_path, lower, kind in entries:
                if kind != "json":
                    continue
                if self._json_head_pins(file_path, bvid, cid):
                    return file_path
        except OSError:
            return None
        return None

    def _handle_local_file_get(self, filenames_str=None, cache_dir=None, bvid=None, cid=None):
        """Look for local subtitle files by name pattern (recursive).

        If `bvid` is supplied, scans every .txt/.md under cache_dir and
        matches files whose first non-empty line is a `# Source: <bvid>`
        header — that's how up-master-report labels its outputs. This
        lets bililearn find subtitles even when the filename pattern
        (YYYY-MM-DD_Title_UP) doesn't match (different date format, no
        UP name, different folder layout, etc.).

        If `cid` is ALSO supplied (preferred since 2026-08-22), every
        .json candidate must pin BOTH bvid and cid in its doc — titles
        and bvids are shared across the parts of a multi-part video, so
        cid is the only key that identifies the exact part. Text exports
        (.md/.txt/.srt/.lrc, usually written by external pipelines) have
        no cid embedded, so they keep the bvid-header behavior.
        """
        if not cache_dir:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "cache_dir required"})
            return

        cache_path = Path(cache_dir)
        if not cache_path.is_dir():
            self._send_json(HTTPStatus.NOT_FOUND, {
                "ok": False,
                "reason": "cache directory not found",
            })
            return

        # 2026-11-05：目录清单带 30s TTL 缓存；两个 pass 共用一次扫描
        # （以前各扫一遍，实测单次 3.1s）
        by_name, all_entries = _cache_index(cache_path)

        # --- Pass 1: filename match (original behavior) ---
        # When `cid` is pinned, a .json hit must ALSO pin the same cid in
        # its doc — filenames are title-based and the parts of a
        # multi-part video share date+title+UP; only cid tells them apart.
        if filenames_str:
            target_filenames = {f.strip().lower() for f in filenames_str.split(",") if f.strip()}
            # 按文件名索引直接查，不用遍历全量清单
            seen_paths = set()
            for lower_name in target_filenames:
                for candidate in by_name.get(lower_name, []):
                    if candidate in seen_paths:
                        continue
                    seen_paths.add(candidate)
                    if cid and lower_name.endswith(".json") and not self._json_head_pins(candidate, bvid, cid):
                        # 2026-10-03: same whole-video exception as Pass 2 —
                        # bvid-only backups with no cid field may pass.
                        if not self._json_pins_bvid_no_cid(candidate, bvid):
                            continue
                    result = self._read_subtitle_file(candidate)
                    if result is not None:
                        self._send_json(HTTPStatus.OK, {"ok": True, "payload": result})
                        return

        # --- Pass 2: bvid grep (header match) ---
        if bvid:
            target_bvid = bvid.strip()
            if target_bvid:
                # Format-aware patterns: txt/md/srt/lrc write `# Source: <bvid>`
                # at the top (up-master-report), JSON caches write
                # `"bvid": "<bvid>"`. Both are precise header-level matches, so
                # we don't fall back to a generic substring search — a 12-char
                # BV id is rare enough but a substring match would be more
                # brittle and could match random 靳卫萍 speech that happens
                # to contain a BV-looking sequence.
                text_pattern = re.compile(
                    r"^#\s*source\s*[:=]\s*(" + re.escape(target_bvid) + r")\s*$",
                    re.IGNORECASE | re.MULTILINE,
                )
                # 2026-10-03: the 靳卫萍-KB / bilibili-transcribe pipelines
                # label their exports with two OTHER header shapes —
                #   1) YAML front matter:      `bvid: BVxxxxxxxxxx` (own line)
                #   2) bold metadata line:     `**BV 号**: BVxxxxxxxxxx`
                # Both are line-anchored matches inside the header block
                # (first 2KB), so they can't false-positive on transcript
                # body text.
                text_pattern_yaml = re.compile(
                    r"^bvid\s*[:=]\s*" + re.escape(target_bvid) + r"\s*$",
                    re.MULTILINE,
                )
                text_pattern_bvline = re.compile(
                    r"^\*{0,2}BV\s*号\*{0,2}\s*[:：]\s*" + re.escape(target_bvid) + r"\s*$",
                    re.MULTILINE,
                )
                text_patterns = (text_pattern, text_pattern_yaml, text_pattern_bvline)
                json_pattern = re.compile(
                    r'"bvid"\s*:\s*"' + re.escape(target_bvid) + r'"',
                )
                # Only consider text-ish files; skip the .m4a/.obsolete cruft
                # up-master-report drops alongside the real subtitles. .json
                # caches (saved by the Whisper trigger flow) live here too.
                # 2026-11-05：复用 all_entries（不再第二次 os.walk）
                for file_path, lower, kind in all_entries:
                        is_json = kind == "json"
                        if is_json and cid:
                            # CID pinned: require the doc to pin BOTH bvid
                            # and cid (part-exact). No bvid-only fallback —
                            # a sibling part's cached subtitles would be
                            # silently the wrong content; a miss lets
                            # the panel offer a fresh transcription.
                            # 2026-10-03 exception: external whisper-backup
                            # pipelines (靳卫萍 KB etc.) write
                            # {bvid, title, date, transcript} with NO cid —
                            # those backups cover the WHOLE video, so a
                            # bvid-only match is safe for any part. A doc
                            # that HAS a different cid still fails.
                            if not self._json_head_pins(file_path, bvid, cid):
                                if not self._json_pins_bvid_no_cid(file_path, target_bvid):
                                    continue
                        else:
                            # Read the first ~2KB only — headers live at the top.
                            # A full read of every .txt would be slow on
                            # directories that also hold gigabytes of m4a.
                            # 2026-11-05: 带 mtime 缓存 —— 900 多个文件的
                            # 头只读一次，之后都走内存。
                            head = _read_head_cached(file_path)
                            if head is None:
                                continue
                            if is_json:
                                if not json_pattern.search(head):
                                    continue
                            elif not any(p.search(head) for p in text_patterns):
                                continue
                        # Confirmed — re-read the whole file for the actual content.
                        result = self._read_subtitle_file(file_path)
                        if result is not None:
                            self._send_json(HTTPStatus.OK, {"ok": True, "payload": result})
                            return

        # None found
        self._send_json(HTTPStatus.NOT_FOUND, {
            "ok": False,
            "reason": "no matching file found",
        })

    @staticmethod
    def _json_head_pins(file_path, bvid, cid):
        """True if the JSON subtitle doc at file_path pins BOTH `bvid` and `cid`.

        Reads only the head of the file — bililearn-written docs always
        start with {"bvid": ..., "cid": ...}. The cid comparison is
        string-based because the extension writes cid as a JSON number
        while this server writes it as a string. A doc that lacks either
        field counts as NOT pinned (callers use this for exact-part
        matching, so "unknown" must not pass).

        2026-11-05: 用 _read_head_cached（mtime 缓存）而不是每次现读。
        """
        head = _read_head_cached(file_path)
        if head is None:
            return False
        m_bvid = re.search(r'"bvid"\s*:\s*"([^"]+)"', head)
        if not m_bvid:
            return False
        if bvid and m_bvid.group(1) != bvid:
            return False
        m_cid = re.search(r'"cid"\s*:\s*"?(\d+)"?', head)
        if not m_cid:
            return False
        want_cid = re.sub(r"\D", "", str(cid or ""))
        return bool(want_cid) and m_cid.group(1) == want_cid

    @staticmethod
    def _json_pins_bvid_no_cid(file_path, bvid):
        """True if the JSON doc pins `bvid` and carries NO cid field.

        2026-10-03: external whisper-backup pipelines (靳卫萍 KB /
        bilibili-transcribe) write {bvid, title, date, transcript} without
        a cid. Those backups cover the WHOLE video, so a bvid-only match is
        safe for any part. Distinct from _json_head_pins semantics, where a
        PRESENT-but-different cid is a genuine multi-part mismatch and must
        keep failing.

        2026-11-05: 用 _read_head_cached（mtime 缓存）。
        """
        head = _read_head_cached(file_path)
        if head is None:
            return False
        m_bvid = re.search(r'"bvid"\s*:\s*"([^"]+)"', head)
        if not m_bvid or m_bvid.group(1) != bvid:
            return False
        return re.search(r'"cid"\s*:', head) is None

    def _read_subtitle_file(self, file_path):
        """Read a subtitle file and return (content, filename, path) tuple.

        Returns None if the file is empty or unreadable.
        """
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as exc:
            LOG.exception(f"Failed to read {file_path}")
            return None
        if not content or not content.strip():
            return None
        return {
            "content": content,
            "filename": file_path.name,
            "path": str(file_path),
        }

    def _handle_verify_path(self, path_str):
        """Verify a directory path exists and is writable."""
        if not path_str:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "path is required"})
            return

        try:
            p = Path(path_str).resolve()
        except (OSError, ValueError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {
                "ok": False,
                "error": f"invalid path: {exc}",
            })
            return

        if not p.exists():
            self._send_json(HTTPStatus.OK, {
                "ok": False,
                "exists": False,
                "reason": "directory does not exist",
                "path": str(p),
            })
            return

        if not p.is_dir():
            self._send_json(HTTPStatus.OK, {
                "ok": False,
                "exists": True,
                "is_dir": False,
                "reason": "path is not a directory",
                "path": str(p),
            })
            return

        # Test write permission by creating a temp file
        try:
            test_file = p / f".bililearn_write_test_{int(time.time())}.tmp"
            test_file.touch()
            test_file.unlink()
        except OSError as exc:
            self._send_json(HTTPStatus.OK, {
                "ok": False,
                "exists": True,
                "is_dir": True,
                "writable": False,
                "error": f"permission denied: {exc}",
                "path": str(p),
            })
            return

        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "exists": True,
            "is_dir": True,
            "writable": True,
            "path": str(p),
        })

    def _handle_cache_write(self, body):
        bvid = (body or {}).get("bvid")
        cid = (body or {}).get("cid")
        payload = (body or {}).get("payload")
        cache_dir = (body or {}).get("cache_dir")
        # Optional metadata for {date}_{title}_{UP}.json naming. Stays
        # in lockstep with `_handle_cache_get` so the read path can
        # always find what the write path produced.
        video_title = (body or {}).get("title")
        channel_name = (body or {}).get("channel")
        pub_date = (body or {}).get("pub_date")
        if payload is None:
            raise ValueError("payload is required")
        try:
            path = self._resolve_cache_path(
                bvid, cid, cache_dir, video_title, channel_name, pub_date,
            )
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: tmp + rename, so a crash mid-write doesn't leave a
        # half-written file the side panel will treat as authoritative.
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        LOG.info("cache write: %s (%d bytes)", path, path.stat().st_size)
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "cache_path": str(path),
            "bytes": path.stat().st_size,
        })

    def _handle_pick_dir(self):
        # Pop the native Windows folder picker via PowerShell +
        # System.Windows.Forms.FolderBrowserDialog. Returns either
        # {"path": "C:/..."} or {"cancelled": true}.
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length > 0:
                _ = self.rfile.read(length)  # ignore body, picker is self-describing
        except (ValueError, OSError):
            pass
        initial = self.headers.get("X-Initial-Dir") or ""
        title = self.headers.get("X-Dialog-Title") or "Select a folder"
        # Escape single quotes for PowerShell single-quoted strings.
        initial_ps = initial.replace("'", "''")
        title_ps = title.replace("'", "''")
        script = (
            "Add-Type -AssemblyName System.Windows.Forms | Out-Null;"
            "$owner = New-Object System.Windows.Forms.Form;"
            "$owner.TopMost = $true;"
            "$owner.Visible = $false;"
            "Add-Type -AssemblyName System.Drawing | Out-Null;"
            "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
            f"$f.Description = '{title_ps}';"
            f"if ('{initial_ps}' -ne '') {{ try {{ $f.SelectedPath = '{initial_ps}' }} catch {{ }} }};"
            "$r = $f.ShowDialog($owner);"
            "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"
        )
        try:
            completed = subprocess.run(
                ["powershell", "-NoProfile", "-Command", script],
                capture_output=True, text=True, timeout=120,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "error": f"picker unavailable: {type(exc).__name__}: {exc}",
            })
            return
        if completed.returncode != 0 and not completed.stdout.strip():
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "error": (completed.stderr or "PowerShell picker failed").strip()[:300],
            })
            return
        picked = completed.stdout.strip()
        if not picked:
            self._send_json(HTTPStatus.OK, {"ok": True, "cancelled": True})
            return
        # Normalise to forward slashes for cross-platform consistency.
        picked = picked.replace("\\", "/")
        self._send_json(HTTPStatus.OK, {"ok": True, "path": picked})

    # ---------- YouTube endpoints (2026-09-27) ----------

    def _handle_youtube_info(self, body: dict):
        """POST /youtube/info
        body: {url, proxy?, cookiesFile?, cookiesText?,
               cookiesFromBrowser?, cookiesFromBrowserProfile?}
        Returns: {ok, videoId, title, channel, channelId, uploadDate,
                  duration, thumbnail, description,
                  availableSubtitleLangs, webpageUrl}
        Cookies are required (2026-09-28) when the URL is a
        "Sign in to confirm" video — without them yt-dlp's extract_info
        raises before we ever get a `subtitles` dict back.
        `cookiesFromBrowser` (2026-09-29) is the cleanest path:
        yt-dlp reads cookies directly from the named browser's
        SQLite DB at runtime.
        """
        url = (body.get("url") or "").strip()
        if not url:
            raise ValueError("missing url")
        proxy = (body.get("proxy") or "").strip() or None
        cookies_file = (body.get("cookiesFile") or "").strip() or None
        cookies_text = (body.get("cookiesText") or "").strip() or None
        cookies_from_browser = (
            (body.get("cookiesFromBrowser") or "").strip() or None
        )
        cookies_from_browser_profile = (
            (body.get("cookiesFromBrowserProfile") or "").strip() or None
        )
        if cookies_text and len(cookies_text) > 64 * 1024:
            raise YtDlpError("invalid_input", "cookiesText exceeds 64 KB cap")
        info = _yt_extract_info(
            url,
            proxy=proxy,
            cookies_file=cookies_file,
            cookies_text=cookies_text,
            cookies_from_browser=cookies_from_browser,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )
        payload = _yt_format_metadata(info)
        self._send_json(HTTPStatus.OK, {"ok": True, **payload})

    def _handle_youtube_audio(self, body: dict):
        """POST /youtube/audio
        body: {videoId, url, proxy?, cookiesFile?, cookiesText?,
               cookiesFromBrowser?, cookiesFromBrowserProfile?}
        Returns: {ok, videoId, ext, audioUrl}
        audioUrl is the relative path the extension GETs to stream
        the bytes back (GET /youtube/audio/<videoId>).

        Cookie auth has three paths (priority order, 2026-09-29):
          1. `cookiesFromBrowser` (e.g. "chrome") — yt-dlp reads
             cookies directly from the named browser's SQLite DB at
             runtime. Cleanest path for the bot wall.
          2. `cookiesFile` — absolute path to a file the user already
             has on disk (manual export).
          3. `cookiesText` — Netscape-format string the extension
             built from chrome.cookies.getAll, written to a temp
             file (finally-deleted so session cookies do not
             outlive the request).
        """
        url = (body.get("url") or "").strip()
        raw_id = (body.get("videoId") or "").strip()
        proxy = (body.get("proxy") or "").strip() or None
        cookies_file = (body.get("cookiesFile") or "").strip() or None
        cookies_text = (body.get("cookiesText") or "").strip() or None
        cookies_from_browser = (
            (body.get("cookiesFromBrowser") or "").strip() or None
        )
        cookies_from_browser_profile = (
            (body.get("cookiesFromBrowserProfile") or "").strip() or None
        )
        if cookies_text and len(cookies_text) > 64 * 1024:
            # 64 KB cap — a normal YouTube cookie jar is well under 4 KB
            # even with 20+ cookies. Anything bigger is a misuse.
            raise YtDlpError("invalid_input", "cookiesText exceeds 64 KB cap")
        video_id = _yt_normalize_video_id(raw_id) if raw_id else _yt_normalize_video_id(url)
        result = _yt_download_audio(
            video_id,
            url,
            proxy=proxy,
            cookies_file=cookies_file,
            cookies_text=cookies_text,
            cookies_from_browser=cookies_from_browser,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            "videoId": result["videoId"],
            "ext": result["ext"],
            "audioUrl": f"/youtube/audio/{result['videoId']}",
            "expiresInSec": _YT_AUDIO_TTL_SEC,
        })

    def _handle_youtube_subtitle(self, body: dict):
        """POST /youtube/subtitle
        body: {videoId, url, lang?, proxy?, cookiesFile?, cookiesText?,
               cookiesFromBrowser?, cookiesFromBrowserProfile?}
        Returns: {ok, videoId, language, source, segments:[{start, duration, text}]}
        Cookies are required (2026-09-28) for the same "Sign in to
        confirm" reason as /youtube/info; without them the subtitle
        endpoint would always return no_subtitle for restricted videos
        even when the captions exist on YouTube's side.
        `cookiesFromBrowser` (2026-09-29) is the cleanest path —
        yt-dlp reads cookies directly from the named browser's
        SQLite DB at runtime, so the cookies/IP/browser fingerprint
        combination matches what YouTube expects to see.
        """
        url = (body.get("url") or "").strip()
        raw_id = (body.get("videoId") or "").strip()
        lang = (body.get("lang") or "").strip() or None
        proxy = (body.get("proxy") or "").strip() or None
        cookies_file = (body.get("cookiesFile") or "").strip() or None
        cookies_text = (body.get("cookiesText") or "").strip() or None
        cookies_from_browser = (
            (body.get("cookiesFromBrowser") or "").strip() or None
        )
        cookies_from_browser_profile = (
            (body.get("cookiesFromBrowserProfile") or "").strip() or None
        )
        if cookies_text and len(cookies_text) > 64 * 1024:
            raise YtDlpError("invalid_input", "cookiesText exceeds 64 KB cap")
        if not url:
            raise ValueError("missing url")
        video_id = _yt_normalize_video_id(raw_id) if raw_id else _yt_normalize_video_id(url)
        result = _yt_download_subtitle(
            video_id,
            url,
            lang,
            proxy=proxy,
            cookies_file=cookies_file,
            cookies_text=cookies_text,
            cookies_from_browser=cookies_from_browser,
            cookies_from_browser_profile=cookies_from_browser_profile,
        )
        self._send_json(HTTPStatus.OK, {
            "ok": True,
            **result,
        })

    def _handle_youtube_audio_stream(self, video_id: str):
        """GET /youtube/audio/<videoId>  -> binary stream of the downloaded
        audio file. The download endpoint put it under
        _YT_AUDIO_DIR/<videoId>.<ext>; we just open + chunk-transfer.
        """
        # Find any matching file (m4a preferred, then anything).
        target: Path | None = None
        for ext in ("m4a", "webm", "mp4", "opus"):
            candidate = _YT_AUDIO_DIR / f"{video_id}.{ext}"
            if candidate.is_file():
                target = candidate
                break
        if target is None:
            # Fallback glob: handles unusual extensions yt-dlp might pick.
            for entry in _YT_AUDIO_DIR.glob(f"{video_id}.*"):
                if entry.is_file():
                    target = entry
                    break
        if target is None:
            self._send_json(HTTPStatus.NOT_FOUND, {
                "ok": False,
                "error_type": "audio_missing",
                "error": f"no downloaded audio for videoId {video_id}. Call POST /youtube/audio first.",
            })
            return
        # Map file extension to a content-type that browsers / the
        # extension understand.
        ext_to_ct = {
            "m4a": "audio/mp4",
            "mp4": "audio/mp4",
            "webm": "audio/webm",
            "opus": "audio/ogg",
            "ogg": "audio/ogg",
        }
        content_type = ext_to_ct.get(target.suffix.lstrip(".").lower(), "application/octet-stream")
        file_size = target.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Access-Control-Allow-Origin", "*")
        # No Accept-Ranges for simplicity — chunks are tiny for ASR.
        self.end_headers()
        with target.open("rb") as fh:
            while True:
                chunk = fh.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ---------- CORS preflight ----------

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # 2026-11-04: the extension's /transcribe POST carries custom X-*
        # headers (X-Whisper-Model / X-Bvid / X-Cid / X-Title / X-Channel /
        # X-Pubdate / X-Cache-Dir). A preflight that does not allow them is
        # rejected by the browser, and the fetch dies with the famously
        # unhelpful "TypeError: Failed to fetch" — no status, no body, no
        # hint that a header list was the problem.
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Whisper-Model, X-Whisper-Language, X-Bvid, X-Cid, "
            "X-Title, X-Channel, X-Pubdate, X-Cache-Dir, X-Initial-Dir, "
            "X-Dialog-Title",
        )
        # Chrome's Local Network Access (PNA) enforcement: a preflight for a
        # request from a public context into a private network (127.0.0.1)
        # must be answered with this header, otherwise the browser drops the
        # request before it is ever sent.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()


def main():
    addr = (HOST, PORT)
    if FW_VERSION is None:
        # Limited mode banner — everything the user needs to fix it, printed
        # right in the console window they are looking at.
        LOG.warning("=" * 62)
        LOG.warning("faster-whisper is NOT importable in this Python.")
        LOG.warning("  python : %s", sys.executable)
        LOG.warning("  reason : %s", FW_IMPORT_ERROR or "import failed")
        LOG.warning("Starting in LIMITED mode anyway:")
        LOG.warning("  /health tells the extension exactly what is missing;")
        LOG.warning("  /transcribe returns 503 until the dep is installed.")
        LOG.warning("Install it yourself (nothing is auto-installed):")
        LOG.warning('  "%s" -m pip install faster-whisper zhconv', sys.executable)
        LOG.warning("=" * 62)
    if YTDLP_VERSION is None:
        # YouTube endpoints will 503 until yt-dlp is installed; whisper /
        # B站 transcription still works fine without it.
        LOG.warning("-" * 62)
        LOG.warning("yt-dlp is NOT importable in this Python.")
        LOG.warning("  python : %s", sys.executable)
        LOG.warning("  reason : %s", YTDLP_IMPORT_ERROR or "import failed")
        LOG.warning("YouTube support (/youtube/info, /audio, /subtitle)")
        LOG.warning("  will return 503 until yt-dlp is installed:")
        LOG.warning('  "%s" -m pip install yt-dlp', sys.executable)
        LOG.warning("-" * 62)
    httpd = ThreadingHTTPServer(addr, Handler)
    LOG.info("bililearn whisper server listening on http://%s:%d", HOST, PORT)
    if FW_VERSION is not None:
        LOG.info("using faster-whisper %s", FW_VERSION)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
