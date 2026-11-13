import { beforeAll, describe, expect, it } from 'vitest';
import type { PolicyResult, ScenarioEvent, SimConfig, SolveResult } from '../src/shared/types';
import { buildScenario, DEFAULT_CONFIG, defaultEvents } from '../src/sim/index';
import { clearMpcCache, initSolver, solveAll, solveDp, solveMpc } from '../src/sim/solve';

beforeAll(async () => {
  await initSolver();
});

const KEYS = ['battChargeKw', 'battDischargeKw', 'evKw', 'gridImportKw', 'gridExportKw', 'socKwh', 'evDeliveredKwh', 'stepCost', 'cumCost'] as const;

function maxDiff(a: PolicyResult, b: PolicyResult): number {
  let m = Math.abs(a.totalCost - b.totalCost);
  for (const k of KEYS) {
    expect(a[k].length).toBe(b[k].length);
    for (let i = 0; i < a[k].length; i++) m = Math.max(m, Math.abs(a[k][i] - b[k][i]));
  }
  return m;
}

const ev = (id: string, startStep: number, durationSteps: number, magnitude: number, kind: 'priceSpike' | 'cloud' = 'priceSpike'): ScenarioEvent => ({
  id, kind, startStep, durationSteps, magnitude,
});

function fresh(config: SimConfig, events: ScenarioEvent[]): SolveResult {
  clearMpcCache();
  return solveAll(999, config, events);
}

const base = (): ScenarioEvent[] => defaultEvents(DEFAULT_CONFIG).filter((e) => e.id !== 'spike-2' && e.id !== 'cloud-2');
const TOL = 1e-7;

describe('solveAll prefix reuse', () => {
  it('A then B (late event differs) equals B from scratch and equals solveMpc(B)', () => {
    for (const fe of [0, 0.5, 1]) {
      const config = { ...DEFAULT_CONFIG, forecastError: fe };
      const A = [...base(), ev('late', 85, 4, 0.5)];
      const B = [...base(), ev('late', 80, 4, 1.2)];
      clearMpcCache();
      solveAll(1, config, A);
      const rB = solveAll(2, config, B);
      const rFresh = fresh(config, B);
      expect(maxDiff(rB.mpc, rFresh.mpc), `fe ${fe} reuse vs fresh`).toBeLessThan(TOL);
      expect(maxDiff(rB.mpc, solveMpc(buildScenario(config, B))), `fe ${fe} reuse vs solveMpc`).toBeLessThan(TOL);
      expect(maxDiff(rB.dp, rFresh.dp)).toBe(0);
      expect(rB.timing.mpcFromStep).toBeGreaterThan(0);
      expect(rB.timing.lpSolves).toBeLessThan(96);
      expect(rFresh.timing.mpcFromStep).toBe(0);
      expect(rFresh.timing.lpSolves).toBeGreaterThanOrEqual(90);
      // the prefix before the first step that can see the event (80 - 47 = 33) should be reused
      expect(rB.timing.mpcFromStep, `fe ${fe} mpcFromStep`).toBeGreaterThanOrEqual(30);
      expect(rB.timing.mpcFromStep).toBeLessThanOrEqual(80);
    }
  });

  it('identical request twice: same result, (nearly) nothing re-solved', () => {
    const config = { ...DEFAULT_CONFIG };
    const E = defaultEvents(config);
    clearMpcCache();
    const a = solveAll(1, config, E);
    const b = solveAll(2, config, E.map((e) => ({ ...e })));
    expect(maxDiff(a.mpc, b.mpc)).toBeLessThan(TOL);
    expect(b.reqId).toBe(2);
    expect(b.timing.lpSolves).toBeLessThan(96);
  });

  it('early change (event at step 0 / 2) forces a full re-solve and matches scratch', () => {
    const config = { ...DEFAULT_CONFIG };
    clearMpcCache();
    solveAll(1, config, base());
    for (const E of [[...base(), ev('x', 0, 3, 1.5)], [...base(), ev('x', 2, 3, 1, 'cloud')], base()]) {
      const r = solveAll(2, config, E);
      expect(maxDiff(r.mpc, fresh(config, E).mpc)).toBeLessThan(TOL);
      clearMpcCache();
      solveAll(1, config, base());
    }
  });

  it('long random sequence of edits (move/resize/add/remove) always equals a fresh solve', () => {
    const config = { ...DEFAULT_CONFIG, forecastError: 0.5 };
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let E = defaultEvents(config);
    clearMpcCache();
    solveAll(0, config, E);
    for (let i = 1; i <= 14; i++) {
      const op = Math.floor(rnd() * 4);
      if (op === 0 && E.length) {
        const j = Math.floor(rnd() * E.length);
        E = E.map((e, idx) => (idx === j ? { ...e, startStep: Math.floor(rnd() * (96 - e.durationSteps)) } : e));
      } else if (op === 1 && E.length) {
        const j = Math.floor(rnd() * E.length);
        E = E.map((e, idx) => (idx === j ? { ...e, magnitude: e.kind === 'cloud' ? rnd() : 0.05 + rnd() * 1.45 } : e));
      } else if (op === 2) {
        E = [...E, ev(`n${i}`, Math.floor(rnd() * 90), 1 + Math.floor(rnd() * 6), 0.05 + rnd() * 1.45, rnd() < 0.5 ? 'cloud' : 'priceSpike')];
      } else if (E.length > 1) {
        E = E.slice(0, E.length - 1);
      }
      const r = solveAll(i, config, E);
      const f = fresh(config, E);
      expect(maxDiff(r.mpc, f.mpc), `step ${i} op ${op}`).toBeLessThan(TOL);
      expect(maxDiff(r.dp, f.dp)).toBe(0);
      // restore cache state to the incremental sequence
      clearMpcCache();
      solveAll(i, config, E);
    }
  });

  it('changing the config (forecastError, seed, battery size, EV need) between solves never reuses stale prefixes', () => {
    const E = defaultEvents(DEFAULT_CONFIG);
    const variants: Partial<SimConfig>[] = [
      { forecastError: 1 },
      { forecastError: 0 },
      { seed: 99 },
      { battKwh: 10 },
      { battKw: 3 },
      { evNeedKwh: 30 },
      { battRoundTrip: 0.8 },
      { pvKwp: 3 },
      { mpcHorizonSteps: 24 },
      { battInitFrac: 0.3 },
    ];
    for (const v of variants) {
      const config = { ...DEFAULT_CONFIG, ...v };
      clearMpcCache();
      solveAll(1, DEFAULT_CONFIG, E);
      const r = solveAll(2, config, E);
      const f = fresh(config, E);
      expect(maxDiff(r.mpc, f.mpc), JSON.stringify(v)).toBeLessThan(TOL);
    }
  });

  it('earlier results are not mutated by later solves (no aliasing of cached arrays)', () => {
    const config = { ...DEFAULT_CONFIG };
    clearMpcCache();
    const a = solveAll(1, config, base());
    const snap = KEYS.map((k) => Array.from(a.mpc[k]));
    const total = a.mpc.totalCost;
    solveAll(2, config, [...base(), ev('late', 85, 6, 1.5)]);
    solveAll(3, config, [...base(), ev('late', 50, 6, 1.5)]);
    expect(a.mpc.totalCost).toBe(total);
    KEYS.forEach((k, i) => expect(Array.from(a.mpc[k]), k).toEqual(snap[i]));
  });

  it('solveAll DP / scenario equal the direct calls; result is a coherent SolveResult', () => {
    clearMpcCache();
    const config = { ...DEFAULT_CONFIG, forecastError: 0.7 };
    const E = defaultEvents(config);
    const r = solveAll(5, config, E);
    const sc = buildScenario(config, E);
    expect(r.reqId).toBe(5);
    expect(Array.from(r.scenario.buy)).toEqual(Array.from(sc.buy));
    expect(maxDiff(r.dp, solveDp(sc))).toBe(0);
    expect(r.mpc.policy).toBe('mpc');
    expect(r.dp.policy).toBe('dp');
    expect(r.solver).toMatch(/HiGHS/i);
    const t = r.timing;
    expect(t.totalMs).toBeGreaterThan(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.mpcMs - 1e-6);
    expect(t.lpSolves).toBeGreaterThan(0);
  });

  it('after a late edit the re-solve is materially faster than from scratch (measured)', () => {
    const config = { ...DEFAULT_CONFIG };
    clearMpcCache();
    const t0 = solveAll(1, config, base());
    solveAll(2, config, [...base(), ev('late', 90, 4, 1)]);
    const warm: number[] = [];
    const cold: number[] = [];
    for (let i = 0; i < 5; i++) {
      warm.push(solveAll(3 + i, config, [...base(), ev('late', 86 + (i % 3), 4, 0.5 + i * 0.1)]).timing.totalMs);
      cold.push(fresh(config, [...base(), ev('late', 86 + (i % 3), 4, 0.5 + i * 0.1)]).timing.totalMs);
    }
    const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
    console.log(`solveAll median warm ${med(warm).toFixed(1)} ms, cold ${med(cold).toFixed(1)} ms, first ${t0.timing.totalMs.toFixed(1)} ms`);
    expect(med(warm)).toBeLessThan(med(cold));
  });
});
