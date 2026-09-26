import * as THREE from 'three';
import { enuAt, altitude, upAt } from '../core/geo';

/** Anything the camera can follow. */
export interface Trackable {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Approximate bounding radius (m). */
  radius: number;
  alive: boolean;
  /** Optional orientation (for chase / first-person). */
  quat?: THREE.Quaternion;
}

export type CamMode = 'orbit' | 'chase' | 'free' | 'fixed' | 'look';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _e = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

function damp(current: number, target: number, lambda: number, dt: number) {
  return target + (current - target) * Math.exp(-lambda * dt);
}
function dampAngle(current: number, target: number, lambda: number, dt: number) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return target - d * Math.exp(-lambda * dt);
}
function dampV(current: THREE.Vector3, target: THREE.Vector3, lambda: number, dt: number) {
  const k = Math.exp(-lambda * dt);
  current.x = target.x + (current.x - target.x) * k;
  current.y = target.y + (current.y - target.y) * k;
  current.z = target.z + (current.z - target.z) * k;
  return current;
}

export interface FixedMount {
  /** Returns the world position & look target for this frame. */
  get(pos: THREE.Vector3, look: THREE.Vector3, up: THREE.Vector3): boolean;
  fov?: number;
  /** What the mount rides on: dragging the view keeps the camera riding with it (look mode). */
  anchor?: Trackable;
}

/**
 * Camera rig with smooth orbit/follow, chase, free-fly, fixed (first-person / mount) and look modes.
 * Look mode rides along with a target at a fixed offset while the view turns in place.
 * All angles are in the local East-North-Up frame of the focus point, so the horizon stays level anywhere on the planet.
 */
export class CameraRig {
  mode: CamMode = 'orbit';
  target: Trackable | null = null;
  /** Focus point (smoothed). */
  focus = new THREE.Vector3();
  private focusGoal = new THREE.Vector3();
  yaw = 0.6; // bearing of the camera *from* focus (rad)
  pitch = 0.18;
  dist = 320;
  yawGoal = 0.6;
  pitchGoal = 0.18;
  distGoal = 320;
  /** When following, keep the view angle relative to the target's heading. */
  lockHeading = false;
  private lastHeading = 0;
  fixed: FixedMount | null = null;
  fovGoal = 50;
  // Free-fly state (also the tether's drift velocity in look mode)
  private freeVel = new THREE.Vector3();
  // Look state: camera offset from the target as (right, forward, up) metres in its frame, which
  // is the compass (east/north) or, riding on board, turns with the target's heading.
  private lookOffset = new THREE.Vector3();
  private lookTurns = false;
  private lookHeading = 0;
  keys = new Set<string>();
  /** Shake amplitude (decays). */
  private shake = 0;
  private shakeT = 0;
  /** Blend factor for mode transitions (0..1). */
  private blend = 1;
  private blendFrom = new THREE.Vector3();
  private blendFromQ = new THREE.Quaternion();
  /** This frame's pose before transition blending and shake. */
  private rawPos = new THREE.Vector3();
  private rawQ = new THREE.Quaternion();
  groundHeight: (x: number, z: number) => number = () => 0;
  onUserInput: () => void = () => {};

  constructor(public camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    this.bindInput();
  }

  /** Smoothly change what we look at. */
  follow(t: Trackable | null, opts: { dist?: number; keepAngles?: boolean; mode?: CamMode } = {}) {
    this.startBlend();
    this.target = t;
    if (opts.mode) this.mode = opts.mode;
    else if (this.mode === 'fixed' || this.mode === 'free' || this.mode === 'look') this.mode = 'orbit';
    this.fixed = null;
    if (t) {
      this.focusGoal.copy(t.pos);
      if (opts.dist) this.distGoal = opts.dist;
      else this.distGoal = Math.max(t.radius * 6, 12);
    }
  }
  lookAtPoint(p: THREE.Vector3, dist?: number) {
    this.startBlend();
    this.target = null;
    this.mode = 'orbit';
    this.fixed = null;
    this.focusGoal.copy(p);
    if (dist) this.distGoal = dist;
  }
  setFixed(m: FixedMount) {
    this.startBlend();
    this.mode = 'fixed';
    this.fixed = m;
  }
  setFree() {
    this.startBlend();
    this.mode = 'free';
    this.fixed = null;
    this.target = null;
    this.freeVel.set(0, 0, 0);
  }
  /**
   * Look around from where the camera is: it keeps its place relative to `t` as `t` moves, and
   * dragging turns the view. `turns`: the offset and view swing with t's heading (on-board mounts).
   */
  setLook(t: Trackable, turns = false) {
    this.target = t;
    this.fixed = null;
    this.mode = 'look';
    this.lookTurns = turns;
    this.lookHeading = this.headingOf(t, 0);
    const h = turns ? this.lookHeading : 0;
    // Start from the view's own pose, not the on-screen one: if a transition is still blending in,
    // it carries on and settles into this spot.
    enuAt(t.pos, _e, _n, _u);
    const off = _v.copy(this.rawPos).sub(t.pos);
    const oe = off.dot(_e), on = off.dot(_n);
    this.lookOffset.set(oe * Math.cos(h) - on * Math.sin(h), oe * Math.sin(h) + on * Math.cos(h), off.dot(_u));
    enuAt(this.rawPos, _e, _n, _u);
    const f = _v2.set(0, 0, -1).applyQuaternion(this.rawQ);
    this.yaw = this.yawGoal = Math.atan2(f.dot(_e), f.dot(_n)) - h;
    this.pitch = this.pitchGoal = Math.asin(THREE.MathUtils.clamp(f.dot(_u), -1, 1));
    this.freeVel.set(0, 0, 0);
  }
  /** Leave look mode: orbit the target again from wherever the camera now is. */
  endLook() {
    const t = this.target;
    if (this.mode !== 'look' || !t) return;
    this.startBlend();
    this.mode = 'orbit';
    enuAt(t.pos, _e, _n, _u);
    const off = _v.copy(this.camera.position).sub(t.pos);
    this.dist = this.distGoal = Math.max(off.length(), 3);
    this.yaw = this.yawGoal = Math.atan2(off.dot(_e), off.dot(_n));
    this.pitch = this.pitchGoal = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(off.dot(_u) / this.dist, -1, 1)), -0.25, 1.55);
    this.focus.copy(t.pos);
    this.focusGoal.copy(t.pos);
    this.fovGoal = 50;
  }
  /** Z: look around from here (riding along with a mount's anchor or the followed target), or back to orbit. */
  toggleLook() {
    if (this.mode === 'look') this.endLook();
    else {
      const t = this.mode === 'fixed' ? this.fixed?.anchor ?? this.target : this.target;
      if (t && t.alive) this.setLook(t, this.mode === 'fixed');
    }
  }
  /** Compass heading of a target (rad): from its velocity, else its nose (+z), else `fallback`. */
  private headingOf(t: Trackable, fallback: number) {
    const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
    enuAt(t.pos, e, n, u);
    const d = t.vel.lengthSq() > 4 ? t.vel : t.quat ? new THREE.Vector3(0, 0, 1).applyQuaternion(t.quat) : null;
    if (!d || Math.abs(d.dot(e)) + Math.abs(d.dot(n)) < 1e-6) return fallback;
    return Math.atan2(d.dot(e), d.dot(n));
  }

  /** Instantly place the orbit (used by the cinematic director for hard cuts). */
  cut(opts: { focus?: THREE.Vector3; yaw?: number; pitch?: number; dist?: number }) {
    if (opts.focus) { this.focus.copy(opts.focus); this.focusGoal.copy(opts.focus); }
    if (opts.yaw !== undefined) { this.yaw = this.yawGoal = opts.yaw; }
    if (opts.pitch !== undefined) { this.pitch = this.pitchGoal = opts.pitch; }
    if (opts.dist !== undefined) { this.dist = this.distGoal = opts.dist; }
    this.blend = 1;
  }
  addShake(a: number) {
    this.shake = Math.min(3, this.shake + a);
  }
  private startBlend() {
    this.blend = 0;
    this.blendFrom.copy(this.camera.position);
    this.blendFromQ.copy(this.camera.quaternion);
  }

  private bindInput() {
    const el = this.dom;
    let dragging: 0 | 1 | 2 = 0;
    let altDrag = false;
    let lx = 0, ly = 0;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      dragging = e.button === 2 || e.shiftKey ? 2 : e.button === 0 ? 1 : 0;
      if (e.button === 1) dragging = 2;
      altDrag = e.altKey;
      lx = e.clientX; ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointerup', (e) => {
      dragging = 0;
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) this.onUserInput();
      const fovK = this.camera.fov / 50;
      // Alt+drag while following, or any drag in a mount view: look around, riding along with it
      if (altDrag && (this.mode === 'orbit' || this.mode === 'chase') && this.target?.alive) this.setLook(this.target);
      if (this.mode === 'fixed' && dragging === 1) {
        const a = this.fixed?.anchor;
        if (a?.alive) this.setLook(a, true);
        else this.mode = 'free';
      }
      if (this.mode === 'free' || this.mode === 'look') {
        this.yawGoal += dx * 0.0035 * fovK;
        this.pitchGoal = THREE.MathUtils.clamp(this.pitchGoal - dy * 0.0035 * fovK, -1.5, 1.5);
        this.yaw = this.yawGoal; this.pitch = this.pitchGoal;
        return;
      }
      if (dragging === 1) {
        if (this.mode === 'chase') this.chaseYawOffset += dx * 0.005 * fovK;
        else this.yawGoal += dx * 0.005 * fovK;
        this.pitchGoal = THREE.MathUtils.clamp(this.pitchGoal + dy * 0.005 * fovK, -0.25, 1.55);
      } else {
        // pan: detach from target and move focus in the view plane
        if (this.target) {
          this.focusGoal.copy(this.target.pos);
          this.target = null;
        }
        const s = this.dist * 0.0016 * fovK;
        enuAt(this.focusGoal, _e, _n, _u);
        const right = _v.copy(_e).multiplyScalar(-Math.cos(this.yaw)).addScaledVector(_n, Math.sin(this.yaw));
        const fwd = _v2.copy(_n).multiplyScalar(-Math.cos(this.yaw)).addScaledVector(_e, -Math.sin(this.yaw));
        this.focusGoal.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s);
      }
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onUserInput();
        const k = Math.exp(e.deltaY * 0.0012);
        if (this.mode === 'free' || this.mode === 'look') {
          this.fovGoal = THREE.MathUtils.clamp(this.fovGoal * k, 8, 90);
        } else {
          // Zoom toward the point under the cursor when not locked to a target (Supreme Commander style)
          if (!this.target && this.mode === 'orbit' && k < 1) {
            const hit = this.seaPointUnder(e.clientX, e.clientY);
            if (hit && hit.distanceTo(this.camera.position) < this.dist * 6) this.focusGoal.lerp(hit, 1 - k);
          }
          this.distGoal = THREE.MathUtils.clamp(this.distGoal * k, 3, 4.0e6);
          if (this.mode === 'fixed') this.fovGoal = THREE.MathUtils.clamp(this.fovGoal * k, 5, 90);
        }
      },
      { passive: false }
    );
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  /** Ray from the camera through a screen point, intersected with the sea-level sphere. */
  seaPointUnder(x: number, y: number): THREE.Vector3 | null {
    const cam = this.camera;
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector3(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5);
    const dir = ndc.unproject(cam).sub(cam.position).normalize();
    const R = 1_000_000;
    const c = new THREE.Vector3(cam.position.x, cam.position.y + R, cam.position.z);
    const b = c.dot(dir);
    const disc = b * b - (c.lengthSq() - R * R);
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return null;
    return cam.position.clone().addScaledVector(dir, t);
  }

  update(dtReal: number) {
    const dt = Math.min(dtReal, 0.1);
    const cam = this.camera;
    const k = this.keys;
    // keyboard orbit / zoom
    if (this.mode !== 'free' && this.mode !== 'look') {
      if (k.has('KeyQ')) this.yawGoal -= dt * 1.2;
      if (k.has('KeyE')) this.yawGoal += dt * 1.2;
      if (k.has('KeyR')) this.distGoal = Math.max(3, this.distGoal * Math.exp(-dt * 1.5));
      if (k.has('KeyF')) this.distGoal = Math.min(4e6, this.distGoal * Math.exp(dt * 1.5));
      const pan = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      if ((pan || strafe) && this.mode === 'orbit') {
        if (this.target) { this.focusGoal.copy(this.target.pos); this.target = null; }
        enuAt(this.focusGoal, _e, _n, _u);
        const fwd = _v.copy(_n).multiplyScalar(-Math.cos(this.yaw)).addScaledVector(_e, -Math.sin(this.yaw));
        const right = _v2.copy(_e).multiplyScalar(-Math.cos(this.yaw)).addScaledVector(_n, Math.sin(this.yaw));
        const sp = this.dist * 0.9 * (k.has('ShiftLeft') ? 3 : 1);
        this.focusGoal.addScaledVector(fwd, pan * sp * dt).addScaledVector(right, strafe * sp * dt);
      }
    }

    if (this.target && !this.target.alive && this.mode === 'chase') this.mode = 'orbit';

    if (this.target && !this.target.alive && this.mode === 'look') {
      // what we were riding with is gone: stay put and keep looking
      if (this.lookTurns) this.yaw = this.yawGoal = this.yaw + this.lookHeading;
      this.mode = 'free';
      this.freeVel.set(0, 0, 0);
    }

    if (this.mode === 'free') this.updateFree(dt);
    else if (this.mode === 'look') this.updateLook(dt);
    else if (this.mode === 'fixed' && this.fixed) this.updateFixed(dt);
    else this.updateOrbit(dt);
    this.rawPos.copy(cam.position);
    this.rawQ.copy(cam.quaternion);

    // fov
    cam.fov = damp(cam.fov, this.fovGoal, 6, dt);
    // Transition blending
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 0.9);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      if (t < 1) {
        cam.position.lerpVectors(this.blendFrom, cam.position, t);
        cam.quaternion.slerpQuaternions(this.blendFromQ, cam.quaternion, t);
      }
    }
    // Camera shake
    if (this.shake > 0.001) {
      this.shakeT += dt;
      const s = this.shake * 0.01;
      const e = new THREE.Euler(
        Math.sin(this.shakeT * 37.1) * s + Math.sin(this.shakeT * 13.7) * s,
        Math.sin(this.shakeT * 29.3) * s,
        Math.sin(this.shakeT * 41.9) * s * 0.5
      );
      cam.quaternion.multiply(_q.setFromEuler(e));
      this.shake *= Math.exp(-dt * 3.5);
    }
    // Keep the camera above the water
    const alt = altitude(cam.position);
    if (alt < 60) {
      const wh = this.groundHeight(cam.position.x, cam.position.z);
      const minAlt = wh + 0.8;
      if (alt < minAlt) {
        upAt(cam.position, _u);
        cam.position.addScaledVector(_u, minAlt - alt);
      }
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private updateOrbit(dt: number) {
    const cam = this.camera;
    if (this.target) {
      this.focusGoal.copy(this.target.pos);
      if (this.lockHeading && this.target.vel.lengthSq() > 1) {
        enuAt(this.target.pos, _e, _n, _u);
        const hd = Math.atan2(this.target.vel.dot(_e), this.target.vel.dot(_n));
        let d = hd - this.lastHeading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.yawGoal += d;
        this.yaw += d;
        this.lastHeading = hd;
      }
    }
    // Focus smoothing: strongly track fast targets so they don't slip out of frame.
    const fast = this.target ? Math.min(1, this.target.vel.length() / 200) : 0;
    const lam = this.target ? 12 + fast * 40 : 8;
    if (this.target && this.focus.distanceToSquared(this.focusGoal) > 1e8) this.focus.copy(this.focusGoal);
    dampV(this.focus, this.focusGoal, lam, dt);
    if (this.target && fast > 0.3) this.focus.copy(this.focusGoal);
    this.yaw = dampAngle(this.yaw, this.yawGoal, 10, dt);
    this.pitch = damp(this.pitch, this.pitchGoal, 10, dt);
    this.dist = Math.exp(damp(Math.log(this.dist), Math.log(this.distGoal), 8, dt));

    if (this.mode === 'chase' && this.target && this.target.vel.lengthSq() > 4) {
      // Chase: behind the velocity vector, slightly above
      const v = _v.copy(this.target.vel).normalize();
      enuAt(this.target.pos, _e, _n, _u);
      const hd = Math.atan2(v.dot(_e), v.dot(_n));
      const behind = hd + Math.PI + this.yawGoal * 0; // yaw offset from drag handled below
      const yaw = behind + this.chaseYawOffset;
      const p = this.pitch;
      const dir = _v2.copy(_n).multiplyScalar(Math.cos(yaw) * Math.cos(p)).addScaledVector(_e, Math.sin(yaw) * Math.cos(p)).addScaledVector(_u, Math.sin(p));
      const goal = new THREE.Vector3().copy(this.focus).addScaledVector(dir, this.dist);
      if (!this.chasePos || this.chasePos.distanceTo(goal) > this.dist * 4) this.chasePos = goal.clone();
      dampV(this.chasePos, goal, 6, dt);
      cam.position.copy(this.chasePos);
      upAt(this.focus, _u);
      cam.up.copy(_u);
      cam.lookAt(this.focus);
      return;
    }

    enuAt(this.focus, _e, _n, _u);
    const cp = Math.cos(this.pitch);
    const dir = _v.copy(_n).multiplyScalar(Math.cos(this.yaw) * cp).addScaledVector(_e, Math.sin(this.yaw) * cp).addScaledVector(_u, Math.sin(this.pitch));
    cam.position.copy(this.focus).addScaledVector(dir, this.dist);
    upAt(cam.position, _u);
    cam.up.copy(_u);
    cam.lookAt(this.focus);
  }
  chaseYawOffset = 0;
  private chasePos: THREE.Vector3 | null = null;

  private updateFree(dt: number) {
    const cam = this.camera;
    const k = this.keys;
    upAt(cam.position, _u);
    enuAt(cam.position, _e, _n, _u);
    const cp = Math.cos(this.pitch);
    const fwd = _v.copy(_n).multiplyScalar(Math.cos(this.yaw) * cp).addScaledVector(_e, Math.sin(this.yaw) * cp).addScaledVector(_u, Math.sin(this.pitch));
    const right = _v2.crossVectors(fwd, _u).normalize();
    const alt = Math.max(altitude(cam.position), 1);
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1) * Math.max(20, alt * 1.2);
    const acc = new THREE.Vector3();
    if (k.has('KeyW')) acc.add(fwd);
    if (k.has('KeyS')) acc.sub(fwd);
    if (k.has('KeyD')) acc.add(right);
    if (k.has('KeyA')) acc.sub(right);
    if (k.has('Space') || k.has('KeyE')) acc.add(_u);
    if (k.has('KeyC') || k.has('KeyQ')) acc.sub(_u);
    if (acc.lengthSq() > 0) acc.normalize().multiplyScalar(speed);
    dampV(this.freeVel, acc, 4, dt);
    cam.position.addScaledVector(this.freeVel, dt);
    cam.up.copy(_u);
    cam.lookAt(_v.copy(cam.position).add(fwd));
  }

  private updateLook(dt: number) {
    const cam = this.camera;
    const k = this.keys;
    const t = this.target!;
    if (this.lookTurns) this.lookHeading = this.headingOf(t, this.lookHeading);
    const h = this.lookTurns ? this.lookHeading : 0;
    enuAt(t.pos, _e, _n, _u);
    const fwdAxis = _v.copy(_n).multiplyScalar(Math.cos(h)).addScaledVector(_e, Math.sin(h));
    const rightAxis = _v2.copy(_e).multiplyScalar(Math.cos(h)).addScaledVector(_n, -Math.sin(h));
    // W A S D / E Q drift the camera relative to the target, along the view (like free-fly)
    const cp = Math.cos(this.pitch);
    const yaw = this.yaw + h;
    const view = new THREE.Vector3().copy(_n).multiplyScalar(Math.cos(yaw) * cp).addScaledVector(_e, Math.sin(yaw) * cp).addScaledVector(_u, Math.sin(this.pitch));
    const side = new THREE.Vector3().crossVectors(view, _u).normalize();
    const acc = new THREE.Vector3();
    if (k.has('KeyW')) acc.add(view);
    if (k.has('KeyS')) acc.sub(view);
    if (k.has('KeyD')) acc.add(side);
    if (k.has('KeyA')) acc.sub(side);
    if (k.has('KeyE')) acc.add(_u);
    if (k.has('KeyQ')) acc.sub(_u);
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 5 : 1) * Math.max(10, this.lookOffset.length() * 0.6);
    if (acc.lengthSq() > 0) acc.normalize().multiplyScalar(speed);
    dampV(this.freeVel, acc, 4, dt);
    this.lookOffset.x += this.freeVel.dot(rightAxis) * dt;
    this.lookOffset.y += this.freeVel.dot(fwdAxis) * dt;
    this.lookOffset.z += this.freeVel.dot(_u) * dt;
    cam.position.copy(t.pos).addScaledVector(rightAxis, this.lookOffset.x).addScaledVector(fwdAxis, this.lookOffset.y).addScaledVector(_u, this.lookOffset.z);
    enuAt(cam.position, _e, _n, _u);
    const dir = _v.copy(_n).multiplyScalar(Math.cos(yaw) * cp).addScaledVector(_e, Math.sin(yaw) * cp).addScaledVector(_u, Math.sin(this.pitch));
    cam.up.copy(_u);
    cam.lookAt(_v2.copy(cam.position).add(dir));
  }

  private updateFixed(dt: number) {
    const cam = this.camera;
    const pos = _v, look = _v2, up = _u;
    if (!this.fixed!.get(pos, look, up)) {
      this.mode = 'orbit';
      return;
    }
    cam.position.copy(pos);
    cam.up.copy(up);
    cam.lookAt(look);
    // Use the current look direction as the free-look start
    enuAt(cam.position, _e, _n, _u);
    const f = look.sub(pos).normalize();
    this.yaw = this.yawGoal = Math.atan2(f.dot(_e), f.dot(_n));
    this.pitch = this.pitchGoal = Math.asin(THREE.MathUtils.clamp(f.dot(_u), -1, 1));
  }
}
