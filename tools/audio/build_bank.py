"""Regenerate the whole ship_defense_sim sound bank (public/audio/*.ogg + manifest.json).

usage:  .venv/bin/python tools/audio/build_bank.py            # build everything
        .venv/bin/python tools/audio/build_bank.py 'gun_*' ui_click   # only matching ids (manifest still complete)
        .venv/bin/python tools/audio/build_bank.py --manifest   # only rewrite manifest.json

Sources: tools/audio_work/raw (see raw/_sources.json; tools/audio/fetch_sources.sh re-downloads them).
Every random process uses a fixed seed, so the output is deterministic.
After building, `tools/audio/check.py` writes stats + spectrogram PNGs to tools/audio_work/png_out.
"""
import fnmatch, json, os, sys
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsp, bank
# category modules (import order = build order); each registers its assets with @bank.asset
import build_ciws, build_gun, build_missiles, build_explosions, build_ambience, build_ui  # noqa: F401

CREDITS = [
    "All sounds produced by tools/audio/build_bank.py (numpy/scipy DSP): synthesized, or hybrids layering synthesis "
    "with the public-domain / CC0 recordings below.",
    "U.S. Navy / DoD video (public domain, 17 U.S.C. 105; no endorsement implied): 'USS Bainbridge Conducts a CWIS "
    "Pre-Action Calibration' (DVIDS 1000563, via Wikimedia Commons); 'US Navy CIWS System firing' (Wikimedia Commons); "
    "'USS Oscar Austin (DDG-79) Completes an SM-2 Engagement ... Formidable Shield 2023' (Lt.j.g. Thomas McGowan, via "
    "Wikimedia Commons); 'USS Porter SM-2 launch Formidable Shield 2023' (230520-N-NQ285-2004, via Wikimedia Commons); "
    "'USS Dewey Fires 5-Inch Gun During Live-Fire Exercise in the Philippine Sea' (DVIDS 937504); 'USS Dewey Fires "
    "5-inch Gun' (DVIDS 836211).",
]


def freesound_credits():
    src = json.load(open(os.path.join(dsp.RAW, "_sources.json")))
    used = set()
    for mod in ["build_ciws", "build_gun", "build_missiles", "build_explosions", "build_ambience", "build_ui"]:
        txt = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), mod + ".py")).read()
        for k in src:
            if k.startswith("freesound/") and k.split("/")[1] in txt:
                used.add(k)
    out = []
    for k in sorted(used, key=lambda k: int(k.split("_")[1].split(".")[0])):
        v = src[k]
        title = v["title"].replace("Freesound - ", "")
        out.append(f"Freesound #{k.split('_')[1].split('.')[0]}: \"{title}\" ({v['page']}), license {v['license']}")
    return out


def write_manifest():
    sounds = {}
    fam = {}
    for e in bank.REG:
        f = os.path.join(dsp.OUT, e["id"] + ".ogg")
        if not os.path.exists(f):
            print("MISSING", e["id"])
            continue
        info = sf.info(f)
        rec = {"file": e["id"] + ".ogg", "loop": e["loop"], "duration": round(info.frames / info.samplerate, 3),
               "channels": info.channels, "desc": e["desc"], "source": e["source"]}
        if e["family"]:
            g = fam.setdefault(e["family"], {"loop": e["loop"], "variants": [], "durations": [], "channels": info.channels,
                                             "desc": e["desc"], "source": e["source"]})
            g["variants"].append(rec["file"])
            g["durations"].append(rec["duration"])
            g["channels"] = max(g["channels"], info.channels)
        else:
            sounds[e["id"]] = rec
    for k, g in fam.items():
        sounds[k] = {"file": g["variants"][0], "loop": g["loop"], "duration": max(g["durations"]),
                     "channels": g["channels"], "variants": g["variants"], "variant_durations": g["durations"],
                     "desc": g["desc"], "source": g["source"]}
    order = [e["family"] or e["id"] for e in bank.REG]
    sounds = {k: sounds[k] for k in dict.fromkeys(order) if k in sounds}
    man = {"sampleRate": dsp.SR, "format": "Ogg Vorbis",
           "levels": "One-shots peak-normalized to -1 dBFS (decoded) and trimmed to start at the transient; loops "
                     "~-20 LUFS integrated (ciws_servo -24) and seamless (sample-exact wrap). ciws_spinup / "
                     "ciws_fire_loop / ciws_tail share one gain so they splice.",
           "sounds": sounds, "credits": CREDITS + freesound_credits()}
    with open(os.path.join(dsp.OUT, "manifest.json"), "w") as fh:
        json.dump(man, fh, indent=1, ensure_ascii=False)
    # remove files that are not part of the bank
    keep = {e["id"] + ".ogg" for e in bank.REG} | {"manifest.json"}
    for f in os.listdir(dsp.OUT):
        if f not in keep:
            os.remove(os.path.join(dsp.OUT, f))
            print("removed stale", f)
    tot = sum(os.path.getsize(os.path.join(dsp.OUT, f)) for f in os.listdir(dsp.OUT))
    print(f"manifest: {len(sounds)} entries, {len(keep) - 1} files, {tot / 1e6:.2f} MB total")


def main(argv):
    pats = [a for a in argv if not a.startswith("--")]
    if "--manifest" not in argv:
        ids = [e["id"] for e in bank.REG]
        if len(ids) != len(set(ids)):
            raise SystemExit("duplicate ids")
        for e in bank.REG:
            if not pats or any(fnmatch.fnmatch(e["id"], p) for p in pats):
                bank.build(e)
    write_manifest()


if __name__ == "__main__":
    main(sys.argv[1:])
