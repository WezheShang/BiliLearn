r"""
bilidown Whisper local server
=============================
A small HTTP server that exposes `faster-whisper` to the bilidown Chrome
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
    C:\Users\username\miniconda3\python.exe C:\Users\username\bilidown\whisper_server.py
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
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# Transparent dependency handling (2026-08-30 rework).
#
# bilidown never silently pip-installs into the user's Python. If
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


def _missing_deps():
    missing = []
    if FW_VERSION is None:
        missing.append("faster-whisper")
    if FW_CTRANSLATE2_ERROR is not None:
        # Surface this as a separate "vc_redist" dep so the options
        # page can show a different fix (install VC++ runtime) than
        # the "pip install faster-whisper zhconv" hint.
        missing.append("vc_redist")
    return missing

HOST = "127.0.0.1"
PORT = 7860
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
    Path(r"C:\Users\username\bilidown\tmp"),
    Path(os.getcwd()),
]

LOG = logging.getLogger("bilidown-whisper")
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
        LOG.info("loading model=%s device=%s compute=%s", name, device, compute)
        t0 = time.time()
        m = WhisperModel(name, device=device, compute_type=compute)
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


class Handler(BaseHTTPRequestHandler):
    server_version = "bilidown-whisper/1.0"

    # Quieter logs -- only log requests, not every static asset.
    def log_message(self, fmt, *args):  # noqa: A003
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict | list):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
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
                },
                "version": FW_VERSION,
                "current_model": _CURRENT_MODEL_NAME,
                "device": _CURRENT_DEVICE,
                "compute_type": _CURRENT_COMPUTE,
                "available_models": AVAILABLE_MODELS,
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
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found", "path": self.path})

    # ---------- POST ----------

    def do_POST(self):  # noqa: N802
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
        # loadLocalSubtitleFile uses, so the bilidown-written cache
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
        for any given video — the bilidown cache is otherwise invisible
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

        Reads only file heads (bilidown docs start with bvid/cid), so
        scanning even a few hundred cache files stays cheap. Returns the
        winning Path or None.
        """
        if not bvid or cid is None:
            return None
        try:
            for dirpath, _dirs, files in os.walk(root_dir):
                for filename in files:
                    if not filename.lower().endswith(".json"):
                        continue
                    candidate = Path(dirpath) / filename
                    if self._json_head_pins(candidate, bvid, cid):
                        return candidate
        except OSError:
            return None
        return None

    def _handle_local_file_get(self, filenames_str=None, cache_dir=None, bvid=None, cid=None):
        """Look for local subtitle files by name pattern (recursive).

        If `bvid` is supplied, scans every .txt/.md under cache_dir and
        matches files whose first non-empty line is a `# Source: <bvid>`
        header — that's how up-master-report labels its outputs. This
        lets bilidown find subtitles even when the filename pattern
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

        # --- Pass 1: filename match (original behavior) ---
        # When `cid` is pinned, a .json hit must ALSO pin the same cid in
        # its doc — filenames are title-based and the parts of a
        # multi-part video share date+title+UP; only cid tells them apart.
        if filenames_str:
            target_filenames = [f.strip().lower() for f in filenames_str.split(",") if f.strip()]
            for root, dirs, files in os.walk(cache_path):
                for filename in files:
                    if filename.lower() in target_filenames:
                        candidate = Path(root) / filename
                        if cid and filename.lower().endswith(".json") and not self._json_head_pins(candidate, bvid, cid):
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
                json_pattern = re.compile(
                    r'"bvid"\s*:\s*"' + re.escape(target_bvid) + r'"',
                )
                # Only consider text-ish files; skip the .m4a/.obsolete cruft
                # up-master-report drops alongside the real subtitles. .json
                # caches (saved by the Whisper trigger flow) live here too.
                for root, dirs, files in os.walk(cache_path):
                    for filename in files:
                        lower = filename.lower()
                        is_json = lower.endswith(".json")
                        if not is_json and not lower.endswith((".txt", ".md", ".srt", ".lrc")):
                            continue
                        file_path = Path(root) / filename
                        if is_json and cid:
                            # CID pinned: require the doc to pin BOTH bvid
                            # and cid (part-exact). No bvid-only fallback —
                            # a sibling part's cached subtitles would
                            # silently be the wrong content; a miss lets
                            # the panel offer a fresh transcription.
                            if not self._json_head_pins(file_path, bvid, cid):
                                continue
                        else:
                            try:
                                # Read the first ~2KB only — headers live at the top.
                                # A full read of every .txt would be slow on
                                # directories that also hold gigabytes of m4a.
                                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                                    head = f.read(2048)
                            except OSError:
                                continue
                            pattern = json_pattern if is_json else text_pattern
                            if not pattern.search(head):
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

        Reads only the head of the file — bilidown-written docs always
        start with {"bvid": ..., "cid": ...}. The cid comparison is
        string-based because the extension writes cid as a JSON number
        while this server writes it as a string. A doc that lacks either
        field counts as NOT pinned (callers use this for exact-part
        matching, so "unknown" must not pass).
        """
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(2048)
        except OSError:
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
            test_file = p / f".bilidown_write_test_{int(time.time())}.tmp"
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

    # ---------- CORS preflight ----------

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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
    httpd = ThreadingHTTPServer(addr, Handler)
    LOG.info("bilidown whisper server listening on http://%s:%d", HOST, PORT)
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
