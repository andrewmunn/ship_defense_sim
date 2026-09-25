import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { createModel, listModels } from '../../index';

// Standalone model viewer / screenshot harness.
// URL params:
//   model=<name>        registered model name
//   az=<deg> el=<deg>   camera azimuth (0 = looking from +Z / bow side toward origin, 90 = from +X / port) and elevation
//   dist=<m>            camera distance (default auto from bounding sphere)
//   tx,ty,tz=<m>        orbit target (default bounding-sphere center)
//   fov=<deg>           field of view (default 35)
//   water=0|1           show a water plane at y=0 (default 1)
//   sun=<az>,<el>       sun direction in degrees (default 35,30)
//   wire=1              wireframe overlay
//   bg=sky|grey         background (default sky)
const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? parseFloat(P.get(k)!) : d);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 35), innerWidth / innerHeight, 0.05, 50000);

// Sky + environment
const sunAz = THREE.MathUtils.degToRad(parseFloat((P.get('sun') ?? '35,30').split(',')[0]));
const sunEl = THREE.MathUtils.degToRad(parseFloat((P.get('sun') ?? '35,30').split(',')[1]));
const sunDir = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), Math.cos(sunAz) * Math.cos(sunEl));
const sky = new Sky();
sky.scale.setScalar(10000);
const su = sky.material.uniforms;
su.turbidity.value = 4;
su.rayleigh.value = 1.5;
su.mieCoefficient.value = 0.005;
su.mieDirectionalG.value = 0.8;
su.sunPosition.value.copy(sunDir);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
scene.environment = pmrem.fromScene(envScene as any).texture;
scene.environmentIntensity = num('envi', 1);
renderer.toneMappingExposure = num('exp', 0.6);
if ((P.get('bg') ?? 'sky') === 'sky') scene.add(sky);
else scene.background = new THREE.Color(0x505560);

const sun = new THREE.DirectionalLight(0xfff4e0, 3.0);
sun.position.copy(sunDir).multiplyScalar(300);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

if ((P.get('water') ?? '1') === '1') {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0x0b2a3a, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.85 })
  );
  water.receiveShadow = true;
  scene.add(water);
}

const name = P.get('model') ?? 'vanguard';
const info = document.getElementById('info')!;
const model = createModel(name);
if (!model) {
  info.textContent = `Unknown model "${name}". Available: ${listModels().join(', ')}`;
} else {
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  scene.add(model);
  if (P.get('pose') === '1') {
    const g = (n: string) => model.getObjectByName(n)!;
    g('gun_mount').rotation.y = 0.7; g('gun_elev').rotation.x = -0.45;
    g('ciws_fwd_mount').rotation.y = 0.9; g('ciws_fwd_elev').rotation.x = -0.6;
    g('ciws_aft_mount').rotation.y = 2.4; g('ciws_aft_elev').rotation.x = -0.4;
    g('illum_fwd').rotation.y = 0.5; g('illum_fwd_elev').rotation.x = -0.5;
    g('illum_aft_port').rotation.y = 1.8; g('illum_aft_port_elev').rotation.x = -0.3;
    g('illum_aft_stbd').rotation.y = -2.0; g('illum_aft_stbd_elev').rotation.x = -0.7;
    g('radar_surface').rotation.y = 0.8; g('radar_horizon').rotation.y = 1.2;
    for (let i = 0; i < 32; i += 3) g('vls_fwd_hatch_' + i).rotation.x = 1.6;
    for (let i = 0; i < 64; i += 5) g('vls_aft_hatch_' + i).rotation.x = 1.6;
    // markers at empties
    const mk = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    model.traverse((o) => {
      if (/muzzle|exhaust|decoy_launcher_|bow_spray|stern_wake|mast_top|bridge_cam|flight_deck_center/.test(o.name)) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), mk);
        o.add(s);
        const ax = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2, 6).translate(0, 1, 0).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x00ffff }));
        o.add(ax);
      }
    });
    const cells = [...(model.getObjectByName('vls_fwd')!.userData.cells), ...(model.getObjectByName('vls_aft')!.userData.cells)];
    for (const c of cells) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffff00 })); s.position.set(c.x, c.y, c.z); model.add(s); }
    const hb = model.userData.hitBoxes as { center: number[]; size: number[] }[];
    if (P.get('hb') === '1') for (const b of hb) { const m = new THREE.Mesh(new THREE.BoxGeometry(...(b.size as [number, number, number])), new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true })); m.position.set(b.center[0], b.center[1], b.center[2]); model.add(m); }
  }
  if (P.get('wire') === '1') {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const w = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.25 }));
        m.add(w);
      }
    });
  }
}

const box = new THREE.Box3();
if (model) box.setFromObject(model);
const bs = box.getBoundingSphere(new THREE.Sphere());
const target = new THREE.Vector3(num('tx', bs.center.x), num('ty', bs.center.y), num('tz', bs.center.z));
const dist = num('dist', bs.radius * 2.6 + 1);
const az = THREE.MathUtils.degToRad(num('az', 35));
const el = THREE.MathUtils.degToRad(num('el', 18));
camera.position.set(
  target.x + Math.sin(az) * Math.cos(el) * dist,
  target.y + Math.sin(el) * dist,
  target.z + Math.cos(az) * Math.cos(el) * dist
);
camera.near = Math.max(0.02, dist / 2000);
camera.updateProjectionMatrix();
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target);
controls.update();

sun.target.position.copy(bs.center);
const sr = Math.max(bs.radius, 1) * 1.2;
Object.assign(sun.shadow.camera, { left: -sr, right: sr, top: sr, bottom: -sr, near: 1, far: 1000 });
sun.position.copy(bs.center).addScaledVector(sunDir, 400);
sun.shadow.camera.updateProjectionMatrix();

let tris = 0;
let meshes = 0;
model?.traverse((o) => {
  const m = o as THREE.Mesh;
  if (m.isMesh) {
    meshes++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
});
if (model) info.textContent = `${name} | tris ${Math.round(tris).toLocaleString()} | meshes ${meshes} | size ${box.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2)).join(' x ')} m`;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.info.reset(); renderer.render(scene, camera);
  if (frames === 3 && model) { const calls = renderer.info.render.calls, tr = renderer.info.render.triangles; console.log(`[vanguard] frame calls=${calls} tris=${tr}`); }
  if (++frames === 5) { (window as any).__ready = true; if (P.get('twice') === '1' && model) { const t = performance.now(); createModel(name); console.log('[vanguard] second create ' + (performance.now() - t).toFixed(1) + ' ms'); } }
  const spin = num('spin', 0);
  if (spin && model) { for (const n of ['radar_surface','radar_horizon']) { const o = model.getObjectByName(n); if (o) o.rotation.y += 0.02; } }
});
