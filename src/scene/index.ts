import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { HouseFrame, SceneApi, SceneFrame } from '../shared/types';
import { Environment } from './environment';
import { FlowSystem } from './flows';
import { HouseView } from './houseview';
import { DRIVE, EAVE_EDGE_Y, EAVE_EDGE_Z, HOUSE, LOT, RIDGE_Y, toWorld } from './layout';
import { buildWorld, type World } from './world';
import { clamp, DEG, damp, dampK, disposeTree, finite } from './util';

const FOV = 32;
/** Default camera elevation above the horizon, degrees (looking south from the street side). */
const DEFAULT_ELEV = 5.5;

export function defaultFrame(): SceneFrame {
  const h = (policy: 'mpc' | 'dp', label: string): HouseFrame => ({
    policy, label, pvKw: 3.4, loadKw: 0.7, evKw: 0, battKw: 2.2, gridKw: -0.5, socFrac: 0.55, evFrac: 0,
    evPresent: false, cost: 0,
  });
  return {
    timeH: 6.5, clockH: 13.5, sunElevationDeg: 55, sunAzimuthDeg: 5, cloud: 0.1,
    houses: [h('mpc', 'MPC · noisy forecast'), h('dp', 'DP · perfect hindsight')], simSpeed: 0,
  };
}

function sunVector(elDeg: number, azDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const e = elDeg * DEG, a = azDeg * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

export function createScene(container: HTMLElement): SceneApi {
  // ---- renderer -----------------------------------------------------------------------
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false });
  } catch (err) {
    const msg = document.createElement('div');
    msg.textContent = '3D view unavailable (WebGL could not start).';
    msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9fb0c6;font:14px system-ui;background:#0b1220';
    container.appendChild(msg);
    console.error('[scene] WebGL init failed', err);
    return { setFrame() {}, resize() {}, dispose() { msg.remove(); } };
  }
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x0b1220);

  // ---- scene ----------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9fb8d4, 70, 640);
  const env = new Environment();
  scene.add(env.group);
  const world: World = buildWorld();
  scene.add(world.group);
  const views = [
    new HouseView({ hs: world.houses[0], index: 0 }, world.textures),
    new HouseView({ hs: world.houses[1], index: 1 }, world.textures),
  ];
  for (const v of views) scene.add(v.group);
  const flows = new FlowSystem(world.houses);
  scene.add(flows.group);

  // ---- camera + controls -------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(FOV, 2.7, 0.3, 14000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.045;
  controls.minDistance = 5;
  controls.maxDistance = 140;
  controls.zoomSpeed = 0.7;
  controls.rotateSpeed = 0.55;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;

  // Points that must stay clear of the UI's HUD rectangles in the default view.
  const fitPts: THREE.Vector3[] = [];
  for (const hs of world.houses) {
    const pl = hs.placement;
    const W = (x: number, y: number, z: number): void => { fitPts.push(toWorld(pl, x, y, z)); };
    // roof, eaves, veranda and walls
    for (const x of [HOUSE.x0 - HOUSE.rake, HOUSE.x1 + HOUSE.rake]) {
      W(x, EAVE_EDGE_Y, EAVE_EDGE_Z);
      W(x, RIDGE_Y, 0);
    }
    W(HOUSE.verandaX0, 2.4, HOUSE.verandaZ);
    W(HOUSE.x1, 2.4, HOUSE.verandaZ);
    W(HOUSE.x0, 0.3, HOUSE.z0);
    W(HOUSE.x1, 0.3, HOUSE.z0);
    // panels (their centres plus a margin through the array extremes)
    for (const m of hs.panelMatrices) {
      const e = m.elements;
      fitPts.push(new THREE.Vector3(e[12], e[13], e[14]));
    }
    // battery + gauge, tags, EV and its gauge
    fitPts.push(hs.battBar.center.clone());
    fitPts.push(hs.tagAnchor.batt.clone().add(new THREE.Vector3(0, 1.1, 0)));
    for (const k of ['solar', 'grid', 'ev', 'load'] as const) fitPts.push(hs.tagAnchor[k].clone());
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      fitPts.push(new THREE.Vector3(hs.carPark.x + sx * 1.0, 1.6, hs.carPark.z + sz * 2.2));
      fitPts.push(new THREE.Vector3(hs.carPark.x + sx * 1.0, 0, hs.carPark.z + sz * 2.2));
    }
    fitPts.push(new THREE.Vector3(hs.carPark.x, 3.0, hs.carPark.z));
    // label pill
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      fitPts.push(new THREE.Vector3(hs.labelAnchor.x + sx * 3.2, hs.labelAnchor.y + sy * 0.7, hs.labelAnchor.z));
    }
    // fence line + letterbox + lot edge (kept above the arbitrage bar)
    for (const x of [DRIVE.x1 + 0.25, LOT.halfW]) {
      W(x, 0, LOT.frontZ);
      W(x, 1.1, LOT.frontZ);
    }
    W(DRIVE.x1 + 0.45, 1.4, LOT.frontZ);
  }
  const _v = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _tgt0 = new THREE.Vector3(0, 2.2, -2);

  /** HUD obstruction boxes (container-relative CSS px), read from `[data-hud-overlay]` elements. */
  let overlayEls: Element[] = [];
  function hudRects(): number[][] {
    const out: number[][] = [];
    const cr = container.getBoundingClientRect();
    overlayEls = Array.from(document.querySelectorAll('[data-hud-overlay]'));
    for (const el of overlayEls) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      const x0 = Math.max(0, r.left - cr.left), y0 = Math.max(0, r.top - cr.top);
      const x1 = Math.min(cr.width, r.right - cr.left), y1 = Math.min(cr.height, r.bottom - cr.top);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      out.push([x0, y0, x1, y1]);
    }
    return out;
  }
  const rectSig = (rs: number[][]): string => rs.map((r) => r.map(Math.round).join(',')).join(';');

  /** Total violation (px) of the key points against the HUD rectangles and the container edges. */
  function violation(rects: number[][]): number {
    const m = 8;
    let total = 0;
    for (const p of fitPts) {
      _v.copy(p).project(camera);
      const x = (_v.x * 0.5 + 0.5) * width, y = (0.5 - _v.y * 0.5) * height;
      if (x < 10) total += 10 - x;
      if (x > width - 10) total += x - (width - 10);
      if (y > height - 6) total += y - (height - 6);
      for (const r of rects) {
        const x0 = r[0] - m, y0 = r[1] - m, x1 = r[2] + m, y1 = r[3] + m;
        if (x > x0 && x < x1 && y > y0 && y < y1) total += Math.min(x - x0, x1 - x, y - y0, y1 - y) + 1;
      }
    }
    return total;
  }

  /**
   * Pick the largest view (smallest distance) along `dir` for which every key point
   * clears the HUD, vertically centred inside the feasible range.
   */
  function fitView(dir: THREE.Vector3, instant: boolean): void {
    const rects = hudRects();
    lastSig = rectSig(rects);
    const prevPos = camera.position.clone(), prevTarget = controls.target.clone();
    camera.position.copy(_tgt0).addScaledVector(dir, 40);
    camera.lookAt(_tgt0);
    camera.updateMatrixWorld(true);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    const quat = camera.quaternion.clone();
    const tanH = Math.tan((FOV * DEG) / 2);
    let best = { v: Infinity, d: 60, s: 0 };
    let found = false;
    const target = new THREE.Vector3();
    const place = (d: number, s: number): void => {
      target.copy(_tgt0).addScaledVector(_up, s);
      camera.position.copy(target).addScaledVector(dir, d);
      camera.quaternion.copy(quat);
      camera.updateMatrixWorld(true);
    };
    for (let d = 20; d <= 130 && !found; d += 1) {
      const kY = d * tanH;
      const ok: number[] = [];
      for (let i = -40; i <= 40; i++) {
        const s = (i / 40) * kY * 0.9;
        place(d, s);
        const v = violation(rects);
        if (v < best.v) best = { v, d, s };
        if (v === 0) ok.push(s);
      }
      // lowest placement that still clears the HUD (fence just above the bar, most sky)
      if (ok.length) { best = { v: 0, d, s: ok[Math.max(0, ok.length - 1 - Math.floor(ok.length * 0.12))] }; found = true; }
    }
    place(best.d, best.s);
    controls.maxDistance = Math.max(100, best.d * 2.4);
    if (instant) {
      controls.target.copy(target);
      controls.update();
    } else {
      fitAnim = { t: 0, fromPos: prevPos, fromTarget: prevTarget, toPos: camera.position.clone(), toTarget: target.clone() };
      camera.position.copy(prevPos);
      controls.target.copy(prevTarget);
    }
  }
  let fitAnim: { t: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
  let lastSig = '';
  const dirFromAngles = (azRad: number, elRad: number): THREE.Vector3 =>
    new THREE.Vector3(Math.sin(azRad) * Math.cos(elRad), Math.sin(elRad), -Math.cos(azRad) * Math.cos(elRad));
  const defaultDir = (): THREE.Vector3 => dirFromAngles(0, DEFAULT_ELEV * DEG);
  let userMoved = false;
  controls.addEventListener('start', () => { userMoved = true; });
  const onDbl = (): void => { userMoved = false; fitView(defaultDir(), false); };
  canvas.addEventListener('dblclick', onDbl);

  // ---- post processing ------------------------------------------------------------------------
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.5, 0.55, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- sizing -----------------------------------------------------------------------------------
  let width = 0, height = 0, pixelRatio = 1;
  function resize(): void {
    const w = Math.max(2, Math.floor(container.clientWidth || 2));
    const h = Math.max(2, Math.floor(container.clientHeight || 2));
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === width && h === height && pr === pixelRatio) return;
    width = w; height = h; pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    flows.setViewport(h, FOV, pr);
    // keep the viewer's orbit direction, re-fit target and distance to the new aspect
    if (!userMoved) fitView(defaultDir(), !fitted);
    fitted = true;
    observeOverlays();
    shadowDirty = true;
  }
  let shadowDirty = true;
  let fitted = false;

  // ---- frame state --------------------------------------------------------------------------------
  let frame: SceneFrame = defaultFrame();
  let lastTimeH = frame.timeH;
  let snapNext = true;
  let gotFrame = false;
  const sunTarget = sunVector(frame.sunElevationDeg, frame.sunAzimuthDeg, new THREE.Vector3());
  const sunSmooth = sunTarget.clone();
  let cloudSmooth = frame.cloud;
  const _sun = new THREE.Vector3();

  function setFrame(f: SceneFrame): void {
    if (!f || !f.houses) return;
    if (!gotFrame) { gotFrame = true; snapNext = true; }
    if (Math.abs(finite(f.timeH) - lastTimeH) > 0.9) snapNext = true;
    lastTimeH = finite(f.timeH);
    frame = f;
  }

  // ---- loop ------------------------------------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let time = 0;
  let disposed = false;
  const lampCol = new THREE.Color();

  function tick(now: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;
    time += dt;
    const f = frame;
    const snap = snapNext || !gotFrame;
    if (gotFrame) snapNext = false;

    sunVector(finite(f.sunElevationDeg, 45), finite(f.sunAzimuthDeg), sunTarget);
    if (snap) { sunSmooth.copy(sunTarget); cloudSmooth = clamp(finite(f.cloud), 0, 1); }
    else {
      sunSmooth.lerp(sunTarget, dampK(0.2, dt)).normalize();
      cloudSmooth = damp(cloudSmooth, clamp(finite(f.cloud), 0, 1), 0.4, dt);
    }
    _sun.copy(sunSmooth);
    env.update(_sun, cloudSmooth, finite(f.clockH, 12), camera, time, dt, finite(f.simSpeed), pixelRatio);
    const es = env.state;
    scene.fog!.color.copy(es.fog);
    renderer.toneMappingExposure = es.exposure;
    bloom.strength = es.bloom;

    let carMoving = false;
    for (let i = 0; i < 2; i++) {
      const hf = f.houses[i];
      const v = views[i];
      v.update(hf, dt, es.lamps, es.night, time, snap, finite(f.simSpeed));
      carMoving ||= v.carMoving;
      flows.setTarget(i, 'solar', hf.pvKw);
      flows.setTarget(i, 'load', hf.loadKw);
      flows.setTarget(i, 'ev', hf.evKw);
      flows.setTarget(i, 'batt', hf.battKw);
      flows.setTarget(i, 'grid', hf.gridKw);
      flows.setWeight(i, 'ev', v.docked);
    }
    if (snap) flows.snap();
    flows.update(dt, time);

    // lamps, porch lights, light pools
    const l = es.lamps;
    for (const m of world.lampMats) m.color.setRGB(0.05 + 4.2 * l, 0.05 + 3.3 * l, 0.05 + 2.1 * l);
    for (const m of world.porchMats) m.color.setRGB(0.05 + 3.2 * l, 0.05 + 2.4 * l, 0.05 + 1.3 * l);
    for (const p of world.pools) {
      p.material.opacity = p.base * l;
      p.mesh.visible = l > 0.01;
    }
    void lampCol;

    // shadow map: only re-render when the key light or a caster moved
    if (env.shadowDirty || carMoving || shadowDirty) {
      renderer.shadowMap.needsUpdate = true;
      env.shadowDirty = false;
      shadowDirty = false;
    }
    sigClock += dt;
    if (sigClock > 0.5) {
      sigClock = 0;
      observeOverlays();
      if (!userMoved && rectSig(hudRects()) !== lastSig) refit();
    }
    if (fitAnim) {
      fitAnim.t = Math.min(1, fitAnim.t + dt / 0.4);
      const k = fitAnim.t * fitAnim.t * (3 - 2 * fitAnim.t);
      camera.position.lerpVectors(fitAnim.fromPos, fitAnim.toPos, k);
      controls.target.lerpVectors(fitAnim.fromTarget, fitAnim.toTarget, k);
      if (fitAnim.t >= 1) fitAnim = null;
    }
    controls.target.clamp(new THREE.Vector3(-45, 0, -45), new THREE.Vector3(45, 12, 35));
    controls.update();
    composer.render(dt);
  }

  const observed = new Set<Element>();
  const roOverlay = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => refit()) : null;
  function observeOverlays(): void {
    for (const el of Array.from(document.querySelectorAll('[data-hud-overlay]'))) {
      if (!observed.has(el)) { observed.add(el); roOverlay?.observe(el); }
    }
  }
  /** Re-fit to the current overlays unless the viewer has taken the camera. */
  function refit(): void {
    if (userMoved || !fitted) return;
    fitView(defaultDir(), false);
  }
  const timers = [250, 800, 2000, 4500].map((ms) => window.setTimeout(() => { observeOverlays(); refit(); }, ms));
  let sigClock = 0;

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  resize();
  raf = requestAnimationFrame(tick);

  return {
    setFrame,
    resize,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      roOverlay?.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      canvas.removeEventListener('dblclick', onDbl);
      controls.dispose();
      for (const v of views) v.dispose();
      flows.dispose();
      env.dispose();
      disposeTree(scene);
      for (const t of world.textures) t.dispose();
      composer.dispose();
      rt.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
