import * as THREE from 'three';
import type { HouseFrame } from '../shared/types';
import { Car } from './ev';
import type { HouseStatic } from './house';
import { GaugeSprite, LabelSprite } from './labels';
import { HOUSE_STYLE, POLICY_COLOR } from './layout';
import { panelGlowTexture, panelTexture, windowGlowTexture } from './textures';
import { clamp01, damp, finite, smoothstep } from './util';

const BAR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Segmented, glowing state-of-charge bar. */
const BAR_FRAG = /* glsl */ `
uniform float uFill;
uniform vec3 uColor;
uniform float uTime;
uniform float uMode;
uniform float uSeg;
uniform float uHdr;
varying vec2 vUv;
void main() {
  float y = vUv.y * uSeg;
  float i = floor(y);
  float f = fract(y);
  float gap = smoothstep(0.0, 0.14, f) * smoothstep(1.0, 0.86, f);
  float xg = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
  float lit = clamp(uFill * uSeg - i, 0.0, 1.0);
  float on = smoothstep(0.0, 0.35, lit);
  float pulse = 0.0;
  if (abs(uMode) > 0.5) {
    pulse = 0.5 + 0.5 * sin(vUv.y * 9.0 - uTime * 4.0 * uMode);
  }
  vec3 c = uColor * (uHdr * (0.8 + 0.5 * pulse * on)) * on + uColor * 0.07 * (1.0 - on);
  gl_FragColor = vec4(c * gap * xg, 1.0);
}`;

function cssOf(c: THREE.Color): string {
  return '#' + c.clone().convertLinearToSRGB().getHexString();
}

const C_CHARGE = new THREE.Color(0x22e0a0);
const C_DISCH = new THREE.Color(0xffa02e);
const C_IDLE = new THREE.Color(0x5ac8ff);
const C_LOW = new THREE.Color(0xff4a3a);
const C_EV = new THREE.Color(0xa974ff);

export interface HouseViewDeps {
  hs: HouseStatic;
  index: 0 | 1;
}

/** Everything about one house that moves or lights up with the frame. */
export class HouseView {
  readonly group = new THREE.Group();
  readonly car: Car;
  private panelMat: THREE.MeshStandardMaterial;
  private glassMats: THREE.MeshStandardMaterial[] = [];
  private barMat: THREE.ShaderMaterial;
  private chargerMat: THREE.MeshBasicMaterial;
  private label: LabelSprite;
  private battGauge: GaugeSprite;
  private evGauge: GaugeSprite;
  private owned: { dispose(): void }[] = [];
  // smoothed visual state
  private s = { pv: 0, load: 0, soc: 0.5, evFrac: 0, evKw: 0, batt: 0 };
  private firstFrame = true;
  /** Docked factor of the car (0..1), exposed for the flow system. */
  docked = 1;
  carMoving = false;

  constructor(private deps: HouseViewDeps, textures: THREE.Texture[]) {
    const { hs, index } = deps;
    const own = <T extends { dispose(): void }>(o: T): T => { this.owned.push(o); return o; };
    const keepTex = <T extends THREE.Texture>(t: T): T => { textures.push(t); return t; };

    // --- solar panels -----------------------------------------------------------------
    const pTex = keepTex(panelTexture());
    const pGlow = keepTex(panelGlowTexture());
    this.panelMat = own(new THREE.MeshStandardMaterial({
      map: pTex, emissiveMap: pGlow, emissive: new THREE.Color(1.0, 0.62, 0.2), emissiveIntensity: 0,
      roughness: 0.5, metalness: 0.08, color: 0xb8c4d8,
    }));
    const pg = own(new THREE.PlaneGeometry(1.0, 1.65).rotateX(-Math.PI / 2));
    const panels = new THREE.InstancedMesh(pg, this.panelMat, hs.panelMatrices.length);
    hs.panelMatrices.forEach((m, i) => panels.setMatrixAt(i, m));
    panels.instanceMatrix.needsUpdate = true;
    panels.castShadow = true;
    panels.receiveShadow = true;
    panels.frustumCulled = false;
    this.group.add(panels);

    // --- windows -----------------------------------------------------------------------
    const glowTex = keepTex(windowGlowTexture());
    hs.glass.forEach((geom, i) => {
      const mat = own(new THREE.MeshStandardMaterial({
        color: i === 0 ? 0x16222e : 0x131d28, roughness: 0.12, metalness: 0.2,
        emissive: new THREE.Color(1, 0.86, 0.6), emissiveMap: glowTex, emissiveIntensity: 0,
      }));
      this.glassMats.push(mat);
      own(geom);
      const m = new THREE.Mesh(geom, mat);
      this.group.add(m);
    });

    // --- battery SoC bar -----------------------------------------------------------------
    const bb = hs.battBar;
    this.barMat = own(new THREE.ShaderMaterial({
      vertexShader: BAR_VERT,
      fragmentShader: BAR_FRAG,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: {
        uFill: { value: 0.5 }, uColor: { value: new THREE.Color(C_IDLE) }, uTime: { value: 0 },
        uMode: { value: 0 }, uSeg: { value: 10 }, uHdr: { value: 2.2 },
      },
    }));
    const barGeo = own(new THREE.PlaneGeometry(bb.w, bb.h).rotateY(Math.PI));
    const bar = new THREE.Mesh(barGeo, this.barMat);
    bar.position.copy(bb.center);
    this.group.add(bar);

    // --- EV charger LED -------------------------------------------------------------------
    this.chargerMat = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.3, 0.1) }));
    const led = new THREE.Mesh(own(new THREE.SphereGeometry(0.035, 8, 6)), this.chargerMat);
    led.position.copy(hs.chargerLed).add(new THREE.Vector3(0, 0.12, -0.02));
    this.group.add(led);

    // --- car --------------------------------------------------------------------------------
    this.car = new Car(hs, HOUSE_STYLE[index].car);
    this.group.add(this.car.group, this.car.cable);

    // --- billboards ---------------------------------------------------------------------------
    this.label = new LabelSprite(POLICY_COLOR[index === 0 ? 'mpc' : 'dp']);
    this.label.sprite.position.copy(hs.labelAnchor);
    this.battGauge = new GaugeSprite();
    this.battGauge.sprite.position.copy(hs.tagAnchor.batt).add(new THREE.Vector3(0, 0.62, 0));
    this.evGauge = new GaugeSprite();
    this.evGauge.sprite.position.copy(hs.carPark).add(new THREE.Vector3(0, 2.6, 0));
    this.group.add(this.label.sprite, this.battGauge.sprite, this.evGauge.sprite);
  }

  /** Re-aims things that follow the camera or the car; call once per frame after update(). */
  update(f: HouseFrame, dt: number, lamps: number, night: number, time: number, snap: boolean, simSpeed: number): void {
    const s = this.s;
    if (snap || this.firstFrame) {
      s.pv = f.pvKw; s.load = f.loadKw; s.soc = f.socFrac; s.evFrac = f.evFrac; s.evKw = f.evKw; s.batt = f.battKw;
      this.firstFrame = false;
    } else {
      s.pv = damp(s.pv, finite(f.pvKw), 0.25, dt);
      s.load = damp(s.load, finite(f.loadKw), 0.25, dt);
      s.soc = damp(s.soc, finite(f.socFrac, 0.5), 0.3, dt);
      s.evFrac = damp(s.evFrac, finite(f.evFrac), 0.3, dt);
      s.evKw = damp(s.evKw, finite(f.evKw), 0.25, dt);
      s.batt = damp(s.batt, finite(f.battKw), 0.25, dt);
    }

    // panels: warm glow and a slow shimmer proportional to generation
    const pvN = clamp01(s.pv / 6);
    this.panelMat.emissiveIntensity = pvN * (0.5 + 0.06 * Math.sin(time * 2.1)) * 0.42;

    // windows: warm at night, brightness loosely follows the household load
    const loadN = clamp01((s.load - 0.2) / 3.2);
    const main = lamps * (0.55 + 0.9 * loadN);
    this.glassMats[0].emissiveIntensity = main * 1.6;
    this.glassMats[1].emissiveIntensity = lamps * (0.15 + 0.95 * loadN * loadN) * 1.5;
    void night;

    // battery bar
    const u = this.barMat.uniforms;
    const soc = clamp01(s.soc);
    u.uFill.value = soc;
    u.uTime.value = time;
    const mode = smoothstep(0.06, 0.3, Math.abs(s.batt)) * Math.sign(s.batt);
    u.uMode.value = mode;
    const col = u.uColor.value as THREE.Color;
    const goal = s.batt > 0.06 ? C_CHARGE : s.batt < -0.06 ? C_DISCH : C_IDLE;
    col.lerp(goal, 1 - Math.exp(-dt / 0.15));
    col.lerp(C_LOW, 0.7 * (1 - smoothstep(0.08, 0.2, soc)));
    const socShown = Math.abs(soc - clamp01(finite(f.socFrac, 0.5))) < 0.008 ? clamp01(finite(f.socFrac, 0.5)) : soc;
    this.battGauge.set('BATTERY', socShown, cssOf(goal === C_IDLE ? C_IDLE : goal));
    this.battGauge.setOpacity(0.92);

    // car
    const dur = simSpeed > 1.5 ? 3.4 : 5.5;
    const st = this.car.update(dt, f.evPresent, snap, lamps, dur);
    this.docked = st.docked;
    this.carMoving = st.moving;
    const evOn = st.docked > 0.5 && s.evKw > 0.05;
    const pulse = 0.65 + 0.35 * Math.sin(time * 5);
    if (evOn) this.chargerMat.color.setRGB(C_EV.r * 2.6 * pulse, C_EV.g * 2.6 * pulse, C_EV.b * 2.6 * pulse);
    else if (st.docked > 0.5) this.chargerMat.color.setRGB(0.05, 0.9, 0.3);
    else this.chargerMat.color.setRGB(0.25, 0.25, 0.28);
    const pl = this.car.portLedMat.color;
    if (evOn) pl.setRGB(C_EV.r * 3 * pulse, C_EV.g * 3 * pulse, C_EV.b * 3 * pulse);
    else pl.setRGB(0.05, 0.05, 0.06);
    this.car.portLed.visible = this.car.group.visible;

    const evT = clamp01(finite(f.evFrac));
    this.evGauge.set('EV', Math.abs(s.evFrac - evT) < 0.008 ? evT : s.evFrac, '#a974ff');
    this.evGauge.setOpacity(0.92 * st.docked);
    const cp = this.car.group.position;
    this.evGauge.sprite.position.set(cp.x, 2.6, cp.z);
    // label text and accent
    this.label.set(f.label || (f.policy === 'mpc' ? 'MPC' : 'DP'));
    this.label.setOpacity(1);
  }

  dispose(): void {
    this.car.dispose();
    this.label.dispose();
    this.battGauge.dispose();
    this.evGauge.dispose();
    for (const o of this.owned) o.dispose();
  }
}
