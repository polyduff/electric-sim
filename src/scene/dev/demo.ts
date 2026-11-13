/**
 * Dev harness for the 3D scene: synthetic SceneFrames, no dependency on src/sim.
 *
 *   ?clock=13.5&cloud=0.2            frozen state (all derived values sensible)
 *   ?anim=1&speed=1.5                animated 48 h loop starting 07:00 (speed = sim hours per second)
 *   ?w=1440&h=520                    container size
 *   ?hud=1                           draw the UI's HUD card footprints for layout checks
 *   overrides: pv, load, ev, batt, grid, soc, evfrac, present (0/1), optional suffix 0/1 per house, e.g. batt1=-3
 *   window.__setDemo({ clock, cloud, pv0, ... })   set an exact frozen frame from the page
 */
import { createScene } from '../index';
import type { HouseFrame, SceneFrame } from '../../shared/types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = q.get(k);
  return v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
};

const view = document.getElementById('view') as HTMLElement;
const info = document.getElementById('info') as HTMLElement;
view.style.width = `${num('w', 1440)}px`;
view.style.height = `${num('h', 520)}px`;
if (q.get('hud') === '1') {
  // the real UI's HUD footprints (fixed px, see the lead's integration notes)
  const W = view.clientWidth, H = view.clientHeight, c = W / 2, bh = Math.min(500, 0.34 * W);
  for (const [x0, y0, x1, y1] of [[0, 0, W, 50], [0, 50, 296, 185], [W - 296, 50, W, 185], [c - 165, 50, c + 165, 136], [c - bh, H - 56, c + bh, H]]) {
    const e = document.createElement('div');
    e.className = 'hud';
    e.setAttribute('data-hud-overlay', '');
    e.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
    view.appendChild(e);
  }
}

let scene = createScene(view);

// ?disposetest=1: create / dispose / create again, then report canvases left in the container
if (q.get('disposetest') === '1') {
  scene.dispose();
  scene = createScene(view);
  scene.dispose();
  scene = createScene(view);
  console.log('[disposetest] canvases in container:', view.querySelectorAll('canvas').length);
}

const DEG = Math.PI / 180;

/** Sun for Christchurch on 12 Nov (NZDT): solar noon ~13:13 clock, declination -17.4 deg. */
function sun(clockH: number): { el: number; az: number } {
  const phi = -43.53 * DEG, dec = -17.4 * DEG;
  const H = (clockH - 13.22) * 15 * DEG;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(sinEl);
  const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  let az = (A / DEG + 180) % 360;
  if (az < 0) az += 360;
  return { el: el / DEG, az };
}

type Over = Partial<Record<string, number>>;
let overrides: Over = {};
for (const [k, v] of q.entries()) if (v !== '' && !Number.isNaN(Number(v))) overrides[k] = Number(v);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function houseFrame(i: 0 | 1, clock: number, cloud: number, o: Over): HouseFrame {
  const s = sun(clock);
  const sinEl = Math.max(0, Math.sin(s.el * DEG));
  const clear = 6 * Math.pow(sinEl, 1.1) * 0.95;
  const pvAuto = clear * (1 - 0.85 * Math.pow(cloud, 1.2));
  const evening = Math.exp(-Math.pow((clock - 19) / 2.2, 2));
  const morning = Math.exp(-Math.pow((clock - 7.5) / 1.1, 2));
  const loadAuto = 0.45 + 1.7 * evening + 0.9 * morning + (i === 1 ? 0.12 : 0);
  const present = clock >= 18 || clock < 7;
  const evAuto = present && (clock >= 22.5 || clock < 5.5) ? 7 : present && clock >= 18.2 && i === 0 ? 3.5 : 0;
  const hr = clock;
  const battAuto = (hr > 10 && hr < 15 ? 3.2 : hr > 18 && hr < 21.5 ? -3.4 : hr > 1 && hr < 4 ? 3 : 0) * (i === 1 ? 0.9 : 1);
  const g = (k: string, d: number): number => o[k + i] ?? o[k] ?? d;
  const pv = g('pv', pvAuto);
  const load = g('load', loadAuto);
  const pres = g('present', present ? 1 : 0) > 0.5;
  const ev = pres ? g('ev', evAuto) : 0;
  const batt = g('batt', battAuto);
  const grid = g('grid', load + ev + batt - pv);
  const socAuto = clock < 7 ? 0.5 + 0.0 * clock : 0.35 + 0.5 * smooth(8, 15, clock) - 0.4 * smooth(18, 21.5, clock) + 0.1 * smooth(1, 4, clock % 24);
  const evFracAuto = pres ? (clock >= 18 ? Math.min(1, (clock - 18) / 10) : Math.min(1, (clock + 6) / 10)) : 0;
  return {
    policy: i === 0 ? 'mpc' : 'dp',
    label: i === 0 ? 'MPC · noisy forecast' : 'DP · perfect hindsight',
    pvKw: Math.max(0, pv), loadKw: Math.max(0, load), evKw: Math.max(0, ev), battKw: batt, gridKw: grid,
    socFrac: Math.min(1, Math.max(0, g('soc', socAuto))),
    evFrac: Math.min(1, Math.max(0, g('evfrac', evFracAuto))),
    evPresent: pres,
    cost: 0,
  };
}

function frameFor(timeH: number, o: Over, simSpeed: number): SceneFrame {
  const clock = o.clock !== undefined && !animate ? o.clock : (7 + timeH) % 24;
  const cloud = o.cloud ?? 0.15;
  const s = sun(clock);
  return {
    timeH, clockH: clock, sunElevationDeg: s.el, sunAzimuthDeg: s.az, cloud,
    houses: [houseFrame(0, clock, cloud, o), houseFrame(1, clock, cloud, o)], simSpeed,
  };
}

let animate = q.get('anim') === '1';
const speed = num('speed', 1.5);
let t0 = performance.now();
let simT = (num('clock', 7) - 7 + 48) % 48;
let frozen: SceneFrame = frameFor(simT, overrides, 0);

function loop(now: number): void {
  requestAnimationFrame(loop);
  let f: SceneFrame;
  if (animate) {
    simT = ((now - t0) / 1000) * speed + (num('clock', 7) - 7 + 48) % 48;
    f = frameFor(simT % 48, overrides, speed);
  } else f = frozen;
  scene.setFrame(f);
  const h0 = f.houses[0];
  info.textContent = `clock ${f.clockH.toFixed(2)}  sun el ${f.sunElevationDeg.toFixed(1)} az ${f.sunAzimuthDeg.toFixed(0)}  cloud ${f.cloud.toFixed(2)}  | h0 pv ${h0.pvKw.toFixed(1)} load ${h0.loadKw.toFixed(1)} ev ${h0.evKw.toFixed(1)} batt ${h0.battKw.toFixed(1)} grid ${h0.gridKw.toFixed(1)} soc ${h0.socFrac.toFixed(2)} ev@home ${h0.evPresent}`;
}
requestAnimationFrame(loop);

const w = window as unknown as Record<string, unknown>;
/** Set an exact frozen frame: __setDemo({ clock: 19.75, cloud: 0.3, batt0: -4 }). */
w.__setDemo = (o: Over): void => {
  animate = false;
  overrides = { ...overrides, ...o };
  simT = ((overrides.clock ?? 12) - 7 + 48) % 48;
  frozen = frameFor(simT, overrides, 0);
};
/** Replace the frame wholesale (full SceneFrame object). */
w.__setFrame = (f: SceneFrame): void => { animate = false; frozen = f; };
w.__demoAnimate = (on: boolean): void => { animate = on; t0 = performance.now(); };
w.__scene = scene;
