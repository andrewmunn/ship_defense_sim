import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { Atmosphere } from './render/atmosphere';
import { Ocean } from './render/ocean';
import { WaveField } from './sim/waves';
import { CameraRig } from './camera/cameraRig';

const P = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffffff, 1, 2); // enables USE_FOG → our aerial perspective chunks
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 5e6);
const R = new Renderer(app, scene, camera);
const atm = new Atmosphere(R.renderer, scene);
if (P.has('tod')) atm.setState({ timeOfDay: parseFloat(P.get('tod')!) });
const waves = new WaveField(parseFloat(P.get('sea') ?? '3'), 0.6);
const ocean = new Ocean(waves, atm.skyCube);
scene.add(ocean.mesh);

// placeholder ship
const box = new THREE.Mesh(new THREE.BoxGeometry(20, 14, 150), new THREE.MeshStandardMaterial({ color: 0x7b8387, roughness: 0.6 }));
box.position.y = 3;
box.castShadow = box.receiveShadow = true;
scene.add(box);

const rig = new CameraRig(camera, R.renderer.domElement);
rig.groundHeight = (x, z) => waves.heightAt(x, z, t);
rig.yaw = rig.yawGoal = parseFloat(P.get('yaw') ?? '0.6');
rig.pitch = rig.pitchGoal = parseFloat(P.get('pitch') ?? '0.12');
rig.dist = rig.distGoal = parseFloat(P.get('dist') ?? '320');
rig.lookAtPoint(new THREE.Vector3(0, 5, 0));
rig.cut({ focus: new THREE.Vector3(0, 5, 0) });

let t = 0;
let last = performance.now();
let frames = 0;
R.renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  rig.update(dt);
  atm.update(camera, rig.focus, 200, t);
  ocean.update(camera, t, atm.keyDir, atm.sunLight.color, atm.keyIntensity);
  R.render(dt);
  if (++frames === 10) (window as any).__ready = true;
});
