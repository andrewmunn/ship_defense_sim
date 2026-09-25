"""List video/audio files in a Commons category (recursing subcats to depth)."""
import sys
from commons_search import api
def members(cat, depth=1, seen=None):
    seen = seen if seen is not None else set()
    if cat in seen: return
    seen.add(cat)
    cont = {}
    while True:
        d = api(dict({"action": "query", "list": "categorymembers", "cmtitle": cat, "cmlimit": 500, "cmtype": "file|subcat"}, **cont))
        for m in d["query"]["categorymembers"]:
            t = m["title"]
            if t.startswith("Category:"):
                if depth > 0: yield from members(t, depth - 1, seen)
            elif t.lower().endswith((".webm", ".ogv", ".ogg", ".oga", ".wav", ".flac", ".mp3", ".opus")):
                yield cat, t
        if "continue" not in d: break
        cont = d["continue"]
if __name__ == "__main__":
    depth = int(sys.argv[1])
    for c in sys.argv[2:]:
        for cat, t in members(c, depth): print(cat[9:40], "|", t)
