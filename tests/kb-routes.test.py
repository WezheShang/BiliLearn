# tests/kb-routes.test.py
# Run: python tests/kb-routes.test.py   (cd bilidown first)
# Contract test for /kb/* endpoints: create/list/write/read/videos/queue/
# move/delete + sandbox + pick_root probe mode. 2026-10-03 spec.
import json, os, sys, tempfile, threading, urllib.request, urllib.parse, urllib.error
sys.dont_write_bytecode = True  # 否则 import whisper_server 会在扩展根目录生成 __pycache__ → Chrome MV3 拒载
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import whisper_server  # noqa: E402  (__main__ guard: import has no server side effects)

ROOT = os.path.realpath(tempfile.mkdtemp(prefix="kbtest_"))
srv = whisper_server.ThreadingHTTPServer(("127.0.0.1", 0), whisper_server.Handler)
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
threading.Thread(target=srv.serve_forever, daemon=True).start()

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())

Q = urllib.parse.quote

# 1. create
st, kb = req("POST", "/kb/create", {"root": ROOT, "name": "宏观", "build_method": "raw", "default_speaker": "测试"})
assert st == 200, (st, kb)
assert kb["dir"].replace("/", "\\").startswith(ROOT) or kb["dir"].startswith(ROOT), (kb, ROOT)
assert os.path.isfile(os.path.join(kb["dir"], "kb.json"))

# 2. list sees it
st, items = req("GET", f"/kb/list?root={Q(ROOT)}")
assert st == 200, (st, items)
assert items[0]["name"] == "宏观" and items[0]["build_method"] == "raw", items

# 3. write + read (legit path inside root)
doc_path = os.path.join(kb["dir"], "videos", "a_20260101.md")
st, w = req("POST", "/kb/write", {"root": ROOT, "path": doc_path, "content": "---\ntopic: a\n---\n# a"})
assert st == 200, (st, w)
st, doc = req("GET", f"/kb/read?path={Q(doc_path)}&root={Q(ROOT)}")
assert st == 200 and doc["content"].startswith("---"), (st, doc)

# 4. sandbox: outside-root path + .. traversal both rejected with 400
st, err = req("POST", "/kb/write", {"root": ROOT, "path": os.path.join(tempfile.gettempdir(), "evil.md"), "content": "x"})
assert st == 400, (st, err)
st, err = req("POST", "/kb/write", {"root": ROOT, "path": os.path.join(ROOT, "..", "evil.md"), "content": "x"})
assert st == 400, (st, err)

# 5. videos listing (frontmatter parse)
st, vids = req("GET", f"/kb/videos?root={Q(ROOT)}&kb={Q('宏观')}")
assert st == 200 and vids[0]["topic"] == "a", (st, vids)

# 6. queue: write pending -> list -> consumer move to done
qdir = os.path.join(kb["dir"], "queue", "pending")
os.makedirs(qdir, exist_ok=True)
with open(os.path.join(qdir, "1_bv.json"), "w", encoding="utf-8") as f:
    json.dump({"kb_name": "宏观", "video_file": "a_20260101.md"}, f, ensure_ascii=False)
st, pend = req("GET", f"/kb/queue?root={Q(ROOT)}&kb={Q('宏观')}&state=pending")
assert st == 200 and pend[0]["file"] == "1_bv.json", (st, pend)
st, m = req("POST", "/kb/move", {"root": ROOT,
                                 "from": os.path.join(qdir, "1_bv.json"),
                                 "to": os.path.join(kb["dir"], "queue", "done", "1_bv.json")})
assert st == 200, (st, m)

# 7. move (KB rename) + delete (recursive wipes dir)
st, m = req("POST", "/kb/move", {"root": ROOT, "from": os.path.join(ROOT, "宏观"), "to": os.path.join(ROOT, "宏观2")})
assert st == 200 and os.path.isdir(os.path.join(ROOT, "宏观2")), (st, m)
st, d = req("POST", "/kb/delete", {"root": ROOT, "path": os.path.join(ROOT, "宏观2"), "recursive": True})
assert st == 200 and not os.path.isdir(os.path.join(ROOT, "宏观2")), (st, d)

# 8. pick_root probe mode: no dialog, contract shape {"path": null}
st, picked = req("POST", "/kb/pick_root?probe=1", {})
assert st == 200 and picked["path"] is None, (st, picked)

# 9. /kb/ensure_notes: idempotent, returns dir + existed flag.
st, en1 = req("POST", "/kb/ensure_notes", {"root": ROOT})
assert st == 200, (st, en1)
assert en1["existed"] is False, en1
assert os.path.isdir(os.path.join(ROOT, "notes")), en1
# 标准骨架都已建好 (videos / queue / wiki/{index.md, moc, _meta})
for sub in ("videos", "queue/pending", "queue/done", "queue/failed", "wiki/moc", "wiki/_meta"):
    assert os.path.isdir(os.path.join(ROOT, "notes", sub)), sub
assert os.path.isfile(os.path.join(ROOT, "notes", "wiki", "index.md"))
assert os.path.isfile(os.path.join(ROOT, "notes", "kb.json"))
with open(os.path.join(ROOT, "notes", "kb.json"), encoding="utf-8") as f:
    cfg = json.load(f)
assert cfg["build_method"] == "karpathy", cfg
assert cfg["protected"] is True, cfg
# kb.list: protected 字段必须为 True
st, items = req("GET", f"/kb/list?root={Q(ROOT)}")
notes_entry = next((x for x in items if x["name"] == "notes"), None)
assert notes_entry is not None and notes_entry["protected"] is True, items

# 10. 再次调用 — existed 必须为 True (幂等)
st, en2 = req("POST", "/kb/ensure_notes", {"root": ROOT})
assert st == 200 and en2["existed"] is True, en2

# 11. /kb/create 拒绝 protected name (notes 已被保留给系统)
st, deny = req("POST", "/kb/create", {"root": ROOT, "name": "notes", "build_method": "raw"})
assert st == 400, (st, deny)
assert "protected" in deny.get("error", "").lower(), deny

# 12. /kb/move 拒绝对 protected KB 重命名/挪位 —— dst 第一层组件是 notes 就拒
st, deny2 = req("POST", "/kb/move",
                {"root": ROOT, "from": os.path.join(ROOT, "any"), "to": os.path.join(ROOT, "notes")})
assert st == 400, (st, deny2)
assert "protected" in deny2.get("error", "").lower(), deny2

# 13. /kb/delete 拒绝删除 protected KB 顶层 (recursive=True), 因为整个 KB 是用户的笔记源
st, deny3 = req("POST", "/kb/delete",
                {"root": ROOT, "path": os.path.join(ROOT, "notes"), "recursive": True})
assert st == 400, (st, deny3)
assert "protected" in deny3.get("error", "").lower(), deny3

# 14. /kb/delete 允许 protected KB 内部单个文件删除 (recursive=False), 供镜像笔记删除用
fake_note = os.path.join(ROOT, "notes", "videos", "note_123.md")
with open(fake_note, "w", encoding="utf-8") as f:
    f.write("---\ntype: note\n---\n# test")
st, ok4 = req("POST", "/kb/delete",
              {"root": ROOT, "path": fake_note, "recursive": False})
assert st == 200 and not os.path.isfile(fake_note), (st, ok4)

srv.shutdown()
print("kb-routes.test.py ALL PASS")
