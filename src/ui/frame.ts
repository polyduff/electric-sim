/**
 * Pure mapping from simulation results to what is shown at a given time:
 * the SceneFrame for the 3D view and the HUD numbers. No DOM here.
 */
import {
  DT_H,
  type HouseFrame,
  type PolicyResult,
  type Scenario,
  type SceneFrame,
  type SolveResult,
} from '../shared/types';
import type { SimApi } from './backend';
import { clamp, clockHourAt, lerp } from './format';

export const POLICY_LABEL = {
  mpc: 'MPC · noisy forecast',
  dp: 'DP · perfect hindsight',
} as const;

export interface StepPos {
  /** Step index 0..n-1. */
  k: number;
  /** Fraction through step k, 0..1. */
  f: number;
}

export function stepPos(n: number, timeH: number): StepPos {
  const t = clamp(timeH / DT_H, 0, Math.max(0, n - 1e-6));
  const k = Math.min(n - 1, Math.floor(t));
  return { k, f: clamp(t - k, 0, 1) };
}

/**
 * Centre-anchored blend of adjacent steps (value = (1-w)*x[a] + w*x[b]). Only used for the
 * cloud cover and the pre-solve idle frame; flows shown with the cost cards use raw step values.
 */
export function blend(scenario: Scenario, p: StepPos, respectEv = true): { a: number; b: number; w: number } {
  const { n, evPlugged } = scenario;
  let a: number;
  let b: number;
  let w: number;
  if (p.f < 0.5) {
    a = Math.max(0, p.k - 1);
    b = p.k;
    w = p.f + 0.5;
  } else {
    a = p.k;
    b = Math.min(n - 1, p.k + 1);
    w = p.f - 0.5;
  }
  if (respectEv && evPlugged[a] !== evPlugged[b]) return { a: p.k, b: p.k, w: 0 };
  return { a, b, w };
}

/** Running cost at t = k + f steps: cumCost[k] + f * stepCost[k]. */
export function runningCost(r: PolicyResult, p: StepPos): number {
  return r.cumCost[p.k] + p.f * r.stepCost[p.k];
}

/** Energy the EV needs in the session that is current (or most recent) at step k; 0 before the first session. */
export function sessionNeedKwh(scenario: Scenario, k: number): number {
  let need = 0;
  for (const s of scenario.evSessions) if (s.arriveStep <= k) need = s.needKwh;
  return need;
}

export function houseFrame(scenario: Scenario, r: PolicyResult, p: StepPos): HouseFrame {
  // One source of truth with the HUD cards: the five powers are the raw step values (constant within a
  // step); the scene smooths visually. State (SoC, EV energy) is exact linear interpolation within the step.
  const k = p.k;
  const plugged = scenario.evPlugged[p.k] === 1;
  const need = sessionNeedKwh(scenario, p.k);
  const delivered = plugged ? lerp(r.evDeliveredKwh[p.k], r.evDeliveredKwh[p.k + 1], p.f) : r.evDeliveredKwh[p.k];
  return {
    policy: r.policy,
    label: POLICY_LABEL[r.policy],
    pvKw: scenario.pvKw[k],
    loadKw: scenario.loadKw[k],
    evKw: r.evKw[k],
    battKw: r.battChargeKw[k] - r.battDischargeKw[k],
    gridKw: r.gridImportKw[k] - r.gridExportKw[k],
    socFrac: clamp(lerp(r.socKwh[p.k], r.socKwh[p.k + 1], p.f) / scenario.config.battKwh, 0, 1),
    evFrac: need > 0 ? clamp(delivered / need, 0, 1) : 0,
    evPresent: plugged,
    cost: runningCost(r, p),
  };
}

/** Before the first solve: show the house idling on the grid (no dispatch known yet). */
function idleHouse(scenario: Scenario, policy: 'mpc' | 'dp', p: StepPos): HouseFrame {
  const { a, b, w } = blend(scenario, p);
  const pv = lerp(scenario.pvKw[a], scenario.pvKw[b], w);
  const load = lerp(scenario.loadKw[a], scenario.loadKw[b], w);
  return {
    policy,
    label: POLICY_LABEL[policy],
    pvKw: pv,
    loadKw: load,
    evKw: 0,
    battKw: 0,
    gridKw: load - pv,
    socFrac: scenario.config.battInitFrac,
    evFrac: 0,
    evPresent: scenario.evPlugged[p.k] === 1,
    cost: 0,
  };
}

export function buildSceneFrame(
  sim: SimApi,
  result: SolveResult | null,
  preview: Scenario,
  timeH: number,
  simSpeed: number,
): SceneFrame {
  const scenario = result ? result.scenario : preview;
  const p = stepPos(scenario.n, timeH);
  const { a, b, w } = blend(scenario, p, false);
  const sun = sim.sunPosition(scenario.config, timeH);
  return {
    timeH,
    clockH: clockHourAt(scenario.config, timeH),
    sunElevationDeg: sun.elevationDeg,
    sunAzimuthDeg: sun.azimuthDeg,
    cloud: clamp(lerp(scenario.cloud[a], scenario.cloud[b], w), 0, 1),
    houses: result
      ? [houseFrame(scenario, result.mpc, p), houseFrame(scenario, result.dp, p)]
      : [idleHouse(scenario, 'mpc', p), idleHouse(scenario, 'dp', p)],
    simSpeed,
  };
}
