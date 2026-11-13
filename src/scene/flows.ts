import * as THREE from 'three';
import type { HouseStatic, LinkKey } from './house';
import { LINK_COLOR } from './layout';
import { TagSprite } from './labels';
import { clamp, clamp01, damp, dampK, lerp, rng, smoothstep } from './util';

export const LINK_KEYS: LinkKey[] = ['solar', 'load', 'ev', 'batt', 'grid'];
const KW_FULL = 7;
const POOL_CAP = 56;

const css = (hex: number): string => '#' + hex.toString(16).padStart(6, '0');

/** Round the corners of a sparse polyline and resample it at a uniform spacing. */
export function roundedPath(points: THREE.Vector3[], radius: number, step: number): THREE.Vector3[] {
  const dense: THREE.Vector3[] = [points[0].clone()];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], p = points[i], c = points[i + 1];
    const la = a.distanceTo(p), lc = c.distanceTo(p);
    const rr = Math.min(radius, la / 2.05, lc / 2.05);
    const p0 = p.clone().addScaledVector(a.clone().sub(p).normalize(), rr);
    const p1 = p.clone().addScaledVector(c.clone().sub(p).normalize(), rr);
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      // quadratic Bezier p0 -> p -> p1
      const q = p0.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(p, 2 * t * (1 - t)).addScaledVector(p1, t * t);
      dense.push(q);
    }
  }
  dense.push(points[points.length - 1].clone());
  // resample by arc length
  const cum: number[] = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dense[i].distanceTo(dense[i - 1]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(total / step));
  const out: THREE.Vector3[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    out.push(dense[j].clone().lerp(dense[j + 1], clamp01((s - cum[j]) / seg)));
  }
  return out;
}

const TUBE_VERT = /* glsl */ `
attribute vec3 aDir;
attribute float aS;
uniform float uRadius;
varying vec3 vDir;
varying float vS;
varying vec3 vWorld;
void main() {
  vec3 p = position + aDir * uRadius;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vDir = normalize(mat3(modelMatrix) * aDir);
  vS = aS;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const TUBE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uPhase;
uniform float uLen;
varying vec3 vDir;
varying float vS;
varying vec3 vWorld;
void main() {
  float ends = smoothstep(0.0, 0.3, vS) * smoothstep(0.0, 0.3, uLen - vS);
  vec3 V = normalize(cameraPosition - vWorld);
  float core = pow(clamp(abs(dot(normalize(vDir), V)), 0.0, 1.0), 0.8);
  float stripe = 0.5 + 0.5 * sin((vS - uPhase) * 6.2832 / 0.85);
  float a = uAlpha * ends * (0.22 + 0.5 * core) * (0.5 + 0.5 * stripe);
  gl_FragColor = vec4(uColor * a, a);
}`;

const PART_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
attribute float aSize;
uniform float uScale;
varying vec3 vC;
varying float vA;
void main() {
  vC = aColor;
  vA = aAlpha;
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.5, aSize * uScale / max(0.1, -mv.z));
}`;

const PART_FRAG = /* glsl */ `
varying vec3 vC;
varying float vA;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float core = pow(clamp(1.0 - r, 0.0, 1.0), 1.5);
  float a = core * vA;
  gl_FragColor = vec4(vC * a, a);
}`;

interface Flow {
  key: LinkKey;
  house: number;
  len: number;
  step: number;
  n: number;
  pts: Float32Array;
  n1: Float32Array;
  n2: Float32Array;
  tube: THREE.Mesh;
  tubeMat: THREE.ShaderMaterial;
  tag: TagSprite;
  tagAnchor: THREE.Vector3;
  // dynamics
  target: number;
  kw: number;
  phase: number;
  acc: number;
  tagOpacity: number;
  tagClock: number;
  tagShown: number;
  /** Colour currently in use (smoothed for the grid import/export switch). */
  color: THREE.Color;
  tubeColor: THREE.Color;
  // particle pool (metres along the path)
  pm: Float32Array;
  pseed: Float32Array;
  pc: number;
  weight: number;
}

const COLORS = {
  solar: new THREE.Color(LINK_COLOR.solar),
  load: new THREE.Color(LINK_COLOR.load),
  ev: new THREE.Color(LINK_COLOR.ev),
  batt: new THREE.Color(LINK_COLOR.batt),
  gridImport: new THREE.Color(LINK_COLOR.gridImport),
  gridExport: new THREE.Color(LINK_COLOR.gridExport),
};

const TAG_CSS = {
  solar: css(LINK_COLOR.solar), load: css(LINK_COLOR.load), ev: css(LINK_COLOR.ev), batt: css(LINK_COLOR.batt),
  gridImport: css(LINK_COLOR.gridImport), gridExport: css(LINK_COLOR.gridExport),
};

export class FlowSystem {
  readonly group = new THREE.Group();
  private flows: Flow[] = [];
  private points: THREE.Points;
  private pMat: THREE.ShaderMaterial;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pAlpha: Float32Array;
  private pSize: Float32Array;
  private geo = new THREE.BufferGeometry();
  private rand = rng(31337);

  constructor(houses: HouseStatic[]) {
    houses.forEach((hs, hi) => {
      for (const key of LINK_KEYS) this.flows.push(this.makeFlow(hs, hi, key));
    });
    const cap = this.flows.length * POOL_CAP;
    this.pPos = new Float32Array(cap * 3);
    this.pCol = new Float32Array(cap * 3);
    this.pAlpha = new Float32Array(cap);
    this.pSize = new Float32Array(cap);
    const posA = new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage);
    const colA = new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage);
    const alA = new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage);
    const szA = new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', posA);
    this.geo.setAttribute('aColor', colA);
    this.geo.setAttribute('aAlpha', alA);
    this.geo.setAttribute('aSize', szA);
    this.geo.setDrawRange(0, 0);
    this.pMat = new THREE.ShaderMaterial({
      vertexShader: PART_VERT,
      fragmentShader: PART_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: { uScale: { value: 600 } },
    });
    this.points = new THREE.Points(this.geo, this.pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.group.add(this.points);
  }

  private makeFlow(hs: HouseStatic, house: number, key: LinkKey): Flow {
    const raw = hs.paths[key];
    const rad = key === 'grid' ? 0.35 : key === 'solar' ? 0.4 : 0.14;
    const path = roundedPath(raw, rad, 0.1);
    const n = path.length;
    const pts = new Float32Array(n * 3);
    const n1 = new Float32Array(n * 3);
    const n2 = new Float32Array(n * 3);
    const cum = new Float32Array(n);
    const t = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), ref = new THREE.Vector3(0, 1, 0);
    let prev = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      pts[i * 3] = path[i].x; pts[i * 3 + 1] = path[i].y; pts[i * 3 + 2] = path[i].z;
      if (i > 0) cum[i] = cum[i - 1] + path[i].distanceTo(path[i - 1]);
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      t.subVectors(path[i1], path[i0]).normalize();
      if (i === 0) {
        a.crossVectors(t, ref);
        if (a.lengthSq() < 1e-4) a.crossVectors(t, new THREE.Vector3(1, 0, 0));
        a.normalize();
      } else {
        a.copy(prev).addScaledVector(t, -prev.dot(t)).normalize();
      }
      b.crossVectors(t, a).normalize();
      n1[i * 3] = a.x; n1[i * 3 + 1] = a.y; n1[i * 3 + 2] = a.z;
      n2[i * 3] = b.x; n2[i * 3 + 1] = b.y; n2[i * 3 + 2] = b.z;
      prev = a.clone();
    }
    const len = cum[n - 1];
    const RS = 6;
    const pos = new Float32Array(n * RS * 3);
    const dir = new Float32Array(n * RS * 3);
    const sA = new Float32Array(n * RS);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < RS; k++) {
        const ang = (k / RS) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
        const o = (i * RS + k) * 3;
        pos[o] = pts[i * 3]; pos[o + 1] = pts[i * 3 + 1]; pos[o + 2] = pts[i * 3 + 2];
        dir[o] = n1[i * 3] * c + n2[i * 3] * s;
        dir[o + 1] = n1[i * 3 + 1] * c + n2[i * 3 + 1] * s;
        dir[o + 2] = n1[i * 3 + 2] * c + n2[i * 3 + 2] * s;
        sA[i * RS + k] = cum[i];
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < RS; k++) {
        const k2 = (k + 1) % RS;
        const a0 = i * RS + k, a1 = i * RS + k2, b0 = (i + 1) * RS + k, b1 = (i + 1) * RS + k2;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aS', new THREE.BufferAttribute(sA, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(path[Math.floor(n / 2)].clone(), len + 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: TUBE_VERT,
      fragmentShader: TUBE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      uniforms: {
        uColor: { value: new THREE.Color() },
        uAlpha: { value: 0 },
        uPhase: { value: 0 },
        uLen: { value: len },
        uRadius: { value: 0.03 },
      },
    });
    const tube = new THREE.Mesh(g, mat);
    tube.frustumCulled = false;
    tube.renderOrder = 6;
    tube.visible = false;
    this.group.add(tube);
    const tag = new TagSprite(TAG_CSS[key === 'grid' ? 'gridImport' : key]);
    this.group.add(tag.sprite);
    const color = (key === 'grid' ? COLORS.gridImport : COLORS[key]).clone();
    return {
      key, house, len, step: len / (n - 1), n, pts, n1, n2, tube, tubeMat: mat, tag,
      tagAnchor: hs.tagAnchor[key].clone(), target: 0, kw: 0, phase: 0, acc: 0, tagOpacity: 0, tagClock: 1, tagShown: 0,
      color, tubeColor: color.clone(),
      pm: new Float32Array(POOL_CAP), pseed: new Float32Array(POOL_CAP), pc: 0, weight: 1,
    };
  }

  private flow(house: number, key: LinkKey): Flow {
    return this.flows[house * LINK_KEYS.length + LINK_KEYS.indexOf(key)];
  }

  /** Signed kW towards the end of the path (see house.ts for each path's direction). */
  setTarget(house: number, key: LinkKey, kw: number): void {
    this.flow(house, key).target = Number.isFinite(kw) ? kw : 0;
  }

  /** 0..1 gate for a flow (e.g. the EV cable is only live while the car is docked). */
  setWeight(house: number, key: LinkKey, w: number): void {
    this.flow(house, key).weight = clamp01(w);
  }

  /** Jump the smoothed values (used for the first frame and when time jumps). */
  snap(): void {
    for (const f of this.flows) {
      f.kw = f.target;
      f.tagShown = f.target * f.weight;
      f.tagClock = 1;
      f.tagOpacity = Math.abs(f.tagShown) >= 0.05 ? 1 : 0;
      f.color.copy(f.key === 'grid' ? (f.kw >= 0 ? COLORS.gridImport : COLORS.gridExport) : COLORS[f.key]);
    }
  }

  setViewport(heightPx: number, fovDeg: number, pixelRatio: number): void {
    this.pMat.uniforms.uScale.value = (heightPx * pixelRatio) / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  update(dt: number, _time: number): void {
    const out = { n: 0 };
    for (const f of this.flows) this.updateFlow(f, dt, out);
    this.geo.setDrawRange(0, out.n);
    for (const name of ['position', 'aColor', 'aAlpha', 'aSize']) {
      (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private updateFlow(f: Flow, dt: number, out: { n: number }): void {
    f.kw = damp(f.kw, f.target, 0.28, dt);
    const mag = Math.abs(f.kw) * f.weight;
    const fwd = f.kw >= 0 ? 1 : -1;
    const fr = Math.pow(clamp01(mag / KW_FULL), 0.6);
    const gate = smoothstep(0.02, 0.22, mag);

    // colour (grid flips between import and export)
    const goal = f.key === 'grid' ? (f.kw >= 0 ? COLORS.gridImport : COLORS.gridExport) : COLORS[f.key];
    f.color.lerp(goal, dampK(0.12, dt));

    // tube
    f.tube.visible = gate > 0.003;
    const u = f.tubeMat.uniforms;
    u.uAlpha.value = gate * 0.95;
    u.uRadius.value = 0.03 + 0.075 * fr;
    f.tubeColor.copy(f.color).multiplyScalar(1.5);
    (u.uColor.value as THREE.Color).copy(f.tubeColor);
    // transit time and number of particles in flight both scale with power
    const T = lerp(5.5, 1.8, fr);
    const speed = f.len / T;
    f.phase += fwd * speed * dt;
    u.uPhase.value = f.phase;

    // particles: advance, retire, spawn
    const inFlight = lerp(3, 20, fr) * (0.55 + 0.45 * Math.min(f.len, 10) / 10);
    const rate = (inFlight / T) * (mag > 0.015 ? 1 : 0);
    f.acc += rate * dt;
    if (f.acc > 6) f.acc = 6;
    const move = fwd * speed * dt;
    let w = 0;
    for (let i = 0; i < f.pc; i++) {
      const m = f.pm[i] + move;
      if (m < 0 || m > f.len) continue;
      f.pm[w] = m;
      f.pseed[w] = f.pseed[i];
      w++;
    }
    f.pc = w;
    while (f.acc >= 1 && f.pc < POOL_CAP) {
      f.acc -= 1;
      // spawn with a random sub-frame offset so spawns do not bunch up on frame boundaries
      const off = this.rand() * speed * dt;
      f.pm[f.pc] = fwd > 0 ? off : f.len - off;
      f.pseed[f.pc] = this.rand();
      f.pc++;
    }
    if (f.acc >= 1) f.acc = 0;

    // write into the shared buffers
    const sizeW = 0.09 + 0.2 * fr;
    const rLat = (0.03 + 0.075 * fr) * 0.55;
    const hdr = 3.6;
    for (let i = 0; i < f.pc; i++) {
      if (out.n >= this.pAlpha.length) break;
      const m = f.pm[i];
      const sFloat = m / f.step;
      const i0 = Math.min(f.n - 2, Math.max(0, Math.floor(sFloat)));
      const fr2 = clamp(sFloat - i0, 0, 1);
      const a0 = i0 * 3, a1 = a0 + 3;
      const sd = f.pseed[i];
      const ang = sd * 6.2832 * 7.0, rad = rLat * (0.2 + 0.8 * Math.sqrt((sd * 13.7) % 1));
      const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad;
      const o = out.n * 3;
      for (let k = 0; k < 3; k++) {
        const p = f.pts[a0 + k] + (f.pts[a1 + k] - f.pts[a0 + k]) * fr2;
        const n1 = f.n1[a0 + k], n2 = f.n2[a0 + k];
        this.pPos[o + k] = p + n1 * ca + n2 * sa;
      }
      const edge = smoothstep(0, 0.3, m) * smoothstep(0, 0.3, f.len - m);
      const tw = 0.8 + 0.2 * Math.sin(f.phase * 2 + sd * 30);
      this.pAlpha[out.n] = gate * edge * tw;
      this.pSize[out.n] = sizeW * (0.8 + 0.4 * sd);
      this.pCol[o] = f.color.r * hdr;
      this.pCol[o + 1] = f.color.g * hdr;
      this.pCol[o + 2] = f.color.b * hdr;
      out.n++;
    }

    // tag: number is refreshed at most ~8x/s and settles exactly on the target
    f.tagClock += dt;
    if (f.tagClock >= 0.125) {
      f.tagClock = 0;
      const settled = Math.abs(f.kw - f.target) < 0.05;
      f.tagShown = (settled ? f.target : f.kw) * f.weight;
    }
    const absShown = Math.abs(f.tagShown);
    const text1 = `${absShown.toFixed(1)} kW`;
    const printable = text1 !== '0.0 kW';
    const showTag = printable && mag > 0.04;
    f.tagOpacity = showTag ? damp(f.tagOpacity, 1, 0.15, dt) : printable ? damp(f.tagOpacity, 0, 0.15, dt) : 0;
    if (f.tagOpacity > 0.01) {
      let line2 = '';
      let cs = TAG_CSS[f.key === 'grid' ? 'gridImport' : f.key];
      const sgn = f.tagShown >= 0;
      if (f.key === 'grid') { line2 = sgn ? 'IMPORT' : 'EXPORT'; cs = sgn ? TAG_CSS.gridImport : TAG_CSS.gridExport; }
      else if (f.key === 'batt') line2 = sgn ? 'CHARGING' : 'DISCHARGING';
      else if (f.key === 'solar') line2 = 'SOLAR';
      else if (f.key === 'ev') line2 = 'EV CHARGE';
      else if (f.key === 'load') line2 = 'HOME';
      f.tag.set(text1, line2, cs);
      f.tag.sprite.position.copy(f.tagAnchor);
      f.tag.sprite.scale.set(f.tag.worldH * (256 / 112), f.tag.worldH, 1);
    }
    f.tag.setOpacity(f.tagOpacity * 0.96);
  }

  dispose(): void {
    for (const f of this.flows) {
      f.tube.geometry.dispose();
      f.tubeMat.dispose();
      f.tag.dispose();
    }
    this.geo.dispose();
    this.pMat.dispose();
  }
}
