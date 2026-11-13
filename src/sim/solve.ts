import { DT_H } from '../shared/types';
import type {
  ArbitrageInsight,
  PolicyResult,
  Scenario,
  ScenarioEvent,
  SimConfig,
  SolveResult,
} from '../shared/types';
import { buildScenario } from './scenario';
import { solveDp as solveDpImpl } from './dp';
import type { DpOptions } from './dp';
import { initSolver as initSolverImpl, solverLabel } from './lp';
import type { SolverInitOptions } from './lp';
import { clearMpcCache as clearMpcCacheImpl, runMpc, solveHindsightLp as solveHindsightLpImpl, solveMpc as solveMpcImpl } from './mpc';

/**
 * Solver entry points (spec: docs/spec.md). Everything that needs the WASM LP
 * solver lives behind this module; `src/sim/index.ts` never imports it.
 */

/** Loads HiGHS (idempotent). In a browser worker pass `{ wasmUrl }`. Returns e.g. "HiGHS 1.15.1 (WASM)". */
export async function initSolver(opts?: SolverInitOptions): Promise<string> {
  await initSolverImpl(opts);
  return solverLabel();
}

/** Perfect-hindsight dynamic programme on the realised series. */
export function solveDp(
  scenario: Scenario,
  opts?: Pick<DpOptions, 'allowGridCharge' | 'battery'>,
): PolicyResult {
  return solveDpImpl(scenario, opts);
}

/** Rolling-horizon LP MPC from scratch. Requires initSolver(). */
export function solveMpc(scenario: Scenario): PolicyResult {
  return solveMpcImpl(scenario);
}

/** Exact optimum of the whole scenario as one LP (tests / calibration). Requires initSolver(). */
export function solveHindsightLp(scenario: Scenario): PolicyResult {
  return solveHindsightLpImpl(scenario);
}

export { mpcFallbackCount } from './mpc';

/** Forgets the cached MPC prefix and the cached DP result: the next solveAll runs from scratch. */
export function clearMpcCache(): void {
  clearMpcCacheImpl();
  dpCache = null;
}

/**
 * Full request: scenario, DP, MPC. The MPC keeps the previous run's prefix and
 * re-solves only from the first step whose forecast changed (see runMpc).
 */
let dpCache: { key: string; dp: PolicyResult } | null = null;

export function solveAll(reqId: number, config: SimConfig, events: ScenarioEvent[]): SolveResult {
  const t0 = performance.now();
  const scenario = buildScenario(config, events);
  const t1 = performance.now();
  // An identical request (same config and events) reuses the previous DP result.
  const key = JSON.stringify([scenario.config, scenario.events]);
  let dp: PolicyResult;
  if (dpCache && dpCache.key === key) dp = dpCache.dp;
  else {
    dp = solveDpImpl(scenario);
    dpCache = { key, dp };
  }
  const t2 = performance.now();
  const run = runMpc(scenario, true);
  const t3 = performance.now();
  return {
    reqId,
    scenario,
    mpc: run.result,
    dp,
    timing: {
      scenarioMs: t1 - t0,
      dpMs: t2 - t1,
      mpcMs: t3 - t2,
      totalMs: t3 - t0,
      lpSolves: run.lpSolves,
      mpcFromStep: run.fromStep,
    },
    solver: solverLabel(),
  };
}

// ---------------------------------------------------------------------------
// Arbitrage insight
// ---------------------------------------------------------------------------

/** Arbitrage is "material" at or above this value per day ($); below it the headline says it is worth almost nothing. */
const PAYS_PER_DAY = 0.05;
/** Battery export below this many kWh is treated as not doing export arbitrage. */
const EXPORT_MIN_KWH = 0.1;

function cents(x: number): string {
  const c = x * 100;
  return `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(1)}`;
}

/**
 * Extra DP runs (no grid charging, no battery) on the same scenario; every
 * field is computed from them and from the realised prices.
 */
export function computeInsight(reqId: number, scenario: Scenario, dp: PolicyResult): ArbitrageInsight {
  const n = scenario.n;
  const rt = scenario.config.battRoundTrip;
  const noGrid = solveDpImpl(scenario, { allowGridCharge: false });
  const noBatt = solveDpImpl(scenario, { battery: false });
  const dpCost = dp.totalCost;
  const noGridChargeCost = noGrid.totalCost;
  const noBatteryCost = noBatt.totalCost;
  const arbitrageValue = Math.max(0, noGridChargeCost - dpCost);
  const days = Math.max(1e-9, (n * DT_H) / 24);
  const arbitrageValuePerDay = arbitrageValue / days;

  let gridChargedKwh = 0;
  let batteryExportedKwh = 0;
  let noGridExportedKwh = 0;
  let eligibleExportKwh = 0;
  let minBuyBefore = Infinity;
  for (let k = 0; k < n; k++) {
    const c = dp.battChargeKw[k];
    if (c > 0) {
      const surplus = Math.max(0, scenario.pvKw[k] - scenario.loadKw[k] - dp.evKw[k]);
      gridChargedKwh += Math.max(0, c - surplus) * DT_H;
    }
    const d = dp.battDischargeKw[k];
    if (d > 0) {
      const kwh = Math.min(d, dp.gridExportKw[k]) * DT_H;
      batteryExportedKwh += kwh;
      if (rt * scenario.sell[k] > minBuyBefore) eligibleExportKwh += kwh;
    }
    minBuyBefore = Math.min(minBuyBefore, scenario.buy[k]);
    const d0 = noGrid.battDischargeKw[k];
    if (d0 > 0) noGridExportedKwh += Math.min(d0, noGrid.gridExportKw[k]) * DT_H;
  }
  // Export that exists only because the battery may charge from the grid: the extra
  // battery-to-grid energy versus the PV-only-charging run, and never more than the
  // grid-charged energy can physically deliver after losses.
  // Only exports sold above the cheapest earlier purchase (after losses) can be bought-to-export.
  const arbitrageExportKwh = Math.max(
    0,
    Math.min(batteryExportedKwh - noGridExportedKwh, gridChargedKwh * rt, eligibleExportKwh),
  );

  let minBuy = Infinity;
  let bestExportSpread = -Infinity;
  let bestShiftSpread = -Infinity;
  for (let t = 0; t < n; t++) {
    if (minBuy < Infinity) {
      bestExportSpread = Math.max(bestExportSpread, rt * scenario.sell[t] - minBuy);
      bestShiftSpread = Math.max(bestShiftSpread, rt * scenario.buy[t] - minBuy);
    }
    minBuy = Math.min(minBuy, scenario.buy[t]);
  }
  if (!Number.isFinite(bestExportSpread)) bestExportSpread = 0;
  if (!Number.isFinite(bestShiftSpread)) bestShiftSpread = 0;

  const pays = arbitrageValuePerDay >= PAYS_PER_DAY;
  const exportPays = bestExportSpread > 0 && arbitrageExportKwh >= EXPORT_MIN_KWH;

  const loss = Math.round((1 - rt) * 100);
  const perDay = `$${arbitrageValuePerDay.toFixed(2)}/day`;
  let headline: string;
  if (!pays) {
    headline =
      `Grid arbitrage is worth almost nothing here (${perDay}): the best buy-low, use-later spread is ${cents(bestShiftSpread)} c/kWh ` +
      `after ${loss}% losses, so charging from the grid barely beats solar-only charging.`;
  } else if (exportPays) {
    headline =
      `Grid arbitrage pays ${perDay} here, and the price spike makes buying to re-export profitable: ` +
      `${arbitrageExportKwh.toFixed(1)} kWh sold back at a best spread of ${cents(bestExportSpread)} c/kWh after ${loss}% losses.`;
  } else {
    const exportPart =
      bestExportSpread > 0
        ? `a re-export spread of ${cents(bestExportSpread)} c/kWh (after ${loss}% losses) exists, but stored solar already covers it, so buying to export adds almost nothing`
        : `buying to re-export never pays (best spread ${cents(bestExportSpread)} c/kWh after ${loss}% losses, since feed-in stays below the buy price)`;
    headline = `Grid arbitrage pays ${perDay} here, but only by shifting cheap imports into dearer hours; ${exportPart}.`;
  }

  return {
    reqId,
    dpCost,
    noGridChargeCost,
    noBatteryCost,
    arbitrageValue,
    arbitrageValuePerDay,
    gridChargedKwh,
    batteryExportedKwh,
    arbitrageExportKwh,
    bestExportSpread,
    bestShiftSpread,
    pays,
    exportPays,
    headline,
  };
}
