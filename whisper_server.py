r"""
bilidown Whisper local server
=============================
A small HTTP server that exposes `faster-whisper` to the bilidown Chrome
extension. The extension downloads the B-station audio to a local file, then
POSTs the file path here; we return timestamped segments.

Endpoints
---------
GET  /health          -> {ok, model, device, version, status}
GET  /models          -> list of whisper model sizes available
POST /transcribe       body: {audio_path, model?, language?, beam_size?}
                        -> {language, duration, segments:[{start,end,text}]}

Start manually
--------------
    C:\Users\username\miniconda3\python.exe C:\Users\username\bilidown\whisper_server.py
    # or double-click start_whisper_server.bat

The first time you transcribe with a new model, faster-whisper downloads the
weights to %LOCALAPPDATA%\faster-whisper\... (~75MB for "base", ~1.5GB
for "large-v3"). Subsequent runs are cached.
"""

from __future__ import annotations

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

try:
    from faster_whisper import WhisperModel, __version__ as FW_VERSION
except ImportError as exc:
    sys.stderr.write(
        "faster-whisper is not installed.\n"
        r"Install it with:  C:\Users\username\miniconda3\python.exe -m pip install faster-whisper"
        "\n"
        f"Original error: {exc}\n"
    )
    raise

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


def _get_model(name: str) -> WhisperModel:
    global _CURRENT_MODEL, _CURRENT_MODEL_NAME, _CURRENT_DEVICE, _CURRENT_COMPUTE
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
    return {
        "language": info.language,
        "language_probability": float(info.language_probability),
        "duration": float(info.duration),
        "segments": [
            {
                "id": seg.id,
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
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
            self._send_json(HTTPStatus.OK, {
                "ok": True,
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
            self._handle_cache_get(bvid, cid, cache_dir)
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
                self._transcribe_bytes(
                    audio_bytes, model_name, language, beam_size,
                    content_type.split(";", 1)[0].strip(),
                )
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
            self._transcribe_path(path, model_name, language, beam_size, vad_filter)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            LOG.exception("transcribe failed")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": f"{type(exc).__name__}: {exc}"},
            )

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
            self._transcribe_path(tmp_path, model_name, language, beam_size, True)
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
        self._send_json(HTTPStatus.OK, payload)

    # ---------- subtitle cache ----------

    def _resolve_cache_path(self, bvid, cid, cache_dir=None):
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
        return target / f"{safe_bvid}_{safe_cid}.json"

    def _handle_cache_get(self, bvid, cid, cache_dir=None):
        try:
            path = self._resolve_cache_path(bvid, cid, cache_dir)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if not path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {
                "ok": False,
                "cache_path": str(path),
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

    def _handle_cache_write(self, body):
        bvid = (body or {}).get("bvid")
        cid = (body or {}).get("cid")
        payload = (body or {}).get("payload")
        cache_dir = (body or {}).get("cache_dir")
        if payload is None:
            raise ValueError("payload is required")
        try:
            path = self._resolve_cache_path(bvid, cid, cache_dir)
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
    httpd = ThreadingHTTPServer(addr, Handler)
    LOG.info("bilidown whisper server listening on http://%s:%d", HOST, PORT)
    LOG.info("using faster-whisper %s", FW_VERSION)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
