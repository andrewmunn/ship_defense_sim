import { Game } from './game/game';
import { Hud } from './ui/hud';
import { Overlay } from './ui/overlay';
import { SetupDialog, HelpDialog, Debrief } from './ui/setup';
import { Director } from './camera/director';
import { Soundscape } from './game/soundscape';
import { bridgeMount, ciwsMount, wingMount, noseMount } from './camera/shots';
import type { Entity } from './sim/entities';

const P = new URLSearchParams(location.search);
const loading = document.getElementById('loading')!;
const bar = loading.querySelector('.p i') as HTMLElement;
const msg = loading.querySelector('.msg') as HTMLElement;
const setProgress = (f: number, m: string) => {
  bar.style.width = `${Math.round(f * 100)}%`;
  msg.textContent = m;
};

async function boot() {
  setProgress(0.15, 'building ship');
  await new Promise((r) => setTimeout(r, 30));
  const app = document.getElementById('app')!;
  const game = new Game(app);
  (window as any).game = game;
  setProgress(0.6, 'raising the coast');
  const overlay = new Overlay(game);
  const hud = new Hud(game);
  const setup = new SetupDialog(game);
  const help = new HelpDialog();
  const debrief = new Debrief(game);
  const director = new Director(game);
  game.addPlugin(director);
  const sound = new Soundscape(game);
  game.addPlugin(sound);
  (window as any).sound = sound;
  game.addPlugin({ update: (dt) => { overlay.draw(); hud.update(dt); } });
  (window as any).director = director;

  // ---------------------------------------------------------------- camera modes
  let camMode = 'orbit';
  const setCam = (mode: string) => {
    const tgt = (game.selected ?? game.rig.target ?? game.world.ship) as Entity;
    director.setActive(false);
    camMode = mode;
    game.rig.fovGoal = 50;
    switch (mode) {
      case 'orbit':
        game.follow(tgt);
        break;
      case 'chase':
        game.rig.follow(tgt, { dist: Math.max(tgt.radius * 7, 16), mode: 'chase' });
        game.rig.pitchGoal = 0.12;
        game.rig.chaseYawOffset = 0;
        break;
      case 'nose':
        game.rig.setFixed(noseMount(game, tgt));
        game.rig.fovGoal = 60;
        break;
      case 'bridge':
        game.rig.setFixed(bridgeMount(game));
        game.rig.fovGoal = 55;
        break;
      case 'ciws':
        game.rig.setFixed(ciwsMount(game, 0));
        break;
      case 'wing':
        game.rig.setFixed(wingMount(game));
        game.rig.fovGoal = 42;
        break;
      case 'free':
        game.rig.setFree();
        break;
    }
  };
  const cycleCam = () => {
    const tgt = (game.selected ?? game.rig.target) as Entity | null;
    const list = tgt && (tgt.kind === 'threat' || tgt.kind === 'interceptor') ? ['orbit', 'chase', 'nose'] : ['orbit', 'bridge', 'ciws', 'wing'];
    const i = list.indexOf(camMode);
    if (!tgt || tgt.kind === 'ship' || list === undefined) game.select(game.world.ship);
    setCam(list[(i + 1) % list.length]);
  };
  hud.hooks = {
    onVampire: () => sound.vampire(),
    onBrace: () => sound.brace(),
    onClick: () => sound.click(),
    openSetup: () => setup.open(),
    openHelp: () => help.toggle(),
    toggleCinematic: () => { director.setActive(!director.active); return director.active; },
    camMode: () => (director.active ? 'cinematic' : game.rig.mode === 'fixed' ? camMode : game.rig.mode),
    setCam,
  };
  director.onChange = (a) => {
    document.querySelector('#brand [data-a=cine]')?.classList.toggle('on', a);
    document.getElementById('hud')!.classList.toggle('cine', a);
  };
  debrief.onReplay = () => game.restart(game.cfg);
  debrief.onSetup = () => setup.open();
  const lockShip = () => {
    director.setActive(false);
    camMode = 'orbit';
    game.select(game.world.ship);
    game.follow(game.world.ship);
  };
  let debriefShown = false;
  // every run starts with the camera locked on the destroyer
  game.events.on('restart', () => { debriefShown = false; lockShip(); });
  game.events.on('frame', () => {
    const W = game.world;
    if (W.over && !debriefShown && W.t > (W as any)._overT + 6) {
      debriefShown = true;
      debrief.open();
    }
    if (W.over && (W as any)._overT === undefined) (W as any)._overT = W.t;
  });

  // ---------------------------------------------------------------- keyboard
  const cycleThreat = (dir: number) => {
    const list = game.world.threats.filter((t) => t.alive).sort((a, b) => a.pos.distanceTo(game.world.ship.pos) - b.pos.distanceTo(game.world.ship.pos));
    if (!list.length) return;
    const i = list.indexOf(game.selected as any);
    const next = list[(i + dir + list.length) % list.length];
    director.setActive(false);
    camMode = 'orbit';
    game.select(next, true);
  };
  const cycleInterceptor = () => {
    const list = game.world.interceptors.filter((t) => t.alive);
    if (!list.length) return;
    const i = list.indexOf(game.selected as any);
    director.setActive(false);
    camMode = 'orbit';
    game.select(list[(i + 1) % list.length], true);
  };
  const skipToContact = () => {
    const W = game.world;
    const stopAt = Math.max(W.t, W.firstArrival - 70);
    let guard = 0;
    while (W.t < stopAt && !W.radar.activeTracks().length && guard++ < 400) game.advance(0.5);
  };
  addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Escape') {
      if (setup.isOpen) setup.close();
      else if (help.isOpen) help.close();
      else if (debrief.isOpen) debrief.close();
      else { game.select(null); director.setActive(false); camMode = 'orbit'; game.follow(game.world.ship); }
      return;
    }
    if (setup.isOpen || debrief.isOpen) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'].includes(e.code)) director.setActive(false);
    switch (e.code) {
      case 'Space': game.setPaused(!game.paused); e.preventDefault(); break;
      case 'BracketLeft': case 'Minus': game.stepTimeScale(-1); break;
      case 'BracketRight': case 'Equal': game.stepTimeScale(1); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
        game.setPaused(false);
        game.setAutoTime(false);
        game.setTimeScale([0.25, 1, 2, 4, 8, 16][+e.code.slice(5) - 1]);
        break;
      case 'KeyA': if (!e.repeat && game.rig.mode !== 'free' && game.rig.mode !== 'look' && e.shiftKey) { game.setAutoTime(!game.autoTime); } break;
      case 'Tab': cycleThreat(e.shiftKey ? -1 : 1); e.preventDefault(); break;
      case 'KeyI': cycleInterceptor(); break;
      case 'Home': case 'Digit0': director.setActive(false); camMode = 'orbit'; game.select(game.world.ship); game.follow(game.world.ship); break;
      case 'KeyC': director.setActive(!director.active); break;
      case 'KeyV': cycleCam(); break;
      case 'KeyG': director.setActive(false); setCam('free'); break;
      case 'KeyZ': director.setActive(false); game.rig.toggleLook(); break;
      case 'KeyL': overlay.labelMode = overlay.labelMode === 'all' ? 'threats' : overlay.labelMode === 'threats' ? 'none' : 'all'; break;
      case 'KeyT': overlay.showTruth = !overlay.showTruth; break;
      case 'KeyO': overlay.showHorizon = !overlay.showHorizon; overlay.showEngagements = overlay.showHorizon; break;
      case 'KeyU': document.getElementById('hud')!.classList.toggle('hidden'); overlay.visible = !document.getElementById('hud')!.classList.contains('hidden'); break;
      case 'KeyH': help.toggle(); break;
      case 'KeyP': setup.open(); break;
      case 'KeyK': skipToContact(); break;
      case 'KeyM': sound.eng.muted = !sound.eng.muted; break;
    }
  });

  setProgress(1, 'ready');
  game.start();
  // browsers only allow audio after a user gesture; the first click or key press unlocks it
  const unlockAudio = () => {
    (window as any).__audioUnlock?.();
    removeEventListener('pointerdown', unlockAudio, true);
    removeEventListener('keydown', unlockAudio, true);
  };
  addEventListener('pointerdown', unlockAudio, true);
  addEventListener('keydown', unlockAudio, true);
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 900);
  if (P.has('nointro')) {
    if (!P.has('manual')) director.setActive(true);
    return;
  }
  // first load: hold the sim on the scenario menu (cinematic backdrop) until the player commences
  game.setPaused(true);
  director.setActive(true);
  setup.onClose = () => {
    setup.onClose = () => {};
    game.setPaused(false);
    lockShip();
  };
  setup.open();
}

boot();
