import * as THREE from 'three';
import { SHADOW } from './layout';
import { clamp, clamp01, DEG, lerp, rng, smoothstep } from './util';

/**
 * Sky, sun / moon, stars, clouds, distant hills and the scene lighting.
 * Everything is a pure function of (sun direction, cloud cover): no history.
 */

interface Key {
  el: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
  exposure: number;
}

const K = (
  el: number, zen: number, hor: number, hs: number, hg: number, hemiI: number, exposure: number,
): Key => ({
  el,
  zenith: new THREE.Color(zen),
  horizon: new THREE.Color(hor),
  hemiSky: new THREE.Color(hs),
  hemiGround: new THREE.Color(hg),
  hemiI,
  exposure,
});

// Sun elevation (deg) -> palette. Night, twilight, sunrise/sunset, golden hour, day.
const KEYS: Key[] = [
  K(-18, 0x04070f, 0x0a1222, 0x4a62a0, 0x161c28, 0.95, 1.35),
  K(-10, 0x070d22, 0x15213f, 0x4b66a8, 0x1a2030, 1.0, 1.32),
  K(-5, 0x112150, 0x4a4a7c, 0x6a80bc, 0x2a2a32, 1.18, 1.25),
  K(-1, 0x21407f, 0xc98468, 0x9ca0c6, 0x4a3c36, 1.35, 1.18),
  K(3, 0x3160ac, 0xedb78c, 0xbcc6e0, 0x6a604a, 1.5, 1.12),
  K(9, 0x3a74c9, 0xd9d3d2, 0xc6d6ee, 0x6e7452, 1.5, 0.98),
  K(20, 0x3474cf, 0xb9d5f0, 0xcfe0f7, 0x66714f, 1.34, 0.88),
  K(50, 0x2a66c6, 0xb0d0f2, 0xd2e3f8, 0x68744f, 1.26, 0.84),
];

const SUN_KEYS: [number, THREE.Color][] = [
  [-2, new THREE.Color(0xff5a22)],
  [1, new THREE.Color(0xff7a38)],
  [5, new THREE.Color(0xffa055)],
  [11, new THREE.Color(0xffc98c)],
  [22, new THREE.Color(0xffe9cb)],
  [45, new THREE.Color(0xfff7ec)],
];

export class EnvState {
  sunDir = new THREE.Vector3(0, 1, 0);
  moonDir = new THREE.Vector3(0, 1, 0);
  sunEl = 45;
  cloud = 0;
  /** 0 = day .. 1 = full night. */
  night = 0;
  /** 0..1: artificial lights (windows, lamps) switched on. */
  lamps = 0;
  /** 0..1: how much direct sunlight reaches the ground. */
  sunStrength = 1;
  keyDir = new THREE.Vector3(0, 1, 0);
  keyColor = new THREE.Color(1, 1, 1);
  keyIntensity = 3;
  /** True while the key light is the moon. */
  keyIsMoon = false;
  sunColor = new THREE.Color(1, 1, 1);
  hemiSky = new THREE.Color();
  hemiGround = new THREE.Color();
  hemiIntensity = 1;
  zenith = new THREE.Color();
  horizon = new THREE.Color();
  fog = new THREE.Color();
  exposure = 1;
  bloom = 0.5;
  glow = 1;
  dusk = 0;
  moon = 0;
  stars = 0;
  disc = 1;
}

const _grey = new THREE.Color();

export function computeEnv(sunDirIn: THREE.Vector3, cloudIn: number, out: EnvState): void {
  const cloud = clamp01(cloudIn);
  out.cloud = cloud;
  out.sunDir.copy(sunDirIn).normalize();
  const el = Math.asin(clamp(out.sunDir.y, -1, 1)) / DEG;
  out.sunEl = el;

  // palette
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp01((el - a.el) / (b.el - a.el));
  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = lerp(a.hemiI, b.hemiI, t);
  out.exposure = lerp(a.exposure, b.exposure, t);

  let j = 0;
  while (j < SUN_KEYS.length - 2 && el > SUN_KEYS[j + 1][0]) j++;
  const st = clamp01((el - SUN_KEYS[j][0]) / (SUN_KEYS[j + 1][0] - SUN_KEYS[j][0]));
  out.sunColor.copy(SUN_KEYS[j][1]).lerp(SUN_KEYS[j + 1][1], st);

  out.night = smoothstep(2, -9, el);
  out.lamps = smoothstep(5.5, -2.5, el);
  const day = smoothstep(-1.5, 10, el);

  // Clouds: direct light falls steeply, diffuse light a little; everything greys out.
  const direct = 1 - 0.86 * Math.pow(cloud, 1.15);
  out.sunStrength = day * direct;
  const diffuse = 1 - 0.42 * cloud;
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const greyTo = (c: THREE.Color, amount: number, dim: number): void => {
    const l = lum(c);
    _grey.setRGB(l, l, l * 1.04);
    c.lerp(_grey, amount).multiplyScalar(dim);
  };
  greyTo(out.zenith, 0.8 * cloud, 1 - 0.38 * cloud);
  greyTo(out.horizon, 0.72 * cloud, 1 - 0.3 * cloud);
  greyTo(out.hemiSky, 0.6 * cloud, 1);
  out.hemiIntensity *= diffuse;
  out.fog.copy(out.horizon);

  // Moon: roughly opposite the sun, lifted so it lights the street-facing walls.
  out.moonDir.set(-out.sunDir.x, Math.abs(out.sunDir.y) * 0.75 + 0.3, -out.sunDir.z).normalize();
  out.moon = smoothstep(0.5, -6, el) * (1 - 0.75 * cloud);
  out.stars = smoothstep(-3.5, -12, el) * (1 - 0.9 * cloud);
  out.glow = smoothstep(-6, 4, el) * (1 - 0.8 * cloud);
  out.dusk = smoothstep(-13, -3, el) * (1 - smoothstep(3, 15, el)) * (1 - 0.75 * cloud);
  out.disc = (1 - cloud) * (1 - cloud) * smoothstep(-2.5, 0.5, el);

  // One shadow-casting key light: the sun by day, the moon at night. The switch
  // happens while both are at zero intensity, so nothing pops.
  const sunI = 3.15 * out.sunStrength;
  const moonI = 1.25 * smoothstep(-2.6, -8.5, el) * (1 - 0.55 * cloud);
  if (el > -2.0) {
    out.keyIsMoon = false;
    // keep the shadow direction off the horizon so shadows stay finite
    const minEl = 7 * DEG;
    const y = Math.max(out.sunDir.y, Math.sin(minEl));
    const h = Math.hypot(out.sunDir.x, out.sunDir.z) || 1e-6;
    const hs = Math.sqrt(Math.max(0, 1 - y * y)) / h;
    out.keyDir.set(out.sunDir.x * hs, y, out.sunDir.z * hs).normalize();
    out.keyColor.copy(out.sunColor);
    out.keyIntensity = sunI;
  } else {
    out.keyIsMoon = true;
    out.keyDir.copy(out.moonDir);
    out.keyColor.setRGB(0.56, 0.7, 1.0);
    out.keyIntensity = moonI;
  }

  out.bloom = lerp(0.42, 0.85, out.night);
  // overcast: slightly lift exposure back so the scene dims but does not die
}

// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uDuskColor;
uniform float uGlow;
uniform float uDusk;
uniform float uMoon;
uniform float uCloud;
uniform float uDisc;
varying vec3 vDir;

float hash(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float k = pow(1.0 - clamp(h, 0.0, 1.0), 5.0);
  vec3 col = mix(uZenith, uHorizon, k);

  // warm band hugging the horizon towards the sun around sunrise / sunset
  vec2 sd = normalize(uSunDir.xz + vec2(1e-5, 0.0));
  vec2 dd = normalize(d.xz + vec2(1e-5, 0.0));
  float toward = pow(0.5 + 0.5 * dot(sd, dd), 2.2);
  float band = pow(1.0 - clamp(abs(h), 0.0, 1.0), 9.0) * toward;
  col = mix(col, uDuskColor, clamp(band * uDusk, 0.0, 1.0));

  float cs = dot(d, uSunDir);
  float csp = max(cs, 0.0);
  float halo = pow(csp, 18.0) * 0.16 + pow(csp, 160.0) * 0.5;
  col += uSunColor * halo * uGlow;

  // overcast: grey and flatten
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(vec3(luma), col, 0.2), uCloud * 0.55);

  float disc = smoothstep(0.99968, 0.99982, cs);
  col += uSunColor * disc * uDisc;

  float cm = dot(d, uMoonDir);
  float cmp = max(cm, 0.0);
  float mdisc = smoothstep(0.99972, 0.99984, cm);
  float mhalo = pow(cmp, 400.0) * 0.22 + pow(cmp, 40.0) * 0.045;
  col += vec3(0.78, 0.85, 1.0) * (mdisc * 1.9 + mhalo) * uMoon;

  col = mix(col, uBelow, smoothstep(0.0, -0.035, h));
  col += (hash(gl_FragCoord.xy) - 0.5) * (1.6 / 255.0);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STAR_VERT = /* glsl */ `
attribute float aMag;
attribute float aPhase;
uniform float uPx;
uniform float uTime;
uniform float uAmt;
varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 dir = normalize(wp.xyz - cameraPosition);
  float tw = 0.82 + 0.18 * sin(uTime * (1.5 + aPhase * 2.0) + aPhase * 40.0);
  vA = uAmt * aMag * tw * smoothstep(0.0, 0.10, dir.y);
  gl_PointSize = uPx * (1.1 + 2.3 * aMag);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const STAR_FRAG = /* glsl */ `
varying float vA;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float a = smoothstep(1.0, 0.15, r) * vA;
  gl_FragColor = vec4(vec3(0.86, 0.92, 1.0) * a * 1.7, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const HILL_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aHaze;
varying vec3 vColor;
varying float vHaze;
void main() {
  vColor = aColor;
  vHaze = aHaze;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HILL_FRAG = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uHaze;
varying vec3 vColor;
varying float vHaze;
void main() {
  vec3 c = mix(vColor * uLight, uHaze, vHaze);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface CloudPuff {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  threshold: number;
  baseScale: THREE.Vector3;
}

export class Environment {
  readonly group = new THREE.Group();
  readonly state = new EnvState();
  readonly keyLight: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private skyMat: THREE.ShaderMaterial;
  private dome: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private hillMat: THREE.ShaderMaterial;
  private clouds: CloudPuff[] = [];
  private cloudGroup = new THREE.Group();
  private cloudWhite = new THREE.Color(0xffffff);
  private cloudGrey = new THREE.Color(0x8f98a3);
  private readonly _c = new THREE.Color();
  private lastKeyDir = new THREE.Vector3();
  /** Set when the shadow map must be re-rendered. */
  shadowDirty = true;

  constructor() {
    // --- sky dome -----------------------------------------------------------
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uBelow: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uDuskColor: { value: new THREE.Color(0xff6f3c) },
        uGlow: { value: 1 },
        uDusk: { value: 0 },
        uMoon: { value: 0 },
        uCloud: { value: 0 },
        uDisc: { value: 1 },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), this.skyMat);
    this.dome.renderOrder = -20;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // --- stars (equatorial frame, rotated by sidereal time) ---------------
    const r = rng(1234);
    const starPos: number[] = [];
    const starMag: number[] = [];
    const starPhase: number[] = [];
    const R = 8000;
    const addStar = (raH: number, decDeg: number, mag: number): void => {
      const ra = (raH / 24) * Math.PI * 2, dec = decDeg * DEG;
      starPos.push(R * Math.cos(dec) * Math.cos(ra), R * Math.cos(dec) * Math.sin(ra), R * Math.sin(dec));
      starMag.push(mag);
      starPhase.push(r());
    };
    for (let i = 0; i < 1500; i++) {
      const z = r() * 2 - 1;
      const ra = r() * 24;
      // most stars faint, a few bright
      const m = Math.pow(r(), 3.2);
      addStar(ra, Math.asin(z) / DEG, 0.16 + 0.6 * m);
    }
    // A denser band standing in for the Milky Way (roughly through Crux and Carina).
    for (let i = 0; i < 700; i++) {
      const u = r() * Math.PI * 2;
      const w = (r() + r() + r() - 1.5) * 0.16;
      // great circle tilted ~62 deg to the celestial equator
      const x = Math.cos(u), y = Math.sin(u) * Math.cos(1.09) - w * Math.sin(1.09), z = Math.sin(u) * Math.sin(1.09) + w * Math.cos(1.09);
      const len = Math.hypot(x, y, z);
      const dec = Math.asin(z / len) / DEG;
      const ra = ((Math.atan2(y, x) / (Math.PI * 2)) * 24 + 24 + 12.4) % 24;
      addStar(ra, dec, 0.1 + 0.25 * Math.pow(r(), 2));
    }
    // Southern Cross + the Pointers, Canopus, Sirius, Achernar: the Christchurch night sky.
    const bright: [number, number, number][] = [
      [12.443, -63.1, 1.0], [12.795, -59.69, 0.95], [12.519, -57.11, 0.9], [12.252, -58.75, 0.7], [12.356, -60.4, 0.45],
      [14.66, -60.83, 1.0], [14.064, -60.37, 0.95], [6.4, -52.7, 1.0], [6.752, -16.72, 1.0], [1.628, -57.24, 0.9],
      [5.242, -8.2, 0.9], [5.919, 7.41, 0.85], [5.604, -1.2, 0.7], [5.679, -1.94, 0.7], [5.533, -0.3, 0.7],
    ];
    for (const [ra, dec, m] of bright) addStar(ra, dec, m);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    sg.setAttribute('aMag', new THREE.Float32BufferAttribute(starMag, 1));
    sg.setAttribute('aPhase', new THREE.Float32BufferAttribute(starPhase, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: false,
      uniforms: { uPx: { value: 1 }, uTime: { value: 0 }, uAmt: { value: 0 } },
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -15;
    this.stars.matrixAutoUpdate = false;
    this.group.add(this.stars);

    // --- distant hills ------------------------------------------------------
    this.hillMat = new THREE.ShaderMaterial({
      vertexShader: HILL_VERT,
      fragmentShader: HILL_FRAG,
      fog: false,
      side: THREE.DoubleSide,
      uniforms: { uLight: { value: new THREE.Color(1, 1, 1) }, uHaze: { value: new THREE.Color() } },
    });
    const hills = new THREE.Mesh(buildHills(), this.hillMat);
    hills.frustumCulled = false;
    hills.renderOrder = -10;
    this.group.add(hills);

    // --- clouds -------------------------------------------------------------
    this.buildClouds();
    this.group.add(this.cloudGroup);

    // --- lights -------------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.group.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -SHADOW.radius;
    sc.right = SHADOW.radius;
    sc.top = SHADOW.radius;
    sc.bottom = -SHADOW.radius;
    sc.near = 20;
    sc.far = 190;
    sc.updateProjectionMatrix();
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.045;
    key.shadow.radius = 2.2;
    key.target.position.copy(SHADOW.center);
    this.group.add(key, key.target);
    this.keyLight = key;
  }

  private buildClouds(): void {
    const r = rng(99);
    // three puff shapes shared by all clouds
    const shapes: THREE.BufferGeometry[] = [];
    for (let s = 0; s < 4; s++) {
      const parts: number[] = [];
      const n = 6 + Math.floor(r() * 4);
      const ico = new THREE.IcosahedronGeometry(1, 1);
      const p = ico.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : i / (n - 1) - 0.5;
        const cx = u * 1.7 + (r() - 0.5) * 0.25;
        const rad = (0.42 + 0.3 * r()) * (1 - 0.9 * u * u);
        const cy = rad * 0.55 + (r() - 0.5) * 0.08;
        const cz = (r() - 0.5) * 0.5;
        for (let k = 0; k < p.count; k++) {
          v.fromBufferAttribute(p, k);
          // flat bottoms: squash the lower half
          const yy = v.y < 0 ? v.y * 0.35 : v.y * 0.8;
          parts.push(cx + v.x * rad * 1.25, cy + yy * rad, cz + v.z * rad);
        }
      }
      ico.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(parts, 3));
      g.computeVertexNormals();
      shapes.push(g);
    }
    const N = 26;
    const order = Array.from({ length: N }, (_, i) => i);
    // shuffle thresholds so the first clouds to appear are scattered over the sky
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i < N; i++) {
      // azimuth: evenly spread with jitter; elevation: mostly low so they sit in the visible strip of sky
      const az = ((i + r() * 0.8) / N) * Math.PI * 2;
      const low = r() < 0.72;
      const el = (low ? 1.6 + r() * 5.0 : 8 + r() * 22) * DEG;
      const dist = 1500 + r() * 1300;
      const width = dist * (0.11 + r() * 0.12) * (low ? 1 : 1.5);
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        fog: false,
        flatShading: true,
      });
      const m = new THREE.Mesh(shapes[i % shapes.length], mat);
      const h = Math.cos(el) * dist;
      m.position.set(Math.sin(az) * h, Math.sin(el) * dist, -Math.cos(az) * h);
      m.rotation.y = -az + (r() - 0.5) * 0.5;
      const base = new THREE.Vector3(width * 0.5, width * 0.2 * (0.8 + 0.5 * r()), width * 0.3);
      m.scale.copy(base);
      m.visible = false;
      m.renderOrder = -8;
      m.frustumCulled = false;
      this.cloudGroup.add(m);
      this.clouds.push({ mesh: m, material: mat, threshold: 0.04 + (order[i] / N) * 0.8, baseScale: base });
    }
  }

  /**
   * @param sunDir smoothed unit sun direction
   * @param cloud smoothed cloud cover
   * @param clockH local clock hour (star rotation)
   */
  update(
    sunDir: THREE.Vector3, cloud: number, clockH: number, camera: THREE.Camera,
    time: number, dt: number, simSpeed: number, pixelRatio: number,
  ): void {
    const s = this.state;
    computeEnv(sunDir, cloud, s);

    const u = this.skyMat.uniforms;
    (u.uZenith.value as THREE.Color).copy(s.zenith);
    (u.uHorizon.value as THREE.Color).copy(s.horizon);
    (u.uBelow.value as THREE.Color).copy(s.fog);
    (u.uSunDir.value as THREE.Vector3).copy(s.sunDir);
    (u.uSunColor.value as THREE.Color).copy(s.sunColor);
    (u.uMoonDir.value as THREE.Vector3).copy(s.moonDir);
    u.uGlow.value = s.glow;
    u.uDusk.value = s.dusk;
    u.uMoon.value = s.moon;
    u.uCloud.value = s.cloud;
    u.uDisc.value = s.disc * 5.5;
    this.dome.position.copy(camera.position);

    // stars: equatorial -> horizontal for latitude -43.53, sidereal time ~ clock (12 Nov)
    this.starMat.uniforms.uAmt.value = s.stars;
    this.starMat.uniforms.uTime.value = time;
    this.starMat.uniforms.uPx.value = pixelRatio;
    this.stars.visible = s.stars > 0.003;
    if (this.stars.visible) {
      const lst = ((3.2 + clockH) / 24) * Math.PI * 2;
      const cL = Math.cos(lst), sL = Math.sin(lst);
      const phi = -43.53 * DEG;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      // rows: world x = east, y = up, z = -north
      this.stars.matrix.set(
        -sL, cL, 0, camera.position.x,
        cp * cL, cp * sL, sp, camera.position.y,
        sp * cL, sp * sL, -cp, camera.position.z,
        0, 0, 0, 1,
      );
      this.stars.matrixWorldNeedsUpdate = true;
    }

    // hills: lit by a cheap approximation of sky + sun, then hazed towards the horizon colour
    const light = this.hillMat.uniforms.uLight.value as THREE.Color;
    light.copy(s.hemiSky).multiplyScalar(s.hemiIntensity * 0.42);
    this._c.copy(s.keyColor).multiplyScalar(s.keyIntensity * 0.2);
    light.add(this._c);
    (this.hillMat.uniforms.uHaze.value as THREE.Color).copy(s.horizon);

    // clouds
    this.cloudGroup.rotation.y -= dt * (0.0022 + 0.0035 * Math.min(Math.max(simSpeed, 0), 2));
    this._c.copy(this.cloudWhite).lerp(this.cloudGrey, smoothstep(0.35, 1, s.cloud) * 0.85);
    for (const c of this.clouds) {
      const o = smoothstep(c.threshold - 0.05, c.threshold + 0.09, s.cloud);
      c.mesh.visible = o > 0.004;
      if (!c.mesh.visible) continue;
      c.material.opacity = o * 0.96;
      c.material.color.copy(this._c);
      c.material.emissive.copy(s.horizon).multiplyScalar(0.2);
      const k = (0.72 + 0.28 * o) * (0.9 + 0.55 * s.cloud);
      c.mesh.scale.copy(c.baseScale).multiplyScalar(k);
    }

    // lights
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    this.keyLight.color.copy(s.keyColor);
    this.keyLight.intensity = s.keyIntensity;
    this.keyLight.position.copy(SHADOW.center).addScaledVector(s.keyDir, 100);
    if (this.lastKeyDir.distanceToSquared(s.keyDir) > 1e-9) {
      this.lastKeyDir.copy(s.keyDir);
      this.shadowDirty = true;
    }
  }

  dispose(): void {
    this.keyLight.shadow.dispose();
  }
}

/** Layered silhouettes: suburban tree line, the Port Hills to the south, the Alps to the west. */
function buildHills(): THREE.BufferGeometry {
  const pos: number[] = [];
  const colr: number[] = [];
  const haze: number[] = [];
  const r = rng(4242);
  const noise = (seedCount: number): ((a: number) => number) => {
    const amps: number[] = [], freqs: number[] = [], phases: number[] = [];
    for (let i = 0; i < seedCount; i++) {
      freqs.push(Math.round(2 + i * 3.3 + r() * 2));
      amps.push(1 / (1 + i * 0.9));
      phases.push(r() * Math.PI * 2);
    }
    const norm = amps.reduce((s, x) => s + x, 0);
    return (a: number): number => {
      let v = 0;
      for (let i = 0; i < seedCount; i++) v += amps[i] * Math.sin(a * freqs[i] + phases[i]);
      return 0.5 + 0.5 * (v / norm);
    };
  };
  const bump = (az: number, centerDeg: number, halfWidthDeg: number): number => {
    let d = Math.abs(((az / DEG - centerDeg + 540) % 360) - 180);
    d = clamp01(1 - d / halfWidthDeg);
    return d * d * (3 - 2 * d);
  };
  const ring = (
    radius: number, steps: number, heightFn: (az: number) => number,
    colorFn: (az: number, h: number, top: boolean) => THREE.Color, hz: number,
  ): void => {
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2, a1 = ((i + 1) / steps) * Math.PI * 2;
      const h0 = heightFn(a0), h1 = heightFn(a1);
      if (h0 <= 0.5 && h1 <= 0.5) continue;
      const x0 = Math.sin(a0) * radius, z0 = -Math.cos(a0) * radius;
      const x1 = Math.sin(a1) * radius, z1 = -Math.cos(a1) * radius;
      const yb = -30;
      const cb0 = colorFn(a0, h0, false), ct0 = colorFn(a0, h0, true);
      const cb1 = colorFn(a1, h1, false), ct1 = colorFn(a1, h1, true);
      // two triangles, facing the origin
      pos.push(x0, yb, z0, x0, h0, z0, x1, h1, z1, x0, yb, z0, x1, h1, z1, x1, yb, z1);
      for (const c of [cb0, ct0, ct1, cb0, ct1, cb1]) colr.push(c.r, c.g, c.b);
      for (let k = 0; k < 6; k++) haze.push(hz);
    }
  };

  // Southern Alps, far west / north-west, snow on the tops
  const nAlps = noise(7);
  const rock = new THREE.Color(0x60708a), snow = new THREE.Color(0xf2f6fb);
  ring(5200, 420,
    (az) => 5200 * Math.tan(2.2 * DEG) * bump(az, 292, 62) * (0.45 + 0.75 * nAlps(az * 3.1)),
    (_az, h, top) => (top && h > 105 ? snow : rock).clone(), 0.74);

  // Port Hills to the south / south-east: dry tussock
  const nPort = noise(6);
  const tussockA = new THREE.Color(0x8d8656), tussockB = new THREE.Color(0x5f6a45);
  ring(3400, 360,
    (az) => 3400 * Math.tan(1.0 * DEG) * (0.28 + 0.3 * nPort(az * 1.7)) +
      3400 * Math.tan(2.25 * DEG) * bump(az, 172, 78) * (0.5 + 0.5 * nPort(az * 2.3 + 1.0)),
    (az, _h, top) => tussockB.clone().lerp(tussockA, top ? 0.3 + 0.7 * nPort(az * 5.0) : 0.15), 0.52);

  // near tree line
  const nTree = noise(9);
  const treeA = new THREE.Color(0x3f5a3c), treeB = new THREE.Color(0x2c4630);
  ring(1700, 360,
    (az) => 1700 * Math.tan(0.75 * DEG) * (0.25 + 0.75 * nTree(az * 4.0)),
    (az, _h, top) => treeB.clone().lerp(treeA, top ? nTree(az * 9.0) : 0.2), 0.32);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(colr, 3));
  g.setAttribute('aHaze', new THREE.Float32BufferAttribute(haze, 1));
  return g;
}
