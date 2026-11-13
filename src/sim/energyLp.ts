import type { Basis, Model, SymbolDisposable } from 'highs';
import { DT_H } from '../shared/types';
import type { Scenario } from '../shared/types';
import { getHighs, recoverSolver, solverGeneration } from './lp';
import { batteryEff } from './result';

/**
 * The dispatch LP in "absolute time" form: one block of six variables per
 * scenario step, with a fixed constraint matrix. The MPC, the hindsight LP and
 * the terminal-value LP all use this one structure and differ only in costs
 * and bounds, which lets a single persistent HiGHS model be re-solved with a
 * warm start instead of being rebuilt (no LP text, no parsing).
 *
 * Columns for step t (index 6t + offset):
 *   C charge kW, D discharge kW, E EV kW, G grid import kW, X grid export kW,
 *   S state of charge at the END of step t (kWh).
 * Rows:
 *   t        power balance:  G - X + D - C - E            = load_t - pv_t
 *   n + t    battery:        S_t - S_{t-1} - etaC*dt*C + dt/etaD*D = 0   (S_{-1} = initial SoC)
 *   2n + i   EV session i:   dt * sum(E_t, t in session)   = need_i
 *
 * Because feed-in < buy price and the round trip loses energy, the LP
 * relaxation never wants simultaneous import/export or charge/discharge, so no
 * binaries are needed.
 */
export const COL_C = 0;
export const COL_D = 1;
export const COL_E = 2;
export const COL_G = 3;
export const COL_X = 4;
export const COL_S = 5;
export const VARS_PER_STEP = 6;

export interface LpSolution {
  ok: boolean;
  /** Primal column values (valid when ok). */
  x: Float64Array;
  /** Row duals (valid when ok). */
  rowDual: Float64Array;
  objective: number;
  iterations: number;
}

const HIGHS_OPTIONS = {
  output_flag: false,
  presolve: 'off',
  solver: 'simplex',
} as const;

/** Structural fingerprint: scenarios with the same key share a constraint matrix. */
export function lpStructureKey(scenario: Scenario): string {
  const s = scenario.evSessions.map((e) => `${e.arriveStep}-${e.departStep}`).join(',');
  return `${scenario.n}|${scenario.config.battRoundTrip}|${s}`;
}

export class EnergyLp {
  readonly n: number;
  readonly nCols: number;
  readonly nRows: number;
  readonly key: string;
  readonly colCost: Float64Array;
  readonly colLower: Float64Array;
  readonly colUpper: Float64Array;
  readonly rowLower: Float64Array;
  readonly rowUpper: Float64Array;
  /** Total LPs solved through this object (including retries). */
  solves = 0;

  private readonly starts: Int32Array;
  private readonly indices: Int32Array;
  private readonly values: Float64Array;
  private model: SymbolDisposable<Model> | null = null;
  private modelGeneration = -1;

  constructor(scenario: Scenario) {
    const n = scenario.n;
    const sessions = scenario.evSessions;
    const { etaC, etaD } = batteryEff(scenario);
    this.n = n;
    this.nCols = VARS_PER_STEP * n;
    this.nRows = 2 * n + sessions.length;
    this.key = lpStructureKey(scenario);
    this.colCost = new Float64Array(this.nCols);
    this.colLower = new Float64Array(this.nCols);
    this.colUpper = new Float64Array(this.nCols);
    this.rowLower = new Float64Array(this.nRows);
    this.rowUpper = new Float64Array(this.nRows);

    const sessionOf = new Int32Array(n).fill(-1);
    sessions.forEach((s, i) => {
      for (let t = s.arriveStep; t < s.departStep; t++) sessionOf[t] = i;
    });

    const starts = new Int32Array(this.nCols + 1);
    const indices: number[] = [];
    const values: number[] = [];
    for (let t = 0; t < n; t++) {
      const base = VARS_PER_STEP * t;
      starts[base + COL_C] = indices.length;
      indices.push(t, n + t);
      values.push(-1, -etaC * DT_H);
      starts[base + COL_D] = indices.length;
      indices.push(t, n + t);
      values.push(1, DT_H / etaD);
      starts[base + COL_E] = indices.length;
      indices.push(t);
      values.push(-1);
      if (sessionOf[t] >= 0) {
        indices.push(2 * n + sessionOf[t]);
        values.push(DT_H);
      }
      starts[base + COL_G] = indices.length;
      indices.push(t);
      values.push(1);
      starts[base + COL_X] = indices.length;
      indices.push(t);
      values.push(-1);
      starts[base + COL_S] = indices.length;
      indices.push(n + t);
      values.push(1);
      if (t + 1 < n) {
        indices.push(n + t + 1);
        values.push(-1);
      }
    }
    starts[this.nCols] = indices.length;
    this.starts = starts;
    this.indices = Int32Array.from(indices);
    this.values = Float64Array.from(values);
  }

  private ensureModel(): SymbolDisposable<Model> {
    if (this.model && this.modelGeneration === solverGeneration() && !this.model.disposed) {
      return this.model;
    }
    const highs = getHighs();
    const model = highs.createModel();
    model.options.set(HIGHS_OPTIONS);
    model.passModel({
      numCols: this.nCols,
      numRows: this.nRows,
      colCost: this.colCost,
      colLower: this.colLower,
      colUpper: this.colUpper,
      rowLower: this.rowLower,
      rowUpper: this.rowUpper,
      matrix: {
        format: 'csc',
        numRows: this.nRows,
        numCols: this.nCols,
        starts: this.starts,
        indices: this.indices,
        values: this.values,
      },
    });
    this.model = model;
    this.modelGeneration = solverGeneration();
    return model;
  }

  private runOnce(start: Basis | 'cold' | 'keep'): LpSolution {
    const highs = getHighs();
    const model = this.ensureModel();
    const cols = { kind: 'range', from: 0, to: this.nCols - 1 } as const;
    const rows = { kind: 'range', from: 0, to: this.nRows - 1 } as const;
    model.changeColsCost(cols, this.colCost);
    model.changeColsBounds(cols, this.colLower, this.colUpper);
    model.changeRowsBounds(rows, this.rowLower, this.rowUpper);
    if (start === 'cold') model.clearSolver();
    else if (start !== 'keep') {
      // Drop factorisation / pricing weights left by earlier solves so the result depends only
      // on (LP data, basis), never on solver history: a reused MPC prefix then matches a
      // from-scratch run bit for bit even when the LP has tied optima.
      model.clearSolver();
      model.setBasis(start);
    }
    const run = model.run();
    this.solves++;
    const ok = run.modelStatus === highs.constants.modelStatus.optimal;
    if (!ok) {
      return { ok, x: EMPTY, rowDual: EMPTY, objective: NaN, iterations: 0 };
    }
    const sol = model.getSolution();
    return {
      ok,
      x: sol.colValue,
      rowDual: sol.rowDual,
      objective: model.getObjectiveValue(),
      iterations: Number(model.info.get('simplex_iteration_count')),
    };
  }

  /**
   * Solves the LP defined by the current cost / bound arrays.
   * start: a basis to warm-start from, 'cold' for a fresh solve, or 'keep' to
   * continue from whatever basis the model currently holds.
   *
   * Robustness: a non-optimal status with a warm start is retried cold; if the
   * WASM runtime throws (abort / trap), the stand-by runtime is swapped in and
   * the solve is retried cold on a rebuilt model.
   */
  solve(start: Basis | 'cold' | 'keep'): LpSolution {
    try {
      const r = this.runOnce(start);
      if (r.ok || start === 'cold') return r;
      return this.runOnce('cold');
    } catch (err) {
      this.dropModel();
      if (!recoverSolver()) {
        // No stand-by runtime: try once more on the same runtime with a new model.
        try {
          return this.runOnce('cold');
        } catch {
          this.dropModel();
          throw err;
        }
      }
      return this.runOnce('cold');
    }
  }

  /** Basis left by the last successful solve. */
  basis(): Basis {
    return this.ensureModel().getBasis();
  }

  private dropModel(): void {
    const m = this.model;
    this.model = null;
    if (m) {
      try {
        m.dispose();
      } catch {
        // the runtime is already gone
      }
    }
  }

  dispose(): void {
    this.dropModel();
  }
}

const EMPTY = new Float64Array(0);
