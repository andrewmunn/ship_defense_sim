"""Ambience loops (stereo, seamless): ocean_loop, hull_wash_loop, wind_loop, ship_engine_loop, fire_loop.

Real CC0 field recordings (Freesound): choppy waves against a ship's bow (tiennotg 551436),
sailing-boat bow wave close (Pfannkuchn 360631), metal barge bow (bruno.auzet 570927), strong wind
(felix.blume 167684, low-passed to remove vegetation rustle), ferry below-deck drone (blaukreuz 398851),
ferry engine room (mrmayo 74915), large fire (theoneandtruelybitch 698209), car fire (florianreichelt 563765),
fire crackling (kingsrow 181562). Layered with synthesized open-sea wave wash, gas-turbine intake whine,
ventilation fans, rigging whistle and buffeting. Loops are made seamless with an equal-power crossfade of
the tail into the head (or are periodic by construction).
"""
import numpy as np
import dsp, synth, bank
from bank import asset, stdn, unit
from dsp import SR


def stereo_of(f, start, dur):
    x = dsp.load(f, start=start, dur=dur)
    x = dsp.pad_to(x, int(dur * SR))
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    return x


def decorrelate(m, r, ms=11.0):
    """Mono -> wide stereo using complementary comb/allpass-ish decorrelation (mono-compatible)."""
    d = int(ms * SR / 1000)
    L = m.copy()
    R = m.copy()
    L[d:] += 0.35 * m[:-d]
    R[d:] -= 0.35 * m[:-d]
    return np.column_stack([L, R])


def wave_wash(n, r, rate=0.35, width=1.0):
    """Open-sea wave wash: overlapping swell 'shhh' events (band noise with slow envelopes, random pan),
    whitecap hiss spikes, and a low swell rumble."""
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    k = 0
    tt = -2.0
    while tt < n / SR:
        tt += r.exponential(1 / rate)
        L = int(r.uniform(3.0, 6.5) * SR)
        s = int(tt * SR)
        if s + L <= 0 or s >= n:
            continue
        seg = dsp.pink(L, r)
        lo, hi = r.uniform(150, 400), r.uniform(2500, 7000)
        seg = dsp.bp(seg, lo, hi, 2)
        a = r.uniform(0.25, 0.45)
        ts = np.arange(L) / SR
        env = (ts / (a * ts[-1])) ** 1.5 * (ts < a * ts[-1]) + np.exp(-(ts - a * ts[-1]) / (0.3 * ts[-1])) * (ts >= a * ts[-1])
        env *= r.uniform(0.3, 1.0)
        # whitecap: short bright hiss burst near the crest
        wc = dsp.hp(r.standard_normal(L), 2500, 2) * np.exp(-((ts - a * ts[-1]) / 0.35) ** 2) * r.uniform(0, 0.6)
        seg = seg * env + wc * env
        p = r.uniform(-1, 1) * width
        gl, gr = np.sqrt(0.5 * (1 - p)), np.sqrt(0.5 * (1 + p))
        a0, a1 = max(0, s), min(n, s + L)
        out[a0:a1, 0] += gl * seg[a0 - s:a1 - s]
        out[a0:a1, 1] += gr * seg[a0 - s:a1 - s]
        k += 1
    swell = dsp.lp(dsp.brown(n, r), 160, 2) * dsp.smooth_random(n, r, 0.25, 0.4, 1.0)
    out += 0.5 * np.column_stack([swell, np.roll(swell, int(0.3 * SR))])
    return out


def wind_synth(n, r, strength=1.0, whistle=0.3, buffet=0.5):
    t = np.arange(n) / SR
    gust = dsp.smooth_random(n, r, 0.35, 0.35, 1.0) * dsp.smooth_random(n, r, 1.7, 0.75, 1.1)
    out = np.zeros((n, 2))
    for c in range(2):
        g = np.roll(gust, int(c * 0.37 * SR))
        body = dsp.bp(dsp.pink(n, r), 80, 2500, 2) * g
        # gust-dependent brightness
        hiss = dsp.hp(dsp.pink(n, r), 2000, 2) * g ** 2
        # rigging/antenna whistles: narrow resonances whose pitch follows the gust
        wh = np.zeros(n)
        for f0 in r.uniform(500, 1600, 3):
            fc = f0 * (0.8 + 0.4 * g)
            wh += dsp.tv_bandpass_fast(r.standard_normal(n), fc, q=60, block=256)
        wh = wh / (np.std(wh) + 1e-9) * g ** 3
        # low buffeting / turbulence on the listener
        buf = dsp.lp(dsp.brown(n, r), 90, 2) * dsp.smooth_random(n, r, 4, 0, 1) ** 2 * g
        out[:, c] = strength * (0.6 * body + 0.25 * hiss) + whistle * 0.08 * wh + buffet * 0.5 * buf / (np.std(buf) + 1e-9)
    return out


# ----------------------------------------------------------------------------- builders
def looped_layer(f, start, seg, n, xf=1.5, roll=0.0):
    """Stereo layer of period `seg` s from a recording (crossfaded loop), tiled to n samples; R channel
    offset by `roll` s for width (still periodic)."""
    x = stereo_of(f, start, seg + xf)
    x = dsp.make_loop(x, xf)
    P = x.shape[0]
    reps = int(np.ceil(n / P)) + 1
    t = np.concatenate([x] * reps, axis=0)
    k = int(roll * SR)
    return np.column_stack([t[:n, 0], t[k:k + n, 1]])


@asset("ocean_loop", loop=True, q=4,
       source="synth open-sea wave wash + Freesound 551436 (waves against a ship's bow), 167684 (wind, low-passed) (CC0)",
       desc="Open-ocean waves heard from the deck: irregular swell wash, whitecap hiss, low swell rumble, a little "
            "slap against the hull; stereo 40 s seamless loop.")
def ocean_loop():
    r = dsp.rng(201)
    D, X = 40.0, 4.0
    n = int((D + X) * SR)
    ww = wave_wash(n, r, rate=0.45)
    ww /= np.std(ww)
    bow = dsp.make_loop(stereo_of("freesound/fs_551436.ogg", 0.0, 21.5), 1.5)       # 20 s period
    bow = np.concatenate([bow] * 3, axis=0)
    bow = np.column_stack([bow[:n, 0], bow[int(9.3 * SR):int(9.3 * SR) + n, 1]])
    bow = dsp.hp(bow, 150, 2)
    bow /= np.std(bow)
    wind_real = dsp.lp(stereo_of("freesound/fs_167684.ogg", 20.0, D + X), 1400, 4)
    wind_real /= np.std(wind_real)
    y = 1.0 * ww + 0.35 * bow + 0.25 * wind_real
    y = dsp.hp(y, 25, 2)
    y = dsp.make_loop(y, X)
    # make the bow layer (period 20 s) wrap cleanly as well: 40 s = 2 periods -> nothing else to do
    return y


@asset("hull_wash_loop", loop=True, q=4,
       source="Freesound 360631 (bow wave, close), 570927 (metal barge bow) (CC0) + synth low rush",
       desc="Water rushing along a steel hull at 15-20 kt heard from the deck edge: continuous wash, gurgle and "
            "slap, low rush; stereo 30 s seamless loop.")
def hull_wash_loop():
    r = dsp.rng(204)
    D, X = 30.0, 3.0
    n = int((D + X) * SR)
    a = stereo_of("freesound/fs_360631.ogg", 20.0, D + X)
    b = stereo_of("freesound/fs_570927.ogg", 5.0, D + X)
    a, b = a / np.std(a), b / np.std(b)
    low = dsp.lp(dsp.brown(n, r), 220, 2) * dsp.smooth_random(n, r, 0.6, 0.5, 1.1)
    low = bank.widen(low / np.std(low), r)
    hiss = dsp.bp(dsp.pink(n, r), 1500, 9000, 2) * dsp.smooth_random(n, r, 1.3, 0.4, 1.0)
    hiss = bank.widen(hiss / np.std(hiss), r, ms=(5.1, 8.7))
    y = 1.0 * a + 0.55 * b + 0.4 * low + 0.15 * hiss
    y = dsp.hp(y, 25, 2)
    return dsp.make_loop(y, X)


@asset("wind_loop", loop=True, q=4, source="synth gusts/whistle/buffeting + Freesound 167684 (strong wind, CC0)",
       desc="Strong sea wind on deck: gusting body, rigging/antenna whistles following the gusts, low buffeting; "
            "stereo 30 s seamless loop.")
def wind_loop():
    r = dsp.rng(203)
    D, X = 30.0, 3.0
    n = int((D + X) * SR)
    ws = wind_synth(n, r, strength=1.0, whistle=0.6, buffet=1.0)
    ws /= np.std(ws)
    real = dsp.lp(stereo_of("freesound/fs_167684.ogg", 90.0, D + X), 1800, 4)
    real /= np.std(real)
    y = 0.8 * ws + 0.5 * real
    y = dsp.hp(y, 20, 2)
    return dsp.make_loop(y, X)


@asset("ship_engine_loop", loop=True, q=4,
       source="synth gas-turbine roar/whine, vent fans, 60 Hz hum, hull ticks + Freesound 398851, 74915 (ferry "
              "below-deck / engine room, CC0) low-passed",
       desc="Warship machinery heard on deck: gas turbine intake/uptake roar and compressor whine, ventilation fans, "
            "electrical hum, drone through the deck; stereo 30 s seamless loop.")
def ship_engine_loop():
    r = dsp.rng(202)
    D, X = 30.0, 3.0
    n = int((D + X) * SR)
    t = np.arange(n) / SR
    gt = dsp.bp(dsp.pink(n, r), 90, 6000, 2)
    gt = dsp.peq(gt, 600, 4, 0.8)
    wh = np.zeros(n)
    for f0, a in [(2890, 1.0), (5780, 0.4), (3610, 0.35), (1445, 0.2)]:
        fm = f0 * (1 + 0.0015 * dsp.smooth_random(n, r, 0.2, -1, 1))
        wh += a * np.sin(2 * np.pi * np.cumsum(fm) / SR + r.uniform(0, 6.28))
    fan = dsp.bp(r.standard_normal(n), 200, 5000, 2) * 0.6
    for f0 in [147.0, 151.3]:
        for h, a in [(1, 1.0), (2, 0.5), (3, 0.25)]:
            fan += 0.5 * a * np.sin(2 * np.pi * f0 * h * t + r.uniform(0, 6.28))
    hum = sum(a * np.sin(2 * np.pi * 60 * h * t) for h, a in [(1, 1.0), (2, 0.35), (3, 0.5), (5, 0.15)])
    drone = dsp.lp(stereo_of("freesound/fs_398851.ogg", 10.0, D + X), 250, 4)
    drone /= np.std(drone)
    er = dsp.lp(stereo_of("freesound/fs_74915.ogg", 5.0, D + X), 700, 4)
    er /= np.std(er)
    ticks = np.zeros(n)
    for _ in range(9):
        h = synth.metal_hit(r, dur=0.5, size=r.uniform(0.3, 0.8), damp=0.3)
        dsp.mix_at(ticks, h / np.max(np.abs(h)), int(r.uniform(0.5, D + X - 0.6) * SR), r.uniform(0.02, 0.05))
    mono_mech = 0.55 * gt / np.std(gt) + 0.10 * wh + 0.30 * fan / np.std(fan) + 0.06 * hum
    y = decorrelate(mono_mech, r, 13) + 0.4 * drone + 0.3 * er + decorrelate(ticks, r, 7)
    y = dsp.hp(y, 25, 2)
    y = dsp.shelf(y, 5000, -6, high=True)
    return dsp.make_loop(y, X)


@asset("fire_loop", loop=True, q=4,
       source="Freesound 698209 (large fire roar), 563765 (car fire), 181562 (crackling) (CC0) + synth low roar",
       desc="Large fire burning on deck: roaring flames, hiss, crackle and pops, low breathing roar; stereo 30 s seamless loop.")
def fire_loop():
    r = dsp.rng(99)
    D, X = 30.0, 3.0
    n = int((D + X) * SR)
    a = stereo_of("freesound/fs_698209.ogg", 60.0, D + X)
    b = looped_layer("freesound/fs_563765.ogg", 0.5, 15.0, n, xf=1.5, roll=5.0)
    c = stereo_of("freesound/fs_181562.ogg", 40.0, D + X)
    a, b, c = a / np.std(a), b / np.std(b), c / np.std(c)
    y = 1.0 * a + 0.35 * dsp.hp(b, 400, 2) + 0.3 * dsp.hp(c, 800, 2)
    low = dsp.lp(dsp.brown(n, r), 120, 2) * dsp.smooth_random(n, r, 0.8, 0.5, 1.2)
    y += 0.35 * bank.widen(low / np.std(low), r)
    y = dsp.hp(y, 30, 2)
    y = dsp.lp(y, 15500, 4)                                # 17.6 kHz whistle in the fire recording
    y = dsp.peq(dsp.peq(y, 2150, -8, 6), 2285, -8, 6)      # faint tonal whistles
    return dsp.make_loop(y, X)
