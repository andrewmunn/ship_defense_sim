"""Reusable synthesis building blocks: blasts/N-waves, rumbles, crackle, debris, water, rocket noise."""
import numpy as np
import dsp
from dsp import SR


def n_wave(T, amp=1.0, rise=0.00008, sr=SR):
    """Friedlander-ish N-wave: instant rise to +amp, linear fall to -amp*0.6 over T, return to 0."""
    n = int(T * sr * 1.6)
    t = np.arange(n) / sr
    y = np.where(t < T, 1 - (t / T) * 1.6, 0.0)
    after = t >= T
    y[after] = -0.6 * np.exp(-(t[after] - T) / (0.35 * T))
    r = int(rise * sr) + 1
    y[:r] *= np.linspace(0, 1, r)
    return amp * y


def friedlander(td, n_dur, amp=1.0, b=1.8, sr=SR):
    """Friedlander blast-wave overpressure p(t) = (1 - t/td) exp(-b t/td)."""
    n = int(n_dur * sr)
    t = np.arange(n) / sr
    y = (1 - t / td) * np.exp(-b * t / td)
    r = 3
    y[:r] *= np.linspace(0, 1, r)
    return amp * y


def blast(r, dur=3.0, size=1.0, crack=1.0, thump=1.0, roar=1.0, rumble=1.0, crackle=0.5,
          roar_tau=0.12, rumble_tau=0.8, lf_hz=45.0, bright=1.0):
    """Generic close explosion/muzzle blast (mono).
    size scales durations (bigger = longer positive phase, lower spectrum)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    # 1) shock: Friedlander pulse, positive duration ~ 4..25 ms depending on size
    td = 0.004 + 0.012 * size
    fw = friedlander(td, min(dur, 12 * td), 1.0)
    shock = dsp.pad_to(fw, n)
    y += crack * 1.0 * shock
    # 2) broadband crack: very short noise burst, bright
    cr = r.standard_normal(n) * np.exp(-t / (0.0015 + 0.002 * size))
    cr = dsp.hp(cr, 700 / max(bright, 0.3), 2)
    y += crack * 0.6 * cr * bright
    # 3) low-frequency pressure thump (gas expansion) - damped low sine sweep downwards
    f = lf_hz * (1 + 1.5 * np.exp(-t / 0.03))
    ph = 2 * np.pi * np.cumsum(f) / SR
    th = np.sin(ph) * np.exp(-t / (0.025 + 0.045 * size)) * np.minimum(1, t / 0.002)
    y += thump * 0.9 * th
    # 4) turbulent roar (fireball / gas) - pink noise, mid band, fast-ish decay
    ro = dsp.bp(dsp.pink(n, r), 150, 5000 * bright, 2)
    ro *= np.exp(-t / (roar_tau * (0.6 + 0.6 * size))) * np.minimum(1, t / 0.003)
    y += roar * 0.35 * ro
    # 5) rumble tail: brown noise lowpassed with slow random modulation
    ru = dsp.lp(dsp.brown(n, r), 180, 2)
    ru = dsp.hp(ru, 22, 2)
    mod = dsp.smooth_random(n, r, 6, 0.5, 1.2)
    ru *= mod * np.exp(-t / (rumble_tau * (0.6 + 0.6 * size))) * np.minimum(1, t / 0.02)
    y += rumble * 0.25 * ru
    # 6) crackle: sparse random impulses decaying (burning fragments/afterburn)
    if crackle > 0:
        ck = np.zeros(n)
        cnt = int(80 * crackle * (0.5 + size))
        for _ in range(cnt):
            p = int(SR * (0.01 + r.exponential(0.25 * (0.5 + size))))
            if p < n - 400:
                k = r.standard_normal(200) * np.exp(-np.arange(200) / r.uniform(10, 40))
                ck[p:p + 200] += k * r.uniform(0.2, 1) * np.exp(-p / SR / 0.8)
        ck = dsp.hp(ck, 1200, 2)
        y += crackle * 0.25 * ck
    return y


def sea_reflection(x, delay_ms=8.0, gain=0.7, lp_hz=3000):
    """Sea surface acts as a (nearly) rigid reflector for airborne sound: positive, slightly lowpassed copy."""
    d = int(delay_ms * SR / 1000)
    y = x.copy()
    y[d:] += gain * dsp.lp(x[:-d], lp_hz, 2)
    return y


def rolling_tail(x, r, rolls=6, spread=2.5, lp_hz=300, gain=0.5):
    """Distant 'rolling thunder': several delayed, smeared, lowpassed copies of the event."""
    n = x.shape[0]
    y = x.copy()
    for i in range(rolls):
        d = int(SR * (0.15 + spread * (i / rolls) ** 1.3 + r.uniform(-0.05, 0.05)))
        if d >= n:
            break
        g = gain * (0.85 ** i) * r.uniform(0.6, 1.0)
        sm = dsp.lp(x, lp_hz * r.uniform(0.6, 1.0), 2)
        # smear with a short noise burst convolution
        ker = r.standard_normal(int(0.08 * SR)) * np.exp(-np.arange(int(0.08 * SR)) / (0.02 * SR))
        sm = np.convolve(sm, ker / np.sqrt(np.sum(ker ** 2)))[:n]
        y[d:] += g * sm[:n - d]
    return y


def crackle_train(n, r, rate, dur_ms=(0.3, 3.0), band=(800, 12000), amp_dist=2.0):
    """Sparse impulsive crackle (rocket exhaust / fire). rate = events per second (array or scalar)."""
    rate = np.broadcast_to(rate, (n,))
    y = np.zeros(n)
    p = r.uniform(size=n) < rate / SR
    idx = np.nonzero(p)[0]
    for i in idx:
        L = int(r.uniform(*dur_ms) * SR / 1000) + 8
        if i + L >= n:
            continue
        k = r.standard_normal(L) * np.exp(-np.arange(L) / (L / 4))
        y[i:i + L] += k * r.pareto(amp_dist) * 0.3
    return dsp.bp(y, band[0], band[1], 2)


def rocket_noise(n, r, crackle=1.0, rumble=1.0, roar_hi=1.0, periodic=False):
    """Rocket-motor exhaust: broadband roar with slow random AM, a crackle layer (supersonic jet
    shock crackle is skewed/impulsive), and heavy low rumble."""
    if periodic:
        def noise(fn):
            X = np.fft.rfft(r.standard_normal(n))
            f = np.fft.rfftfreq(n, 1 / SR)
            y = np.fft.irfft(X * fn(np.maximum(f, 1)), n)
            return y / np.std(y)
        pinkish = noise(lambda f: 1 / np.sqrt(f) * (1 / (1 + (f / 9000) ** 2)))
        low = noise(lambda f: 1 / f * ((f > 25) * 1.0) * (1 / (1 + (f / 200) ** 4)))
        am = dsp.periodic_smooth_random(n, r, max(4, int(n / SR * 9)), 0.6, 1.25)
        am2 = dsp.periodic_smooth_random(n, r, max(4, int(n / SR * 23)), 0.85, 1.15)
    else:
        pinkish = dsp.lp(dsp.pink(n, r), 9000, 2)
        low = dsp.lp(dsp.brown(n, r), 200, 4)
        low = dsp.hp(low, 25, 2)
        low /= np.std(low)
        am = dsp.smooth_random(n, r, 9, 0.6, 1.25)
        am2 = dsp.smooth_random(n, r, 23, 0.85, 1.15)
    roar = pinkish * am * am2
    # crackle: skewed impulsive events (positive-going spikes, like real rocket crackle)
    ck = np.zeros(n)
    cnt = int(n / SR * 260 * crackle)
    pos = r.integers(0, n, cnt)
    for p in pos:
        L = int(r.uniform(0.0003, 0.0022) * SR) + 4
        k = np.exp(-np.arange(L) / (L / 3)) * (1 + 0.3 * r.standard_normal(L))
        amp = r.pareto(2.2) * 0.25
        idx = (p + np.arange(L)) % n
        ck[idx] += k * amp
    ck = ck - np.convolve(ck, np.ones(64) / 64, mode="same")  # remove local DC keep skew
    return roar_hi * roar, crackle * ck, rumble * low


def water_splash(r, dur=2.0, size=1.0, bright=1.0):
    """Synthetic splash: impact slap + bubbly burst (many tiny damped sine 'bubbles' with rising pitch)
    + spray noise + fall-back patter."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    # impact slap
    slap = dsp.bp(r.standard_normal(n), 300, 6000 * bright, 2) * np.exp(-t / (0.01 + 0.02 * size))
    y += 0.8 * slap
    # bubbles (Minnaert resonances), rising chirp, count ~ size
    nb = int(60 * size + 20)
    for _ in range(nb):
        st = r.exponential(0.08 * size ** 0.5)
        f0 = r.uniform(400, 3500) / size ** 0.3
        d = r.uniform(0.005, 0.04)
        L = int(d * 5 * SR)
        s = int(st * SR)
        if s + L >= n:
            continue
        tt = np.arange(L) / SR
        f = f0 * (1 + 2.5 * tt / d * 0.1)
        b = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / d)
        y[s:s + L] += b * r.uniform(0.05, 0.3)
    # spray / sheet noise
    spray = dsp.hp(r.standard_normal(n), 2500, 2) * np.exp(-t / (0.12 * size)) * np.minimum(1, t / 0.01)
    y += 0.25 * spray * bright
    # fall-back patter (droplets / water column collapsing) after delay
    fb = np.zeros(n)
    t0 = 0.25 * size ** 0.5
    for _ in range(int(400 * size)):
        s = int((t0 + r.gamma(2, 0.2 * size)) * SR)
        L = 300
        if s + L >= n:
            continue
        fb[s:s + L] += r.standard_normal(L) * np.exp(-np.arange(L) / 30) * r.uniform(0.02, 0.2)
    fb = dsp.bp(fb, 600, 9000, 2)
    y += fb
    return y


def metal_hit(r, dur=1.0, size=1.0, damp=1.0):
    """Struck steel plate/debris: inharmonic modal set + noise contact."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    base = r.uniform(180, 600) / size
    ratios = np.array([1.0, 1.59, 2.14, 2.30, 2.65, 2.92, 3.50, 4.15, 5.2, 6.8]) * r.uniform(0.97, 1.03, 10)
    freqs = base * ratios
    decays = r.uniform(0.05, 0.4, 10) * damp / np.sqrt(ratios)
    amps = r.uniform(0.2, 1.0, 10) / ratios ** 0.5
    y = dsp.modal(n, freqs, decays, amps, r)
    contact = dsp.bp(r.standard_normal(n), 800, 9000, 2) * np.exp(-t / 0.004)
    y = y * np.minimum(1, t / 0.0005) + 0.7 * contact
    return y


# ----------------------------------------------------------------------------- moving-source renderer
C_SOUND = 343.0


def render_path(src, pos, dur_out, listener=(0.0, 0.0, 10.0), d_ref=30.0, d_min=8.0, sea=0.55,
                absorb_ref=40.0, absorb_exp=0.7, fc_max=20000.0, fc_min=500.0, width=0.8, block=128):
    """Render a moving mono source to stereo for a fixed listener, physically:
    propagation delay (-> doppler), 1/r spreading, distance low-pass (air absorption), a sea-surface
    image-source reflection (swept comb 'phasing'), and constant-power panning from azimuth.
    src: mono source signal sampled at emission time (t_e = i / SR).
    pos: fn(t_e array) -> (x, y, z) arrays in metres (x = right of listener, y = ahead, z = up; sea at z=0).
    Returns (stereo, info) where info has arrival time of the closest approach."""
    n_src = len(src)
    te = np.arange(n_src) / SR
    x, y, z = pos(te)
    lx, ly, lz = listener
    d = np.sqrt((x - lx) ** 2 + (y - ly) ** 2 + (z - lz) ** 2)
    d2 = np.sqrt((x - lx) ** 2 + (y - ly) ** 2 + (z + lz) ** 2)          # image source below the sea
    n = int(dur_out * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    az = np.arctan2(x - lx, y - ly)                                       # 0 = ahead, +pi/2 = right
    for dist, g_extra in [(d, 1.0), (d2, sea)]:
        ta = te + dist / C_SOUND
        if np.any(np.diff(ta) <= 0):
            raise ValueError("source approaches faster than sound")
        te_of_t = np.interp(t, ta, te, left=-1, right=-1)
        valid = te_of_t >= 0
        idx = np.clip(te_of_t * SR, 0, n_src - 2)
        i0 = idx.astype(int)
        fr = idx - i0
        s = (src[i0] * (1 - fr) + src[i0 + 1] * fr) * valid
        dd = np.interp(t, ta, dist)
        g = d_ref / np.maximum(dd, d_min) * g_extra
        fc = np.clip(fc_max * (absorb_ref / np.maximum(dd, 1)) ** absorb_exp, fc_min, fc_max)
        s = dsp.tv_lowpass_fast(s * g, fc, block=block)
        if g_extra != 1.0:
            s = dsp.lp(s, 3000, 2)
        p = np.sin(np.interp(t, ta, az)) * width
        out[:, 0] += s * np.sqrt(0.5 * (1 - p))
        out[:, 1] += s * np.sqrt(0.5 * (1 + p))
    ta_direct = te + d / C_SOUND
    info = {"t_cpa": float(ta_direct[int(np.argmin(d))]), "t_first": float(ta_direct[0])}
    return out, info
