import * as THREE from 'three';
import { Terrain } from '../sim/terrain';
import { R_PLANET } from '../core/constants';
import { ChunkGenerator, ChunkJob, ChunkResult, GenParams, ScatterJob, ScatterResult, genScatter, LandUse, EXT_STRIDE } from './terrain/gen';
import { MACRO_SIZE } from './terrain/textures';
import { makeTerrainTextures, TerrainTextures } from './terrain/textures';
import { createTerrainMaterial } from './terrain/material';
import { TerrainScatter } from './terrain/scatter';
import { TownLights, pickTowns } from './terrain/lights';
import { MAX_CLEARINGS } from './terrain/material';

/**
 * Coastal terrain renderer.
 *
 * Chunked quadtree LOD in coast-aligned coordinates (a = along the coast, c = across/inland), with
 * screen-space-error driven splitting, horizon culling (terrain hidden by planet curvature is neither
 * refined nor drawn), skirts against cracks, and generation in Web Workers (main-thread fallback).
 * Heights come from `Terrain.height()` (the same function the sim uses), displaced along the local
 * sphere normal exactly like `geo.setAltitude()`. Each chunk's vertices are relative to its own origin
 * (mesh.position) to avoid float32 jitter far from the world origin.
 */

const N = 64; // cells per chunk side
const ROOT = 102400; // root chunk size (m)
const MAX_DEPTH = 9; // 200 m chunks → 3.125 m vertex spacing
const ROOTS_A = 6; // along-coast root count (±307 km)
const ROOTS_C = 4; // across root count (−12.8 km … +397 km from the coast line)
const R = R_PLANET;

interface TNode {
  depth: number;
  a0: number;
  c0: number;
  size: number;
  parent: TNode | null;
  children: TNode[] | null;
  state: 0 | 1 | 2; // none, pending, ready
  mesh: THREE.Mesh | null;
  hMin: number;
  hMax: number;
  err: number;
  lastUsed: number;
  dead: boolean;
  center: THREE.Vector3; // world
  radius: number;
  prio: number;
}

export interface TerrainViewOptions {
  /** Worker count (0 = generate on the main thread). Default: min(4, cores − 2). */
  workers?: number;
  /** Target screen-space error in pixels. */
  pixelError?: number;
  /** Soft cap on in-frustum chunks / draw calls (pixel error is relaxed adaptively above it). */
  maxDrawn?: number;
  /** Main-thread generation budget per frame (ms) when running without workers. */
  budgetMs?: number;
  scatter?: boolean;
  lights?: boolean;
  /**
   * Terrain chunks (≤ 3.2 km) cast into the sun shadow map. Off by default: an open height field
   * rendered back-face-first lets the skirts cast stripes, and front faces acne with the scene's bias.
   * Terrain self-shadowing comes from the per-vertex horizon map instead.
   */
  castShadows?: boolean;
  /**
   * Extra layer enabled on near terrain chunks (≤ 6.4 km), e.g. the renderer's depth-prepass /
   * AO occluder layer. Default: none.
   */
  occluderLayer?: number;
}

export class TerrainView {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  textures: TerrainTextures;
  /**
   * drawn: selected LOD chunks (all directions); inView: of those, inside the camera frustum (≈ draw calls);
   * triangles: in-view terrain triangles; nodes: generated chunks cached; genMs: avg worker ms per chunk.
   */
  stats = { drawn: 0, inView: 0, nodes: 0, pending: 0, triangles: 0, genMs: 0, genCount: 0, tau: 1, scatter: 0 };
  /** True once no generation work is outstanding for the current view. */
  settled = false;

  private matU: ReturnType<typeof createTerrainMaterial>['uniforms'];
  private roots: TNode[] = [];
  private index: THREE.BufferAttribute;
  private frame = 0;
  private params!: GenParams;
  private gen!: ChunkGenerator;
  private landUse!: LandUse;
  private workers: Worker[] = [];
  private inflight: number[] = [];
  private jobs = new Map<number, TNode>();
  private scatterJobs = new Map<number, (r: ScatterResult) => void>();
  private nextId = 1;
  private wanted: TNode[] = [];
  private drawn: TNode[] = [];
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private tau: number;
  private opts: Required<TerrainViewOptions>;
  private sig = '';
  private liveNodes = 0;
  private scatter: TerrainScatter | null = null;
  private lights: TownLights | null = null;
  private _sphere = new THREE.Sphere();

  constructor(public terrain: Terrain, renderer: THREE.WebGLRenderer, opts: TerrainViewOptions = {}) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.opts = {
      workers: opts.workers ?? Math.max(1, Math.min(4, cores - 2)),
      pixelError: opts.pixelError ?? 1.25,
      maxDrawn: opts.maxDrawn ?? 110,
      budgetMs: opts.budgetMs ?? 5,
      scatter: opts.scatter ?? true,
      lights: opts.lights ?? true,
      castShadows: opts.castShadows ?? false,
      occluderLayer: opts.occluderLayer ?? -1,
    };
    this.tau = this.opts.pixelError;
    this.group.name = 'terrain';
    this.textures = makeTerrainTextures(renderer);
    const { material, uniforms } = createTerrainMaterial(this.textures);
    this.material = material;
    this.matU = uniforms;
    this.index = buildIndex(N);
    this.init();
  }

  // ------------------------------------------------------------------ setup

  private init() {
    const T = this.terrain;
    this.sig = `${T.bearing}|${T.distance}`;
    const c0 = T.distance - 12800;
    this.params = {
      bearing: T.bearing,
      distance: T.distance,
      a0: (-ROOTS_A / 2) * ROOT,
      a1: (ROOTS_A / 2) * ROOT,
      c0,
      c1: c0 + ROOTS_C * ROOT,
    };
    this.gen = new ChunkGenerator(this.params);
    const towns = pickTowns(this.gen, this.params);
    this.params.macro = this.textures.macroData;
    this.params.macroSize = MACRO_SIZE;
    this.params.towns = towns.slice(0, 40).map((t) => [t.x, t.z, t.rad, t.size]);
    this.landUse = new LandUse(this.params.macro, MACRO_SIZE, this.params.towns);
    this.startWorkers();
    for (let j = 0; j < ROOTS_C; j++)
      for (let i = 0; i < ROOTS_A; i++) this.roots.push(this.node(null, 0, this.params.a0 + i * ROOT, c0 + j * ROOT, ROOT));
    if (this.opts.scatter) {
      this.scatter = new TerrainScatter((job, cb) => this.requestScatter(job, cb));
      if (this.clearings.length) this.scatter.setClearings(this.clearings);
      this.group.add(this.scatter.group);
    }
    if (this.opts.lights) {
      this.lights = new TownLights(this.gen, this.params, towns);
      this.group.add(this.lights.points);
    }
  }

  private startWorkers() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.inflight = [];
    const n = this.opts.workers;
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('./terrain/worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.onWorkerMessage(e.data, i);
        w.onerror = (e) => {
          console.warn('[terrain] worker failed, falling back to main thread', e.message);
          this.workerFailed();
        };
        w.postMessage({ type: 'init', params: this.params });
        this.workers.push(w);
        this.inflight.push(0);
      } catch (err) {
        console.warn('[terrain] workers unavailable, generating on the main thread', err);
        this.workers = [];
        this.inflight = [];
        break;
      }
    }
  }

  private workerFailed() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.inflight = [];
    // re-queue everything in flight
    for (const node of this.jobs.values()) if (node.state === 1) node.state = 0;
    this.jobs.clear();
    for (const cb of this.scatterJobs.values()) void cb;
    this.scatterJobs.clear();
    this.scatter?.reset();
  }

  private node(parent: TNode | null, depth: number, a0: number, c0: number, size: number): TNode {
    const am = a0 + size / 2, cm = c0 + size / 2;
    const x = this.gen.toX(am, cm), z = this.gen.toZ(am, cm);
    return {
      depth, a0, c0, size, parent, children: null, state: 0, mesh: null,
      hMin: parent ? parent.hMin - parent.err : -60, hMax: parent ? parent.hMax + parent.err : 2700, err: parent ? parent.err * 0.5 : 1e4,
      lastUsed: this.frame, dead: false,
      center: new THREE.Vector3(x, surfaceYd(x, z), z), radius: size * 0.75 + 1500,
      prio: 0,
    };
  }

  // ------------------------------------------------------------------ per frame

  update(camera: THREE.PerspectiveCamera, simTime: number, isNight = 0) {
    if (this.disposed) return;
    if (`${this.terrain.bearing}|${this.terrain.distance}` !== this.sig) this.rebuild();
    this.frame++;
    this.matU.tTime.value = simTime;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen, camera.coordinateSystem, (camera as any).reversedDepth);

    const cam = camera.position;
    const t0 = performance.now();
    // integrate finished worker results (bounded per frame; GPU upload happens on first draw)
    while (this.results.length && performance.now() - t0 < this.opts.budgetMs * 0.5) {
      const [n, r] = this.results.shift()!;
      if (!n.dead) this.accept(n, r);
    }
    // Without workers, alternate selection and synchronous generation within the budget so a camera
    // cut converges in a few frames.
    for (let pass = 0; pass < 6; pass++) {
      this.select(camera);
      if (this.workers.length) {
        this.dispatch();
        break;
      }
      if (!this.wanted.length || performance.now() - t0 > this.opts.budgetMs) break;
      this.wanted.sort((a, b) => b.prio - a.prio);
      for (const n of this.wanted) {
        if (performance.now() - t0 > this.opts.budgetMs && pass > 0) break;
        const job = this.makeJob(n);
        n.state = 1;
        this.accept(n, this.gen.gen(job));
      }
    }
    // Visibility
    for (const n of this.drawn) if (n.mesh) n.mesh.visible = false;
    this.drawn = this.nextDrawn;
    this.nextDrawn = [];
    let tris = 0, inView = 0;
    for (const n of this.drawn) {
      if (!n.mesh) continue;
      n.mesh.visible = true;
      this._sphere.center.copy(n.center);
      this._sphere.radius = n.radius;
      if (this.frustum.intersectsSphere(this._sphere)) {
        inView++;
        tris += (this.index.count / 3) | 0;
      }
    }
    this.stats.inView = inView;
    // adapt pixel error to the draw budget
    // (budget on in-frustum chunks = actual draw calls; out-of-view nodes are refined at 4× tau)
    if (inView > this.opts.maxDrawn) this.tau = Math.min(this.tau * 1.08, 8);
    else if (inView < this.opts.maxDrawn * 0.75 && this.tau > this.opts.pixelError) this.tau = Math.max(this.opts.pixelError, this.tau / 1.04);

    if ((this.frame & 31) === 0 || this.liveNodes > 520) this.prune(this.liveNodes > 420 ? 20 : 150);

    this.stats.drawn = this.drawn.length;
    this.stats.nodes = this.liveNodes;
    this.stats.pending = this.jobs.size + this.wanted.length + this.results.length;
    this.stats.triangles = tris;
    this.stats.tau = this.tau;
    this.settled = this.wanted.length === 0 && this.jobs.size === 0 && this.results.length === 0;

    this.scatter?.update(cam, this.terrain, this.gen);
    const near = this.matU.tNear.value;
    if (this.scatter?.active) near.set(cam.x, cam.z, this.scatter.radius * 0.55, this.scatter.radius * 0.95);
    else near.set(cam.x, cam.z, -2, -1);
    if (this.scatter) {
      this.stats.scatter = this.scatter.count;
      if (this.scatter.pending > 0) this.settled = false;
    }
    this.lights?.update(isNight, simTime);
  }

  private nextDrawn: TNode[] = [];
  private results: [TNode, ChunkResult][] = [];
  private camA = 0;
  private camC = 0;
  private camAlt = 0;
  private pxPerRad = 1000;
  private horCam = 0;

  private select(camera: THREE.PerspectiveCamera) {
    const p = camera.position;
    const cx = this.gen.cx, cz = this.gen.cz;
    this.camA = p.x * -cz + p.z * cx;
    this.camC = p.x * cx + p.z * cz;
    this.camAlt = Math.hypot(p.x, p.y + R, p.z) - R;
    const vh = (camera as any).__viewportHeight ?? (typeof innerHeight !== 'undefined' ? innerHeight : 900);
    this.pxPerRad = vh / (2 * Math.tan(((camera.fov / camera.zoom) * Math.PI) / 360));
    this.horCam = Math.sqrt(2 * R * Math.max(this.camAlt, 1));
    this.wanted.length = 0;
    this.nextDrawn.length = 0;
    for (const r of this.roots) this.visit(r);
  }

  private visit(n: TNode) {
    n.lastUsed = this.frame;
    if (n.state !== 2) {
      this.want(n, 1e9 - n.depth);
      return;
    }
    // horizontal distance to the node rectangle (chunk space ≈ surface distance)
    const da = Math.max(n.a0 - this.camA, 0, this.camA - (n.a0 + n.size));
    const dc = Math.max(n.c0 - this.camC, 0, this.camC - (n.c0 + n.size));
    const dh = Math.hypot(da, dc);
    // horizon culling: fully hidden behind the planet's curvature
    if (n.hMax < -3 && n.err < 1) return; // underwater, nothing finer to find
    const hTop = Math.max(n.hMax + n.err, 0);
    if (dh > this.horCam + Math.sqrt(2 * R * hTop) + 800) return;
    const dz = Math.max(n.hMin - n.err - this.camAlt, 0, this.camAlt - n.hMax - n.err);
    // curvature drop makes far chunks effectively further below the camera
    const d3 = Math.max(Math.hypot(dh, dz + (dh * dh) / (2 * R) * (this.camAlt > hTop ? 1 : 0)), 1);
    const errPx = (n.err * this.pxPerRad) / d3;
    let split = false;
    if (n.depth < MAX_DEPTH) {
      this._sphere.center.copy(n.center);
      this._sphere.radius = n.radius;
      const inView = this.frustum.intersectsSphere(this._sphere);
      split = errPx > this.tau * (inView ? 1 : 4) || d3 < n.size * 0.6;
    }
    if (split) {
      if (!n.children) {
        const s = n.size / 2;
        n.children = [
          this.node(n, n.depth + 1, n.a0, n.c0, s),
          this.node(n, n.depth + 1, n.a0 + s, n.c0, s),
          this.node(n, n.depth + 1, n.a0, n.c0 + s, s),
          this.node(n, n.depth + 1, n.a0 + s, n.c0 + s, s),
        ];
      }
      let ready = true;
      for (const c of n.children) {
        c.lastUsed = this.frame;
        if (c.state !== 2) {
          ready = false;
          this.want(c, errPx);
        }
      }
      if (ready) {
        for (const c of n.children) this.visit(c);
        return;
      }
    }
    if (n.mesh) this.nextDrawn.push(n);
  }

  private want(n: TNode, prio: number) {
    n.prio = prio;
    if (n.state === 0) this.wanted.push(n);
  }

  private makeJob(n: TNode): ChunkJob {
    return { id: this.nextId++, a0: n.a0, c0: n.c0, size: n.size, n: N, horizon: true };
  }

  private dispatch() {
    if (!this.wanted.length) return;
    this.wanted.sort((a, b) => b.prio - a.prio);
    const maxPer = 3;
    for (const n of this.wanted) {
      let best = -1;
      for (let i = 0; i < this.workers.length; i++) if (this.inflight[i] < maxPer && (best < 0 || this.inflight[i] < this.inflight[best])) best = i;
      if (best < 0) break;
      const job = this.makeJob(n);
      n.state = 1;
      this.jobs.set(job.id, n);
      this.inflight[best]++;
      this.workers[best].postMessage({ type: 'chunk', job });
    }
    // anything left stays in `wanted` (counted as pending) and is re-requested next frame
    this.wanted = this.wanted.filter((n) => n.state === 0);
  }

  private onWorkerMessage(m: { type: string; r: any }, wi: number) {
    this.inflight[wi] = Math.max(0, (this.inflight[wi] ?? 1) - 1);
    if (m.type === 'chunk') {
      const r = m.r as ChunkResult;
      const n = this.jobs.get(r.id);
      this.jobs.delete(r.id);
      if (!n || n.dead) return;
      this.results.push([n, r]);
    } else if (m.type === 'scatter') {
      const r = m.r as ScatterResult;
      const cb = this.scatterJobs.get(r.id);
      this.scatterJobs.delete(r.id);
      cb?.(r);
    }
  }

  private requestScatter(job: ScatterJob, cb: (r: ScatterResult) => void) {
    if (!this.workers.length) {
      cb(genScatter(this.gen, this.landUse, job));
      return;
    }
    let best = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.inflight[i] < this.inflight[best]) best = i;
    this.inflight[best]++;
    this.scatterJobs.set(job.id, cb);
    this.workers[best].postMessage({ type: 'scatter', job });
  }

  private accept(n: TNode, r: ChunkResult) {
    if (n.state === 2 || n.dead) return;
    n.state = 2;
    n.hMin = r.hMin;
    n.hMax = r.hMax;
    n.err = r.err;
    this.liveNodes++;
    this.stats.genMs = this.stats.genMs * 0.95 + r.ms * 0.05;
    this.stats.genCount++;
    if (r.hMax < -0.3) return; // entirely under the sea (the shader discards below -0.3 m): nothing to draw
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.nrm, 3));
    g.setAttribute('aTex', new THREE.BufferAttribute(r.tex, 4));
    const ib = new THREE.InterleavedBuffer(r.ext, EXT_STRIDE);
    g.setAttribute('aHor0', new THREE.InterleavedBufferAttribute(ib, 4, 0, true));
    g.setAttribute('aHor1', new THREE.InterleavedBufferAttribute(ib, 4, 4, true));
    g.setAttribute('aExt', new THREE.InterleavedBufferAttribute(ib, 4, 8, true));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.name = `terrain_d${n.depth}`;
    m.position.set(r.origin[0], r.origin[1], r.origin[2]);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.updateMatrixWorld(true);
    m.receiveShadow = true;
    m.castShadow = this.opts.castShadows && n.size <= 3200;
    // depth-prepass occluders: land-only chunks (the prepass uses an override material, so it can't
    // discard the seabed the way the colour pass does)
    if (this.opts.occluderLayer >= 0 && n.size <= 6400 && r.hMin > -0.3) m.layers.enable(this.opts.occluderLayer);
    m.visible = false;
    n.mesh = m;
    const bs = g.boundingSphere!;
    n.center.copy(bs.center).add(m.position);
    n.radius = bs.radius;
    this.group.add(m);
  }

  /** Drop subtrees that haven't been visited for a while. */
  private prune(age = 150) {
    const old = this.frame - age;
    const walk = (n: TNode) => {
      if (!n.children) return;
      if (n.children.every((c) => c.lastUsed < old)) {
        for (const c of n.children) this.kill(c);
        n.children = null;
        return;
      }
      for (const c of n.children) walk(c);
    };
    for (const r of this.roots) walk(r);
  }

  private kill(n: TNode) {
    n.dead = true;
    if (n.children) for (const c of n.children) this.kill(c);
    n.children = null;
    if (n.state === 2) this.liveNodes--;
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.setIndex(null); // shared index buffer stays alive
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
  }

  private rebuild() {
    for (const r of this.roots) this.kill(r);
    this.roots = [];
    this.jobs.clear();
    this.results = [];
    this.scatterJobs.clear();
    if (this.scatter) {
      this.group.remove(this.scatter.group);
      this.scatter.dispose();
      this.scatter = null;
    }
    if (this.lights) {
      this.group.remove(this.lights.points);
      this.lights.dispose();
      this.lights = null;
    }
    this.drawn = [];
    this.liveNodes = 0;
    this.init();
  }

  /**
   * Keep these ground areas free of scatter (trees/shrubs/rocks) and paint worn ground there —
   * call with the launcher emplacements (world x, z, radius m). Up to 8 are painted.
   */
  setClearings(list: { x: number; z: number; r: number }[]) {
    this.clearings = list.slice();
    this.scatter?.setClearings(this.clearings);
    const u = this.matU.tClear.value;
    for (let i = 0; i < MAX_CLEARINGS; i++) {
      const c = list[i];
      if (c) u[i].set(c.x, c.z, c.r, 1);
      else u[i].set(0, 0, 0, 0);
    }
    this.matU.tNClear.value = Math.min(list.length, MAX_CLEARINGS);
    // bounding circle so most pixels skip the loop
    const used = list.slice(0, MAX_CLEARINGS);
    if (used.length) {
      const cx = used.reduce((a, c) => a + c.x, 0) / used.length, cz = used.reduce((a, c) => a + c.z, 0) / used.length;
      const r = Math.max(...used.map((c) => Math.hypot(c.x - cx, c.z - cz) + c.r * 1.6));
      this.matU.tClearBound.value.set(cx, cz, r, 0);
    }
  }
  private clearings: { x: number; z: number; r: number }[] = [];

  /** Debug: histogram of drawn chunks per depth, and (depth, err, distance) samples. */
  debugDepths() {
    const hist: number[] = new Array(MAX_DEPTH + 1).fill(0);
    const errs: string[] = [];
    for (const n of this.drawn) {
      hist[n.depth]++;
      const da = Math.max(n.a0 - this.camA, 0, this.camA - (n.a0 + n.size));
      const dc = Math.max(n.c0 - this.camC, 0, this.camC - (n.c0 + n.size));
      if (errs.length < 60) errs.push(`${n.depth}:${n.err.toFixed(1)}@${(Math.hypot(da, dc) / 1000).toFixed(1)}k h${n.hMin.toFixed(0)}..${n.hMax.toFixed(0)}`);
    }
    return { hist, errs };
  }

  /** Rendered height (m above sea level) at world (x, z): exactly Terrain.height() (inside the region). */
  heightAt(x: number, z: number) {
    return this.terrain.height(x, z);
  }

  private disposed = false;
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const r of this.roots) this.kill(r);
    this.roots = [];
    this.scatter?.dispose();
    if (this.lights) {
      this.group.remove(this.lights.points);
      this.lights.dispose();
    }
    this.index = new THREE.BufferAttribute(new Uint16Array(0), 1);
    this.material.dispose();
    this.textures.dispose();
    this.group.removeFromParent();
  }
}

function surfaceYd(x: number, z: number) {
  const d2 = x * x + z * z;
  return -d2 / (R + Math.sqrt(Math.max(R * R - d2, 0)));
}

/** Shared index buffer: (n+1)² grid + 4 skirts, all chunks share it. */
function buildIndex(n: number) {
  const idx: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  // Grid (a along +i, c along +j). With world T × N = +up, triangle (v00, v10, v01) faces up.
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = v(i, j), b = v(i + 1, j), c = v(i, j + 1), d = v(i + 1, j + 1);
      if ((i + j) & 1) idx.push(a, b, c, b, d, c);
      else idx.push(a, b, d, a, d, c);
    }
  const nv = (n + 1) * (n + 1);
  const s0 = nv, s1 = nv + (n + 1), s2 = nv + 2 * (n + 1), s3 = nv + 3 * (n + 1);
  // edge j=0 (outward = −c): (e_i, s_i, e_i+1)
  for (let i = 0; i < n; i++) {
    const e0 = v(i, 0), e1 = v(i + 1, 0), k0 = s0 + i, k1 = s0 + i + 1;
    idx.push(e0, k0, e1, e1, k0, k1);
  }
  // edge j=n (outward = +c): reversed
  for (let i = 0; i < n; i++) {
    const e0 = v(i, n), e1 = v(i + 1, n), k0 = s1 + i, k1 = s1 + i + 1;
    idx.push(e0, e1, k0, e1, k1, k0);
  }
  // edge i=0 (outward = −a)
  for (let j = 0; j < n; j++) {
    const e0 = v(0, j), e1 = v(0, j + 1), k0 = s2 + j, k1 = s2 + j + 1;
    idx.push(e0, e1, k0, e1, k1, k0);
  }
  // edge i=n (outward = +a)
  for (let j = 0; j < n; j++) {
    const e0 = v(n, j), e1 = v(n, j + 1), k0 = s3 + j, k1 = s3 + j + 1;
    idx.push(e0, k0, e1, e1, k0, k1);
  }
  const total = nv + 4 * (n + 1);
  const arr = total > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return new THREE.BufferAttribute(arr, 1);
}
