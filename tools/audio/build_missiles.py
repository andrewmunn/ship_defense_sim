"""Missiles & engines: vls_launch_1..2, vls_launch_distant, rocket_motor_loop, jet_asm_loop, ramjet_loop,
missile_flyby_1..2, sonic_boom, chaff_launch.

Launches and fly-bys are rendered physically with synth.render_path (moving source, propagation delay ->
doppler, 1/r, distance low-pass, sea-surface image reflection, azimuth panning) from synthesized motor
sources layered with real recordings: the SM-2 launches recorded aboard USS Oscar Austin and USS Porter
(Formidable Shield 2023, US Navy, public domain) and CC0 Freesound rocket/jet recordings.
"""
import functools
import numpy as np
import dsp, synth, bank
from bank import asset, variants, env_points, unit, stdn
from dsp import SR


# ----------------------------------------------------------------------------- sources
@functools.lru_cache(None)
def real_launch(which):
    """Real SM-2 launch, denoised with the pre-launch noise, starting at the ignition onset (mono)."""
    if which == "austin":
        X = dsp.load("austin_sm2.webm", mono=True)
        on, noise = 3.7066, (0.8, 3.4)
    else:
        X = dsp.load("porter_sm2.webm", mono=True)
        on, noise = 49.93, (45.3, 47.4)
    nz = X[int(noise[0] * SR):int(noise[1] * SR)]
    x = X[int((on - 0.01) * SR):int((on + 9.0) * SR)]
    x = dsp.spectral_denoise(x, nz, reduction_db=20, oversub=1.8)
    x = dsp.declick(dsp.hp(x, 90, 2), thresh_db=9)
    a = np.abs(x)
    k = int(np.argmax(a > 0.25 * a[: int(0.5 * SR)].max()))
    return x[max(0, k - 48):]


@functools.lru_cache(None)
def real_thrust(sec=12.0, start=10.0):
    """Steady rocket thrust recording (LilMati, Freesound 515123, CC0)."""
    return dsp.load("freesound/fs_515123.ogg", start=start, dur=sec, mono=True)


def motor_src(n, r, crackle=1.0, real=0.6, bright=1.0):
    """Close rocket-motor exhaust source signal: synthetic roar/crackle/rumble + real thrust texture."""
    roar, ck, low = synth.rocket_noise(n, r, crackle=crackle, rumble=1.0)
    roar = dsp.peq(roar, 900, 3, 0.7)
    rt = real_thrust(n / SR + 0.5, 10.0 + r.uniform(0, 40))[:n]
    rt = dsp.pad_to(rt, n)
    y = 0.32 * stdn(roar) * bright + 0.5 * stdn(ck) * 0.35 + 0.28 * stdn(low) + real * 0.3 * stdn(rt)
    return y


# ----------------------------------------------------------------------------- VLS launch
def vls_path(a, side, drift):
    """Missile rising out of a forward VLS cell. Listener on the bridge wing at z=12 m;
    cell ~26 m ahead, 3 m to the side, at z=6 m. Vertical boost with slight downrange drift/pitch-over."""
    def pos(te):
        h = 0.5 * a * np.maximum(te, 0) ** 2
        x = side - drift * 0.06 * h
        y = 26.0 + 0.22 * h * np.clip(te / 3.0, 0, 1)
        z = 6.0 + h
        return x, y, z
    return pos


def vls_launch(i, distant=False):
    r = dsp.rng(410 + i + (10 if distant else 0))
    a = [150.0, 175.0][i - 1]
    src_dur = 9.0 if not distant else 12.0
    n_src = int(src_dur * SR)
    src = motor_src(n_src, r, crackle=1.2, real=0.6)
    te = np.arange(n_src) / SR
    # ignition: fast rise, 'booster' at full, very slight thrust wobble
    src *= np.minimum(1, te / 0.025) * dsp.smooth_random(n_src, r, 3, 0.85, 1.1)
    if distant:   # booster plume/directivity: swells after lift-off, fades as it pitches over and burns out
        src *= env_points(n_src, [(0, 0.5), (1.5, 1.0), (4.0, 0.8), (7.0, 0.3), (10.0, 0.0), (12.0, 0.0)])
        src = dsp.lp(src, 3000, 2)
    pos = vls_path(a, [-3.0, 4.0][i - 1], [1, -1][i - 1])
    if distant:
        lis = (1500.0, -3600.0, 10.0)       # another ship ~4 km away
        out, info = synth.render_path(src, pos, src_dur + 13.0, listener=lis, d_ref=30.0, sea=0.5,
                                      absorb_ref=60.0, absorb_exp=0.65, fc_min=250.0, width=0.2)
        s0 = int((info["t_first"] - 0.02) * SR)
        out = out[s0:s0 + int(9.5 * SR)]
        n = out.shape[0]
        m = dsp.lp(out.mean(1), 900, 4)
        boom = synth.blast(r, 3.0, size=1.2, crack=0.4, thump=1.2, roar=0.5, rumble=1.0, crackle=0.0, lf_hz=34, bright=0.3)
        boom = dsp.lp(boom, 600, 4)
        dsp.mix_at(m, unit(boom) * np.max(np.abs(m)) * 1.8, int(0.02 * SR))
        m = synth.rolling_tail(m, r, rolls=6, spread=3.0, lp_hz=300, gain=0.4)
        ir = dsp.synth_ir(5.0, 3.5, r, stereo=True, hf_damp=600, lf_cut=25)
        y = dsp.convolve(m, ir, wet=0.35, dry=1.0)[:n]
        y *= env_points(n, [(0, 1), (7.5, 1), (9.5, 0)])[:, None]
        return dsp.hp(y, 20, 2)
    out, info = synth.render_path(src, pos, 9.0, listener=(0.0, 0.0, 12.0), d_ref=30.0, d_min=12.0, sea=0.5,
                                  absorb_ref=60.0, absorb_exp=0.6, fc_min=700.0, width=0.7)
    s0 = int(info["t_first"] * SR)
    out = out[s0:]
    n = out.shape[0]
    t = np.arange(n) / SR
    # ignition blast in the cell + exhaust venting through the uptake hatch (fixed position, near field)
    ig = synth.blast(r, 2.5, size=0.45, crack=1.0, thump=1.2, roar=0.9, rumble=0.9, crackle=0.4,
                     roar_tau=0.1, rumble_tau=0.6, lf_hz=48, bright=1.2)
    vent = dsp.bp(dsp.pink(n, r), 180, 9000, 2) * np.exp(-t / 0.28) * np.minimum(1, t / 0.008)
    vent = dsp.peq(vent, 700, 4, 0.8)
    near = np.zeros(n)
    dsp.mix_at(near, unit(ig), 0, 0.9)
    near += 0.35 * unit(vent)
    near_st = bank.widen(near, r, amt=0.25) * np.array([1.0, 0.85])
    # real recorded launch (natural roar, ship/sea reflections), pan-spread
    real = dsp.pad_to(real_launch(["austin", "porter"][i - 1]), n)
    real = unit(real) * env_points(n, [(0, 1.0), (4.0, 0.8), (8.0, 0.5)] if i == 1 else
                                   [(0, 1.0), (4.0, 0.8), (5.6, 0.6), (6.3, 0.0), (9, 0)])
    real_st = bank.widen(real, r, ms=(9.1, 14.3), amt=0.35)
    pk = np.max(np.abs(out))
    y = 1.0 * out / pk + 0.75 * near_st + [0.55, 0.65][i - 1] * real_st
    # open-air reverb (sea/sky), stereo
    ir = dsp.synth_ir(3.5, 2.6, r, stereo=True, hf_damp=1500, lf_cut=35)
    wet = dsp.convolve(y.mean(1), ir, wet=1.0, dry=0.0)[:n]
    y = y + 0.18 * wet * np.max(np.abs(y)) / np.max(np.abs(wet)) * 2.5
    y = dsp.compress(unit(y), thresh_db=-14, ratio=2.5, attack=0.005, release=0.3)
    y = dsp.sat(unit(y) * 1.2, 1.0)
    y = y[: int(8.5 * SR)]
    return dsp.hp(y, 22, 2)


@variants("vls_launch", 2, q=5,
          source="austin_sm2.webm / porter_sm2.webm (SM-2 launches, USS Oscar Austin / USS Porter, US Navy, PD), "
                 "Freesound 515123 (rocket thrust, CC0), synthesized ignition blast, uptake vent, motor roar/crackle; "
                 "physically rendered climb-out (doppler, 1/r, air absorption, sea reflection)",
          desc="Close VLS launch heard from the bridge wing: ignition blast + uptake exhaust vent, roaring motor "
               "rising past, then receding and dropping in pitch as the missile climbs away; stereo, ~8.5 s. "
               "Starts at ignition (t=0).", tail_db=-55)
def _vls(i):
    return vls_launch(i)


@asset("vls_launch_distant", q=5, source="synth motor + Freesound 515123 (CC0), rendered at ~4 km",
       desc="A VLS launch from another ship ~4 km away: dull boom, then a distant low roar that swells and fades as the "
            "missile climbs; stereo, ~9 s.", tail_db=-55)
def _vls_d():
    return vls_launch(1, distant=True)


# ----------------------------------------------------------------------------- loops
def periodic_noise(n, r, shape):
    f = np.fft.rfftfreq(n, 1 / SR)
    y = np.fft.irfft(np.fft.rfft(r.standard_normal(n)) * shape(np.maximum(f, 1)), n)
    return y / np.std(y)


@asset("rocket_motor_loop", loop=True, source="synth (periodic roar/crackle/rumble) + Freesound 515123 (CC0), crossfaded",
       desc="Close rocket-motor roar with shock crackle for missiles in flight; 4 s seamless loop. Engine applies distance/doppler.")
def rocket_motor_loop():
    r = dsp.rng(42)
    N, X = 4 * SR, int(1.0 * SR)
    roar, ck, low = synth.rocket_noise(N, r, crackle=1.0, rumble=1.0, periodic=True)
    syn = 0.35 * roar + 0.55 * ck + 0.25 * low
    syn = dsp.circular(lambda z: dsp.peq(dsp.lp(z, 15000, 2), 1100, 3, 0.8), syn)
    real = dsp.make_loop(dsp.pad_to(real_thrust(5.2, 30.0), N + X), 1.0)
    real = dsp.circular(lambda z: dsp.hp(z, 30, 2), real)
    y = stdn(syn) + 0.7 * stdn(real)
    y = dsp.circular(lambda z: dsp.sat(z / np.max(np.abs(z)) * 1.4, 1.0), y)
    return dsp.circular(lambda z: dsp.hp(z, 25, 2), y)


@asset("jet_asm_loop", loop=True, source="synth (turbine tones, jet mixing noise) + Freesound 477132 (jet engine, CC0) pitched up",
       desc="Small turbojet of a subsonic sea-skimming cruise missile: high compressor whine, "
            "buzz and jet roar; 3 s seamless loop.")
def jet_asm_loop():
    r = dsp.rng(44)
    n = 3 * SR
    t = np.arange(n) / SR
    jet = periodic_noise(n, r, lambda f: (f / 900) / (1 + (f / 900) ** 2.2) / (1 + (f / 7000) ** 2))
    rumble = periodic_noise(n, r, lambda f: (f > 30) / (1 + (f / 180) ** 3) / np.sqrt(f))
    am = dsp.periodic_smooth_random(n, r, 30, 0.85, 1.15)
    tones = np.zeros(n)
    fm = dsp.periodic_smooth_random(n, r, 6, -1, 1)
    for f0, a in [(687, 0.25), (1374, 0.18), (2061, 0.12), (3405, 0.9), (6810, 0.35), (10215, 0.12), (4780, 0.3)]:
        f_int = round(f0 * 3) / 3
        inst = f_int * (1 + 0.0025 * fm)
        ph = 2 * np.pi * np.cumsum(inst) / SR
        ph += -np.linspace(0, 1, n) * (ph[-1] + 2 * np.pi * inst[-1] / SR - 2 * np.pi * f_int * 3)
        tones += a * np.sin(ph + r.uniform(0, 6.28))
    tones *= dsp.periodic_smooth_random(n, r, 12, 0.8, 1.2)
    syn = 1.0 * jet * am + 0.45 * rumble + 0.22 * tones
    real = dsp.load("freesound/fs_477132.ogg", start=5.0, dur=6.0, mono=True)
    real = dsp.resample(dsp.hp(real, 60, 2), 1.3)          # smaller, faster-spinning engine
    X = int(0.8 * SR)
    real = dsp.make_loop(dsp.pad_to(real, n + X), 0.8)
    y = stdn(syn) + 0.8 * stdn(real)
    return dsp.circular(lambda z: dsp.hp(z, 30, 2), y)


@asset("ramjet_loop", loop=True, source="synth (roar, 141 Hz combustion buzz, tearing HF, crackle) + Freesound 515122 (CC0)",
       desc="Harsh supersonic ramjet: tearing broadband roar, combustion buzz, crackle; 3 s seamless loop.")
def ramjet_loop():
    r = dsp.rng(45)
    n = 3 * SR
    roar, ck, low = synth.rocket_noise(n, r, crackle=0.8, rumble=1.2, periodic=True)
    f = np.fft.rfftfreq(n, 1 / SR)
    buzz = np.zeros(n)
    for h, a in [(1, 1.0), (2, 0.6), (3, 0.35), (4, 0.2)]:
        band = np.exp(-0.5 * ((f - 141 * h) / (6 * h)) ** 2)
        b = np.fft.irfft(np.fft.rfft(r.standard_normal(n)) * band, n)
        buzz += a * b / np.std(b)
    tear = dsp.circular(lambda z: dsp.hp(z, 2500, 2), roar) * dsp.periodic_smooth_random(n, r, 240, 0.4, 1.3)
    real = dsp.load("freesound/fs_515122.ogg", start=12.0, dur=5.0, mono=True)
    real = dsp.resample(real, 1.15)
    real = dsp.make_loop(dsp.pad_to(real, n + int(0.8 * SR)), 0.8)
    y = 0.5 * roar + 0.3 * tear + 0.35 * ck + 0.35 * low + 0.18 * buzz + 0.4 * stdn(real)
    y = dsp.circular(lambda z: dsp.sat(dsp.peq(dsp.hp(z, 30, 2), 2200, 4, 1.0) * 0.8, 1.6), y / np.max(np.abs(y)))
    return y


# ----------------------------------------------------------------------------- fly-bys
FLYBY = {1: dict(kind="jet", v=285.0, lateral=22.0, z=9.0, seed=61),
         2: dict(kind="rocket", v=310.0, lateral=35.0, z=25.0, seed=62)}
FLYBY_CPA = 1.5  # seconds from file start to the closest-approach arrival


def flyby(i):
    p = FLYBY[i]
    r = dsp.rng(p["seed"])
    tc = {1: 12.0, 2: 21.0}[i]          # near-sonic approach compresses time: need a long emission history
    T = tc + 4.0
    n = int(T * SR)
    if p["kind"] == "jet":
        loop = jet_asm_loop()
        src = np.tile(loop, int(np.ceil(n / len(loop))) + 1)[:n]
        src = stdn(src) + 0.3 * stdn(dsp.hp(r.standard_normal(n), 3000, 2)) * 0.5
    else:
        src = motor_src(n, r, crackle=1.4, real=0.5, bright=1.2)
    v, lat, z = p["v"], p["lateral"], p["z"]
    pos = lambda te: (v * (te - tc), lat + 0 * te, z + 0 * te)
    out, info = synth.render_path(src, pos, T + 4.0, listener=(0.0, 0.0, 12.0), d_ref=30.0, d_min=6.0, sea=0.6,
                                  absorb_ref=50.0, absorb_exp=0.6, fc_min=900.0, width=0.9)
    s0 = int((info["t_cpa"] - FLYBY_CPA) * SR)
    y = out[s0:s0 + int(3.6 * SR)]
    # air-rush / turbulence whoosh right at the pass
    m = y.shape[0]
    tt = np.arange(m) / SR
    wh = dsp.bp(dsp.pink(m, r), 400, 9000, 2) * np.exp(-((tt - FLYBY_CPA - 0.05) / 0.12) ** 2)
    y += 0.25 * np.max(np.abs(y)) * bank.widen(unit(wh), r)
    y = dsp.fade(y, 0.35, 0.6)
    return dsp.hp(y, 25, 2)


@variants("missile_flyby", 2, trim=False, q=5,
          source="jet_asm_loop / synth rocket motor + Freesound 515123 (CC0), physically rendered pass",
          desc="Pre-rendered close pass of a missile (1: subsonic turbojet sea-skimmer at 285 m/s, 22 m abeam; 2: rocket-"
               "powered missile at 310 m/s, 35 m): doppler whoosh-roar with sea-reflection phasing, stereo left->right, "
               "3.6 s, closest approach heard at 1.5 s. Play without engine doppler (it is baked in).")
def _flyby(i):
    return flyby(i)


# ----------------------------------------------------------------------------- sonic boom
@asset("sonic_boom", source="synth (N-waves, sea-surface reflection, diffuse tail)",
       desc="Supersonic missile passing: sharp N-wave double crack (bow/tail shocks) followed by the sea-reflected "
            "N-wave ~30 ms later, short rumbling tail; ~1.5 s.")
def sonic_boom():
    r = dsp.rng(46)
    n = int(1.8 * SR)
    y = np.zeros(n)
    nw = synth.n_wave(0.009, 1.0, rise=0.00004)
    nw2 = dsp.lp(synth.n_wave(0.0095, 1.0, rise=0.0001), 7000, 2)
    dsp.mix_at(y, nw, int(0.002 * SR))
    dsp.mix_at(y, nw2, int(0.032 * SR), 0.7)
    turb = dsp.hp(r.standard_normal(n), 2500, 2) * np.exp(-np.arange(n) / (0.004 * SR))
    y += 0.06 * np.roll(turb, int(0.002 * SR))
    ir = dsp.synth_ir(1.6, 1.2, r, stereo=False, hf_damp=1500, lf_cut=30)
    y = dsp.convolve(y, ir, wet=0.10, dry=1.0)[:n]
    t = np.arange(n) / SR
    rum = dsp.lp(dsp.brown(n, r), 140, 2) * np.exp(-t / 0.3) * np.minimum(1, t / 0.03)
    y += 0.10 * unit(rum)
    return dsp.hp(y, 15, 2)


# ----------------------------------------------------------------------------- chaff
@asset("chaff_launch", source="synth (mortar blast, tube resonance, rocket whoosh, burst pop) + Freesound 187767 (CC0)",
       desc="Decoy launcher firing a chaff/decoy round: hollow mortar thump, whoosh of the round leaving and "
            "receding, faint burst pop ~2 s later; ~3 s.")
def chaff_launch():
    r = dsp.rng(36)
    n = int(3.2 * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    b = synth.blast(r, 1.5, size=0.35, crack=0.8, thump=1.4, roar=0.6, rumble=0.7, crackle=0.0, lf_hz=58, bright=0.9)
    tube = dsp.reson(unit(b), 142, 8) + 0.5 * dsp.reson(unit(b), 410, 10)
    dsp.mix_at(y, unit(b) + 0.4 * unit(tube), 0)
    real = dsp.load("freesound/fs_187767.ogg", mono=True)
    a = np.abs(real)
    k = int(np.argmax(a > 0.3 * a.max()))
    real = dsp.fade(real[k:k + int(1.4 * SR)], 0.0, 0.5)
    dsp.mix_at(y, unit(dsp.resample(real, 1.25)), 0, 0.45)
    # whoosh: short rocket burn receding (doppler down, darkening)
    m = int(1.6 * SR)
    tm = np.arange(m) / SR
    w = dsp.bp(dsp.pink(m, r), 300, 9000, 2)
    fc = 9000 * np.exp(-tm / 0.5) + 700
    w = dsp.tv_lowpass_fast(w, fc) * np.minimum(1, tm / 0.03) * np.exp(-tm / 0.45)
    dsp.mix_at(y, unit(w), int(0.02 * SR), 0.45)
    pop = dsp.lp(synth.blast(r, 1.0, size=0.2, crack=0.6, thump=0.5, roar=0.3, rumble=0.3, crackle=0.0), 1500, 2)
    dsp.mix_at(y, unit(pop), int(2.05 * SR), 0.07)
    ir = dsp.synth_ir(2.0, 1.4, r, stereo=False, hf_damp=2000, lf_cut=40)
    y = dsp.convolve(y, ir, wet=0.12, dry=1.0)[:n]
    return dsp.hp(y, 25, 2)
