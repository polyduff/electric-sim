import { beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, DEFAULT_CONFIG, defaultEvents } from '../src/sim/index';
import { initSolver, solveDp, solveHindsightLp, solveMpc } from '../src/sim/solve';
import { buildCases, eventSets, solveCase } from './helpers';

/**
 * Tolerances.
 *  - MPC and DP are both feasible policies for the same constraints, so each must cost >= the exact LP optimum
 *    (solver feasibility tolerance only): 1e-6.
 *  - The DP is discretised (SoC / EV-energy grid), so it can be slightly suboptimal vs the LP. We bound
 *    DP - LP in [-1e-6, 0.05] $.
 *  - MPC >= DP - ((DP - LP) + 1e-6): if the DP is within eps of the LP optimum, any feasible MPC can beat the
 *    DP by at most eps. This is the tightest defensible form. A flat 0.01 $ form is also asserted because the UI
 *    displays the gap to the cent.
 */
beforeAll(async () => {
  await initSolver();
});

const cases = buildCases();

describe('MPC vs DP vs exact hindsight LP', () => {
  it('MPC >= LP optimum - 1e-6 and DP >= LP optimum - 1e-6 for every case', () => {
    const errs: string[] = [];
    for (const c of cases) {
      const s = solveCase(c);
      if (s.mpc.totalCost < s.lp.totalCost - 1e-6) errs.push(`${c.name}: mpc ${s.mpc.totalCost} < lp ${s.lp.totalCost}`);
      if (s.dp.totalCost < s.lp.totalCost - 1e-6) errs.push(`${c.name}: dp ${s.dp.totalCost} < lp ${s.lp.totalCost}`);
    }
    expect(errs).toEqual([]);
  });

  it('DP is close to LP optimum (<= 0.05 $ over 2 days)', () => {
    const errs: string[] = [];
    let worst = 0;
    for (const c of cases) {
      const s = solveCase(c);
      const gap = s.dp.totalCost - s.lp.totalCost;
      worst = Math.max(worst, gap);
      if (gap > 0.05) errs.push(`${c.name}: dp-lp = ${gap.toFixed(4)}`);
    }
    console.log(`worst DP - LP gap over ${cases.length} cases: $${worst.toFixed(4)}`);
    expect(errs).toEqual([]);
  });

  it('MPC >= DP - ((DP-LP) + 1e-6) for every case', () => {
    const errs: string[] = [];
    for (const c of cases) {
      const s = solveCase(c);
      const tol = Math.max(0, s.dp.totalCost - s.lp.totalCost) + 1e-6;
      if (s.mpc.totalCost < s.dp.totalCost - tol) errs.push(`${c.name}: mpc ${s.mpc.totalCost} < dp ${s.dp.totalCost}`);
    }
    expect(errs).toEqual([]);
  });

  it('MPC >= DP with a flat 0.01 $ tolerance (a negative gap would show in the UI)', () => {
    const errs: string[] = [];
    for (const c of cases) {
      const s = solveCase(c);
      if (s.mpc.totalCost - s.dp.totalCost < -0.01) errs.push(`${c.name}: gap ${(s.mpc.totalCost - s.dp.totalCost).toFixed(4)}`);
    }
    expect(errs).toEqual([]);
  });

  it('forecastError=0: MPC close to LP optimum; gap grows with forecastError on average over seeds', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20261112];
    const avg: Record<number, number> = {};
    const worst0: string[] = [];
    for (const fe of [0, 0.5, 1]) {
      let sum = 0;
      for (const seed of seeds) {
        const config = { ...DEFAULT_CONFIG, seed, forecastError: fe };
        const sc = buildScenario(config, defaultEvents(config));
        const lp = solveHindsightLp(sc).totalCost;
        const mpc = solveMpc(sc).totalCost;
        const g = mpc - lp;
        sum += g;
        if (fe === 0 && g > 0.15) worst0.push(`seed ${seed}: mpc-lp = ${g.toFixed(3)}`);
      }
      avg[fe] = sum / seeds.length;
    }
    console.log('avg MPC - LP gap over', seeds.length, 'seeds, by forecastError:', JSON.stringify(avg));
    expect(worst0).toEqual([]);
    expect(avg[0.5]).toBeGreaterThan(avg[0] - 1e-9);
    expect(avg[1]).toBeGreaterThan(avg[0.5]);
  });

  it('forecastError=0 on the default scenario: MPC - DP < 0.15 $', () => {
    const config = { ...DEFAULT_CONFIG, forecastError: 0 };
    const sc = buildScenario(config, defaultEvents(config));
    const dp = solveDp(sc).totalCost;
    const mpc = solveMpc(sc).totalCost;
    console.log(`fe=0 default: mpc ${mpc.toFixed(3)} dp ${dp.toFixed(3)}`);
    expect(mpc - dp).toBeLessThan(0.15);
  });

  it('DP never worse than the no-battery DP baseline', () => {
    const errs: string[] = [];
    for (const [name, events] of Object.entries(eventSets(DEFAULT_CONFIG))) {
      const sc = buildScenario(DEFAULT_CONFIG, events);
      const noBatt = solveDp(sc, { battery: false }).totalCost;
      const dp = solveDp(sc).totalCost;
      if (dp > noBatt + 1e-6) errs.push(`${name}: dp ${dp} > noBattery ${noBatt}`);
    }
    expect(errs).toEqual([]);
  });
});
