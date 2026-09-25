import { GRAVITY } from '../core/constants';
import { Rng } from '../core/rng';

/**
 * Shared Gerstner wave spectrum. The exact same set of waves is evaluated on the GPU
 * (ocean vertex shader) and on the CPU (ship buoyancy, splashes, camera clamp) so
 * objects float on the rendered surface.
 */
export interface Wave {
  dirX: number;
  dirZ: number;
  k: number; // wavenumber 2π/L
  amp: number; // m
  steep: number; // Gerstner Q (0..1)
  omega: number; // angular frequency
  phase: number;
}

export const MAX_WAVES = 16;

export class WaveField {
  waves: Wave[] = [];
  seaState = 3;
  windDir = 0.6; // radians, direction waves travel toward (in XZ: dir = (cos, sin))
  constructor(seaState = 3, windDir = 0.6) {
    this.set(seaState, windDir);
  }

  /** Significant wave height per (approx.) Douglas sea state. */
  static hs(seaState: number) {
    return [0.05, 0.1, 0.4, 1.0, 1.9, 3.2, 5.0][Math.max(0, Math.min(6, Math.round(seaState)))];
  }

  set(seaState: number, windDir: number) {
    this.seaState = seaState;
    this.windDir = windDir;
    const hs = WaveField.hs(seaState);
    const rng = new Rng(4242);
    this.waves = [];
    // Peak wavelength grows with sea state (fully developed sea, roughly).
    const Lp = 18 + hs * 22;
    const n = MAX_WAVES;
    let sumA2 = 0;
    const raw: { L: number; a: number; ang: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const L = Lp * Math.pow(0.12, t) * (1 + 0.15 * rng.gauss()) * (i === 0 ? 1.6 : 1);
      // amplitude ~ spectrum; longer waves carry more energy
      const a = Math.pow(L / Lp, 1.1);
      const spread = 0.35 + 0.9 * t; // short waves more spread
      const ang = windDir + rng.gauss() * spread;
      raw.push({ L, a, ang });
      sumA2 += a * a;
    }
    // Hs = 4*sqrt(sum(a_i^2)/2) for a sum of sinusoids
    const scale = hs / (4 * Math.sqrt(sumA2 / 2));
    for (const r of raw) {
      const k = (2 * Math.PI) / r.L;
      const amp = r.a * scale;
      const omega = Math.sqrt(GRAVITY * k);
      // Steepness: Q*k*A summed must stay < 1 to avoid loops.
      const steep = Math.min(0.9, 0.55 / Math.max(k * amp * n, 1e-6)) ;
      this.waves.push({ dirX: Math.cos(r.ang), dirZ: Math.sin(r.ang), k, amp, steep: Math.min(steep, 1) * 0.9, omega, phase: rng.range(0, Math.PI * 2) });
    }
  }

  /**
   * Gerstner displacement at undisplaced horizontal position (x, z), time t.
   * Returns [dx, dy, dz].
   */
  displacement(x: number, z: number, t: number, out: number[] = [0, 0, 0]) {
    let dx = 0, dy = 0, dz = 0;
    for (const w of this.waves) {
      const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase;
      const c = Math.cos(th), s = Math.sin(th);
      const qa = w.steep * w.amp;
      dx += qa * w.dirX * c;
      dz += qa * w.dirZ * c;
      dy += w.amp * s;
    }
    out[0] = dx; out[1] = dy; out[2] = dz;
    return out;
  }

  /** Surface height (relative to the mean sphere) at the displaced horizontal position (x, z). */
  heightAt(x: number, z: number, t: number) {
    // Invert the horizontal Gerstner displacement with a few fixed-point iterations.
    let px = x, pz = z;
    const d = this._d;
    for (let i = 0; i < 3; i++) {
      this.displacement(px, pz, t, d);
      px = x - d[0];
      pz = z - d[2];
    }
    this.displacement(px, pz, t, d);
    return d[1];
  }
  private _d = [0, 0, 0];

  /** Surface normal (approx, from finite differences of heightAt). */
  normalAt(x: number, z: number, t: number, e = 1.5) {
    const hL = this.heightAt(x - e, z, t), hR = this.heightAt(x + e, z, t);
    const hD = this.heightAt(x, z - e, t), hU = this.heightAt(x, z + e, t);
    const nx = -(hR - hL) / (2 * e), nz = -(hU - hD) / (2 * e);
    const l = Math.hypot(nx, 1, nz);
    return [nx / l, 1 / l, nz / l];
  }
}
