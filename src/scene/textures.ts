import * as THREE from 'three';
import { rng } from './util';

/** All textures are drawn on canvases at start-up: no downloaded assets. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, repeat = true, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Horizontal weatherboards: 4 boards per tile, light face with a shadow line under each lap. */
export function weatherboardTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  const boards = 4;
  const bh = c.height / boards;
  for (let i = 0; i < boards; i++) {
    const y = i * bh;
    const grad = g.createLinearGradient(0, y, 0, y + bh);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.7, '#f1f1f1');
    grad.addColorStop(0.86, '#dcdcdc');
    grad.addColorStop(0.9, '#9a9a9a');
    grad.addColorStop(1, '#7c7c7c');
    g.fillStyle = grad;
    g.fillRect(0, y, c.width, bh);
  }
  return finish(c);
}

/** Corrugated iron: soft vertical ridges. */
export function corrugatedTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 8);
  const img = g.createImageData(c.width, c.height);
  const ridges = 4;
  for (let x = 0; x < c.width; x++) {
    const ph = (x / c.width) * ridges * Math.PI * 2;
    const v = 0.80 + 0.2 * Math.sin(ph) - 0.06 * Math.max(0, Math.sin(ph + 2.2));
    const b = Math.round(255 * Math.min(1, v));
    for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c);
}

/** Solar panel: aluminium frame, dark cells, fine bus bars. Used as both map and emissiveMap. */
export function panelTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 208);
  g.fillStyle = '#c9ced6';
  g.fillRect(0, 0, c.width, c.height);
  const m = 5;
  g.fillStyle = '#0a1326';
  g.fillRect(m, m, c.width - 2 * m, c.height - 2 * m);
  const cols = 6, rows = 10;
  const cw = (c.width - 2 * m) / cols, ch = (c.height - 2 * m) / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = m + i * cw, y = m + j * ch;
      const grad = g.createLinearGradient(x, y, x + cw, y + ch);
      grad.addColorStop(0, '#1d3a6e');
      grad.addColorStop(1, '#122a55');
      g.fillStyle = grad;
      g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
    }
  }
  return finish(c, false, 4);
}

/** Subtle value noise used to break up large flat ground colours. */
export function grainTexture(seed = 7): THREE.CanvasTexture {
  const size = 128;
  const [c, g] = canvas(size, size);
  const r = rng(seed);
  // tileable value noise: two octaves on a wrapped lattice
  const lattice = (n: number): Float32Array => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = r();
    return a;
  };
  const l1 = lattice(8), l2 = lattice(32);
  const sample = (l: Float32Array, n: number, u: number, v: number): number => {
    const x = u * n, y = v * n;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number): number => l[((j % n + n) % n) * n + ((i % n + n) % n)];
    const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy;
  };
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = 0.62 * sample(l1, 8, u, v) + 0.38 * sample(l2, 32, u, v);
      const b = Math.round(255 * (0.8 + 0.2 * n));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c);
}

/** Warm interior seen through a window: brighter towards the bottom, curtains at the sides. */
export function windowGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#8a6a3c');
  grad.addColorStop(0.35, '#e8c078');
  grad.addColorStop(1, '#fff0c0');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const cur = g.createLinearGradient(0, 0, 64, 0);
  cur.addColorStop(0, 'rgba(90,50,20,0.55)');
  cur.addColorStop(0.18, 'rgba(90,50,20,0.0)');
  cur.addColorStop(0.82, 'rgba(90,50,20,0.0)');
  cur.addColorStop(1, 'rgba(90,50,20,0.55)');
  g.fillStyle = cur;
  g.fillRect(0, 0, 64, 64);
  return finish(c, false, 1);
}

/** Soft radial falloff (white, alpha) for light pools and halos. */
export function radialTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = finish(c, false, 1);
  return t;
}

/** Emissive companion of panelTexture: the cells light up, the frame stays dark. */
export function panelGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 208);
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const m = 5, cols = 6, rows = 10;
  const cw = (c.width - 2 * m) / cols, ch = (c.height - 2 * m) / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const grad = g.createLinearGradient(0, m + j * ch, 0, m + (j + 1) * ch);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, '#b0b0b0');
      g.fillStyle = grad;
      g.fillRect(m + i * cw + 1, m + j * ch + 1, cw - 2, ch - 2);
    }
  }
  return finish(c, false, 4);
}
