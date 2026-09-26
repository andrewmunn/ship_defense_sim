"""Analysis of the offline renders written by tools/audiocheck.mjs (shots/audio/*.wav).

Prints RMS, spectral centroid and 95 % roll-off vs distance for the sweeps, and checks the CIWS splice
by detecting individual rounds (high-passed envelope peaks) and their inter-onset intervals.
"""
import sys, os, glob, re
import numpy as np
import soundfile as sf
from scipy import signal

D = sys.argv[1] if len(sys.argv) > 1 else 'shots/audio'
fails = 0


def load(p):
    x, sr = sf.read(p, always_2d=True)
    return x.mean(axis=1), sr


def spec_stats(x, sr):
    f, P = signal.welch(x, sr, nperseg=4096)
    P = P + 1e-20
    cen = float((f * P).sum() / P.sum())
    hf = float(10 * np.log10(P[f >= 2000].sum() / P.sum()))  # energy above 2 kHz relative to total
    return cen, hf


print(f"{'file':38s} {'rms dB':>7s} {'peak dB':>8s} {'centroid':>9s} {'HF>2k dB':>9s}")
rows = {}
for p in sorted(glob.glob(os.path.join(D, 'sweep_*.wav')), key=lambda s: (re.sub(r'_\d+m\.wav$', '', s), int(re.search(r'_(\d+)m\.wav$', s).group(1)))):
    x, sr = load(p)
    rms = 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
    pk = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    cen, hf = spec_stats(x, sr)
    name = os.path.basename(p)[:-4]
    m = re.match(r'sweep_(.+)_(\d+)m', name)
    rows.setdefault(m.group(1), []).append((int(m.group(2)), rms, cen, hf))
    print(f"{name:38s} {rms:7.1f} {pk:8.1f} {cen:9.0f} {hf:9.1f}")

for snd, r in rows.items():
    hfs = [h for _, _, _, h in r]
    # air absorption: the share of energy above 2 kHz must drop with distance (small wobble allowed for near/far xfades)
    # (steps where the HF share is already below -40 dB are inaudible and ignored; short-range sounds only need no rise)
    far_enough = r[-1][0] >= 1000
    # 3.5 dB step tolerance: Chrome's HRTF panner (used < 150 m) is ~3 dB darker than equal-power (used beyond)
    ok = all(hfs[i + 1] <= hfs[i] + 3.5 or hfs[i + 1] < -40 for i in range(len(hfs) - 1)) and (hfs[-1] < hfs[0] - 10 or not far_enough)
    print(f"{'PASS' if ok else 'FAIL'}  {snd}: HF share falls with distance ({hfs[0]:.1f} dB -> {hfs[-1]:.1f} dB)")
    fails += 0 if ok else 1


def ciws_onsets(p, t0, t1):
    x, sr = load(p)
    hp = signal.sosfilt(signal.butter(4, 2500, 'hp', fs=sr, output='sos'), x)
    env = np.abs(hp)
    env = signal.sosfilt(signal.butter(2, 900, 'lp', fs=sr, output='sos'), env)
    a, b = int(t0 * sr), int(t1 * sr)
    seg = env[a:b]
    pk, _ = signal.find_peaks(seg, distance=int(0.009 * sr), height=np.percentile(seg, 90) * 0.35)
    return (pk + a) / sr, sr


p = os.path.join(D, 'ciws_burst_20m.wav')
if os.path.exists(p):
    # burst requested 0.1 -> 1.6 s, heard 58 ms later; spin-up 0.427 s
    on, sr = ciws_onsets(p, 0.05, 2.1)
    ioi = np.diff(on) * 1000
    steady = ioi[(on[:-1] > 0.75) & (on[:-1] < 1.55)]
    print(f"\nCIWS 20 m: {len(on)} rounds detected; steady IOI median {np.median(steady):.2f} ms (expected {636 / 48:.2f}), "
          f"p5-p95 {np.percentile(steady, 5):.2f}-{np.percentile(steady, 95):.2f} ms")
    t_loop = 0.1 + 20 / 343 + 0.427
    near = ioi[(on[:-1] > t_loop - 0.06) & (on[:-1] < t_loop + 0.06)]
    print(f"   IOIs around spinup->loop splice (t~{t_loop:.3f} s): {np.round(near, 2).tolist()}")
    t_stop = 1.6 + 20 / 343
    late = ioi[(on[:-1] > t_stop - 0.07) & (on[:-1] < t_stop + 0.05)]
    print(f"   IOIs around loop->tail splice (then the tail's designed deceleration 13.3/14.6/15.8/17.1 ms): {np.round(late, 2).tolist()}")
    ok = abs(np.median(steady) - 13.25) < 0.3 and np.all(near > 11) and np.all(near < 17) and np.all(late > 11) and np.all(late < 19)
    print(f"{'PASS' if ok else 'FAIL'}  CIWS round train is continuous through both splices (no gaps / double hits)")
    fails += 0 if ok else 1

for name in ['raid_mix', 'voice_limit']:
    p = os.path.join(D, name + '.wav')
    if os.path.exists(p):
        x, sr = load(p)
        blk = int(0.4 * sr)
        r = [20 * np.log10(np.sqrt(np.mean(x[i:i + blk] ** 2)) + 1e-12) for i in range(0, len(x) - blk, blk)]
        print(f"\n{name}: short-term RMS (0.4 s blocks) min {min(r):.1f} / median {np.median(r):.1f} / max {max(r):.1f} dBFS, "
              f"peak {20 * np.log10(np.max(np.abs(x)) + 1e-12):.2f} dBFS")

sys.exit(1 if fails else 0)
