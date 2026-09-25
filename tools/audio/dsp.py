"""Shared DSP toolkit for the ship_defense_sim audio pipeline.

Everything works on float64 numpy arrays at SR = 48000. Mono = shape (n,), stereo = shape (n, 2).
"""
import os, subprocess, tempfile
import numpy as np
import soundfile as sf
from scipy import signal

SR = 48000
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(ROOT, "tools", "audio_work")
RAW = os.path.join(WORK, "raw")
OUT = os.path.join(ROOT, "public", "audio")
os.makedirs(OUT, exist_ok=True)


def rng(seed):
    return np.random.default_rng(seed)


# ----------------------------------------------------------------------------- I/O
def load(path, start=0.0, dur=None, mono=False, sr=SR):
    """Decode any file (via ffmpeg) to float64 at `sr`. Returns (n,) if mono else (n, ch)."""
    if not os.path.isabs(path):
        path = os.path.join(RAW, path)
    tmp = tempfile.mktemp(suffix=".wav")
    cmd = ["ffmpeg", "-v", "error", "-y"]
    if start:
        cmd += ["-ss", str(start)]
    if dur:
        cmd += ["-t", str(dur)]
    cmd += ["-i", path, "-vn", "-ar", str(sr), "-c:a", "pcm_f32le", tmp]
    subprocess.run(cmd, check=True)
    x, _ = sf.read(tmp, always_2d=True, dtype="float64")
    os.remove(tmp)
    if mono:
        return x.mean(1)
    return x


def save_wav(path, x, sr=SR):
    sf.write(path, x, sr, subtype="FLOAT")


def export_ogg(name, x, q=6, sr=SR):
    """Write public/audio/<name>.ogg (Vorbis). Also keep a float wav master in audio_work/masters."""
    x = np.asarray(x, dtype=np.float64)
    mdir = os.path.join(WORK, "masters")
    os.makedirs(mdir, exist_ok=True)
    wav = os.path.join(mdir, name + ".wav")
    save_wav(wav, x, sr)
    out = os.path.join(OUT, name + ".ogg")
    # ffmpeg here has no libvorbis; libsndfile's Vorbis encoder: quality = 1 - compression_level
    if ("loop" in name or name in ("ciws_servo", "alarm_missile")) and x.shape[0] < 5 * sr:
        q = max(q, 8)  # short weapon/engine loops: lower codec noise at the wrap point, size is negligible
    for _ in range(4):
        sf.write(out, x, sr, format="OGG", subtype="VORBIS", compression_level=1.0 - q / 10.0)
        dec, _ = sf.read(out, dtype="float64")
        pk = np.max(np.abs(dec))
        if pk <= db(-1.0):
            break
        x = x * (db(-1.05) / pk)  # Vorbis overshoot: pull the whole asset down slightly and re-encode
    return out


# ----------------------------------------------------------------------------- basic generators
def t_axis(dur, sr=SR):
    return np.arange(int(round(dur * sr))) / sr


def white(n, r):
    return r.standard_normal(n)


def pink(n, r):
    """Pink noise via FFT shaping (1/f power)."""
    X = np.fft.rfft(r.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    X /= np.sqrt(f)
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def brown(n, r):
    X = np.fft.rfft(r.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    X /= f
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def shaped_noise(n, r, fn):
    """Noise with arbitrary magnitude spectrum fn(freq_array)->gain."""
    X = np.fft.rfft(r.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    X *= fn(f)
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def smooth_random(n, r, rate_hz, lo=0.0, hi=1.0):
    """Slowly varying random control signal (cubic-interp of random points at rate_hz)."""
    from scipy.interpolate import CubicSpline
    k = max(4, int(n / SR * rate_hz) + 4)
    pts = r.uniform(lo, hi, k)
    xs = np.linspace(0, n, k)
    return CubicSpline(xs, pts)(np.arange(n))


def periodic_smooth_random(n, r, npts, lo=0.0, hi=1.0):
    """Like smooth_random but periodic over n samples (for seamless loops)."""
    from scipy.interpolate import CubicSpline
    pts = r.uniform(lo, hi, npts)
    pts = np.append(pts, pts[0])
    xs = np.linspace(0, n, npts + 1)
    return CubicSpline(xs, pts, bc_type="periodic")(np.arange(n))


# ----------------------------------------------------------------------------- filters
def _sos(kind, f, order=4):
    f = np.atleast_1d(f)
    return signal.butter(order, f if len(f) > 1 else f[0], kind, fs=SR, output="sos")


def lp(x, f, order=4):
    return signal.sosfilt(_sos("lowpass", f, order), x, axis=0)


def hp(x, f, order=4):
    return signal.sosfilt(_sos("highpass", f, order), x, axis=0)


def bp(x, lo, hi, order=4):
    return signal.sosfilt(_sos("bandpass", [lo, hi], order), x, axis=0)


def lp0(x, f, order=4):
    """Zero-phase lowpass."""
    return signal.sosfiltfilt(_sos("lowpass", f, order), x, axis=0)


def hp0(x, f, order=4):
    return signal.sosfiltfilt(_sos("highpass", f, order), x, axis=0)


def peq(x, f0, gain_db, q=1.0):
    """RBJ peaking EQ."""
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / SR
    al = np.sin(w) / (2 * q)
    b = [1 + al * A, -2 * np.cos(w), 1 - al * A]
    a = [1 + al / A, -2 * np.cos(w), 1 - al / A]
    return signal.lfilter(b, a, x, axis=0)


def shelf(x, f0, gain_db, high=True):
    """RBJ shelving filter (S=1)."""
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / SR
    al = np.sin(w) / 2 * np.sqrt(2)
    c = np.cos(w)
    sA = 2 * np.sqrt(A) * al
    if high:
        b = [A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA)]
        a = [(A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA]
    else:
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    return signal.lfilter(b, a, x, axis=0)


def reson(x, f0, q, gain=1.0):
    """2-pole resonator (constant peak gain bandpass)."""
    w = 2 * np.pi * f0 / SR
    al = np.sin(w) / (2 * q)
    b = [al, 0, -al]
    a = [1 + al, -2 * np.cos(w), 1 - al]
    return gain * signal.lfilter(b, a, x, axis=0)


def tv_lowpass(x, fc):
    """Time-varying one-pole->two-stage lowpass with per-sample cutoff array fc (Hz)."""
    fc = np.broadcast_to(fc, x.shape[:1])
    a = np.exp(-2 * np.pi * np.clip(fc, 5, SR * 0.45) / SR)
    from scipy.signal import lfilter  # noqa
    y1 = np.empty_like(x)
    y2 = np.empty_like(x)
    s1 = np.zeros(x.shape[1:])
    s2 = np.zeros(x.shape[1:])
    # numba-free loop in chunks: use a simple python loop (fine for a few seconds of audio)
    for i in range(x.shape[0]):
        s1 = a[i] * s1 + (1 - a[i]) * x[i]
        s2 = a[i] * s2 + (1 - a[i]) * s1
        y2[i] = s2
    return y2


def tv_lowpass_fast(x, fc, block=64):
    """Block-wise time-varying Butterworth lowpass (2nd order) with state carry. Fast enough for minutes."""
    n = x.shape[0]
    y = np.zeros_like(x)
    zi = None
    for s in range(0, n, block):
        e = min(n, s + block)
        f = float(np.clip(np.mean(fc[s:e]) if np.ndim(fc) else fc, 10, SR * 0.45))
        sos = signal.butter(2, f, "lowpass", fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        y[s:e], zi = signal.sosfilt(sos, x[s:e], axis=0, zi=zi)
    return y


def tv_bandpass_fast(x, fc, q=2.0, block=64):
    n = x.shape[0]
    y = np.zeros_like(x)
    zi = None
    for s in range(0, n, block):
        e = min(n, s + block)
        f = float(np.clip(np.mean(fc[s:e]), 20, SR * 0.45))
        bw = f / q
        lo, hi = max(10, f - bw / 2), min(SR * 0.49, f + bw / 2)
        sos = signal.butter(1, [lo, hi], "bandpass", fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        y[s:e], zi = signal.sosfilt(sos, x[s:e], axis=0, zi=zi)
    return y


# ----------------------------------------------------------------------------- envelopes
def env_exp(n, tau, sr=SR):
    return np.exp(-np.arange(n) / (tau * sr))


def env_adsr(n, a, d, s_level, r, hold=None, sr=SR):
    """Linear attack, exponential-ish decay to sustain, release at end."""
    t = np.arange(n) / sr
    e = np.ones(n) * s_level
    ai = t < a
    e[ai] = t[ai] / max(a, 1e-9)
    di = (t >= a)
    e[di] = s_level + (1 - s_level) * np.exp(-(t[di] - a) / max(d, 1e-9))
    rel_start = n / sr - r
    ri = t >= rel_start
    e[ri] *= np.clip(1 - (t[ri] - rel_start) / max(r, 1e-9), 0, 1) ** 2
    return e


def fade(x, fin=0.0, fout=0.0, sr=SR, curve="cos"):
    x = x.copy()
    ni, no = int(fin * sr), int(fout * sr)
    if ni:
        w = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, ni)) if curve == "cos" else np.linspace(0, 1, ni)
        x[:ni] *= w if x.ndim == 1 else w[:, None]
    if no:
        w = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, no)) if curve == "cos" else np.linspace(1, 0, no)
        x[-no:] *= w if x.ndim == 1 else w[:, None]
    return x


def db(x):
    return 10 ** (x / 20)


# ----------------------------------------------------------------------------- dynamics / colour
def sat(x, drive=1.0):
    """Soft saturation normalised to preserve small-signal gain."""
    return np.tanh(drive * x) / np.tanh(drive) if drive > 0 else x


def asym_sat(x, drive=1.5, bias=0.15):
    y = np.tanh(drive * (x + bias)) - np.tanh(drive * bias)
    return y / (drive * (1 - np.tanh(drive * bias) ** 2))


def compress(x, thresh_db=-18, ratio=4, attack=0.003, release=0.12, makeup_db=0, knee_db=6):
    """Simple feed-forward peak compressor (stereo-linked)."""
    mono = np.abs(x) if x.ndim == 1 else np.max(np.abs(x), axis=1)
    lvl = 20 * np.log10(mono + 1e-9)
    over = lvl - thresh_db
    gr = np.where(over > knee_db / 2, over * (1 - 1 / ratio),
                  np.where(over > -knee_db / 2, (1 - 1 / ratio) * (over + knee_db / 2) ** 2 / (2 * knee_db), 0))
    # smooth gain reduction with attack/release (one-pole, python loop on decimated signal)
    dec = 16
    g = gr[::dec]
    aa = np.exp(-dec / (attack * SR))
    ar = np.exp(-dec / (release * SR))
    out = np.empty_like(g)
    s = 0.0
    for i, v in enumerate(g):
        s = aa * s + (1 - aa) * v if v > s else ar * s + (1 - ar) * v
        out[i] = s
    gr_s = np.interp(np.arange(len(mono)), np.arange(len(out)) * dec, out)
    gain = db(-gr_s + makeup_db)
    return x * (gain if x.ndim == 1 else gain[:, None])


def limiter(x, ceiling_db=-1.0, release=0.08, lookahead=0.002):
    """Look-ahead brickwall-ish limiter; guarantees |x| <= ceiling (followed by hard clip safety)."""
    c = db(ceiling_db)
    mono = np.abs(x) if x.ndim == 1 else np.max(np.abs(x), axis=1)
    la = int(lookahead * SR)
    need = np.maximum(1.0, mono / c)
    # running max over lookahead window (future)
    from scipy.ndimage import maximum_filter1d
    need = maximum_filter1d(need, size=2 * la + 1, origin=0)
    g = 1 / need
    ar = np.exp(-1 / (release * SR))
    # smooth: instant attack, exponential release (vectorised via decimated loop)
    dec = 8
    gd = np.minimum.reduceat(g, np.arange(0, len(g), dec))
    out = np.empty_like(gd)
    s = 1.0
    for i, v in enumerate(gd):
        s = v if v < s else ar ** dec * s + (1 - ar ** dec) * v
        out[i] = s
    gs = np.interp(np.arange(len(g)), np.arange(len(out)) * dec, out)
    gs = np.minimum(gs, g)  # safety
    y = x * (gs if x.ndim == 1 else gs[:, None])
    return np.clip(y, -c, c)


def normalize_peak(x, peak_db=-1.0):
    p = np.max(np.abs(x))
    return x * (db(peak_db) / p) if p > 0 else x


def lufs(x):
    import pyloudnorm as pyln
    y = x if x.ndim == 2 else x[:, None]
    if y.shape[0] < SR // 2:
        y = np.pad(y, ((0, SR // 2 - y.shape[0]), (0, 0)))
    return pyln.Meter(SR).integrated_loudness(y)


def normalize_lufs(x, target, peak_ceiling=-1.0):
    """Normalise integrated loudness to target; if that would exceed peak ceiling, limit peaks (gently)."""
    L = lufs(x)
    y = x * db(target - L)
    if np.max(np.abs(y)) > db(peak_ceiling):
        y = limiter(y, peak_ceiling)
    return y


def remove_dc(x):
    return hp(x, 12, 2)


# ----------------------------------------------------------------------------- space
def synth_ir(dur, rt60, r, stereo=True, predelay=0.0, hf_damp=4000, lf_cut=60, density_ms=None, early=None):
    """Synthetic diffuse reverb IR: exponentially decaying noise with frequency-dependent decay
    (HF decays faster), optional early reflections [(t, gain), ...]."""
    n = int(dur * SR)
    ch = 2 if stereo else 1
    out = np.zeros((n, ch))
    t = np.arange(n) / SR
    for c in range(ch):
        nz = r.standard_normal(n)
        # split into bands with different decay: low, mid, high
        lo = lp(nz, 500)
        mid = bp(nz, 500, hf_damp)
        hi = hp(nz, hf_damp)
        k = 6.91 / rt60
        y = lo * np.exp(-k * 0.85 * t) + mid * np.exp(-k * t) + hi * np.exp(-k * 2.2 * t)
        out[:, c] = y
    out = hp(out, lf_cut, 2)
    # smooth onset
    out *= np.minimum(1, t / 0.004)[:, None]
    if predelay:
        pd = int(predelay * SR)
        out = np.vstack([np.zeros((pd, ch)), out[:-pd]])
    if early:
        for (et, eg) in early:
            i = int(et * SR)
            if i < n:
                for c in range(ch):
                    out[i + c * 7 if i + c * 7 < n else i, c] += eg * np.max(np.abs(out)) * 3
    out /= np.sqrt(np.sum(out ** 2) / ch)
    return out if stereo else out[:, 0]


def convolve(x, ir, wet=0.3, dry=1.0):
    """Convolve mono/stereo x with mono/stereo IR; returns stereo if IR stereo. Output length = len(x)+len(ir)-1."""
    x2 = x if x.ndim == 2 else x[:, None]
    ir2 = ir if ir.ndim == 2 else ir[:, None]
    ch = max(x2.shape[1], ir2.shape[1])
    n = x2.shape[0] + ir2.shape[0] - 1
    out = np.zeros((n, ch))
    for c in range(ch):
        xc = x2[:, min(c, x2.shape[1] - 1)]
        ic = ir2[:, min(c, ir2.shape[1] - 1)]
        out[:, c] = signal.fftconvolve(xc, ic)
    drypad = np.zeros((n, ch))
    drypad[:x2.shape[0]] = x2 if x2.shape[1] == ch else np.repeat(x2, ch, axis=1)
    y = dry * drypad + wet * out
    return y if ch > 1 or x.ndim == 2 else y[:, 0]


def pad_to(x, n):
    if x.shape[0] >= n:
        return x[:n]
    padw = [(0, n - x.shape[0])] + [(0, 0)] * (x.ndim - 1)
    return np.pad(x, padw)


def mix_at(dst, src, at, gain=1.0):
    """Add src into dst starting at sample index `at` (in-place, clipped to dst length)."""
    at = int(at)
    if at >= dst.shape[0]:
        return dst
    m = min(src.shape[0], dst.shape[0] - at)
    if dst.ndim == 2 and src.ndim == 1:
        dst[at:at + m] += gain * src[:m, None]
    else:
        dst[at:at + m] += gain * src[:m]
    return dst


def resample(x, factor):
    """Pitch/speed change by factor (>1 = higher/shorter)."""
    n = int(round(x.shape[0] / factor))
    return signal.resample_poly(x, 1000, int(round(1000 * factor)), axis=0)[:n] if n > 0 else x


def varispeed(x, ratio_curve):
    """Time-varying playback-rate resampling; ratio_curve: per-output-sample rate (1 = original)."""
    pos = np.cumsum(ratio_curve)
    pos -= pos[0]
    pos = pos[pos < x.shape[0] - 1]
    i = pos.astype(int)
    f = pos - i
    if x.ndim == 1:
        return x[i] * (1 - f) + x[i + 1] * f
    return x[i] * (1 - f)[:, None] + x[i + 1] * f[:, None]


# ----------------------------------------------------------------------------- loops
def make_loop(x, xfade):
    """Seamless loop: equal-power crossfade the last `xfade` seconds into the beginning.
    Output length = len(x) - xfade samples."""
    n = int(xfade * SR)
    head = x[:n]
    tail = x[-n:]
    th = np.linspace(0, np.pi / 2, n)
    fi, fo = np.sin(th), np.cos(th)
    if x.ndim == 2:
        fi, fo = fi[:, None], fo[:, None]
    body = x[n:-n] if x.shape[0] > 2 * n else x[n:]
    # the tail (fading out) overlaps with the head (fading in); place the mix at the START
    start = head * fi + tail * fo
    return np.concatenate([start, body], axis=0)


def loop_check(x):
    """Return seam jump metrics (tiled once)."""
    seam = np.max(np.abs(np.atleast_1d(x[0] - x[-1])))
    typ = np.percentile(np.abs(np.diff(x, axis=0)), 99.5)
    return seam, typ


# ----------------------------------------------------------------------------- denoise
def spectral_denoise(x, noise, reduction_db=18, oversub=1.5, nfft=2048):
    """Stationary spectral subtraction using a noise profile clip. Works per channel."""
    x2 = x if x.ndim == 2 else x[:, None]
    n2 = noise if noise.ndim == 2 else noise[:, None]
    out = np.zeros_like(x2)
    floor = db(-reduction_db)
    for c in range(x2.shape[1]):
        f, t, Z = signal.stft(x2[:, c], SR, nperseg=nfft, noverlap=nfft * 3 // 4)
        _, _, N = signal.stft(n2[:, min(c, n2.shape[1] - 1)], SR, nperseg=nfft, noverlap=nfft * 3 // 4)
        prof = np.mean(np.abs(N), axis=1, keepdims=True)
        mag = np.abs(Z)
        g = np.maximum(1 - oversub * prof / (mag + 1e-12), floor)
        # temporal smoothing of the gain to reduce musical noise
        g = signal.lfilter([0.4], [1, -0.6], g, axis=1)
        _, y = signal.istft(Z * g, SR, nperseg=nfft, noverlap=nfft * 3 // 4)
        out[:, c] = pad_to(y, x2.shape[0])
    return out if x.ndim == 2 else out[:, 0]


def onsets(x, thresh_db=12, min_gap=0.005, hp_hz=1000):
    """Simple onset detector (returns sample indices) on high-passed envelope."""
    m = x if x.ndim == 1 else x.mean(1)
    e = np.abs(hp(m, hp_hz))
    e = lp(e, 800, 2)
    de = np.diff(20 * np.log10(e + 1e-7), prepend=-140)
    pk, _ = signal.find_peaks(e, distance=int(min_gap * SR), prominence=np.percentile(e, 90) * 0.5)
    return pk


def circular(fn, x, reps=3):
    """Apply a (non-circular) process fn to a periodic signal x and return one seamless period.
    Tiles x `reps` times, processes, and returns the last full period so all filter/reverb tails
    have wrapped around (tails must be shorter than (reps-1) periods)."""
    n = x.shape[0]
    tiled = np.concatenate([x] * reps, axis=0)
    y = fn(tiled)
    return y[(reps - 1) * n: reps * n]


def circ_mix(dst, src, at, gain=1.0):
    """Add src into periodic buffer dst at index `at`, wrapping around the end."""
    n = dst.shape[0]
    at = int(at) % n
    m = src.shape[0]
    idx = (at + np.arange(m)) % n
    if dst.ndim == 2 and src.ndim == 1:
        np.add.at(dst, idx, gain * src[:, None])
    else:
        np.add.at(dst, idx, gain * src)
    return dst


def modal(n, freqs, decays, amps, r=None, phase_rand=True):
    """Sum of exponentially decaying sinusoids (modal synthesis of struck objects)."""
    t = np.arange(n) / SR
    y = np.zeros(n)
    for f, d, a in zip(freqs, decays, amps):
        ph = r.uniform(0, 2 * np.pi) if (r is not None and phase_rand) else 0
        y += a * np.sin(2 * np.pi * f * t + ph) * np.exp(-t / d)
    return y


def declick(x, thresh_db=10.0, hf=2500.0, win_ms=2.0, ctx_ms=120.0):
    """Attenuate short impulsive clicks/knocks (camera handling, mechanical ticks) in a mono recording:
    where the short-term HF envelope exceeds its running median by > thresh_db, the signal is scaled
    down to the median level (smoothed gain, applied to the full band)."""
    from scipy.ndimage import median_filter
    h = hp(x, hf, 2)
    w = max(1, int(win_ms * SR / 1000))
    e = np.sqrt(np.convolve(h ** 2, np.ones(w) / w, mode="same")) + 1e-9
    dec = 48
    ed = e[::dec]
    med = median_filter(ed, size=max(3, int(ctx_ms * SR / 1000 / dec)) | 1)
    ratio = ed / (med + 1e-9)
    g = np.where(ratio > db(thresh_db), med / ed * db(thresh_db * 0.3), 1.0)
    from scipy.ndimage import minimum_filter1d
    g = minimum_filter1d(g, 5)
    g = np.interp(np.arange(len(x)), np.arange(len(g)) * dec, g)
    g = lp0(g, 150, 2)
    return x * np.clip(g, 0, 1)
