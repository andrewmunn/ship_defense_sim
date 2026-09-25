"""Asset registry + mastering/finishing shared by all bank modules.

Each category module registers builder functions with @asset(...). build_bank.py imports the modules,
runs the builders, masters every result (one-shots: DC removal, leading-silence trim to the transient,
tail trim/fade, -1 dBFS peak; loops: seam-safe processing, ~-20 LUFS) and writes manifest.json.
"""
import time
import numpy as np
import dsp
from dsp import SR

REG = []  # dicts: id, fn, loop, desc, source, family, q, master (callable or None), stereo


def asset(id, loop=False, desc="", source="", family=None, q=6, lufs=-20.0, peak=-1.0, trim=True,
          tail_db=-62.0, fade_out=None, premastered=False):
    """premastered=True: the builder returns the final signal (used where several assets must share
    one gain, e.g. CIWS spin-up/loop/tail splicing); only the codec-overshoot guard is applied."""
    def deco(fn):
        REG.append(dict(id=id, fn=fn, loop=loop, desc=desc, source=source, family=family, q=q,
                        lufs=lufs, peak=peak, trim=trim, tail_db=tail_db, fade_out=fade_out,
                        premastered=premastered))
        return fn
    return deco


def variants(family, n, **kw):
    """Register fn(i) for i=1..n as <family>_<i>."""
    def deco(fn):
        for i in range(1, n + 1):
            asset(f"{family}_{i}", family=family, **kw)(lambda i=i: fn(i))
        return fn
    return deco


# ----------------------------------------------------------------------------- finishing
def _mono_abs(x):
    return np.abs(x) if x.ndim == 1 else np.max(np.abs(x), axis=1)


def trim_lead(x, rel_db=-36.0, pre=0.0008):
    """Start the file at the transient: first sample within rel_db of the peak, minus a tiny pre-roll
    that gets a raised-cosine fade-in (so there is no click but the attack is intact)."""
    a = _mono_abs(x)
    thr = np.max(a) * dsp.db(rel_db)
    on = int(np.argmax(a > thr))
    p = int(pre * SR)
    s = max(0, on - p)
    y = x[s:].copy()
    k = on - s
    if k > 1:
        w = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
        y[:k] *= w if y.ndim == 1 else w[:, None]
    return y


def trim_tail(x, rel_db=-62.0, fade=None):
    """Cut after the last sample above rel_db (re peak, smoothed envelope) and fade the end."""
    a = _mono_abs(x)
    env = dsp.lp(a, 30, 2)
    thr = np.max(env) * dsp.db(rel_db)
    idx = np.nonzero(env > thr)[0]
    end = min(len(x), (idx[-1] if len(idx) else len(x) - 1) + int(0.05 * SR))
    y = x[:end]
    f = fade if fade is not None else min(0.5, 0.25 * end / SR)
    return dsp.fade(y, 0.0, f)


def master_oneshot(x, peak=-1.0, trim=True, tail_db=-62.0, fade_out=None):
    x = np.asarray(x, dtype=np.float64)
    x = dsp.hp(x, 15, 2)                      # DC / infrasonic removal
    if trim:
        x = trim_lead(x)
    x = trim_tail(x, tail_db, fade_out)
    x = dsp.normalize_peak(x, peak + 0.3)
    return dsp.limiter(x, peak)


def master_loop(x, target=-20.0, peak=-1.0):
    """Loops must already be seamless; only apply linear gain (+ a look-ahead limiter processed
    circularly so the seam stays intact)."""
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x, axis=0)
    L = dsp.lufs(x)
    y = x * dsp.db(target - L)
    if np.max(np.abs(y)) > dsp.db(peak):
        y = dsp.circular(lambda z: dsp.limiter(z, peak), y, reps=3)
    return y


def seam_report(x):
    """(jump at seam, p99 sample delta) of a loop."""
    seam = float(np.max(np.abs(np.atleast_1d(x[0] - x[-1]))))
    typ = float(np.percentile(np.abs(np.diff(x, axis=0)), 99))
    return seam, typ


# ----------------------------------------------------------------------------- common helpers
def to_stereo(x):
    return x if x.ndim == 2 else np.column_stack([x, x])


def widen(m, r, ms=(7.3, 11.9), amt=0.3):
    """Mono -> stereo with complementary short combs (mono-compatible; sums back to ~mono)."""
    d1, d2 = int(ms[0] * SR / 1000), int(ms[1] * SR / 1000)
    L, R = m.copy(), m.copy()
    L[d1:] += amt * m[:-d1]
    R[d1:] -= amt * m[:-d1]
    L[d2:] -= 0.5 * amt * m[:-d2]
    R[d2:] += 0.5 * amt * m[:-d2]
    return np.column_stack([L, R])


def env_points(n, pts):
    t = np.arange(n) / SR
    tp, vp = zip(*pts)
    return np.interp(t, tp, vp)


def unit(x):
    m = np.max(np.abs(x))
    return x / m if m > 0 else x


def stdn(x):
    s = np.std(x)
    return x / s if s > 0 else x


# ----------------------------------------------------------------------------- build one entry
def build(entry):
    t0 = time.time()
    x = entry["fn"]()
    if entry["premastered"]:
        y = x
    elif entry["loop"]:
        y = master_loop(x, entry["lufs"], entry["peak"])
    else:
        y = master_oneshot(x, entry["peak"], entry["trim"], entry["tail_db"], entry["fade_out"])
    dsp.export_ogg(entry["id"], y, q=entry["q"])
    msg = f"{entry['id']:24s} {y.shape[0] / dsp.SR:6.2f}s ch={1 if y.ndim == 1 else y.shape[1]} " \
          f"peak={20 * np.log10(np.max(np.abs(y))):6.2f}dB  ({time.time() - t0:.1f}s)"
    if entry["loop"]:
        s, p = seam_report(y)
        msg += f"  seam={s:.4f} p99={p:.4f} lufs={dsp.lufs(y):.1f}"
    print(msg, flush=True)




def run(pats=()):
    """Build registered assets whose id matches any of the fnmatch patterns (all if empty)."""
    import fnmatch
    for e in REG:
        if not pats or any(fnmatch.fnmatch(e["id"], p) for p in pats):
            build(e)
