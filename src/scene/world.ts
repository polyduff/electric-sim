import * as THREE from 'three';
import { GeoBatch, trs, v3 } from './geo';
import {
  buildHouse, plantLot, addTree, addBlob, addFlax, sagSpan,
  type Batches, type HouseStatic, type Slat,
} from './house';
import { DRIVE, LOT, POLE, STREET, housePlacement } from './layout';
import {
  corrugatedTexture, grainTexture, radialTexture, weatherboardTexture,
} from './textures';
import { jitter, rng } from './util';

export interface Pool {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  base: number;
}

export interface World {
  group: THREE.Group;
  houses: [HouseStatic, HouseStatic];
  /** Light pools (street lamps etc.) scaled by the night factor. */
  pools: Pool[];
  /** Emissive lamp heads (street lamps), colour scaled by the night factor. */
  lampMats: THREE.MeshBasicMaterial[];
  porchMats: THREE.MeshBasicMaterial[];
  textures: THREE.Texture[];
}

function newBatches(): Batches {
  return {
    flat: new GeoBatch(),
    boards: new GeoBatch(),
    roof: new GeoBatch(),
    ground: new GeoBatch(),
    foliage: new GeoBatch(),
    cables: new GeoBatch(),
    slats: [],
  };
}

const UP = v3(0, 1, 0);

/** A plain neighbouring bungalow, facing the street (-Z). */
function simpleHouse(
  b: Batches, x: number, z: number, w: number, d: number, wall: number, roof: number, trim: number,
): void {
  const h = 2.65, y0 = 0.3, pitch = 27 * Math.PI / 180;
  const wallC = new THREE.Color(wall), roofC = new THREE.Color(roof);
  b.boards.setMatrix(null); b.roof.setMatrix(null); b.flat.setMatrix(null);
  const ridge = y0 + h + (d / 2) * Math.tan(pitch);
  b.boards.box(x, y0 + h / 2, z, w, h, d, wallC, { uv: { su: 0.5, sv: 1 / 0.6 }, noTop: true, noBottom: true });
  const ov = 0.45;
  const x0 = x - w / 2 - 0.3, x1 = x + w / 2 + 0.3;
  const zn = z - d / 2 - ov, zs = z + d / 2 + ov;
  const ye = y0 + h - ov * Math.tan(pitch);
  b.roof.quad(v3(x0, ye, zn), v3(x1, ye, zn), v3(x1, ridge, z), v3(x0, ridge, z), roofC, v3(0, 1, -0.5),
    { eu: v3(1, 0, 0), ev: v3(0, 0.5, 0.87), su: 1, sv: 1 });
  b.roof.quad(v3(x0, ye, zs), v3(x1, ye, zs), v3(x1, ridge, z), v3(x0, ridge, z), roofC, v3(0, 1, 0.5),
    { eu: v3(1, 0, 0), ev: v3(0, 0.5, -0.87), su: 1, sv: 1 });
  b.boards.tri(v3(x - w / 2, y0 + h, z - d / 2), v3(x - w / 2, y0 + h, z + d / 2), v3(x - w / 2, ridge, z), wallC, v3(-1, 0, 0));
  b.boards.tri(v3(x + w / 2, y0 + h, z + d / 2), v3(x + w / 2, y0 + h, z - d / 2), v3(x + w / 2, ridge, z), wallC, v3(1, 0, 0));
  // simple door + window blocks on the street face
  b.flat.box(x - w * 0.18, y0 + 1.05, z - d / 2 - 0.03, 0.9, 2.1, 0.06, 0x3c5a68);
  b.flat.box(x + w * 0.2, y0 + 1.5, z - d / 2 - 0.03, 1.8, 1.2, 0.06, 0x2a3a48);
  b.flat.box(x + w * 0.2, y0 + 1.5, z - d / 2 - 0.05, 1.98, 0.08, 0.06, trim);
  b.flat.box(x, y0 + 0.14, z, w + 0.1, 0.3, d + 0.1, 0x6d655c, { noTop: true });
}

function addPole(b: Batches, x: number, z: number): void {
  b.flat.setMatrix(null);
  b.flat.consume(new THREE.CylinderGeometry(0.1, 0.15, POLE.height, 8, 1, true), trs(x, POLE.height / 2, z), 0x6d5b49);
  b.flat.box(x, POLE.armY, z, 0.13, 0.13, 1.7, 0x5a4a3b);
  b.flat.box(x, POLE.armY - 0.35, z, 0.07, 0.7, 0.07, 0x5a4a3b, {});
  for (const dz of [-0.75, 0, 0.75]) {
    b.flat.box(x, POLE.armY + 0.12, z + dz, 0.08, 0.18, 0.08, 0xcfd6dd);
  }
}

function wire(b: Batches, a: THREE.Vector3, c: THREE.Vector3, sag: number, radius = 0.012): void {
  const pts = sagSpan(a, c, sag, 16);
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
  b.cables.setMatrix(null);
  b.cables.consume(new THREE.TubeGeometry(curve, 24, radius, 4, false), null, 0x17191c);
}

export function buildWorld(): World {
  const group = new THREE.Group();
  const textures: THREE.Texture[] = [];
  const keep = <T extends THREE.Texture>(t: T): T => { textures.push(t); return t; };
  const b = newBatches();
  const r = rng(77);

  // --- the two houses ---------------------------------------------------------
  const pl0 = housePlacement(0), pl1 = housePlacement(1);
  const h0 = buildHouse(b, pl0);
  const h1 = buildHouse(b, pl1);
  plantLot(b, pl0);
  plantLot(b, pl1);

  // --- street -------------------------------------------------------------------
  for (const bt of [b.flat, b.ground, b.cables, b.boards, b.roof, b.foliage]) bt.setMatrix(null);
  const g = b.ground;
  const X0 = -420, X1 = 420;
  const yRoad = 0.012;
  g.quad(v3(X0, yRoad, STREET.roadZ0), v3(X1, yRoad, STREET.roadZ0), v3(X1, yRoad, STREET.roadZ1), v3(X0, yRoad, STREET.roadZ1), 0x4b4e54, UP);
  const zc = (STREET.roadZ0 + STREET.roadZ1) / 2;
  for (let x = -60; x < 60; x += 6) {
    g.quad(v3(x, yRoad + 0.006, zc - 0.07), v3(x + 3, yRoad + 0.006, zc - 0.07), v3(x + 3, yRoad + 0.006, zc + 0.07), v3(x, yRoad + 0.006, zc + 0.07), 0xd9d6c4, UP);
  }
  for (const z of [STREET.roadZ0 + 0.35, STREET.roadZ1 - 0.3]) {
    g.quad(v3(X0, yRoad + 0.006, z - 0.06), v3(X1, yRoad + 0.006, z - 0.06), v3(X1, yRoad + 0.006, z + 0.06), v3(X0, yRoad + 0.006, z + 0.06), 0xc9c8bc, UP);
  }
  // footpath with joints
  g.quad(v3(X0, 0.018, STREET.footpathZ0), v3(X1, 0.018, STREET.footpathZ0), v3(X1, 0.018, STREET.footpathZ1), v3(X0, 0.018, STREET.footpathZ1), 0xa8a59d, UP);
  for (let x = -60; x < 60; x += 1.5) {
    g.quad(v3(x, 0.024, STREET.footpathZ0), v3(x + 0.03, 0.024, STREET.footpathZ0), v3(x + 0.03, 0.024, STREET.footpathZ1), v3(x, 0.024, STREET.footpathZ1), 0x8c8982, UP);
  }
  // kerb
  b.flat.box(0, 0.07, STREET.kerbZ - 0.07, 840, 0.14, 0.16, 0xb4b2aa);

  // --- power poles + lines -----------------------------------------------------------
  const poleXs = [0, -27, 27];
  for (const px of poleXs) addPole(b, px, POLE.z);
  for (const dz of [-0.75, 0, 0.75]) {
    const top = (x: number): THREE.Vector3 => v3(x, POLE.armY + 0.24, POLE.z + dz);
    wire(b, top(0), top(27), 0.5);
    wire(b, top(0), top(-27), 0.5);
    wire(b, top(27), top(75), 0.6);
    wire(b, top(-27), top(-75), 0.6);
  }
  // street luminaire on the central pole
  const lampEnd = v3(0, 7.05, POLE.z - 1.6);
  b.flat.consume(new THREE.CylinderGeometry(0.035, 0.045, 1.7, 5, 1, true),
    new THREE.Matrix4().compose(v3(0, 6.95, POLE.z - 0.8), new THREE.Quaternion().setFromUnitVectors(UP, v3(0, 0.07, -1).normalize()), v3(1, 1, 1)), 0x555a60);
  b.flat.box(lampEnd.x, lampEnd.y, lampEnd.z, 0.9, 0.12, 0.36, 0x6a7077);
  const lampGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.05, 0.05) });
  lampGlow.toneMapped = true;

  // --- neighbours and backdrop ------------------------------------------------------
  simpleHouse(b, 30.5, 0.5, 10, 8, 0xd9c9a3, 0x586a5c, 0xf2f0e8);
  simpleHouse(b, -30.5, 0.2, 10, 8, 0xb7c8b2, 0x7d4a3c, 0xf2f0e8);
  simpleHouse(b, 52, 0.5, 10, 8, 0xc7b8a6, 0x4b525c, 0xf2f0e8);
  simpleHouse(b, -52, 0.3, 10, 8, 0xe3d9c0, 0x6a3b32, 0xf2f0e8);
  for (const [x, z] of [[-34, 24], [-14, 25], [8, 24], [29, 25], [48, 24], [-50, 25]] as [number, number][]) {
    simpleHouse(b, x, z, 11, 8.5, jitter(0xcfc4b0, 0.1, r).getHex(), jitter(0x5e5148, 0.35, r).getHex(), 0xf2f0e8);
  }
  b.flat.setMatrix(null); b.foliage.setMatrix(null);
  for (const [x, z, h] of [
    [-24, 8.5, 6], [22, 9, 5.6], [-39, -3, 6.5], [39.5, -2, 6], [-45, 10, 7.2], [46, 11, 6.5],
    [-20, 16, 7], [4, 17, 8], [26, 16, 6.8], [-4, 15, 6.2], [42, 17, 7.4], [-35, 17, 6.6],
  ] as [number, number, number][]) {
    addTree(b, x, z, h, r, jitter(0x3f7a3a, 0.2, r).getHex());
  }
  for (const [x, z] of [[-26, -9], [26.5, -9], [-41, -9], [41, -9], [37, -4], [-37, -3]] as [number, number][]) {
    addFlax(b, x, z, 0.85, r, r() < 0.3);
    addBlob(b, x + 0.9, 0.4, z + 0.4, 0.5, 0.4, 0.5, 0x3c6c3a, r);
  }
  // hedges + fences on the neighbouring front boundaries
  for (const [x0, x1] of [[18.2, 38], [-38, -18.2], [38, 60], [-60, -38]] as [number, number][]) {
    for (let x = x0; x < x1; x += 1.3) addBlob(b, x, 0.42, LOT.frontZ + 0.4, 0.7, 0.42, 0.45, 0x3b6a3a, r);
  }

  // --- materials -----------------------------------------------------------------------
  const boardTex = keep(weatherboardTexture());
  const roofTex = keep(corrugatedTexture());
  const grain = keep(grainTexture());
  grain.repeat.set(240, 240);

  const flatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const boardMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: boardTex });
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: roofTex, roughness: 0.5, metalness: 0.12 });
  const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const foliageMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const cableMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  group.add(b.flat.mesh(flatMat, { name: 'flat' }));
  group.add(b.boards.mesh(boardMat, { name: 'boards' }));
  group.add(b.roof.mesh(roofMat, { name: 'roof' }));
  group.add(b.ground.mesh(groundMat, { cast: false, receive: true, name: 'ground' }));
  group.add(b.foliage.mesh(foliageMat, { name: 'foliage' }));
  group.add(b.cables.mesh(cableMat, { cast: false, receive: false, name: 'cables' }));

  // base lawn
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(1800, 1800).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x78a152, map: grain }),
  );
  lawn.receiveShadow = true;
  group.add(lawn);

  // instanced slats (pickets, balusters, palings)
  const slats: Slat[] = b.slats;
  const slatMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), slats.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  slats.forEach((sl, i) => {
    q.setFromEuler(e.set(0, sl.rotY, 0));
    m4.compose(p.set(sl.x, sl.y, sl.z), q, s.set(sl.sx, sl.sy, sl.sz));
    slatMesh.setMatrixAt(i, m4);
    slatMesh.setColorAt(i, sl.color);
  });
  slatMesh.instanceMatrix.needsUpdate = true;
  if (slatMesh.instanceColor) slatMesh.instanceColor.needsUpdate = true;
  slatMesh.castShadow = true;
  slatMesh.receiveShadow = true;
  group.add(slatMesh);

  // street lamp head (emissive)
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.28), lampGlow);
  lamp.position.set(lampEnd.x, lampEnd.y - 0.09, lampEnd.z);
  group.add(lamp);

  // --- light pools + porch lights ------------------------------------------------------
  const poolTex = keep(radialTexture());
  const pools: Pool[] = [];
  const porchMats: THREE.MeshBasicMaterial[] = [];
  const addPool = (x: number, y: number, z: number, size: number, color: number, base: number): void => {
    const mat = new THREE.MeshBasicMaterial({
      map: poolTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, opacity: 0,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat);
    m.position.set(x, y, z);
    m.renderOrder = 2;
    group.add(m);
    pools.push({ mesh: m, material: mat, base });
  };
  addPool(0, 0.05, -15.2, 13, 0xffc680, 0.5);
  addPool(0, 0.05, -11.5, 7, 0xffc680, 0.2);
  for (const hs of [h0, h1]) {
    addPool(hs.porchLight.x, 0.4, hs.porchLight.z + 0.2, 4.2, 0xffcf8a, 0.45);
    const pm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.05, 0.05) });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), pm);
    bulb.position.copy(hs.porchLight);
    group.add(bulb);
    porchMats.push(pm);
  }

  return { group, houses: [h0, h1], pools, lampMats: [lampGlow], porchMats, textures };
}

export { DRIVE };
