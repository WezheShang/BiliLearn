# -*- coding: utf-8 -*-
"""
whisper_server 本地模型解析探针（2026-11-05）

背景：用户点 Whisper 转录 → server 回 500
    LocalEntryNotFoundError: Got: ConnectTimeout: [WinError 10060]

根因：faster-whisper 认模型名 "base" 时会去 HuggingFace Hub 在线拉。
本机**直连 huggingface.co 不通**，server 又可能以 SYSTEM 运行（其 HF
缓存为空），于是必然超时。

修法：
  1) `_bootstrap_hf_cache()` 在 faster_whisper **import 之前**把
     HF_HOME / HF_HUB_CACHE 指向真正装着模型的缓存根；
  2) `_resolve_model_reference()` 把 "base" 解析成本地 snapshot 目录
     → 离线加载，零网络。

跑法（必须 -B，绝不能让 Python 在扩展根目录写 __pycache__）：
    python -B bilidown-tests\_diag_whisper_model_resolve.py
"""

import os
import sys
import shutil
import tempfile
import importlib.util

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


def load_server():
    """从路径加载 whisper_server 模块（不写 __pycache__）。"""
    spec = importlib.util.spec_from_file_location("whisper_server_probe", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["whisper_server_probe"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    print("=== whisper_server 本地模型解析探针 ===")

    # --- 1. 导入前 HF 缓存已被指向"有模型的根" -------------------------
    mod = load_server()

    roots = mod._hf_search_roots()
    print("  search roots:")
    for r in roots:
        print("    %s%s" % (r, "  [HAS MODELS]" if mod._root_has_models(r) else ""))

    with_models = [r for r in roots if mod._root_has_models(r)]
    check("R1 至少找到一个装着 faster-whisper 模型的 HF 缓存根", len(with_models) > 0,
          "roots=%s" % roots)

    hub_cache = os.environ.get("HF_HUB_CACHE", "")
    check("R2 HF_HUB_CACHE 已被设置为某个存在的目录",
          bool(hub_cache) and os.path.isdir(hub_cache), "HF_HUB_CACHE=%r" % hub_cache)
    check("R3 HF_HUB_CACHE 指向的根里确实有模型",
          bool(hub_cache) and mod._root_has_models(hub_cache),
          "HF_HUB_CACHE=%r" % hub_cache)

    # --- 2. _find_local_model_snapshot ---------------------------------
    snap = mod._find_local_model_snapshot("base")
    check("R4 base 模型能定位到本地快照目录", snap is not None)
    if snap is not None:
        check("R5 快照目录里有 model.bin（CT2 权重本体）",
              os.path.isfile(os.path.join(str(snap), "model.bin")), str(snap))
        check("R6 快照目录里有 config.json",
              os.path.isfile(os.path.join(str(snap), "config.json")), str(snap))

    # 没下载过的模型 → 必须返回 None（而不是随便指个目录）
    check("R7 未下载的模型名返回 None",
          mod._find_local_model_snapshot("definitely-not-downloaded-xyz") is None)

    # --- 3. _resolve_model_reference ----------------------------------
    ref = mod._resolve_model_reference("base")
    check("R8 base 解析成本地 snapshot 路径（不是裸模型名）",
          ref != "base" and os.path.isdir(ref), "ref=%r" % ref)
    check("R9 解析结果指向 base 的 snapshot",
          "faster-whisper-base" in ref.replace("\\", "/"), "ref=%r" % ref)

    ref_missing = mod._resolve_model_reference("definitely-not-downloaded-xyz")
    check("R10 缺失模型回落成原名（走在线下载）",
          ref_missing == "definitely-not-downloaded-xyz", "ref=%r" % ref_missing)

    ref_auto = mod._resolve_model_reference("auto")
    check("R11 auto 解析成默认模型的快照",
          ref_auto != "auto" and os.path.isdir(ref_auto), "ref=%r" % ref_auto)

    # --- 4. _get_model 确实用了解析后的路径 ---------------------------
    captured = {}

    class FakeWhisperModel:
        def __init__(self, ref, device=None, compute_type=None):
            captured["ref"] = ref
            captured["device"] = device
            captured["compute_type"] = compute_type

    orig = mod.WhisperModel
    orig_name = mod._CURRENT_MODEL_NAME
    mod.WhisperModel = FakeWhisperModel
    mod._CURRENT_MODEL = None
    mod._CURRENT_MODEL_NAME = None
    try:
        mod._get_model("base")
    finally:
        mod.WhisperModel = orig
        mod._CURRENT_MODEL = None
        mod._CURRENT_MODEL_NAME = orig_name

    check("R12 _get_model 把本地 snapshot 路径传给 WhisperModel",
          captured.get("ref") == ref, "captured=%r expected=%r" % (captured.get("ref"), ref))
    check("R13 _get_model 传的不是裸模型名（不会联网）",
          captured.get("ref") not in ("base", None), "captured=%r" % captured.get("ref"))

    # --- 5. 红/绿反向验证：坏缓存根不能被选中 -------------------------
    # 造一个"有 repo 目录但快照里没有 model.bin"的假缓存根，
    # 以及一个"完全没有模型"的空根，确认解析器不会误判。
    tmp = tempfile.mkdtemp(prefix="whisper_probe_")
    try:
        fake_root = os.path.join(tmp, "hub")
        repo = os.path.join(fake_root, "models--Systran--faster-whisper-tiny")
        os.makedirs(os.path.join(repo, "snapshots", "deadbeef"))
        # 故意不放 model.bin
        with open(os.path.join(repo, "snapshots", "deadbeef", "config.json"), "w") as f:
            f.write("{}")
        empty_root = os.path.join(tmp, "empty")
        os.makedirs(empty_root)

        check("R14 没有 model.bin 的 repo 不算'有模型'",
              not mod._root_has_models(fake_root), fake_root)
        check("R15 空目录不算'有模型'",
              not mod._root_has_models(empty_root), empty_root)

        # 只看假根时，找不到快照
        saved_roots = mod._MODEL_SEARCH_ROOTS
        try:
            mod._MODEL_SEARCH_ROOTS = [fake_root, empty_root]
            check("R16 只有坏根时 _find_local_model_snapshot 返回 None",
                  mod._find_local_model_snapshot("tiny") is None)
            check("R17 只有坏根时 _resolve_model_reference 回落成裸名",
                  mod._resolve_model_reference("tiny") == "tiny")
        finally:
            mod._MODEL_SEARCH_ROOTS = saved_roots
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- 6. 现有真实模型不被破坏 --------------------------------------
    for m in ("tiny", "base", "small"):
        s = mod._find_local_model_snapshot(m)
        check("R18 %s 模型快照可定位" % m, s is not None)

    print("")
    print("=== %d passed, %d failed ===" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("  FAILED: %s  %s" % (name, detail))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
