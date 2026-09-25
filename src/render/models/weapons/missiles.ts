import * as THREE from 'three';
import { PartBuilder, M, V2, DEG } from '../ship/geom';
import { makeSkin, SkinOpts } from './skin';

type Mats = Record<string, THREE.Material>;

/** Lathe around +Z with cylindrical UVs (u around, v = (z - z0) / (z1 - z0)). Profile: [r, z]. */
export function bodyLathe(profile: V2[], seg: number, z0: number, z1: number) {
  const nP = profile.length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < nP; i++) {
    const [r, z] = profile[i];
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
      uv.push(j / seg, (z - z0) / (z1 - z0));
    }
  }
  for (let i = 0; i < nP - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // lathe winding: ensure outward normals
  const n = g.attributes.normal as THREE.BufferAttribute;
  const k = Math.floor(nP / 2) * (seg + 1);
  if (n.getX(k) * pos[k * 3] + n.getY(k) * pos[k * 3 + 1] < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** Ogive nose profile points from zBase (radius R) to the tip at zTip. */
export function ogive(R: number, zBase: number, zTip: number, n = 14, blunt = 0.02): V2[] {
  const L = zTip - zBase;
  const rho = (R * R + L * L) / (2 * R);
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = L * t;
    let r = Math.sqrt(Math.max(rho * rho - x * x, 0)) + R - rho;
    if (i === n) r = 0;
    out.push([Math.max(r, i === n ? 0 : blunt * R), zBase + x]);
  }
  return out;
}

/**
 * Fin: trapezoid planform with a thin diamond section. Root along +Z (chord), span along +X,
 * thickness along Y. Root leading edge at z = +root/2.
 */
export function finGeo(root: number, tip: number, span: number, sweep: number, t: number) {
  const le0 = root / 2, te0 = -root / 2;
  const le1 = le0 - sweep, te1 = le1 - tip;
  const sections = [
    { x: 0, le: le0, te: te0 },
    { x: span, le: le1, te: te1 },
  ];
  const rings: THREE.Vector3[][] = [];
  for (const s of sections) {
    const c = s.le - s.te;
    const th = t * (s.x === 0 ? 1 : 0.6);
    // diamond / wedge airfoil: LE, upper ridge, TE, lower ridge
    rings.push([
      new THREE.Vector3(s.x, 0, s.le),
      new THREE.Vector3(s.x, th / 2, s.le - c * 0.25),
      new THREE.Vector3(s.x, th / 2, s.te + c * 0.2),
      new THREE.Vector3(s.x, 0, s.te),
      new THREE.Vector3(s.x, -th / 2, s.te + c * 0.2),
      new THREE.Vector3(s.x, -th / 2, s.le - c * 0.25),
    ]);
  }
  // build faceted (flat-shaded) quads between the two rings + tip cap
  const pos: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
  const [r0, r1] = rings;
  for (let j = 0; j < 6; j++) {
    const j1 = (j + 1) % 6;
    quad(r0[j], r1[j], r1[j1], r0[j1]);
  }
  // tip cap
  for (let j = 1; j < 5; j++) pos.push(...r1[0].toArray(), ...r1[j + 1].toArray(), ...r1[j].toArray());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // make normals outward (check against centroid)
  const p = g.attributes.position as THREE.BufferAttribute, nn = g.attributes.normal as THREE.BufferAttribute;
  const cen = new THREE.Vector3(span / 2, 0, (le0 + te1) / 2);
  const tmp = new THREE.Vector3(), nv = new THREE.Vector3();
  let flips = 0;
  for (let i = 0; i < p.count; i += 3) {
    tmp.set((p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3).sub(cen);
    nv.set(nn.getX(i), nn.getY(i), nn.getZ(i));
    if (nv.dot(tmp) < 0) flips++;
  }
  if (flips > p.count / 6) {
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
    g.computeVertexNormals();
  }
  return g;
}

function empty(name: string, x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent?.add(o);
  return o;
}

// ------------------------------------------------------------------ materials
const _cache: Record<string, Mats> = {};
function skinMat(key: string, opts: SkinOpts, metal = 0.25) {
  const s = makeSkin(opts);
  return new THREE.MeshStandardMaterial({ map: s.map, roughnessMap: s.roughnessMap, normalMap: s.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: metal, name: key });
}
function common(): Mats {
  if (_cache.common) return _cache.common;
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  _cache.common = {
    nozzle: std({ color: 0x1b1a19, roughness: 0.55, metalness: 0.7 }),
    nozzleIn: std({ color: 0x0b0a09, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide }),
    metal: std({ color: 0x8a8d90, roughness: 0.35, metalness: 0.9 }),
    darkMetal: std({ color: 0x35383b, roughness: 0.5, metalness: 0.7 }),
    black: std({ color: 0x121314, roughness: 0.7, metalness: 0.1 }),
    finWhite: std({ color: 0xd8d9d6, roughness: 0.45, metalness: 0.2 }),
    finGrey: std({ color: 0x8e9496, roughness: 0.5, metalness: 0.3 }),
    finOlive: std({ color: 0x5b6149, roughness: 0.6, metalness: 0.15 }),
    finSand: std({ color: 0xa89572, roughness: 0.65, metalness: 0.1 }),
    finSilver: std({ color: 0xb5b8ba, roughness: 0.3, metalness: 0.85 }),
    radomeDark: std({ color: 0x3a3b3c, roughness: 0.35, metalness: 0.0 }),
    intake: std({ color: 0x0c0c0d, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide }),
  };
  return _cache.common;
}

/** Common VLS-launched interceptor body: radome + cylindrical airframe + nozzle. */
function interceptorBody(pb: PartBuilder, R: number, zTail: number, zNose: number, noseLen: number, skin: string) {
  const prof: V2[] = [
    [0.001, zTail + 0.01],
    [R * 0.55, zTail + 0.01],
    [R * 0.92, zTail + 0.02],
    [R * 0.97, zTail + 0.06],
    [R, zTail + 0.12],
  ];
  // shallow girth rings at section joints for silhouette detail
  const L = zNose - noseLen - (zTail + 0.12);
  const joints = [0.18, 0.42, 0.66, 0.86];
  let zc = zTail + 0.12;
  for (const j of joints) {
    const z = zTail + 0.12 + L * j;
    prof.push([R, z - 0.012], [R * 1.012, z - 0.006], [R * 1.012, z + 0.006], [R, z + 0.012]);
    zc = z;
  }
  void zc;
  prof.push([R, zNose - noseLen]);
  prof.push([R * 1.004, zNose - noseLen + 0.005]);
  const nose = ogive(R * 1.004, zNose - noseLen + 0.005, zNose, 18, 0.03);
  prof.push(...nose.slice(1));
  pb.addOwned(skin, bodyLathe(prof, 48, zTail, zNose), undefined, { uv: 'keep' });
}

function nozzle(pb: PartBuilder, r: number, z: number, len: number) {
  const outer: V2[] = [[r * 0.75, z], [r * 0.9, z - len * 0.5], [r, z - len]];
  pb.addOwned('nozzle', bodyLathe([...outer, [r * 0.93, z - len], [r * 0.6, z - len * 0.3]], 32, z - len, z), undefined, { uv: 'keep' });
  pb.addOwned('nozzleIn', bodyLathe([[r * 0.6, z - len * 0.3], [0.001, z - len * 0.25]], 32, z - len, z), undefined, { uv: 'keep' });
}

function finSet(parent: THREE.Object3D, pb: PartBuilder | null, mats: Mats, mat: string, R: number, z: number, root: number, tip: number, span: number, sweep: number, t: number, count = 4, roll = 45 * DEG, named = true, prefix = 'fin') {
  const g = finGeo(root, tip, span, sweep, t);
  for (let i = 0; i < count; i++) {
    const a = roll + (i / count) * Math.PI * 2;
    if (named) {
      // pivot group at the hinge (mid-root chord) so rotating about local X deflects it
      const pivot = new THREE.Group();
      pivot.name = `${prefix}_${i}`;
      pivot.position.set(Math.cos(a) * R, Math.sin(a) * R, z);
      pivot.rotation.z = a;
      const m = new THREE.Mesh(g, mats[mat]);
      m.castShadow = m.receiveShadow = true;
      pivot.add(m);
      parent.add(pivot);
    } else if (pb) {
      const m = new THREE.Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * R, Math.sin(a) * R, z);
      pb.add(mat, g, m, { uvScale: 1 });
    }
  }
}

// ------------------------------------------------------------------ Halberd (and Glaive with booster)
export function createHalberd(opts: { booster?: boolean } = {}): THREE.Group {
  const withBooster = !!opts.booster;
  const L = 4.72, R = 0.1715;
  const zN = withBooster ? 6.6 / 2 : L / 2;
  const zT = zN - L;
  const key = withBooster ? 'glaive' : 'halberd';
  const mats: Mats = { ...common() };
  mats.skin = _cache[key]?.skin ?? skinMat(key, {
    seed: withBooster ? 66 : 22, length: L, base: '#dcdcd6', radomeV: 1 - 0.95 / L, radome: withBooster ? '#48494a' : '#5a5b5b',
    seams: [0.1, 0.33, 0.52, 0.7, 0.8], bands: [[0.15, 0.17, '#8a5a2b'], [0.72, 0.74, '#d9b43a']], stencils: [[0.45, 0.1, 3], [0.45, 0.6, 3], [0.62, 0.3, 2]],
    longSeams: [0.25, 0.75], soot: 0.4, grime: 0.35, roughness: 0.4,
  });
  _cache[key] = { skin: mats.skin } as Mats;
  const g = new THREE.Group();
  g.name = key;
  const pb = new PartBuilder();
  interceptorBody(pb, R, zT, zN, 0.95, 'skin');
  nozzle(pb, R * 0.8, zT + 0.02, 0.12);
  // dorsal strakes (long, low-aspect), 4 at 45°
  const strakeLen = 2.1, strakeZ = zT + L * 0.47;
  const sg = finGeo(strakeLen, strakeLen * 0.92, 0.1, 0.02, 0.012);
  for (let i = 0; i < 4; i++) {
    const a = 45 * DEG + (i / 4) * Math.PI * 2;
    pb.add('finWhite', sg, new THREE.Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * R, Math.sin(a) * R, strakeZ), { uvScale: 1 });
  }
  pb.build(g, mats, key);
  finSet(g, null, mats, 'finWhite', R, zT + 0.3, 0.42, 0.2, 0.33, 0.2, 0.02, 4, 45 * DEG);
  const ex = empty('exhaust', 0, 0, zT - 0.1, g);
  ex.rotation.y = Math.PI;
  empty('seeker', 0, 0, zN, g);
  if (withBooster) {
    const b = new THREE.Group();
    b.name = 'booster';
    const bp = new PartBuilder();
    const BR = 0.265, bz1 = zT, bz0 = -6.6 / 2;
    const bmat = { ...mats };
    bmat.bskin = _cache.glaiveb?.bskin ?? skinMat('glaiveb', { seed: 67, length: 1.9, base: '#d4d4ce', seams: [0.2, 0.8], bands: [[0.5, 0.53, '#8a5a2b']], stencils: [[0.6, 0.2, 3]], soot: 0.7, roughness: 0.45 });
    _cache.glaiveb = { bskin: bmat.bskin } as Mats;
    // interstage adapter tapering from booster to missile
    const prof: V2[] = [[0.001, bz0], [BR * 0.8, bz0], [BR, bz0 + 0.05], [BR, bz1 - 0.35], [R * 1.05, bz1 - 0.02], [R * 1.02, bz1 + 0.04]];
    bp.addOwned('bskin', bodyLathe(prof, 48, bz0, bz1), undefined, { uv: 'keep' });
    nozzle(bp, BR * 0.8, bz0 + 0.02, 0.18);
    bp.build(b, bmat, 'glaive_booster');
    finSet(b, bp, bmat, 'finWhite', BR, bz0 + 0.35, 0.55, 0.32, 0.36, 0.2, 0.025, 4, 45 * DEG, true, 'bfin');
    const bex = empty('booster_exhaust', 0, 0, bz0 - 0.15, b);
    bex.rotation.y = Math.PI;
    g.add(b);
  }
  return g;
}

// ------------------------------------------------------------------ Stiletto
export function createStiletto(): THREE.Group {
  const L = 3.66, R = 0.127;
  const zN = L / 2, zT = -L / 2;
  const mats: Mats = { ...common() };
  mats.skin = _cache.stiletto?.skin ?? skinMat('stiletto', {
    seed: 162, length: L, base: '#e0e0da', radomeV: 1 - 0.55 / L, radome: '#6a6b6a', seams: [0.12, 0.45, 0.62, 0.78], bands: [[0.2, 0.22, '#8a5a2b'], [0.66, 0.68, '#d9b43a']],
    stencils: [[0.35, 0.15, 3], [0.35, 0.65, 2]], soot: 0.45, roughness: 0.42,
  });
  _cache.stiletto = { skin: mats.skin } as Mats;
  const g = new THREE.Group();
  g.name = 'stiletto';
  const pb = new PartBuilder();
  interceptorBody(pb, R, zT, zN, 0.55, 'skin');
  nozzle(pb, R * 0.82, zT + 0.02, 0.1);
  // small forward strakes near the seeker section
  const sg = finGeo(0.34, 0.2, 0.06, 0.1, 0.01);
  for (let i = 0; i < 4; i++) {
    const a = 45 * DEG + (i / 4) * Math.PI * 2;
    pb.add('finWhite', sg, new THREE.Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * R, Math.sin(a) * R, zN - 0.9), { uvScale: 1 });
  }
  pb.build(g, mats, 'stiletto');
  finSet(g, null, mats, 'finWhite', R, zT + 0.26, 0.36, 0.16, 0.24, 0.18, 0.016, 4, 45 * DEG);
  const ex = empty('exhaust', 0, 0, zT - 0.08, g);
  ex.rotation.y = Math.PI;
  empty('seeker', 0, 0, zN, g);
  return g;
}

// ------------------------------------------------------------------ subsonic ASCM (with jettisonable booster)
export function createAsmSubsonic(): THREE.Group {
  const Ltot = 6.0, Lm = 5.05, R = 0.18;
  const zN = Ltot / 2, zT = zN - Lm, zB = -Ltot / 2;
  const mats: Mats = { ...common() };
  mats.skin = _cache.asm1?.skin ?? skinMat('asm1', {
    seed: 801, length: Lm, base: '#6b7058', radomeV: 1 - 0.62 / Lm, radome: '#303230', seams: [0.14, 0.36, 0.55, 0.74, 0.86], longSeams: [0.5],
    stencils: [[0.5, 0.2, 4], [0.3, 0.6, 2]], soot: 0.3, grime: 0.8, roughness: 0.55, camo: [['#5a5f49', 0.5]],
  });
  mats.bskin = _cache.asm1?.bskin ?? skinMat('asm1b', { seed: 802, length: 0.95, base: '#62674f', seams: [0.3, 0.85], stencils: [[0.6, 0.3, 2]], soot: 0.9, roughness: 0.6 });
  _cache.asm1 = { skin: mats.skin, bskin: mats.bskin } as Mats;
  const g = new THREE.Group();
  g.name = 'asm_subsonic';
  const pb = new PartBuilder();
  // body with slightly boat-tailed rear
  const prof: V2[] = [[0.001, zT], [R * 0.62, zT], [R * 0.85, zT + 0.1], [R, zT + 0.35]];
  for (const j of [0.3, 0.55, 0.75]) {
    const z = zT + (Lm - 0.62) * j;
    prof.push([R, z - 0.01], [R * 1.01, z], [R, z + 0.01]);
  }
  prof.push([R, zN - 0.62]);
  prof.push(...ogive(R, zN - 0.62, zN, 18, 0.05).slice(1));
  pb.addOwned('skin', bodyLathe(prof, 48, zT, zN), undefined, { uv: 'keep' });
  // ventral turbojet intake (scoop) — loft a flattened duct under the body
  const rings: THREE.Vector3[][] = [];
  const iz0 = zT + 1.1, iz1 = zT + 2.1;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const z = iz0 + (iz1 - iz0) * t;
    const h = 0.11 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (t > 0.8 ? 1 - (t - 0.8) * 2.5 : 1);
    const w = 0.12;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j <= 10; j++) {
      const a = Math.PI + (j / 10) * Math.PI;
      ring.push(new THREE.Vector3(Math.cos(a) * w, -R * 0.93 + Math.sin(a) * Math.max(h, 0.005), z));
    }
    rings.push(ring);
  }
  const { loftRings } = { loftRings: (window as any).__loft } as any;
  void loftRings;
  pb.addOwned('skin', ductGeo(rings), undefined, { uv: 'box' });
  // intake mouth (dark)
  pb.add('intake', new THREE.CircleGeometry(1, 16, Math.PI, Math.PI).scale(0.11, 0.095, 1), M(0, -R * 0.93, iz1 - 0.02, 0, 0, 0));
  nozzle(pb, R * 0.55, zT + 0.02, 0.08);
  pb.build(g, mats, 'asm_subsonic');
  // mid-body wings (X), tail fins (X)
  finSet(g, null, mats, 'finOlive', R, zT + 2.35, 0.62, 0.3, 0.42, 0.28, 0.022, 4, 45 * DEG, true, 'wing');
  finSet(g, null, mats, 'finOlive', R, zT + 0.3, 0.38, 0.2, 0.3, 0.16, 0.018, 4, 45 * DEG);
  const ex = empty('exhaust', 0, 0, zT - 0.06, g);
  ex.rotation.y = Math.PI;
  empty('seeker', 0, 0, zN, g);
  // booster
  const b = new THREE.Group();
  b.name = 'booster';
  const bp = new PartBuilder();
  const BR = 0.2;
  const bprof: V2[] = [[0.001, zB], [BR * 0.8, zB], [BR, zB + 0.06], [BR, zT - 0.08], [R * 0.9, zT - 0.02], [R * 0.7, zT + 0.02]];
  bp.addOwned('bskin', bodyLathe(bprof, 40, zB, zT), undefined, { uv: 'keep' });
  nozzle(bp, BR * 0.78, zB + 0.02, 0.14);
  bp.build(b, mats, 'asm_booster');
  finSet(b, null, mats, 'finOlive', BR, zB + 0.33, 0.5, 0.3, 0.36, 0.2, 0.02, 4, 0, true, 'bfin');
  const bex = empty('booster_exhaust', 0, 0, zB - 0.12, b);
  bex.rotation.y = Math.PI;
  g.add(b);
  return g;
}

/** Duct from rings (open at both ends). */
function ductGeo(rings: THREE.Vector3[][]) {
  const nr = rings.length, np = rings[0].length;
  const pos: number[] = [], idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < nr - 1; i++)
    for (let j = 0; j < np - 1; j++) {
      const a = i * np + j, b = a + 1, c = a + np, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ supersonic ramjet ASCM
export function createAsmSupersonic(): THREE.Group {
  const L = 8.5, R = 0.335;
  const zN = L / 2, zT = -L / 2;
  const mats: Mats = { ...common() };
  mats.skin = _cache.asm2?.skin ?? skinMat('asm2', {
    seed: 800, length: L, base: '#b9bcb6', seams: [0.08, 0.22, 0.4, 0.58, 0.76, 0.9], longSeams: [0.25, 0.75],
    stencils: [[0.62, 0.15, 4], [0.62, 0.65, 4], [0.3, 0.4, 2]], bands: [[0.93, 0.96, '#6a2a22']], soot: 0.5, grime: 0.6, roughness: 0.4,
  });
  _cache.asm2 = { skin: mats.skin } as Mats;
  const g = new THREE.Group();
  g.name = 'asm_supersonic';
  const pb = new PartBuilder();
  // annular nose intake: body lip tapers to an intake ring; central shock cone
  const lipR = R * 0.82;
  const prof: V2[] = [[0.001, zT], [R * 0.7, zT], [R * 0.93, zT + 0.12], [R, zT + 0.4]];
  for (const j of [0.2, 0.4, 0.6, 0.78]) {
    const z = zT + L * j;
    prof.push([R, z - 0.015], [R * 1.008, z], [R, z + 0.015]);
  }
  prof.push([R, zN - 1.25], [R * 0.95, zN - 0.7], [lipR * 1.02, zN - 0.12], [lipR, zN - 0.02], [lipR * 0.92, zN - 0.04], [lipR * 0.9, zN - 0.2]);
  pb.addOwned('skin', bodyLathe(prof, 56, zT, zN), undefined, { uv: 'keep' });
  // intake throat (dark)
  pb.addOwned('intake', bodyLathe([[lipR * 0.9, zN - 0.2], [lipR * 0.85, zN - 0.7]], 40, zN - 1, zN), undefined, { uv: 'keep' });
  // shock cone: radome, protruding
  const cone: V2[] = [[R * 0.52, zN - 0.8], [R * 0.52, zN - 0.2], ...ogive(R * 0.52, zN - 0.2, zN + 0.55, 16, 0.04).slice(1)];
  pb.addOwned('radomeDark', bodyLathe(cone, 40, zN - 0.8, zN + 0.55), undefined, { uv: 'keep' });
  nozzle(pb, R * 0.78, zT + 0.02, 0.2);
  pb.build(g, mats, 'asm_supersonic');
  finSet(g, null, mats, 'finGrey', R, zT + L * 0.52, 1.0, 0.45, 0.42, 0.52, 0.035, 4, 0, true, 'wing');
  finSet(g, null, mats, 'finGrey', R, zT + 0.55, 0.85, 0.35, 0.5, 0.45, 0.03, 4, 0);
  const ex = empty('exhaust', 0, 0, zT - 0.2, g);
  ex.rotation.y = Math.PI;
  empty('seeker', 0, 0, zN + 0.55, g);
  return g;
}

// ------------------------------------------------------------------ heavy high-diving ASM
export function createAsmHeavy(): THREE.Group {
  const L = 11.6, R = 0.46;
  const zN = L / 2, zT = -L / 2;
  const mats: Mats = { ...common() };
  mats.skin = _cache.asm3?.skin ?? skinMat('asm3', {
    seed: 22, length: L, base: '#a3a8aa', radomeV: 1 - 1.7 / L, radome: '#e6e3d8', seams: [0.1, 0.25, 0.42, 0.6, 0.76], longSeams: [0.5],
    stencils: [[0.55, 0.1, 5], [0.55, 0.6, 5], [0.35, 0.35, 3]], bands: [[0.8, 0.83, '#a01c1c']], soot: 0.55, grime: 0.7, roughness: 0.35,
  }, 0.55);
  _cache.asm3 = { skin: mats.skin } as Mats;
  const g = new THREE.Group();
  g.name = 'asm_heavy';
  const pb = new PartBuilder();
  const prof: V2[] = [[0.001, zT], [R * 0.75, zT], [R * 0.9, zT + 0.2], [R, zT + 0.8]];
  for (const j of [0.25, 0.42, 0.6, 0.76]) {
    const z = zT + L * j;
    prof.push([R, z - 0.015], [R * 1.008, z], [R, z + 0.015]);
  }
  prof.push([R, zN - 1.7], ...ogive(R, zN - 1.7, zN, 22, 0.02).slice(1));
  pb.addOwned('skin', bodyLathe(prof, 56, zT, zN), undefined, { uv: 'keep' });
  // twin chamber nozzle cluster
  for (const sx of [-1, 1]) {
    const m = M(sx * R * 0.35, 0, 0);
    const tmp = new PartBuilder();
    nozzle(tmp, R * 0.32, zT + 0.02, 0.35);
    for (const [k, list] of tmp.lists) for (const geo of list) pb.addOwned(k, geo.applyMatrix4(m), undefined, { uv: 'keep' });
  }
  pb.build(g, mats, 'asm_heavy');
  // big delta wings (2, horizontal) + ventral fin + tail stabilizers
  const wing = new THREE.Group();
  const wg = finGeo(4.2, 0.7, 1.35, 3.1, 0.08);
  const wm = new THREE.MeshStandardMaterial({ color: 0x9fa4a6, roughness: 0.4, metalness: 0.6 });
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(wg, wm);
    m.position.set(sx * R * 0.9, -R * 0.25, zT + L * 0.42);
    m.rotation.z = sx > 0 ? 0 : Math.PI;
    m.castShadow = m.receiveShadow = true;
    wing.add(m);
  }
  g.add(wing);
  finSet(g, null, mats, 'finSilver', R, zT + 0.9, 1.6, 0.6, 0.95, 1.0, 0.05, 4, 0);
  // ventral fin (folding in reality), longer
  const vf = new THREE.Mesh(finGeo(2.0, 0.8, 0.8, 1.1, 0.05), mats.finSilver);
  vf.position.set(0, -R, zT + 1.3);
  vf.rotation.z = -Math.PI / 2;
  g.add(vf);
  const ex = empty('exhaust', 0, 0, zT - 0.35, g);
  ex.rotation.y = Math.PI;
  empty('seeker', 0, 0, zN, g);
  return g;
}

// ------------------------------------------------------------------ standalone booster (debris)
export function createBooster(): THREE.Group {
  const m = createAsmSubsonic();
  const b = m.getObjectByName('booster')!;
  const g = new THREE.Group();
  g.name = 'booster_debris';
  b.position.z = 2.5; // re-centre roughly on its own mass
  g.add(b);
  return g;
}
