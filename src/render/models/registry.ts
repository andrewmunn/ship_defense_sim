import * as THREE from 'three';

/**
 * Model registry used by the standalone viewer (viewer.html?model=<name>) and the game.
 * Conventions for ALL models:
 *  - Units: meters. +Y up. Forward (bow / nose) = +Z. Port = +X, starboard = -X.
 *  - Ships: origin at midships on the design waterline (y = 0 is the waterline).
 *  - Missiles: origin at the center of the airframe length, nose toward +Z.
 */
export type ModelFactory = () => THREE.Object3D;

const registry: Record<string, ModelFactory> = {};

export function registerModel(name: string, f: ModelFactory) {
  registry[name] = f;
}
export function listModels() {
  return Object.keys(registry);
}
export function createModel(name: string): THREE.Object3D | null {
  const f = registry[name];
  return f ? f() : null;
}
