# Generates tools/scenes/shipv2_views.json (ship close-up review set). Usage: python shipv2_gen.py <outdir> [subset]
import json, sys
out = sys.argv[1] if len(sys.argv) > 1 else 'shots/shipv2/game'
only = sys.argv[2].split(',') if len(sys.argv) > 2 else None
DAY = "game.atm.setState({timeOfDay:%s}); "
views = [
  ('a_bowq',    (0, 8, 5, 0.5, 0.08, 120, 40), None),
  ('b_side',    (0, 8, 0, 1.57, 0.02, 170, 35), None),
  ('c_sternq',  (0, 6, -20, 2.7, 0.25, 110, 40), None),
  ('d_bridge',  (0, 17, 22, 0.6, 0.15, 30, 45), None),
  ('e_bow',     (0, 6, 55, 0.9, 0.12, 38, 45), None),
  ('f_funnels', (0, 17, -6, 1.9, 0.25, 38, 45), None),
  ('g_hangar',  (0, 8, -62, 2.8, 0.3, 42, 45), None),
  ('h_mid',     (0, 10, 0, -1.0, 0.2, 75, 40), None),
  ('i_array',   (6, 13, 24, 0.9, 0.05, 16, 45), None),
  ('k_flight',  (0, 7, -66, -2.3, 0.35, 28, 45), None),
  ('m_bowlow',  (0, 4, 40, -0.35, 0.03, 70, 40), None),
  ('n_canisters', (0, 11, -6, 1.2, 0.35, 18, 45), None),
  ('o_decoy', (6.5, 10.8, 32.2, 1.57, 0.4, 9, 45), None),
  ('r_lit_mid', (0, 12, 5, 0.9, 0.12, 60, 40), None),
  ('s_lit_aft', (0, 9, -40, 1.25, 0.15, 42, 42), None),
  ('t_lit_bridge', (4, 16, 20, 0.75, 0.1, 26, 45), None),
  ('p_hangarside', (9, 8, -40, 1.57, 0.1, 28, 45), None),
  ('q_stern_low', (0, 6, -60, 2.3, 0.05, 60, 40), None),
  ('j_sunset',  (0, 8, 5, -0.6, 0.08, 110, 40), 18.6),
  ('l_sunset_close', (0, 14, 10, -1.1, 0.12, 50, 45), 18.6),
]
DEF = "window.V=game.world.ship.pos.constructor; window.F=(x,y,z,yr,p,d,fov=40)=>{const pt=new V(x,y,z).applyMatrix4(game.world.ship.localToWorld); T.orbit({pos:pt,vel:game.world.ship.vel,radius:5,alive:true,id:-1}, game.world.ship.heading+yr, p, d, fov);}; T.hideHud(); game.setAutoTime(false); "
steps = [{"wait": 600}]
for n, a, tod in views:
  if only and n not in only: continue
  x,y,z,yr,p,d,fov = a
  steps.append({"eval": DEF + (DAY % tod if tod else "") + f"game.setPaused(false); F({x},{y},{z},{yr},{p},{d},{fov}); game.advance(0.1); T.pause(); null", "wait": 1400, "shot": f"{out}/{n}.png"})
json.dump({"url": "/?scenario=mixedraid&nointro&manual", "steps": steps}, open('tools/scenes/shipv2_views.json','w'), indent=1)
