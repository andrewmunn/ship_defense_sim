import * as THREE from 'three';
import { PartBuilder, M, V3, box, cyl, cylZ, beam, rod, DEG } from './geom';

type Mats = Record<string, THREE.Material>;

/**
 * Raked tripod main mast of the Vanguard class: two splayed forward legs, one aft leg, raked aft,
 * with horizon-search radar platform, surface-search radar platform, yardarm and TACAN topmast.
 * Returns named rotating radars as separate groups.
 */
export function buildMast(pb: PartBuilder, root: THREE.Object3D, mats: Mats, baseY: number) {
  const P = (mat: string, gm: [THREE.BufferGeometry, THREE.Matrix4]) => pb.addOwned(mat, gm[0], gm[1]);
  const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const FLb: V3 = [2.25, baseY, 20.6], FRb: V3 = [-2.25, baseY, 20.6], Ab: V3 = [0, baseY, 12.6];
  const topY = 33.2;
  const FLt: V3 = [0.55, topY, 15.1], FRt: V3 = [-0.55, topY, 15.1], At: V3 = [0, topY, 13.3];
  // legs: large round tubes
  const leg = (a: V3, b: V3, r: number) => {
    const [g, m] = rod(new THREE.Vector3(...a), new THREE.Vector3(...b), r, 16, r * 0.6);
    pb.addOwned('paint', g, m);
  };
  leg(FLb, FLt, 0.3);
  leg(FRb, FRt, 0.3);
  leg(Ab, At, 0.26);
  // leg feet (stealthy fairings)
  for (const b of [FLb, FRb, Ab]) pb.add('paint', cyl(0.36, 0.48, 0.6, 16), M(b[0], b[1] + 0.3, b[2]));
  // horizontal struts at a few levels + light diagonals
  const levels = [0.3, 0.66, 0.93];
  levels.forEach((t) => {
    const a = lerp3(FLb, FLt, t), b = lerp3(FRb, FRt, t), c = lerp3(Ab, At, t);
    P('paintFine', beam(a, b, 0.12));
    P('paintFine', beam(a, c, 0.11));
    P('paintFine', beam(b, c, 0.11));
  });
  for (const [t0, t1] of [[0.0, 0.3], [0.3, 0.66]]) {
    const a0 = lerp3(FLb, FLt, t0), b0 = lerp3(FRb, FRt, t0), a1 = lerp3(FLb, FLt, t1), b1 = lerp3(FRb, FRt, t1);
    const c0 = lerp3(Ab, At, t0), c1 = lerp3(Ab, At, t1);
    P('paintFine', beam(a0, b1, 0.08));
    P('paintFine', beam(b0, a1, 0.08));
    P('paintFine', beam(a0, c1, 0.07));
    P('paintFine', beam(b0, c1, 0.07));
  }
  // ladder on aft leg
  const [lg, lm] = rod(new THREE.Vector3(Ab[0] + 0.3, Ab[1], Ab[2] - 0.35), new THREE.Vector3(At[0] + 0.3, At[1], At[2] - 0.35), 0.025, 6);
  pb.addOwned('darkSteel', lg, lm);

  // ---- platforms
  const platform = (t: number, fwdExt: number, w: number, depth: number) => {
    const a = lerp3(FLb, FLt, t), c = lerp3(Ab, At, t);
    const y = a[1];
    const zc = (a[2] + c[2]) / 2 + fwdExt / 2;
    pb.add('deckPlain', box(w, 0.12, depth + fwdExt), M(0, y, zc));
    pb.add('paintFine', box(w + 0.1, 0.18, depth + fwdExt + 0.1), M(0, y - 0.12, zc));
    // railings
    const zf = zc + (depth + fwdExt) / 2, zb = zc - (depth + fwdExt) / 2;
    for (const [x0, z0, x1, z1] of [[w / 2, zb, w / 2, zf], [-w / 2, zb, -w / 2, zf], [-w / 2, zf, w / 2, zf]] as [number, number, number, number][]) {
      for (const h of [0.55, 1.0]) {
        const [g, m] = rod(new THREE.Vector3(x0, y + h, z0), new THREE.Vector3(x1, y + h, z1), 0.02, 5);
        pb.addOwned('wire', g, m);
      }
      const n = Math.max(2, Math.round(Math.hypot(x1 - x0, z1 - z0) / 1.0));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n, z = z0 + ((z1 - z0) * k) / n;
        pb.add('wire', cyl(0.022, 0.022, 1.0, 5), M(x, y + 0.5, z));
      }
    }
    return { y, zf, zc };
  };
  const pQ = platform(0.3, 2.4, 3.2, 3.6); // horizon-search radar platform
  const pS = platform(0.66, 1.9, 2.6, 2.2); // surface-search radar platform
  const pY = lerp3(FLb, FLt, 0.93);

  // ---- horizon-search radar (rotating back-to-back antenna; separate named object)
  const horiz = new THREE.Group();
  horiz.name = 'radar_horizon';
  horiz.position.set(0, pQ.y + 0.06, pQ.zf - 1.05);
  const sq = new PartBuilder();
  sq.add('paintFine', cyl(0.28, 0.35, 0.55, 16), M(0, 0.27, 0));
  // back-to-back antenna: two slightly curved panels, 1.8 m wide
  sq.add('paintFine', box(1.9, 0.95, 0.3), M(0, 1.05, 0));
  sq.add('darkSteel', box(1.95, 0.08, 0.34), M(0, 1.55, 0));
  sq.add('darkSteel', box(1.95, 0.08, 0.34), M(0, 0.55, 0));
  sq.build(horiz, mats, 'radar_horizon');
  root.add(horiz);

  // ---- surface-search radar antenna (rotating)
  const surf = new THREE.Group();
  surf.name = 'radar_surface';
  surf.position.set(0, pS.y + 0.06, pS.zf - 0.9);
  const sp = new PartBuilder();
  sp.add('darkSteel', cyl(0.18, 0.22, 0.45, 12), M(0, 0.22, 0));
  sp.add('paintFine', box(0.5, 0.25, 0.4), M(0, 0.5, 0));
  // slotted waveguide array + reflector (about 3 m wide), faces +Z
  sp.add('paintFine', box(3.1, 0.34, 0.18), M(0, 0.82, 0.12));
  sp.add('black', box(3.0, 0.08, 0.03), M(0, 0.82, 0.22));
  sp.add('paintFine', box(3.1, 0.06, 0.5), M(0, 1.0, 0.0, -12 * DEG));
  sp.add('paintFine', box(3.1, 0.06, 0.5), M(0, 0.64, 0.0, 12 * DEG));
  sp.build(surf, mats, 'radar_surface');
  root.add(surf);

  // ---- yardarm with antennas and lights
  const yy = pY[1], yz = pY[2];
  pb.add('paint', box(9.5, 0.28, 0.35), M(0, yy, yz));
  for (const sx of [1, -1]) {
    // brace
    const [g, m] = rod(new THREE.Vector3(sx * 4.3, yy, yz), new THREE.Vector3(sx * 0.4, yy - 1.8, yz + 0.3), 0.05, 6);
    pb.addOwned('paintFine', g, m);
    // hanging dipoles / UHF antennas
    for (const x of [2.0, 3.0, 4.1]) {
      pb.add('paintFine', cyl(0.035, 0.05, 1.1, 6), M(sx * x, yy + 0.65, yz));
      pb.add('paintFine', cyl(0.07, 0.07, 0.12, 8), M(sx * x, yy + 0.2, yz));
    }
    pb.add('paintFine', box(0.5, 0.08, 0.08), M(sx * 3.5, yy + 0.9, yz));
    // yard lights
    pb.add('lamp', new THREE.SphereGeometry(0.1, 8, 6), M(sx * 4.7, yy + 0.2, yz));
    // ESM/DF small radomes at yard ends
    pb.add('radome', cyl(0.22, 0.22, 0.45, 14), M(sx * 3.1, yy + 0.38, yz));
  }
  // ---- topmast + TACAN + masthead
  const top: V3 = [0, topY, 14.4];
  pb.add('paint', box(1.4, 0.5, 2.3), M(top[0], top[1] + 0.2, top[2]));
  pb.add('paintFine', cyl(0.18, 0.24, 3.4, 12), M(0, topY + 2.1, 14.3));
  pb.add('darkSteel', cyl(0.5, 0.5, 0.2, 20), M(0, topY + 3.9, 14.3));
  // TACAN: array of vertical dipoles around a cylinder
  pb.add('radome', cyl(0.42, 0.42, 1.25, 24), M(0, topY + 4.65, 14.3));
  for (const dy of [-0.4, 0, 0.4]) pb.add('paintFine', cyl(0.46, 0.46, 0.06, 24), M(0, topY + 4.65 + dy, 14.3));
  pb.add('darkSteel', cyl(0.46, 0.46, 0.08, 24), M(0, topY + 5.3, 14.3));
  pb.add('darkSteel', cyl(0.05, 0.05, 1.9, 6), M(0, topY + 6.25, 14.3));
  pb.add('lamp', new THREE.SphereGeometry(0.1, 8, 6), M(0, topY + 7.2, 14.3));
  // anemometers / small whips at the masthead
  for (const sx of [1, -1]) {
    pb.add('darkSteel', cyl(0.025, 0.025, 1.4, 6), M(sx * 0.6, topY + 1.1, 15.2));
    pb.add('darkSteel', cylZ(0.08, 0.08, 0.3, 8), M(sx * 0.6, topY + 1.85, 15.2));
  }
  // extra whips, lights and wind birds on the topmast
  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * Math.PI * 2;
    const x = Math.cos(ang) * 0.6, z = 14.3 + Math.sin(ang) * 0.6;
    pb.add('darkSteel', cyl(0.015, 0.025, 1.2 + (k % 3) * 0.5, 5), M(x, topY + 3.5 + (k % 3) * 0.25, z));
  }
  pb.add('darkSteel', cylZ(0.05, 0.05, 1.2, 6), M(0, topY + 5.8, 14.3));
  pb.add('lamp', new THREE.SphereGeometry(0.08, 8, 6), M(0.6, topY + 5.8, 14.3));
  pb.add('red', new THREE.SphereGeometry(0.08, 8, 6), M(-0.6, topY + 5.8, 14.3));
  // navigation radar antenna (small, on the upper platform aft)
  pb.add('darkSteel', box(1.9, 0.18, 0.22), M(0, pS.y + 0.9, pS.zc - 1.0));
  pb.add('paintFine', cyl(0.12, 0.15, 0.7, 10), M(0, pS.y + 0.45, pS.zc - 1.0));
  // signal halyards from the yardarm down to the 05 level
  for (const sx of [1, -1]) for (const dx of [3.9, 4.4]) {
    const [hg, hm] = rod(new THREE.Vector3(sx * dx, yy, yz), new THREE.Vector3(sx * (dx - 1.2), baseY + 0.2, 9.8), 0.008, 3);
    pb.addOwned('wire', hg, hm);
  }
  const mastTop = new THREE.Object3D();
  mastTop.name = 'mast_top';
  mastTop.position.set(0, topY + 7.3, 14.3);
  root.add(mastTop);
  // SATCOM-ish small domes on the horizon-search platform sides
  for (const sx of [1, -1]) pb.add('radome', new THREE.SphereGeometry(0.45, 18, 10), M(sx * 1.2, pQ.y + 0.55, pQ.zc - 1.2));
  return { topY };
}
