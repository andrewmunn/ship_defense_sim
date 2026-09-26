import { fbm2, ridged2 } from '../core/noise';

/**
 * Coastal landmass. Defined over world XZ (which approximates surface coordinates near the origin).
 * The coast runs perpendicular to `bearing` at `distance` from the origin.
 */
export class Terrain {
  cx = 0;
  cz = -1;
  constructor(public bearing = (40 * Math.PI) / 180, public distance = 45000) {
    this.set(bearing, distance);
  }
  set(bearing: number, distance: number) {
    this.bearing = bearing;
    this.distance = distance;
    this.cx = Math.sin(bearing);
    this.cz = -Math.cos(bearing);
  }
  /** Signed inland distance (m): >0 on land (before height shaping). */
  inland(x: number, z: number) {
    const along = x * -this.cz + z * this.cx;
    const s = x * this.cx + z * this.cz - this.distance;
    const wig = (fbm2(along / 22000, 3.1, 4, 5) - 0.5) * 14000 + (fbm2(along / 4000, 7.7, 3, 9) - 0.5) * 2200;
    // A finite continent (so orbital views show a natural landmass, not a clipped rectangle):
    // the coast curls back into capes ~150 km either side, and the land ends ~300 km inland.
    const endJit = (fbm2(along / 60000 + 13, s / 60000, 3, 57) - 0.5) * 60000;
    const curl = Math.max(0, Math.abs(along) - 150000 + endJit) * 2.5;
    const back = 300000 + (fbm2(along / 70000, 9.1, 3, 58) - 0.5) * 80000 - s;
    return Math.min(s + wig - curl, back);
  }
  /** Height above sea level (m); negative = seabed (not rendered). */
  height(x: number, z: number) {
    const s = this.inland(x, z);
    if (s < -3000) return -50;
    const along = x * -this.cz + z * this.cx;
    const u = along / 1000, v = s / 1000;
    const beach = Math.min(1, Math.max(0, s / 600));
    const hills = fbm2(u / 6, v / 6, 5, 21) * 260 * smooth(0, 4000, s);
    const mtnMask = smooth(5000, 26000, s) * (0.55 + 0.75 * fbm2(u / 30, v / 30, 3, 40));
    // domain-warped ridges (less maze-like from altitude); rule-of-cool: a tall range visible over the horizon
    const wu = u + (fbm2(u / 40, v / 40, 3, 91) - 0.5) * 18, wv = v + (fbm2(u / 40 + 7, v / 40, 3, 92) - 0.5) * 18;
    const mtn = ridged2(wu / 14, wv / 14, 6, 33) * 3400 * mtnMask;
    let h = beach * 6 + hills + mtn + (s < 0 ? s * 0.02 : 0);
    // islands offshore
    if (s < 0) {
      // offshore islands in a band 2–14 km off the beach, faded out before the shore (no cliffs / sandbar lines)
      const isl = fbm2(u / 3.5, v / 3.5, 4, 77);
      const mask = smooth(-14000, -7000, s) * (1 - smooth(-2200, -600, s));
      const ih = ((isl - 0.7) * 1600 - 40) * mask - 40 * (1 - mask);
      h = Math.max(h, ih);
    }
    return h;
  }
}
function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
