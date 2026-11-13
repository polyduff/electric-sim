import type { Basis } from 'highs';
import { DT_H } from '../shared/types';
import type { Forecast, PolicyResult, Scenario } from '../shared/types';
import {
  COL_C,
  COL_D,
  COL_E,
  COL_G,
  COL_S,
  COL_X,
  EnergyLp,
  lpStructureKey,
  VARS_PER_STEP,
} from './energyLp';
import { forecastAt } from './forecast';
import { assembleResult, batteryEff, initialSocKwh, settleEvSessions } from './result';
import { loadMeanKw, MEAN_CLOUD_ATTENUATION } from './scenario';

// ---------------------------------------------------------------------------
// Tuning knobs (exported for benchmarks / experiments; defaults are what ships)
// ---------------------------------------------------------------------------

export interface MpcTuning {
  /**
   * Value of energy left in the battery at the end of a truncated horizon:
   * - 'baselineDual': shadow price of stored energy at that time of day, taken
   *   from one deterministic "climatology" LP (see terminalValues()).
   * - 'none': zero (the MPC drains the battery by the end of each horizon).
   * - a number: that multiple of the mean forecast buy price over the horizon.
   */
  terminal: 'baselineDual' | 'none' | number;
  /**
   * 'basis': every LP is started from the previous step's stored optimal basis
   * (deterministic: the result does not depend on solver history).
   * 'keep': continue from HiGHS's internal state. 'cold': no warm start.
   */
  warmStart: 'basis' | 'keep' | 'cold';
}

export const mpcTuning: MpcTuning = { terminal: 'baselineDual', warmStart: 'basis' };

// ---------------------------------------------------------------------------
// Filling the LP for a window [k, k + len) of the scenario
// ---------------------------------------------------------------------------

interface AppliedState {
  charge: Float64Array;
  discharge: Float64Array;
  ev: Float64Array;
  gridImport: Float64Array;
  gridExport: Float64Array;
  /** soc[t] = SoC at the start of step t; length n + 1. */
  soc: Float64Array;
}

function newAppliedState(n: number, initSoc: number): AppliedState {
  const soc = new Float64Array(n + 1);
  soc[0] = initSoc;
  return {
    charge: new Float64Array(n),
    discharge: new Float64Array(n),
    ev: new Float64Array(n),
    gridImport: new Float64Array(n),
    gridExport: new Float64Array(n),
    soc,
  };
}

/**
 * Writes costs and bounds for "decide steps k .. k+len-1 given this data".
 *
 * - Steps before k are history: every variable is fixed at what was applied.
 * - Steps inside the window use the supplied prices / PV / load (index j = t - k).
 * - Steps after the window are made inert: the battery row that would tie them
 *   to the window is freed, their battery is switched off and their grid energy
 *   is free, so they constrain nothing. The only link is an EV session that
 *   straddles the window end: energy deferred past the window is charged at
 *   `evDeferCost` ($/kWh), and physical feasibility of the deferral is kept.
 * - If the window ends at the scenario end, the final SoC must be >= the
 *   initial SoC. Otherwise stored energy at the window end is credited at
 *   `terminalValue` ($/kWh).
 *
 * The arrays are rewritten completely on every call, so the LP is a pure
 * function of (scenario, k, data, history).
 */
function fillWindow(
  lp: EnergyLp,
  scenario: Scenario,
  k: number,
  len: number,
  buy: Float64Array,
  sell: Float64Array,
  pv: Float64Array,
  load: Float64Array,
  past: AppliedState | null,
  terminalValue: number,
  evDeferCost: number,
): void {
  const n = lp.n;
  const cfg = scenario.config;
  const cap = cfg.battKwh;
  const init = initialSocKwh(scenario);
  const kEnd = k + len;
  const cost = lp.colCost;
  const lo = lp.colLower;
  const up = lp.colUpper;
  const rl = lp.rowLower;
  const ru = lp.rowUpper;
  const plugged = scenario.evPlugged;

  for (let t = 0; t < n; t++) {
    const b = VARS_PER_STEP * t;
    if (t < k && past) {
      cost[b + COL_C] = 0;
      cost[b + COL_D] = 0;
      cost[b + COL_E] = 0;
      cost[b + COL_G] = 0;
      cost[b + COL_X] = 0;
      cost[b + COL_S] = 0;
      lo[b + COL_C] = up[b + COL_C] = past.charge[t];
      lo[b + COL_D] = up[b + COL_D] = past.discharge[t];
      lo[b + COL_E] = up[b + COL_E] = past.ev[t];
      lo[b + COL_G] = up[b + COL_G] = past.gridImport[t];
      lo[b + COL_X] = up[b + COL_X] = past.gridExport[t];
      lo[b + COL_S] = up[b + COL_S] = past.soc[t + 1];
      rl[t] = ru[t] = scenario.loadKw[t] - scenario.pvKw[t];
    } else if (t < kEnd) {
      const j = t - k;
      cost[b + COL_C] = 0;
      cost[b + COL_D] = 0;
      cost[b + COL_E] = 0;
      cost[b + COL_G] = DT_H * buy[j];
      cost[b + COL_X] = -DT_H * sell[j];
      cost[b + COL_S] = 0;
      lo[b + COL_C] = 0;
      up[b + COL_C] = cfg.battKw;
      lo[b + COL_D] = 0;
      up[b + COL_D] = cfg.battKw;
      lo[b + COL_E] = 0;
      up[b + COL_E] = plugged[t] ? cfg.evKw : 0;
      lo[b + COL_G] = 0;
      up[b + COL_G] = Infinity;
      lo[b + COL_X] = 0;
      up[b + COL_X] = Infinity;
      lo[b + COL_S] = 0;
      up[b + COL_S] = cap;
      rl[t] = ru[t] = load[j] - pv[j];
    } else {
      cost[b + COL_C] = 0;
      cost[b + COL_D] = 0;
      cost[b + COL_E] = DT_H * evDeferCost;
      cost[b + COL_G] = 0;
      cost[b + COL_X] = 0;
      cost[b + COL_S] = 0;
      lo[b + COL_C] = up[b + COL_C] = 0;
      lo[b + COL_D] = up[b + COL_D] = 0;
      lo[b + COL_E] = 0;
      up[b + COL_E] = plugged[t] ? cfg.evKw : 0;
      lo[b + COL_G] = 0;
      up[b + COL_G] = Infinity;
      lo[b + COL_X] = 0;
      up[b + COL_X] = Infinity;
      lo[b + COL_S] = 0;
      up[b + COL_S] = cap;
      rl[t] = ru[t] = 0;
    }
    rl[n + t] = ru[n + t] = 0;
  }
  rl[n] = ru[n] = init; // S_0 - etaC*dt*C_0 + dt/etaD*D_0 = initial SoC

  if (kEnd < n) {
    cost[VARS_PER_STEP * (kEnd - 1) + COL_S] = -terminalValue;
    rl[n + kEnd] = -Infinity; // cut the battery chain after the window
    ru[n + kEnd] = Infinity;
  }
  // Final state of charge >= initial (applies to the window only when it reaches the end).
  if (n - 1 >= k) lo[VARS_PER_STEP * (n - 1) + COL_S] = init;

  const sessions = scenario.evSessions;
  for (let i = 0; i < sessions.length; i++) {
    rl[2 * n + i] = ru[2 * n + i] = sessions[i].needKwh;
  }
}

// ---------------------------------------------------------------------------
// LP workspaces
// ---------------------------------------------------------------------------

let sharedLp: EnergyLp | null = null;

/** The persistent LP used by the MPC; rebuilt only when the constraint structure changes. */
function mpcLp(scenario: Scenario): EnergyLp {
  const key = lpStructureKey(scenario);
  if (!sharedLp || sharedLp.key !== key) {
    sharedLp?.dispose();
    sharedLp = new EnergyLp(scenario);
  }
  return sharedLp;
}

// ---------------------------------------------------------------------------
// Terminal value of stored energy
// ---------------------------------------------------------------------------

interface TerminalValues {
  key: string;
  /** value[T] = $/kWh for energy in the battery at the start of step T. */
  value: Float64Array;
  evDeferCost: number;
}

let terminalCache: TerminalValues | null = null;

function terminalKey(scenario: Scenario): string {
  const { seed: _seed, forecastError: _fe, mpcHorizonSteps: _h, ...rest } = scenario.config;
  return JSON.stringify(rest);
}

/**
 * Terminal value for truncated horizons.
 *
 * A 24 h horizon that ends in the middle of the scenario says nothing about
 * what stored energy is worth afterwards; with no terminal value the LP would
 * plan to empty the battery by the end of every horizon. We price leftover
 * energy at its shadow price in a deterministic baseline plan: one LP over the
 * whole scenario using only what is known for certain in advance (the TOU
 * tariff, clear-sky PV times the climatological mean cloud attenuation, the
 * mean load profile, the EV schedule; no noise, no events). The dual of the
 * battery equation at step T is the marginal value of a kWh held at T: low in
 * the middle of a sunny day (it only displaces feed-in), high before the
 * evening peak. It depends on the config alone, so it never changes during a
 * drag and costs one extra LP per configuration.
 */
function terminalValues(scenario: Scenario): TerminalValues {
  const key = terminalKey(scenario);
  if (terminalCache && terminalCache.key === key) return terminalCache;
  const n = scenario.n;
  const value = new Float64Array(n + 1);
  let evDeferCost = Infinity;
  for (let t = 0; t < n; t++) evDeferCost = Math.min(evDeferCost, scenario.buyBase[t]);
  if (!Number.isFinite(evDeferCost)) evDeferCost = 0;

  const pv = new Float64Array(n);
  const load = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    pv[t] = scenario.clearSkyKw[t] * MEAN_CLOUD_ATTENUATION;
    load[t] = loadMeanKw(scenario.clockHour[t]);
  }
  const lp = new EnergyLp(scenario);
  try {
    fillWindow(lp, scenario, 0, n, scenario.buyBase, scenario.sellBase, pv, load, null, 0, 0);
    const sol = lp.solve('cold');
    if (sol.ok) {
      // Row n + T: energy injected there is available from step T onwards.
      for (let t = 0; t < n; t++) value[t] = Math.max(0, -sol.rowDual[n + t]);
    }
  } finally {
    lp.dispose();
  }
  terminalCache = { key, value, evDeferCost };
  return terminalCache;
}

// ---------------------------------------------------------------------------
// MPC
// ---------------------------------------------------------------------------

export interface MpcRun {
  result: PolicyResult;
  /** First step that was actually re-solved (n if everything was reused). */
  fromStep: number;
  lpSolves: number;
  /** Steps where the LP failed and the safe fallback action was applied. */
  fallbacks: number;
  simplexIterations: number;
}

interface MpcCache {
  configKey: string;
  structureKey: string;
  n: number;
  forecasts: Forecast[];
  basis: (Basis | null)[];
  applied: AppliedState;
  fallbackAt: Uint8Array;
}

let mpcCache: MpcCache | null = null;
let totalFallbacks = 0;

/** Total number of fallback actions since the module was loaded (expected: 0). */
export function mpcFallbackCount(): number {
  return totalFallbacks;
}

export function clearMpcCache(): void {
  mpcCache = null;
}

function sameSeries(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameForecast(a: Forecast, b: Forecast): boolean {
  return (
    a.length === b.length &&
    sameSeries(a.buy, b.buy) &&
    sameSeries(a.sell, b.sell) &&
    sameSeries(a.pvKw, b.pvKw) &&
    sameSeries(a.loadKw, b.loadKw)
  );
}

/**
 * Rolling-horizon MPC. With `reuse`, the previous run's prefix is kept up to
 * the first step whose inputs (the forecast issued at that step, which
 * includes the realised values of the step itself) differ from last time.
 */
export function runMpc(scenario: Scenario, reuse: boolean): MpcRun {
  const cfg = scenario.config;
  const n = scenario.n;
  const { etaC, etaD } = batteryEff(scenario);
  const init = initialSocKwh(scenario);
  const cap = cfg.battKwh;
  const upMax = etaC * DT_H * cfg.battKw;
  const configKey = JSON.stringify(cfg);
  const structureKey = lpStructureKey(scenario);
  const tv = terminalValues(scenario);
  const lp = mpcLp(scenario);

  // --- how much of the previous run is still valid? ---
  const forecasts: Forecast[] = new Array(n);
  let fromStep = 0;
  const prev = mpcCache;
  const canReuse =
    reuse && prev !== null && prev.configKey === configKey && prev.structureKey === structureKey && prev.n === n;
  if (canReuse && prev) {
    while (fromStep < n) {
      const f = forecastAt(scenario, fromStep);
      forecasts[fromStep] = f;
      if (!sameForecast(f, prev.forecasts[fromStep])) break;
      fromStep++;
    }
  }

  const applied = newAppliedState(n, init);
  const basis: (Basis | null)[] = new Array(n).fill(null);
  const fallbackAt = new Uint8Array(n);
  if (canReuse && prev && fromStep > 0) {
    applied.charge.set(prev.applied.charge.subarray(0, fromStep));
    applied.discharge.set(prev.applied.discharge.subarray(0, fromStep));
    applied.ev.set(prev.applied.ev.subarray(0, fromStep));
    applied.gridImport.set(prev.applied.gridImport.subarray(0, fromStep));
    applied.gridExport.set(prev.applied.gridExport.subarray(0, fromStep));
    applied.soc.set(prev.applied.soc.subarray(0, fromStep + 1));
    fallbackAt.set(prev.fallbackAt.subarray(0, fromStep));
    for (let k = 0; k < fromStep; k++) basis[k] = prev.basis[k];
  }

  // --- EV bookkeeping at fromStep ---
  const sessions = scenario.evSessions;
  const sessionOf = new Int32Array(n).fill(-1);
  sessions.forEach((s, i) => {
    for (let t = s.arriveStep; t < s.departStep; t++) sessionOf[t] = i;
  });
  let delivered = 0;
  if (fromStep > 0 && fromStep < n && sessionOf[fromStep] >= 0) {
    const s = sessions[sessionOf[fromStep]];
    for (let t = s.arriveStep; t < fromStep; t++) delivered += applied.ev[t] * DT_H;
  }

  let lpSolves = 0;
  let fallbacks = 0;
  let iterations = 0;
  const solvesBefore = lp.solves;

  for (let k = fromStep; k < n; k++) {
    const f = forecasts[k] ?? forecastAt(scenario, k);
    forecasts[k] = f;
    const kEnd = k + f.length;

    let terminal = 0;
    if (kEnd < n) {
      const mode = mpcTuning.terminal;
      if (mode === 'baselineDual') terminal = tv.value[kEnd];
      else if (typeof mode === 'number') {
        let mean = 0;
        for (let j = 0; j < f.length; j++) mean += f.buy[j];
        terminal = (mode * mean) / f.length;
      }
    }
    fillWindow(lp, scenario, k, f.length, f.buy, f.sell, f.pvKw, f.loadKw, applied, terminal, tv.evDeferCost);

    let start: Basis | 'cold' | 'keep' = 'cold';
    if (k > 0 && mpcTuning.warmStart !== 'cold') {
      const b = basis[k - 1];
      if (mpcTuning.warmStart === 'keep') start = k > fromStep ? 'keep' : (b ?? 'cold');
      else start = b ?? 'cold';
    }

    let sol;
    try {
      sol = lp.solve(start);
    } catch {
      sol = null;
    }

    // --- decide the action for step k ---
    const si = sessionOf[k];
    let remaining = 0;
    let stepsLeft = 0;
    if (si >= 0) {
      if (k === sessions[si].arriveStep) delivered = 0;
      remaining = Math.max(0, sessions[si].needKwh - delivered);
      stepsLeft = sessions[si].departStep - k;
    }

    let c: number;
    let d: number;
    let e: number;
    if (sol && sol.ok) {
      const b = VARS_PER_STEP * k;
      c = sol.x[b + COL_C];
      d = sol.x[b + COL_D];
      e = sol.x[b + COL_E];
      iterations += sol.iterations;
      basis[k] = lp.basis();
    } else {
      // Safe fallback: leave the battery alone, charge the EV at the average rate still needed.
      c = 0;
      d = 0;
      e = si >= 0 ? remaining / (stepsLeft * DT_H) : 0;
      basis[k] = null;
      fallbackAt[k] = 1;
      fallbacks++;
    }

    // --- make the action exactly feasible in the real world ---
    c = c < 1e-9 ? 0 : Math.min(c, cfg.battKw);
    d = d < 1e-9 ? 0 : Math.min(d, cfg.battKw);
    if (si >= 0) {
      const eMax = Math.min(cfg.evKw, remaining / DT_H);
      const eMin = Math.max(0, (remaining - (stepsLeft - 1) * cfg.evKw * DT_H) / DT_H);
      if (e < 1e-9) e = 0;
      if (e < eMin) e = eMin;
      if (e > eMax) e = eMax;
      if (stepsLeft === 1) e = eMax; // last chance: deliver exactly what is left
    } else {
      e = 0;
    }
    const soc = applied.soc[k];
    let socNext = soc + (etaC * c - d / etaD) * DT_H;
    if (socNext < 0) {
      d = Math.max(0, d + (socNext * etaD) / DT_H);
      socNext = soc + (etaC * c - d / etaD) * DT_H;
    } else if (socNext > cap) {
      c = Math.max(0, c - (socNext - cap) / (etaC * DT_H));
      socNext = soc + (etaC * c - d / etaD) * DT_H;
    }
    // Keep the final-SoC requirement reachable whatever happens later.
    const minNext = init - (n - k - 1) * upMax;
    if (socNext < minNext - 1e-9) {
      d = 0;
      c = Math.min(cfg.battKw, Math.max(0, (minNext - soc) / (etaC * DT_H)));
      socNext = soc + etaC * c * DT_H;
    }
    if (socNext < 0) socNext = 0;
    if (socNext > cap) socNext = cap;

    // The grid closes the balance against the REALISED load and PV (f[0] is exact).
    const net = scenario.loadKw[k] + e + c - scenario.pvKw[k] - d;
    applied.charge[k] = c;
    applied.discharge[k] = d;
    applied.ev[k] = e;
    applied.gridImport[k] = net > 0 ? net : 0;
    applied.gridExport[k] = net < 0 ? -net : 0;
    applied.soc[k + 1] = socNext;
    delivered += e * DT_H;
  }

  lpSolves = lp.solves - solvesBefore;
  totalFallbacks += fallbacks;
  mpcCache = { configKey, structureKey, n, forecasts, basis, applied, fallbackAt };

  const charge = applied.charge.slice();
  const discharge = applied.discharge.slice();
  const ev = applied.ev.slice();
  settleEvSessions(scenario, ev);
  const result = assembleResult(scenario, 'mpc', charge, discharge, ev);
  let allFallbacks = 0;
  for (let k = 0; k < n; k++) allFallbacks += fallbackAt[k];
  return { result, fromStep, lpSolves, fallbacks: allFallbacks, simplexIterations: iterations };
}

/** Rolling-horizon MPC from scratch (no prefix reuse). Requires initSolver(). */
export function solveMpc(scenario: Scenario): PolicyResult {
  return runMpc(scenario, false).result;
}

// ---------------------------------------------------------------------------
// Exact hindsight optimum (one LP over the whole scenario)
// ---------------------------------------------------------------------------

export function solveHindsightLp(scenario: Scenario): PolicyResult {
  const n = scenario.n;
  const lp = new EnergyLp(scenario);
  try {
    fillWindow(lp, scenario, 0, n, scenario.buy, scenario.sell, scenario.pvKw, scenario.loadKw, null, 0, 0);
    const sol = lp.solve('cold');
    if (!sol.ok) throw new Error('hindsight LP did not reach optimality');
    const charge = new Float64Array(n);
    const discharge = new Float64Array(n);
    const ev = new Float64Array(n);
    const cfg = scenario.config;
    for (let t = 0; t < n; t++) {
      const b = VARS_PER_STEP * t;
      charge[t] = Math.min(cfg.battKw, Math.max(0, sol.x[b + COL_C]));
      discharge[t] = Math.min(cfg.battKw, Math.max(0, sol.x[b + COL_D]));
      ev[t] = scenario.evPlugged[t] ? Math.min(cfg.evKw, Math.max(0, sol.x[b + COL_E])) : 0;
    }
    settleEvSessions(scenario, ev);
    return assembleResult(scenario, 'dp', charge, discharge, ev);
  } finally {
    lp.dispose();
  }
}
