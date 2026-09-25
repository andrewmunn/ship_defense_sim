"""Contact sheet: many small envelope+spectrogram panels in one PNG. usage: sheet.py out.png file[@start:dur] ..."""
import sys, os, numpy as np
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from scipy import signal
sys.path.insert(0, os.path.dirname(__file__))
import dsp
out = sys.argv[1]; items = sys.argv[2:]
n = len(items); cols = 2; rows = (n + 1) // 2
fig, axs = plt.subplots(rows * 2, cols, figsize=(16, 3.2 * rows), gridspec_kw={"height_ratios": [1, 2.2] * rows})
axs = np.atleast_2d(axs)
for k, it in enumerate(items):
    f, s, d = it, 0.0, None
    if "@" in it:
        f, rng_ = it.split("@"); s, d = [float(v) for v in rng_.split(":")]
    x = dsp.load(f, s, d)
    m = x.mean(1); t = np.arange(len(m)) / dsp.SR
    r, c = (k // cols) * 2, k % cols
    hop = max(1, len(m) // 3000)
    pk = np.maximum.reduceat(np.abs(m), np.arange(0, len(m), hop))
    axs[r, c].plot(t[::hop][:len(pk)], 20 * np.log10(pk + 1e-6), lw=.5); axs[r, c].set_ylim(-70, 1); axs[r, c].grid(alpha=.3)
    axs[r, c].set_title(f"{os.path.basename(f)[:40]} @{s} ch={x.shape[1]}", fontsize=9)
    fr, tt, S = signal.spectrogram(m, dsp.SR, nperseg=2048, noverlap=1536)
    S = 10 * np.log10(S + 1e-14)
    axs[r + 1, c].pcolormesh(tt, fr, S, vmin=S.max() - 85, vmax=S.max(), shading="auto", cmap="magma")
    axs[r + 1, c].set_yscale("symlog", linthresh=200); axs[r + 1, c].set_ylim(20, 24000)
    axs[r + 1, c].set_xlim(0, t[-1]); axs[r, c].set_xlim(0, t[-1])
plt.tight_layout(); plt.savefig(out, dpi=55)
