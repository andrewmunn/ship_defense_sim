// Each model module calls registerModel(...) on import.
import { registerModel } from './registry';
import * as THREE from 'three';
import './ship/register_ship';
import './weapons/register_weapons';
import './launcher/register_launcher';

registerModel('test_cube', () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial({ color: 0x888888 }));
  m.position.y = 5;
  return m;
});
