"""Detect periodic gunfire: per 0.5 s window, spectrum of HF envelope; report dominant modulation freq 30-150 Hz and prominence."""
import sys, numpy as np
from scipy import signal
from analyze import load
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
for p in sys.argv[1:]:
    x, fs = load(p); m = x.mean(1)
    sos = signal.butter(4, 1500, "hp", fs=fs, output="sos")
    env = np.abs(signal.sosfilt(sos, m))
    env = signal.sosfilt(signal.butter(4, 400, "lp", fs=fs, output="sos"), env)
    env = env[::20]; efs = fs / 20
    W = int(0.5 * efs); H = W // 2
    rows = []
    for i in range(0, len(env) - W, H):
        seg = env[i:i + W] - env[i:i + W].mean()
        sp = np.abs(np.fft.rfft(seg * np.hanning(W), 8192)); f = np.fft.rfftfreq(8192, 1 / efs)
        band = (f > 30) & (f < 160)
        k = np.argmax(sp[band]); pk = sp[band][k]; med = np.median(sp[(f > 20) & (f < 400)])
        rows.append((i / efs, f[band][k], pk / (med + 1e-12)))
    rows = np.array(rows)
    print("==", p.split("/")[-1][:60])
    for t, fr, pr in rows[::2]:
        print(f"  t={t:5.1f} f={fr:6.1f} prom={pr:5.1f}" + ("  <<< FIRING" if pr > 8 else ""))
