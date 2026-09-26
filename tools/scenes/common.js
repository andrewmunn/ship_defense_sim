// helpers injected into the page (eval'd before steps)
window.T = {
  until(pred, max = 400, h = 0.1) { let n = 0; while (!pred() && n++ < max / h) game.advance(h); return game.world.t; },
  orbitShip(yawRel, pitch, dist, fov = 50) { const s = game.world.ship; game.rig.follow(s, { dist }); game.rig.cut({ focus: s.pos.clone(), yaw: s.heading + yawRel, pitch, dist }); game.rig.fovGoal = fov; game.camera.fov = fov; },
  orbit(e, yaw, pitch, dist, fov = 50) { game.rig.follow(e, { dist }); game.rig.cut({ focus: e.pos.clone(), yaw, pitch, dist }); game.rig.fovGoal = fov; game.camera.fov = fov; },
  pause() { game.setPaused(true); },
  manual() { window.director && window.director.setActive(false); game.setAutoTime(false); },
  hideHud() { document.getElementById('hud').classList.add('hidden'); },
};
