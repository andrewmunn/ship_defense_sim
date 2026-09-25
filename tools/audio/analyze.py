"""Analysis helpers: spectrogram/envelope PNGs, stats (peak, RMS, LUFS, DC, loop-seam check)."""
import sys, os, numpy as np, soundfile as sf
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import signal

def load(path, sr=48000):
    if not path.endswith((".wav", ".flac")):
        import subprocess, tempfile
        tmp = tempfile.mktemp(suffix=".wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ar", str(sr), tmp], check=True)
        x, fs = sf.read(tmp, always_2d=True); os.remove(tmp)
    else:
        x, fs = sf.read(path, always_2d=True)
    return x, fs

def stats(x, fs, loop=False):
    import pyloudnorm as pyln
    mono = x.mean(1)
    peak = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    rms = 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
    try:
        lufs = pyln.Meter(fs).integrated_loudness(x if x.shape[0] > fs * 0.5 else np.pad(x, ((0, int(fs * 0.5)), (0, 0))))
    except Exception:
        lufs = float("nan")
    dc = float(np.mean(mono))
    clip = int(np.sum(np.abs(x) >= 0.999))
    d = {"dur": x.shape[0] / fs, "ch": x.shape[1], "peak_db": round(peak, 2), "rms_db": round(rms, 2),
         "lufs": round(lufs, 2), "dc": round(dc, 6), "clipped_samples": clip}
    if loop:
        # seam discontinuity relative to typical sample-to-sample delta
        seam = np.abs(x[0] - x[-1]).max()
        typ = np.percentile(np.abs(np.diff(x, axis=0)), 99)
        # also compare short-term RMS at the start vs end
        n = int(0.05 * fs)
        r0 = np.sqrt(np.mean(x[:n] ** 2)); r1 = np.sqrt(np.mean(x[-n:] ** 2))
        d["loop_seam_jump"] = round(float(seam), 4); d["loop_p99_delta"] = round(float(typ), 4)
        d["loop_rms_ratio_db"] = round(20 * np.log10((r0 + 1e-9) / (r1 + 1e-9)), 2)
        # click detector: HF (>4 kHz) energy in a 4 ms window centred on the seam of the tiled loop vs the
        # 99th percentile of the same measure over the whole loop (ratio > ~0 dB suggests an audible click)
        tiled = np.concatenate([x, x], axis=0).mean(1)
        hf = signal.sosfilt(signal.butter(4, 4000, "hp", fs=fs, output="sos"), tiled)[len(x) // 2:]  # skip filter warmup
        w = int(0.004 * fs)
        e = np.convolve(hf ** 2, np.ones(w) / w, mode="same")
        seam_i = len(x) - len(x) // 2
        d["seam_hf_vs_p99_db"] = round(10 * np.log10((e[seam_i] + 1e-15) / (np.percentile(e, 99) + 1e-15)), 2)
    return d

def plot(x, fs, out, title="", fmax=None, tile=1):
    mono = x.mean(1)
    if tile > 1: mono = np.tile(mono, tile)
    fig, ax = plt.subplots(2, 1, figsize=(14, 7), sharex=True, gridspec_kw={"height_ratios": [1, 2.5]})
    t = np.arange(len(mono)) / fs
    hop = max(1, len(mono) // 4000)
    env = np.abs(mono)
    ax[0].plot(t[::hop], 20 * np.log10(np.maximum.reduceat(env, np.arange(0, len(env), hop)) + 1e-6), lw=0.6)
    ax[0].set_ylim(-70, 1); ax[0].set_ylabel("peak dBFS"); ax[0].grid(alpha=.3); ax[0].set_title(title)
    nper = 2048 if len(mono) > 4096 else 256
    f, tt, S = signal.spectrogram(mono, fs, nperseg=nper, noverlap=nper * 3 // 4, window="hann")
    S = 10 * np.log10(S + 1e-14)
    ax[1].pcolormesh(tt, f, S, vmin=S.max() - 90, vmax=S.max(), shading="auto", cmap="magma")
    ax[1].set_yscale("symlog", linthresh=200); ax[1].set_ylim(20, fmax or fs / 2); ax[1].set_ylabel("Hz"); ax[1].set_xlabel("s")
    plt.tight_layout(); plt.savefig(out, dpi=70); plt.close(fig)

if __name__ == "__main__":
    outdir = sys.argv[1]; os.makedirs(outdir, exist_ok=True)
    for p in sys.argv[2:]:
        x, fs = load(p)
        name = os.path.splitext(os.path.basename(p))[0][:60]
        print(name, stats(x, fs))
        plot(x, fs, os.path.join(outdir, name + ".png"), name)
