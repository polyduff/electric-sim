import * as THREE from 'three';

type V3 = THREE.Vector3;
export type ColorLike = THREE.Color | number;

export interface UvFrame {
  /** Unit direction (local space) mapped to +u. */
  eu: V3;
  /** Unit direction (local space) mapped to +v. */
  ev: V3;
  /** Texture repeats per metre along u / v. */
  su: number;
  sv: number;
}

const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cc = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

export const v3 = (x: number, y: number, z: number): V3 => new THREE.Vector3(x, y, z);

/**
 * Accumulates flat-shaded, vertex-coloured triangles and turns them into ONE mesh.
 * Everything static in the scene goes through a handful of these, so the whole
 * neighbourhood costs a few draw calls.
 *
 * A current transform (`matrix`) is applied to everything pushed; mirrored
 * transforms (negative determinant) are handled by swapping the winding.
 */
export class GeoBatch {
  private pos: number[] = [];
  private nor: number[] = [];
  private colr: number[] = [];
  private uvs: number[] = [];
  private mat = new THREE.Matrix4();
  private mirrored = false;

  setMatrix(m: THREE.Matrix4 | null): this {
    if (m) this.mat.copy(m);
    else this.mat.identity();
    this.mirrored = this.mat.determinant() < 0;
    return this;
  }

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  private pushTri(a: V3, b: V3, c: V3, color: THREE.Color, uv?: UvFrame, colorB?: THREE.Color, colorC?: THREE.Color): void {
    // UVs are computed in local space so mirrored copies share the same mapping.
    let ua = 0, va = 0, ub = 0, vb = 0, uc = 0, vc = 0;
    if (uv) {
      ua = a.dot(uv.eu) * uv.su; va = a.dot(uv.ev) * uv.sv;
      ub = b.dot(uv.eu) * uv.su; vb = b.dot(uv.ev) * uv.sv;
      uc = c.dot(uv.eu) * uv.su; vc = c.dot(uv.ev) * uv.sv;
    }
    _a.copy(a).applyMatrix4(this.mat);
    _b.copy(b).applyMatrix4(this.mat);
    _cc.copy(c).applyMatrix4(this.mat);
    const cb = colorB ?? color;
    const cC = colorC ?? color;
    if (this.mirrored) {
      this.emit(_a, _cc, _b, color, cC, cb, ua, va, uc, vc, ub, vb);
    } else {
      this.emit(_a, _b, _cc, color, cb, cC, ua, va, ub, vb, uc, vc);
    }
  }

  private emit(
    a: V3, b: V3, c: V3,
    ca: THREE.Color, cb: THREE.Color, cc: THREE.Color,
    ua: number, va: number, ub: number, vb: number, uc: number, vc: number,
  ): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    const len = _n.length();
    if (len < 1e-12) return; // degenerate
    _n.multiplyScalar(1 / len);
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.nor.push(_n.x, _n.y, _n.z, _n.x, _n.y, _n.z, _n.x, _n.y, _n.z);
    this.colr.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
    this.uvs.push(ua, va, ub, vb, uc, vc);
  }

  private static toColor(c: ColorLike): THREE.Color {
    return typeof c === 'number' ? _c.setHex(c).clone() : c;
  }

  /** Triangle; if `outward` is given the winding is fixed so the face normal points that way (local space). */
  tri(a: V3, b: V3, c: V3, color: ColorLike, outward?: V3, uv?: UvFrame): this {
    const col = GeoBatch.toColor(color);
    if (outward) {
      _e1.subVectors(b, a);
      _e2.subVectors(c, a);
      if (_n.crossVectors(_e1, _e2).dot(outward) < 0) {
        this.pushTri(a, c, b, col, uv);
        return this;
      }
    }
    this.pushTri(a, b, c, col, uv);
    return this;
  }

  /** Planar quad a-b-c-d (in order around the perimeter). */
  quad(a: V3, b: V3, c: V3, d: V3, color: ColorLike, outward?: V3, uv?: UvFrame): this {
    const col = GeoBatch.toColor(color);
    let flip = false;
    if (outward) {
      _e1.subVectors(b, a);
      _e2.subVectors(d, a);
      flip = _n.crossVectors(_e1, _e2).dot(outward) < 0;
    }
    if (flip) {
      this.pushTri(a, c, b, col, uv);
      this.pushTri(a, d, c, col, uv);
    } else {
      this.pushTri(a, b, c, col, uv);
      this.pushTri(a, c, d, col, uv);
    }
    return this;
  }

  /** Axis-aligned (optionally yawed) box centred at (cx, cy, cz). `faces` can drop hidden sides. */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    color: ColorLike,
    opts: { rotY?: number; uv?: { su: number; sv: number }; noBottom?: boolean; noTop?: boolean; topColor?: ColorLike } = {},
  ): this {
    const col = GeoBatch.toColor(color);
    const top = opts.topColor !== undefined ? GeoBatch.toColor(opts.topColor) : col;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cs = Math.cos(opts.rotY ?? 0), sn = Math.sin(opts.rotY ?? 0);
    const P = (x: number, y: number, z: number): V3 =>
      new THREE.Vector3(cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs);
    const p000 = P(-hx, -hy, -hz), p100 = P(hx, -hy, -hz), p010 = P(-hx, hy, -hz), p110 = P(hx, hy, -hz);
    const p001 = P(-hx, -hy, hz), p101 = P(hx, -hy, hz), p011 = P(-hx, hy, hz), p111 = P(hx, hy, hz);
    const up = new THREE.Vector3(0, 1, 0);
    const side = (a: V3, b: V3, c: V3, d: V3): void => {
      let uv: UvFrame | undefined;
      if (opts.uv) {
        const eu = new THREE.Vector3().subVectors(b, a).normalize();
        uv = { eu, ev: up, su: opts.uv.su, sv: opts.uv.sv };
      }
      const out = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5).sub(new THREE.Vector3(cx, cy, cz));
      this.quad(a, b, c, d, col, out, uv);
    };
    side(p100, p000, p010, p110); // -z
    side(p001, p101, p111, p011); // +z
    side(p000, p001, p011, p010); // -x
    side(p101, p100, p110, p111); // +x
    if (!opts.noTop) this.quad(p010, p011, p111, p110, top, up);
    if (!opts.noBottom) this.quad(p000, p100, p101, p001, col, new THREE.Vector3(0, -1, 0));
    return this;
  }

  /**
   * Append an arbitrary geometry (indexed or not) with a local matrix.
   * Flat shaded unless `smooth` is set. `colorFn` can vary the colour per vertex (receives the LOCAL position).
   */
  geom(
    g: THREE.BufferGeometry,
    local: THREE.Matrix4 | null,
    color: ColorLike,
    opts: { smooth?: boolean; colorFn?: (p: V3, base: THREE.Color) => THREE.Color; keepUv?: boolean } = {},
  ): this {
    const base = GeoBatch.toColor(color);
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.getAttribute('position');
    const nrm = src.getAttribute('normal');
    const uvA = src.getAttribute('uv');
    const full = new THREE.Matrix4().copy(this.mat);
    if (local) full.multiply(local);
    const mirrored = full.determinant() < 0;
    const nm = new THREE.Matrix3().getNormalMatrix(full);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const la = new THREE.Vector3(), lb = new THREE.Vector3(), lc = new THREE.Vector3();
    const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      la.fromBufferAttribute(p, i); lb.fromBufferAttribute(p, i + 1); lc.fromBufferAttribute(p, i + 2);
      va.copy(la).applyMatrix4(full); vb.copy(lb).applyMatrix4(full); vc.copy(lc).applyMatrix4(full);
      const ca = opts.colorFn ? opts.colorFn(la, base) : base;
      const cb = opts.colorFn ? opts.colorFn(lb, base) : base;
      const cc = opts.colorFn ? opts.colorFn(lc, base) : base;
      const ua = opts.keepUv && uvA ? uvA.getX(i) : 0, vaU = opts.keepUv && uvA ? uvA.getY(i) : 0;
      const ub = opts.keepUv && uvA ? uvA.getX(i + 1) : 0, vbU = opts.keepUv && uvA ? uvA.getY(i + 1) : 0;
      const uc = opts.keepUv && uvA ? uvA.getX(i + 2) : 0, vcU = opts.keepUv && uvA ? uvA.getY(i + 2) : 0;
      if (opts.smooth && nrm) {
        na.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        nb.fromBufferAttribute(nrm, i + 1).applyMatrix3(nm).normalize();
        nc.fromBufferAttribute(nrm, i + 2).applyMatrix3(nm).normalize();
        if (mirrored) {
          this.pos.push(va.x, va.y, va.z, vc.x, vc.y, vc.z, vb.x, vb.y, vb.z);
          this.nor.push(na.x, na.y, na.z, nc.x, nc.y, nc.z, nb.x, nb.y, nb.z);
          this.colr.push(ca.r, ca.g, ca.b, cc.r, cc.g, cc.b, cb.r, cb.g, cb.b);
          this.uvs.push(ua, vaU, uc, vcU, ub, vbU);
        } else {
          this.pos.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
          this.nor.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
          this.colr.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
          this.uvs.push(ua, vaU, ub, vbU, uc, vcU);
        }
      } else if (mirrored) {
        this.emit(va, vc, vb, ca, cc, cb, ua, vaU, uc, vcU, ub, vbU);
      } else {
        this.emit(va, vb, vc, ca, cb, cc, ua, vaU, ub, vbU, uc, vcU);
      }
    }
    if (src !== g) src.dispose();
    return this;
  }

  /** Geometry helper that disposes the temporary source afterwards. */
  consume(
    g: THREE.BufferGeometry,
    local: THREE.Matrix4 | null,
    color: ColorLike,
    opts: { smooth?: boolean; colorFn?: (p: V3, base: THREE.Color) => THREE.Color; keepUv?: boolean } = {},
  ): this {
    this.geom(g, local, color, opts);
    g.dispose();
    return this;
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colr, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.pos = []; this.nor = []; this.colr = []; this.uvs = [];
    return g;
  }

  mesh(material: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string } = {}): THREE.Mesh {
    const m = new THREE.Mesh(this.toGeometry(), material);
    m.castShadow = opts.cast ?? true;
    m.receiveShadow = opts.receive ?? true;
    m.name = opts.name ?? '';
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }
}

/** Compose a TRS matrix in one call. */
export function trs(
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}
