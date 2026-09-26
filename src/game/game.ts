import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { Atmosphere, atmUniforms } from '../render/atmosphere';
import { Ocean } from '../render/ocean';
import { CameraRig, Trackable } from '../camera/cameraRig';
import { World } from '../sim/world';
import { ScenarioConfig, cloneScenario, PRESETS } from '../sim/scenario';
import { ShipView } from '../render/shipView';
import { EntityViews, prewarmGroup } from '../render/entityViews';
import { Fx } from '../render/fx';
import { Wake } from '../render/wake';
import { Particles } from '../render/particles';
import { Glows, Streaks } from '../render/glows';
import { Emitter } from '../core/events';
import { TerrainView } from '../render/terrainView';
import { CloudShell } from '../render/clouds';
import { OCCLUDER_LAYER } from '../render/sceneDepth';
import type { Entity } from '../sim/entities';
import { altitude, upAt, enuAt } from '../core/geo';
import { DEG, SIM_DT } from '../core/constants';
import { SimClock } from '../core/simClock';
import { PoseHistory } from './poseHistory';

export const TIME_SCALES = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

export interface GameEvents {
  restart: { world: World };
  select: { entity: Entity | null };
  timeScale: { scale: number; paused: boolean };
  frame: { dtReal: number; dtSim: number };
}

/** Optional systems that attach to the game (terrain, audio, director...). */
export interface GamePlugin {
  onRestart?(world: World): void;
  update?(dtReal: number, dtSim: number): void;
  dispose?(): void;
}

const _v = new THREE.Vector3(), _u = new THREE.Vector3();

export class Game {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  R: Renderer;
  atm: Atmosphere;
  ocean!: Ocean;
  rig: CameraRig;
  world!: World;
  cfg: ScenarioConfig;
  shipView: ShipView;
  entities!: EntityViews;
  fx!: Fx;
  wake!: Wake;
  particles = new Particles(1 << 17);
  glows = new Glows(4096);
  streaks = new Streaks(12000);
  events = new Emitter<GameEvents>();
  plugins: GamePlugin[] = [];
  timeScale = 1;
  paused = false;
  selected: Entity | null = null;
  hovered: Entity | null = null;
  private last = performance.now();
  frames = 0;
  fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;
  /** Real-time seconds since start (UI animations). */
  realTime = 0;
  /** Scale the whole planet-fixed world by an exposure (auto-exposure-ish for night). */
  exposure = 1;
  private worldGroup = new THREE.Group();
  terrainView: TerrainView | null = null;
  clouds = new CloudShell();
  private terrainKey = '';
  private simClock = new SimClock();
  private poses = new PoseHistory();

  constructor(public container: HTMLElement) {
    const scene = this.scene;
    scene.fog = new THREE.Fog(0xffffff, 1, 2); // enables USE_FOG → aerial perspective chunks
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 5e6);
    this.R = new Renderer(container, scene, this.camera);
    this.atm = new Atmosphere(this.R.renderer, scene);
    this.rig = new CameraRig(this.camera, this.R.renderer.domElement);
    this.shipView = new ShipView();
    scene.add(this.shipView.root);
    scene.add(this.worldGroup);
    scene.add(this.particles.mesh, this.glows.mesh, this.streaks.mesh, this.clouds.mesh);
    const P = new URLSearchParams(location.search);
    const preset = PRESETS.find((p) => p.name.toLowerCase().replace(/[^a-z]/g, '') === (P.get('scenario') ?? '').toLowerCase().replace(/[^a-z]/g, '')) ?? PRESETS.find((p) => p.name === 'Saturation (TOT)')!;
    this.cfg = cloneScenario(preset);
    this.restart(this.cfg);
    this.rig.cut({ focus: this.world.ship.pos.clone().add(new THREE.Vector3(0, 8, 0)), yaw: 2.4, pitch: 0.16, dist: 260 });
    this.rig.follow(this.world.ship, { dist: 260 });
  }

  /**
   * Compile every shader program and upload every texture the fight will need, while the loading
   * screen is up. Without this the first missile launch / explosion of each kind stalls the frame
   * for tens to hundreds of milliseconds (shader compiles are especially slow on ANGLE/Metal).
   */
  private prewarm() {
    const g = prewarmGroup();
    // in front of the camera so nothing is frustum-culled out of the compile
    this.camera.updateMatrixWorld();
    g.position.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(_v), 60);
    this.scene.add(g);
    const r = this.R.renderer;
    g.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats])
        for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) r.initTexture(v as THREE.Texture);
    });
    // A real render (not renderer.compile) into the composer's linear render target, with culling
    // off: compile() targets the canvas (sRGB output) and skips the back/front split that transparent
    // double-sided materials get, so it builds the wrong program variants.
    // pooled meshes that start hidden (all trail slots share one program)
    const hidden = [this.entities.trails.group.children[0]].filter((o) => o && !o.visible);
    for (const o of hidden) o.visible = true;
    const culled: THREE.Object3D[] = [];
    this.scene.traverse((o) => { if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); } });
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.R.composer.inputBuffer);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    for (const o of culled) o.frustumCulled = true;
    for (const o of hidden) o.visible = false;
    this.scene.remove(g);
  }

  /** (Re)build the world from a scenario config. */
  restart(cfg: ScenarioConfig) {
    this.cfg = cloneScenario(cfg);
    const world = new World(this.cfg, this.shipView.layout);
    world.ship.setHitBoxes(this.shipView.hitBoxes);
    world.ship.updateFrame();
    this.simClock.reset();
    this.poses.clear();
    const oldShip = this.world?.ship;
    this.world = world;
    // environment
    const env = this.cfg.env;
    this.atm.setState({ timeOfDay: env.timeOfDay, visibility: env.visibilityKm * 1000, cloudCover: env.clouds });
    if (!this.ocean) {
      this.ocean = new Ocean(world.waves, this.atm.skyCube);
      this.scene.add(this.ocean.mesh);
      this.wake = new Wake(this.ocean);
    } else {
      this.ocean.waves = world.waves;
      this.wake.reset();
    }
    this.ocean.setSeaState(env.seaState);
    // coastal terrain (rebuilt only when the coastline changes)
    const key = `${this.cfg.coastBearing}/${this.cfg.coastKm}`;
    if (!this.terrainView || key !== this.terrainKey) {
      if (this.terrainView) {
        this.scene.remove(this.terrainView.group);
        this.terrainView.dispose();
      }
      this.terrainView = new TerrainView(world.terrain, this.R.renderer, { occluderLayer: OCCLUDER_LAYER });
      this.scene.add(this.terrainView.group);
      this.terrainKey = key;
    }
    this.terrainView.setClearings(world.launchers.map((L) => ({ x: L.pos.x, z: L.pos.z, r: 22 })));
    this.rig.groundHeight = (x, z) => this.world.waves.heightAt(x, z, this.world.t);
    // views
    this.entities?.dispose();
    this.fx?.dispose();
    this.particles.clear();
    this.entities = new EntityViews(this.particles, this.glows);
    this.worldGroup.add(this.entities.group);
    this.fx = new Fx(world, this.shipView, this.particles, this.glows, this.streaks);
    this.fx.onBig = (pos, kind, size) => this.onBig(pos, kind, size);
    this.shipView.clearDamage();
    world.events.on('shipHit', (e) => this.shipView.addScorch(e.local, THREE.MathUtils.clamp(4 + e.damage * 0.25, 5, 16), world.t));
    this.worldGroup.add(this.fx.group);
    this.shipView.update(world, 0, 0);
    // keep the camera on the ship across restarts
    if (this.rig.target === oldShip || !this.rig.target) this.rig.follow(world.ship, { dist: this.rig.distGoal });
    this.select(null);
    for (const p of this.plugins) p.onRestart?.(world);
    this.events.emit('restart', { world });
  }

  addPlugin(p: GamePlugin) {
    this.plugins.push(p);
    p.onRestart?.(this.world);
  }

  /** Adaptive resolution: drop render scale when the frame rate sags, recover slowly when there's headroom. */
  adaptiveRes = true;
  private lowFps = 0;
  private highFps = 0;
  private adaptResolution() {
    if (!this.adaptiveRes || document.hidden) return;
    const R = this.R;
    if (this.fps < 44) { this.lowFps++; this.highFps = 0; }
    else if (this.fps > 57) { this.highFps++; this.lowFps = 0; }
    else { this.lowFps = 0; this.highFps = 0; }
    if (this.lowFps >= 4) { R.setPixelRatio(R.pixelRatio - 0.15); this.lowFps = 0; }
    if (this.highFps >= 16 && R.pixelRatio < R.maxPixelRatio) { R.setPixelRatio(R.pixelRatio + 0.1); this.highFps = 0; }
  }

  /** Hook for notable explosions etc. (camera shake near the camera). */
  private onBig(pos: THREE.Vector3, kind: string, size: number) {
    const d = pos.distanceTo(this.camera.position);
    const k = kind === 'shipHit' ? 3 : kind === 'warhead' ? 1.2 : kind === 'vls' ? 0.5 : 0.6;
    const s = k * Math.min(1, 300 / Math.max(d, 50)) * Math.min(2, Math.cbrt(Math.max(size, 1) / 60));
    if (s > 0.03) this.rig.addShake(s);
  }

  /** Smart time compression: fast through quiet stretches, real time when the fight is on. */
  autoTime = true;
  /** Set by the cinematic director while it holds slow motion (overrides auto). */
  timeHold = false;
  private autoScale = 4;
  private updateAutoTime(dtReal: number) {
    if (!this.autoTime || this.timeHold || this.paused) return;
    const W = this.world;
    const sp = W.ship.pos;
    let target = 8;
    let nearest = Infinity;
    for (const th of W.threats) if (th.alive) nearest = Math.min(nearest, th.pos.distanceTo(sp));
    const active = W.interceptors.some((m) => m.alive) || W.ciws.some((c) => c.firing || c.target) || W.gun.state === 'fire' || W.gun.state === 'track';
    const airborne = W.threats.some((t) => t.alive);
    if (nearest < 20000 || active) target = 1;
    else if (airborne) target = nearest < 30000 ? 2 : 4;
    else if (W.plan.length && W.t < (W.plan[0]?.time ?? 0) - 3) target = 8;
    else if (!W.plan.length && !airborne) target = 1; // raid over: let the smoke settle in real time
    else target = 2;
    // ease: drop instantly, rise gently
    this.autoScale = target < this.autoScale ? target : this.autoScale + (target - this.autoScale) * Math.min(1, dtReal * 0.8);
    const s = this.autoScale > 1.5 ? Math.round(this.autoScale) : 1;
    if (Math.abs(s - this.timeScale) > 1e-6) {
      this.timeScale = s;
      this.events.emit('timeScale', { scale: s, paused: this.paused });
    }
  }

  setAutoTime(on: boolean) {
    this.autoTime = on;
    this.events.emit('timeScale', { scale: this.timeScale, paused: this.paused });
  }

  setTimeScale(s: number) {
    this.timeScale = s;
    this.events.emit('timeScale', { scale: s, paused: this.paused });
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.events.emit('timeScale', { scale: this.timeScale, paused: p });
  }
  stepTimeScale(dir: number) {
    this.autoTime = false;
    let i = TIME_SCALES.findIndex((x) => x >= this.timeScale - 1e-6);
    if (i < 0) i = TIME_SCALES.length - 1;
    i = THREE.MathUtils.clamp(i + dir, 0, TIME_SCALES.length - 1);
    this.setTimeScale(TIME_SCALES[i]);
  }

  select(e: Entity | null, follow = false) {
    this.selected = e;
    if (e && follow) this.follow(e);
    this.events.emit('select', { entity: e });
  }

  follow(e: Trackable, dist?: number) {
    const d = dist ?? (e === this.world.ship ? 260 : Math.max(e.radius * 9, 18));
    this.rig.follow(e, { dist: d });
  }

  /** All entities that can be selected/followed. */
  trackables(): Entity[] {
    return this.world.trackables();
  }

  start() {
    // one full update first so the environment (sky cube / env maps / lights) is in its in-game state
    this.updateViews(0, 0);
    this.prewarm();
    this.R.renderer.setAnimationLoop(() => this.frame());
  }

  private frame() {
    const now = performance.now();
    const dtReal = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.realTime += dtReal;
    this.fpsAcc += dtReal;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      this.adaptResolution();
    }
    const W = this.world;
    this.updateAutoTime(dtReal);
    // ------------------------------------------------ simulation (sub-stepped)
    let dtSim = 0;
    if (!this.paused) {
      const t0 = performance.now();
      dtSim = this.simClock.advance(dtReal * this.timeScale, (h) => {
        this.poses.capture(W);
        W.step(h);
      }, () => performance.now() - t0 > 22);
    }
    this.poses.render(W, this.simClock.alpha, () => this.frameViews(dtReal, dtSim));
  }

  /**
   * Fast-forward the sim (tests / screenshots / "skip to action"): steps the world and keeps the
   * effect views fed without rendering every step.
   */
  advance(seconds: number, h = SIM_DT) {
    this.poses.clear();
    const n = Math.round(seconds / h);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.world.step(h);
      acc += h;
      if (i % 4 === 3 || i === n - 1) {
        this.updateViews(0, acc);
        acc = 0;
      }
    }
  }

  private frameViews(dtReal: number, dtSim: number) {
    this.updateViews(dtReal, dtSim);
    const sd = this.R.sceneDepth;
    sd.update(this.scene, this.camera, this.world.t);
    const pu = this.particles.material.uniforms;
    pu.uSceneDepth.value = sd.depthRT.texture;
    pu.uRes.value.copy(sd.resolution);
    this.R.flare.track(this.camera, atmUniforms.uSunDir.value as THREE.Vector3, this.atm.sunLight.color, this.atm.sunElevationDeg);
    this.R.grade.uniforms.get('uNight')!.value = atmUniforms.uNight.value as number;
    this.R.render(dtReal);
    this.events.emit('frame', { dtReal, dtSim });
    if (++this.frames === 12) (window as any).__ready = true;
  }

  /** Update every view for the current sim state (no rendering). */
  updateViews(dtReal: number, dtSim: number) {
    const W = this.world;
    const cam = this.camera;
    this.shipView.update(W, dtSim, dtReal);
    this.glows.begin(this.R.renderer.domElement.height);
    this.streaks.begin(this.R.renderer.domElement.height);
    this.entities.update(W, cam, dtSim);
    this.fx.update(dtSim, cam, this.R.renderer.domElement.height);
    this.shipView.lights(this.glows, atmUniforms.uNight.value as number, W.radar.activeTracks().some((t) => t.cls === 'hostile') || W.t > W.firstArrival - 60, W.t);
    this.glows.end();
    this.streaks.end();
    if (this.selected && (!this.selected.alive || this.selected.remove)) {
      // keep watching the explosion for a moment, then let go of the dead entity
      if (!this.selected.alive && this.rig.target === this.selected) this.rig.lookAtPoint(this.selected.pos.clone(), this.rig.distGoal);
      this.select(null);
    }
    // ------------------------------------------------ camera
    this.rig.update(dtReal);
    if (this.fx.shake > 0) {
      const d = cam.position.distanceTo(W.ship.pos);
      this.rig.addShake(this.fx.shake * Math.min(1, 200 / Math.max(d, 30)));
      this.fx.shake = 0;
    }
    for (const p of this.plugins) p.update?.(dtReal, dtSim);
    // ------------------------------------------------ environment
    const camDist = cam.position.distanceTo(this.rig.focus);
    const shadowR = THREE.MathUtils.clamp(camDist * 0.9, 60, 450);
    this.atm.update(cam, this.shadowFocus(), shadowR, W.t);
    this.ocean.update(cam, W.t, this.atm.keyDir, this.atm.sunLight.color, this.atm.keyIntensity);
    this.bindOceanLights();
    this.wake.update(W.ship, W.t, dtSim, this.fx.foamBursts, this.particles, cam.position);
    this.terrainView?.update(cam, W.t, atmUniforms.uNight.value as number);
    this.clouds.update(cam, this.cfg.env.clouds);
    const amb = this.ambient();
    this.particles.update(W.t, W.wind, this.R.renderer.domElement.height, amb);
    this.particles.flush();
    this.entities.trails.update(W.t, W.wind, this.R.renderer.domElement.height, amb);
    // exposure: open up at night so moonlit scenes stay readable
    const night = atmUniforms.uNight.value as number;
    const target = 1 + night * 2.2;
    this.exposure += (target - this.exposure) * Math.min(1, dtReal * 2);
    this.R.renderer.toneMappingExposure = this.exposure;
  }

  private shadowFocus() {
    // Shadows centred between the focus and the ship when close, so the ship keeps crisp shadows
    const f = this.rig.focus;
    const d = f.distanceTo(this.world.ship.pos);
    return d < 400 ? _v.copy(f).lerp(this.world.ship.pos, 0.5) : f;
  }

  private ambient() {
    const z = atmUniforms.uSkyZenith.value as THREE.Vector3, h = atmUniforms.uSkyHorizon.value as THREE.Vector3;
    return new THREE.Vector3().copy(z).multiplyScalar(0.55).addScaledVector(h, 0.35).multiplyScalar(0.9).addScalar(0.004);
  }

  private bindOceanLights() {
    const u = this.ocean.material.uniforms;
    const L = u.uExplLights.value as THREE.Vector4[];
    const C = u.uExplColors.value as THREE.Vector3[];
    const g = this.ocean.mesh.position;
    for (let i = 0; i < 4; i++) {
      const o = this.fx.oceanLights[i];
      if (!o) {
        L[i].set(0, 0, 0, 0);
        continue;
      }
      L[i].set(o.pos.x - g.x, o.pos.y - g.y, o.pos.z - g.z, o.radius);
      C[i].set(o.color.r, o.color.g, o.color.b);
    }
  }

  /** Useful derived numbers for UI. */
  static bearingDeg(from: THREE.Vector3, to: THREE.Vector3) {
    const { e, n } = enuAt(from);
    _v.copy(to).sub(from);
    let b = Math.atan2(_v.dot(e), _v.dot(n)) / DEG;
    if (b < 0) b += 360;
    return b;
  }
  static alt(p: THREE.Vector3) {
    return altitude(p);
  }
  static up(p: THREE.Vector3) {
    return upAt(p, _u);
  }
}
