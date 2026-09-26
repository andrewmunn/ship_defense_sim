/**
 * Procedural outdoor / open-sea impulse response for the shared convolution reverb send.
 *
 * Out on the water there are no walls: what you hear after a gunshot is
 *  - one strong, early specular reflection off the sea surface (a few ms),
 *  - a sparse handful of later reflections (own superstructure, wave crests, other hulls),
 *  - a slowly building, long, dark and "rolling" diffuse decay (scattering off the rough sea,
 *    refraction in the boundary layer, distant coast), whose high end dies much faster than the low end.
 * RT60 ≈ 3.2 s at low frequencies, well under 0.5 s above 3 kHz (dark). Stereo decorrelated. Energy-normalised so a unit
 * send returns roughly −6 dB of reverberant energy.
 */
export function makeSeaIR(ctx: BaseAudioContext, seconds = 3.6, seed = 1337): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  let s = seed >>> 0;
  const rnd = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const RT_LOW = 3.2;
  for (let ch = 0; ch < 2; ch++) {
    const x = buf.getChannelData(ch);
    // --- late diffuse field: noise through a time-varying 2-pole low-pass (darkens with time), exp decay, slow build-up
    let y1 = 0, y2 = 0;
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fc = 250 + 3200 * Math.exp(-t / 0.3);
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      const w = gauss();
      y1 = a * y1 + (1 - a) * w;
      y2 = a * y2 + (1 - a) * y1;
      // compensate the level loss of the narrowing filter so the *low* band follows RT_LOW
      const comp = Math.sqrt(3450 / fc);
      const build = t < 0.02 ? 0 : t < 0.14 ? Math.pow((t - 0.02) / 0.12, 1.5) : 1;
      const roll = 1 + (t > 0.25 ? 0.35 * Math.min(1, (t - 0.25) / 0.5) : 0) *
        (0.5 * Math.sin(2 * Math.PI * 0.9 * t + ph[0]) + 0.3 * Math.sin(2 * Math.PI * 1.7 * t + ph[1]) + 0.2 * Math.sin(2 * Math.PI * 0.43 * t + ph[2]));
      const env = Math.exp((-6.91 * t) / RT_LOW) * build * roll;
      const tail = t > seconds - 0.25 ? (seconds - t) / 0.25 : 1;
      x[i] = y2 * comp * env * tail;
    }
    // --- early reflections: sea surface (strong, few ms, slightly different per ear) + sparse later ones
    const tap = (t: number, g: number) => {
      const i = Math.floor(t * sr);
      if (i >= 0 && i < n - 4) {
        // short smeared tap (rough surface), ~0.3 ms
        x[i] += g * 0.6;
        x[i + 1] += g * 0.3;
        x[i + 2] += g * 0.1;
      }
    };
    tap(0.0045 + ch * 0.0006, 0.9);
    tap(0.011 + ch * 0.0011, 0.35);
    for (let k = 0; k < 16; k++) {
      const t = 0.02 + Math.pow(rnd(), 1.4) * 0.22;
      tap(t, (rnd() < 0.5 ? -1 : 1) * 0.45 * Math.exp(-t / 0.09) * (0.4 + 0.6 * rnd()));
    }
  }
  // --- normalise energy (per channel) to 0.25 (≈ −6 dB)
  for (let ch = 0; ch < 2; ch++) {
    const x = buf.getChannelData(ch);
    let e = 0;
    for (let i = 0; i < n; i++) e += x[i] * x[i];
    const g = Math.sqrt(0.25 / Math.max(e, 1e-12));
    for (let i = 0; i < n; i++) x[i] *= g;
  }
  return buf;
}
