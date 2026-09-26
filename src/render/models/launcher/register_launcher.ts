// Coastal-missile launcher (TEL) model registrations
import { registerModel } from '../registry';
import { createTEL } from './tel';

registerModel('tel', () => createTEL());
registerModel('tel_erect', () => {
  const g = createTEL();
  g.getObjectByName('tel_rack')!.rotation.x = (-35 * Math.PI) / 180;
  return g;
});
