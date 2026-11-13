import { beforeAll, describe, expect, it } from 'vitest';
import { DT_H } from '../shared/types';
import type { PolicyResult, Scenario, ScenarioEvent, SimConfig } from '../shared/types';
import { buildScenario, DEFAULT_CONFIG, defaultEvents, forecastAt, sunPosition } from './index';
import {
  clearMpcCache,
  computeInsight,
  initSolver,
  mpcFallbackCount,
  solveAll,
  solveDp,
  solveHindsightLp,
  solveMpc,
} from './solve';
import { recoverSolver, solverRecoveries, spareReady } from './lp';

const cfg: SimConfig = { ...DEFAULT_CONFIG };
const events = defaultEvents(cfg);

function same(a: Float64Array | Uint8Array, b: Float64Array | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function checkPolicy(sc: Scenario, r: PolicyResult): void {
  const c = sc.config;
  const sq = Math.sqrt(c.battRoundTrip);
  const tol = 1e-6;
  const init = c.battKwh * c.battInitFrac;
  expect(r.socKwh[0]).toBeCloseTo(init, 9);
  expect(r.socKwh[sc.n]).toBeGreaterThanOrEqual(init - 1e-9);
  let cost = 0;
  for (let k = 0; k < sc.n; k++) {
    // energy balance
    const lhs = sc.pvKw[k] + r.gridImportKw[k] + r.battDischargeKw[k];
    const rhs = sc.loadKw[k] + r.evKw[k] + r.battChargeKw[k] + r.gridExportKw[k];
    expect(Math.abs(lhs - rhs)).toBeLessThan(1e-9);
    // limits
    expect(r.battChargeKw[k]).toBeGreaterThanOrEqual(0);
    expect(r.battChargeKw[k]).toBeLessThanOrEqual(c.battKw + 1e-9);
    expect(r.battDischargeKw[k]).toBeGreaterThanOrEqual(0);
    expect(r.battDischargeKw[k]).toBeLessThanOrEqual(c.battKw + 1e-9);
    expect(r.evKw[k]).toBeGreaterThanOrEqual(0);
    expect(r.evKw[k]).toBeLessThanOrEqual(c.evKw * sc.evPlugged[k] + 1e-9);
    expect(r.gridImportKw[k] * r.gridExportKw[k]).toBe(0);
    // SoC recursion and bounds
    const next = r.socKwh[k] + (sq * r.battChargeKw[k] - r.battDischargeKw[k] / sq) * DT_H;
    expect(Math.abs(next - r.socKwh[k + 1])).toBeLessThan(tol);
    expect(r.socKwh[k + 1]).toBeGreaterThanOrEqual(0);
    expect(r.socKwh[k + 1]).toBeLessThanOrEqual(c.battKwh);
    cost += (sc.buy[k] * r.gridImportKw[k] - sc.sell[k] * r.gridExportKw[k]) * DT_H;
  }
  expect(Math.abs(cost - r.totalCost)).toBeLessThan(1e-9);
  expect(r.cumCost[sc.n]).toBeCloseTo(r.totalCost, 12);
  // EV deadlines (delivered >= need exactly)
  for (const s of sc.evSessions) {
    let e = 0;
    for (let k = s.arriveStep; k < s.departStep; k++) e += r.evKw[k] * DT_H;
    expect(e).toBeGreaterThanOrEqual(s.needKwh);
    expect(e).toBeLessThan(s.needKwh + 1e-6);
  }
}

describe('scenario (pure)', () => {
  it('is bit-identical for the same seed and events, and differs across seeds', () => {
    const a = buildScenario(cfg, events);
    const b = buildScenario(cfg, events);
    for (const key of ['buy', 'sell', 'cloud', 'pvKw', 'loadKw', 'clearSkyKw', 'clockHour'] as const) {
      expect(same(a[key], b[key])).toBe(true);
    }
    const c = buildScenario({ ...cfg, seed: cfg.seed + 1 }, events);
    expect(same(a.pvKw, c.pvKw)).toBe(false);
  });

  it('moving an event changes only the steps it covers', () => {
    const a = buildScenario(cfg, events);
    const moved = events.map((e) => (e.id === 'spike-2' ? { ...e, startStep: e.startStep + 10 } : e));
    const b = buildScenario(cfg, moved);
    const spike = events.find((e) => e.id === 'spike-2')!;
    const lo = spike.startStep;
    const hi = spike.startStep + 10 + spike.durationSteps;
    for (let k = 0; k < a.n; k++) {
      if (k < lo || k >= hi) {
        expect(a.buy[k]).toBe(b.buy[k]);
        expect(a.sell[k]).toBe(b.sell[k]);
      }
      expect(a.pvKw[k]).toBe(b.pvKw[k]);
      expect(a.loadKw[k]).toBe(b.loadKw[k]);
    }
  });

  it('has the demo events, stable ids, and the documented shape', () => {
    expect(events.filter((e) => e.kind === 'priceSpike').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.kind === 'cloud').length).toBeGreaterThanOrEqual(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(defaultEvents(cfg)).toEqual(events);
    const sc = buildScenario(cfg, events);
    expect(sc.n).toBe(96);
    expect(sc.evSessions).toHaveLength(2);
    for (const s of sc.evSessions) expect(s.needKwh).toBe(40);
    const days = Array.from(sc.loadKw).reduce((a, b) => a + b, 0) * DT_H / 2;
    expect(days).toBeGreaterThan(18);
    expect(days).toBeLessThan(22);
    expect(Math.max(...sc.clearSkyKw)).toBeGreaterThan(5);
    expect(Math.max(...sc.clearSkyKw)).toBeLessThan(5.6);
  });

  it('keeps 0 < S <= B - 0.02 and cloud in 0..1 under extreme events', () => {
    const extreme: ScenarioEvent[] = [
      { id: 'a', kind: 'priceSpike', startStep: 10, durationSteps: 8, magnitude: 1.5 },
      { id: 'b', kind: 'priceSpike', startStep: 12, durationSteps: 8, magnitude: 1.5 },
      { id: 'c', kind: 'cloud', startStep: 20, durationSteps: 40, magnitude: 1 },
      { id: 'd', kind: 'cloud', startStep: 30, durationSteps: 40, magnitude: 1 },
    ];
    for (const evs of [events, extreme, []]) {
      const sc = buildScenario(cfg, evs);
      for (let k = 0; k < sc.n; k++) {
        expect(sc.sell[k]).toBeGreaterThan(0);
        expect(sc.sell[k]).toBeLessThanOrEqual(sc.buy[k] - 0.02 + 1e-12);
        expect(sc.cloud[k]).toBeGreaterThanOrEqual(0);
        expect(sc.cloud[k]).toBeLessThanOrEqual(1);
        expect(sc.pvKw[k]).toBeLessThanOrEqual(sc.clearSkyKw[k] + 1e-12);
        expect(sc.pvKw[k]).toBeGreaterThanOrEqual(0);
      }
    }
    const sc = buildScenario(cfg, []);
    expect(Math.min(...sc.buy)).toBeGreaterThan(0.15);
    expect(Math.max(...sc.buy)).toBeLessThan(0.45);
  });

  it('puts the sun where Christchurch would see it (NZDT)', () => {
    let best = { h: 0, el: -90 };
    let rise = NaN;
    let set = NaN;
    let prev = sunPosition(cfg, 0).elevationDeg;
    for (let t = 0; t <= 24; t += 1 / 60) {
      const p = sunPosition(cfg, t);
      if (p.elevationDeg > best.el) best = { h: cfg.startHour + t, el: p.elevationDeg };
      if (prev < 0 && p.elevationDeg >= 0 && Number.isNaN(rise)) rise = cfg.startHour + t;
      if (prev > 0 && p.elevationDeg <= 0 && Number.isNaN(set)) set = cfg.startHour + t;
      prev = p.elevationDeg;
    }
    expect(best.h).toBeGreaterThan(13.0);
    expect(best.h).toBeLessThan(13.5);
    expect(best.el).toBeGreaterThan(62);
    expect(best.el).toBeLessThan(66);
    expect(set).toBeGreaterThan(20.1);
    expect(set).toBeLessThan(20.6);
    const dawn = sunPosition(cfg, 30.1 - cfg.startHour);
    expect(Math.abs(dawn.elevationDeg)).toBeLessThan(1);
    expect(rise).toBeGreaterThan(29.9); // first sunrise is the morning of day 1 (06:04)
    expect(rise).toBeLessThan(30.3);
    const noon = sunPosition(cfg, 13.25 - cfg.startHour);
    expect(Math.min(noon.azimuthDeg, 360 - noon.azimuthDeg)).toBeLessThan(5); // north
    const morning = sunPosition(cfg, 9 - cfg.startHour);
    expect(morning.azimuthDeg).toBeGreaterThan(30);
    expect(morning.azimuthDeg).toBeLessThan(90); // north-east
    // smooth: no jumps between 1-minute samples
    let last = sunPosition(cfg, 0);
    for (let t = 1 / 60; t < 24; t += 1 / 60) {
      const p = sunPosition(cfg, t);
      expect(Math.abs(p.elevationDeg - last.elevationDeg)).toBeLessThan(0.5);
      last = p;
    }
  });
});

describe('forecasts', () => {
  const sc = buildScenario(cfg, events);

  it('are exact at lead 0, bounded, consistent and convergent', () => {
    const f0 = forecastAt(sc, 30);
    expect(f0.buy[0]).toBe(sc.buy[30]);
    expect(f0.pvKw[0]).toBe(sc.pvKw[30]);
    expect(f0.loadKw[0]).toBe(sc.loadKw[30]);
    expect(f0.length).toBe(48);
    expect(forecastAt(sc, 80).length).toBe(16);
    for (let k = 0; k < sc.n; k += 7) {
      const f = forecastAt(sc, k);
      for (let j = 0; j < f.length; j++) {
        expect(f.sell[j]).toBeGreaterThan(0);
        expect(f.sell[j]).toBeLessThan(f.buy[j]);
        expect(f.pvKw[j]).toBeGreaterThanOrEqual(0);
        expect(f.pvKw[j]).toBeLessThanOrEqual(sc.clearSkyKw[k + j] + 1e-12);
        expect(f.loadKw[j]).toBeGreaterThan(0);
      }
    }
    // error shrinks as the target approaches
    let farErr = 0;
    let nearErr = 0;
    for (let t = 50; t < 90; t++) {
      farErr += Math.abs(forecastAt(sc, t - 40).pvKw[40] - sc.pvKw[t]);
      nearErr += Math.abs(forecastAt(sc, t - 4).pvKw[4] - sc.pvKw[t]);
    }
    expect(nearErr).toBeLessThan(farErr);
    // noise is keyed on the target step: same-target forecasts from adjacent steps are close
    const a = forecastAt(sc, 40).loadKw[10];
    const b = forecastAt(sc, 41).loadKw[9];
    expect(Math.abs(a - b)).toBeLessThan(0.6);
  });

  it('equal the realised series at forecastError = 0', () => {
    const exact = buildScenario({ ...cfg, forecastError: 0 }, events);
    for (let k = 0; k < exact.n; k += 5) {
      const f = forecastAt(exact, k);
      for (let j = 0; j < f.length; j++) {
        expect(f.buy[j]).toBe(exact.buy[k + j]);
        expect(f.sell[j]).toBe(exact.sell[k + j]);
        expect(f.pvKw[j]).toBe(exact.pvKw[k + j]);
        expect(f.loadKw[j]).toBe(exact.loadKw[k + j]);
      }
    }
  });

  it('reveal a dragged event only as it approaches', () => {
    const big = buildScenario(cfg, [...events, { id: 'x', kind: 'priceSpike', startStep: 70, durationSteps: 4, magnitude: 1 }]);
    const near = forecastAt(big, 66).buy[5]; // lead 4 steps
    const far = forecastAt(big, 30).buy[40]; // lead 40 steps
    expect(near - big.buyBase[71]).toBeGreaterThan(far - big.buyBase[70] + 0.3);
  });
});

describe('solvers', () => {
  beforeAll(async () => {
    const label = await initSolver();
    expect(label).toMatch(/HiGHS/);
  });

  it('initSolver is idempotent', async () => {
    expect(await initSolver()).toBe(await initSolver());
  });

  it('DP, MPC and the hindsight LP are feasible and consistent on the default scenario', () => {
    const sc = buildScenario(cfg, events);
    const lp = solveHindsightLp(sc);
    const dp = solveDp(sc);
    const mpc = solveMpc(sc);
    checkPolicy(sc, lp);
    checkPolicy(sc, dp);
    checkPolicy(sc, mpc);
    expect(mpc.totalCost).toBeGreaterThanOrEqual(lp.totalCost - 1e-6);
    expect(mpc.totalCost - lp.totalCost).toBeGreaterThan(0.05); // forecastError 0.5 leaves a visible gap
    expect(dp.totalCost).toBeGreaterThanOrEqual(lp.totalCost - 1e-6);
    expect(Math.abs(dp.totalCost - lp.totalCost)).toBeLessThan(Math.max(0.03, 0.005 * lp.totalCost));
    expect(mpcFallbackCount()).toBe(0);
  });

  it('keeps DP within tolerance of the LP optimum and MPC above it across seeds and settings', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const fe of [0, 0.5, 1]) {
        const c = { ...cfg, seed: seed * 104729, forecastError: fe };
        const sc = buildScenario(c, defaultEvents(c));
        const lp = solveHindsightLp(sc);
        const dp = solveDp(sc);
        const mpc = solveMpc(sc);
        expect(Math.abs(dp.totalCost - lp.totalCost)).toBeLessThan(Math.max(0.03, 0.005 * lp.totalCost));
        expect(mpc.totalCost).toBeGreaterThanOrEqual(lp.totalCost - 1e-6);
        if (fe === 0) expect(mpc.totalCost - lp.totalCost).toBeLessThan(0.03);
      }
    }
  });

  it('MPC at forecastError = 0 matches the exact optimum closely, and the gap grows with the error', () => {
    const gaps = [0, 0.5, 1].map((fe) => {
      const c = { ...cfg, forecastError: fe };
      const sc = buildScenario(c, defaultEvents(c));
      return solveMpc(sc).totalCost - solveHindsightLp(sc).totalCost;
    });
    expect(gaps[0]).toBeLessThan(0.005);
    expect(gaps[0]).toBeGreaterThanOrEqual(-1e-6);
    expect(gaps[1]).toBeGreaterThan(gaps[0] + 0.05);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
  });

  it('handles awkward configurations (short horizon, tiny battery, no PV, 1 day)', () => {
    const variants: Partial<SimConfig>[] = [
      { mpcHorizonSteps: 8 },
      { battKwh: 2, battKw: 1 },
      { pvKwp: 0 },
      { days: 1 },
      { days: 3 },
      { battInitFrac: 0.2, evNeedKwh: 20 },
    ];
    for (const v of variants) {
      const c = { ...cfg, ...v };
      const sc = buildScenario(c, defaultEvents(c));
      const lp = solveHindsightLp(sc);
      const dp = solveDp(sc);
      const mpc = solveMpc(sc);
      checkPolicy(sc, dp);
      checkPolicy(sc, mpc);
      expect(mpc.totalCost).toBeGreaterThanOrEqual(lp.totalCost - 1e-6);
      expect(Math.abs(dp.totalCost - lp.totalCost)).toBeLessThan(Math.max(0.03, 0.005 * Math.abs(lp.totalCost)));
    }
    expect(mpcFallbackCount()).toBe(0);
  });

  it('DP stays within 0.5 c of the exact LP on extreme spikes, and an identical solveAll request reuses the DP', () => {
    for (const seed of [1, 7]) {
      const c = { ...cfg, seed, forecastError: 0 };
      for (const spike of [
        { id: 's', kind: 'priceSpike' as const, startStep: 95, durationSteps: 1, magnitude: 1.5 },
        { id: 's', kind: 'priceSpike' as const, startStep: 94, durationSteps: 10, magnitude: 1.5 },
      ]) {
        const sc = buildScenario(c, [spike]);
        const gap = solveDp(sc).totalCost - solveHindsightLp(sc).totalCost;
        expect(gap).toBeGreaterThanOrEqual(-1e-6);
        expect(gap).toBeLessThan(0.005);
      }
    }
    clearMpcCache();
    const a = solveAll(1, cfg, events);
    const b = solveAll(2, cfg, events);
    expect(b.timing.dpMs).toBeLessThan(a.timing.dpMs / 5);
    expect(b.timing.lpSolves).toBe(0);
    expect(b.dp.totalCost).toBe(a.dp.totalCost);
  });

  it('DP options: no grid charging and no battery', () => {
    const sc = buildScenario(cfg, events);
    const full = solveDp(sc);
    const noGrid = solveDp(sc, { allowGridCharge: false });
    const noBatt = solveDp(sc, { battery: false });
    checkPolicy(sc, noGrid);
    checkPolicy(sc, noBatt);
    for (let k = 0; k < sc.n; k++) {
      const surplus = Math.max(0, sc.pvKw[k] - sc.loadKw[k] - noGrid.evKw[k]);
      expect(noGrid.battChargeKw[k]).toBeLessThanOrEqual(surplus + 1e-9);
      expect(noBatt.battChargeKw[k]).toBe(0);
      expect(noBatt.battDischargeKw[k]).toBe(0);
    }
    expect(noGrid.totalCost).toBeGreaterThanOrEqual(full.totalCost - 1e-3);
    expect(noBatt.totalCost).toBeGreaterThan(noGrid.totalCost);
  });

  it('solveAll with a reused MPC prefix is identical to a from-scratch solve', () => {
    clearMpcCache();
    const base = solveAll(1, cfg, events);
    expect(base.timing.mpcFromStep).toBe(0);
    expect(base.timing.lpSolves).toBe(96);
    expect(base.solver).toMatch(/HiGHS/);

    // Move a late event: the MPC prefix before its forecast footprint is reused.
    const moved = events.map((e) => (e.id === 'cloud-2' ? { ...e, startStep: e.startStep + 12 } : e));
    const reused = solveAll(2, cfg, moved);
    expect(reused.timing.mpcFromStep).toBeGreaterThan(0);
    expect(reused.timing.lpSolves).toBe(96 - reused.timing.mpcFromStep);
    clearMpcCache();
    const scratch = solveAll(3, cfg, moved);
    expect(scratch.timing.mpcFromStep).toBe(0);
    expect(same(reused.mpc.battChargeKw, scratch.mpc.battChargeKw)).toBe(true);
    expect(same(reused.mpc.battDischargeKw, scratch.mpc.battDischargeKw)).toBe(true);
    expect(same(reused.mpc.evKw, scratch.mpc.evKw)).toBe(true);
    expect(same(reused.mpc.socKwh, scratch.mpc.socKwh)).toBe(true);
    expect(reused.mpc.totalCost).toBe(scratch.mpc.totalCost);
    expect(same(reused.dp.stepCost, scratch.dp.stepCost)).toBe(true);

    // Moving it back reuses again, and an unchanged request re-solves nothing.
    const back = solveAll(4, cfg, events);
    expect(back.mpc.totalCost).toBe(base.mpc.totalCost);
    const again = solveAll(5, cfg, events);
    expect(again.timing.lpSolves).toBe(0);
    expect(again.mpc.totalCost).toBe(base.mpc.totalCost);
    // A config change invalidates the cache.
    const other = solveAll(6, { ...cfg, forecastError: 0.9 }, events);
    expect(other.timing.mpcFromStep).toBe(0);
  });

  it('survives thousands of consecutive LP solves and recovers from a replaced runtime', async () => {
    const t0 = performance.now();
    let solves = 0;
    for (let i = 0; i < 40; i++) {
      const c = { ...cfg, forecastError: (i % 5) / 4 };
      const r = solveAll(i, c, i % 2 ? events : events.slice(0, 3));
      solves += r.timing.lpSolves;
    }
    expect(solves).toBeGreaterThan(1500);
    const before = solverRecoveries();
    await spareReady();
    expect(recoverSolver()).toBe(true); // swap in the stand-by runtime, as after an abort
    expect(solverRecoveries()).toBe(before + 1);
    const sc = buildScenario(cfg, events);
    const mpc = solveMpc(sc);
    checkPolicy(sc, mpc);
    expect(mpcFallbackCount()).toBe(0);
    expect(performance.now() - t0).toBeLessThan(20000);
  });
});

describe('arbitrage insight', () => {
  beforeAll(async () => {
    await initSolver();
  });

  it('reports the default scenario honestly (shifting pays, re-exporting does not)', () => {
    const sc = buildScenario(cfg, events);
    const dp = solveDp(sc);
    const ins = computeInsight(7, sc, dp);
    expect(ins.reqId).toBe(7);
    expect(ins.dpCost).toBe(dp.totalCost);
    expect(ins.noGridChargeCost).toBeGreaterThanOrEqual(ins.dpCost - 1e-3);
    expect(ins.noBatteryCost).toBeGreaterThan(ins.noGridChargeCost);
    expect(ins.arbitrageValue).toBeCloseTo(Math.max(0, ins.noGridChargeCost - ins.dpCost), 12);
    expect(ins.arbitrageValuePerDay).toBeCloseTo(ins.arbitrageValue / 2, 12);
    expect(ins.gridChargedKwh).toBeGreaterThan(1);
    expect(ins.bestShiftSpread).toBeGreaterThan(0.1);
    expect(ins.bestExportSpread).toBeLessThan(0);
    expect(ins.arbitrageExportKwh).toBeLessThan(0.1);
    expect(ins.pays).toBe(true);
    expect(ins.exportPays).toBe(false);
    expect(ins.headline.length).toBeLessThan(230);
    expect(ins.headline).toContain(`$${ins.arbitrageValuePerDay.toFixed(2)}/day`);
    expect(ins.headline).toContain('never pays');
  });

  it('flips truthfully when a huge evening spike makes buy-then-export profitable', () => {
    const big: ScenarioEvent = { id: 'big', kind: 'priceSpike', startStep: 36, durationSteps: 6, magnitude: 1.0 };
    const sc = buildScenario(cfg, [...events, big]);
    const ins = computeInsight(1, sc, solveDp(sc));
    expect(ins.bestExportSpread).toBeGreaterThan(0.05);
    expect(ins.exportPays).toBe(true);
    expect(ins.arbitrageExportKwh).toBeGreaterThan(1);
    expect(ins.arbitrageExportKwh).toBeLessThanOrEqual(ins.gridChargedKwh * cfg.battRoundTrip + 1e-9);
    expect(ins.arbitrageExportKwh).toBeLessThanOrEqual(ins.batteryExportedKwh + 1e-9);
    expect(ins.pays).toBe(true);
    expect(ins.headline).not.toContain('never pays');
    expect(ins.headline.length).toBeLessThan(230);
    const base = computeInsight(1, buildScenario(cfg, events), solveDp(buildScenario(cfg, events)));
    expect(ins.arbitrageValue).toBeGreaterThan(base.arbitrageValue);
  });

  it('says arbitrage is worth ~nothing when losses eat the spread', () => {
    const c = { ...cfg, battRoundTrip: 0.3 };
    const sc = buildScenario(c, defaultEvents(c));
    const ins = computeInsight(1, sc, solveDp(sc));
    expect(ins.pays).toBe(false);
    expect(ins.exportPays).toBe(false);
    expect(ins.headline).toContain('almost nothing');
    expect(ins.headline.length).toBeLessThan(230);
  });
});
