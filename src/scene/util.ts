import * as THREE from 'three';

export const DEG = Math.PI / 180;

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach: returns the new value of `current`. */
export function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Blend factor equivalent to `damp` for use with lerp()/Color.lerp(). */
export function dampK(tau: number, dt: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

/** Small deterministic PRNG (mulberry32) so the procedural scene is identical on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const col = (hex: number): THREE.Color => new THREE.Color(hex);

/** Colour slightly varied in lightness, for hand-made looking batches. */
export function jitter(c: THREE.Color | number, amount: number, r: () => number): THREE.Color {
  const out = typeof c === 'number' ? new THREE.Color(c) : c.clone();
  const k = 1 + (r() - 0.5) * 2 * amount;
  out.multiplyScalar(k);
  return out;
}

export function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Dispose every geometry / material / texture reachable from `root`. */
export function disposeTree(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (v && (v as THREE.Texture).isTexture && !seen.has(v)) {
          seen.add(v);
          (v as THREE.Texture).dispose();
        }
      }
      const uniforms = (mat as THREE.ShaderMaterial).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          const v = u?.value;
          if (v && (v as THREE.Texture).isTexture && !seen.has(v)) {
            seen.add(v);
            (v as THREE.Texture).dispose();
          }
        }
      }
      mat.dispose();
    }
  });
}
