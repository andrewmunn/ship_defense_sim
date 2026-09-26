import * as THREE from 'three';
import { Terrain } from '../../sim/terrain';
import { R_PLANET } from '../../core/constants';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ChunkGenerator, ScatterJob, ScatterResult, SCATTER_STRIDE } from './gen';

/**
 * Close-range ground scatter around the camera: maquis shrubs (alpha-tested leaf cards around a
 * small core), limestone rocks (faceted) and dry grass tufts (cards). Tiles are generated
 * deterministically in the terrain workers; instances are packed into InstancedMeshes relative to a
 * snapped local origin (float32-safe) whenever the visible tile set changes.
 */
const TILE = 128;
const RADIUS = 720; // shrubs & rocks
const GRASS_RADIUS = 110;
const MAX_ALT = 700; // camera height above terrain beyond which scatter is dropped
const CAP = [24000, 8000, 30000, 7000, 7000]; // shrub, rock, grass, olive canopy, olive trunk

interface Tile {
  key: string;
  state: 0 | 1 | 2;
  data: Float32Array | null;
  count: number;
  origin: [number, number, number];
  lastUsed: number;
}

// ------------------------------------------------------------------ textures

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w = 256, h = 256) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Shrub card: a ragged dome of small leaves (lentisk / kermes oak), darker inside and at the base. */
function shrubTexture() {
  return canvasTex((ctx, w, h) => {
    const r = rng(42);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const base = h * 0.97;
    // twigs
    ctx.strokeStyle = 'rgba(52,40,28,1)';
    for (let i = 0; i < 14; i++) {
      ctx.lineWidth = 1 + r() * 1.5;
      ctx.beginPath();
      const x0 = cx + (r() - 0.5) * w * 0.25;
      ctx.moveTo(x0, base);
      ctx.quadraticCurveTo(x0 + (r() - 0.5) * 40, base - h * 0.3, cx + (r() - 0.5) * w * 0.8, base - h * (0.35 + r() * 0.45));
      ctx.stroke();
    }
    const edge = (a: number) => 0.44 + 0.05 * Math.sin(a * 3 + 1.3) + 0.04 * Math.sin(a * 7 + 0.4) + 0.03 * Math.sin(a * 13);
    for (let i = 0; i < 5200; i++) {
      const a = Math.PI * (1.02 + r() * 0.96); // upper half-dome (canvas y up = negative)
      const rr = Math.sqrt(r()) * edge(a) * w;
      const x = cx + Math.cos(a) * rr * 1.08;
      const y = base + Math.sin(a) * rr * 1.75 + h * 0.02;
      if (y > base) continue;
      const depth = rr / (edge(a) * w); // 0 center .. 1 rim
      const top = 1 - (y / base);
      const shade = 0.35 + 0.45 * depth + 0.35 * top + (r() - 0.5) * 0.35;
      const g = Math.max(0, Math.min(1.4, shade));
      const hue = r();
      const R = (hue < 0.2 ? 118 : 80) * g, G = (hue < 0.2 ? 120 : 104) * g, B = (hue < 0.2 ? 72 : 50) * g;
      ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 2 + r() * 3.2, 1.2 + r() * 1.8, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** Dry grass tuft card: straw blades fanning from the base. */
function grassTexture() {
  return canvasTex((ctx, w, h) => {
    const r = rng(7);
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const x0 = w / 2 + (r() - 0.5) * w * 0.3;
      const len = h * (0.45 + r() * 0.5);
      const lean = (r() - 0.5) * w * 0.9;
      const t = r();
      const col = t < 0.5 ? [196, 168, 104] : t < 0.8 ? [160, 138, 86] : [120, 116, 78];
      const g = 0.75 + r() * 0.4;
      const grad = ctx.createLinearGradient(0, h, 0, h - len);
      grad.addColorStop(0, `rgb(${(col[0] * 0.45) | 0},${(col[1] * 0.42) | 0},${(col[2] * 0.4) | 0})`);
      grad.addColorStop(1, `rgb(${Math.min(255, col[0] * g) | 0},${Math.min(255, col[1] * g) | 0},${Math.min(255, col[2] * g) | 0})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2 + r() * 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.quadraticCurveTo(x0 + lean * 0.3, h - len * 0.6, x0 + lean, h - len);
      ctx.stroke();
      // seed heads
      if (r() < 0.25) {
        ctx.fillStyle = `rgb(${(col[0] * 1.05) | 0},${(col[1] * 0.95) | 0},${(col[2] * 0.8) | 0})`;
        ctx.beginPath();
        ctx.ellipse(x0 + lean, h - len, 1.5, 5, Math.atan2(lean, len), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

/** Olive crown card: open, silvery gray-green crown in the upper part of the card. */
function oliveTexture() {
  return canvasTex((ctx, w, h) => {
    const r = rng(99);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h * 0.36;
    // a few sub-clumps make the crown lumpy and open
    const clumps: [number, number, number][] = [];
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.22;
      clumps.push([cx + Math.cos(a) * d * w, cy + Math.sin(a) * d * h * 0.7, (0.12 + r() * 0.08) * w]);
    }
    // branches
    ctx.strokeStyle = 'rgb(86,78,66)';
    for (let i = 0; i < 9; i++) {
      const [x, y] = clumps[i];
      ctx.lineWidth = 1 + r() * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + (r() - 0.5) * 10, h * 0.62);
      ctx.quadraticCurveTo(cx + (x - cx) * 0.3, h * 0.6, x, y);
      ctx.stroke();
    }
    for (let i = 0; i < 6000; i++) {
      const c = clumps[(r() * clumps.length) | 0];
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * c[2];
      const x = c[0] + Math.cos(a) * d, y = c[1] + Math.sin(a) * d * 0.8;
      const rim = d / c[2];
      const top = 1 - y / (h * 0.7);
      const g = Math.max(0.3, Math.min(1.35, 0.45 + 0.4 * rim + 0.45 * top + (r() - 0.5) * 0.4));
      const under = r() < 0.3; // silvery undersides
      const R = (under ? 132 : 84) * g, G = (under ? 136 : 92) * g, B = (under ? 100 : 48) * g;
      ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 2.6 + r() * 2, 0.9 + r() * 0.8, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function oliveTrunk() {
  const parts: THREE.BufferGeometry[] = [];
  const r = rng(5);
  const seg = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r1, r0, d.length(), 7, 1, true);
    g.translate(0, d.length() / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate(a.x, a.y, a.z);
    parts.push(g);
  };
  const base = new THREE.Vector3(0, -0.1, 0), knee = new THREE.Vector3(0.12, 0.7, -0.05), fork = new THREE.Vector3(-0.05, 1.25, 0.08);
  seg(base, knee, 0.075, 0.06);
  seg(knee, fork, 0.06, 0.05);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r();
    const tip = new THREE.Vector3(Math.cos(a) * (0.35 + r() * 0.2), 1.9 + r() * 0.5, Math.sin(a) * (0.35 + r() * 0.2));
    seg(fork, tip, 0.04, 0.015);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ geometry

/** Crossed vertical cards (+ an optional horizontal cap or a shallow dome), unit size, base at y=0. Spherical normals. */
function cards(nV: number, cap: boolean | 'dome', center: THREE.Vector3, normalUp: number) {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  const quad = (p: THREE.Vector3[], uvs: number[][]) => {
    const b = pos.length / 3;
    for (let i = 0; i < 4; i++) {
      pos.push(p[i].x, p[i].y, p[i].z);
      uv.push(uvs[i][0], uvs[i][1]);
      const n = p[i].clone().sub(center);
      n.y += normalUp;
      n.normalize();
      nrm.push(n.x, n.y, n.z);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (let k = 0; k < nV; k++) {
    const a = (k / nV) * Math.PI;
    const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
    quad(
      [new THREE.Vector3(-dx, 0, -dz), new THREE.Vector3(dx, 0, dz), new THREE.Vector3(dx, 1, dz), new THREE.Vector3(-dx, 1, -dz)],
      [[0, 0], [1, 0], [1, 1], [0, 1]]
    );
  }
  if (cap === 'dome') {
    // octagonal shallow dome, planar-mapped onto the crown part of the texture
    const n = 8, y0 = 0.52, y1 = 0.78, rr = 0.42;
    const uvOf = (x: number, z: number) => [0.5 + x, 0.36 + z * 0.7] as number[];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const p0 = new THREE.Vector3(Math.cos(a0) * rr, y0, Math.sin(a0) * rr);
      const p1 = new THREE.Vector3(Math.cos(a1) * rr, y0, Math.sin(a1) * rr);
      const ap = new THREE.Vector3(0, y1, 0);
      const b = pos.length / 3;
      for (const p of [p0, p1, ap]) {
        pos.push(p.x, p.y, p.z);
        const u = uvOf(p.x, p.z);
        uv.push(u[0], u[1]);
        const nn = p.clone().sub(center);
        nn.y += normalUp + 0.3;
        nn.normalize();
        nrm.push(nn.x, nn.y, nn.z);
      }
      idx.push(b, b + 2, b + 1);
    }
  } else if (cap) {
    const y = 0.62, s = 0.42;
    quad(
      [new THREE.Vector3(-s, y, -s), new THREE.Vector3(s, y, -s), new THREE.Vector3(s, y, s), new THREE.Vector3(-s, y, s)],
      [[0.08, 0.3], [0.92, 0.3], [0.92, 0.95], [0.08, 0.95]]
    );
  }
  // back faces as explicit reversed triangles (FrontSide material): DoubleSide would flip the
  // spherical normals on the far side and turn foliage black
  const nIdx = idx.length;
  for (let i = 0; i < nIdx; i += 3) idx.push(idx[i], idx[i + 2], idx[i + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const disp = new Map<string, number>();
  const r = rng(3);
  const planes: THREE.Vector3[] = [];
  for (let i = 0; i < 7; i++) planes.push(new THREE.Vector3(r() - 0.5, r() * 0.6 - 0.1, r() - 0.5).normalize());
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let d = disp.get(k);
    if (d === undefined) {
      d = 0.85 + r() * 0.3;
      disp.set(k, d);
    }
    v.multiplyScalar(d);
    // cleave with a few planes → blocky limestone
    for (const pl of planes) {
      const t = v.dot(pl) - 0.62;
      if (t > 0) v.addScaledVector(pl, -t * 0.85);
    }
    v.y = v.y * 0.62 + 0.18;
    p.setXYZ(i, v.x * 1.15, v.y, v.z);
  }
  g.computeVertexNormals(); // non-indexed → faceted
  // cleaving can collapse triangles: sanitize degenerate normals (NaN would poison bloom)
  const nr = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < nr.count; i++) {
    const x = nr.getX(i), y = nr.getY(i), z = nr.getZ(i);
    if (!Number.isFinite(x + y + z) || x * x + y * y + z * z < 0.5) nr.setXYZ(i, 0, 1, 0);
  }
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const c = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.1) / 0.8));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

let _assets: { geos: THREE.BufferGeometry[]; mats: THREE.Material[] } | null = null;
function assets() {
  if (_assets) return _assets;
  const shrubMap = shrubTexture();
  const grassMap = grassTexture();
  const shrub = cards(3, true, new THREE.Vector3(0, 0.15, 0), 0.25);
  const grass = cards(3, false, new THREE.Vector3(0, -0.5, 0), 1.2);
  const rock = rockGeometry();
  const olive = cards(3, 'dome', new THREE.Vector3(0, 0.62, 0), 0.35);
  const trunk = oliveTrunk();
  const mOlive = new THREE.MeshStandardMaterial({ map: oliveTexture(), alphaTest: 0.45, alphaToCoverage: true, roughness: 0.85, metalness: 0 });
  mOlive.shadowSide = THREE.DoubleSide;
  const mTrunk = new THREE.MeshStandardMaterial({ color: 0x4a4236, roughness: 0.95, metalness: 0 });
  const mShrub = new THREE.MeshStandardMaterial({ map: shrubMap, alphaTest: 0.45, alphaToCoverage: true, roughness: 0.9, metalness: 0 });
  mShrub.shadowSide = THREE.DoubleSide;
  const mRock = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, metalness: 0 });
  const mGrass = new THREE.MeshStandardMaterial({ map: grassMap, alphaTest: 0.4, alphaToCoverage: true, roughness: 1, metalness: 0 });
  for (const m of [mShrub, mRock, mGrass, mOlive, mTrunk]) m.envMapIntensity = 0.5;
  _assets = { geos: [shrub, rock, grass, olive, trunk], mats: [mShrub, mRock, mGrass, mOlive, mTrunk] };
  return _assets;
}

export class TerrainScatter {
  group = new THREE.Group();
  meshes: THREE.InstancedMesh[] = [];
  count = 0;
  pending = 0;
  active = false;
  radius = RADIUS;
  /** Areas kept free of scatter (x, z, radius) — e.g. launcher emplacements. */
  clearings: { x: number; z: number; r: number }[] = [];
  setClearings(c: { x: number; z: number; r: number }[]) {
    this.clearings = c.slice();
    this.dirty = true;
  }
  private tiles = new Map<string, Tile>();
  private frame = 0;
  dirty = false;
  private origin = new THREE.Vector3();
  private packedAt = new THREE.Vector3(1e9, 0, 0);
  private nextId = 1;
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _q2 = new THREE.Quaternion();
  private _s = new THREE.Vector3();
  private _p = new THREE.Vector3();
  private _c = new THREE.Color();

  constructor(private request: (job: ScatterJob, cb: (r: ScatterResult) => void) => void) {
    const { geos, mats } = assets();
    for (let k = 0; k < 5; k++) {
      const im = new THREE.InstancedMesh(geos[k], mats[k], CAP[k]);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP[k] * 3), 3);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = k !== 2;
      im.receiveShadow = true;
      im.name = ['scatter_shrub', 'scatter_rock', 'scatter_grass', 'scatter_olive', 'scatter_olive_trunk'][k];
      this.meshes.push(im);
      this.group.add(im);
    }
  }

  reset() {
    for (const t of this.tiles.values()) if (t.state === 1) t.state = 0;
  }

  update(cam: THREE.Vector3, terrain: Terrain, _gen: ChunkGenerator) {
    this.frame++;
    const hGround = Math.max(terrain.height(cam.x, cam.z), 0);
    const alt = Math.hypot(cam.x, cam.y + R_PLANET, cam.z) - R_PLANET - hGround;
    const active = alt < MAX_ALT;
    this.active = active;
    this.pending = 0;
    if (active) {
      const r = RADIUS + Math.max(0, alt) * 0.4;
      this.radius = r;
      const i0 = Math.floor((cam.x - r) / TILE), i1 = Math.floor((cam.x + r) / TILE);
      const j0 = Math.floor((cam.z - r) / TILE), j1 = Math.floor((cam.z + r) / TILE);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * TILE - cam.x, cz = (j + 0.5) * TILE - cam.z;
          if (Math.hypot(cx, cz) > r + TILE * 0.71) continue;
          const key = `${i},${j}`;
          let t = this.tiles.get(key);
          if (!t) {
            t = { key, state: 0, data: null, count: 0, origin: [0, 0, 0], lastUsed: this.frame };
            this.tiles.set(key, t);
          }
          t.lastUsed = this.frame;
          if (t.state === 0) {
            t.state = 1;
            const tile = t;
            this.request({ id: this.nextId++, x0: i * TILE, z0: j * TILE, size: TILE, density: 1 / 9 }, (res) => {
              if (!this.tiles.has(tile.key)) return;
              tile.state = 2;
              tile.data = res.data;
              tile.count = res.count;
              tile.origin = res.origin;
              this.dirty = true;
            });
          }
          if (t.state !== 2) this.pending++;
        }
    }
    for (const [k, t] of this.tiles) {
      if (t.lastUsed !== this.frame) {
        if (t.state === 2 && t.count > 0) this.dirty = true;
        this.tiles.delete(k);
      }
    }
    // grass depends on camera distance: repack when the camera moved a bit
    const moved = this.packedAt.distanceToSquared(cam) > 25 * 25;
    if (this.dirty || (moved && this.tiles.size)) this.rebuild(cam);
  }

  private rebuild(cam: THREE.Vector3) {
    this.dirty = false;
    this.packedAt.copy(cam);
    const ox = Math.round(cam.x / 256) * 256, oz = Math.round(cam.z / 256) * 256;
    const d2 = ox * ox + oz * oz;
    const oy = -d2 / (R_PLANET + Math.sqrt(Math.max(R_PLANET * R_PLANET - d2, 0)));
    this.origin.set(ox, oy, oz);
    const counts = [0, 0, 0, 0, 0];
    const up = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const g2 = GRASS_RADIUS * GRASS_RADIUS;
    for (const t of this.tiles.values()) {
      if (t.state !== 2 || !t.data) continue;
      const [tx, ty, tz] = t.origin;
      up.set(tx, ty + R_PLANET, tz).normalize();
      this._q2.setFromUnitVectors(Y, up);
      const dxT = tx - ox, dyT = ty - oy, dzT = tz - oz;
      const d = t.data;
      const nearTile = Math.hypot(tx - cam.x, tz - cam.z) < GRASS_RADIUS + TILE;
      const clr = this.clearings.filter((c) => Math.abs(c.x - tx) < c.r + TILE && Math.abs(c.z - tz) < c.r + TILE);
      for (let k = 0; k < t.count; k++) {
        const o = k * SCATTER_STRIDE;
        const type = d[o + 5] | 0;
        if (clr.length) {
          const wx = d[o] + tx, wz = d[o + 2] + tz;
          let skip = false;
          for (const c of clr) {
            const rr = c.r + (type === 3 ? 4 : 1);
            if ((wx - c.x) ** 2 + (wz - c.z) ** 2 < rr * rr) skip = true;
          }
          if (skip) continue;
        }
        if (type === 2) {
          if (!nearTile) continue;
          const ex = d[o] + tx - cam.x, ez = d[o + 2] + tz - cam.z;
          if (ex * ex + ez * ez > g2) continue;
        }
        const s = d[o + 3];
        const f = d[o + 6];
        if (type === 2) {
          // a clump of 3-6 tufts around the point
          const ex = d[o] + tx - cam.x, ez = d[o + 2] + tz - cam.z;
          const nearC = ex * ex + ez * ez < 45 * 45;
          const n = (3 + ((f * 4.99) | 0)) * (nearC ? 2 : 1);
          const px = d[o] + dxT, py = d[o + 1] + dyT, pz = d[o + 2] + dzT;
          for (let q = 0; q < n && counts[2] < CAP[2]; q++) {
            const a = f * 40 + q * 2.39996, rr = 0.25 + ((q * 0.618 + f) % 1) * (nearC ? 1.6 : 1.1);
            const sc = s * (0.6 + ((q * 0.37 + f * 3.1) % 1) * 0.6);
            this._q.setFromAxisAngle(Y, a * 1.7).premultiply(this._q2);
            this._s.set(sc * 0.9, sc * (0.7 + ((q * 0.53 + f) % 1) * 0.6), sc * 0.9);
            this._p.set(px + Math.cos(a) * rr, py - 0.02, pz + Math.sin(a) * rr);
            this._m.compose(this._p, this._q, this._s);
            this.meshes[2].setMatrixAt(counts[2], this._m);
            const g = 0.8 + ((q * 0.29 + f * 1.7) % 1) * 0.45;
            this.meshes[2].setColorAt(counts[2], this._c.setRGB(g, g * 0.97, g * 0.92));
            counts[2]++;
          }
          continue;
        }
        const c = counts[type];
        if (c >= CAP[type]) continue;
        counts[type]++;
        this._q.setFromAxisAngle(Y, d[o + 4]);
        this._q.premultiply(this._q2);
        if (type === 3) {
          // tint < 0: forest tree (holm oak; < -1: coastal umbrella pine), else olive
          const forest = f < 0;
          const pine = f < -1;
          const ft = pine ? -f - 1 : -f;
          this._p.set(d[o] + dxT, d[o + 1] + dyT, d[o + 2] + dzT);
          if (pine) this._s.set(s * 8.5, s * 7.2, s * 8.5);
          else if (forest) this._s.set(s * 6.2, s * 6.8, s * 6.2);
          else this._s.set(s * 4.6, s * 4.4, s * 4.6);
          this._m.compose(this._p, this._q, this._s);
          this.meshes[3].setMatrixAt(c, this._m);
          if (pine) this._c.setRGB(0.55 + 0.2 * ft, 0.72 + 0.2 * ft, 0.45 + 0.15 * ft);
          else if (forest) this._c.setRGB(0.4 + 0.2 * ft, 0.5 + 0.2 * ft, 0.38 + 0.15 * ft);
          else this._c.setRGB(0.85 + 0.3 * f, 0.85 + 0.3 * f, 0.8 + 0.3 * f);
          this.meshes[3].setColorAt(c, this._c);
          if (pine) this._s.set(s * 2.0, s * 1.5, s * 2.0);
          else if (forest) this._s.set(s * 2.0, s * 1.6, s * 2.0);
          else this._s.set(s * 1.5, s * 1.1, s * 1.5);
          this._m.compose(this._p, this._q, this._s);
          this.meshes[4].setMatrixAt(c, this._m);
          this.meshes[4].setColorAt(c, this._c.setRGB(1, 1, 1));
          counts[4]++;
          continue;
        }
        if (type === 0) this._s.set(s * (1.6 + f * 0.8), s * (0.75 + f * 0.6), s * (1.6 + f * 0.8));
        else if (type === 1) this._s.set(s, s * (0.7 + f * 0.6), s * (0.8 + f * 0.4));
        else this._s.set(s * 0.9, s * (0.7 + f * 0.5), s * 0.9);
        this._p.set(d[o] + dxT, d[o + 1] + dyT, d[o + 2] + dzT);
        this._m.compose(this._p, this._q, this._s);
        const im = this.meshes[type];
        im.setMatrixAt(c, this._m);
        if (type === 0) {
          // olive-green ↔ dusty gray-green ↔ dark
          const a = (f * 7.31) % 1;
          this._c.setRGB(1.0 + 0.4 * a, 1.05 + 0.25 * f, 0.85 + 0.3 * a).multiplyScalar(0.95 + 0.45 * f);
        } else if (type === 1) {
          const g = 0.16 + 0.16 * f;
          this._c.setRGB(g * 1.1, g, g * 0.84);
        } else {
          this._c.setRGB(0.85 + 0.3 * f, 0.8 + 0.3 * f, 0.75 + 0.3 * f);
        }
        im.setColorAt(c, this._c);
      }
    }
    let total = 0;
    for (let k = 0; k < 5; k++) {
      const im = this.meshes[k];
      im.count = counts[k];
      im.position.copy(this.origin);
      im.updateMatrix();
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      total += counts[k];
    }
    this.count = total;
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.tiles.clear();
    this.group.removeFromParent();
  }
}
