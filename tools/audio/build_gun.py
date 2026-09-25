"""5-inch deck gun: gun_5in_1..3 (close, on/near own ship) and gun_5in_distant (5-20 km).

Hybrid. The DVIDS camera recordings of real Mk 45 shots (public domain) are limited by the camera
(AGC/limiter) and have almost nothing below ~300 Hz, so the first ~150 ms (shock front, gas-expansion
pressure thump, sub bloom) is synthesized, while the real recording supplies the mid/high texture of
the report, the natural outdoor decay and mechanical noises of the mount. A synthetic open-sea
impulse response (sea-surface reflection + long low diffuse tail) extends the reverb over the water.
"""
import numpy as np
import dsp, synth, bank
from bank import variants, asset
from dsp import SR

# (file, onset s, usable length s) - onsets measured on the full decode (see tools/audio notes)
SHOTS = {1: ("dvids_937504.mp4", 7.719, 3.30),
         2: ("dvids_836211.mp4", 1.527, 3.30),
         3: ("dvids_836211.mp4", 11.672, 3.35)}


def real_shot(i):
    f, on, ln = SHOTS[i]
    X = dsp.load(f, mono=True)
    noise = X[int((on - 0.35) * SR):int((on - 0.03) * SR)]
    x = X[int((on - 0.002) * SR):int((on + ln) * SR)]
    x = dsp.spectral_denoise(x, noise, reduction_db=14, oversub=1.4)
    return dsp.fade(x, 0.001, 0.4)


def close_shot(i):
    r = dsp.rng(540 + i)
    real = real_shot(i)
    dur = 3.4
    n = int(dur * SR)
    real = dsp.pad_to(real, n)
    t = np.arange(n) / SR
    size = [0.9, 0.95, 0.85][i - 1]
    b = synth.blast(r, dur=dur, size=size, crack=1.0, thump=0.9, roar=0.8, rumble=0.9, crackle=0.0,
                    roar_tau=0.07, rumble_tau=0.55, lf_hz=[38, 35, 41][i - 1], bright=1.0)
    b = synth.sea_reflection(b, [9.0, 11.5, 7.5][i - 1], 0.6, 2500)
    b = dsp.sat(b * 1.3, 1.2)
    # real report tucked under the synthetic onset for the first 100 ms, then carries body/tail
    g_real = np.where(t < 0.10, 0.4 + 0.6 * (t / 0.10) ** 2, 1.0)
    real_eq = dsp.shelf(dsp.hp(real, 120, 2), 250, 6, high=False)
    real_eq = dsp.peq(real_eq, 3500, -3, 0.8)
    y = bank.unit(b) + 0.85 * g_real * bank.unit(real_eq)
    # spent case ejected through the mount front, bouncing on deck
    t_case = r.uniform(0.62, 0.8)
    for dt, g in [(0.0, 0.045), (0.2, 0.028), (0.33, 0.016), (0.41, 0.009)]:
        c = synth.metal_hit(r, dur=0.6, size=0.6, damp=0.5)
        dsp.mix_at(y, bank.unit(c), int((t_case + dt * r.uniform(0.85, 1.15)) * SR), g)
    # sub-bass pressure bloom
    sub = dsp.lp(dsp.brown(n, r), 70, 4) * np.exp(-t / 0.35) * np.minimum(1, t / 0.01)
    y += 0.28 * bank.unit(sub)
    # over-water reverb: long, dark, low-frequency-heavy (sea + distant sky/ship scattering)
    ir = dsp.synth_ir(3.2, 2.6, r, stereo=False, hf_damp=900, lf_cut=30, predelay=0.03)
    wet = dsp.convolve(y, ir, wet=1.0, dry=0.0)[:n]
    y = y + 0.07 * wet * np.max(np.abs(y)) / np.max(np.abs(wet)) * 4
    # glue: gentle compression lifts the body/tail relative to the crack
    y = dsp.compress(bank.unit(y), thresh_db=-16, ratio=2.5, attack=0.004, release=0.25, makeup_db=0)
    return dsp.hp(y, 18, 2)


@variants("gun_5in", 3, source="dvids_937504.mp4 / dvids_836211.mp4 (USS Dewey Mk 45 firing, US Navy, PD) + "
          "synthesized shock/thump/sub, case-ejection clatter, synthetic over-water IR",
          desc="Close 5-inch round (~20-60 m): sharp report, pressure thump, reverb tail over the water, "
               "~3.3 s (one firing cycle at 18-20 rds/min).", tail_db=-60)
def gun_5in(i):
    return close_shot(i)


@asset("gun_5in_distant", source="synth + dvids_937504.mp4 (texture, heavily low-passed)",
       desc="5-inch gun heard at 5-20 km: soft-edged deep boom, rolling low tail, nothing above ~1 kHz.", tail_db=-55)
def gun_5in_distant():
    r = dsp.rng(546)
    n = int(6.0 * SR)
    b = synth.blast(r, dur=6.0, size=1.6, crack=0.6, thump=1.3, roar=0.5, rumble=1.0, crackle=0.0,
                    roar_tau=0.12, rumble_tau=1.0, lf_hz=32, bright=0.4)
    b = dsp.lp(b, 500, 4)
    b = dsp.lp(b, 1200, 2)
    b = synth.rolling_tail(b, r, rolls=7, spread=3.0, lp_hz=260, gain=0.45)
    ir = dsp.synth_ir(4.5, 3.2, r, stereo=False, hf_damp=700, lf_cut=25)
    y = dsp.convolve(b, ir, wet=0.35, dry=1.0)[:n]
    real = dsp.pad_to(real_shot(1), n)
    y += 0.08 * dsp.lp(real, 700, 4)
    return dsp.hp(y, 18, 2)
