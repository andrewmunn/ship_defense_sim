"""Analyse exported assets: stats + spectrogram PNGs (loops are plotted tiled x2 to reveal seams)."""
import sys, os, glob, json
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import analyze, dsp
outdir = os.path.join(dsp.WORK, "png_out"); os.makedirs(outdir, exist_ok=True)
pats = sys.argv[1:] or ["*"]
for pat in pats:
    for f in sorted(glob.glob(os.path.join(dsp.OUT, pat + ".ogg"))):
        name = os.path.basename(f)[:-4]
        x, fs = analyze.load(f)
        loop = "loop" in name or name == "ciws_servo"
        st = analyze.stats(x, fs, loop=loop)
        kb = os.path.getsize(f) / 1024
        print(f"{name:26s} {kb:7.0f}KB", {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in st.items()})
        analyze.plot(x, fs, os.path.join(outdir, name + ".png"), name + (" (tiled x2)" if loop else ""), tile=2 if loop else 1)
