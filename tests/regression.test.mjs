import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/sim/world.ts';
import { PRESETS, cloneScenario, validateScenario } from '../src/sim/scenario.ts';
import { Threat } from '../src/sim/threat.ts';
import { Track } from '../src/sim/radar.ts';
import { Ship, Decoy } from '../src/sim/entities.ts';
import { Ciws } from '../src/sim/mounts.ts';
import { RoundPool } from '../src/sim/rounds.ts';
import { CIWS_SPEC } from '../src/sim/specs.ts';
import { rng } from '../src/core/rng.ts';
import { SIM_DT, T, DEG } from '../src/core/constants.ts';
import { SimClock } from '../src/core/simClock.ts';
import { PoseHistory } from '../src/game/poseHistory.ts';
import { altitude, setAltitude, upAt, surfaceY } from '../src/core/geo.ts';
import { flyTime, flyTimeDirect } from '../src/sim/flytime.ts';
import { CameraRig } from '../src/camera/cameraRig.ts';
import { FlareEffect } from '../src/render/post.ts';
import { EntityViews } from '../src/render/entityViews.ts';
import { registerModel } from '../src/render/models/registry.ts';

function emptyWorld() {
  const cfg = cloneScenario(PRESETS[0]);
  cfg.waves = [];
  cfg.ship = { speedKts: 0, heading: 0 };
  cfg.doctrine.maneuver = false;
  cfg.doctrine.decoys = false;
  return new World(cfg);
}

function contact(w, local, ttg = 100) {
  const th = new Threat('asm_subsonic');
  th.pos.copy(local).applyMatrix4(w.ship.localToWorld);
  th.vel.copy(w.ship.pos).sub(th.pos).setLength(200);
  const tr = new Track(th, 0);
  tr.firm = true;
  tr.cls = 'hostile';
  tr.hostileTime = 0;
  tr.range = th.pos.distanceTo(w.ship.pos);
  tr.ttg = ttg;
  return tr;
}

function finish(w, extra = () => {}) {
  while (!w.over && w.t < 1500) {
    w.step(SIM_DT);
    extra();
    for (const e of [w.ship, ...w.threats, ...w.interceptors, ...w.decoys, ...w.debris]) {
      assert.ok(Number.isFinite(e.pos.lengthSq()) && Number.isFinite(e.vel.lengthSq()), `${e.kind} has non-finite state at ${w.t}`);
    }
  }
  assert.ok(w.over, `${w.cfg.name} timed out`);
  assert.ok(['sunk', 'survived'].includes(w.outcome));
  return { stats: w.stats, hp: w.ship.hp, outcome: w.outcome, time: w.t, position: w.ship.pos.toArray() };
}

test('same seed replays exactly despite cosmetic draws and interleaved worlds', () => {
  const cfg = cloneScenario(PRESETS.find(p => p.name === 'Night Raid'));
  const a = new World(cloneScenario(cfg));
  const aLogs = [];
  a.events.on('log', e => aLogs.push(e));
  const result = finish(a);
  rng.seed(999);
  const b = new World(cloneScenario(cfg));
  const unrelated = new World(cloneScenario(PRESETS[0]));
  const bLogs = [];
  b.events.on('log', e => { bLogs.push(e); rng.gauss(); });
  b.events.on('detonation', () => { for (let i = 0; i < 100; i++) rng.next(); });
  assert.deepEqual(finish(b, () => { rng.gauss(); unrelated.step(SIM_DT); }), result);
  assert.deepEqual(bLogs, aLogs);
  const different = cloneScenario(cfg);
  different.seed++;
  const c = new World(different);
  const d = new World(cloneScenario(cfg));
  assert.notDeepEqual(c.plan.map(p => p.time), d.plan.map(p => p.time));
});

for (const policy of ['sls', 'auto', 'salvo']) {
  test(`${policy} respects pending shots and the assessment wait`, () => {
    const w = emptyWorld();
    w.cfg.doctrine.policy = policy;
    const tr = contact(w, new THREE.Vector3(0, 100, 7000));
    w.radar.tracks = [tr];
    const fired = [];
    w.events.on('interceptorLaunch', e => fired.push(e.m));
    const evalAt = t => { w.t = t; w.bastion.update(0.25, t); };
    for (let t = 5; t < 10; t += 0.25) evalAt(t);
    const expected = policy === 'salvo' ? 2 : 1;
    assert.equal(fired.length, expected);
    for (const m of fired) { m.result = 'miss'; m.alive = false; }
    evalAt(10);
    if (policy !== 'salvo') {
      assert.equal(fired.length, expected);
      evalAt(10 + T(2.5) - 0.1);
      assert.equal(fired.length, expected);
      evalAt(10 + T(2.5) + 0.25);
      assert.ok(fired.length > expected, 'SLS never retried after assessment');
    }
  });
}

test('CIWS stops on loss of arc and can select a valid replacement', () => {
  const ship = new Ship();
  ship.updateFrame();
  const c = new Ciws('test', new THREE.Vector3(0, 15, 0), 0, 0);
  const rounds = new RoundPool(6000, CIWS_SPEC.dragK);
  const th = new Threat('asm_subsonic');
  th.pos.set(0, 15, -1000);
  th.vel.set(0, 0, 200);
  const update = threats => c.update(SIM_DT, 10, ship, threats, rounds, true, () => {});
  for (let i = 0; i < 120; i++) update([th]);
  assert.ok(c.roundsFired > 0, 'valid target should be engaged');
  const before = c.roundsFired;
  th.pos.z = 1000;
  th.vel.z = -200;
  update([th]);
  assert.equal(c.target, null);
  assert.equal(c.firing, false);
  assert.equal(c.roundsFired, before);
  const replacement = new Threat('asm_subsonic');
  replacement.pos.set(0, 15, -1200);
  replacement.vel.set(0, 0, 200);
  update([th, replacement]);
  assert.equal(c.target, replacement);
  c.burstT = 1;
  c.spin = 1;
  c.update(SIM_DT, 10, ship, [], rounds, false, () => {});
  assert.equal(c.firing, false, 'weapons hold must also stop a trailing burst');
});

test('gun skips a more urgent blocked target and fires on a valid one', () => {
  const w = emptyWorld();
  w.bastion.inventory = { halberd: 0, glaive: 0, stiletto: 0 };
  const rear = contact(w, new THREE.Vector3(0, 20, -2000), 10);
  const front = contact(w, new THREE.Vector3(0, 20, 3000), 15);
  w.radar.tracks = [rear, front];
  assert.equal(w.gun.canEngage(w.ship, rear.threat), false);
  assert.equal(w.gun.canEngage(w.ship, front.threat), true);
  w.bastion.update(0.25, 5);
  assert.equal(w.gunTarget, front.threat);
  for (let i = 0; i < 240; i++) w.gun.update(SIM_DT, w.ship, w.gunTarget, () => {});
  assert.ok(w.gun.shots > 0);
});

test('Wisp converges to hover altitude from above and below', () => {
  for (const initial of [10, 150]) {
    const d = new Decoy('wisp');
    d.pos.set(20000, 0, 10000);
    setAltitude(d.pos, initial);
    d.vel.set(28, 0, 0).addScaledVector(upAt(d.pos), 30);
    for (let i = 0; i < 1200; i++) d.update(SIM_DT, new THREE.Vector3());
    assert.ok(Math.abs(altitude(d.pos) - 40) < 0.1, `hover altitude was ${altitude(d.pos)}`);
    assert.ok(Math.abs(d.vel.dot(upAt(d.pos))) < 0.1);
  }
});

test('flight table handles its first reachable sample and the minimum-range boundary', () => {
  const sample = 200 + (15600 - 200) * (3 / 25) ** 1.5;
  for (const distance of [700, 800, sample]) {
    const f = flyTime('stiletto', distance, 0);
    const direct = flyTimeDirect('stiletto', distance, 0);
    assert.ok(Number.isFinite(f.t), `unreachable table result at ${distance}m`);
    assert.ok(Math.abs(f.t - direct.t) < 0.1);
  }
  assert.equal(flyTime('stiletto', 1e6, 0).t, Infinity);
  for (const distance of [0, -1, NaN, Infinity]) assert.equal(flyTime('stiletto', distance, 0).t, Infinity);
});

test('fixed clock is independent of frame rate and retains budget backlog', () => {
  for (const fps of [24, 60, 144]) {
    const clock = new SimClock();
    const steps = [];
    for (let i = 0; i < fps * 10; i++) clock.advance(1 / fps, h => steps.push(h));
    assert.equal(steps.length, 600);
    assert.ok(steps.every(h => h === SIM_DT));
  }
  const clock = new SimClock();
  let n = 0;
  clock.advance(SIM_DT * 5.5, () => n++, () => true);
  assert.equal(n, 1);
  clock.advance(0, () => n++);
  assert.equal(n, 5);
  clock.advance(SIM_DT / 2, () => n++);
  assert.equal(n, 6);
  clock.advance(SIM_DT / 2, () => n++);
  clock.reset();
  clock.advance(SIM_DT / 2, () => n++);
  assert.equal(n, 6, 'restart retained old fractional time');
});

test('render interpolation smooths substeps and restores physics even if drawing fails', () => {
  const w = emptyWorld();
  const history = new PoseHistory();
  history.capture(w);
  w.ship.pos.x = 40;
  w.ship.updateFrame();
  const matrix = w.ship.localToWorld.clone();
  const quaternion = w.ship.quat.clone();
  history.render(w, 0.25, () => {
    assert.equal(w.ship.pos.x, 10);
    assert.equal(w.ship.localToWorld.elements[12], 10);
  });
  assert.equal(w.ship.pos.x, 40);
  assert.deepEqual(w.ship.quat, quaternion);
  assert.deepEqual(w.ship.localToWorld, matrix);
  assert.throws(() => history.render(w, 0.5, () => { throw new Error('draw failed'); }), /draw failed/);
  assert.equal(w.ship.pos.x, 40);
  assert.deepEqual(w.ship.localToWorld, matrix);
  history.clear();
  history.render(w, 0, () => assert.equal(w.ship.pos.x, 40));
});

test('sea picking and sun occlusion use the actual planet away from the origin', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 5e6);
  const sea = new THREE.Vector3(100000, surfaceY(100000, 0), 0);
  camera.position.copy(sea).addScaledVector(upAt(sea), 10000);
  camera.up.copy(upAt(sea));
  camera.lookAt(sea);
  camera.updateMatrixWorld();
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }) };
  const hit = CameraRig.prototype.seaPointUnder.call({ camera, dom }, 400, 400);
  assert.ok(hit && hit.distanceTo(sea) < 0.001);
  camera.position.set(-100000, surfaceY(-100000, 0) + 1000, 0);
  const sun = new THREE.Vector3(Math.cos(5 * DEG), Math.sin(5 * DEG), 0);
  camera.lookAt(camera.position.clone().addScaledVector(sun, 10000));
  camera.updateMatrixWorld();
  const texture = new THREE.Texture();
  const flare = new FlareEffect(texture);
  flare.track(camera, sun, new THREE.Color('white'), 5);
  assert.equal(flare.uniforms.get('uVis').value, 0, 'sun behind the actual planet should be occluded');
  flare.dispose();
  texture.dispose();
});

test('entity disposal releases run-owned resources but preserves shared model assets', () => {
  globalThis.innerHeight = 720;
  const sharedGeo = new THREE.BoxGeometry(1, 1, 1);
  const sharedMat = new THREE.MeshBasicMaterial();
  registerModel('asm_subsonic', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(sharedGeo, sharedMat));
    const exhaust = new THREE.Group();
    exhaust.name = 'exhaust';
    group.add(exhaust);
    return group;
  });
  const w = emptyWorld();
  w.launchers = [];
  w.threats = [new Threat('asm_subsonic')];
  w.threats[0].pos.set(100, 100, 100);
  w.decoys = [new Decoy('wisp')];
  const views = new EntityViews({ spawn() {} }, { add() {} });
  const scene = new THREE.Scene();
  scene.add(views.group);
  views.update(w, new THREE.PerspectiveCamera(), SIM_DT);
  const resources = new Set();
  views.group.traverse(o => {
    if (!o.isMesh) return;
    if (o.geometry !== sharedGeo && o.parent?.name !== 'exhaust' && !o.material.isShaderMaterial) resources.add(o.geometry);
    // Plume geometry and nozzle geometry are shared too. Trail geometry is owned per view.
    if (o.geometry.attributes.aTan) resources.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m !== sharedMat) resources.add(m);
  });
  const disposed = new Set();
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.add(resource));
  let sharedDisposed = false;
  sharedGeo.addEventListener('dispose', () => { sharedDisposed = true; });
  sharedMat.addEventListener('dispose', () => { sharedDisposed = true; });
  views.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(views.group.children.length, 0);
  assert.equal(disposed.size, resources.size);
  assert.equal(sharedDisposed, false);
  views.dispose(); // safe on repeated cleanup
  sharedGeo.dispose();
  sharedMat.dispose();
  delete globalThis.innerHeight;
});

test('scenario validation rejects invalid input and accepts every preset', () => {
  for (const p of PRESETS) assert.deepEqual(validateScenario(p), [], p.name);
  for (const value of [0, -1, 1.5, 201, NaN]) {
    const cfg = cloneScenario(PRESETS[0]);
    cfg.waves[0].count = value;
    assert.ok(validateScenario(cfg).length);
  }
  const cfg = cloneScenario(PRESETS[0]);
  cfg.loadout.gunRounds = NaN;
  assert.ok(validateScenario(cfg).some(e => e.startsWith('gunRounds')));
  cfg.loadout.gunRounds = 600;
  cfg.loadout.glaive = cfg.loadout.halberd = 96;
  assert.ok(validateScenario(cfg).some(e => e.includes('96 VLS cells')));
  const empty = emptyWorld();
  assert.deepEqual(validateScenario(empty.cfg, true), []);
  empty.step(SIM_DT);
  assert.equal(empty.outcome, 'survived');
});

for (const preset of PRESETS) {
  test(`preset completes with finite state: ${preset.name}`, () => {
    const w = new World(cloneScenario(preset));
    finish(w);
    assert.ok(w.stats.killed <= w.stats.launched);
    assert.ok(w.ship.hp >= 0 && w.ship.hp <= w.ship.maxHp);
  });
}
