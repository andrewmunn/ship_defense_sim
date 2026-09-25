"""Download Commons files by title into tools/audio_work/raw, and record license metadata to raw/_sources.json."""
import json, os, sys, time, urllib.parse, urllib.request
from commons_search import api, UA
RAW = os.path.join(os.path.dirname(__file__), "..", "audio_work", "raw")
os.makedirs(RAW, exist_ok=True)
srcf = os.path.join(RAW, "_sources.json")
sources = json.load(open(srcf)) if os.path.exists(srcf) else {}
for title in sys.argv[1:]:
    if not title.startswith("File:"): title = "File:" + title
    d = api({"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url|extmetadata|size"})
    p = next(iter(d["query"]["pages"].values()))
    ii = p["imageinfo"][0]; md = ii["extmetadata"]
    fn = title[5:].replace(" ", "_")
    out = os.path.join(RAW, fn)
    if not os.path.exists(out):
        print("downloading", fn, ii["size"] // 1024, "KB", flush=True)
        import subprocess
        for attempt in range(8):
            rc = subprocess.call(["curl", "-sfL", "-A", UA, "-o", out + ".part", ii["url"]])
            if rc == 0: break
            print("  retry", attempt, flush=True); time.sleep(20 * (attempt + 1))
        else:
            print("FAILED", fn); continue
        os.rename(out + ".part", out)
        time.sleep(5)
    sources[fn] = {"title": title, "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                   "url": ii["url"], "license": md.get("LicenseShortName", {}).get("value"),
                   "artist": md.get("Artist", {}).get("value"), "credit": md.get("Credit", {}).get("value"),
                   "desc": (md.get("ImageDescription", {}).get("value") or "")[:400]}
    json.dump(sources, open(srcf, "w"), indent=1)
    print("ok", fn, sources[fn]["license"])
