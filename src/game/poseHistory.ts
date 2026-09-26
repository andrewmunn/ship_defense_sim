import * as THREE from 'three';
import type { Entity } from '../sim/entities';
import type { World } from '../sim/world';

interface Pose {
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/** Present the last physics interval smoothly, restoring authoritative poses before the next step. */
export class PoseHistory {
  private poses = new Map<Entity, Pose>();
  private scale = new THREE.Vector3(1, 1, 1);

  clear() {
    this.poses.clear();
  }

  capture(w: World) {
    const entities = new Set<Entity>([w.ship, ...w.threats, ...w.interceptors, ...w.decoys, ...w.debris]);
    for (const e of this.poses.keys()) if (!entities.has(e)) this.poses.delete(e);
    for (const e of entities) {
      let p = this.poses.get(e);
      if (!p) {
        p = { prevPos: new THREE.Vector3(), prevQuat: new THREE.Quaternion(), pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        this.poses.set(e, p);
      }
      p.prevPos.copy(e.pos);
      p.prevQuat.copy(e.quat);
    }
  }

  render(w: World, alpha: number, draw: () => void) {
    if (alpha >= 1 || !this.poses.has(w.ship)) return draw();
    alpha = THREE.MathUtils.clamp(alpha, 0, 1);
    const frame = () => {
      w.ship.localToWorld.compose(w.ship.pos, w.ship.quat, this.scale);
      w.ship.worldToLocal.copy(w.ship.localToWorld).invert();
    };
    for (const [e, p] of this.poses) {
      p.pos.copy(e.pos);
      p.quat.copy(e.quat);
      e.pos.lerpVectors(p.prevPos, p.pos, alpha);
      e.quat.slerpQuaternions(p.prevQuat, p.quat, alpha);
    }
    frame();
    try { draw(); }
    finally {
      for (const [e, p] of this.poses) {
        e.pos.copy(p.pos);
        e.quat.copy(p.quat);
      }
      frame();
    }
  }
}
