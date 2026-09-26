// Weapon/missile model registrations (owned by the weapons-model work stream)
import { registerModel } from '../registry';
import { createHalberd, createStiletto, createAsmSubsonic, createAsmSupersonic, createAsmHeavy, createBooster } from './missiles';

registerModel('halberd', () => createHalberd());
registerModel('glaive', () => createHalberd({ booster: true }));
registerModel('stiletto', () => createStiletto());
registerModel('asm_subsonic', () => createAsmSubsonic());
registerModel('asm_supersonic', () => createAsmSupersonic());
registerModel('asm_heavy', () => createAsmHeavy());
registerModel('booster', () => createBooster());
