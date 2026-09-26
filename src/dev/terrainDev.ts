import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { Atmosphere, atmUniforms } from '../render/atmosphere';
import { Ocean } from '../render/ocean';
import { WaveField } from '../sim/waves';
import { Terrain } from '../sim/terrain';
import { TerrainView } from '../render/terrainView';
import { destination, setAltitude, enuAt, bearingDir, altitude } from '../core/geo';
import { DEG } from '../core/constants';
import { createModel, listModels } from '../render/models/index';
import { OCCLUDER_LAYER } from '../render/sceneDepth';

/**
 * Terrain dev / screenshot page: /terrain.html?<params>
 *  tod=15.5 vis=90000 clouds=0.45 sea=3 fov=50 workers=n
 *  Camera (pick one):
 *   cam=brgDeg,distKm,altM        position by bearing/distance from the origin (alt above sea level)
 *   agl=1                         treat altM as height above the terrain
 *   site=k&sd=m&sb=deg&sa=m       near launch site k (0..2): distance sd from the site, bearing sb from it, height sa AGL
 *  Look:
 *   yaw=deg pitch=deg             bearing / elevation of the view direction
 *   look=site                     look at the launch site (with site=k)
 *   look=brg,distKm,altM          look at a point
 *  tel=1 (place launchers at the sites), ship=0 (hide placeholder ship), fly=1 (mouse drag look + WASD)
 */
const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? parseFloat(P.get(k)!) : d);
const vec = (k: string) => (P.get(k) ?? '').split(',').map(parseFloat);

const app = document.getElementById('app')!;
const info = document.getElementById('info')!;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffffff, 1, 2);
const camera = new THREE.PerspectiveCamera(num('fov', 50), innerWidth / innerHeight, 0.3, 5e6);
const R = new Renderer(app, scene, camera);
const atm = new Atmosphere(R.renderer, scene);
atm.setState({ timeOfDay: num('tod', 15.5), visibility: num('vis', 90000), cloudCover: num('clouds', 0.45) });
const waves = new WaveField(num('sea', 3), 0.6);
const ocean = new Ocean(waves, atm.skyCube);
if (P.get('ocean') !== '0') scene.add(ocean.mesh);

const coastBrg = num('coast', 40) * DEG;
const coastKm = num('coastKm', 38);
const terrain = new Terrain(coastBrg, coastKm * 1000);
const tvOpts: any = {};
if (P.has('workers')) tvOpts.workers = num('workers', 4);
if (P.get('tcast') === '0') tvOpts.castShadows = false;
if (P.get('scatter') === '0') tvOpts.scatter = false;
if (P.has('tau')) tvOpts.pixelError = num('tau', 1.25);
if (P.has('maxdrawn')) tvOpts.maxDrawn = num('maxdrawn', 150);
if (P.get('ao') !== '0') tvOpts.occluderLayer = OCCLUDER_LAYER;
const tv = new TerrainView(terrain, R.renderer, tvOpts);
scene.add(tv.group);
(window as any).tv = tv;
(window as any).camera = camera;
(window as any).THREE = THREE;
(window as any).terrain = terrain;

if (P.get('ship') !== '0') {
  const box = new THREE.Mesh(new THREE.BoxGeometry(20, 14, 150), new THREE.MeshStandardMaterial({ color: 0x7b8387, roughness: 0.6 }));
  box.position.y = 3;
  box.castShadow = box.receiveShadow = true;
  scene.add(box);
}

// ---- launch sites (mirrors World.placeSites / coastPoint)
function coastPoint(b: number) {
  const o = new THREE.Vector3();
  const f = (d: number) => {
    const p = destination(o, b, d);
    return terrain.inland(p.x, p.z) > 0 && terrain.height(p.x, p.z) > 2;
  };
  let d = 1000;
  while (d < 250000 && !f(d)) d += 500;
  let hi = d, lo = Math.max(1000, d - 500);
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (f(m)) hi = m;
    else lo = m;
  }
  return hi;
}
const sites: { p: THREE.Vector3; b: number }[] = [];
const nSites = 3;
const spread = Math.min(70, 12 + nSites * 9) * DEG;
for (let i = 0; i < nSites; i++) {
  const b = coastBrg + (i / (nSites - 1) - 0.5) * 2 * spread;
  const d = coastPoint(b) + 2200;
  const p = destination(new THREE.Vector3(), b, d);
  setAltitude(p, Math.max(terrain.height(p.x, p.z), 2));
  sites.push({ p, b });
}
const tels: THREE.Object3D[] = [];
if (P.get('tel') === '1' || P.has('site')) {
  const hasTel = listModels().includes('tel');
  for (const s of sites) {
    for (let k = 0; k < 2; k++) {
      const off = bearingDir(s.p, s.b + Math.PI / 2, new THREE.Vector3()).multiplyScalar((k - 0.5) * 60);
      const pos = s.p.clone().add(off);
      setAltitude(pos, Math.max(terrain.height(pos.x, pos.z), 2) + 0.05);
      const m = hasTel ? createModel('tel')! : new THREE.Mesh(new THREE.BoxGeometry(3, 3.5, 12).translate(0, 1.75, 0), new THREE.MeshStandardMaterial({ color: 0x5a5b40 }));
      const heading = s.b + Math.PI;
      const { e, n, u } = enuAt(pos);
      const f = n.clone().multiplyScalar(Math.cos(heading)).addScaledVector(e, Math.sin(heading));
      const x = new THREE.Vector3().crossVectors(u, f).normalize();
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, u, f));
      m.position.copy(pos);
      const rack = m.getObjectByName('tel_rack');
      if (rack) rack.rotation.x = -num('erect', 0) * DEG;
      m.traverse((o) => {
        const me = o as THREE.Mesh;
        if (me.isMesh) me.castShadow = me.receiveShadow = true;
        o.layers.enable(OCCLUDER_LAYER);
      });
      scene.add(m);
      tels.push(m);
    }
  }
}

if (tels.length) tv.setClearings(tels.map((m) => ({ x: m.position.x, z: m.position.z, r: 16 })));

// ---- camera placement
const camPos = new THREE.Vector3();
const lookAt = new THREE.Vector3();
let yaw = num('yaw', coastBrg / DEG) * DEG;
let pitch = num('pitch', 1) * DEG;
let useLook = false;
let shadowFocus: THREE.Vector3 | null = null;
if (P.has('site')) {
  const s = sites[Math.min(nSites - 1, num('site', 1))];
  const sb = num('sb', s.b / DEG + 180) * DEG;
  camPos.copy(destination(s.p, sb, num('sd', 80)));
  setAltitude(camPos, terrain.height(camPos.x, camPos.z) + num('sa', 3));
  shadowFocus = s.p.clone();
  if ((P.get('look') ?? 'site') === 'site') {
    lookAt.copy(s.p);
    setAltitude(lookAt, terrain.height(s.p.x, s.p.z) + num('lh', 3));
    useLook = true;
  }
} else {
  const [b, dk, a] = P.has('cam') ? vec('cam') : [0, 0, 20];
  camPos.copy(destination(new THREE.Vector3(), b * DEG, dk * 1000));
  const g = P.get('agl') === '1' ? Math.max(terrain.height(camPos.x, camPos.z), 0) : 0;
  setAltitude(camPos, g + a);
}
if (P.has('look') && P.get('look') !== 'site') {
  const [b, dk, a] = vec('look');
  lookAt.copy(destination(new THREE.Vector3(), b * DEG, dk * 1000));
  setAltitude(lookAt, a);
  useLook = true;
}
camera.position.copy(camPos);
function aim() {
  const { e, n, u } = enuAt(camera.position);
  camera.up.copy(u);
  if (useLook) {
    camera.lookAt(lookAt);
    // derive yaw/pitch for fly mode
    const d = lookAt.clone().sub(camera.position).normalize();
    pitch = Math.asin(THREE.MathUtils.clamp(d.dot(u), -1, 1));
    yaw = Math.atan2(d.dot(e), d.dot(n));
    useLook = false;
    return;
  }
  const dir = n.multiplyScalar(Math.cos(yaw) * Math.cos(pitch)).addScaledVector(e, Math.sin(yaw) * Math.cos(pitch)).addScaledVector(u, Math.sin(pitch));
  camera.lookAt(camera.position.clone().add(dir));
}
aim();

// ---- optional fly controls
const keys = new Set<string>();
if (P.get('fly') === '1' || !P.has('cam')) {
  let drag = false, lx = 0, ly = 0;
  addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; });
  addEventListener('pointerup', () => (drag = false));
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    yaw += (e.clientX - lx) * 0.003;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - ly) * 0.003, -1.5, 1.5);
    lx = e.clientX; ly = e.clientY;
  });
  addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
}

// GPU frame timing (EXT_disjoint_timer_query_webgl2)
const gl = R.renderer.getContext() as WebGL2RenderingContext;
const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const queries: WebGLQuery[] = [];
let gpuMs = 0;
const gpuSamples: number[] = [];
function gpuBegin() {
  if (!tq) return null;
  const q = gl.createQuery()!;
  gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
  return q;
}
function gpuEnd(q: WebGLQuery | null) {
  if (!q || !tq) return;
  gl.endQuery(tq.TIME_ELAPSED_EXT);
  queries.push(q);
  while (queries.length) {
    const q0 = queries[0];
    if (!gl.getQueryParameter(q0, gl.QUERY_RESULT_AVAILABLE)) break;
    const ns = gl.getQueryParameter(q0, gl.QUERY_RESULT) as number;
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) {
      gpuSamples.push(ns / 1e6);
      if (gpuSamples.length > 120) gpuSamples.shift();
      const sorted = [...gpuSamples].sort((a, b) => a - b);
      gpuMs = sorted[sorted.length >> 1];
      (window as any).__gpu = gpuMs;
      (window as any).__gpuMin = sorted[0];
    }
    gl.deleteQuery(q0);
    queries.shift();
  }
}
if (P.get('terrain') === '0') tv.group.visible = false;
if (P.get('tmat') === 'plain') {
  const pm = tv.material as any;
  pm.onBeforeCompile = (THREE.Material.prototype as any).onBeforeCompile;
  pm.customProgramCacheKey = () => 'plain';
  pm.color.setRGB(0.3, 0.25, 0.2);
}
if (P.has('tdef')) {
  // debug: shader feature toggles, e.g. tdef=NO_TOWNS,NO_DETAIL
  for (const d of P.get('tdef')!.split(',')) (tv.material as any).defines = { ...((tv.material as any).defines ?? {}), [d]: '' };
  tv.material.needsUpdate = true;
}

// ---- benchmark: alternate terrain off / plain material / full material in the same page
const bench = P.get('bench') === '1';
const plainMat = new THREE.MeshStandardMaterial({ color: 0x4d4033, roughness: 0.9 });
const benchRes: Record<string, number[]> = { off: [], plain: [], full: [] };
let benchPhase = -1;
let benchFrame = 0;
function setVariant(v: string) {
  tv.group.visible = v !== 'off';
  tv.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name.startsWith('terrain')) m.material = v === 'plain' ? plainMat : tv.material;
  });
}

let t = 0;
let last = performance.now();
let frames = 0;
let settledFrames = 0;
let fpsAcc = 0, fpsN = 0, fps = 0;
const tStart = performance.now();
R.renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (keys.size) {
    const alt = altitude(camera.position);
    const sp = Math.max(20, Math.abs(alt) * 1.2) * (keys.has('shift') ? 5 : 1) * dt;
    const f = new THREE.Vector3();
    camera.getWorldDirection(f);
    const r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
    if (keys.has('w')) camera.position.addScaledVector(f, sp);
    if (keys.has('s')) camera.position.addScaledVector(f, -sp);
    if (keys.has('d')) camera.position.addScaledVector(r, sp);
    if (keys.has('a')) camera.position.addScaledVector(r, -sp);
    if (keys.has('e')) camera.position.addScaledVector(camera.up, sp);
    if (keys.has('q')) camera.position.addScaledVector(camera.up, -sp);
  }
  aim();
  let focus = shadowFocus;
  if (!focus) {
    // shadow focus: ground point ~120 m ahead of the camera (or straight below when high)
    const f = camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 120);
    focus = setAltitude(f, Math.max(terrain.height(f.x, f.z), 0));
  }
  atm.update(camera, focus, num('shadow', shadowFocus ? 160 : 250), t);
  ocean.update(camera, t, atm.keyDir, atm.sunLight.color, atm.keyIntensity);
  const tu = performance.now();
  tv.update(camera, t, atmUniforms.uNight.value);
  const upd = performance.now() - tu;
  (R as any).sceneDepth?.update(scene, camera, t);
  let q: WebGLQuery | null = null;
  if (bench && (window as any).__ready) {
    const order = ['off', 'plain', 'full'];
    if (benchPhase < 0) { benchPhase = 0; benchFrame = 0; setVariant(order[0]); }
    const v = order[benchPhase % 3];
    q = gpuBegin();
    R.render(dt);
    if (q && tq) {
      gl.endQuery(tq.TIME_ELAPSED_EXT);
      const qq = q;
      const tag = v;
      const poll = () => {
        if (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) return void setTimeout(poll, 5);
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) benchRes[tag].push((gl.getQueryParameter(qq, gl.QUERY_RESULT) as number) / 1e6);
        gl.deleteQuery(qq);
      };
      setTimeout(poll, 5);
    }
    if (++benchFrame >= 20) {
      benchFrame = 0;
      benchPhase++;
      setVariant(order[benchPhase % 3]);
    }
    if (benchPhase >= 30 && !(window as any).__bench) {
      const out: Record<string, string> = {};
      for (const k of order) {
        const a = benchRes[k].slice(3).sort((x, y) => x - y);
        out[k] = `min ${a[0]?.toFixed(2)} p25 ${a[a.length >> 2]?.toFixed(2)} med ${a[a.length >> 1]?.toFixed(2)} n ${a.length}`;
      }
      (window as any).__bench = out;
    }
  } else {
    q = gpuBegin();
    R.render(dt);
    gpuEnd(q);
  }
  frames++;
  if (tv.settled) settledFrames++;
  else settledFrames = 0;
  if (!(window as any).__ready && frames > 10 && (settledFrames > 8 || now - tStart > 45000)) {
    (window as any).__ready = true;
    console.log(`[terrain] ready after ${(now - tStart).toFixed(0)} ms, ${tv.stats.genCount} chunks generated, avg ${tv.stats.genMs.toFixed(1)} ms/chunk`);
  }
  if (frames % 10 === 0 && P.get('info') !== '0') {
    const s = tv.stats;
    const info2 = R.renderer.info;
    info.textContent =
      `fps ${fps.toFixed(0)}  gpu ${gpuMs.toFixed(2)} ms  update ${upd.toFixed(2)} ms\n` +
      `chunks selected ${s.drawn}  in view ${s.inView}  cached ${s.nodes}  pending ${s.pending}  tau ${s.tau.toFixed(2)}\n` +
      `terrain tris ${(s.triangles / 1000).toFixed(0)}k  scene tris ${(info2.render.triangles / 1000).toFixed(0)}k  calls ${info2.render.calls}\n` +
      `gen ${s.genMs.toFixed(1)} ms/chunk (${s.genCount})  scatter ${s.scatter}\n` +
      `cam alt ${altitude(camera.position).toFixed(0)} m  ground ${Math.max(0, terrain.height(camera.position.x, camera.position.z)).toFixed(0)} m`;
  }
});
