import * as THREE from 'three';
import type { FixedMount } from './cameraRig';
import type { Game } from '../game/game';
import type { Entity } from '../sim/entities';
import type { Threat } from '../sim/threat';
import { upAt, altitude } from '../core/geo';

const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Camera on the bridge looking over the bow (slight look-around toward the nearest threat). */
export function bridgeMount(g: Game): FixedMount {
  const look = new THREE.Vector3();
  return {
    fov: 55,
    get(pos, lk, up) {
      const sv = g.shipView;
      const cam = sv.bridgeCam;
      if (!cam) return false;
      cam.getWorldPosition(pos);
      const fwd = _v.set(0, 0, 1).applyQuaternion(g.world.ship.quat);
      const goal = pos.clone().addScaledVector(fwd, 400);
      upAt(pos, up);
      goal.addScaledVector(up, -12);
      const th = nearestThreat(g, 12000);
      if (th) goal.lerp(th.pos, 0.35);
      if (look.lengthSq() === 0) look.copy(goal);
      look.lerp(goal, 0.03);
      lk.copy(look);
      up.copy(_u.set(0, 1, 0).applyQuaternion(g.world.ship.quat)); // rolls with the ship
      return true;
    },
  };
}

/** Over-the-shoulder behind a CIWS mount, looking down its line of fire. */
export function ciwsMount(g: Game, idx = 0): FixedMount {
  return {
    fov: 50,
    get(pos, lk, up) {
      const c = g.world.ciws[idx];
      const pivot = c.worldPos;
      const dir = c.worldDir;
      upAt(pivot, up);
      pos.copy(pivot).addScaledVector(dir, -7).addScaledVector(up, 2.2);
      const side = _v.crossVectors(dir, up).normalize();
      pos.addScaledVector(side, 1.8);
      lk.copy(pivot).addScaledVector(dir, 120);
      up.copy(_u.set(0, 1, 0).applyQuaternion(g.world.ship.quat));
      return true;
    },
  };
}

/** Port or starboard bridge wing, tracking the most urgent threat (or the horizon on the threat axis). */
export function wingMount(g: Game): FixedMount {
  const look = new THREE.Vector3();
  return {
    fov: 42,
    get(pos, lk, up) {
      const ship = g.world.ship;
      const th = nearestThreat(g, 40000);
      const sideSign = th ? g.world.relativeSide(th.pos) : 1;
      pos.set(sideSign * 8.6, 18.2, 20.5).applyMatrix4(ship.localToWorld);
      upAt(pos, up);
      let goal: THREE.Vector3;
      if (th) goal = th.pos.clone();
      else goal = pos.clone().addScaledVector(_v.set(sideSign, 0, 0.3).applyQuaternion(ship.quat).normalize(), 3000);
      if (look.lengthSq() === 0) look.copy(goal);
      look.lerp(goal, 0.12);
      lk.copy(look);
      return true;
    },
  };
}

/** Seeker-head view: from just behind a missile's nose looking along its velocity. */
export function noseMount(g: Game, e: Entity): FixedMount {
  return {
    fov: 60,
    get(pos, lk, up) {
      if (!e.alive) return false;
      const len = (e as any).spec?.length ?? 5;
      const fwd = _v.set(0, 0, 1).applyQuaternion(e.quat);
      const upL = _u.set(0, 1, 0).applyQuaternion(e.quat);
      pos.copy(e.pos).addScaledVector(fwd, len * 0.1).addScaledVector(upL, (e as any).spec?.diameter ?? 0.4);
      lk.copy(pos).addScaledVector(fwd, 100);
      upAt(pos, up);
      return true;
    },
  };
}

/**
 * Spectator camera fixed in space (just above the sea or at a chosen point), tracking an entity:
 * the classic "missile screams past the lens" fly-by shot.
 */
export function flybyMount(g: Game, e: Entity, place: THREE.Vector3, fov = 35): FixedMount {
  const look = new THREE.Vector3().copy(e.pos);
  let lastAlive = g.world.t;
  const fixed = place.clone();
  return {
    fov,
    get(pos, lk, up) {
      if (e.alive) lastAlive = g.world.t;
      if (!e.alive && g.world.t - lastAlive > 4) return false;
      pos.copy(fixed);
      const a = altitude(pos);
      upAt(pos, up);
      const wh = g.world.waves.heightAt(pos.x, pos.z, g.world.t);
      if (a < wh + 1.5) pos.addScaledVector(up, wh + 1.5 - a);
      look.lerp(e.pos, e.alive ? 0.5 : 0.05);
      lk.copy(look);
      return true;
    },
  };
}

/** Fixed point tracking a world position (for explosions / leftover smoke). */
export function watchMount(place: THREE.Vector3, target: THREE.Vector3, fov = 40): FixedMount {
  return {
    fov,
    get(pos, lk, up) {
      pos.copy(place);
      lk.copy(target);
      upAt(pos, up);
      return true;
    },
  };
}

export function nearestThreat(g: Game, maxRange: number): Threat | null {
  let best: Threat | null = null, bd = maxRange;
  const sp = g.world.ship.pos;
  for (const th of g.world.threats) {
    if (!th.alive) continue;
    const d = th.pos.distanceTo(sp);
    if (d < bd) {
      bd = d;
      best = th;
    }
  }
  return best;
}

void _q;
