import * as THREE from 'three';
import { GeoBatch, trs, v3, type UvFrame } from './geo';
import {
  DRIVE, EAVE_EDGE_Y, EAVE_EDGE_Z, HOUSE, HOUSE_STYLE, LOT, POLE, RIDGE_Y, SLOPE_LEN, STREET,
  roofPoint, toWorld, type HousePlacement,
} from './layout';
import { rng, jitter } from './util';

export type LinkKey = 'solar' | 'load' | 'ev' | 'batt' | 'grid';

/** Instanced box (picket, paling, baluster ...). */
export interface Slat {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  rotY: number;
  color: THREE.Color;
}

export interface Batches {
  /** Lambert, vertex colours, casts + receives shadows. */
  flat: GeoBatch;
  /** Weatherboard texture x vertex colour. */
  boards: GeoBatch;
  /** Corrugated iron texture x vertex colour. */
  roof: GeoBatch;
  /** Ground decals (lawn, concrete, asphalt): receive only, polygon offset. */
  ground: GeoBatch;
  /** Double-sided leaves. */
  foliage: GeoBatch;
  /** Thin dark cables / conduits, no shadows. */
  cables: GeoBatch;
  slats: Slat[];
}

export interface HouseStatic {
  placement: HousePlacement;
  /** Flow paths as sparse world-space polylines (rounded and resampled by the flow system). */
  paths: Record<LinkKey, THREE.Vector3[]>;
  tagAnchor: Record<LinkKey, THREE.Vector3>;
  labelAnchor: THREE.Vector3;
  /** Glass quads: [main rooms, secondary rooms]. */
  glass: [THREE.BufferGeometry, THREE.BufferGeometry];
  panelMatrices: THREE.Matrix4[];
  battBar: { center: THREE.Vector3; w: number; h: number };
  chargerLed: THREE.Vector3;
  porchLight: THREE.Vector3;
  /** Parked car position (world) and where its charge port is. */
  carPark: THREE.Vector3;
  port: THREE.Vector3;
  chargerPlug: THREE.Vector3;
}

const UP = v3(0, 1, 0);
const WALL_SV = 1 / 0.6;
const ROOF_SU = 1.0;

class GlassBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  constructor(private p: HousePlacement) {}
  /** Quad centred at local `c`, spanning `w` along tangent `t` and `h` up, facing `n` (local). */
  add(c: THREE.Vector3, t: THREE.Vector3, n: THREE.Vector3, w: number, h: number): void {
    const hw = w / 2, hh = h / 2;
    const corner = (su: number, sv: number): THREE.Vector3 => {
      const q = c.clone().addScaledVector(t, su * hw).addScaledVector(UP, sv * hh);
      return toWorld(this.p, q.x, q.y, q.z);
    };
    const a = corner(-1, -1), b = corner(1, -1), cc = corner(1, 1), d = corner(-1, 1);
    const wn = v3(n.x * this.p.flip, n.y, n.z);
    // winding so the face normal equals wn
    const e1 = b.clone().sub(a), e2 = d.clone().sub(a);
    const ccw = e1.cross(e2).dot(wn) > 0;
    const tris = ccw ? [a, b, cc, a, cc, d] : [a, cc, b, a, d, cc];
    const uvs = ccw ? [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1] : [0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1];
    for (const v of tris) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(wn.x, wn.y, wn.z);
    }
    this.uv.push(...uvs);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}

/** Sagging span between two points (parabola approximation of a catenary). */
export function sagSpan(a: THREE.Vector3, b: THREE.Vector3, sag: number, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    out.push(p);
  }
  return out;
}

export function buildHouse(b: Batches, p: HousePlacement): HouseStatic {
  const style = HOUSE_STYLE[p.index];
  const r = rng(100 + p.index * 17);
  const H = HOUSE;
  const { x0, x1, z0, z1, yBase: yB, yEave: yE } = H;
  const cx = (x0 + x1) / 2;
  const wallC = new THREE.Color(style.wall);
  const trim = new THREE.Color(style.trim);
  const roofC = new THREE.Color(style.roof);

  for (const batch of [b.flat, b.boards, b.roof, b.ground, b.foliage, b.cables]) batch.setMatrix(p.matrix);

  const wallUv = (eu: THREE.Vector3): UvFrame => ({ eu, ev: UP, su: 0.5, sv: WALL_SV });
  const X = v3(1, 0, 0), Z = v3(0, 0, 1);

  // ---- walls ---------------------------------------------------------------
  b.boards.quad(v3(x1, yB, z0), v3(x0, yB, z0), v3(x0, yE, z0), v3(x1, yE, z0), wallC, v3(0, 0, -1), wallUv(X));
  b.boards.quad(v3(x0, yB, z1), v3(x1, yB, z1), v3(x1, yE, z1), v3(x0, yE, z1), wallC, v3(0, 0, 1), wallUv(X));
  b.boards.quad(v3(x0, yB, z0), v3(x0, yB, z1), v3(x0, yE, z1), v3(x0, yE, z0), wallC, v3(-1, 0, 0), wallUv(Z));
  b.boards.quad(v3(x1, yB, z1), v3(x1, yB, z0), v3(x1, yE, z0), v3(x1, yE, z1), wallC, v3(1, 0, 0), wallUv(Z));
  b.boards.tri(v3(x0, yE, z0), v3(x0, yE, z1), v3(x0, RIDGE_Y, 0), wallC, v3(-1, 0, 0), wallUv(Z));
  b.boards.tri(v3(x1, yE, z1), v3(x1, yE, z0), v3(x1, RIDGE_Y, 0), wallC, v3(1, 0, 0), wallUv(Z));
  // foundation skirt
  b.flat.box(cx, yB / 2, 0, x1 - x0 - 0.08, yB, z1 - z0 - 0.08, style.base, { noBottom: true, noTop: true });
  // corner boards
  for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) {
    b.flat.box(px, (yB + yE) / 2, pz, 0.16, yE - yB, 0.16, trim, { noBottom: true, noTop: true });
  }
  // gable vents
  b.flat.box(x0 - 0.02, yE + 0.95, 0, 0.05, 0.5, 0.5, 0x4a5058);
  b.flat.box(x1 + 0.02, yE + 0.95, 0, 0.05, 0.5, 0.5, 0x4a5058);

  // ---- main roof -----------------------------------------------------------
  const xr0 = x0 - H.rake, xr1 = x1 + H.rake;
  const tanP = Math.tan(H.pitch);
  const nN = v3(0, Math.cos(H.pitch), -Math.sin(H.pitch));
  const nS = v3(0, Math.cos(H.pitch), Math.sin(H.pitch));
  const upN = v3(0, Math.sin(H.pitch), Math.cos(H.pitch)); // up-slope on the north face
  const upS = v3(0, Math.sin(H.pitch), -Math.cos(H.pitch));
  const sEdgeZ = z1 + H.overhang;
  b.roof.quad(v3(xr0, EAVE_EDGE_Y, EAVE_EDGE_Z), v3(xr1, EAVE_EDGE_Y, EAVE_EDGE_Z), v3(xr1, RIDGE_Y, 0), v3(xr0, RIDGE_Y, 0),
    roofC, nN, { eu: X, ev: upN, su: ROOF_SU, sv: 1 });
  b.roof.quad(v3(xr0, EAVE_EDGE_Y, sEdgeZ), v3(xr1, EAVE_EDGE_Y, sEdgeZ), v3(xr1, RIDGE_Y, 0), v3(xr0, RIDGE_Y, 0),
    roofC, nS, { eu: X, ev: upS, su: ROOF_SU, sv: 1 });
  // soffits (underside), slightly below the iron
  const th = 0.09;
  const soffit = trim.clone().multiplyScalar(0.82);
  b.flat.quad(v3(xr0, EAVE_EDGE_Y - th, EAVE_EDGE_Z), v3(xr1, EAVE_EDGE_Y - th, EAVE_EDGE_Z), v3(xr1, RIDGE_Y - th, 0), v3(xr0, RIDGE_Y - th, 0),
    soffit, nN.clone().negate());
  b.flat.quad(v3(xr0, EAVE_EDGE_Y - th, sEdgeZ), v3(xr1, EAVE_EDGE_Y - th, sEdgeZ), v3(xr1, RIDGE_Y - th, 0), v3(xr0, RIDGE_Y - th, 0),
    soffit, nS.clone().negate());
  // barge boards on both gable ends (double sided strips)
  const bargeH = 0.24;
  for (const bx of [xr0, xr1]) {
    for (const ez of [EAVE_EDGE_Z, sEdgeZ]) {
      const a = v3(bx, EAVE_EDGE_Y + 0.02, ez), c = v3(bx, RIDGE_Y + 0.02, 0);
      const a2 = v3(bx, EAVE_EDGE_Y + 0.02 - bargeH, ez), c2 = v3(bx, RIDGE_Y + 0.02 - bargeH, 0);
      b.flat.quad(a, c, c2, a2, trim, v3(1, 0, 0));
      b.flat.quad(a, c, c2, a2, trim, v3(-1, 0, 0));
    }
  }
  // fascia + gutters along both eaves, ridge cap
  for (const [ez, s] of [[EAVE_EDGE_Z, -1], [sEdgeZ, 1]] as const) {
    b.flat.box(cx, EAVE_EDGE_Y - 0.1, ez - s * 0.03, xr1 - xr0, 0.2, 0.05, trim);
    b.flat.box(cx, EAVE_EDGE_Y - 0.03, ez + s * 0.06, xr1 - xr0 + 0.1, 0.11, 0.13, 0xdfe3e6);
  }
  b.flat.box(cx, RIDGE_Y + 0.03, 0, xr1 - xr0 + 0.06, 0.09, 0.34, roofC.clone().multiplyScalar(0.8));

  // ---- veranda ---------------------------------------------------------------
  const vx0 = H.verandaX0, vx1 = x1, vz = H.verandaZ;
  const vcx = (vx0 + vx1) / 2, vlen = vx1 - vx0;
  const deck = 0x9a7650;
  b.flat.box(vcx, yB - 0.06, (z0 + vz) / 2, vlen, 0.12, z0 - vz, deck, { topColor: 0xa9855c });
  b.flat.box(vcx, (yB - 0.12) / 2, (z0 + vz) / 2 + 0.05, vlen - 0.1, yB - 0.12, z0 - vz - 0.1, style.base, { noBottom: true, noTop: true });
  const stepX = 4.9;
  b.flat.box(stepX, 0.06, vz - 0.33, 1.5, 0.12, 0.66, 0x8a8a86);
  b.flat.box(stepX, 0.18, vz - 0.16, 1.5, 0.12, 0.33, 0x8a8a86);
  const postY0 = yB, postY1 = 2.32;
  const postXs = [vx0 + 0.07, stepX - 0.85, stepX + 0.85, vx1 - 0.07];
  for (const px of postXs) {
    b.flat.box(px, (postY0 + postY1) / 2, vz + 0.07, 0.13, postY1 - postY0, 0.13, trim, { noBottom: true });
  }
  b.flat.box(vcx, postY1 + 0.08, vz + 0.07, vlen + 0.1, 0.16, 0.14, trim);
  // lean-to roof continuing the main slope at a shallow pitch
  const vrY0 = EAVE_EDGE_Y + 0.03, vrZ0 = EAVE_EDGE_Z + 0.12;
  const vrY1 = postY1 + 0.17, vrZ1 = vz - 0.22;
  const vrx0 = vx0 - 0.12, vrx1 = xr1;
  const vSlope = v3(0, vrY0 - vrY1, vrZ0 - vrZ1).normalize();
  const vN = v3(0, vSlope.z, -vSlope.y); // perpendicular, pointing up/out
  b.roof.quad(v3(vrx0, vrY1, vrZ1), v3(vrx1, vrY1, vrZ1), v3(vrx1, vrY0, vrZ0), v3(vrx0, vrY0, vrZ0),
    roofC, vN, { eu: X, ev: vSlope, su: ROOF_SU, sv: 1 });
  b.flat.quad(v3(vrx0, vrY1 - 0.07, vrZ1), v3(vrx1, vrY1 - 0.07, vrZ1), v3(vrx1, vrY0 - 0.07, vrZ0), v3(vrx0, vrY0 - 0.07, vrZ0),
    soffit, vN.clone().negate());
  b.flat.box((vrx0 + vrx1) / 2, vrY1 - 0.06, vrZ1 - 0.02, vrx1 - vrx0, 0.16, 0.05, trim);
  for (const sx of [vrx0, vrx1]) {
    b.flat.quad(v3(sx, vrY1, vrZ1), v3(sx, vrY0, vrZ0), v3(sx, vrY0 - 0.14, vrZ0), v3(sx, vrY1 - 0.14, vrZ1), trim, v3(1, 0, 0));
    b.flat.quad(v3(sx, vrY1, vrZ1), v3(sx, vrY0, vrZ0), v3(sx, vrY0 - 0.14, vrZ0), v3(sx, vrY1 - 0.14, vrZ1), trim, v3(-1, 0, 0));
  }
  // balustrade
  const railTop = yB + 0.88, railBot = yB + 0.12;
  const rail = (ax: number, az: number, bx: number, bz: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const rot = Math.atan2(-(bz - az), bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    b.flat.box(mx, railTop, mz, len, 0.07, 0.08, trim, { rotY: rot });
    b.flat.box(mx, railBot, mz, len, 0.05, 0.05, trim, { rotY: rot });
    const n = Math.max(1, Math.round(len / 0.14));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const lx = ax + (bx - ax) * t, lz = az + (bz - az) * t;
      const w = toWorld(p, lx, 0, lz);
      b.slats.push({ x: w.x, y: (railTop + railBot) / 2, z: w.z, sx: 0.035, sy: railTop - railBot, sz: 0.035, rotY: 0, color: trim });
    }
  };
  rail(postXs[0], vz + 0.07, postXs[1], vz + 0.07);
  rail(postXs[2], vz + 0.07, postXs[3], vz + 0.07);
  rail(postXs[3], vz + 0.07, postXs[3], z0);
  rail(postXs[0], vz + 0.07, postXs[0], z0);

  // ---- door + windows --------------------------------------------------------
  const glassMain = new GlassBuilder(p), glassAux = new GlassBuilder(p);
  const doorX = 3.6, doorW = 0.92, doorTop = 2.42;
  b.flat.box(doorX, (yB + doorTop) / 2, z0 - 0.035, doorW, doorTop - yB, 0.07, style.door, { noBottom: true });
  b.flat.box(doorX - doorW / 2 - 0.05, (yB + doorTop) / 2, z0 - 0.05, 0.1, doorTop - yB + 0.1, 0.1, trim);
  b.flat.box(doorX + doorW / 2 + 0.05, (yB + doorTop) / 2, z0 - 0.05, 0.1, doorTop - yB + 0.1, 0.1, trim);
  b.flat.box(doorX, doorTop + 0.05, z0 - 0.05, doorW + 0.2, 0.1, 0.1, trim);
  b.flat.box(doorX + 0.3, 1.4, z0 - 0.09, 0.05, 0.14, 0.05, 0xd8c690); // handle
  glassMain.add(v3(doorX, 1.95, z0 - 0.075), X, v3(0, 0, -1), 0.56, 0.5);

  /** Window with frame; `n` outward normal, `t` tangent along the wall. */
  const addWindow = (
    c: THREE.Vector3, t: THREE.Vector3, n: THREE.Vector3, w: number, h: number, glass: GlassBuilder, mullions = 2,
  ): void => {
    const f = 0.09;
    const out = c.clone().addScaledVector(n, 0.05);
    const boxAlong = (center: THREE.Vector3, lenT: number, lenY: number, depth: number, color: THREE.Color | number): void => {
      const sx = Math.abs(t.x) * lenT + Math.abs(n.x) * depth;
      const sz = Math.abs(t.z) * lenT + Math.abs(n.z) * depth;
      b.flat.box(center.x, center.y, center.z, sx, lenY, sz, color);
    };
    boxAlong(out.clone().addScaledVector(UP, h / 2 + f / 2), w + 2 * f, f, 0.1, trim);
    boxAlong(out.clone().addScaledVector(UP, -h / 2 - f / 2), w + 2 * f + 0.06, f, 0.14, trim);
    boxAlong(out.clone().addScaledVector(t, w / 2 + f / 2), f, h, 0.1, trim);
    boxAlong(out.clone().addScaledVector(t, -w / 2 - f / 2), f, h, 0.1, trim);
    for (let i = 1; i < mullions; i++) {
      boxAlong(out.clone().addScaledVector(t, -w / 2 + (w * i) / mullions), 0.05, h, 0.07, trim);
    }
    boxAlong(out.clone().addScaledVector(UP, h * 0.18), w, 0.045, 0.07, trim);
    glass.add(c.clone().addScaledVector(n, 0.035), t, n, w, h);
  };
  addWindow(v3(5.85, 1.62, z0), X, v3(0, 0, -1), 1.9, 1.3, glassMain, 3);
  addWindow(v3(x0, 1.85, -1.5), Z, v3(-1, 0, 0), 1.0, 0.95, glassMain, 2);
  addWindow(v3(x0, 1.7, 1.7), Z, v3(-1, 0, 0), 1.5, 1.2, glassAux, 2);
  addWindow(v3(x1, 1.7, -1.3), Z, v3(1, 0, 0), 1.5, 1.2, glassMain, 2);
  addWindow(v3(x1, 1.7, 1.8), Z, v3(1, 0, 0), 1.3, 1.2, glassAux, 2);
  addWindow(v3(0.4, 1.7, z1), X, v3(0, 0, 1), 1.5, 1.2, glassAux, 2);
  addWindow(v3(4.9, 1.7, z1), X, v3(0, 0, 1), 1.9, 1.2, glassMain, 3);

  // ---- equipment on the street-facing wall ------------------------------------
  const boardX = -1.1, boardY = 1.75;
  b.flat.box(boardX, boardY, z0 - 0.08, 0.6, 0.8, 0.16, 0xcfd5db);
  b.flat.box(boardX, boardY + 0.14, z0 - 0.165, 0.36, 0.26, 0.012, 0x1f2a33);
  b.flat.box(boardX + 0.2, boardY - 0.2, z0 - 0.165, 0.06, 0.12, 0.012, 0x59626c);
  const battX = 1.5, battY = 1.4;
  b.flat.box(battX, battY, z0 - 0.09, 0.8, 1.2, 0.18, 0xf1f3f5);
  b.flat.box(battX, battY - 0.63, z0 - 0.09, 0.7, 0.06, 0.14, 0x8d949c);
  b.flat.box(battX, battY, z0 - 0.183, 0.3, 1.0, 0.008, 0x14181d);
  const chgX = -2.0, chgY = 1.3;
  b.flat.box(chgX, chgY, z0 - 0.07, 0.36, 0.5, 0.14, 0x2a2f36);
  b.flat.box(chgX, chgY + 0.02, z0 - 0.143, 0.27, 0.36, 0.01, 0xe8ecf0);

  // ---- solar array: 2 rows x 8 portrait panels on the north slope -------------
  const panelMatrices: THREE.Matrix4[] = [];
  const pw = 1.0, pl = 1.65, gap = 0.035;
  const arrayCx = cx + 0.3;
  const tRow = [0.3, 0.3 + (pl + gap) / SLOPE_LEN];
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 8; i++) {
      const lx = arrayCx + (i - 3.5) * (pw + gap);
      const c = roofPoint(lx, tRow[row], 0.075);
      const w = toWorld(p, c.x, c.y, c.z);
      panelMatrices.push(trs(w.x, w.y, w.z, -H.pitch, 0, 0));
    }
  }
  // mounting rails under the panels
  for (const t of [tRow[0] - 0.1, tRow[0] + 0.1, tRow[1] - 0.1, tRow[1] + 0.1]) {
    const c = roofPoint(arrayCx, t, 0.035);
    b.flat.box(c.x, c.y, c.z, 8 * (pw + gap) + 0.1, 0.04, 0.05, 0x9aa1a8);
  }

  // ---- flow paths (lot-local, converted to world) ------------------------------
  const zf = z0 - 0.27;
  const L = (x: number, y: number, z: number): THREE.Vector3 => toWorld(p, x, y, z);
  const Lv = (v: THREE.Vector3): THREE.Vector3 => toWorld(p, v.x, v.y, v.z);
  const tMid = (tRow[0] + tRow[1]) / 2;
  const solar = [
    Lv(roofPoint(arrayCx + 3.4, tMid, 0.2)),
    Lv(roofPoint(boardX, tMid, 0.2)),
    Lv(roofPoint(boardX, 0.03, 0.2)),
    L(boardX, EAVE_EDGE_Y - 0.1, EAVE_EDGE_Z - 0.17),
    L(boardX, boardY + 0.42, zf),
  ];
  const poleTop = new THREE.Vector3(POLE.x + p.flip * 0.28 * (p.index === 0 ? 1 : 1), POLE.armY - 0.32, POLE.z + 0.05);
  const attach = L(-2.1, EAVE_EDGE_Y - 0.04, EAVE_EDGE_Z - 0.14);
  const grid = [
    ...sagSpan(poleTop, attach, 0.55, 22),
    L(-2.1, boardY + 0.22, zf),
    L(boardX - 0.31, boardY + 0.22, zf),
  ];
  const plug = L(chgX, chgY - 0.27, z0 - 0.2);
  const carPark = L(DRIVE.carX, 0, DRIVE.carZ);
  const port = L(DRIVE.carX + 0.93, 0.84, DRIVE.carZ + 1.25);
  const ev = [
    L(boardX - 0.31, boardY - 0.22, zf),
    L(chgX, boardY - 0.22, zf),
    plug,
    ...sagSpan(plug, port, 0.42, 14).slice(1),
  ];
  const batt = [L(boardX + 0.31, boardY - 0.1, zf), L(battX - 0.41, boardY - 0.1, zf)];
  const load = [
    L(boardX, boardY - 0.42, zf),
    L(boardX, 0.58, zf),
    L(doorX, 0.58, zf),
    L(doorX, 1.3, z0 - 0.14),
  ];

  // physical conduits / cables under the flows (the EV cable is dynamic and lives with the car)
  const conduit = (pts: THREE.Vector3[], radius: number, color: number): void => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.08);
    const g = new THREE.TubeGeometry(curve, Math.max(8, pts.length * 3), radius, 5, false);
    b.cables.setMatrix(null);
    b.cables.consume(g, null, color);
    b.cables.setMatrix(p.matrix);
  };
  conduit(sagSpan(poleTop, attach, 0.55, 22), 0.03, 0x15181c);
  conduit([attach, L(-2.1, boardY + 0.22, z0 - 0.05), L(boardX - 0.3, boardY + 0.22, z0 - 0.05)], 0.028, 0x8b9299);
  conduit([L(boardX, boardY + 0.4, z0 - 0.05), L(boardX, EAVE_EDGE_Y - 0.25, z0 - 0.05)], 0.028, 0x8b9299);
  conduit([L(boardX + 0.3, boardY - 0.1, z0 - 0.05), L(battX - 0.4, boardY - 0.1, z0 - 0.05)], 0.028, 0x8b9299);
  conduit([L(boardX - 0.3, boardY - 0.22, z0 - 0.05), L(chgX + 0.18, boardY - 0.22, z0 - 0.05)], 0.028, 0x8b9299);

  // ---- the lot ------------------------------------------------------------------
  const g = b.ground;
  const y1 = 0.02, y2 = 0.035;
  const lawn = new THREE.Color(p.index === 0 ? 0x5f9440 : 0x5a8f43);
  // lawn (lot minus the driveway) with mowing stripes
  const stripes = 9;
  const lx0 = DRIVE.x1 + 0.0, lx1 = LOT.halfW;
  for (let i = 0; i < stripes; i++) {
    const za = LOT.frontZ + ((LOT.backZ - LOT.frontZ) * i) / stripes;
    const zb = LOT.frontZ + ((LOT.backZ - LOT.frontZ) * (i + 1)) / stripes;
    const c = lawn.clone().multiplyScalar(i % 2 ? 1.0 : 0.9);
    g.quad(v3(lx0, y1, za), v3(lx1, y1, za), v3(lx1, y1, zb), v3(lx0, y1, zb), c, UP);
  }
  // planted strip between the driveway and the centre boundary
  g.quad(v3(-LOT.halfW, y1, LOT.frontZ), v3(DRIVE.x0, y1, LOT.frontZ), v3(DRIVE.x0, y1, LOT.backZ), v3(-LOT.halfW, y1, LOT.backZ),
    0x4f7f3a, UP);
  // driveway: from the kerb to past the house, lightly jointed concrete
  const dz0 = STREET.kerbZ, dz1 = 2.2;
  const slabs = 6;
  for (let i = 0; i < slabs; i++) {
    const za = dz0 + ((dz1 - dz0) * i) / slabs, zb = dz0 + ((dz1 - dz0) * (i + 1)) / slabs;
    g.quad(v3(DRIVE.x0, y2, za + 0.03), v3(DRIVE.x1, y2, za + 0.03), v3(DRIVE.x1, y2, zb - 0.03), v3(DRIVE.x0, y2, zb - 0.03),
      jitter(0xb9b6ae, 0.035, r), UP);
  }
  g.quad(v3(DRIVE.x0, y1 + 0.005, dz0), v3(DRIVE.x1, y1 + 0.005, dz0), v3(DRIVE.x1, y1 + 0.005, dz1), v3(DRIVE.x0, y1 + 0.005, dz1), 0x8f8c85, UP);
  // garden path from the gate to the veranda steps (pavers)
  const pathX = stepX;
  for (let i = 0; i < 6; i++) {
    const za = LOT.frontZ + 0.15 + i * 0.72;
    g.quad(v3(pathX - 0.5, y2, za), v3(pathX + 0.5, y2, za), v3(pathX + 0.5, y2, za + 0.62), v3(pathX - 0.5, y2, za + 0.62),
      jitter(0xa9a39a, 0.05, r), UP);
  }
  // garden bed along the front of the veranda and beside the steps
  g.quad(v3(vx0, y2, vz - 0.9), v3(stepX - 0.9, y2, vz - 0.9), v3(stepX - 0.9, y2, vz), v3(vx0, y2, vz), 0x4a3b2c, UP);
  g.quad(v3(stepX + 0.9, y2, vz - 0.9), v3(vx1 + 0.4, y2, vz - 0.9), v3(vx1 + 0.4, y2, vz), v3(stepX + 0.9, y2, vz), 0x4a3b2c, UP);

  // ---- fences ---------------------------------------------------------------------
  const picket = (ax: number, az: number, bx: number, bz: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.2) return;
    const rot = Math.atan2(-(bz - az), bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    b.flat.box(mx, 0.3, mz, len, 0.06, 0.04, trim, { rotY: rot });
    b.flat.box(mx, 0.72, mz, len, 0.06, 0.04, trim, { rotY: rot });
    const nPosts = Math.max(1, Math.round(len / 2.3));
    for (let i = 0; i <= nPosts; i++) {
      const t = i / nPosts;
      b.flat.box(ax + (bx - ax) * t, 0.52, az + (bz - az) * t, 0.1, 1.04, 0.1, trim, { noBottom: true });
    }
    const n = Math.max(1, Math.round(len / 0.135));
    // pickets sit on the street side of the rails
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const side = nz < 0 || (nz === 0 && nx > 0) ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const w = toWorld(p, ax + (bx - ax) * t + nx * side * 0.035, 0, az + (bz - az) * t + nz * side * 0.035);
      b.slats.push({ x: w.x, y: 0.5, z: w.z, sx: 0.075, sy: 0.9 + (i % 2) * 0.0, sz: 0.022, rotY: rot * p.flip, color: trim });
    }
  };
  const paling = (ax: number, az: number, bx: number, bz: number, h = 1.75): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const rot = Math.atan2(-(bz - az), bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    b.flat.box(mx, h * 0.3, mz, len, 0.07, 0.06, 0x6e5a44, { rotY: rot });
    b.flat.box(mx, h * 0.8, mz, len, 0.07, 0.06, 0x6e5a44, { rotY: rot });
    const n = Math.max(1, Math.round(len / 0.16));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const w = toWorld(p, ax + (bx - ax) * t, 0, az + (bz - az) * t);
      const hh = h + (r() - 0.5) * 0.05;
      b.slats.push({
        x: w.x, y: hh / 2, z: w.z, sx: 0.15, sy: hh, sz: 0.035, rotY: rot * p.flip,
        color: jitter(0x8a7257, 0.09, r),
      });
    }
  };
  const fz = LOT.frontZ;
  picket(DRIVE.x1 + 0.25, fz, pathX - 0.65, fz);
  picket(pathX + 0.65, fz, LOT.halfW, fz);
  picket(LOT.halfW, fz, LOT.halfW, z0 - 0.4);
  paling(LOT.halfW, z0 - 0.4, LOT.halfW, LOT.backZ);
  paling(-LOT.halfW, LOT.backZ, LOT.halfW, LOT.backZ);
  paling(-LOT.halfW, 2.3, x0, 2.3); // closes the back yard behind the driveway
  paling(-LOT.halfW + 0.02, 2.3, -LOT.halfW + 0.02, LOT.backZ);
  // gate posts
  b.flat.box(pathX - 0.65, 0.6, fz, 0.13, 1.2, 0.13, trim, { noBottom: true });
  b.flat.box(pathX + 0.65, 0.6, fz, 0.13, 1.2, 0.13, trim, { noBottom: true });

  // letterbox beside the driveway
  const lbx = DRIVE.x1 + 0.45, lbz = fz - 0.05;
  b.flat.box(lbx, 0.5, lbz, 0.09, 1.0, 0.09, 0x5d4a38, { noBottom: true });
  b.flat.box(lbx, 1.1, lbz, 0.42, 0.26, 0.3, style.door);
  b.flat.box(lbx, 1.25, lbz, 0.48, 0.05, 0.36, 0x33383e);
  b.flat.box(lbx, 1.1, lbz - 0.155, 0.2, 0.04, 0.01, 0x15181c);

  return {
    placement: p,
    paths: { solar, load, ev, batt, grid },
    tagAnchor: {
      solar: Lv(roofPoint(arrayCx - 0.4, tMid, 0.75)),
      grid: grid[9].clone().add(v3(0, 0.3, 0)),
      ev: L(DRIVE.carX, 1.72, DRIVE.carZ + 0.2),
      batt: L(battX, battY + 0.72, z0 - 0.3),
      load: L(doorX - 0.75, 0.78, zf - 0.05),
    },
    labelAnchor: L(cx, RIDGE_Y + 0.62, 0),
    glass: [glassMain.build(), glassAux.build()],
    panelMatrices,
    battBar: { center: L(battX, battY, z0 - 0.19), w: 0.24, h: 0.94 },
    chargerLed: L(chgX, chgY + 0.02, z0 - 0.152),
    porchLight: L(doorX + 0.9, 2.15, z0 - 0.9),
    carPark,
    port,
    chargerPlug: plug,
  };
}

// ---------------------------------------------------------------------------
// plants (shared helpers, used by house lots and the wider world)
// ---------------------------------------------------------------------------

/** Harakeke / NZ flax: a fan of long stiff blades. */
export function addFlax(b: Batches, x: number, z: number, scale: number, r: () => number, bronze = false): void {
  const blades = 16 + Math.floor(r() * 8);
  const base = new THREE.Color(bronze ? 0x6b4a3a : 0x4c7a3a);
  for (let i = 0; i < blades; i++) {
    const az = (i / blades) * Math.PI * 2 + r() * 0.5;
    const lean = 0.18 + r() * 0.75; // radians from vertical
    const len = (1.0 + r() * 0.8) * scale;
    const w = 0.085 * scale;
    const dir = v3(Math.sin(az) * Math.sin(lean), Math.cos(lean), Math.cos(az) * Math.sin(lean));
    const side = v3(Math.cos(az), 0, -Math.sin(az)).multiplyScalar(w);
    const root = v3(x + Math.sin(az) * 0.08 * scale, 0, z + Math.cos(az) * 0.08 * scale);
    const mid = root.clone().addScaledVector(dir, len * 0.6);
    // tip droops a little
    const tip = root.clone().addScaledVector(dir, len).add(v3(Math.sin(az) * len * 0.12, -len * 0.1 * lean, Math.cos(az) * len * 0.12));
    const c = jitter(base, 0.22, r);
    const c2 = c.clone().multiplyScalar(1.25);
    b.foliage.quad(root.clone().sub(side), root.clone().add(side), mid.clone().add(side), mid.clone().sub(side), c);
    b.foliage.tri(mid.clone().sub(side), mid.clone().add(side), tip, c2);
  }
}

/** Ti kouka / cabbage tree: bare trunk, a few branches, spiky leaf heads. */
export function addCabbageTree(b: Batches, x: number, z: number, h: number, r: () => number): void {
  const bark = 0x8b7c68;
  const trunkH = h * 0.62;
  b.flat.consume(new THREE.CylinderGeometry(0.13, 0.2, trunkH, 6, 1, true), trs(x, trunkH / 2, z), bark);
  const heads = 3;
  for (let i = 0; i < heads; i++) {
    const az = (i / heads) * Math.PI * 2 + r() * 0.8;
    const tilt = i === 0 ? 0.12 : 0.45 + r() * 0.2;
    const len = h * (i === 0 ? 0.3 : 0.24 + r() * 0.08);
    const dir = v3(Math.sin(az) * Math.sin(tilt), Math.cos(tilt), Math.cos(az) * Math.sin(tilt));
    const start = v3(x, trunkH - 0.1, z);
    const end = start.clone().addScaledVector(dir, len);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    b.flat.consume(new THREE.CylinderGeometry(0.075, 0.11, len, 5, 1, true), m, bark);
    // leaf head
    const n = 34;
    for (let k = 0; k < n; k++) {
      const u = r() * 2 - 0.55; // more leaves up than down
      const yy = Math.max(-0.75, Math.min(1, u));
      const a2 = r() * Math.PI * 2;
      const rad = Math.sqrt(Math.max(0, 1 - yy * yy));
      const ld = v3(Math.cos(a2) * rad, yy, Math.sin(a2) * rad);
      const ll = 0.85 + r() * 0.35;
      const side = new THREE.Vector3().crossVectors(ld, UP);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize().multiplyScalar(0.05);
      const tip = end.clone().addScaledVector(ld, ll);
      if (yy < 0) tip.y -= 0.25 * -yy; // old leaves hang
      const c = jitter(yy < -0.25 ? 0x8a8452 : 0x5d8a3e, 0.2, r);
      b.foliage.tri(end.clone().sub(side), end.clone().add(side), tip, c);
    }
  }
}

/** Rounded low-poly shrub / tree canopy blob. */
export function addBlob(b: Batches, x: number, y: number, z: number, rx: number, ry: number, rz: number, color: number, r: () => number): void {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const c = jitter(color, 0.12, r);
  const dark = c.clone().multiplyScalar(0.72);
  b.flat.consume(g, trs(x, y, z, 0, r() * 6.28, 0, rx, ry, rz), c, {
    colorFn: (pt, base) => (pt.y < -0.2 ? dark : base),
  });
}

export function addTree(b: Batches, x: number, z: number, h: number, r: () => number, color = 0x3f7a3a): void {
  const trunk = h * 0.42;
  b.flat.consume(new THREE.CylinderGeometry(0.1 * h * 0.3, 0.16 * h * 0.3, trunk, 6, 1, true), trs(x, trunk / 2, z), 0x6b5440);
  const rad = h * 0.34;
  addBlob(b, x, trunk + rad * 0.75, z, rad, rad * 0.9, rad, color, r);
  addBlob(b, x + rad * 0.55, trunk + rad * 0.5, z + rad * 0.2, rad * 0.62, rad * 0.55, rad * 0.62, color, r);
  addBlob(b, x - rad * 0.5, trunk + rad * 0.62, z - rad * 0.3, rad * 0.68, rad * 0.6, rad * 0.68, color, r);
}

/** Planting for one lot (kept separate so it can use the mirrored transform). */
export function plantLot(b: Batches, p: HousePlacement): void {
  const r = rng(555 + p.index * 31);
  for (const batch of [b.flat, b.foliage]) batch.setMatrix(p.matrix);
  const H = HOUSE;
  // flax along the centre strip, beside the driveway
  for (const z of [-9.4, -7.2, -0.6]) addFlax(b, -8.15 + (r() - 0.5) * 0.3, z, 0.9 + r() * 0.25, r, r() < 0.3);
  // garden bed in front of the veranda
  const vz = H.verandaZ - 0.45;
  addBlob(b, 3.1, 0.32, vz, 0.42, 0.34, 0.4, 0x3f7240, r);
  addBlob(b, 3.75, 0.26, vz + 0.05, 0.3, 0.26, 0.3, 0x7a9a4a, r);
  addFlax(b, 6.25, vz, 0.62, r, true);
  addBlob(b, 7.0, 0.36, vz, 0.46, 0.38, 0.44, 0x3a6b3c, r);
  addBlob(b, 7.55, 0.24, vz - 0.05, 0.26, 0.22, 0.26, 0xb86a7a, r); // something flowering
  // a cabbage tree in the outer front corner, flax at its feet
  addCabbageTree(b, 7.6, -8.6, 5.3, r);
  addFlax(b, 6.6, -9.3, 0.8, r);
  addFlax(b, 8.2, -7.4, 0.7, r, true);
  // by the letterbox
  addFlax(b, DRIVE.x1 + 1.3, LOT.frontZ + 0.6, 0.55, r);
  // back yard trees (visible over the fence through the gap between the houses)
  addTree(b, -7.4, 9.0, 4.4, r, 0x3b7038);
  addTree(b, 5.5, 7.8, 5.2, r, 0x4a7f3c);
  // hedge along the driveway side of the house
  for (let i = 0; i < 4; i++) addBlob(b, H.x0 - 0.5, 0.3, -1.6 + i * 0.95, 0.42, 0.34, 0.5, 0x356638, r);
}
