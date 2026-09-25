import * as THREE from 'three';
import { PartBuilder, M, box, cyl, cylZ, rng } from './geom';
import { Block } from './block';

/** Small fittings placed on superstructure faces. Local face frame: X along face, Y up-face, Z outward. */

export function door(pb: PartBuilder, fm: THREE.Matrix4) {
  // raised frame (coaming) + dark gap + door leaf + dogs + hinges
  pb.add('paintFine', box(1.0, 1.95, 0.05), fm.clone().multiply(M(0, 0, 0.025)));
  pb.add('black', box(0.84, 1.76, 0.02), fm.clone().multiply(M(0, 0, 0.055)));
  pb.add('paintFine', box(0.78, 1.7, 0.05), fm.clone().multiply(M(0, 0, 0.08)));
  pb.add('darkSteel', box(1.1, 0.05, 0.12), fm.clone().multiply(M(0, 1.02, 0.06)));
  for (const dy of [-0.6, 0, 0.6]) {
    pb.add('darkSteel', box(0.14, 0.04, 0.06), fm.clone().multiply(M(0.3, dy, 0.12)));
    pb.add('darkSteel', box(0.06, 0.16, 0.06), fm.clone().multiply(M(-0.41, dy, 0.1)));
  }
}
export function louver(pb: PartBuilder, fm: THREE.Matrix4, w = 1.1, h = 0.7) {
  pb.add('darkSteel', box(w, h, 0.04), fm.clone().multiply(M(0, 0, 0.02)));
  const n = Math.max(3, Math.round(h / 0.1));
  for (let i = 0; i < n; i++) pb.add('paintFine', box(w - 0.04, 0.03, 0.07), fm.clone().multiply(M(0, -h / 2 + (i + 0.5) * (h / n), 0.05, -0.5)));
  pb.add('paintFine', box(w + 0.08, h + 0.08, 0.03), fm.clone().multiply(M(0, 0, 0.012)));
}
export function lightFix(pb: PartBuilder, fm: THREE.Matrix4) {
  pb.add('paintFine', box(0.18, 0.12, 0.2), fm.clone().multiply(M(0, 0, 0.1)));
  pb.add('lamp', cylZ(0.07, 0.07, 0.04, 10), fm.clone().multiply(M(0, -0.02, 0.21)));
}
export function jbox(pb: PartBuilder, fm: THREE.Matrix4, w = 0.35, h = 0.45) {
  pb.add('paintFine', box(w, h, 0.16), fm.clone().multiply(M(0, 0, 0.08)));
  pb.add('darkSteel', cyl(0.025, 0.025, 0.4, 6), fm.clone().multiply(M(w * 0.3, -h / 2 - 0.2, 0.08)));
}
export function ladder(pb: PartBuilder, fm: THREE.Matrix4, h: number) {
  for (const sx of [-0.22, 0.22]) pb.add('paintFine', box(0.05, h, 0.05), fm.clone().multiply(M(sx, h / 2, 0.18)));
  for (let y = 0.3; y < h; y += 0.3) pb.add('paintFine', cyl(0.018, 0.018, 0.44, 5), fm.clone().multiply(M(0, y, 0.18, 0, 0, Math.PI / 2)));
  for (const y of [0.4, h - 0.4]) for (const sx of [-0.22, 0.22]) pb.add('paintFine', box(0.04, 0.04, 0.16), fm.clone().multiply(M(sx, y, 0.08)));
}
export function pipeRun(pb: PartBuilder, fm: THREE.Matrix4, len: number) {
  pb.add('paintFine', cyl(0.045, 0.045, len, 6), fm.clone().multiply(M(0, 0, 0.1, 0, 0, Math.PI / 2)));
  for (let x = -len / 2 + 0.3; x < len / 2; x += 1.2) pb.add('paintFine', box(0.05, 0.12, 0.1), fm.clone().multiply(M(x, 0, 0.05)));
}

export interface FaceSpec {
  e: number;
  doors?: number[]; // edge fractions
  louvers?: [number, number][]; // [s, yAbs]
  lights?: number;
  boxes?: number;
  ladders?: number[];
  pipes?: number; // yAbs of a horizontal pipe run
  drip?: boolean;
  s0?: number; // usable range
  s1?: number;
}

/** Apply details to faces of a block. `deckY` = floor height for doors at the base of this block. */
export function detailBlock(pb: PartBuilder, b: Block, specs: FaceSpec[], seed: number, floor?: number | ((x: number, z: number) => number)) {
  const r = rng(seed);
  const fAt = (e: number, s: number) => {
    if (floor === undefined) return b.y0;
    if (typeof floor === 'number') return floor;
    const p = b.facePoint(e, s, 0);
    return floor(p.x, p.z);
  };
  for (const sp of specs) {
    const len = b.edgeLen(sp.e);
    const s0 = sp.s0 ?? 0.05, s1 = sp.s1 ?? 0.95;
    for (const s of sp.doors ?? []) door(pb, b.faceFrame(sp.e, s, b.hf(fAt(sp.e, s) + 1.05), 0));
    for (const [s, y] of sp.louvers ?? []) louver(pb, b.faceFrame(sp.e, s, b.hf(y), 0));
    for (let i = 0; i < (sp.lights ?? 0); i++) { const s = s0 + (s1 - s0) * r(); lightFix(pb, b.faceFrame(sp.e, s, b.hf(fAt(sp.e, s) + 2.2 + r() * 0.2), 0)); }
    for (let i = 0; i < (sp.boxes ?? 0); i++) { const s = s0 + (s1 - s0) * r(); jbox(pb, b.faceFrame(sp.e, s, b.hf(fAt(sp.e, s) + 0.9 + r() * 1.1), 0), 0.25 + r() * 0.3, 0.3 + r() * 0.4); }
    for (const s of sp.ladders ?? []) ladder(pb, b.faceFrame(sp.e, s, 0.0, 0), b.y1 - b.y0 + 1.0);
    if (sp.pipes !== undefined) pipeRun(pb, b.faceFrame(sp.e, (s0 + s1) / 2, b.hf(sp.pipes), 0), len * (s1 - s0));
    if (sp.drip !== false) {
      // drip/edge rail along the top edge
      const fm = b.faceFrame(sp.e, 0.5, 0.985, 0.05);
      pb.add('paintFine', box(len * 0.99, 0.08, 0.1), fm);
    }
  }
}
