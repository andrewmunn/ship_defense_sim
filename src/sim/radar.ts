import * as THREE from 'three';
import { altitude, horizonDist, surfaceDistance, bearingTo, upAt } from '../core/geo';
import { K_REFRACTION } from '../core/constants';
import { Rng } from '../core/rng';
import type { Threat } from './threat';
import type { Interceptor } from './interceptor';

export type TrackClass = 'pending' | 'unknown' | 'hostile';

/** A radar track: the combat system only ever sees these estimates, never the truth. */
export class Track {
  tn: number;
  /** Estimated position now: the filtered position at the last detection, propagated forward. */
  estPos = new THREE.Vector3();
  estVel = new THREE.Vector3();
  /** Filtered position at the last detection (the alpha-beta filter's state). */
  private fPos = new THREE.Vector3();
  firm = false;
  cls: TrackClass = 'pending';
  detections = 0;
  firstDetect: number;
  lastDetect: number;
  firmTime = -1;
  hostileTime = -1;
  lost = false;
  dead = false;
  deadTime = -1;
  /** Interceptors in flight against this track. */
  engagedBy: Interceptor[] = [];
  /** Total shots fired at this track. */
  shots = 0;
  /** Time of the most recent miss/kill-assessment (for shoot-look-shoot). */
  lastLook = -1;
  quality = 0;
  ciwsEngaged = false;
  gunEngaged = false;
  decoyed = false;
  /** Predicted time to reach own ship (s). */
  ttg = Infinity;
  range = Infinity;
  bearing = 0;
  constructor(public threat: Threat, t: number, tn = 7001) {
    this.tn = tn;
    this.firstDetect = this.lastDetect = t;
    this.estPos.copy(threat.pos);
    this.fPos.copy(threat.pos);
    this.estVel.copy(threat.vel);
  }

  /** First detection: position only, velocity unknown. */
  initFilter(meas: THREE.Vector3, t: number) {
    this.fPos.copy(meas);
    this.estPos.copy(meas);
    this.estVel.set(0, 0, 0);
    this.lastDetect = t;
  }

  /** Alpha-beta update with a new measurement at time t. */
  updateFilter(meas: THREE.Vector3, t: number) {
    const dtm = Math.max(t - this.lastDetect, 0.05);
    // predict from the filter state at the last detection (not from estPos, which has already been
    // propagated to now: predicting from it again counted the motion twice and halved the velocity)
    const pred = _pred.copy(this.fPos).addScaledVector(this.estVel, dtm);
    const resid = meas.sub(pred);
    const a = this.detections < 4 ? 0.8 : 0.45, b = this.detections < 4 ? 0.6 : 0.2;
    this.fPos.copy(pred).addScaledVector(resid, a);
    this.estVel.addScaledVector(resid, b / dtm);
    this.estPos.copy(this.fPos);
    this.lastDetect = t;
  }

  /** Propagate the estimate to time t between detections. */
  propagate(t: number) {
    this.estPos.copy(this.fPos).addScaledVector(this.estVel, t - this.lastDetect);
  }
}

const _pred = new THREE.Vector3();

const _up = new THREE.Vector3();

/**
 * Sentinel phased-array radar model: 360° coverage, detection limited by the (refracted) radar horizon,
 * SNR vs RCS/range^4, multipath fading close to the horizon, and sea-clutter for skimmers.
 */
export class Radar {
  private nextTn = 7001;
  constructor(private rng = new Rng()) {}

  tracks: Track[] = [];
  byThreat = new Map<number, Track>();
  /** Radar phase-center height above the waterline (m). */
  height = 21;
  /** Range (m) at which a 1 m² target yields 13 dB SNR. */
  r1 = 260000;
  private nextLook = new Map<number, number>();
  enabled = true;
  degraded = 0; // 0..1 damage

  radarPos(shipPos: THREE.Vector3, out = new THREE.Vector3()) {
    upAt(shipPos, _up);
    return out.copy(shipPos).addScaledVector(_up, this.height);
  }

  /** Margin (m) by which a target is above the radar horizon (negative = masked). */
  horizonMargin(radar: THREE.Vector3, p: THREE.Vector3, k = K_REFRACTION) {
    const hr = Math.max(altitude(radar), 1), ht = Math.max(altitude(p), 0.5);
    const d = surfaceDistance(radar, p);
    return horizonDist(hr, k) + horizonDist(ht, k) - d;
  }

  detectProb(radar: THREE.Vector3, th: Threat) {
    const margin = this.horizonMargin(radar, th.pos);
    if (margin < 0) return 0;
    const R = Math.max(radar.distanceTo(th.pos), 100);
    const snrDb = 13 + 40 * Math.log10(this.r1 / R) + 10 * Math.log10(th.spec.rcs) - this.degraded * 12;
    // multipath fade in the first ~800 m of range margin past the horizon
    const mp = THREE.MathUtils.smoothstep(margin, 0, 800);
    // sea clutter for low fliers
    const clutter = altitude(th.pos) < 60 ? 4 : 0;
    const pd = 1 / (1 + Math.exp(-(snrDb - clutter - 13) / 2.2));
    return pd * (0.25 + 0.75 * mp);
  }

  update(dt: number, t: number, shipPos: THREE.Vector3, shipVel: THREE.Vector3, threats: Threat[], onNew: (tr: Track) => void, reaction: number) {
    const radar = this.radarPos(shipPos);
    for (const th of threats) {
      if (!th.alive) continue;
      const due = this.nextLook.get(th.id) ?? 0;
      if (t < due) continue;
      let tr = this.byThreat.get(th.id);
      // Revisit: tracked targets at 5 Hz; search at 1.5 Hz
      this.nextLook.set(th.id, t + (tr && !tr.lost ? 0.2 : 0.65) * (0.9 + this.rng.next() * 0.2));
      if (!this.enabled) continue;
      const pd = this.detectProb(radar, th);
      if (!this.rng.chance(pd)) continue;
      const R = radar.distanceTo(th.pos);
      const sigma = 3 + R * 0.0004;
      const meas = th.pos.clone().add(new THREE.Vector3(this.rng.gauss(), this.rng.gauss(), this.rng.gauss()).multiplyScalar(sigma));
      if (!tr || tr.lost) {
        if (tr) this.tracks = this.tracks.filter((x) => x !== tr);
        tr = new Track(th, t, this.nextTn++);
        tr.initFilter(meas, t);
        this.tracks.push(tr);
        this.byThreat.set(th.id, tr);
        th.trackNumber = tr.tn;
      } else {
        tr.updateFilter(meas, t);
      }
      tr.detections++;
      tr.quality = Math.min(1, tr.quality + 0.25);
      if (!tr.firm && tr.detections >= 3) {
        tr.firm = true;
        tr.firmTime = t;
        tr.cls = 'unknown';
        onNew(tr);
      }
    }
    for (const tr of this.tracks) {
      if (tr.dead) continue;
      // propagate estimate between detections
      if (!tr.lost) {
        const dtm = t - tr.lastDetect;
        if (dtm > 0) tr.propagate(t);
        tr.quality = Math.max(0, tr.quality - dt * 0.15);
        if (dtm > 3.5) tr.lost = true;
      }
      if (tr.firm && tr.cls === 'unknown' && t - tr.firmTime > reaction * 0.5) {
        // identification: fast + closing → hostile (VAMPIRE)
        const to = shipPos.clone().sub(tr.estPos);
        const closing = tr.estVel.dot(to.normalize());
        if (tr.estVel.length() > 120 && closing > 50) {
          tr.cls = 'hostile';
          tr.hostileTime = t;
        }
      }
      tr.range = tr.estPos.distanceTo(shipPos);
      tr.bearing = bearingTo(shipPos, tr.estPos);
      const rel = tr.estPos.clone().sub(shipPos);
      const vrel = tr.estVel.clone().sub(shipVel);
      const closing = -rel.dot(vrel) / Math.max(rel.length(), 1);
      tr.ttg = closing > 10 ? tr.range / closing : Infinity;
    }
  }

  markDead(th: Threat, t: number) {
    const tr = this.byThreat.get(th.id);
    if (tr && !tr.dead) {
      tr.dead = true;
      tr.deadTime = t;
    }
  }

  cleanup(t: number) {
    this.tracks = this.tracks.filter((tr) => !(tr.dead && t - tr.deadTime > 8) && !(tr.lost && t - tr.lastDetect > 20));
  }

  activeTracks() {
    return this.tracks.filter((t) => t.firm && !t.dead && !t.lost);
  }
}
