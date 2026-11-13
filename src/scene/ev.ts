import * as THREE from 'three';
import type { HouseStatic } from './house';
import { STREET } from './layout';
import { clamp01, damp, smoothstep } from './util';

/** A polyline in the XZ plane (y = 0) sampled by arc-length fraction. */
class Poly {
  private cum: number[] = [0];
  constructor(readonly pts: THREE.Vector2[]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  get length(): number { return this.cum[this.cum.length - 1]; }
  /** Position and unit tangent at arc-length fraction s in 0..1. */
  at(s: number, pos: THREE.Vector2, tan: THREE.Vector2): void {
    const d = clamp01(s) * this.length;
    let i = 0;
    while (i < this.cum.length - 2 && this.cum[i + 1] < d) i++;
    const seg = this.cum[i + 1] - this.cum[i] || 1;
    const t = (d - this.cum[i]) / seg;
    pos.lerpVectors(this.pts[i], this.pts[i + 1], clamp01(t));
    tan.subVectors(this.pts[i + 1], this.pts[i]).normalize();
  }
  fractionAt(index: number): number { return this.cum[index] / this.length; }
}

function curve(a: THREE.Vector2, ctrl: THREE.Vector2, b: THREE.Vector2, n = 14): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push(new THREE.Vector2(
      (1 - t) * (1 - t) * a.x + 2 * t * (1 - t) * ctrl.x + t * t * b.x,
      (1 - t) * (1 - t) * a.y + 2 * t * (1 - t) * ctrl.y + t * t * b.y,
    ));
  }
  return out;
}

const FAR = 40;

export interface CarState {
  /** 0 = away .. 1 = parked. */
  presence: number;
  moving: boolean;
  /** 1 only once the car is stationary in the driveway: the cable is connected. */
  docked: number;
}

export class Car {
  readonly group = new THREE.Group();
  readonly cable: THREE.Mesh;
  readonly portLed: THREE.Mesh;
  readonly portLedMat: THREE.MeshBasicMaterial;
  private tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.02, 0.02) });
  private headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.3, 0.3) });
  private wheels: THREE.Object3D[] = [];
  private arrive: Poly;
  private depart: Poly;
  private dep1 = 0;
  private dep2 = 1;
  private presence = 1;
  private pos = new THREE.Vector2();
  private yaw = 0;
  private lastPos = new THREE.Vector2();
  private tmpP = new THREE.Vector2();
  private tmpT = new THREE.Vector2();
  private owned: { dispose(): void }[] = [];
  private park: THREE.Vector3;
  private flip: number;

  constructor(hs: HouseStatic, color: number) {
    const x = hs.carPark.x, z = hs.carPark.z, lane = STREET.laneZ;
    this.park = hs.carPark.clone();
    this.flip = hs.placement.flip;
    // arrival: along the lane from the east, left turn into the drive (nose in)
    const a: THREE.Vector2[] = [new THREE.Vector2(FAR, lane), new THREE.Vector2(x + 7.5, lane)];
    a.push(...curve(a[1], new THREE.Vector2(x, lane), new THREE.Vector2(x, lane + 7.5)));
    a.push(new THREE.Vector2(x, z));
    this.arrive = new Poly(a);
    // departure: reverse out, swing round and leave westwards
    const d: THREE.Vector2[] = [new THREE.Vector2(x, z), new THREE.Vector2(x, lane + 7.5)];
    const arcStart = d.length - 1;
    d.push(...curve(d[1], new THREE.Vector2(x, lane), new THREE.Vector2(x - 7.5, lane)));
    const arcEnd = d.length - 1;
    d.push(new THREE.Vector2(-FAR, lane));
    this.depart = new Poly(d);
    this.dep1 = this.depart.fractionAt(arcStart);
    this.dep2 = this.depart.fractionAt(arcEnd);

    this.buildModel(color);

    // charging cable from the wall box to the car's port (plug / port come from the house layout)
    const plug = hs.chargerPlug, port = hs.port;
    const mid = plug.clone().lerp(port, 0.5);
    mid.y -= 0.34;
    const cv = new THREE.CatmullRomCurve3([plug, plug.clone().add(new THREE.Vector3(0, -0.18, -0.05)), mid, port.clone().add(new THREE.Vector3(0, -0.05, 0)), port], false, 'catmullrom', 0.3);
    const cg = new THREE.TubeGeometry(cv, 30, 0.035, 6, false);
    const cm = new THREE.MeshLambertMaterial({ color: 0x14171a });
    this.cable = new THREE.Mesh(cg, cm);
    this.cable.castShadow = true;
    this.owned.push(cg, cm);

    this.group.position.set(x, 0, z);
    this.portLedMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.1, 0.1) });
    this.portLed = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), this.portLedMat);
    this.portLed.position.set(this.flip * 0.95, 0.9, 1.25);
    this.group.add(this.portLed);
    this.owned.push(this.portLed.geometry, this.portLedMat);
  }

  private buildModel(color: number): void {
    const g = this.group;
    const own = <T extends { dispose(): void }>(o: T): T => { this.owned.push(o); return o; };
    const paint = own(new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.2 }));
    const glass = own(new THREE.MeshStandardMaterial({ color: 0x0e1621, roughness: 0.1, metalness: 0.1 }));
    const dark = own(new THREE.MeshLambertMaterial({ color: 0x15171a }));
    const hub = own(new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.35, metalness: 0.6 }));

    const W = 1.8, bev = 0.07;
    const body = new THREE.Shape();
    const P: [number, number][] = [
      [-2.1, 0.32], [-2.19, 0.62], [-2.06, 0.95], [-1.5, 1.02], [-0.85, 1.46], [0.45, 1.5],
      [1.2, 1.05], [2.05, 0.9], [2.19, 0.62], [2.1, 0.32],
    ];
    body.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length; i++) body.lineTo(P[i][0], P[i][1]);
    body.closePath();
    const eg = own(new THREE.ExtrudeGeometry(body, {
      depth: W - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 1,
    }));
    eg.translate(0, 0, -(W - 2 * bev) / 2);
    const bodyMesh = new THREE.Mesh(eg, paint);
    bodyMesh.rotation.y = -Math.PI / 2;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    g.add(bodyMesh);

    // greenhouse glass: a slightly wider, slightly outset extrusion over the cabin
    const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const r0 = lerp2(P[3], P[4], 0.1), r1 = lerp2(P[3], P[4], 0.93);
    const f0 = lerp2(P[5], P[6], 0.07), f1 = lerp2(P[5], P[6], 0.86);
    const gs = new THREE.Shape();
    gs.moveTo(r0[0] - 0.015, r0[1] + 0.01);
    gs.lineTo(r1[0] - 0.015, r1[1] + 0.005);
    gs.lineTo(f0[0], f0[1] - 0.04);
    gs.lineTo(f1[0] + 0.015, f1[1] + 0.01);
    gs.closePath();
    const gg = own(new THREE.ExtrudeGeometry(gs, { depth: W + 0.02, bevelEnabled: false }));
    gg.translate(0, 0, -(W + 0.02) / 2);
    const glassMesh = new THREE.Mesh(gg, glass);
    glassMesh.rotation.y = -Math.PI / 2;
    g.add(glassMesh);

    const under = new THREE.Mesh(own(new THREE.BoxGeometry(1.6, 0.22, 3.9)), dark);
    under.position.set(0, 0.24, 0);
    g.add(under);

    const tire = own(new THREE.CylinderGeometry(0.33, 0.33, 0.26, 16).rotateZ(Math.PI / 2));
    const hubG = own(new THREE.CylinderGeometry(0.19, 0.19, 0.275, 8).rotateZ(Math.PI / 2));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Group();
        const t = new THREE.Mesh(tire, dark);
        t.castShadow = true;
        w.add(t, new THREE.Mesh(hubG, hub));
        w.position.set(sx * 0.8, 0.33, sz * 1.38);
        g.add(w);
        this.wheels.push(w);
      }
    }
    // lights
    const lampG = own(new THREE.BoxGeometry(0.46, 0.1, 0.05));
    for (const sx of [-1, 1]) {
      const t = new THREE.Mesh(lampG, this.tailMat);
      t.position.set(sx * 0.62, 0.78, -2.2);
      g.add(t);
      const h = new THREE.Mesh(lampG, this.headMat);
      h.position.set(sx * 0.6, 0.72, 2.2);
      g.add(h);
    }
    // charge port flap (on the side that faces the house wall)
    const flap = new THREE.Mesh(own(new THREE.BoxGeometry(0.03, 0.18, 0.22)), dark);
    flap.position.set(this.flip * 0.93, 0.84, 1.25);
    g.add(flap);
    this.owned.push(this.tailMat, this.headMat);
  }

  /**
   * @param present state-derived: true = parked at home
   * @param snap jump straight to the target state (first frame, big time jumps)
   * @param lamps 0..1 night-time lights
   */
  update(dt: number, present: boolean, snap: boolean, lamps: number, duration: number): CarState {
    const target = present ? 1 : 0;
    if (snap) this.presence = target;
    else {
      const step = dt / duration;
      this.presence = target > this.presence ? Math.min(target, this.presence + step) : Math.max(target, this.presence - step);
    }
    const p = this.presence;
    const arriving = present;
    const e = smoothstep(0, 1, p);
    const tmpP = this.tmpP, tmpT = this.tmpT;
    if (arriving) {
      this.arrive.at(e, tmpP, tmpT);
      this.yaw = Math.atan2(tmpT.x, tmpT.y);
    } else {
      const s = 1 - e;
      this.depart.at(s, tmpP, tmpT);
      const k = smoothstep(this.dep1, this.dep2, s);
      this.yaw = -(Math.PI / 2) * k;
    }
    this.lastPos.copy(this.pos);
    if (snap) this.pos.copy(tmpP);
    else {
      this.pos.x = damp(this.pos.x, tmpP.x, 0.07, dt);
      this.pos.y = damp(this.pos.y, tmpP.y, 0.07, dt);
    }
    this.group.position.set(this.pos.x, 0, this.pos.y);
    // shortest-way yaw smoothing
    let dy = this.yaw - this.group.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.group.rotation.y = snap ? this.yaw : this.group.rotation.y + dy * (1 - Math.exp(-dt / 0.08));

    const dist = this.pos.distanceTo(this.lastPos);
    const moving = !snap && dist > 1e-4 && p > 0.001 && p < 0.9995;
    const fwd = new THREE.Vector2(Math.sin(this.group.rotation.y), Math.cos(this.group.rotation.y));
    const signed = (this.pos.x - this.lastPos.x) * fwd.x + (this.pos.y - this.lastPos.y) * fwd.y;
    if (!snap) for (const w of this.wheels) w.rotation.x += signed / 0.33;

    this.group.visible = p > 0.002 && (this.pos.y > -40);
    this.group.visible = p > 0.002;
    const docked = smoothstep(0.985, 1.0, p);
    this.cable.visible = docked > 0.5;
    // lights: headlights on at night or while moving in the dark; tail lights glow when moving or at night
    const l = lamps;
    const head = moving ? 0.35 + 3.2 * l : 0.2 + 0.4 * l;
    this.headMat.color.setRGB(head, head * 0.95, head * 0.8);
    const tail = (moving ? 1.0 : 0.25) + 0.9 * l * (moving ? 1 : 0.2);
    this.tailMat.color.setRGB(tail, tail * 0.04, tail * 0.03);
    return { presence: p, moving, docked };
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
  }
}

export { clamp01 };
