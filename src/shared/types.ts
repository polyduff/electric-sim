/**
 * Shared contract between the simulator (src/sim), the 3D scene (src/scene)
 * and the UI (src/ui). Owned by the lead; see docs/spec.md.
 *
 * Units everywhere: power kW (average over the step), energy kWh, price $/kWh
 * (NZD), cost $, time in steps (integer index) or hours since scenario start.
 */

/** Step length in hours: NZ electricity market trading periods are 30 minutes. */
export const DT_H = 0.5;
export const STEPS_PER_DAY = 48;

export type Series = Float64Array;

export interface SimConfig {
  /** Seed for every stochastic generator. Same seed + events => identical scenario. */
  seed: number;
  /** Scenario length in days (default 2 => 96 steps). */
  days: number;
  /** Local clock hour at step 0 (default 7, i.e. the scenario starts at 07:00). */
  startHour: number;
  /** Day of year used for the sun (default 316 = 12 November). */
  dayOfYear: number;
  /** Site latitude in degrees, negative south (Christchurch = -43.53). */
  latitudeDeg: number;
  /** Forecast error level 0..1. 0 = the MPC sees the future perfectly within its horizon. */
  forecastError: number;
  /** MPC look-ahead in steps (default 48 = 24 h). */
  mpcHorizonSteps: number;

  pvKwp: number; // 6
  battKwh: number; // 13.5 usable
  battKw: number; // 5 (charge and discharge limit, AC side)
  battRoundTrip: number; // 0.90 (applied as sqrt on charge and sqrt on discharge)
  battInitFrac: number; // 0.5 initial state of charge; also the required final state of charge
  evNeedKwh: number; // 40 per overnight session
  evKw: number; // 7
  evArriveHour: number; // 18
  evDepartHour: number; // 7 (deadline)
}

export type EventKind = 'priceSpike' | 'cloud';

/** A user-draggable disturbance layered on top of the seeded stochastic series. */
export interface ScenarioEvent {
  id: string;
  kind: EventKind;
  /** First affected step (integer, 0 <= startStep < n). */
  startStep: number;
  /** Number of affected steps (integer >= 1). */
  durationSteps: number;
  /**
   * priceSpike: peak $/kWh added to the wholesale price component (0.05 .. 1.5).
   * cloud: extra cloud cover at the event's core (0 .. 1).
   */
  magnitude: number;
}

export interface EvSession {
  /** First step the EV is plugged in. */
  arriveStep: number;
  /** Deadline: needKwh must be delivered during steps [arriveStep, departStep). */
  departStep: number;
  needKwh: number;
}

/** Everything that actually happens (the "realised" world), per step. */
export interface Scenario {
  config: SimConfig;
  events: ScenarioEvent[];
  /** Number of steps = days * 48. */
  n: number;
  /** Local clock hour (0..24) at the start of each step. */
  clockHour: Series;
  /** Realised buy price B_t, $/kWh. */
  buy: Series;
  /** Realised feed-in price S_t, $/kWh. Invariant: 0 < S_t < B_t for every t. */
  sell: Series;
  /** Deterministic time-of-use part of B_t / S_t (what a forecaster knows for certain). */
  buyBase: Series;
  sellBase: Series;
  /** Realised cloud cover 0..1 (stochastic process + cloud events). */
  cloud: Series;
  /** PV output under a clear sky, kW. */
  clearSkyKw: Series;
  /** Realised PV output, kW. */
  pvKw: Series;
  /** Household (non-EV) load, kW. */
  loadKw: Series;
  /** 1 while the EV is plugged in during the step, else 0. */
  evPlugged: Uint8Array;
  evSessions: EvSession[];
}

/** What the MPC believes at step `issuedAtStep`. Index j refers to step issuedAtStep + j. */
export interface Forecast {
  issuedAtStep: number;
  /** Number of steps covered (<= mpcHorizonSteps, truncated at scenario end). */
  length: number;
  /** j = 0 is the current step and equals the realised value exactly. */
  buy: Series;
  sell: Series;
  pvKw: Series;
  loadKw: Series;
}

export type PolicyId = 'mpc' | 'dp';

/**
 * A dispatched trajectory. Per-step arrays have length n; state arrays have
 * length n + 1 (value at the START of step k; index n is the final state).
 *
 * Power balance, every step (no curtailment):
 *   pvKw + gridImportKw + battDischargeKw = loadKw + evKw + battChargeKw + gridExportKw
 * Battery: soc[k+1] = soc[k] + (sqrt(rt) * charge - discharge / sqrt(rt)) * DT_H
 */
export interface PolicyResult {
  policy: PolicyId;
  battChargeKw: Series;
  battDischargeKw: Series;
  evKw: Series;
  gridImportKw: Series;
  gridExportKw: Series;
  socKwh: Series;
  /** kWh delivered to the EV in the current session at the start of step k (0 outside sessions before arrival; holds its final value until the next arrival). */
  evDeliveredKwh: Series;
  /** (buy * import - sell * export) * DT_H, $. */
  stepCost: Series;
  /** cumCost[k] = sum of stepCost[0..k-1]; length n + 1. */
  cumCost: Series;
  totalCost: number;
}

export interface SolveTiming {
  scenarioMs: number;
  dpMs: number;
  mpcMs: number;
  /** Wall time inside the worker for the whole request. */
  totalMs: number;
  /** LPs actually solved for this request (may be < n when a cached prefix was reused). */
  lpSolves: number;
  /** First MPC step that had to be re-solved (0 = from scratch). */
  mpcFromStep: number;
}

export interface SolveResult {
  reqId: number;
  scenario: Scenario;
  mpc: PolicyResult;
  dp: PolicyResult;
  timing: SolveTiming;
  /** e.g. "HiGHS 1.x (WASM)". */
  solver: string;
}

/**
 * "Does grid arbitrage pay?" Everything here is computed from hindsight-optimal
 * (DP) runs of the current scenario; nothing is a constant.
 */
export interface ArbitrageInsight {
  reqId: number;
  /** DP cost of the scenario as solved. */
  dpCost: number;
  /** DP cost when the battery is forbidden from charging from the grid (PV surplus only). */
  noGridChargeCost: number;
  /** DP cost with no battery at all (EV still optimally scheduled). */
  noBatteryCost: number;
  /** noGridChargeCost - dpCost, $ over the scenario (>= 0 up to DP grid tolerance). */
  arbitrageValue: number;
  arbitrageValuePerDay: number;
  /** kWh the battery charged from the grid in the DP run. */
  gridChargedKwh: number;
  /** kWh the battery discharged into the grid (exported) in the DP run, whatever its source (mostly stored solar). */
  batteryExportedKwh: number;
  /**
   * kWh of battery export attributable to grid charging: the extra battery-to-grid
   * energy in the DP run compared with the no-grid-charge DP run, floored at 0.
   * This, not batteryExportedKwh, is what "bought to re-export" means.
   */
  arbitrageExportKwh: number;
  /** max over t1 < t2 of (rt * S[t2] - B[t1]), $/kWh: best buy-then-export round trip. */
  bestExportSpread: number;
  /** max over t1 < t2 of (rt * B[t2] - B[t1]), $/kWh: best buy-low-to-avoid-buying-high round trip. */
  bestShiftSpread: number;
  /** True when arbitrageValue is materially > 0. */
  pays: boolean;
  /** True when buy-then-export is profitable somewhere (bestExportSpread > 0) AND the DP actually did it (arbitrageExportKwh materially > 0). */
  exportPays: boolean;
  /** One honest sentence for the HUD, assembled from the numbers above. */
  headline: string;
}

// ---------------------------------------------------------------------------
// Worker protocol (UI <-> src/sim/worker.ts). All messages are structured-cloned.
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | { type: 'init' }
  | {
      type: 'solve';
      reqId: number;
      config: SimConfig;
      events: ScenarioEvent[];
      /** Also compute and post an 'insight' message after 'solved'. False while dragging. */
      wantInsight: boolean;
    };

export type WorkerResponse =
  | { type: 'ready'; solver: string; initMs: number }
  | { type: 'solved'; result: SolveResult }
  | { type: 'insight'; insight: ArbitrageInsight }
  | { type: 'error'; reqId: number | null; message: string };

// ---------------------------------------------------------------------------
// Scene contract (UI -> src/scene). The scene never imports from src/sim.
// ---------------------------------------------------------------------------

/** Instantaneous state of one house. All kW values are >= 0 unless noted. */
export interface HouseFrame {
  policy: PolicyId;
  /** Label shown above the house, e.g. "MPC · noisy forecast". */
  label: string;
  pvKw: number;
  loadKw: number;
  evKw: number;
  /** Signed: > 0 battery charging, < 0 discharging. */
  battKw: number;
  /** Signed: > 0 importing from grid, < 0 exporting. */
  gridKw: number;
  /** Battery state of charge 0..1. */
  socFrac: number;
  /** Fraction of the EV's session energy delivered 0..1. */
  evFrac: number;
  /** True while the EV is plugged in at home; false = away (07:00-18:00). */
  evPresent: boolean;
  /** Running cost so far, $ (for optional in-scene labels). */
  cost: number;
}

export interface SceneFrame {
  /** Hours since scenario start (fractional, continuous while playing). */
  timeH: number;
  /** Local clock hour 0..24. */
  clockH: number;
  /** Sun elevation above horizon in degrees (negative at night). */
  sunElevationDeg: number;
  /** Sun azimuth in degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W). */
  sunAzimuthDeg: number;
  /** Cloud cover 0..1. */
  cloud: number;
  /** [0] = MPC house, [1] = DP house. */
  houses: [HouseFrame, HouseFrame];
  /** Simulated hours per real second (0 when paused): lets animations scale. */
  simSpeed: number;
}

export interface SceneApi {
  /** Latest state to display. Cheap; call every animation frame. */
  setFrame(frame: SceneFrame): void;
  /** Call when the container changes size. */
  resize(): void;
  dispose(): void;
}

/** Signature of the scene module's single entry point: src/scene/index.ts `createScene`. */
export type CreateScene = (container: HTMLElement) => SceneApi;

// ---------------------------------------------------------------------------
// Debug handle the UI installs on window for the verifier (window.__energySim).
// ---------------------------------------------------------------------------

export interface AppDebugState {
  /** True once the first solve has been displayed. */
  ready: boolean;
  timeH: number;
  playing: boolean;
  /** Simulated hours per real second. */
  speed: number;
  forecastError: number;
  events: ScenarioEvent[];
  /** Running costs at the playhead and the gap (mpc - dp), $. */
  costMpc: number;
  costDp: number;
  gap: number;
  /** Whole-scenario totals, $. */
  totalMpc: number;
  totalDp: number;
  /** Last measured round-trip re-solve latency (postMessage -> result applied), ms. */
  latencyMs: number;
  /** Number of 'solved' results applied so far. */
  solveCount: number;
  /** True while a solve request is in flight or queued. */
  solving: boolean;
  /** Current arbitrage HUD sentence ('' until the first insight arrives). */
  insightText: string;
}

export interface AppDebug {
  getState(): AppDebugState;
  getResult(): SolveResult | null;
  getInsight(): ArbitrageInsight | null;
  setTimeH(h: number): void;
  play(): void;
  pause(): void;
}
