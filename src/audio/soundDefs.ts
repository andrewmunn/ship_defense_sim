/**
 * Per-sound mixing / propagation table and the pure acoustic math used by the audio engine.
 * Everything here is side-effect free so it can be unit-checked (see src/dev/audioCheck.ts).
 *
 * Distance law (per sound, overridable by play(..., { range })):
 *   vol   : linear gain at the reference distance `ref` (the "as recorded" perspective of the asset)
 *   ref   : reference distance, m. Inside ref the level rises gently (^NEAR_EXP) and is capped at NEAR_MAX (+4 dB)
 *   range : distance at which the sound has fallen by 40 dB (then fades to silence by 1.25 × range and is culled)
 *   → beyond ref, gain = (ref/d)^k with k = 2 / log10(range/ref), clamped to [0.6, 1.6]
 *     (k≈1 is physical spherical spreading; long-range sounds get a slightly softer law so they stay playable).
 * Air absorption: a two-stage low-pass whose cutoff falls with distance (~16 kHz @ 50 m, 1.5 kHz @ 3 km, 300 Hz @ 15 km).
 * Sounds that were *rendered* at a distance (distant variants) only get the excess path (d - render) filtered.
 */
export const SPEED_OF_SOUND = 343;

export type SoundClass = 'ui' | 'alarm' | 'combat' | 'motor' | 'amb';

export interface SoundDef {
  vol: number;
  ref: number;
  range: number;
  cls: SoundClass;
  /** Near → far crossfade partner (a "distant" rendering of the same event). Crossfade is equal-power in log distance. */
  far?: { name: string; start: number; end: number; /** level match of the distant asset (default 1) */ gain?: number };
  /** Distance the asset already "contains" (baked air absorption); only the excess path is filtered. */
  render?: number;
  /** Max identical starts within the 50 ms window (the rest are merged into a cluster). */
  burst?: number;
  /** Survives high time scales (≥ 8×) and is never ducked. */
  big?: boolean;
  /** Reverb-send multiplier (sounds with a baked reverb tail send less). */
  wet?: number;
  /** Voice-stealing priority multiplier (default 1). */
  prio?: number;
  /** Stereo image baked into the asset: pan with a StereoPanner only (no HRTF), never doppler. */
  baked?: boolean;
  /** Random detune applied per start (fraction, default 0.03 for world sounds). */
  detune?: number;
}

const COMBAT = 'combat' as const;
const CIWS: SoundDef = { vol: 0.8, ref: 25, range: 9000, cls: COMBAT, wet: 0.45, big: true, prio: 2, detune: 0 };
const EXPLO_FAR = { name: 'explosion_far', start: 900, end: 5000 };

/** Sensible defaults for every manifest entry. Unknown names fall back to DEFAULT_DEF. */
export const SOUND_DEFS: Record<string, SoundDef> = {
  // ---- CIWS (spinup/loop/tail share one gain so they splice; the handle does the near/far crossfade)
  ciws_fire_loop: { ...CIWS, far: { name: 'ciws_distant_loop', start: 150, end: 1500 } },
  ciws_spinup: CIWS,
  ciws_tail: CIWS,
  ciws_distant_loop: { ...CIWS, render: 2000 },
  ciws_servo: { vol: 0.5, ref: 4, range: 150, cls: 'motor', wet: 0.2, detune: 0 },

  // ---- guns / launchers
  gun_5in: { vol: 1.5, ref: 40, range: 20000, cls: COMBAT, far: { name: 'gun_5in_distant', start: 600, end: 4000, gain: 0.6 }, wet: 0.6, prio: 1.5, burst: 2 },
  gun_5in_distant: { vol: 1.5, ref: 40, range: 20000, cls: COMBAT, render: 8000, prio: 1.5 },
  vls_launch: { vol: 1.0, ref: 40, range: 12000, cls: COMBAT, far: { name: 'vls_launch_distant', start: 400, end: 2500 }, wet: 0.5, big: true, prio: 2, baked: true, detune: 0.015 },
  vls_launch_distant: { vol: 1.0, ref: 40, range: 12000, cls: COMBAT, render: 4000, big: true, prio: 2, baked: true },
  chaff_launch: { vol: 0.9, ref: 20, range: 3000, cls: COMBAT, prio: 1.2 },

  // ---- missiles
  rocket_motor_loop: { vol: 0.9, ref: 30, range: 10000, cls: 'motor', detune: 0.02 },
  jet_asm_loop: { vol: 0.8, ref: 20, range: 5000, cls: 'motor', detune: 0.02 },
  ramjet_loop: { vol: 0.9, ref: 30, range: 9000, cls: 'motor', detune: 0.02 },
  missile_flyby: { vol: 1.0, ref: 30, range: 1500, cls: COMBAT, baked: true, prio: 1.5, burst: 2 },
  sonic_boom: { vol: 1.0, ref: 60, range: 12000, cls: COMBAT, big: true, prio: 2, burst: 2 },

  // ---- impacts / explosions
  explosion_near: { vol: 1.0, ref: 250, range: 30000, cls: COMBAT, far: EXPLO_FAR, render: 250, wet: 0.7, big: true, prio: 2, burst: 3 },
  explosion_air: { vol: 1.0, ref: 300, range: 30000, cls: COMBAT, far: { name: 'explosion_far', start: 1500, end: 7000 }, render: 400, wet: 0.7, big: true, prio: 2, burst: 3 },
  explosion_far: { vol: 1.0, ref: 250, range: 30000, cls: COMBAT, render: 8000, big: true, prio: 2, burst: 3 },
  explosion_ship_hit: { vol: 1.0, ref: 60, range: 30000, cls: COMBAT, far: EXPLO_FAR, wet: 0.5, big: true, prio: 4, burst: 2, detune: 0.015 },
  splash_big: { vol: 0.9, ref: 40, range: 4000, cls: COMBAT, big: true, prio: 1.5, burst: 3 },
  splash_small: { vol: 0.45, ref: 8, range: 400, cls: COMBAT, prio: 0.5, burst: 2 },
  debris_metal: { vol: 0.55, ref: 10, range: 500, cls: COMBAT, prio: 0.7, burst: 2 },
  metal_groan: { vol: 0.85, ref: 40, range: 2500, cls: COMBAT, wet: 0.8, big: true, prio: 1.5, burst: 1 },

  // ---- ambience beds (normally owned by the engine; usable as positional loops too)
  ocean_loop: { vol: 0.5, ref: 10, range: 600, cls: 'amb', detune: 0 },
  hull_wash_loop: { vol: 0.55, ref: 10, range: 400, cls: 'amb', detune: 0 },
  wind_loop: { vol: 0.4, ref: 10, range: 300, cls: 'amb', detune: 0 },
  ship_engine_loop: { vol: 0.6, ref: 25, range: 1500, cls: 'amb', detune: 0 },
  fire_loop: { vol: 0.8, ref: 25, range: 2500, cls: 'amb', wet: 0.5, detune: 0 },

  // ---- 1MC alarms (2D, diegetic but not time-stretched)
  alarm_gq: { vol: 0.3, ref: 1, range: 1, cls: 'alarm', detune: 0, big: true },
  alarm_klaxon: { vol: 0.3, ref: 1, range: 1, cls: 'alarm', detune: 0, big: true },

  // ---- UI (2D, separate always-running context so they work while paused)
  ui_click: { vol: 0.22, ref: 1, range: 1, cls: 'ui', detune: 0, burst: 2 },
  ui_track_new: { vol: 0.25, ref: 1, range: 1, cls: 'ui', detune: 0, burst: 2 },
  ui_alert: { vol: 0.2, ref: 1, range: 1, cls: 'ui', detune: 0, burst: 1 },
  ui_kill: { vol: 0.25, ref: 1, range: 1, cls: 'ui', detune: 0, burst: 2 },
  ui_warn: { vol: 0.22, ref: 1, range: 1, cls: 'ui', detune: 0, burst: 1 },
};

export const DEFAULT_DEF: SoundDef = { vol: 0.8, ref: 20, range: 3000, cls: COMBAT };

export function defFor(name: string): SoundDef {
  return SOUND_DEFS[name] ?? (name.startsWith('ui_') ? { ...DEFAULT_DEF, cls: 'ui', vol: 0.25 } : DEFAULT_DEF);
}

// ------------------------------------------------------------------------------------------ math
export const NEAR_MAX = 1.6; // +4 dB max boost when closer than ref
export const NEAR_EXP = 0.35;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Effective (ref, range, k) for a def with an optional range override. */
export function lawFor(def: SoundDef, rangeOverride?: number) {
  const range = Math.max(1, rangeOverride ?? def.range);
  const ref = Math.max(0.5, Math.min(def.ref, range / 4));
  const k = clamp(2 / Math.log10(Math.max(range / ref, 1.5)), 0.6, 1.6);
  return { ref, range, k };
}

/** Distance attenuation (linear, 1 at ref). */
export function distGain(d: number, ref: number, range: number, k?: number) {
  const kk = k ?? clamp(2 / Math.log10(Math.max(range / ref, 1.5)), 0.6, 1.6);
  let a: number;
  if (d <= ref) a = Math.min(NEAR_MAX, Math.pow(ref / Math.max(d, 0.5), NEAR_EXP));
  else a = Math.pow(ref / d, kk);
  if (d > range) a *= Math.max(0, 1 - (d - range) / (0.25 * range));
  return a;
}

/** Air-absorption low-pass cutoff (Hz) vs propagation distance (m); log-log interpolation. */
const AIR: [number, number][] = [
  [1, 20000], [50, 16000], [200, 9000], [500, 5000], [1000, 2800], [3000, 1500], [6000, 750],
  [10000, 420], [15000, 300], [25000, 190], [40000, 130], [100000, 80], [1e7, 60],
];
export function airCutoff(d: number) {
  if (d <= AIR[0][0]) return AIR[0][1];
  for (let i = 1; i < AIR.length; i++) {
    const [d1, f1] = AIR[i];
    if (d <= d1) {
      const [d0, f0] = AIR[i - 1];
      const t = Math.log(d / d0) / Math.log(d1 / d0);
      return Math.exp(Math.log(f0) + t * (Math.log(f1) - Math.log(f0)));
    }
  }
  return AIR[AIR.length - 1][1];
}

/** Cutoff for an asset rendered at `render` m heard at d m: only the excess path is absorbed. */
export function excessCutoff(d: number, render = 0) {
  return airCutoff(Math.max(1, d - render));
}

/** Reverb wet fraction vs distance (distant sounds are more reverberant). */
const WET: [number, number][] = [[10, 0.05], [100, 0.14], [1000, 0.3], [5000, 0.45], [20000, 0.55]];
export function reverbWet(d: number) {
  if (d <= WET[0][0]) return WET[0][1];
  for (let i = 1; i < WET.length; i++) {
    if (d <= WET[i][0]) {
      const t = Math.log(d / WET[i - 1][0]) / Math.log(WET[i][0] / WET[i - 1][0]);
      return WET[i - 1][1] + t * (WET[i][1] - WET[i - 1][1]);
    }
  }
  return WET[WET.length - 1][1];
}

/** Equal-power near/far weights. */
export function xfade(d: number, start: number, end: number) {
  const t = clamp(Math.log(Math.max(d, 1) / start) / Math.log(end / start), 0, 1);
  return { near: Math.cos(t * Math.PI * 0.5), far: Math.sin(t * Math.PI * 0.5) };
}

/** Everything the engine would compute for a sound at distance d (used by the engine and by the checks). */
export function spatialParams(def: SoundDef, d: number, rangeOverride?: number, farDef?: SoundDef) {
  const { ref, range, k } = lawFor(def, rangeOverride);
  const a = distGain(d, ref, range, k);
  const w = def.far ? xfade(d, def.far.start, def.far.end) : { near: 1, far: 0 };
  const cutN = excessCutoff(d, def.render ?? 0) * 1.3;
  const cutF = def.far ? excessCutoff(d, farDef?.render ?? 0) * 1.3 : 0;
  const wet = reverbWet(d) * (def.wet ?? 1);
  return {
    ref, range, k,
    dist: a, // distance attenuation
    gain: def.vol * a, // direct gain at the listener
    send: def.vol * Math.pow(a, 0.75) * wet, // reverb send (falls slower than the direct sound → rising wet/dry)
    nearW: w.near, farW: w.far * (def.far?.gain ?? 1),
    cutoffNear: Math.min(22000, cutN),
    cutoffFar: Math.min(22000, cutF),
    delay: d / SPEED_OF_SOUND,
  };
}

/** Slow-motion playback rate for a given time scale (1 at ≥ 1×). */
export function timeRateFor(scale: number) {
  if (scale >= 1 || scale <= 0) return 1;
  return Math.max(0.35, Math.sqrt(scale));
}
