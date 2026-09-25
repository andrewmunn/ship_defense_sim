"""Search Wikimedia Commons for media files and print title, license, duration, url."""
import json, sys, time, urllib.parse, urllib.request, urllib.error
FT = "filetype:video"
UA = "ShipDefenseSimAudio/1.0 (offline game sound design; python-urllib/curl)"
def api(params):
    params = dict(params, format="json")
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    for i in range(6):
        try:
            time.sleep(1.5)
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA})))
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(10 * (i + 1))
    raise RuntimeError("rate limited")
def search(q, n=25):
    d = api({"action": "query", "generator": "search", "gsrsearch": q + " " + FT, "gsrnamespace": 6, "gsrlimit": n,
             "prop": "imageinfo", "iiprop": "url|extmetadata|size|mime"})
    out = []
    for p in (d.get("query", {}).get("pages", {}) or {}).values():
        ii = p["imageinfo"][0]; md = ii.get("extmetadata", {})
        out.append((p["title"], md.get("LicenseShortName", {}).get("value"), ii.get("duration"), ii.get("size"), ii["url"],
                    (md.get("Artist", {}).get("value") or "")[:80]))
    return out
if __name__ == "__main__":
    for q in sys.argv[1:]:
        print("===", q)
        for r in search(q):
            print(f"  {r[0]} | {r[1]} | dur={r[2]} | {r[3]//1024 if r[3] else '?'}KB\n     {r[4]}")
