import { beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioEvent, SimConfig } from '../src/shared/types';
import { buildScenario, DEFAULT_CONFIG } from '../src/sim/index';
import { initSolver, solveDp, solveHindsightLp, solveMpc } from '../src/sim/solve';
import { checkPolicy } from './helpers';

beforeAll(async () => {
  await initSolver();
});

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

interface Rand {
  name: string;
  config: SimConfig;
  events: ScenarioEvent[];
}

function randomCase(i: number): Rand {
  const r = rng(1000 + i);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const days = pick([1, 2, 2, 3]);
  const config: SimConfig = {
    ...DEFAULT_CONFIG,
    seed: 1 + Math.floor(r() * 1e6),
    days,
    startHour: pick([7, 7, 0, 12, 18, 20, 3.5]),
    forecastError: pick([0, 0.5, 1]),
    pvKwp: pick([0, 3, 6, 10]),
    battKwh: pick([2, 6, 13.5, 20, 27]),
    battKw: pick([1, 2.5, 5, 8]),
    battRoundTrip: pick([0.7, 0.8, 0.9, 1]),
    battInitFrac: pick([0.1, 0.5, 0.9, 1, 0]),
    evNeedKwh: pick([0, 10, 40, 60]),
    evKw: pick([3.7, 7, 11]),
    evArriveHour: pick([18, 17, 22]),
    evDepartHour: pick([7, 6, 8]),
    mpcHorizonSteps: pick([48, 24, 12]),
  };
  const n = days * 48;
  const events: ScenarioEvent[] = [];
  const ne = Math.floor(r() * 7);
  for (let e = 0; e < ne; e++) {
    const kind = r() < 0.6 ? 'priceSpike' : 'cloud';
    const dur = 1 + Math.floor(r() * 12);
    events.push({
      id: `e${e}`,
      kind,
      startStep: Math.floor(r() * n),
      durationSteps: dur,
      magnitude: kind === 'priceSpike' ? 0.05 + r() * 1.45 : 0.1 + r() * 0.9,
    });
  }
  return { name: `rand${i}`, config, events };
}

const CASES = Array.from({ length: 36 }, (_, i) => randomCase(i));

describe('adversarial randomized configs (refined DP, MPC, LP)', () => {
  it('constraints hold for MPC, DP and LP on every random case', () => {
    const errs: string[] = [];
    for (const c of CASES) {
      const sc = buildScenario(c.config, c.events);
      for (const [label, r] of [['mpc', solveMpc(sc)], ['dp', solveDp(sc)], ['lp', solveHindsightLp(sc)]] as const) {
        errs.push(...checkPolicy(sc, r, `${label} ${c.name} ${JSON.stringify({ ...c.config, seed: undefined })}`).slice(0, 1));
      }
    }
    expect(errs).toEqual([]);
  });

  it('DP >= LP - 1e-6, MPC >= LP - 1e-6, and DP within 1% (or 2 c) of the LP optimum', () => {
    const errs: string[] = [];
    let worst = { gap: 0, name: '', cfg: '' };
    for (const c of CASES) {
      const sc = buildScenario(c.config, c.events);
      const lp = solveHindsightLp(sc).totalCost;
      const dp = solveDp(sc).totalCost;
      const mpc = solveMpc(sc).totalCost;
      if (dp < lp - 1e-6) errs.push(`${c.name}: dp ${dp} < lp ${lp}`);
      if (mpc < lp - 1e-6) errs.push(`${c.name}: mpc ${mpc} < lp ${lp}`);
      const gap = dp - lp;
      if (gap > worst.gap) worst = { gap, name: c.name, cfg: JSON.stringify({ ...c.config, seed: undefined }) + ' events ' + c.events.length };
      if (gap > Math.max(0.02, 0.01 * Math.abs(lp))) errs.push(`${c.name}: dp - lp = ${gap.toFixed(4)} (lp ${lp.toFixed(3)})`);
      if (mpc < dp - (Math.max(0, gap) + 1e-6)) errs.push(`${c.name}: mpc ${mpc} < dp ${dp} beyond DP gap`);
    }
    console.log(`random cases: worst DP - LP = ${worst.gap.toFixed(4)} (${worst.name}) ${worst.cfg}`);
    expect(errs).toEqual([]);
  });

  it('degenerate extremes: zero-size battery, zero EV, 100% efficient, 1 day, spike everywhere', () => {
    const base = DEFAULT_CONFIG;
    const variants: Partial<SimConfig>[] = [
      { battKwh: 0.5, battKw: 0.5 },
      { evNeedKwh: 0 },
      { battRoundTrip: 1 },
      { days: 1 },
      { battInitFrac: 1 },
      { battInitFrac: 0 },
      { evNeedKwh: 91 }, // exactly the max deliverable in 13 h at 7 kW
    ];
    const errs: string[] = [];
    for (const v of variants) {
      const config = { ...base, ...v };
      for (const events of [[], [{ id: 'a', kind: 'priceSpike' as const, startStep: 0, durationSteps: 96, magnitude: 1.5 }]]) {
        const sc = buildScenario(config, events);
        const lp = solveHindsightLp(sc);
        const dp = solveDp(sc);
        errs.push(...checkPolicy(sc, dp, `dp ${JSON.stringify(v)}`).slice(0, 1));
        errs.push(...checkPolicy(sc, solveMpc(sc), `mpc ${JSON.stringify(v)}`).slice(0, 1));
        if (dp.totalCost < lp.totalCost - 1e-6) errs.push(`${JSON.stringify(v)} dp below lp`);
        if (dp.totalCost - lp.totalCost > 0.03) errs.push(`${JSON.stringify(v)} dp-lp ${(dp.totalCost - lp.totalCost).toFixed(4)}`);
      }
    }
    expect(errs).toEqual([]);
  });

  it('DP is deterministic and the identical-repeat solves are stable', () => {
    const c = CASES[3];
    const sc = buildScenario(c.config, c.events);
    const a = solveDp(sc);
    const b = solveDp(sc);
    expect(b.totalCost).toBe(a.totalCost);
    expect(Array.from(b.socKwh)).toEqual(Array.from(a.socKwh));
  });
});
