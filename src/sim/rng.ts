/**
 * Small deterministic PRNG helpers. Everything stochastic in the simulator is
 * derived from `config.seed` through these, so the same seed always produces a
 * bit-identical scenario (within one JS engine family; Node and Chromium are
 * both V8).
 */

/** mulberry32: 32-bit state, good enough statistically for a demo, very fast. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a seed with a stream id so independent series use independent streams. */
export function streamSeed(seed: number, stream: number): number {
  let h = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (stream + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Standard normal generator (Box-Muller) on top of a uniform generator. */
export function gaussian(uniform: () => number): () => number {
  let spare = NaN;
  return () => {
    if (!Number.isNaN(spare)) {
      const s = spare;
      spare = NaN;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Unit-variance AR(1) series of length n: x[t+1] = rho x[t] + sqrt(1-rho^2) eps. */
export function ar1Series(seed: number, stream: number, n: number, rho: number): Float64Array {
  const g = gaussian(mulberry32(streamSeed(seed, stream)));
  const out = new Float64Array(n);
  const k = Math.sqrt(Math.max(0, 1 - rho * rho));
  let x = g();
  for (let t = 0; t < n; t++) {
    out[t] = x;
    x = rho * x + k * g();
  }
  return out;
}
