"""Fetch a DVIDS video page, find its mp4, download to raw/dvids_<id>.mp4, record metadata in raw/_sources.json.
DVIDS media produced by US military personnel in the course of duty is public domain (17 U.S.C. 105)."""
import json, os, re, subprocess, sys, html
RAW = os.path.join(os.path.dirname(__file__), "..", "audio_work", "raw")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
srcf = os.path.join(RAW, "_sources.json")
sources = json.load(open(srcf)) if os.path.exists(srcf) else {}
for url in sys.argv[1:]:
    vid = re.search(r"/video/(\d+)", url).group(1)
    page = subprocess.run(["curl", "-sL", "-A", UA, url], capture_output=True, text=True).stdout
    mp4s = sorted(set(re.findall(r'https?://[^"\' ]+\.mp4', page)))
    title = html.unescape(re.search(r"<title>(.*?)</title>", page, re.S).group(1).strip())
    credit = re.search(r'Video by ([^<]+)<', page)
    lic = "Public Domain" if re.search(r"public domain", page, re.I) else "US Gov work (DVIDS) - verify"
    fn = f"dvids_{vid}.mp4"; out = os.path.join(RAW, fn)
    if not mp4s: print("no mp4 for", url); continue
    if not os.path.exists(out):
        subprocess.run(["curl", "-sfL", "-A", UA, "-o", out, mp4s[0]], check=True)
    sources[fn] = {"title": title, "page": url, "url": mp4s[0], "license": lic,
                   "artist": credit.group(1).strip() if credit else "U.S. Navy (DVIDS)"}
    json.dump(sources, open(srcf, "w"), indent=1)
    print("ok", fn, title[:90], "|", lic, "|", sources[fn]["artist"])
