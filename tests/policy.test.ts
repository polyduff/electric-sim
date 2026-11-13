import { beforeAll, describe, expect, it } from 'vitest';
import { DT_H } from '../src/shared/types';
import type { PolicyResult, Scenario } from '../src/shared/types';
import { initSolver } from '../src/sim/solve';
import { buildCases, checkPolicy, solveCase } from './helpers';

const cases = buildCases();

beforeAll(async () => {
  await initSolver();
});

function simultaneous(sc: Scenario, r: PolicyResult, tol: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < sc.n; k++) {
    if (Math.min(r.battChargeKw[k], r.battDischargeKw[k]) > tol) out.push(`k=${k} charge ${r.battChargeKw[k].toFixed(3)} & discharge ${r.battDischargeKw[k].toFixed(3)}`);
    if (Math.min(r.gridImportKw[k], r.gridExportKw[k]) > tol) out.push(`k=${k} import ${r.gridImportKw[k].toFixed(3)} & export ${r.gridExportKw[k].toFixed(3)}`);
  }
  return out;
}

describe('policy invariants (energy conservation, bounds, EV deadline)', () => {
  for (const policy of ['mpc', 'dp', 'lp'] as const) {
    it(`${policy}: balance, SoC recursion, bounds, EV accounting, cost recomputation over ${cases.length} scenarios`, () => {
      const all: string[] = [];
      for (const c of cases) {
        const s = solveCase(c);
        all.push(...checkPolicy(s.sc, s[policy], `${policy} ${c.name}`).slice(0, 2));
      }
      expect(all).toEqual([]);
    });
  }

  it('EV sessions exist and each receives its need within window (mpc, dp)', () => {
    const errs: string[] = [];
    for (const c of cases) {
      const s = solveCase(c);
      expect(s.sc.evSessions.length).toBeGreaterThanOrEqual(1);
      for (const pol of [s.mpc, s.dp]) {
        for (const es of s.sc.evSessions) {
          let d = 0;
          for (let k = es.arriveStep; k < es.departStep; k++) d += pol.evKw[k] * DT_H;
          if (d < es.needKwh - 1e-6) errs.push(`${pol.policy} ${c.name} ${es.arriveStep}-${es.departStep}: ${d} < ${es.needKwh}`);
        }
      }
    }
    expect(errs).toEqual([]);
  });

  it('default sessions are 18:00->07:00 needing 40 kWh', () => {
    const s = solveCase(cases.find((c) => c.name.endsWith('/default'))!);
    expect(s.sc.evSessions).toEqual([
      { arriveStep: 22, departStep: 48, needKwh: 40 },
      { arriveStep: 70, departStep: 96, needKwh: 40 },
    ]);
  });

  for (const policy of ['mpc', 'dp'] as const) {
    it(`${policy}: no simultaneous battery charge+discharge or import+export (>1e-3 kW)`, () => {
      const out: string[] = [];
      for (const c of cases) {
        const s = solveCase(c);
        const v = simultaneous(s.sc, s[policy], 1e-3);
        if (v.length) out.push(`${c.name}: ${v.length} steps, e.g. ${v[0]}`);
      }
      expect(out.slice(0, 10)).toEqual([]);
    });
  }
});
