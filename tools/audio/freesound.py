"""Freesound helper (no API key): search CC0 sounds by scraping the search page, and download HQ OGG previews
with license verification from the sound page. Usage:
  freesound.py search "query" [pages]
  freesound.py get <sound_id> [...]      (records into raw/_sources.json)"""
import json, os, re, subprocess, sys, time, html
RAW = os.path.join(os.path.dirname(__file__), "..", "audio_work", "raw", "freesound")
os.makedirs(RAW, exist_ok=True)
SRCF = os.path.join(os.path.dirname(__file__), "..", "audio_work", "raw", "_sources.json")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
def curl(url):
    for i in range(5):
        r = subprocess.run(["curl", "-sL", "-A", UA, url], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout: return r.stdout
        time.sleep(3 * (i + 1))
    return ""
def search(q, pages=1, lic='"Creative Commons 0"'):
    out = []
    for p in range(1, pages + 1):
        url = "https://freesound.org/search/?" + subprocess.run(["python3", "-c", "import urllib.parse,sys;print(urllib.parse.urlencode({'q':sys.argv[1],'f':'license:'+sys.argv[2],'s':'Downloads (most first)','page':sys.argv[3]}))", q, lic, str(p)], capture_output=True, text=True).stdout.strip()
        h = curl(url)
        for blk in re.findall(r'data-sound-id="(\d+)"(.*?)tabindex', h, re.S):
            sid, b = blk
            g = lambda k: (re.search(k + r'="([^"]*)"', b) or [None, ""])[1]
            out.append(dict(id=sid, user=g("data-username"), title=html.unescape(g("data-title")), dur=float(g("data-duration") or 0),
                            sr=g("data-samplerate"), dl=g("data-num-downloads"), ogg=g("data-ogg").replace("-lq.ogg", "-hq.ogg")))
    return out
def get(sid):
    srcs = json.load(open(SRCF)) if os.path.exists(SRCF) else {}
    page = curl(f"https://freesound.org/s/{sid}/")
    m = re.search(r'https://cdn.freesound.org/previews/\d+/' + sid + r'_\d+-lq.ogg', page)
    if not m: print("no preview", sid); return
    ogg = m.group(0).replace("-lq.ogg", "-hq.ogg")
    lic = re.findall(r'creativecommons.org/(publicdomain/zero|licenses/[a-z\-]+)/([\d.]+)', page)
    lic = "CC0 1.0" if any(l[0].startswith("publicdomain") for l in lic) else ("CC " + lic[0][0].split("/")[1].upper() + " " + lic[0][1] if lic else "UNKNOWN")
    title = html.unescape((re.search(r'<title>(.*?)</title>', page, re.S) or [None, ""])[1]).strip()
    user = (re.search(r'freesound.org/people/([^/]+)/sounds/' + sid, page) or re.search(r'/people/([^/"]+)/sounds/' + sid, page))
    user = user.group(1) if user else "?"
    fn = f"fs_{sid}.ogg"; out = os.path.join(RAW, fn)
    if not os.path.exists(out):
        subprocess.run(["curl", "-sfL", "-A", UA, "-o", out, ogg], check=True)
    srcs["freesound/" + fn] = {"title": title, "page": f"https://freesound.org/people/{user}/sounds/{sid}/", "url": ogg, "license": lic, "artist": user}
    json.dump(srcs, open(SRCF, "w"), indent=1)
    print("ok", fn, lic, user, title[:80])
if __name__ == "__main__":
    if sys.argv[1] == "search":
        for r in search(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1):
            print(f"{r['id']:>7} {r['dur']:7.1f}s {r['sr'][:5]:>5} dl={r['dl']:>6} {r['user'][:16]:16} {r['title'][:70]}")
    else:
        for sid in sys.argv[2:]: get(sid); time.sleep(1)
