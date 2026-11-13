import { DT_H } from '../shared/types';
import type { PolicyResult, Scenario } from '../shared/types';
import { assembleResult, batteryEff, initialSocKwh, settleEvSessions } from './result';

/**
 * Perfect-hindsight benchmark: backward dynamic programming over
 * (battery state of charge, EV energy delivered) on the realised series,
 * followed by a forward pass that extracts the trajectory.
 *
 * Discretisation (see DP_SOC_INTERVALS / DP_EV_LEVELS_PER_STEP):
 * - EV energy is on a lattice of evKw*dt/K per level (0.5 kWh by default), so
 *   "full power for a step" and the 40 kWh need are both exactly representable.
 * - Battery SoC is on a uniform grid, but actions are NOT restricted to grid
 *   transitions. The value function is linearly interpolated between grid
 *   levels and the candidate set contains every point where the piecewise
 *   linear objective can have its minimum: all grid levels within reach, the
 *   power limits, "do nothing", and the point where net grid power is exactly
 *   zero (the buy/sell kink). So the Bellman minimisation over the continuous
 *   battery action is exact for the interpolated value function, and the
 *   forward pass runs in continuous SoC. The remaining error (interpolation of
 *   a convex piecewise-linear function, EV lattice) is quantified against the
 *   exact hindsight LP in the tests.
 */
export const DP_SOC_INTERVALS = 54;
export const DP_EV_LEVELS_PER_STEP = 7;
/**
 * Second pass: with the EV schedule of the first pass held fixed, the problem
 * is a battery-only DP (no EV dimension), which is ~50x cheaper per SoC node,
 * so it runs on an 8x finer SoC grid. The better of the two trajectories (by
 * realised cost) is returned. Cuts the worst-case gap to the exact LP from
 * ~3 c to < 0.5 c on the verifier's extreme cases.
 */
export const DP_REFINE_INTERVALS = 432;

export interface DpOptions {
  /** false: the battery may charge only from PV surplus (charge <= max(0, pv - load - ev)). */
  allowGridCharge?: boolean;
  /** false: no battery at all (EV still optimally scheduled). */
  battery?: boolean;
  /** Tuning overrides, used by tests and benchmarks. */
  socIntervals?: number;
  evLevelsPerStep?: number;
  /** Battery-only refinement grid (SoC intervals); 0 disables the refinement pass. Default DP_REFINE_INTERVALS. */
  refineIntervals?: number;
  /** Internal: EV power per step held fixed (battery-only DP, used by the refinement pass). */
  fixedEvKw?: Float64Array;
}

/** Penalty ($/kWh) for finishing below the required final state of charge. */
const TERMINAL_PENALTY = 1000;
const INF = 1e30;
const TIE = 1e-12;

interface GridSpec {
  nS: number;
  ds: number;
  sBase: number;
  sTop: number;
  init: number;
  etaC: number;
  etaD: number;
  upMax: number;
  dnMax: number;
  dnSteps: number;
  dnOffGrid: boolean;
  initOffGrid: boolean;
  gridCharge: boolean;
}

/**
 * One Bellman relaxation for a fixed EV action: for every SoC grid level,
 * minimise over the battery action and keep the result if it improves on what
 * is already stored at kOff. e1 = (load + ev - pv) * dt in kWh; b / s are the
 * buy / feed-in prices; nOff is the offset of the next stage's value row.
 *
 * This is the hot loop of the DP (about a million state relaxations per
 * solve), so everything is hoisted into locals and the interpolation is
 * written out inline.
 */
function relaxStage(
  V: Float64Array,
  g: GridSpec,
  kOff: number,
  nOff: number,
  e1: number,
  b: number,
  s: number,
  last: boolean,
): void {
  const nS = g.nS;
  const NS = nS - 1;
  const ds = g.ds;
  const sBase = g.sBase;
  const sTop = g.sTop;
  const init = g.init;
  const etaC = g.etaC;
  const etaD = g.etaD;
  const dnMax = g.dnMax;
  const dnSteps = g.dnSteps;
  const dsDis = ds * etaD; // AC kWh released per grid level discharged
  const dsChg = ds / etaC; // AC kWh drawn per grid level charged
  const invDs = 1 / ds;
  const surplus = e1 < 0 ? -e1 : 0;
  const upLim = g.gridCharge ? g.upMax : Math.min(g.upMax, etaC * surplus);
  const upSteps = Math.floor(upLim * invDs + 1e-9);
  const upOffGrid = upLim - upSteps * ds > 1e-9;
  const dnOffGrid = g.dnOffGrid;

  // Net grid energy and cost of the two power-limit actions (independent of SoC).
  const netDn = e1 - dnMax * etaD;
  const costDn = netDn > 0 ? b * netDn : s * netDn;
  const netUp = e1 + upLim / etaC;
  const costUp = netUp > 0 ? b * netUp : s * netUp;
  // The zero-net action: SoC change that makes grid power exactly zero.
  const zeroDelta = e1 < 0 ? -e1 * etaC : -e1 / etaD;
  const zeroOk = e1 < 0 ? zeroDelta < upLim : e1 > 0 && -zeroDelta < dnMax;

  for (let i = 0; i < nS; i++) {
    const soc = sBase + i * ds;
    let best = V[kOff + i];

    // Grid levels at or below the current one (discharge or hold).
    let t = i - dnSteps;
    if (t < 0) t = 0;
    let net = e1 + (t - i) * dsDis;
    for (; t <= i; t++) {
      const v = (net > 0 ? b * net : s * net) + V[nOff + t];
      if (v < best) best = v;
      net += dsDis;
    }
    // Grid levels above the current one (charge).
    let tHi = i + upSteps;
    if (tHi > NS) tHi = NS;
    net = e1 + dsChg;
    for (t = i + 1; t <= tHi; t++) {
      const v = (net > 0 ? b * net : s * net) + V[nOff + t];
      if (v < best) best = v;
      net += dsChg;
    }

    // Off-grid kinks of the objective: full-power discharge / charge, zero net.
    if (dnOffGrid) {
      const x = soc - dnMax;
      if (x > sBase) {
        let v: number;
        if (last) v = x >= init - 1e-9 ? 0 : TERMINAL_PENALTY * (init - x);
        else {
          const u = (x - sBase) * invDs;
          let i0 = u | 0;
          if (i0 >= NS) i0 = NS - 1;
          const v0 = V[nOff + i0];
          v = v0 + (u - i0) * (V[nOff + i0 + 1] - v0);
        }
        v += costDn;
        if (v < best) best = v;
      }
    }
    if (upOffGrid) {
      const x = soc + upLim;
      if (x < sTop) {
        let v: number;
        if (last) v = x >= init - 1e-9 ? 0 : TERMINAL_PENALTY * (init - x);
        else {
          const u = (x - sBase) * invDs;
          let i0 = u | 0;
          if (i0 >= NS) i0 = NS - 1;
          const v0 = V[nOff + i0];
          v = v0 + (u - i0) * (V[nOff + i0 + 1] - v0);
        }
        v += costUp;
        if (v < best) best = v;
      }
    }
    if (zeroOk) {
      const x = soc + zeroDelta;
      if (x <= sTop && x >= sBase) {
        let v: number;
        if (last) v = x >= init - 1e-9 ? 0 : TERMINAL_PENALTY * (init - x);
        else {
          const u = (x - sBase) * invDs;
          let i0 = u | 0;
          if (i0 >= NS) i0 = NS - 1;
          const v0 = V[nOff + i0];
          v = v0 + (u - i0) * (V[nOff + i0 + 1] - v0);
        }
        if (v < best) best = v;
      }
    }
    if (last && g.initOffGrid) {
      const d = init - soc;
      if (d <= upLim && -d <= dnMax) {
        const n2 = e1 + (d >= 0 ? d / etaC : d * etaD);
        const v = n2 > 0 ? b * n2 : s * n2;
        if (v < best) best = v;
      }
    }
    V[kOff + i] = best;
  }
}

/** Value-function buffer reused between calls to avoid re-allocating megabytes per solve. */
let vBuffer = new Float64Array(0);

function dpPass(scenario: Scenario, opts?: DpOptions): PolicyResult {
  const cfg = scenario.config;
  const n = scenario.n;
  const { etaC, etaD } = batteryEff(scenario);
  const cap = cfg.battKwh;
  const init = initialSocKwh(scenario);
  const useBattery = opts?.battery !== false && cap > 0 && cfg.battKw > 0;
  const gridCharge = opts?.allowGridCharge !== false;

  // --- battery grid ---
  const NS = useBattery ? Math.max(2, Math.round(opts?.socIntervals ?? DP_SOC_INTERVALS)) : 0;
  const nS = NS + 1;
  const ds = useBattery ? cap / NS : 1;
  const sBase = useBattery ? 0 : init; // s = sBase + i * ds
  const sTop = useBattery ? cap : init;
  const upMax = useBattery ? etaC * DT_H * cfg.battKw : 0; // max SoC rise per step
  const dnMax = useBattery ? (DT_H * cfg.battKw) / etaD : 0; // max SoC fall per step
  const dnSteps = Math.floor(dnMax / ds + 1e-9);
  const dnOffGrid = dnMax - dnSteps * ds > 1e-9;
  const initOffGrid = useBattery && Math.abs(init / ds - Math.round(init / ds)) > 1e-9;

  // --- EV lattice ---
  const K = Math.max(1, Math.round(opts?.evLevelsPerStep ?? DP_EV_LEVELS_PER_STEP));
  const dq = (cfg.evKw * DT_H) / K;
  const fixedEv = opts?.fixedEvKw;
  const sessions = fixedEv ? [] : scenario.evSessions;
  const sessionOf = new Int32Array(n).fill(-1);
  const topLevel = new Int32Array(sessions.length);
  let NQ = 1;
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si];
    for (let k = s.arriveStep; k < s.departStep; k++) sessionOf[k] = si;
    topLevel[si] = dq > 0 ? Math.max(0, Math.ceil(s.needKwh / dq - 1e-9)) : 0;
    if (topLevel[si] + 1 > NQ) NQ = topLevel[si] + 1;
  }

  const stride = NQ * nS;
  const size = (n + 1) * stride;
  if (vBuffer.length < size) vBuffer = new Float64Array(size);
  const V = vBuffer;

  const buy = scenario.buy;
  const sell = scenario.sell;
  const pv = scenario.pvKw;
  const load = fixedEv ? Float64Array.from(scenario.loadKw, (l, k) => l + fixedEv[k]) : scenario.loadKw;

  // Terminal values: finishing below the initial SoC is (prohibitively) penalised.
  const termOff = n * stride;
  for (let i = 0; i < nS; i++) {
    const s = sBase + i * ds;
    V[termOff + i] = s >= init - 1e-9 ? 0 : TERMINAL_PENALTY * (init - s);
  }

  /** Value of arriving at SoC x in the stage stored at offset `off` (linear interpolation). */
  const valueAt = (off: number, x: number, last: boolean): number => {
    if (last) return x >= init - 1e-9 ? 0 : TERMINAL_PENALTY * (init - x);
    if (NS === 0) return V[off];
    let u = (x - sBase) / ds;
    if (u <= 0) return V[off];
    if (u >= NS) return V[off + NS];
    const i0 = Math.floor(u);
    u -= i0;
    return V[off + i0] + u * (V[off + i0 + 1] - V[off + i0]);
  };

  const grid: GridSpec = {
    nS,
    ds,
    sBase,
    sTop,
    init,
    etaC,
    etaD,
    upMax,
    dnMax,
    dnSteps,
    dnOffGrid,
    initOffGrid,
    gridCharge,
  };
  const relax = (kOff: number, nOff: number, e1: number, b: number, s: number, last: boolean): void =>
    relaxStage(V, grid, kOff, nOff, e1, b, s, last);

  // ------------------------------------------------------------------
  // Backward pass
  // ------------------------------------------------------------------
  for (let k = n - 1; k >= 0; k--) {
    const e0 = (load[k] - pv[k]) * DT_H;
    const b = buy[k];
    const s = sell[k];
    const last = k === n - 1;
    const kBase = k * stride;
    const nBase = (k + 1) * stride;
    const si = sessionOf[k];
    if (si < 0) {
      for (let i = 0; i < nS; i++) V[kBase + i] = INF;
      relax(kBase, nBase, e0, b, s, last);
      continue;
    }
    const sess = sessions[si];
    const need = sess.needKwh;
    const top = topLevel[si];
    const done = k - sess.arriveStep;
    const remaining = sess.departStep - k; // steps left including this one
    const nextPlugged = k + 1 < sess.departStep;
    const jLo = Math.max(0, top - remaining * K);
    const jHi = Math.min(top, done * K);
    for (let j = jLo; j <= jHi; j++) {
      const kOff = kBase + j * nS;
      for (let i = 0; i < nS; i++) V[kOff + i] = INF;
      const qNow = Math.min(j * dq, need);
      const aLo = Math.max(0, top - (remaining - 1) * K - j);
      const aHi = Math.min(K, top - j);
      for (let a = aLo; a <= aHi; a++) {
        const e = Math.min((j + a) * dq, need) - qNow;
        const nOff = nBase + (nextPlugged ? (j + a) * nS : 0);
        relax(kOff, nOff, e0 + e, b, s, last);
      }
    }
  }

  // ------------------------------------------------------------------
  // Forward pass in continuous SoC
  // ------------------------------------------------------------------
  const charge = new Float64Array(n);
  const discharge = new Float64Array(n);
  const ev = new Float64Array(n);

  let soc = init;
  let level = 0;
  for (let k = 0; k < n; k++) {
    const e0 = (load[k] - pv[k]) * DT_H;
    const b = buy[k];
    const s = sell[k];
    const last = k === n - 1;
    const nBase = (k + 1) * stride;
    const si = sessionOf[k];

    let aLo = 0;
    let aHi = 0;
    let need = 0;
    let nextPlugged = false;
    if (si >= 0) {
      const sess = sessions[si];
      if (k === sess.arriveStep) level = 0;
      need = sess.needKwh;
      const remaining = sess.departStep - k;
      nextPlugged = k + 1 < sess.departStep;
      aLo = Math.max(0, topLevel[si] - (remaining - 1) * K - level);
      aHi = Math.min(K, topLevel[si] - level);
    }

    let bestV = Infinity;
    let bestA = aLo;
    let bestDelta = 0;
    let bestE = 0;
    for (let a = aLo; a <= aHi; a++) {
      const e = si >= 0 ? Math.min((level + a) * dq, need) - Math.min(level * dq, need) : 0;
      const e1 = e0 + e;
      const nOff = nBase + (nextPlugged ? (level + a) * nS : 0);
      const upLim = gridCharge ? upMax : Math.min(upMax, etaC * Math.max(0, -e1));
      const lo = Math.max(sBase, soc - dnMax);
      const hi = Math.min(sTop, soc + upLim);

      const consider = (target: number): void => {
        const x = target < lo ? lo : target > hi ? hi : target;
        const d = x - soc;
        const net = e1 + (d >= 0 ? d / etaC : d * etaD);
        const v = (net > 0 ? b * net : s * net) + valueAt(nOff, x, last);
        if (v < bestV - TIE) {
          bestV = v;
          bestA = a;
          bestDelta = d;
          bestE = e;
        }
      };

      consider(soc); // hold
      if (NS > 0) {
        const tLo = Math.ceil((lo - sBase) / ds - 1e-9);
        const tHi = Math.floor((hi - sBase) / ds + 1e-9);
        for (let t = tLo; t <= tHi; t++) consider(sBase + t * ds);
        consider(lo);
        consider(hi);
        if (e1 < 0) consider(soc - e1 * etaC);
        else if (e1 > 0) consider(soc - e1 / etaD);
        if (last) consider(init);
      }
    }

    if (bestDelta > 0) charge[k] = Math.min(cfg.battKw, bestDelta / (etaC * DT_H));
    else if (bestDelta < 0) discharge[k] = Math.min(cfg.battKw, (-bestDelta * etaD) / DT_H);
    ev[k] = Math.min(cfg.evKw, bestE / DT_H);
    soc += bestDelta;
    if (soc < sBase) soc = sBase;
    if (soc > sTop) soc = sTop;
    level += bestA;
  }

  if (fixedEv) ev.set(fixedEv);
  else settleEvSessions(scenario, ev);
  return assembleResult(scenario, 'dp', charge, discharge, ev);
}

/** Perfect-hindsight DP: a coarse joint (SoC, EV) pass, then a fine battery-only refinement pass. */
export function solveDp(scenario: Scenario, opts?: DpOptions): PolicyResult {
  const first = dpPass(scenario, opts);
  const cap = scenario.config.battKwh;
  const useBattery = opts?.battery !== false && cap > 0 && scenario.config.battKw > 0;
  const refine = opts?.refineIntervals ?? DP_REFINE_INTERVALS;
  if (!useBattery || refine <= 0 || opts?.fixedEvKw) return first;
  const second = dpPass(scenario, {
    allowGridCharge: opts?.allowGridCharge,
    socIntervals: refine,
    fixedEvKw: first.evKw,
  });
  return second.totalCost < first.totalCost ? second : first;
}
