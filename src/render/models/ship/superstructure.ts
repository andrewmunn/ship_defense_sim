import * as THREE from 'three';
import { PartBuilder, M, V2, V3, box, cyl, cylZ, prismBetween, DEG, normalizeGeo, offsetPoly } from './geom';
const offsetPolyIn = offsetPoly;
import { Block, sym } from './block';
import { profileSolid } from './geom';
import { LAYOUT as L, deckAt, deckY } from './hulldef';
import { detailBlock, louver, lightFix, jbox } from './facedetail';

/** Slopes for a sym() polygon: halfSlopes for port edges (k-1 values), aft edge, front edge. */
export function symSlopes(half: number[], aft: number, front: number) {
  return [...half, aft, ...[...half].reverse(), front];
}

export interface SSAnchors {
  ciwsFwd: V3;
  illumFwd: V3;
  illumAft: V3[];
  ciwsAft: V3;
  mastBaseY: number;
  funnels: { name: 'fwd' | 'aft'; exhausts: V3[] }[];
  decoyLaunchers: { pos: V3; outward: number }[]; // outward = +1 port, -1 stbd
  bridgeCam: V3;
  arrays: THREE.Matrix4[];
  hangarDoors: { x: number; z: number; w: number; h: number; y: number }[];
  vlsAftDeckY: number;
  blocks: Record<string, Block>;
}

export function buildSuperstructure(pb: PartBuilder): SSAnchors {
  const P = (mat: string, g: THREE.BufferGeometry, m?: THREE.Matrix4) => pb.addOwned(mat, g, m);

  // ------------------------------------------------ forward 01 deckhouse
  const f01h: V2[] = [[4.3, L.ss01Front], [7.7, 31.8], [8.8, 29.4], [8.9, 7.8], [7.6, 6.6]];
  const fwd01 = new Block(sym(f01h), 6.4, L.lvl01, symSlopes([14, 10, 8, 8], 0, 14));
  P('paint', fwd01.geometry());

  // ------------------------------------------------ tower 1 (02/03 levels, forward Sentinel arrays)
  const t1h: V2[] = [[3.2, 30.5], [8.6, 25.0], [8.6, 14.6]];
  const tower1 = new Block(sym(t1h), L.lvl01, L.lvl03, symSlopes([15, 10], 0, 12));
  P('paint', tower1.geometry());
  // ------------------------------------------------ tower 2 (aft arrays, raised one deck)
  const t2h: V2[] = [[8.6, 17.5], [8.6, 7.4], [3.55, 2.4]];
  const tower2 = new Block(sym(t2h), L.lvl01, L.lvl05, symSlopes([10, 14], 0, 0));
  P('paint', tower2.geometry());

  // chamfer band (stealth knuckle) between 01 and tower: a thin sloped skirt
  // ------------------------------------------------ pilothouse (04)
  const phh: V2[] = [[4.2, 29.3], [6.45, 27.1], [6.7, 14.8]];
  const pilot = new Block(sym(phh), L.lvl03, L.bridgeRoof, symSlopes([-12, 6], 0, -12));
  P('paint', pilot.geometry());
  // bridge windows: front + angled faces (edges: 0 port angled, last = front center, and stbd angled)
  const nE = pilot.bot.length;
  const winFaces = [0, nE - 1, nE - 2];
  const hw0 = pilot.hf(16.15), hw1 = pilot.hf(17.7);
  for (const e of winFaces) {
    const len = pilot.edgeLen(e);
    const nWin = Math.max(2, Math.round(len / 1.15));
    for (let i = 0; i < nWin; i++) {
      const s0 = (i + 0.08) / nWin, s1 = (i + 0.92) / nWin;
      P('glass', quadOnFace(pilot, e, s0, s1, hw0, hw1, 0.02));
    }
    // sun visor / eyebrow above windows
    P('paintFine', stripOnFace(pilot, e, 0.0, 1.0, pilot.hf(17.85), 0.3, 0.06));
  }
  // side windows on pilothouse (small)
  for (const e of [1, nE - 3]) {
    for (let i = 0; i < 3; i++) {
      const s0 = e === 1 ? 0.25 + i * 0.1 : 0.68 + i * 0.1, s1 = s0 + 0.07;
      P('glass', quadOnFace(pilot, e, s0, s1, hw0, hw1, 0.02));
    }
  }
  // bridge wings
  for (const sx of [1, -1]) {
    const z0 = 24.7, z1 = 27.5, x0 = 6.2, x1 = 9.55;
    P('paint', box(x1 - x0, 0.28, z1 - z0), M(sx * (x0 + x1) / 2, L.lvl03 - 0.14, (z0 + z1) / 2));
    // bulwark plates
    P('paintFine', box(0.06, 1.1, z1 - z0), M(sx * x1, L.lvl03 + 0.55, (z0 + z1) / 2));
    P('paintFine', box(x1 - 7.3, 1.1, 0.06), M(sx * (x1 + 7.3) / 2, L.lvl03 + 0.55, z1));
    P('paintFine', box(x1 - 7.0, 1.1, 0.06), M(sx * (x1 + 7.0) / 2, L.lvl03 + 0.55, z0));
    // bracket underneath
    const br = prismBetween([[0, 0], [0, 0.1], [2.4, 0.1], [2.4, 0]], 0, [[0, 0], [0, 0.1], [2.4, 0.1], [2.4, 0]], 0.1, true, true);
    void br;
    // closed, chamfered underside (sloped ~35 deg) instead of open brackets
    {
      const xa = 7.0, xb = 9.55, yT = L.lvl03 - 0.28, yB = L.lvl03 - 2.2;
      const prof: V2[] = [[z0, yT], [z1, yT], [z1 - 0.6, yB], [z0 + 0.6, yB]];
      const w = (xb - xa) / 2;
      const g = profileSolid(prof, [w, w, w * 0.2, w * 0.2]);
      // shift so the narrow bottom hugs the tower and the wide top meets the wing
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i), x = p.getX(i);
        const t = (y - yB) / (yT - yB);
        const xc = xa + 0.1 + (w * 0.2) + (w - w * 0.2) * t; // centre moves outboard with height
        p.setX(i, sx * (xc + x));
      }
      if (sx < 0) {
        const ix = g.index!.array as unknown as number[];
        for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
      }
      g.computeVertexNormals();
      pb.addOwned('paint', normalizeGeo(g));
    }
    // pelorus / gyro repeater stand on wing
    P('darkSteel', cyl(0.12, 0.15, 1.1, 10), M(sx * 8.9, L.lvl03 + 0.55, 26.1));
    P('darkSteel', cyl(0.2, 0.2, 0.15, 12), M(sx * 8.9, L.lvl03 + 1.15, 26.1));
    // big-eyes binocular
    P('darkSteel', cylZ(0.14, 0.14, 0.9, 10), M(sx * 9.1, L.lvl03 + 1.25, 25.2));
  }

  // ------------------------------------------------ 05 level (above pilothouse)
  const l5h: V2[] = [[2.5, 26.4], [4.2, 24.7], [4.3, 11.8], [3.3, 9.6]];
  const lvl05 = new Block(sym(l5h), L.bridgeRoof, L.lvl05, symSlopes([14, 8, 8], 0, 14));
  P('paint', lvl05.geometry());
  // roof edge railings + small gear on bridge roof
  P('paintFine', box(2.2, 0.9, 1.6), M(4.9, L.bridgeRoof + 0.45, 21.0)); // optical sight housing (port)
  P('radome', new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(4.9, L.bridgeRoof + 0.9, 21.0));
  P('paintFine', box(2.2, 0.9, 1.6), M(-4.9, L.bridgeRoof + 0.45, 21.0));
  P('radome', new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M(-4.9, L.bridgeRoof + 0.9, 21.0));
  // forward Lantern pedestal on 05 roof
  const illumFwd: V3 = [0, L.lvl05 + 1.35, 23.6];
  P('paint', new Block(sym([[1.0, 25.0], [1.3, 24.2], [1.3, 22.6], [0.9, 22.2]]), L.lvl05, L.lvl05 + 1.35, 8).geometry());

  // ------------------------------------------------ forward Sentinel arrays (on tower1 angled faces)
  const arrays: THREE.Matrix4[] = [];
  const t1n = tower1.bot.length;
  for (const e of [0, t1n - 2]) arrays.push(tower1.faceFrame(e, 0.5, tower1.hf(12.75), 0.0));
  const t2n = tower2.bot.length;
  // aft-facing faces of tower2: port edge 1 ((8.05,11.6)->(3.45,7.0)) and its mirror
  for (const e of [1, t2n - 3]) arrays.push(tower2.faceFrame(e, 0.5, tower2.hf(15.2), 0.0));

  // EW suite sponsons on tower1 sides
  for (const sx of [1, -1]) {
    const e = sx > 0 ? 1 : t1n - 3;
    const fm = tower1.faceFrame(e, 0.72, tower1.hf(13.3), 0.55);
    const g = prismBetween([[-1.7, -0.55], [1.7, -0.55], [1.7, 0.55], [-1.7, 0.55]], -1.25, [[-1.55, -0.55], [1.55, -0.55], [1.55, 0.2], [-1.55, 0.2]], 1.25, true, true);
    // local frame of face: X along face, Y up face, Z outward; prism built in (x,z)-plan with y height -> rotate so plan z -> outward
    P('paintFine', g, fm);
    P('paintFine', box(2.6, 0.9, 0.9), fm.clone().multiply(M(0, -1.85, 0.1)));
  }

  // ------------------------------------------------ funnels
  const funnels: SSAnchors['funnels'] = [];
  const mkFunnel = (zc: number, yTop: number, name: 'fwd' | 'aft') => {
    const bh: V2[] = [[2.5, zc + 4.0], [3.4, zc + 3.2], [3.45, zc - 3.6], [2.7, zc - 4.3]];
    const shift = -3.0, sh = 0.85;
    const th: V2[] = bh.map(([x, z]) => [x - sh, z + shift - (z - zc) * 0.12] as V2);
    const bot = sym(bh), top = sym(th);
    const y0 = L.lvl01 - 0.2, yCap = yTop - 2.3;
    // split the tapered body at the base of the stack extension (enclosed stack cap)
    const f = (yCap - y0) / (yTop - y0);
    const mid = bot.map(([x, z], i) => [x + (top[i][0] - x) * f, z + (top[i][1] - z) * f] as V2);
    P('paint', prismBetween(bot, y0, mid, yCap, false, false));
    // stack extension: faceted cap, sides leaning inboard, black band at top, soot below
    const lip = offsetPoly(mid, -0.07);
    P('paintFine', prismBetween(lip, yCap - 0.1, lip, yCap + 0.08, true, true));
    const capTop = offsetPoly(mid, 0.42);
    const capG = normalizeGeo(prismBetween(mid, yCap, capTop, yTop, true, false));
    {
      const pos = capG.attributes.position, uv = capG.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + pos.getZ(i)) / 3, (pos.getY(i) - yCap) / (yTop - yCap));
    }
    pb.addOwned('soot', capG, undefined, { uv: 'keep' });
    // recessed exhaust grille on top: dark plate + grating bars
    const grille = offsetPoly(capTop, 0.18);
    P('black', prismBetween(grille, yTop, grille, yTop + 0.02, true, false));
    // raised lip around the recessed top (0.3 m)
    const lipO = offsetPoly(capTop, -0.02), lipI = offsetPoly(capTop, 0.16);
    for (let i = 0; i < lipO.length; i++) {
      const j = (i + 1) % lipO.length;
      const seg = prismBetween([lipO[i], lipO[j], lipI[j], lipI[i]], yTop, [lipO[i], lipO[j], lipI[j], lipI[i]], yTop + 0.3, true, false);
      P('black', seg);
    }
    const tzc = zc + shift;
    let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
    for (const [x, z] of grille) { gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gz0 = Math.min(gz0, z); gz1 = Math.max(gz1, z); }
    for (let z = gz0 + 0.3; z < gz1 - 0.2; z += 0.35) P('darkSteel', box(gx1 - gx0 - 0.5, 0.08, 0.05), M((gx0 + gx1) / 2, yTop + 0.06, z));
    P('darkSteel', box(0.08, 0.1, gz1 - gz0 - 0.3), M(0, yTop + 0.08, (gz0 + gz1) / 2));
    // exhaust emitters (effect empties) along the grille: 2 x main gas turbine + GTG uptakes
    const ex: V3[] = [[0.9, yTop + 0.1, tzc + 1.4], [-0.9, yTop + 0.1, tzc + 1.4], [0, yTop + 0.1, tzc - 1.4]];
    // small whip/sensor on funnel top edge
    P('darkSteel', cyl(0.03, 0.05, 3.5, 6), M(0, yTop + 1.8, tzc - 3.2));
    // intake/exhaust louvers on funnel sides (dark grilles)
    for (const sx of [1, -1]) {
      for (let k = 0; k < 2; k++) {
        const zz = zc + 1.7 - k * 3.5;
        const yy = L.lvl02 + 1.3;
        const th = Math.atan(0.85 / (yTop - y0)); // side-wall lean
        const xw = 3.45 - (yy - y0) * Math.tan(th);
        const fm = M(sx * xw, yy, zz, 0, 0, sx * th); // local +X = outward normal of this wall (port), frame tilted with the wall
        const out = (d: number) => fm.clone().multiply(M(sx * d, 0, 0));
        P('darkSteel', box(0.05, 2.1, 3.0), out(0.03));
        P('paintFine', box(0.06, 2.3, 3.2), out(0.01));
        for (let q = 0; q < 9; q++) P('paintFine', box(0.14, 0.04, 2.9), out(0.09).multiply(M(0, -0.94 + q * 0.235, 0, 0, 0, sx * -0.5)));
      }
    }
    funnels.push({ name, exhausts: ex });
  };
  mkFunnel(L.fwdFunnelZ, 24.2, 'fwd');
  mkFunnel(L.aftFunnelZ, 22.9, 'aft');

  // ------------------------------------------------ midships 01 and aft deckhouses
  const mid01 = new Block(sym([[7.3, 6.8], [7.3, -10.6]]), 5.9, L.lvl01, symSlopes([8], 0, 8));
  P('paint', mid01.geometry());
  const aft01 = new Block(sym([[7.4, -9.6], [8.6, -12.2], [8.9, -21.3]]), 5.6, L.lvl01, symSlopes([12, 9], 0, 10));
  P('paint', aft01.geometry());
  const aft02 = new Block(sym([[3.9, -9.0], [5.0, -10.6], [5.0, -20.8]]), L.lvl01, L.lvl02, symSlopes([14, 10], 0, 14));
  P('paint', aft02.geometry());
  // fwd funnel base house (02 around funnel, behind tower2)
  const f02 = new Block(sym([[4.4, 7.2], [4.4, -1.9], [3.6, -3.0]]), L.lvl01, L.lvl02, symSlopes([10, 14], 10, 0));
  P('paint', f02.geometry());

  // ------------------------------------------------ hangar block with aft VLS well
  const hz0 = -21.0, hz1 = L.hangarAftZ;
  const hy0 = 4.7, hy1 = L.hangarRoof;
  const wellX = 3.8, wellZ0 = -24.6, wellZ1 = -35.8;
  const hangars: Block[] = [];
  for (const sx of [1, -1]) {
    const poly: V2[] = [[sx * wellX, hz0], [sx * 8.95, hz0], [sx * 9.25, -24.5], [sx * 9.3, hz1], [sx * wellX, hz1]];
    const hb = new Block(poly, hy0, hy1, [0, 10, 9, 0, 0]);
    P('paint', hb.geometry());
    hangars.push(hb);
  }
  const vlsDeck = 8.75;
  P('paint', new Block([[wellX, hz0], [wellX, wellZ0], [-wellX, wellZ0], [-wellX, hz0]], hy0, vlsDeck, 0).geometry());
  P('paint', new Block([[wellX, wellZ0], [wellX, wellZ1], [-wellX, wellZ1], [-wellX, wellZ0]], hy0, vlsDeck, 0).geometry());
  P('paint', new Block([[wellX, wellZ1], [wellX, hz1], [-wellX, hz1], [-wellX, wellZ1]], hy0, hy1, 0).geometry());
  // well coaming
  // raised CIWS house on hangar roof
  const ciwsH = new Block(sym([[1.4, -46.6], [2.1, -47.4], [2.1, -51.2], [1.7, -51.9]]), hy1, 14.0, symSlopes([20, 10, 10], 8, 25));
  P('paint', ciwsH.geometry());
  const ciwsAft: V3 = [0, 14.0 + 0.9, -49.4];
  P('paint', new Block(sym([[1.2, -48.1], [1.5, -48.6], [1.5, -50.2], [1.2, -50.7]]), 14.0, 14.9, 6).geometry());
  // aft Lantern pedestals on hangar roofs flanking the VLS well
  const illumAft: V3[] = [];
  for (const sx of [1, -1]) {
    const x = sx * 6.4, z = -27.6;
    P('paint', cyl(0.75, 0.95, 2.4, 28), M(x, hy1 + 1.2, z));
    P('paintFine', cyl(0.85, 0.85, 0.12, 28), M(x, hy1 + 2.4, z));
    illumAft.push([x, hy1 + 2.46, z]);
  }
  // hangar doors
  const doorY = deckY(hz1) + 0.05;
  const hangarDoors: SSAnchors['hangarDoors'] = [];
  for (const sx of [1, -1]) {
    const x = sx * 6.55, w = 4.6, h = 4.75;
    hangarDoors.push({ x, z: hz1, w, h, y: doorY });
    P('darkSteel', box(w + 0.4, h + 0.25, 0.1), M(x, doorY + (h + 0.25) / 2, hz1 - 0.03));
    P('paintFine', box(w, h, 0.12), M(x, doorY + h / 2, hz1 - 0.1));
    for (let k = 0; k < 15; k++) P('paintFine', box(w, 0.05, 0.06), M(x, doorY + 0.3 + k * 0.3, hz1 - 0.18));
  }
  // flight-deck floodlights on the hangar face
  for (const x of [-8.6, -3.2, 3.2, 8.6]) {
    P('paintFine', box(0.4, 0.3, 0.35), M(x, hy1 - 0.4, hz1 - 0.2));
    P('lamp', box(0.32, 0.2, 0.02), M(x, hy1 - 0.45, hz1 - 0.38, 0.3));
  }
  // helicopter control station windows (aft face center)
  for (let i = 0; i < 3; i++) P('glass', box(0.9, 0.7, 0.05), M(-1.1 + i * 1.1, hy1 - 1.1, hz1 - 0.04));

  // ------------------------------------------------ forward CIWS plinth on 01 roof
  const ciwsFwd: V3 = [0, L.lvl01 + 1.45, 32.0];
  P('paint', new Block(sym([[1.1, 33.4], [1.5, 32.9], [1.5, 31.0], [1.1, 30.5]]), L.lvl01, L.lvl01 + 1.45, 8).geometry());

  // ------------------------------------------------ face details: doors, louvers, lights, boxes, ladders, drip rails
  const deckF = (x: number, z: number) => deckAt(x, z);
  detailBlock(pb, fwd01, [
    { e: 0, lights: 1, boxes: 1 }, { e: 1, drip: true }, { e: 2, doors: [0.14, 0.58], louvers: [[0.3, 8.3]], lights: 2, boxes: 2, pipes: 9.45 }, { e: 3 },
    { e: 5 }, { e: 6, doors: [0.42, 0.86], louvers: [[0.7, 8.3]], lights: 2, boxes: 2, pipes: 9.45 }, { e: 7 }, { e: 8, lights: 1, boxes: 1 },
    { e: 9 },
  ], 11, deckF);
  detailBlock(pb, tower1, [
    { e: 1, doors: [0.3], louvers: [[0.85, 10.9]], lights: 1, boxes: 1, s0: 0.2, s1: 0.95 },
    { e: 3, doors: [0.7], louvers: [[0.15, 10.9]], lights: 1, boxes: 1, s0: 0.05, s1: 0.8 },
    { e: 5, lights: 1 },
    { e: 0, drip: true }, { e: 4, drip: true },
  ], 12, L.lvl01);
  detailBlock(pb, tower2, [
    { e: 0, doors: [0.25], louvers: [[0.55, 10.9]], lights: 1, boxes: 1, ladders: [0.9] },
    { e: 4, doors: [0.75], louvers: [[0.45, 10.9]], lights: 1, boxes: 1, ladders: [0.1] },
    { e: 1 }, { e: 3 },
  ], 13, L.lvl01);
  detailBlock(pb, pilot, [{ e: 1, doors: [0.12], lights: 1 }, { e: 3, doors: [0.88], lights: 1 }], 14, L.lvl03);
  detailBlock(pb, lvl05, [{ e: 1, louvers: [[0.5, 19.2]] }, { e: 5, louvers: [[0.5, 19.2]] }, { e: 0 }, { e: 6 }, { e: 7 }, { e: 2 }, { e: 4 }], 15, L.bridgeRoof);
  detailBlock(pb, mid01, [
    { e: 0, doors: [0.3, 0.75], louvers: [[0.52, 7.9]], lights: 2, boxes: 2, pipes: 9.4 },
    { e: 2, doors: [0.25, 0.7], louvers: [[0.48, 7.9]], lights: 2, boxes: 2, pipes: 9.4 },
  ], 16, deckF);
  detailBlock(pb, aft01, [
    { e: 1, doors: [0.2, 0.7], louvers: [[0.45, 7.9]], lights: 2, boxes: 2 },
    { e: 3, doors: [0.3, 0.8], louvers: [[0.55, 7.9]], lights: 2, boxes: 2 },
    { e: 0 }, { e: 4 },
  ], 17, deckF);
  detailBlock(pb, aft02, [{ e: 1, doors: [0.4], louvers: [[0.75, 11.3]] }, { e: 3, doors: [0.6], louvers: [[0.25, 11.3]] }, { e: 0 }, { e: 4 }, { e: 5 }], 18, L.lvl01);
  detailBlock(pb, f02, [{ e: 0, louvers: [[0.5, 11.3]] }, { e: 4, louvers: [[0.5, 11.3]] }], 19, L.lvl01);
  hangars.forEach((hb, i) => {
    detailBlock(pb, hb, [
      { e: 2, doors: i === 0 ? [0.2, 0.62] : [0.38, 0.8], louvers: [[i === 0 ? 0.4 : 0.6, 7.2]], lights: 3, boxes: 5, pipes: 10.6, ladders: [i === 0 ? 0.93 : 0.07] },
      { e: 1 }, { e: 0 },
      { e: 3, lights: 2, boxes: 2, s0: i === 0 ? 0.02 : 0.75, s1: i === 0 ? 0.25 : 0.98 },
    ], 20 + i, deckF);
  });
  // aft face center (between hangar doors) + CIWS house faces
  detailBlock(pb, ciwsH, [{ e: 1, louvers: [[0.5, 12.9]] }, { e: 5, louvers: [[0.5, 12.9]] }, { e: 3, lights: 1 }], 22, hy1);

  // ------------------------------------------------ bridge interior (seen from bridge_cam through the windows)
  {
    const inner = (e: number, h0: number, h1: number) => {
      const g = quadOnFace(pilot, e, 0, 1, h0, h1, -0.06);
      // flip to face inward
      const ix = g.index!.array as unknown as number[];
      for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
      const n = g.attributes.normal;
      for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
      P('interior', g);
    };
    const nP = pilot.bot.length;
    for (let e = 0; e < nP; e++) {
      if (winFaces.includes(e) || e === 1 || e === nP - 3) {
        inner(e, 0, hw0);
        inner(e, hw1, 1);
      } else inner(e, 0, 1);
    }
    // mullions between the windows (visible from inside and outside)
    for (const e of winFaces) {
      const len = pilot.edgeLen(e);
      const nWin = Math.max(2, Math.round(len / 1.15));
      for (let i = 0; i <= nWin; i++) {
        const fm = pilot.faceFrame(e, Math.min(0.995, Math.max(0.005, i / nWin)), (hw0 + hw1) / 2, -0.11);
        P('interior', box(0.08, 1.6, 0.1), fm);
      }
    }
    // ceiling
    const ceil = offsetPolyIn(pilot.top, 0.25);
    const cg = prismBetween(ceil, L.bridgeRoof - 0.12, ceil, L.bridgeRoof - 0.08, false, true);
    P('interior', cg);
    // forward console under the windows with display screens
    P('interior', box(6.6, 0.85, 0.55), M(0, L.lvl03 + 0.42, 29.0));
    for (const x of [-2.6, -1.3, 1.3, 2.6]) {
      P('black', box(0.8, 0.42, 0.05), M(x, L.lvl03 + 0.98, 28.9, -0.9));
      P('screen', box(0.7, 0.34, 0.02), M(x, L.lvl03 + 0.99, 28.86, -0.9));
    }
    // helm / lee-helm consoles, radar repeaters, captain's chair
    for (const [x, z] of [[-0.9, 27.2], [0.9, 27.2]] as [number, number][]) {
      P('interior', box(0.9, 1.05, 0.7), M(x, L.lvl03 + 0.52, z));
      P('screen', box(0.7, 0.35, 0.02), M(x, L.lvl03 + 1.08, z + 0.2, -0.6));
      P('black', cyl(0.06, 0.06, 0.2, 8), M(x, L.lvl03 + 1.1, z + 0.28, Math.PI / 2 - 0.6));
    }
    for (const x of [-3.4, 3.4]) {
      P('interior', box(0.8, 1.2, 0.8), M(x, L.lvl03 + 0.6, 26.4));
      P('screen', box(0.6, 0.45, 0.02), M(x, L.lvl03 + 1.35, 26.81, -0.2));
    }
    // captain's chair (stbd side)
    P('black', box(0.6, 0.12, 0.6), M(-2.6, L.lvl03 + 0.75, 27.3));
    P('black', box(0.6, 0.8, 0.12), M(-2.6, L.lvl03 + 1.15, 27.0));
    P('darkSteel', cyl(0.05, 0.1, 0.7, 8), M(-2.6, L.lvl03 + 0.35, 27.3));
    // overhead cable trays / repeaters
    P('darkSteel', box(5.5, 0.08, 0.3), M(0, L.bridgeRoof - 0.3, 28.3));
    P('black', box(0.6, 0.35, 0.12), M(1.6, L.bridgeRoof - 0.45, 28.6, 0.25));
    P('black', box(0.6, 0.35, 0.12), M(-1.6, L.bridgeRoof - 0.45, 28.6, 0.25));
  }

  // ------------------------------------------------ vents, lockers, misc boxes on 01 roofs
  for (const sx of [1, -1]) {
    P('paintFine', box(1.2, 0.8, 2.2), M(sx * 6.4, L.lvl01 + 0.4, 9.2));
    P('paintFine', box(0.9, 0.6, 1.2), M(sx * 5.9, L.lvl01 + 0.3, -4.0));
    P('paintFine', box(1.4, 1.0, 1.4), M(sx * 2.2, L.lvl02 + 0.5, -18.5));
    P('darkSteel', box(0.06, 0.9, 1.5), M(sx * 4.95, L.lvl01 + 1.3, -15.0));
  }
  // bridge cam: behind the centre window
  const bridgeCam: V3 = [0, 16.85, 28.3];
  // Decoy launcher positions on 01 roof, forward (4 launchers)
  const decoyLaunchers: SSAnchors['decoyLaunchers'] = [
    { pos: [6.2, L.lvl01, 32.2], outward: 1 },
    { pos: [-6.2, L.lvl01, 32.2], outward: -1 },
    { pos: [7.6, L.lvl01, -19.6], outward: 1 },
    { pos: [-7.6, L.lvl01, -19.6], outward: -1 },
  ];
  void deckAt;
  return { ciwsFwd, illumFwd, illumAft, ciwsAft, mastBaseY: L.lvl05, funnels, decoyLaunchers, bridgeCam, arrays, hangarDoors, vlsAftDeckY: vlsDeck, blocks: { fwd01, tower1, tower2, pilot, lvl05, mid01, aft01, aft02 } };
  void louver; void lightFix; void jbox;
}

/** Quad on a block face between edge fractions s0..s1 and height fractions h0..h1. */
export function quadOnFace(b: Block, e: number, s0: number, s1: number, h0: number, h1: number, off: number) {
  const fm = b.faceFrame(e, (s0 + s1) / 2, (h0 + h1) / 2, off);
  const w = b.edgeLen(e) * (s1 - s0);
  const hh = b.facePoint(e, 0.5, h1).distanceTo(b.facePoint(e, 0.5, h0));
  const g = new THREE.PlaneGeometry(w, hh);
  g.applyMatrix4(fm);
  return g;
}
/** Thin projecting strip (eyebrow) along a face at height fraction h, projecting `depth` outward. */
export function stripOnFace(b: Block, e: number, s0: number, s1: number, h: number, depth: number, thick: number) {
  const fm = b.faceFrame(e, (s0 + s1) / 2, h, depth / 2);
  const w = b.edgeLen(e) * (s1 - s0) * 0.98;
  const g = new THREE.BoxGeometry(w, thick, depth);
  g.applyMatrix4(fm);
  return g;
}
/** Triangular plate (bracket) with thickness t along z. */
export function triPlate(a: V3, b: V3, c: V3, t: number) {
  const g = prismBetween([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]], a[2] - t / 2, [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]], a[2] + t / 2, true, true);
  // prismBetween builds in (x,z) plan with y extrusion; remap (x, y_ext, z_plan) -> (x, z_plan, y_ext)
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i, x, z, y);
  }
  // winding flipped by the swap
  const ix = g.index!.array as unknown as number[];
  for (let k = 0; k < ix.length; k += 3) { const tmp = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = tmp; }
  g.computeVertexNormals();
  return g;
}
