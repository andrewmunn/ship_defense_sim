"""Alarms and UI tones (all synthesized): alarm_gq, alarm_klaxon, ui_click, ui_track_new, ui_alert, ui_kill, ui_warn."""
import numpy as np
from scipy import signal
import dsp, bank
from bank import asset, unit
from dsp import SR


def horn_speaker(x, r, reverb=0.25, rt=1.1, drive=1.6):
    """Shipboard 1MC/alarm loudspeaker: horn band-limit + resonance, light overdrive, stereo slaps + ship reverb."""
    y = dsp.hp(x, 350, 4)
    y = dsp.lp(y, 5000, 4)
    y = dsp.peq(y, 1400, 5, 1.4)
    y = dsp.asym_sat(y / np.max(np.abs(y)) * drive, 1.8, 0.08)
    n = len(y) + int(rt * 1.6 * SR)
    out = np.zeros((n, 2))
    for (d, gl, gr) in [(0.0, 1.0, 0.9), (0.043, 0.35, 0.5), (0.089, 0.3, 0.2), (0.15, 0.15, 0.2)]:
        i = int(d * SR)
        out[i:i + len(y), 0] += gl * y
        out[i:i + len(y), 1] += gr * y
    ir = dsp.synth_ir(rt * 1.5, rt, r, stereo=True, hf_damp=3500, lf_cut=150)
    wet = np.column_stack([signal.fftconvolve(out[:, c], ir[:, c])[:n] for c in range(2)])
    out = out + reverb * wet / np.max(np.abs(wet)) * np.max(np.abs(out))
    return dsp.hp(out, 120, 2)


def bong(r, f0=560.0, dur=2.0, dscale=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    # electro-mechanical gong: inharmonic partials, the fundamental sustains longest
    parts = [(1.0, 1.0, 0.30), (2.0, 0.55, 0.2), (2.76, 0.4, 0.14), (4.1, 0.2, 0.08), (5.4, 0.12, 0.05)]
    y = np.zeros(n)
    for ratio, a, d in parts:
        y += a * np.sin(2 * np.pi * f0 * ratio * t * (1 + 0.0015 * np.exp(-t / 0.05))) * np.exp(-t / (d * dscale))
    strike = dsp.bp(r.standard_normal(n), 1500, 6000, 2) * np.exp(-t / 0.004) * 0.3
    y = (y + strike) * np.minimum(1, t / 0.002)
    return y


def ui_click_synth():
    r = dsp.rng(73)
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    y = dsp.modal(n, [2400, 4100, 6900], [0.004, 0.0025, 0.0015], [1, .6, .3], r)
    y += 0.6 * dsp.hp(r.standard_normal(n), 3000, 2) * np.exp(-t / 0.0008)
    # release click of the switch 25 ms later, softer
    y2 = dsp.modal(n, [2900, 5200], [0.003, 0.002], [1, .5], r)
    y[int(0.022 * SR):] += 0.35 * y2[: n - int(0.022 * SR)]
    y *= np.minimum(1, t / 0.0002)
    return np.column_stack([y, y])


@asset("alarm_gq", source="synth (inharmonic gong partials, 1MC loudspeaker chain, ship reverb)", peak=-1.0,
       desc="General Quarters alarm: the rapid repeating electro-mechanical 'bong-bong-bong' gong through the "
            "1MC shipboard loudspeakers (horn band-limit, overdrive, slap echoes, steel reverb); stereo, ~6 s.")
def alarm_gq():
    r = dsp.rng(71)
    period = 0.29
    count = 18
    n = int((period * count + 1.4) * SR)
    y = np.zeros(n)
    for k in range(count):
        dsp.mix_at(y, bong(r, f0=560.0 * (1 + 0.002 * r.standard_normal()), dur=1.2, dscale=0.55) * dsp.db(r.normal(0, 0.3)),
                   int((k * period + r.normal(0, 0.002)) * SR))
    out = horn_speaker(y, r, reverb=0.2, rt=1.1, drive=1.15)
    return dsp.fade(out, 0, 0.5)


@asset("alarm_klaxon", source="synth (pulsed harsh two-tone buzzer, 1MC loudspeaker chain)",
       desc="'Brace for impact' / collision alarm: urgent rapid high buzzer pulses over the 1MC; stereo, ~3 s.")
def alarm_klaxon():
    r = dsp.rng(72)
    dur = 2.35
    n = int(dur * SR)
    t = np.arange(n) / SR
    ph1 = 2 * np.pi * 910 * t
    ph2 = 2 * np.pi * 1365 * t
    tone = (np.sign(np.sin(ph1)) * 0.6 + 0.4 * np.sin(ph1)) + 0.5 * (np.sign(np.sin(ph2)) * 0.6 + 0.4 * np.sin(ph2))
    gate = (np.mod(t, 1 / 6.0) < 0.1).astype(float)
    gate = dsp.lp0(gate, 120, 2)
    y = dsp.lp(tone * gate, 6000, 2)
    out = horn_speaker(y, r, reverb=0.25, rt=1.0)
    return dsp.fade(out, 0, 0.3)


@asset("ui_click", source="synth", desc="Console button click (switch press + release), 60 ms.")
def ui_click():
    return ui_click_synth()[:, 0]


def blip(f, dur, r, harm=(1.0, 0.12, 0.05), glide=0.0, attack=0.004, tau=None):
    n = int(dur * SR)
    t = np.arange(n) / SR
    ff = f * (1 + glide * np.minimum(t / dur, 1))
    ph = 2 * np.pi * np.cumsum(ff) / SR
    y = sum(a * np.sin((k + 1) * ph) for k, a in enumerate(harm))
    env = np.minimum(1, t / attack) * (np.exp(-t / tau) if tau else np.clip((dur - t) / 0.015, 0, 1))
    return y * env


def console_space(y, r, wet=0.12):
    ir = dsp.synth_ir(0.35, 0.22, r, stereo=False, hf_damp=6000, lf_cut=300)
    return dsp.convolve(y, ir, wet=wet, dry=1.0)


@asset("ui_track_new", source="synth", desc="New radar track: soft two-note rising sonar-like blip, ~0.4 s.")
def ui_track_new():
    r = dsp.rng(75)
    n = int(0.45 * SR)
    y = np.zeros(n)
    dsp.mix_at(y, blip(1175, 0.09, r, glide=0.01, tau=0.05), 0)
    dsp.mix_at(y, blip(1568, 0.14, r, glide=0.01, tau=0.07), int(0.085 * SR), 0.9)
    return console_space(y, r, 0.18)


@asset("ui_alert", peak=-1.0, source="synth",
       desc="VAMPIRE / inbound missile alert: three urgent bright beeps with a harsh edge, ~0.7 s (retrigger to repeat).")
def ui_alert():
    r = dsp.rng(76)
    n = int(0.75 * SR)
    y = np.zeros(n)
    for k in range(3):
        b = blip(2093, 0.11, r, harm=(1.0, 0.0, 0.35, 0.0, 0.18, 0.0, 0.08), attack=0.002)
        b += 0.5 * blip(2217, 0.11, r, harm=(1.0,), attack=0.002)          # slight beating = urgency
        dsp.mix_at(y, b, int(k * 0.17 * SR))
    y = dsp.asym_sat(unit(y) * 1.3, 1.4, 0.05)
    return console_space(dsp.hp(y, 300, 2), r, 0.1)


@asset("ui_kill", source="synth", desc="Confirmed kill: quick bright ascending three-note chirp, ~0.45 s.")
def ui_kill():
    r = dsp.rng(77)
    n = int(0.5 * SR)
    y = np.zeros(n)
    for k, (f, g) in enumerate([(1047, 0.8), (1319, 0.9), (1976, 1.0)]):
        dsp.mix_at(y, blip(f, 0.16 if k == 2 else 0.07, r, glide=0.004, tau=0.09 if k == 2 else 0.04), int(k * 0.055 * SR), g)
    return console_space(y, r, 0.2)


@asset("ui_warn", source="synth", desc="Caution/warning: two low alternating tones (down-step), ~0.55 s.")
def ui_warn():
    r = dsp.rng(78)
    n = int(0.6 * SR)
    y = np.zeros(n)
    for k, f in enumerate([659, 494]):
        dsp.mix_at(y, blip(f, 0.22, r, harm=(1.0, 0.3, 0.15, 0.05), attack=0.006), int(k * 0.25 * SR))
    return console_space(y, r, 0.12)
