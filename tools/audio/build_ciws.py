"""CIWS assets: ciws_fire_loop, ciws_spinup, ciws_tail, ciws_distant_loop, ciws_servo.

Source: real per-shot grains extracted from the U.S. Navy PD video "USS Bainbridge Conducts a CWIS
Pre-Action Calibration" (clean, dry impulse train at ~76 shots/s), re-sequenced into a perfectly
periodic loop and layered with synthesized close-perspective detail (gas bursts, mount/deck
resonance thump, bolt/mechanism ticks, drive-motor whine, internal feed rattle, short deck
reflections).
"""
import numpy as np
from scipy import signal
import functools
import dsp, bank
from bank import asset
from dsp import SR

R = dsp.rng(4500)
P = 636                      # shot period in samples -> 75.47 shots/s (4528 rpm)
N_LOOP = 226                 # shots per loop -> 2.995 s
L = P * N_LOOP


# ----------------------------------------------------------------------------- real grains
def extract_grains():
    x = dsp.load("bainbridge.webm", mono=True)
    x = dsp.hp(x, 30, 2)
    e = np.abs(dsp.hp(x, 2000))
    grains, spin = [], []
    for (a, b) in [(2.62, 4.95), (12.9, 15.36)]:
        s0, s1 = int(a * SR), int(b * SR)
        pk, _ = signal.find_peaks(e[s0:s1], distance=int(0.0105 * SR), height=0.035)
        pk = pk + s0
        # refine: main shot = largest |x| within +-1.5 ms
        ref = []
        for p in pk:
            w = x[p - 72:p + 72]
            ref.append(p - 72 + int(np.argmax(np.abs(w))))
        pk = np.array(sorted(set(ref)))
        d = np.diff(pk)
        for i in range(1, len(pk) - 1):
            pre = 40
            ln = min(d[i], 900) - pre + 30
            g = x[pk[i] - pre: pk[i] - pre + ln].copy()
            g = dsp.fade(g, 0.0006, 0.0015)
            if 590 < d[i - 1] < 700 and 590 < d[i] < 700 and i > 20:
                grains.append(g[:P - 8])
            if i > len(pk) - 12:
                spin.append((g, d[i]))
    grains = [g / np.max(np.abs(g)) for g in grains]
    return grains, spin


def shot_synth(r, close=True):
    """Synthesized close-perspective per-shot detail (returned mono, starts at blast)."""
    n = P + 400
    t = np.arange(n) / SR
    # gas burst: short bright noise burst (muzzle gas), 3.5 ms decay
    gas = dsp.bp(r.standard_normal(n), 400, 9000, 2) * np.exp(-t / 0.0032)
    gas *= np.minimum(1, t / 0.0002)
    # mount/deck resonance thump: low damped modes excited each shot
    thump = dsp.modal(n, [62, 118, 176, 243], [0.018, 0.012, 0.008, 0.006],
                      [1.0, 0.7, 0.45, 0.3], r) * np.minimum(1, t / 0.0008)
    # bolt / breech mechanism tick ~4-6 ms after the shot
    tick = np.zeros(n)
    d = int(r.uniform(0.0035, 0.0055) * SR)
    k = dsp.modal(n - d, r.uniform([2100, 3300, 4700, 6900], [2500, 3900, 5400, 7800]),
                  [0.004, 0.003, 0.0022, 0.0015], [1, 0.8, 0.6, 0.4], r)
    tick[d:] = k * np.minimum(1, np.arange(n - d) / 10)
    return gas, thump, tick


def deck_reflections(x):
    """A few discrete early reflections from superstructure/deck (lowpassed, attenuated)."""
    y = x.copy()
    for dt, g, f in [(0.0042, 0.35, 5000), (0.0091, 0.25, 3500), (0.0137, 0.18, 3000), (0.0213, 0.12, 2200),
                     (0.0290, 0.08, 1800)]:
        s = int(dt * SR)
        y[s:] += g * dsp.lp(x[:-s], f, 2)
    return y


def build_train(times, grains, r, gains=None, close=True, n=None):
    """Mix shots at sample positions `times` into a circular buffer of length n (layers kept separate)."""
    layers = {k: np.zeros(n) for k in ["real", "gas", "thump", "tick"]}
    for i, tt in enumerate(times):
        g = grains[r.integers(len(grains))]
        a = dsp.db(r.normal(0, 1.2)) * (gains[i] if gains is not None else 1.0)
        dsp.circ_mix(layers["real"], g, tt - 40, a)
        gas, thump, tick = shot_synth(r, close)
        dsp.circ_mix(layers["gas"], gas, tt, a * dsp.db(r.normal(0, 1.5)))
        dsp.circ_mix(layers["thump"], thump, tt, a)
        dsp.circ_mix(layers["tick"], tick, tt, a * dsp.db(r.normal(0, 2.5)))
    return layers


def motor_whine(n, r, f0_curve, periodic=False):
    """Gun drive motor / barrel-cluster whine: harmonic tone set with slight wobble + filtered noise."""
    ph = 2 * np.pi * np.cumsum(f0_curve) / SR
    y = np.zeros(n)
    for h, a in [(1, 1.0), (2, 0.5), (3, 0.35), (4, 0.18), (6, 0.12), (8, 0.06)]:
        y += a * np.sin(h * ph + r.uniform(0, 6.28))
    # barrel cluster rotation: 12.5 Hz amplitude flutter (6 barrels at 750 rpm)
    return y


def mix_close(layers, whine, rattle):
    real = dsp.hp(layers["real"], 40, 2)
    gas = layers["gas"]
    thump = layers["thump"]
    tick = layers["tick"]
    m = 1.0 * real + 0.10 * gas + 0.030 * thump + 0.018 * tick + 0.010 * whine + 0.012 * rattle
    return m


def build_loop(grains):
    r = dsp.rng(1)
    times = np.arange(N_LOOP) * P + 60 + r.integers(-6, 7, N_LOOP)
    lay = build_train(times, grains, r, n=L)
    t = np.arange(L) / SR
    # whine: 187 Hz fundamental (motor) phase-continuous over the loop -> choose integer cycles
    cycles = round(187 * L / SR)
    f0 = np.full(L, cycles * SR / L)
    whine = motor_whine(L, r, f0)
    whine *= 1 + 0.15 * np.sin(2 * np.pi * round(12.5 * L / SR) * t * SR / L)
    # internal feed/link rattle: dense random metallic micro-impacts, periodic by construction
    rat = np.zeros(L)
    for _ in range(1800):
        dsp.circ_mix(rat, dsp.modal(300, r.uniform([3000, 5200], [4200, 7600]), [0.0012, 0.0008], [1, .6], r),
                     r.integers(L), r.uniform(0.2, 1))
    m = mix_close(lay, whine, rat)
    m = dsp.circular(lambda z: deck_reflections(z), m)
    m = dsp.circular(lambda z: dsp.peq(dsp.hp(z, 35, 2), 420, 3.0, 1.2), m)
    return m, times


def build_start(grains):
    r = dsp.rng(2)
    # spin-up: 0.14 s of motor wind-up, then shots with interval shrinking from ~30 ms to P
    t_first = int(0.14 * SR)
    times = [t_first]
    iv = 1500.0
    while True:
        iv = max(P, iv * 0.86)
        times.append(times[-1] + int(iv))
        if iv <= P and len(times) > 18:
            break
    times = np.array(times)
    n = times[-1] + P
    gains = np.clip(np.linspace(0.75, 1.0, len(times)), 0, 1)
    lay = {k: np.zeros(n + 4000) for k in ["real", "gas", "thump", "tick"]}
    lay = build_train(times, grains, r, gains=gains, n=n + 4000)
    tt = np.arange(n + 4000) / SR
    f_end = round(187 * L / SR) * SR / L
    f0 = f_end * np.clip(0.25 + 0.75 * (1 - np.exp(-tt / 0.09)), 0, 1)
    whine = motor_whine(n + 4000, r, f0) * np.clip(tt / 0.05, 0, 1) * (1 + 3.0 * np.clip((0.16 - tt) / 0.04, 0, 1))
    rat = np.zeros(n + 4000)
    for _ in range(int(1200 * (n / L))):
        pos = int(t_first + (n - t_first) * np.sqrt(r.uniform()))
        dsp.mix_at(rat, dsp.modal(300, r.uniform([3000, 5200], [4200, 7600]), [0.0012, 0.0008], [1, .6], r),
                   pos, r.uniform(0.2, 1))
    # pneumatic/electrical clunk of the gun drive engaging
    clunk = dsp.modal(9000, [95, 160, 410, 1250, 2600], [0.05, 0.03, 0.02, 0.01, 0.006], [1, .8, .5, .35, .2], r)
    m = mix_close(lay, whine, rat)
    dsp.mix_at(m, clunk * np.minimum(1, np.arange(9000) / 30), int(0.01 * SR), 0.06)
    m = deck_reflections(m)
    m = dsp.peq(dsp.hp(m, 35, 2), 420, 3.0, 1.2)[:n]
    m = dsp.fade(m, 0.002, 0.0)
    return m


def real_tail():
    """Natural outdoor echo/rumble after a real Phalanx burst (US Navy 'CIWS System firing', PD):
    the burst ends at ~23.88 s; from 24.15 s on only the decaying echo from sea/superstructure remains.
    Denoised with the pre-burst floor (21.0-22.4 s). Decoded in full and sliced (webm seeking is imprecise)."""
    X = dsp.load("usn_ciws.webm", mono=True)
    y = X[int(24.15 * SR):int(27.6 * SR)]
    noise = X[int(21.0 * SR):int(22.4 * SR)]
    y = dsp.spectral_denoise(y, noise, reduction_db=20, oversub=1.6)
    y = dsp.hp(y, 40, 2)
    return y


def build_stop(grains, spin, loop_rms):
    """End of burst: decelerating last rounds, drive spin-down whine and brake clack, then the long
    outdoor echo tail (real, from a Navy recording) + synthetic diffuse sea/sky reverb. ~2.8 s."""
    r = dsp.rng(3)
    n = int(2.9 * SR)
    ivs = [640, 700, 760, 820, 900, 980, 1080, 1200, 1340, 1480]
    times = np.cumsum([0] + ivs) + 40
    gains = np.linspace(1.0, 0.55, len(times))
    lay = build_train(times, grains, r, gains=gains, n=n)
    tt = np.arange(n) / SR
    f_start = round(187 * L / SR) * SR / L
    f0 = f_start * (0.2 + 0.8 * np.exp(-tt / 0.35))
    wenv = np.exp(-tt / 0.5) * np.clip(1 - tt / 1.25, 0, 1)
    whine = motor_whine(n, r, f0) * wenv
    rat = np.zeros(n)
    for _ in range(120):
        pos = int(times[-1] * r.uniform() ** 1.5)
        dsp.mix_at(rat, dsp.modal(300, r.uniform([3000, 5200], [4200, 7600]), [0.0012, 0.0008], [1, .6], r),
                   pos, r.uniform(0.2, 1))
    m = mix_close(lay, whine, rat)
    rumble = dsp.lp(dsp.pink(n, r), 900) * np.exp(-tt / 0.18) * 0.03
    m += rumble
    cn = 6000
    clack = dsp.modal(cn, [140, 520, 1900, 3400], [0.02, 0.008, 0.003, 0.002], [1, .6, .5, .3], r)
    clack += 0.6 * dsp.bp(r.standard_normal(cn), 800, 6000, 2) * np.exp(-np.arange(cn) / (0.004 * SR))
    dsp.mix_at(m, clack, int(0.72 * SR), 0.02)
    m = dsp.peq(deck_reflections(m), 420, 3.0, 1.2)
    # diffuse outdoor reverb of the whole burst: the loop itself (steady state) decaying + the last shots
    ir = dsp.synth_ir(3.0, 2.2, r, stereo=False, hf_damp=1800, lf_cut=45)
    m = dsp.convolve(m, ir * 0.07, wet=1.0, dry=1.0)[:n]
    # energy of the burst that was already "in the air" when firing stopped (reverb of the loop)
    pre = dsp.pad_to(np.tile(LOOP_CACHE["loop"], 2), 2 * L)
    pre_wet = dsp.convolve(pre, ir, wet=1.0, dry=0.0)[2 * L:2 * L + n]
    m += 0.08 * pre_wet
    # real echo tail, placed after the last synthetic round, level re the loop RMS
    rt = real_tail()
    at = int(0.20 * SR)
    rt = dsp.pad_to(rt, n - at)
    rt = dsp.fade(rt, 0.08, 0.6)
    ref = np.sqrt(np.mean(rt[int(0.05 * SR):int(0.15 * SR)] ** 2))
    dsp.mix_at(m, rt * (loop_rms * dsp.db(-11) / ref), at)
    m = dsp.hp(m, 35, 2)
    return dsp.fade(m, 0.0, 0.5)


def build_distant(loop_close_times, grains):
    """Distant perspective (1-3 km): shots lose all top end, the 75 Hz fundamental + low harmonics
    dominate ("BRRRRT" growl), sea-surface reflection comb, long diffuse tail."""
    r = dsp.rng(5)
    times = loop_close_times
    lay = build_train(times, grains, r, n=L)
    base = lay["real"] + 0.25 * lay["gas"] + 0.08 * lay["thump"]
    # Distance filtering (beyond what the engine does, which is a gentle LP): emphasise the low
    # buzz and remove crisp top
    def proc(z):
        z = dsp.lp(z, 1400, 4)
        z = dsp.lp(z, 3500, 2)
        z = dsp.peq(z, 150, 6, 0.8)
        z = dsp.peq(z, 75.5, 5, 2.0)
        # sea-surface reflection: water is a near-rigid reflector for airborne sound -> positive copy
        d = int(0.0065 * SR)
        z2 = z.copy()
        z2[d:] += 0.6 * dsp.lp(z[:-d], 1500, 2)
        return z2
    m = dsp.circular(proc, base)
    # diffuse tail from atmosphere/sea scattering
    ir = dsp.synth_ir(1.4, 1.1, r, stereo=False, hf_damp=1200, lf_cut=40)
    wet = dsp.circular(lambda z: dsp.convolve(z, ir, wet=1.0, dry=0.0)[:len(z)], m, reps=3)
    m = m + 0.55 * wet
    # low rumble bed (turbulent muzzle gas heard far) with slow periodic modulation
    rum = np.fft.irfft(np.fft.rfft(r.standard_normal(L)) * (1 / np.maximum(np.fft.rfftfreq(L, 1 / SR), 20)), L)
    rum = dsp.circular(lambda z: dsp.bp(z, 40, 400, 2), rum)
    rum /= np.std(rum)
    m += 0.08 * np.std(m) * rum
    return dsp.circular(lambda z: dsp.hp(z, 28, 2), m)


def build_servo():
    """Mount slew servo: electric/hydraulic drive whine with gearing texture; seamless 1.0 s loop."""
    r = dsp.rng(7)
    n = SR  # 1.0 s
    t = np.arange(n) / SR
    y = np.zeros(n)
    # motor fundamental and harmonics with integer cycles per loop for seamlessness
    for f, a in [(420, 1.0), (840, 0.55), (1260, 0.3), (1680, 0.2), (2520, 0.12), (3780, 0.06)]:
        fm = f + 3 * np.sin(2 * np.pi * 3 * t)
        y += a * np.sin(2 * np.pi * np.cumsum(fm) / SR + r.uniform(0, 6.28))
    # gear mesh: 28-tooth @ ~ 23.3 rev/s -> 653 Hz buzz, amplitude modulated at shaft rate
    gm = np.sin(2 * np.pi * 653 * t) * (1 + 0.5 * np.sin(2 * np.pi * 23 * t))
    y += 0.25 * np.sign(gm) * np.abs(gm) ** 0.5 * 0.4
    # hydraulic hiss (periodic noise)
    hs = np.fft.irfft(np.fft.rfft(r.standard_normal(n)) * ((np.fft.rfftfreq(n, 1 / SR) > 1500) & (np.fft.rfftfreq(n, 1 / SR) < 9000)), n)
    y += 0.9 * hs / np.std(hs) * 0.12
    y = dsp.circular(lambda z: dsp.peq(dsp.peq(z, 1100, 5, 2), 2900, 4, 3), y)
    y = dsp.circular(lambda z: dsp.hp(z, 120, 2), y)
    return y


LOOP_CACHE = {}


@functools.lru_cache(None)
def build_set():
    """Loop, spin-up and tail share one gain so they splice seamlessly: loop at ~-20 LUFS."""
    grains, spin = extract_grains()
    loop, times = build_loop(grains)
    LOOP_CACHE["loop"] = loop
    start = build_start(grains)
    stop = build_stop(grains, spin, np.sqrt(np.mean(loop ** 2)))
    g = dsp.db(-20 - dsp.lufs(loop))
    g = min(g, dsp.db(-1.5) / np.max(np.abs(loop)))
    loop, start, stop = loop * g, start * g, stop * g
    start = dsp.limiter(start, -1.5) if np.max(np.abs(start)) > dsp.db(-1.5) else start
    stop = dsp.limiter(stop, -1.5) if np.max(np.abs(stop)) > dsp.db(-1.5) else stop
    dist = build_distant(times, grains)
    return loop, start, stop, dist


SRC_CIWS = ("bainbridge.webm (USS Bainbridge CIWS PACFIRE, US Navy, PD): real per-shot grains; "
            "synthesized gas/thump/mechanism/motor layers")


@asset("ciws_fire_loop", loop=True, premastered=True, q=8, source=SRC_CIWS,
       desc="Close (~20 m) CIWS firing at 4,528 rpm: 226 rounds at an exact 636-sample period, seamless 2.995 s loop. "
            "Play ciws_spinup, start this loop exactly at spinup end, stop it and start ciws_tail at the same instant.")
def ciws_fire_loop():
    return build_set()[0]


@asset("ciws_spinup", premastered=True, source=SRC_CIWS,
       desc="Gun drive wind-up (0.14 s) plus the first rounds accelerating to full rate. Ends exactly one shot period "
            "after its last round, so ciws_fire_loop starts at the end of this buffer. Same gain as the loop.")
def ciws_spinup():
    return build_set()[1]


@asset("ciws_tail", premastered=True,
       source=SRC_CIWS + "; usn_ciws.webm (US Navy CIWS System firing, PD): real outdoor echo tail after a burst",
       desc="End of burst: decelerating last rounds, drive spin-down and brake clack, then ~2.5 s of rolling outdoor echo "
            "(real Navy recording + synthetic diffuse reverb). Same gain as the loop.")
def ciws_tail():
    return build_set()[2]


@asset("ciws_distant_loop", loop=True, q=8, source=SRC_CIWS,
       desc="The same burst heard from 1-3 km: top end gone, 75 Hz 'BRRRT' growl and low harmonics, sea-surface "
            "reflection, diffuse echo; 2.995 s seamless loop, phase-compatible with ciws_fire_loop.")
def ciws_distant_loop():
    return build_set()[3]


@asset("ciws_servo", loop=True, q=8, lufs=-24, source="synth",
       desc="(extra) Mount slew servo/hydraulic whine, 1.0 s loop; drive gain and playbackRate (0.8-1.3) from slew rate.")
def ciws_servo():
    return build_servo()
