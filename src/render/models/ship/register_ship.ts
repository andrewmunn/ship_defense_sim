// Ship model registrations (owned by the ship-model work stream)
import { registerModel } from '../registry';
import { createDestroyer } from './vanguard';

registerModel('vanguard', () => createDestroyer());
