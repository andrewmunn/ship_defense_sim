import * as THREE from 'three';
import { V2, offsetPoly, prismBetween } from './geom';

/** Mirror a port-side half outline (x>=0, ordered bow->stern) into a full closed polygon. */
export function sym(half: V2[]): V2[] {
  const port = half.map(([x, z]) => [x, z] as V2);
  const stbd = [...half].reverse().map(([x, z]) => [-x, z] as V2);
  // drop duplicated centerline points
  const out: V2[] = [];
  for (const p of [...port, ...stbd]) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    out.push(p);
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
  }
  return out;
}

/**
 * A faceted deckhouse block: plan polygon at y0, inward-offset polygon at y1.
 * Provides face-attachment frames for placing arrays, windows, doors.
 */
export class Block {
  bot: V2[];
  top: V2[];
  constructor(public poly: V2[], public y0: number, public y1: number, slopeDeg: number | number[], topPoly?: V2[]) {
    this.bot = poly;
    const h = y1 - y0;
    const d = Array.isArray(slopeDeg) ? slopeDeg.map((s) => Math.tan((s * Math.PI) / 180) * h) : poly.map(() => Math.tan((slopeDeg * Math.PI) / 180) * h);
    this.top = topPoly ?? offsetPoly(poly, d);
  }
  geometry(capTop = true, capBot = false) {
    return prismBetween(this.bot, this.y0, this.top, this.y1, capTop, capBot);
  }
  /** Point on face `e` (edge poly[e] -> poly[e+1]) at edge fraction s (0..1) and height fraction h (0..1). */
  facePoint(e: number, s: number, h: number) {
    const n = this.bot.length;
    const j = (e + 1) % n;
    const b = [this.bot[e][0] + (this.bot[j][0] - this.bot[e][0]) * s, this.bot[e][1] + (this.bot[j][1] - this.bot[e][1]) * s];
    const t = [this.top[e][0] + (this.top[j][0] - this.top[e][0]) * s, this.top[e][1] + (this.top[j][1] - this.top[e][1]) * s];
    return new THREE.Vector3(b[0] + (t[0] - b[0]) * h, this.y0 + (this.y1 - this.y0) * h, b[1] + (t[1] - b[1]) * h);
  }
  /** Height fraction on face for absolute y. */
  hf(y: number) {
    return (y - this.y0) / (this.y1 - this.y0);
  }
  /** Edge-fraction for an absolute distance along the bottom edge (meters from start). */
  edgeLen(e: number) {
    const n = this.bot.length;
    const j = (e + 1) % n;
    return Math.hypot(this.bot[j][0] - this.bot[e][0], this.bot[j][1] - this.bot[e][1]);
  }
  /**
   * Local frame on a face: X along edge (start->end), Y up the face (tilted), Z outward normal.
   * Returns matrix placing local origin at (s,h) on the face, offset outward by `off`.
   */
  faceFrame(e: number, s: number, h: number, off = 0): THREE.Matrix4 {
    const p = this.facePoint(e, s, h);
    const n = this.bot.length;
    const j = (e + 1) % n;
    const ex = new THREE.Vector3(this.bot[j][0] - this.bot[e][0], 0, this.bot[j][1] - this.bot[e][1]).normalize();
    const up = this.facePoint(e, s, 1).sub(this.facePoint(e, s, 0)).normalize();
    let nz = new THREE.Vector3().crossVectors(ex, up).normalize();
    // make nz outward: compare with vector from polygon centroid
    let cx = 0, cz = 0;
    for (const [x, z] of this.bot) { cx += x; cz += z; }
    cx /= this.bot.length; cz /= this.bot.length;
    const outward = new THREE.Vector3(p.x - cx, 0, p.z - cz);
    let ex2 = ex.clone();
    if (nz.dot(outward) < 0) {
      // flip X so that frame is right-handed with outward Z
      ex2 = ex.clone().negate();
      nz = new THREE.Vector3().crossVectors(ex2, up).normalize();
    }
    const y = new THREE.Vector3().crossVectors(nz, ex2).normalize();
    const m = new THREE.Matrix4().makeBasis(ex2, y, nz);
    m.setPosition(p.clone().addScaledVector(nz, off));
    return m;
  }
}
