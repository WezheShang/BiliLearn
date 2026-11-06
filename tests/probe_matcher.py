"""Unit-test the lang matcher logic from _yt_download_subtitle.
Runs offline — no network. Tests the `_pick_match` closure logic
extracted from the function we just refactored."""
import sys
sys.path.insert(0, r"C:\Users\shangweizhe\bilidown")

# Extract just the matcher function — same closure as in _yt_download_subtitle.
def _pick_match(available, code):
    # Pass 1 — exact match
    for k in available:
        if k == code:
            return k
    # Pass 2 — base lang match (zh → zh-Hans/zh-CN/zh-Hant)
    code_base = code.lower().split("-")[0]
    for k in available:
        if k.lower().split("-")[0] == code_base:
            return k
    return None


CASES = [
    # (chain_attempt_code, manual_langs, auto_langs, expected_match,
    #  description)
    # ---- exact match wins (manual preferred over auto)
    ("en", ["en", "de", "ja"], ["en", "zh-Hans"], "en", "exact en manual > auto"),
    # ---- "zh" prefix matches all Chinese variants
    ("zh-Hans", [], ["zh-CN", "zh-Hant", "zh-Hans", "zh-Hans-CN", "en"],
     "zh-Hans", "exact zh-Hans in auto"),
    ("zh", [], ["zh-CN", "zh-Hant", "zh-Hans", "zh-Hans-CN"], "zh-CN",
     "zh base matches zh-CN (first in list)"),
    ("zh-Hant", [], ["zh-CN", "zh-Hant"], "zh-Hant", "exact zh-Hant"),
    ("zh-CN", [], ["zh-Hans-CN", "zh-Hant"], "zh-Hans-CN",
     "zh-CN base matches zh-Hans-CN"),
    # ---- manual wins over auto on same prefix
    ("zh", ["zh-Hans-CN"], ["zh-CN", "zh-Hant"], "zh-Hans-CN",
     "manual zh-Hans-CN matches zh base > auto"),
    # ---- nothing in chain, fall through (handled in the caller)
    ("ko", ["ko", "en"], [], "ko",
     "ko is in manual → matches"),
    # ---- empty available
    ("zh-Hans", [], [], None, "empty manual+auto → no match"),
    # ---- edge: en-orig should match en
    ("en", ["en-orig", "fr"], ["en"], "en-orig", "en matches en-orig manual"),
    # ---- zh-Hant with traditional caption
    ("zh-Hant", ["zh-Hant"], ["zh-Hans"], "zh-Hant", "exact zh-Hant manual"),
]


def run_chain_step(code, manual, auto):
    """Mirrors the actual code's lookup pattern (manual first, then auto)."""
    m = _pick_match(manual, code)
    if m is not None:
        return (m, "manual")
    a = _pick_match(auto, code)
    if a is not None:
        return (a, "auto")
    return (None, None)


passed = 0
failed = 0
for code, manual, auto, expected, desc in CASES:
    actual_key, src = run_chain_step(code, manual, auto)
    ok = actual_key == expected
    flag = "PASS" if ok else "FAIL"
    print(f"[{flag}] chain={code!r:14} -> {actual_key!r:18} ({src})  {desc}")
    if ok:
        passed += 1
    else:
        failed += 1
        print(f"    expected: {expected!r}")

print(f"\n{passed} passed, {failed} failed")