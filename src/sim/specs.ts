/**
 * Weapon & threat performance data. Numbers are plausible, public-order-of-magnitude values,
 * authored at full scale and compressed by the world scale helpers (see core/constants.ts):
 * L() lengths, V() speeds, T() durations, DRAG() drag constants. Accelerations, g limits and
 * object-sized quantities (lengths of airframes, skim heights, lethal radii) are not scaled.
 */
import { L, V, T, DRAG } from '../core/constants';

export type ThreatType = 'asm_subsonic' | 'asm_supersonic' | 'asm_heavy';
export type InterceptorType = 'halberd' | 'glaive' | 'stiletto';

export interface ThreatSpec {
  type: ThreatType;
  name: string;
  short: string;
  model: string;
  length: number;
  diameter: number;
  /** Cruise speed (m/s). */
  speed: number;
  /** Terminal speed (m/s). */
  terminalSpeed: number;
  /** Mid-course altitude (m) for the hi-lo profile. */
  cruiseAlt: number;
  /** Terminal / sea-skim altitude (m). */
  skimAlt: number;
  /** Distance to target at which the missile descends to skim altitude (m). */
  descentRange: number;
  seekerRange: number;
  maxG: number;
  rcs: number; // m^2
  /** Structural hit points vs 20mm hits (average hits to kill). */
  hp: number;
  warheadKg: number;
  boostTime: number;
  boostAccel: number;
  /** Detachable booster (jettisoned after boost). */
  booster: boolean;
  terminal: 'none' | 'popup' | 'weave' | 'dive';
  /** Probability the seeker is seduced by a decoy/chaff when one is in its FOV. */
  decoySusceptibility: number;
  /** Fraction of blast lethality an interceptor warhead achieves against this target (hardness). */
  interceptPkMod: number;
  /** Plume / trail style. */
  motor: 'turbojet' | 'ramjet' | 'rocket';
  color: string;
}

export const THREATS: Record<ThreatType, ThreatSpec> = {
  asm_subsonic: {
    type: 'asm_subsonic',
    name: 'Subsonic sea-skimming ASCM',
    short: 'SUBSONIC ASCM',
    model: 'asm_subsonic',
    length: 6.0,
    diameter: 0.36,
    speed: V(275),
    terminalSpeed: V(290),
    cruiseAlt: 30,
    skimAlt: 5,
    descentRange: L(16000),
    seekerRange: L(18000),
    maxG: 9,
    rcs: 0.1,
    hp: 2.2,
    warheadKg: 165,
    boostTime: T(2.8),
    boostAccel: 95,
    booster: true,
    terminal: 'popup',
    decoySusceptibility: 0.16,
    interceptPkMod: 1.0,
    motor: 'turbojet',
    color: '#ff5a4a',
  },
  asm_supersonic: {
    type: 'asm_supersonic',
    name: 'Supersonic ramjet ASCM',
    short: 'SUPERSONIC ASCM',
    model: 'asm_supersonic',
    length: 8.5,
    diameter: 0.67,
    speed: V(720),
    terminalSpeed: V(800),
    cruiseAlt: L(9000),
    skimAlt: 9,
    descentRange: L(26000),
    seekerRange: L(22000),
    maxG: 15,
    rcs: 0.5,
    hp: 3.5,
    warheadKg: 250,
    boostTime: T(4.0),
    boostAccel: 170,
    booster: false,
    terminal: 'weave',
    decoySusceptibility: 0.08,
    interceptPkMod: 0.8,
    motor: 'ramjet',
    color: '#ff8a2a',
  },
  asm_heavy: {
    type: 'asm_heavy',
    name: 'Heavy high-diving ASM',
    short: 'HEAVY DIVER',
    model: 'asm_heavy',
    length: 11.6,
    diameter: 0.92,
    speed: V(950),
    terminalSpeed: V(1150),
    cruiseAlt: L(16000),
    skimAlt: 0,
    descentRange: L(22000),
    seekerRange: L(30000),
    maxG: 10,
    rcs: 2.0,
    hp: 4.5,
    warheadKg: 900,
    boostTime: T(6),
    boostAccel: 150,
    booster: false,
    terminal: 'dive',
    decoySusceptibility: 0.04,
    interceptPkMod: 0.7,
    motor: 'rocket',
    color: '#ff3aa0',
  },
};

export interface InterceptorSpec {
  type: InterceptorType;
  name: string;
  short: string;
  model: string;
  length: number;
  diameter: number;
  /** thrust phases: [duration s, accel m/s^2] */
  motor: [number, number][];
  /** Separate booster stage burn time (0 = none). */
  boosterSep: number;
  /** Drag coefficient * area / mass  (1/m) at sea level density. */
  dragK: number;
  maxG: number;
  /**
   * Thrust-vector authority (g) for the pitch-over out of the cell, before the fins have the airspeed
   * to turn the missile: how quickly it can swing onto a low, close target.
   */
  turnoverG: number;
  minRange: number;
  maxRange: number;
  /** Typical average fly-out speed (m/s): only the first guess for fire control, which times shots from the fly-out model (flyout.ts). */
  avgSpeed: number;
  lethalRadius: number;
  /** Semi-active: needs illuminator during terminal phase. */
  semiActive: boolean;
  terminalTime: number;
  /** Missiles per VLS cell. */
  perCell: number;
  verticalTime: number;
  basePk: number;
  color: string;
}

export const INTERCEPTORS: Record<InterceptorType, InterceptorSpec> = {
  halberd: {
    type: 'halberd',
    name: 'Halberd medium-range SAM',
    short: 'HALBERD',
    model: 'halberd',
    length: 4.72,
    diameter: 0.343,
    motor: [[T(5.5), 170], [T(16), 34]],
    boosterSep: T(0),
    dragK: DRAG(0.000024),
    maxG: 30,
    turnoverG: 25,
    minRange: L(2500),
    maxRange: L(60000),
    avgSpeed: V(1050),
    lethalRadius: 9,
    semiActive: true,
    terminalTime: T(5.0),
    perCell: 1,
    verticalTime: T(0.8),
    basePk: 0.8,
    color: '#5ac8ff',
  },
  glaive: {
    type: 'glaive',
    name: 'Glaive extended-range SAM',
    short: 'GLAIVE',
    model: 'glaive',
    length: 6.6,
    diameter: 0.53,
    motor: [[T(8), 100], [T(6), 95], [T(18), 24]],
    boosterSep: T(8),
    dragK: DRAG(0.000022),
    maxG: 22,
    turnoverG: 12,
    minRange: L(8000),
    maxRange: L(110000),
    avgSpeed: V(1250),
    lethalRadius: 10,
    semiActive: false,
    terminalTime: T(6),
    perCell: 1,
    verticalTime: T(1.4),
    basePk: 0.85,
    color: '#7ae0ff',
  },
  stiletto: {
    type: 'stiletto',
    name: 'Stiletto point-defense SAM',
    short: 'STILETTO',
    model: 'stiletto',
    length: 3.66,
    diameter: 0.254,
    motor: [[T(4.0), 285]],
    boosterSep: T(0),
    dragK: DRAG(0.000033),
    maxG: 45,
    turnoverG: 30,
    minRange: L(1200),
    maxRange: L(24000),
    avgSpeed: V(940),
    lethalRadius: 7,
    semiActive: true,
    terminalTime: T(3.5),
    perCell: 4,
    verticalTime: T(0.5),
    basePk: 0.8,
    color: '#8affd0',
  },
};

export const CIWS_SPEC = {
  rpm: 4500,
  muzzleVel: V(1100),
  /** Round dispersion (1-sigma, radians). */
  dispersion: 0.0011,
  magazine: 1550,
  reloadTime: 240,
  maxRange: L(3600),
  openFireRange: L(2100),
  slewRate: 2.4, // rad/s
  elevRate: 2.0,
  lockTime: 0.5,
  /** Effective hit radius of a round vs missile body (m), includes fragment / debris effects. */
  hitRadius: 0.5,
  /** Probability that a single hit detonates the warhead. */
  pkPerHit: 0.22,
  /** Quadratic drag constant (1/m) for the 20 mm APDS sub-caliber penetrator. */
  dragK: DRAG(0.00045),
  burst: 1.2,
};

export const GUN_SPEC = {
  roundsPerMin: 20,
  muzzleVel: V(808),
  magazine: 600,
  maxRange: L(13000),
  minRange: L(1500),
  fuzeRadius: 14,
  pkInFuze: 0.3,
  slewRate: 0.55,
  elevRate: 0.35,
  dragK: DRAG(0.00005),
};

export const DECOY_SPEC = {
  wisp: 8,
  chaff: 24,
};
