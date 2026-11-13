import { DT_H } from '../src/shared/types';
import type { PolicyResult, Scenario, ScenarioEvent, SimConfig } from '../src/shared/types';
import { buildScenario, DEFAULT_CONFIG, defaultEvents } from '../src/sim/index';
import { solveDp, solveHindsightLp, solveMpc } from '../src/sim/solve';

export const SEEDS = [20261112, 1, 7, 424242];
export const FES = [0, 0.5, 1];

export interface Case {
  name: string;
  config: SimConfig;
  events: ScenarioEvent[];
}

const ev = (id: string, kind: 'priceSpike' | 'cloud', startStep: number, durationSteps: number, magnitude: number): ScenarioEvent => ({
  id, kind, startStep, durationSteps, magnitude,
});

export function eventSets(config: SimConfig): Record<string, ScenarioEvent[]> {
  return {
    default: defaultEvents(config),
    none: [],
    spikeInEv: [ev('s', 'priceSpike', 26, 4, 1.5)], // 20:00 on day 1, EV plugged
    spikeEnd: [ev('s', 'priceSpike', 92, 4, 1.5)], // last 4 steps
    spikeLast1: [ev('s', 'priceSpike', 95, 1, 1.5)],
    spikeStep0: [ev('s', 'priceSpike', 0, 3, 1.5), ev('c', 'cloud', 0, 6, 1)],
    cloudDay1: [ev('c', 'cloud', 0, 48, 1)],
    cloudDay2: [ev('c', 'cloud', 48, 48, 1)],
    overlap: [
      ev('a', 'priceSpike', 20, 8, 1.2), ev('b', 'priceSpike', 24, 8, 1.5), ev('c', 'cloud', 10, 12, 0.7),
      ev('d', 'cloud', 14, 12, 1), ev('e', 'priceSpike', 24, 8, 0.4),
    ],
    pastEnd: [ev('s', 'priceSpike', 94, 10, 1.5)],
  };
}

export function buildCases(seeds = SEEDS, fes = FES): Case[] {
  const out: Case[] = [];
  for (const seed of seeds) {
    for (const fe of fes) {
      const config = { ...DEFAULT_CONFIG, seed, forecastError: fe };
      for (const [name, events] of Object.entries(eventSets(config))) {
        out.push({ name: `seed${seed}/fe${fe}/${name}`, config, events });
      }
    }
  }
  return out;
}

/** A thinner matrix for the heavy tests: all event sets for 2 seeds x 3 fe, plus default for others. */
export function mediumCases(): Case[] {
  const all = buildCases();
  return all.filter((c) => c.config.seed === DEFAULT_CONFIG.seed || c.config.seed === 7 || c.name.endsWith('/default'));
}

export interface Solved {
  case: Case;
  sc: Scenario;
  mpc: PolicyResult;
  dp: PolicyResult;
  lp: PolicyResult;
}

const cache = new Map<string, Solved>();
export function solveCase(c: Case): Solved {
  let s = cache.get(c.name);
  if (!s) {
    const sc = buildScenario(c.config, c.events);
    s = { case: c, sc, mpc: solveMpc(sc), dp: solveDp(sc), lp: solveHindsightLp(sc) };
    cache.set(c.name, s);
  }
  return s;
}

/** Independent recomputation of costs. */
export function recomputeCost(sc: Scenario, r: PolicyResult): { step: number[]; cum: number[]; total: number } {
  const step: number[] = [];
  const cum: number[] = [0];
  for (let k = 0; k < sc.n; k++) {
    const s = (sc.buy[k] * r.gridImportKw[k] - sc.sell[k] * r.gridExportKw[k]) * DT_H;
    step.push(s);
    cum.push(cum[k] + s);
  }
  return { step, cum, total: cum[sc.n] };
}

export { DEFAULT_CONFIG, defaultEvents, DT_H };

const TOL = 1e-6;
export function checkPolicy(sc: Scenario, r: PolicyResult, label: string): string[] {
  const errs: string[] = [];
  const c = sc.config;
  const sq = Math.sqrt(c.battRoundTrip);
  const init = c.battKwh * c.battInitFrac;
  const bad = (m: string) => errs.length < 8 && errs.push(`${label}: ${m}`);
  if (r.socKwh.length !== sc.n + 1 || r.cumCost.length !== sc.n + 1 || r.evDeliveredKwh.length !== sc.n + 1) bad('state array lengths');
  for (const key of ['battChargeKw', 'battDischargeKw', 'evKw', 'gridImportKw', 'gridExportKw', 'stepCost'] as const) {
    if (r[key].length !== sc.n) bad(`${key} length ${r[key].length}`);
  }
  if (Math.abs(r.socKwh[0] - init) > TOL) bad(`soc[0]=${r.socKwh[0]} != ${init}`);
  if (r.socKwh[sc.n] < init - TOL) bad(`final soc ${r.socKwh[sc.n]} < init ${init}`);
  const cost = recomputeCost(sc, r);
  for (let k = 0; k < sc.n; k++) {
    const lhs = sc.pvKw[k] + r.gridImportKw[k] + r.battDischargeKw[k];
    const rhs = sc.loadKw[k] + r.evKw[k] + r.battChargeKw[k] + r.gridExportKw[k];
    if (Math.abs(lhs - rhs) > TOL) bad(`k=${k} balance ${lhs} vs ${rhs}`);
    const soc = r.socKwh[k] + (sq * r.battChargeKw[k] - r.battDischargeKw[k] / sq) * DT_H;
    if (Math.abs(soc - r.socKwh[k + 1]) > TOL) bad(`k=${k} soc recursion ${soc} vs ${r.socKwh[k + 1]}`);
    if (r.socKwh[k + 1] < -TOL || r.socKwh[k + 1] > c.battKwh + TOL) bad(`k=${k + 1} soc ${r.socKwh[k + 1]} out of range`);
    if (r.battChargeKw[k] < -TOL || r.battChargeKw[k] > c.battKw + TOL) bad(`k=${k} charge ${r.battChargeKw[k]}`);
    if (r.battDischargeKw[k] < -TOL || r.battDischargeKw[k] > c.battKw + TOL) bad(`k=${k} discharge ${r.battDischargeKw[k]}`);
    if (r.evKw[k] < -TOL || r.evKw[k] > c.evKw + TOL) bad(`k=${k} ev ${r.evKw[k]}`);
    if (!sc.evPlugged[k] && r.evKw[k] > TOL) bad(`k=${k} EV charging while unplugged ${r.evKw[k]}`);
    if (r.gridImportKw[k] < -TOL || r.gridExportKw[k] < -TOL) bad(`k=${k} negative grid flow`);
    if (!Number.isFinite(r.stepCost[k]) || Math.abs(r.stepCost[k] - cost.step[k]) > TOL) bad(`k=${k} stepCost ${r.stepCost[k]} vs ${cost.step[k]}`);
    if (Math.abs(r.cumCost[k + 1] - cost.cum[k + 1]) > TOL) bad(`k=${k + 1} cumCost ${r.cumCost[k + 1]} vs ${cost.cum[k + 1]}`);
  }
  if (r.cumCost[0] !== 0) bad('cumCost[0] != 0');
  if (Math.abs(r.totalCost - cost.total) > TOL) bad(`totalCost ${r.totalCost} vs ${cost.total}`);
  // EV accounting
  for (const s of sc.evSessions) {
    let d = 0;
    for (let k = s.arriveStep; k < s.departStep; k++) {
      if (!sc.evPlugged[k]) bad(`session step ${k} not plugged`);
      if (Math.abs(r.evDeliveredKwh[k] - d) > TOL) bad(`k=${k} evDelivered ${r.evDeliveredKwh[k]} vs ${d}`);
      d += r.evKw[k] * DT_H;
    }
    if (d < s.needKwh - TOL) bad(`EV session ${s.arriveStep}-${s.departStep} delivered ${d} < need ${s.needKwh}`);
    if (Math.abs(r.evDeliveredKwh[s.departStep] - d) > TOL) bad(`evDelivered at depart ${r.evDeliveredKwh[s.departStep]} vs ${d}`);
  }
  for (let k = 0; k < sc.n; k++) {
    if (!sc.evPlugged[k] && Math.abs(r.evDeliveredKwh[k + 1] - r.evDeliveredKwh[k]) > TOL && !(k + 1 < sc.n && sc.evPlugged[k + 1])) bad(`k=${k} evDelivered changes while unplugged`);
  }
  return errs;
}

