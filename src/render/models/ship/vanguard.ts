import * as THREE from 'three';
import { PartBuilder, M, V3, offsetPoly } from './geom';
import { shipMaterials } from './materials';
import { buildHull, buildRunningGear } from './hull';
import { buildSuperstructure } from './superstructure';
import { createGun, createCIWS, createIlluminator, createVLS, addDecoyLauncher, addTorpedoTubes, addChainGun } from './weapons';
import { buildMast } from './mast';
import { Railings, buildDeckFittings, buildFlightDeckNets, buildLifeRafts, buildBoats, buildAntennas, buildHullDecals } from './details';
import { createHelo } from './helo';
import { Block } from './block';
import { LOA, Z_STERN, Z_STEM_WL, LAYOUT as L, deckAt, deckY } from './hulldef';

/**
 * Procedural VANGUARD (DDV-01), lead ship of the Vanguard-class guided-missile destroyers.
 * Ship-local frame: meters, +Y up, +Z bow, +X port, origin midships on the design waterline.
 *
 * Animated parts (rest pose = pointing forward +Z, horizontal):
 *  gun_mount (yaw: rotation.y) > gun_elev (pitch: rotation.x = -elevation) > gun_muzzle (empty at barrel tip)
 *  ciws_fwd_mount / ciws_aft_mount (yaw) > ciws_*_elev (rotation.x = -elevation) > ciws_*_barrels (spin: rotation.z), ciws_*_muzzle
 *  illum_fwd / illum_aft_port / illum_aft_stbd (yaw) > <name>_elev (rotation.x = -elevation)
 *  radar_surface, radar_horizon (rotation.y, continuous)
 *  vls_fwd (32 cells) / vls_aft (64 cells): hatches vls_*_hatch_i open with rotation.x = +angle; group.userData.cells
 *  prop_port / prop_stbd (spin rotation.z), rudder_port / rudder_stbd (rotation.y), helo > helo_rotor (rotation.y)
 */
let _template: THREE.Object3D | null = null;

/**
 * Create a Vanguard-class destroyer. The first call builds geometry/textures (~0.5 s); later calls clone the cached
 * template (geometry + materials shared by reference), so extra ships are cheap.
 * Do not dispose geometries/materials of one ship while others are alive.
 */
export function createDestroyer(): THREE.Object3D {
  const t0 = performance.now();
  if (!_template) _template = buildDestroyer();
  const ship = _template.clone(true);
  ship.userData = JSON.parse(JSON.stringify(_template.userData));
  ship.userData.createMs = performance.now() - t0;
  return ship;
}

function buildDestroyer(): THREE.Object3D {
  const t0 = performance.now();
  const mats = shipMaterials();
  const root = new THREE.Group();
  root.name = 'vanguard';
  const pb = new PartBuilder();

  // ---------------------------------------------------------------- hull & running gear
  buildHull(pb);
  buildRunningGear(pb, root, mats);

  // ---------------------------------------------------------------- superstructure
  const ss = buildSuperstructure(pb);
  // Sentinel octagonal phased-array faces
  {
    const R = 3.66 / 2 / Math.cos(Math.PI / 8);
    const face = new THREE.CylinderGeometry(R, R, 0.22, 8, 1, false);
    face.rotateX(Math.PI / 2);
    face.rotateZ(Math.PI / 8);
    {
      // planar UVs across the octagon so the element grid is axis-aligned
      const p = face.attributes.position, uv = face.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2 * R) + 0.5, p.getY(i) / (2 * R) + 0.5);
    }
    const frame = new THREE.CylinderGeometry(R + 0.16, R + 0.16, 0.12, 8, 1, false);
    frame.rotateX(Math.PI / 2);
    frame.rotateZ(Math.PI / 8);
    for (const fm of ss.arrays) {
      pb.add('array', face, fm.clone().multiply(M(0, 0, 0.17)), { uv: 'keep' });
      pb.add('paintFine', frame, fm.clone().multiply(M(0, 0, 0.06)));
    }
  }

  // ---------------------------------------------------------------- mast & radars
  buildMast(pb, root, mats, ss.mastBaseY);

  // ---------------------------------------------------------------- fittings, rails, boats
  const rails = new Railings();
  buildDeckFittings(pb, rails);
  buildFlightDeckNets(pb);
  buildLifeRafts(pb);
  buildBoats(pb);
  buildAntennas(pb);
  buildHullDecals(pb);
  addRoofRails(rails, ss.blocks);

  // ---------------------------------------------------------------- weapons
  // Anvil 5-inch gun
  const gunY = deckAt(0, L.gunZ);
  pb.add('deckPlain', new THREE.CylinderGeometry(1.75, 1.8, 0.08, 40), M(0, gunY + 0.03, L.gunZ - 0.4));
  const gun = createGun(mats);
  gun.position.set(0, gunY + 0.08, L.gunZ);
  root.add(gun);

  // Hornet CIWS fwd / aft
  for (const [nm, p] of [['ciws_fwd', ss.ciwsFwd], ['ciws_aft', ss.ciwsAft]] as [string, V3][]) {
    const { base } = createCIWS(nm, mats);
    base.position.set(p[0], p[1], p[2]);
    root.add(base);
  }
  // Lantern illuminators
  const illums: [string, V3][] = [['illum_fwd', ss.illumFwd], ['illum_aft_port', ss.illumAft[0]], ['illum_aft_stbd', ss.illumAft[1]]];
  for (const [nm, p] of illums) {
    const s = createIlluminator(nm, mats);
    s.position.set(p[0], p[1], p[2]);
    root.add(s);
  }
  // VLS: 32 cells forward (4 modules), 64 cells aft (8 modules)
  const vlsF = createVLS('vls_fwd', 2, 2, [0, deckAt(0, L.vlsFwdZ) - 0.02, L.vlsFwdZ], mats);
  root.add(vlsF);
  const vlsA = createVLS('vls_aft', 2, 4, [0, ss.vlsAftDeckY, L.vlsAftZ], mats);
  root.add(vlsA);
  // Wisp / chaff decoy launchers
  ss.decoyLaunchers.forEach((s, i) => root.add(addDecoyLauncher(pb, s.pos, s.outward, i)));
  // triple torpedo tubes (01 level, aft of the boats)
  addTorpedoTubes(pb, 6.4, L.lvl01, -15.4, 1);
  addTorpedoTubes(pb, -6.4, L.lvl01, -15.4, -1);

  // 25 mm chain gun mounts (01 level, abreast the forward stack)
  for (const sx of [1, -1]) addChainGun(pb, sx * 6.3, L.lvl01, 3.4, sx);

  // ---------------------------------------------------------------- helicopter (Petrel on the flight deck)
  const helo = createHelo(mats);
  helo.position.set(0, deckY(-66.5) + 0.02, -66.3);
  root.add(helo);

  // ---------------------------------------------------------------- merge static geometry
  rails.build(root, pb, mats);
  bakeFloorAO(pb);
  const statics = new THREE.Group();
  statics.name = 'ship_static';
  pb.build(statics, mats, 'ship');
  root.add(statics);

  // ---------------------------------------------------------------- effect empties
  const empty = (name: string, p: V3) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(p[0], p[1], p[2]);
    root.add(o);
    return o;
  };
  for (const f of ss.funnels) f.exhausts.forEach((p, i) => empty(`stack_${f.name}_exhaust_${i}`, p));
  empty('bow_spray', [0, 0, Z_STEM_WL]);
  empty('stern_wake', [0, 0, Z_STERN]);
  const cam = empty('bridge_cam', ss.bridgeCam);
  cam.rotation.y = Math.PI; // oriented like a THREE.Camera: looks along its local -Z = ship +Z (bow)
  empty('flight_deck_center', [0, deckY(-67) + 0.05, -67]);

  root.userData.dims = { loa: LOA, beam: 20.1, draft: 9.4, hullDraft: 6.3, height: 40.5 };
  root.userData.hitBoxes = [
    { center: [0, 4.6, 55.0], size: [16.5, 9.4, 45.0] },
    { center: [0, 3.4, -3.75], size: [20.1, 6.9, 72.5] },
    { center: [0, 2.6, -58.8], size: [19.0, 5.4, 37.7] },
    { center: [0, 13.4, 20.8], size: [17.2, 13.8, 27.6] },
    { center: [0, 17.3, 1.5], size: [7.0, 14.6, 11.0] },
    { center: [0, 8.1, -7.2], size: [17.0, 4.4, 28.3] },
    { center: [0, 16.5, -15.8], size: [7.0, 13.2, 10.5] },
    { center: [0, 8.4, -38.7], size: [18.6, 7.4, 35.4] },
    { center: [0, 28.5, 15.5], size: [5.0, 17.0, 8.0] },
  ];
  root.userData.buildMs = performance.now() - t0;
  console.log(`[vanguard] built in ${(performance.now() - t0).toFixed(0)} ms`);
  return root;
}

function addRoofRails(rails: Railings, b: Record<string, Block>) {
  const top = (k: string, inset = 0.15) => offsetPoly(b[k].top, inset);
  // forward 01 roof: around the front (stbd side -> front -> port side)
  {
    const t = top('fwd01');
    const y = b.fwd01.y1;
    rails.add([7, 8, 9, 0, 1, 2].map((i) => [t[i][0], y, t[i][1]] as V3));
  }
  // 05 level (bridge roof) — loop except aft
  {
    const t = top('lvl05');
    const y = b.lvl05.y1;
    const n = t.length;
    rails.add([n - 3, n - 2, n - 1, 0, 1, 2].map((i) => [t[i][0], y, t[i][1]] as V3), 1.5);
  }
  // pilothouse roof sides outboard of the 05 house
  {
    const t = top('pilot');
    const y = b.pilot.y1;
    const n = t.length;
    rails.add([[t[1][0], y, t[1][1]], [t[2][0], y, t[2][1]]], 1.5);
    rails.add([[t[n - 2][0], y, t[n - 2][1]], [t[n - 3][0], y, t[n - 3][1]]], 1.5);
  }
  // midships 01 roof sides (boat deck)
  {
    const t = top('mid01');
    const y = b.mid01.y1;
    rails.add([[t[0][0], y, t[0][1]], [t[1][0], y, t[1][1]]]);
    rails.add([[t[2][0], y, t[2][1]], [t[3][0], y, t[3][1]]]);
  }
  // aft 01 roof sides
  {
    const t = top('aft01');
    const y = b.aft01.y1;
    const n = t.length;
    rails.add([[t[0][0], y, t[0][1]], [t[1][0], y, t[1][1]], [t[2][0], y, t[2][1]]]);
    rails.add([[t[n - 1][0], y, t[n - 1][1]], [t[n - 2][0], y, t[n - 2][1]], [t[n - 3][0], y, t[n - 3][1]]]);
  }
  // hangar roof: outer edges, aft edge, VLS well edges
  const hy = L.hangarRoof;
  for (const sx of [1, -1]) {
    rails.add([[sx * 8.1, hy, -21.3], [sx * 8.95, hy, -24.8], [sx * 8.95, hy, -56.2], [sx * 3.9, hy, -56.2]]);
    rails.add([[sx * 3.95, hy, -24.6], [sx * 3.95, hy, -35.8], [sx * 2.6, hy, -35.8]]);
  }
}

/**
 * Cheap ambient-occlusion substitute for static painted geometry: vertex colours darken toward the
 * nearest floor level below (deck / 01 / 02 / 03 / bridge roof / hangar roof ...), giving contact
 * shadowing at the base of walls and fittings. Moves 'paint'/'paintFine' lists to their AO variants.
 */
function bakeFloorAO(pb: PartBuilder) {
  const levels = [L.lvl01, L.lvl02, L.lvl03, L.bridgeRoof, L.lvl05, L.hangarRoof, 8.75, 14.0];
  for (const key of ['paint', 'paintFine']) {
    const list = pb.lists.get(key);
    if (!list) continue;
    for (const g of list) {
      const p = g.attributes.position;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const d = Math.abs(z) < 77.6 ? deckAt(Math.min(Math.abs(x), 10), z) : 4.7;
        let floor = y < d - 0.05 ? y : d;
        for (const l of levels) if (l <= y + 0.02 && l > floor) floor = l;
        const h = y - floor;
        const f = y < d - 0.05 ? 0.72 : 0.74 + 0.26 * Math.min(1, Math.max(0, h / 2.2)) ** 0.7;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = f;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    pb.lists.set(key + 'AO', list);
    pb.lists.delete(key);
  }
}
