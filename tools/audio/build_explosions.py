"""Explosions, impacts & water: explosion_near_1..3, explosion_far_1..2, explosion_air_1..2, explosion_ship_hit,
splash_big, splash_small_1..3, debris_metal_1..3, metal_groan_1..2.

Synthesized blast cores (shock, pressure thump, fireball roar, rumble, crackle) layered with real CC0
recordings: real explosions (The_Sound_Side 262436, tommccann 235968), distant explosions (Kostrava 320788,
Johnnyfarmer 209769), thunder (Dave Welsh 194364), metal impacts (Nox_Sound 569555), metal groan
(hinchinbrook 496836), shed-door clangs/rattle (EpicWizard 264889), debris crash (xkeril 703247),
stone/debris falls (Nox_Sound 550342), dive splash (bruno.auzet 529794), big splashes (qubodup 442773,
Bird_man 316744), stone splashes (vibe_crc 50623), steel girders tearing (craigsmith 675486),
bending metal (NachtmahrTV 556714), large fire (theoneandtruelybitch 698209).
"""
import functools
import numpy as np
import dsp, synth, bank
from bank import asset, variants, unit, stdn, env_points
from dsp import SR


def grab(f, t, pre=0.02, dur=1.0, mono=True):
    """Load an event around time t (s): find actual onset near t and return from onset-pre."""
    x = dsp.load(f, start=max(0, t - 0.4), dur=dur + 0.8, mono=True)
    e = np.abs(x)
    s = int(0.4 * SR) if t >= 0.4 else int(t * SR)
    w = e[max(0, s - int(0.3 * SR)): s + int(0.3 * SR)]
    thr = 0.15 * np.max(w)
    on = max(0, s - int(0.3 * SR)) + int(np.argmax(w > thr))
    y = x[max(0, on - int(pre * SR)): max(0, on - int(pre * SR)) + int(dur * SR)]
    return dsp.fade(y, 0.001, min(0.2, dur / 4))


@functools.lru_cache(None)
def metal_hits():
    times = [0.03, 3.19, 6.16, 8.63, 11.1, 13.9, 16.3, 17.74, 20.67, 23.57, 26.75, 30.73, 33.76, 35.94, 38.21]
    return [grab("freesound/fs_569555.ogg", t, 0.005, 2.4) for t in times]


def tear(r, dur=2.5, f_lo=90, f_hi=900):
    """Synthetic metal tearing/shearing: stick-slip impulse train with jittered rate driving a bank of
    plate resonances, plus the real groaning hinge (pitched down) for organic character."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    rate = dsp.smooth_random(n, r, 5, f_lo, f_hi)
    ph = np.cumsum(rate / SR)
    imp = np.zeros(n)
    idx = np.nonzero(np.diff(np.floor(ph)) > 0)[0]
    imp[idx] = r.uniform(0.3, 1.0, len(idx)) * (r.uniform(size=len(idx)) > 0.15)
    exc = imp + 0.08 * r.standard_normal(n) * dsp.smooth_random(n, r, 12, 0, 1)
    y = np.zeros(n)
    for f0 in r.uniform(300, 4500, 14):
        y += dsp.reson(exc, f0, r.uniform(15, 60)) * r.uniform(0.3, 1)
    y = dsp.bp(y, 150, 8000, 2)
    env = dsp.smooth_random(n, r, 3, 0.2, 1.0) * np.minimum(1, t / 0.05) * np.minimum(1, (dur - t) / 0.4)
    y *= env
    groan = dsp.load("freesound/fs_496836.ogg", start=0.5, dur=dur * 1.6, mono=True)
    groan = dsp.resample(groan, 0.62)[:n]
    groan = dsp.pad_to(groan, n)
    return y / np.max(np.abs(y)) + 0.8 * groan / (np.max(np.abs(groan)) + 1e-9) * env


def frag_whizz(r, n, count=30, t_max=0.35):
    """Fragments & debris zipping past: short band-passed noise chirps with doppler down-sweep."""
    y = np.zeros(n)
    for _ in range(count):
        L = int(r.uniform(0.02, 0.08) * SR)
        s = int(r.uniform(0.005, t_max) * SR)
        if s + L >= n:
            continue
        tt = np.arange(L) / SR
        fc = r.uniform(2500, 7000) * (1 - 0.4 * tt / tt[-1])
        z = dsp.tv_bandpass_fast(r.standard_normal(L), fc, q=4, block=32)
        env = np.sin(np.pi * tt / tt[-1]) ** 2
        y[s:s + L] += z * env * r.uniform(0.2, 1.0)
    return y


# ----------------------------------------------------------------------------- ship hit
def explosion_ship_hit():
    r = dsp.rng(83)
    dur = 9.0
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    # main warhead detonation (large, 150-250 kg HE) + penetration crunch just before
    crunch = synth.metal_hit(r, dur=0.6, size=2.5, damp=0.2) + 0.5 * dsp.bp(r.standard_normal(int(0.6 * SR)), 300, 6000, 2) * np.exp(-np.arange(int(0.6 * SR)) / (0.02 * SR))
    dsp.mix_at(y, crunch / np.max(np.abs(crunch)), 0, 0.25)
    main = synth.blast(r, dur, size=1.3, crack=1.0, thump=1.3, roar=1.1, rumble=1.3, crackle=1.0,
                       roar_tau=0.18, rumble_tau=1.3, lf_hz=36, bright=1.0)
    dsp.mix_at(y, main, int(0.035 * SR), 1.0)
    # hull resonance: steel hull/superstructure ringing modes excited by the blast
    hull = dsp.modal(n, [41, 67, 103, 138, 212, 287], [0.9, 0.6, 0.45, 0.35, 0.25, 0.2], [1, .8, .6, .5, .35, .25], r)
    hull *= np.minimum(1, t / 0.01)
    dsp.mix_at(y, hull / np.max(np.abs(hull)), int(0.035 * SR), 0.18)
    # metal tearing (plates shearing) 0.15..3 s
    tr = tear(r, 2.8)
    dsp.mix_at(y, tr, int(0.15 * SR), 0.22)
    # real debris crash & falling stones/metal
    deb = dsp.load("freesound/fs_703247.ogg", mono=True)
    dsp.mix_at(y, dsp.resample(deb, 0.8) / np.max(np.abs(deb)), int(0.25 * SR), 0.3)
    fall = dsp.load("freesound/fs_550342.ogg", start=0.0, dur=6.0, mono=True)
    dsp.mix_at(y, fall / np.max(np.abs(fall)), int(1.4 * SR), 0.12)
    # individual metal debris landing on deck (real contact-mic impacts, pitched down, randomised)
    hits = metal_hits()
    for k in range(14):
        h = hits[r.integers(len(hits))]
        h = dsp.resample(h, r.uniform(0.55, 0.95))
        tt = 0.5 + r.gamma(2.0, 0.6)
        if tt < dur - 1.0:
            dsp.mix_at(y, h / np.max(np.abs(h)), int(tt * SR), r.uniform(0.04, 0.14) * np.exp(-tt / 3))
    # secondary cook-off explosions (fuel/ammo)
    for (tt, sz, g) in [(1.7, 0.35, 0.3), (2.9, 0.25, 0.18), (4.6, 0.3, 0.14)]:
        b = synth.blast(r, 3.0, size=sz, crack=0.8, thump=0.8, roar=0.9, rumble=0.6, crackle=0.8, lf_hz=50)
        dsp.mix_at(y, b, int(tt * SR), g)
    # fireball whoosh
    fire = dsp.pad_to(dsp.load("freesound/fs_698209.ogg", start=40.0, dur=dur, mono=True), n)
    fenv = np.minimum(1, t / 0.3) * np.exp(-t / 3.5)
    y += 0.10 * fire / np.max(np.abs(fire)) * fenv
    y = synth.sea_reflection(y, 12.0, 0.4, 1500)
    ir = dsp.synth_ir(3.0, 2.0, r, stereo=False, hf_damp=2000, lf_cut=30)
    y = dsp.convolve(y, ir, wet=0.08, dry=1.0)[:n]
    y = dsp.sat(y / np.max(np.abs(y)) * 1.3, 1.1)
    return dsp.fade(dsp.hp(y, 18, 2), 0, 1.5)


# ----------------------------------------------------------------------------- water
def splash_small(i):
    """Rounds/fragments hitting the water: sharp entry 'tsip' + small spout; 4 variations."""
    r = dsp.rng(90 + i)
    ev = [0.19, 1.84, 4.33, 5.5, 7.3, 8.78, 10.08, 12.12]
    real = grab("freesound/fs_50623.ogg", ev[(2 * i) % len(ev)], 0.003, 0.9)
    real2 = grab("freesound/fs_50623.ogg", ev[(2 * i + 5) % len(ev)], 0.003, 0.9)
    real = dsp.resample(real, [0.8, 0.95, 0.72, 0.88][i])
    real2 = dsp.resample(real2, [1.1, 0.8, 1.0, 0.7][i])

    def to_onset(z):   # start each layer at its first strong transient (grab() can leave a soft pre-splash)
        k = int(np.argmax(np.abs(z) > 0.3 * np.max(np.abs(z))))
        return z[max(0, k - int(0.002 * SR)):]
    real, real2 = to_onset(real), to_onset(real2)
    n = int(1.0 * SR)
    y = np.zeros(n)
    snap = dsp.hp(r.standard_normal(600), 2500, 2) * np.exp(-np.arange(600) / 60)
    dsp.mix_at(y, snap, 0, 0.35)
    dsp.mix_at(y, real / np.max(np.abs(real)), int(0.002 * SR), 1.0)
    dsp.mix_at(y, real2 / np.max(np.abs(real2)), int(r.uniform(0.01, 0.05) * SR), 0.3)
    sp = synth.water_splash(r, dur=0.9, size=0.3, bright=1.2)
    dsp.mix_at(y, sp / np.max(np.abs(sp)), 0, 0.25)
    e = np.abs(y) > 0.001 * np.max(np.abs(y))
    last = len(e) - np.argmax(e[::-1])
    y = y[: min(n, last + 200)]
    return dsp.fade(dsp.hp(y, 60, 2), 0, 0.15)


def debris_metal(i):
    r = dsp.rng(95 + i)
    hits = metal_hits()
    picks = [(0, 0.8, [(5, 0.18, 0.5), (9, 0.33, 0.25)]),
             (8, 0.7, [(2, 0.12, 0.4), (12, 0.29, 0.3), (6, 0.45, 0.15)]),
             (10, 0.9, [(3, 0.09, 0.35)])][i]
    main, rate, extra = picks
    y = dsp.resample(hits[main], rate)
    y = dsp.pad_to(y / np.max(np.abs(y)), int(2.4 * SR))
    for (k, dt, g) in extra:  # bounces / secondary pieces
        h = dsp.resample(hits[k], rate * r.uniform(1.05, 1.4))
        dsp.mix_at(y, h / np.max(np.abs(h)), int(dt * SR), g)
    # small rattle of fragments
    rat = dsp.load("freesound/fs_264889.ogg", start=[3.0, 8.2, 20.2][i], dur=1.2, mono=True)
    dsp.mix_at(y, dsp.fade(rat, 0.005, 0.4) / np.max(np.abs(rat)), int(0.05 * SR), 0.12)
    return dsp.fade(dsp.hp(y, 40, 2), 0, 0.5)




# ----------------------------------------------------------------------------- registry: ship hit / debris / splashes
@asset("explosion_ship_hit", source="synth blast/hull modes/tearing + Freesound 703247, 550342, 569555, 496836, 698209, "
       "262436 (CC0)",
       desc="Anti-ship missile warhead hitting our own ship: penetration crunch, huge detonation, hull ringing, "
            "tearing plates, debris raining on deck, secondary cook-offs and fireball; ~9 s.", tail_db=-58)
def _ship_hit():
    y = explosion_ship_hit()
    # add real explosion body (fireball roar) under the synthetic core
    X = dsp.load("freesound/fs_262436.ogg", mono=True)
    real = dsp.fade(X[int(3.86 * SR):int(10.5 * SR)], 0.002, 1.5)
    dsp.mix_at(y, unit(dsp.lp(real, 6000, 2)) * np.max(np.abs(y)), int(0.035 * SR), 0.45)
    return y


@variants("splash_small", 3, source="Freesound 50623 (CC0) stone splashes + synth bubbles/spray",
          desc="A round or fragment hitting the water: sharp entry 'tsip', small spout, droplets; ~1 s.", tail_db=-55)
def _splash_small(i):
    return splash_small(i - 1)


@variants("debris_metal", 3, source="Freesound 569555, 264889 (CC0) metal impacts/rattle, pitched & layered",
          desc="Fragments/debris hitting steel deck and superstructure: clang, bounces, small rattle; ~2 s.", tail_db=-55)
def _debris(i):
    return debris_metal(i - 1)


# ----------------------------------------------------------------------------- near explosions (100-500 m)
NEAR = {1: dict(src="freesound/fs_235968.ogg", on=0.39, ln=6.5, lp=4000, g=0.55, size=0.85, lf=40, dist=250),
        2: dict(src="freesound/fs_262436.ogg", on=3.86, ln=6.0, lp=9000, g=0.8, size=0.75, lf=44, dist=150),
        3: dict(src="freesound/fs_262436.ogg", on=1.33, ln=2.5, lp=9000, g=0.7, size=0.8, lf=38, dist=400)}


def fragment_rain(r, n, t0=0.6, count=90, spread=1.6):
    """Warhead fragments falling into the sea around the burst point (distant, soft 'tsip' patter)."""
    y = np.zeros(n)
    for _ in range(count):
        s = int((t0 + r.gamma(2.0, spread / 2)) * SR)
        L = int(0.05 * SR)
        if s + L >= n:
            continue
        tt = np.arange(L) / SR
        k = dsp.bp(r.standard_normal(L), 900, 5000, 2) * np.exp(-tt / r.uniform(0.008, 0.02)) * np.minimum(1, tt / 0.002)
        y[s:s + L] += k * r.uniform(0.1, 1.0) ** 2
    return dsp.lp(y, 3500, 2)


def explosion_near(i):
    p = NEAR[i]
    r = dsp.rng(700 + i)
    dur = 6.0
    n = int(dur * SR)
    t = np.arange(n) / SR
    X = dsp.load(p["src"], mono=True)
    real = X[int((p["on"] - 0.003) * SR):int((p["on"] + p["ln"]) * SR)]
    real = dsp.fade(real, 0.001, min(1.2, p["ln"] * 0.4))
    real = dsp.lp(dsp.hp(real, 35, 2), p["lp"], 2)
    real = dsp.pad_to(real, n)
    b = synth.blast(r, dur, size=p["size"], crack=1.0, thump=1.1, roar=0.9, rumble=1.5, crackle=0.7,
                    roar_tau=0.14, rumble_tau=1.3, lf_hz=p["lf"], bright=1.0)
    # propagation over p["dist"] m: soften the very top of the synthetic crack
    b = dsp.lp(b, 16000 * (100 / p["dist"]) ** 0.35, 2)
    y = unit(b) + p["g"] * unit(real)
    y += 0.08 * frag_whizz(r, n, 25, 0.5)
    y += 0.035 * unit(fragment_rain(r, n, t0=0.8 + p["dist"] / 800, count=70))
    # sea-surface reflection and rolling echo off the sea/sky + other ships
    y = synth.sea_reflection(y, 4.0 + p["dist"] / 40, 0.5, 2500)
    y = synth.rolling_tail(y, r, rolls=6, spread=2.8, lp_hz=380, gain=0.35)
    ir = dsp.synth_ir(4.0, 3.0, r, stereo=False, hf_damp=1200, lf_cut=28)
    y = dsp.convolve(y, ir, wet=0.2, dry=1.0)[:n]
    y = dsp.compress(unit(y), thresh_db=-15, ratio=2.5, attack=0.003, release=0.35)
    y = dsp.sat(unit(y) * 1.3, 1.1)
    return dsp.hp(y, 18, 2)


@variants("explosion_near", 3, source="Freesound 235968 / 262436 (CC0) real explosions + synth blast, fragment whizz, "
          "fragments splashing into the sea, rolling tail, synthetic outdoor IR",
          desc="Warhead detonation 100-500 m away: crack, fireball body, fragments whizzing and splashing, rolling tail; "
               "~5-6 s.", tail_db=-58)
def _near(i):
    return explosion_near(i)


# ----------------------------------------------------------------------------- far explosions (5-20 km)
FAR = {1: ("freesound/fs_320788.ogg", 42.13, 8.0), 2: ("freesound/fs_320788.ogg", 34.76, 7.0)}


def explosion_far(i):
    f, on, ln = FAR[i]
    r = dsp.rng(720 + i)
    n = int(7.5 * SR)
    X = dsp.load(f, mono=True)
    real = X[int((on - 0.01) * SR):int((on + ln) * SR)]
    real = dsp.fade(real, 0.005, 2.0)
    real = dsp.pad_to(dsp.hp(real, 22, 2), n)
    b = synth.blast(r, 7.5, size=1.6, crack=0.4, thump=1.3, roar=0.4, rumble=1.2, crackle=0.0,
                    roar_tau=0.12, rumble_tau=1.2, lf_hz=30, bright=0.3)
    b = dsp.lp(dsp.lp(b, 400, 4), 900, 2)
    b = synth.rolling_tail(b, r, rolls=7, spread=4.0, lp_hz=220, gain=0.45)
    y = unit(real) + 0.55 * unit(b)
    y *= dsp.smooth_random(n, r, 1.5, 0.85, 1.1)
    ir = dsp.synth_ir(5.0, 3.8, r, stereo=False, hf_damp=700, lf_cut=22)
    y = dsp.convolve(y, ir, wet=0.25, dry=1.0)[:n]
    return dsp.hp(dsp.lp(y, 2500, 2), 16, 2)


@variants("explosion_far", 2, source="Freesound 320788 (Kostrava, distant explosions, CC0) + synth sub boom/rolling tail",
          desc="Explosion 5-20 km away: deep dull boom, low rolling rumble, no high end; ~7 s.", tail_db=-55)
def _far(i):
    return explosion_far(i)


# ----------------------------------------------------------------------------- airbursts
def explosion_air(i):
    """Proximity-fuzed interceptor warhead bursting in the air (a few hundred m): very sharp crack (no ground
    to absorb), fragment ring, then rolling thunder as the blast echoes between sea and sky."""
    r = dsp.rng(740 + i)
    dur = 7.0
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    crack = synth.blast(r, 2.0, size=0.35, crack=1.4, thump=0.6, roar=0.5, rumble=0.3, crackle=0.2,
                        roar_tau=0.05, rumble_tau=0.3, lf_hz=60, bright=1.6)
    dsp.mix_at(y, unit(crack), 0, 1.0)
    X = dsp.load("freesound/fs_194364.ogg", mono=True)
    th = X[int([16.9, 19.5][i - 1] * SR):int(([16.9, 19.5][i - 1] + dur) * SR)]
    th = dsp.pad_to(dsp.fade(dsp.hp(th, 25, 2), 0.25, 2.0), n)
    th *= env_points(n, [(0, 0.0), (0.08, 0.6), (0.5, 1.0), (dur, 1.0)])
    y += [0.32, 0.28][i - 1] * unit(th)
    # synthetic roll: delayed smeared copies of the burst
    body = synth.blast(r, dur, size=1.1, crack=0.0, thump=0.8, roar=0.5, rumble=1.4, crackle=0.3,
                       roar_tau=0.15, rumble_tau=1.6, lf_hz=36, bright=0.6)
    y += 0.22 * unit(synth.rolling_tail(dsp.lp(body, 1500, 2), r, rolls=8, spread=4.0, lp_hz=300, gain=0.6))
    y += 0.06 * frag_whizz(r, n, 18, 0.4)
    ir = dsp.synth_ir(5.0, 3.5, r, stereo=False, hf_damp=900, lf_cut=25)
    y = dsp.convolve(y, ir, wet=0.2, dry=1.0)[:n]
    return dsp.hp(y, 18, 2)


@variants("explosion_air", 2, source="synth crack/body/rolling tail + Freesound 194364 (thunder, Dave Welsh, CC0)",
          desc="Proximity-fuzed airburst of an interceptor warhead a few hundred m up: very sharp crack, then rolling "
               "thunder-like echo; ~6-7 s.", tail_db=-55)
def _air(i):
    return explosion_air(i)


# ----------------------------------------------------------------------------- big splash
@asset("splash_big", source="Freesound 442773, 316744, 529794 (CC0) splashes + synth impact thump, bubbles, fall-back",
       desc="A missile or large piece of wreckage slamming into the sea: heavy slap/thump, water sheet and spray, "
            "column collapsing back as a downpour; ~4 s.", tail_db=-55)
def splash_big():
    r = dsp.rng(85)
    dur = 4.5
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    thump = dsp.lp(synth.blast(r, 1.5, size=0.7, crack=0.3, thump=1.6, roar=0.3, rumble=0.8, crackle=0.0, lf_hz=42), 1200, 2)
    dsp.mix_at(y, unit(thump), 0, 1.1)
    a = dsp.load("freesound/fs_442773.ogg", mono=True)
    b = dsp.load("freesound/fs_316744.ogg", mono=True)
    dsp.mix_at(y, unit(dsp.resample(a, 0.7)), int(0.004 * SR), 0.8)
    dsp.mix_at(y, unit(dsp.resample(b[: int(0.85 * SR)], 0.6)), int(0.01 * SR), 0.5)
    dive = dsp.load("freesound/fs_529794.ogg", start=0.1, dur=3.0, mono=True)
    dive = dsp.spectral_denoise(dive, dsp.load("freesound/fs_529794.ogg", start=9.5, dur=1.0, mono=True), 30, 2.5)
    dsp.mix_at(y, unit(dsp.fade(dsp.resample(dive, 0.55), 0, 0.8)), int(0.02 * SR), 0.45)
    sp = synth.water_splash(r, dur=4.0, size=2.5, bright=0.9)
    dsp.mix_at(y, unit(sp), 0, 0.3)
    rain_env = np.clip((t - 1.0) / 0.6, 0, 1) * np.exp(-np.maximum(t - 1.8, 0) / 0.9)
    patter = np.zeros(n)
    for k in np.nonzero(r.uniform(size=n) < 1800 / SR * rain_env)[0]:
        if k + 240 < n:
            patter[k:k + 240] += r.standard_normal(240) * np.exp(-np.arange(240) / r.uniform(8, 40)) * r.uniform(0.1, 1)
    y += 0.3 * unit(dsp.bp(patter, 500, 11000, 2))
    ir = dsp.synth_ir(2.0, 1.5, r, stereo=False, hf_damp=2500, lf_cut=40)
    y = dsp.convolve(y, ir, wet=0.1, dry=1.0)[:n]
    return dsp.hp(y, 22, 2)


# ----------------------------------------------------------------------------- hull groans
def metal_groan(i):
    """Deep structural stress of a sinking/breaking hull: real steel creaks & groans pitched down an octave+,
    stick-slip tearing, low hull resonances, heard through a large steel structure (dark reverb)."""
    r = dsp.rng(760 + i)
    dur = 7.0
    n = int(dur * SR)
    t = np.arange(n) / SR
    if i == 1:
        g = dsp.load("freesound/fs_675486.ogg", start=4.0, dur=5.0, mono=True)
        g2 = dsp.load("freesound/fs_496836.ogg", start=0.3, dur=4.5, mono=True)
    else:
        g = dsp.load("freesound/fs_675486.ogg", start=24.0, dur=5.0, mono=True)
        g2 = dsp.load("freesound/fs_556714.ogg", start=0.0, dur=4.5, mono=True)
    a = dsp.pad_to(dsp.resample(g, [0.55, 0.48][i - 1]), n)
    b = dsp.pad_to(dsp.resample(g2, [0.5, 0.42][i - 1]), n)
    y = unit(a) + 0.7 * unit(b)
    # low hull modes excited by the stress (slowly swelling)
    ex = dsp.lp(r.standard_normal(n), 300, 2) * dsp.smooth_random(n, r, 2.0, 0, 1) ** 2
    hull = sum(dsp.reson(ex, f0, 40) * w for f0, w in [(38, 1.0), (57, 0.7), (83, 0.5), (121, 0.35)])
    y += 0.5 * unit(hull)
    y *= env_points(n, [(0, 0), (0.4, 1.0), (dur - 1.5, 0.9), (dur, 0.0)])
    y = dsp.lp(y, 5000, 2)
    ir = dsp.synth_ir(3.0, 2.2, r, stereo=False, hf_damp=1200, lf_cut=30)
    y = dsp.convolve(y, ir, wet=0.3, dry=1.0)[:n]
    return dsp.hp(y, 22, 2)


@variants("metal_groan", 2, trim=False, source="Freesound 675486, 496836, 556714 (CC0) pitched down + synth hull resonances",
          desc="Deep structural groan/creak of a stressed, sinking hull; ~7 s, soft attack (ambient one-shot).", tail_db=-55)
def _groan(i):
    return metal_groan(i)
