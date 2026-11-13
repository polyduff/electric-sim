import * as THREE from 'three';

/**
 * World convention (docs/spec.md): +Y up, +X east, -Z north. The street runs
 * east-west on the NORTH side of the section; houses face it. The default camera
 * stands north of the street looking south (+Z), so +X (east) is on screen LEFT.
 *
 * House 0 (MPC) sits at +X = screen left, house 1 (DP) at -X = screen right.
 * The two lots are mirror images so both driveways, EVs, chargers and
 * switchboards meet in the middle of the picture, next to the shared power pole.
 */

export const DEGR = Math.PI / 180;

export const LOT = {
  halfW: 9, // each lot is 18 m wide
  frontZ: -10.5, // street boundary (picket fence)
  backZ: 10.5, // back fence
};

export const HOUSE = {
  x0: -2.4, // local x of the wall next to the driveway
  x1: 7.2,
  z0: -3.6, // north (street) wall
  z1: 3.6,
  yBase: 0.35,
  yEave: 3.0,
  pitch: 30 * DEGR,
  overhang: 0.45,
  rake: 0.4,
  verandaX0: 2.6,
  verandaZ: -5.6,
};

export const RIDGE_Y = HOUSE.yEave + HOUSE.z1 * Math.tan(HOUSE.pitch);
export const EAVE_EDGE_Y = HOUSE.yEave - HOUSE.overhang * Math.tan(HOUSE.pitch);
export const EAVE_EDGE_Z = HOUSE.z0 - HOUSE.overhang;

export const DRIVE = { x0: -7.0, x1: -3.8, carX: -5.4, carZ: -4.5 };

export const STREET = {
  footpathZ0: -12.0,
  footpathZ1: -10.75,
  kerbZ: -13.4,
  roadZ0: -20.6,
  roadZ1: -13.55,
  laneZ: -15.25, // west-bound lane (NZ drives on the left)
};

export const POLE = { x: 0, z: -12.7, height: 7.0, armY: 6.55 };

/** Centre of the area the sun shadow frustum is fitted to, and its radius. */
export const SHADOW = { center: new THREE.Vector3(0, 0, -4.5), radius: 27.5 };

export interface HousePlacement {
  index: 0 | 1;
  /** World x of the lot centre. */
  cx: number;
  /** +1 = as designed, -1 = mirrored in x. */
  flip: 1 | -1;
  matrix: THREE.Matrix4;
}

export function housePlacement(index: 0 | 1): HousePlacement {
  const flip = index === 0 ? 1 : -1;
  const cx = index === 0 ? LOT.halfW : -LOT.halfW;
  const matrix = new THREE.Matrix4().makeScale(flip, 1, 1).setPosition(cx, 0, 0);
  return { index, cx, flip, matrix };
}

/** Lot-local point to world. */
export function toWorld(p: HousePlacement, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(p.cx + p.flip * x, y, z);
}

/**
 * Point on the north roof slope. `t` = 0 at the eave edge .. 1 at the ridge,
 * `off` = distance above the roof surface.
 */
export function roofPoint(x: number, t: number, off = 0): THREE.Vector3 {
  const z = EAVE_EDGE_Z + t * (0 - EAVE_EDGE_Z);
  const y = EAVE_EDGE_Y + t * (RIDGE_Y - EAVE_EDGE_Y);
  const ny = Math.cos(HOUSE.pitch), nz = -Math.sin(HOUSE.pitch);
  return new THREE.Vector3(x, y + ny * off, z + nz * off);
}

export const SLOPE_LEN = (0 - EAVE_EDGE_Z) / Math.cos(HOUSE.pitch);

/** Link colours: consistent everywhere (tubes, particles, tags). */
export const LINK_COLOR = {
  solar: 0xffb224,
  load: 0xeef2ff,
  ev: 0xa974ff,
  batt: 0x22d3ee,
  gridImport: 0xff5a36,
  gridExport: 0x3ee07f,
};

/** Accent colours matching the UI's policy colours. */
export const POLICY_COLOR: Record<string, string> = { mpc: '#ff9a3d', dp: '#4cc3ff' };

export const HOUSE_STYLE = [
  // House 0 (MPC): warm cream weatherboards, red-oxide iron roof
  { wall: 0xe6d7b4, roof: 0x9a3f31, trim: 0xf6f2e8, door: 0x2f6f73, base: 0x6d655c, car: 0x2f7f9f },
  // House 1 (DP): cool blue-grey weatherboards, charcoal iron roof
  { wall: 0xa9bfce, roof: 0x444d57, trim: 0xf4f6f8, door: 0xc98a2b, base: 0x5c6066, car: 0xc65a43 },
];
