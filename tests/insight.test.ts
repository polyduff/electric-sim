import { beforeAll, describe, expect, it } from 'vitest';
import { DT_H } from '../src/shared/types';
import type { ArbitrageInsight, Scenario } from '../src/shared/types';
import { buildScenario, DEFAULT_CONFIG, defaultEvents } from '../src/sim/index';
import { computeInsight, initSolver, solveDp } from '../src/sim/solve';
import { eventSets, SEEDS } from './helpers';

beforeAll(async () => {
  await initSolver();
});

function bruteSpreads(sc: Scenario) {
  const rt = sc.config.battRoundTrip;
  let ex = -Infinity;
  let sh = -Infinity;
  for (let t1 = 0; t1 < sc.n; t1++) {
    for (let t2 = t1 + 1; t2 < sc.n; t2++) {
      ex = Math.max(ex, rt * sc.sell[t2] - sc.buy[t1]);
      sh = Math.max(sh, rt * sc.buy[t2] - sc.buy[t1]);
    }
  }
  return { ex, sh };
}

const spike = (m: number, start = 30, dur = 4) => [{ id: 's', kind: 'priceSpike' as const, startStep: start, durationSteps: dur, magnitude: m }];

function insightFor(config = DEFAULT_CONFIG, events = defaultEvents(DEFAULT_CONFIG)) {
  const sc = buildScenario(config, events);
  const dp = solveDp(sc);
  return { sc, dp, ins: computeInsight(7, sc, dp) };
}

/** all insight-bearing cases: event sets x seeds */
const allCases = SEEDS.flatMap((seed) =>
  Object.entries(eventSets({ ...DEFAULT_CONFIG, seed })).map(([name, events]) => ({ name: `${seed}/${name}`, config: { ...DEFAULT_CONFIG, seed }, events })),
);

describe('ArbitrageInsight consistency', () => {
  it('numeric fields are consistent with each other and with independent DP runs', () => {
    const errs: string[] = [];
    for (const c of allCases) {
      const { sc, dp, ins } = insightFor(c.config, c.events);
      const noGrid = solveDp(sc, { allowGridCharge: false }).totalCost;
      const noBatt = solveDp(sc, { battery: false }).totalCost;
      const days = (sc.n * DT_H) / 24;
      if (ins.reqId !== 7) errs.push(`${c.name} reqId`);
      if (Math.abs(ins.dpCost - dp.totalCost) > 1e-9) errs.push(`${c.name} dpCost`);
      if (Math.abs(ins.noGridChargeCost - noGrid) > 1e-9) errs.push(`${c.name} noGridChargeCost`);
      if (Math.abs(ins.noBatteryCost - noBatt) > 1e-9) errs.push(`${c.name} noBatteryCost`);
      const raw = noGrid - dp.totalCost;
      if (raw < -2e-3) errs.push(`${c.name}: noGridChargeCost ${noGrid} < dpCost ${dp.totalCost} (raw arbitrage ${raw}; reported ${ins.arbitrageValue})`);
      if (Math.abs(ins.arbitrageValue - raw) > 1e-9 && !(raw < 0 && ins.arbitrageValue === 0)) errs.push(`${c.name} arbitrageValue ${ins.arbitrageValue} vs ${raw}`);
      if (ins.arbitrageValue < 0) errs.push(`${c.name} negative arbitrageValue`);
      if (Math.abs(ins.arbitrageValuePerDay - ins.arbitrageValue / days) > 1e-9) errs.push(`${c.name} per day`);
      if (ins.noBatteryCost < ins.dpCost - 1e-9) errs.push(`${c.name} noBattery < dp`);
      if (ins.gridChargedKwh < -1e-9) errs.push(`${c.name} gridCharged<0`);
      let charged = 0;
      let discharged = 0;
      let exported = 0;
      for (let k = 0; k < sc.n; k++) {
        charged += dp.battChargeKw[k] * DT_H;
        discharged += dp.battDischargeKw[k] * DT_H;
        exported += dp.gridExportKw[k] * DT_H;
      }
      if (ins.gridChargedKwh > charged + 1e-9) errs.push(`${c.name} gridCharged ${ins.gridChargedKwh} > total charged ${charged}`);
      if (ins.batteryExportedKwh > Math.min(discharged, exported) + 1e-9) errs.push(`${c.name} batteryExported ${ins.batteryExportedKwh} > min(discharged ${discharged}, exported ${exported})`);
      // If grid charging is forbidden-equivalent (zero value) there should not be a big grid charge
      if (ins.arbitrageValue < 1e-6 && ins.gridChargedKwh > 0.5) errs.push(`${c.name}: zero arbitrage value but ${ins.gridChargedKwh} kWh grid charged`);
    }
    expect(errs).toEqual([]);
  });

  it('spreads equal an independent brute force over t1 < t2', () => {
    for (const c of allCases) {
      const { sc, ins } = insightFor(c.config, c.events);
      const { ex, sh } = bruteSpreads(sc);
      expect(ins.bestExportSpread, c.name).toBeCloseTo(ex, 12);
      expect(ins.bestShiftSpread, c.name).toBeCloseTo(sh, 12);
      expect(ins.bestShiftSpread).toBeGreaterThanOrEqual(ins.bestExportSpread - 1e-12);
    }
  });

  it('pays / exportPays flags agree with the numbers', () => {
    const errs: string[] = [];
    for (const c of allCases) {
      const { ins } = insightFor(c.config, c.events);
      if (ins.pays && ins.arbitrageValue <= 0) errs.push(`${c.name} pays with value ${ins.arbitrageValue}`);
      if (ins.pays !== ins.arbitrageValuePerDay >= 0.05) errs.push(`${c.name} pays=${ins.pays} with ${ins.arbitrageValuePerDay.toFixed(4)} per day (contract: pays iff >= 0.05 per day)`);
      if (ins.exportPays && !(ins.bestExportSpread > 0)) errs.push(`${c.name} exportPays but spread ${ins.bestExportSpread}`);
      if (ins.exportPays !== (ins.bestExportSpread > 0 && ins.arbitrageExportKwh >= 0.1)) errs.push(`${c.name} exportPays=${ins.exportPays} vs spread ${ins.bestExportSpread}, arbExport ${ins.arbitrageExportKwh}`);
    }
    expect(errs).toEqual([]);
  });

  it('headline quotes the same numbers as the fields', () => {
    const errs: string[] = [];
    for (const c of allCases) {
      const { ins } = insightFor(c.config, c.events);
      const h = ins.headline;
      const perDay = /\$(\d+\.\d\d)\/day/.exec(h);
      if (!perDay) errs.push(`${c.name}: no $/day in "${h}"`);
      else if (Math.abs(parseFloat(perDay[1]) - ins.arbitrageValuePerDay) > 0.0051) errs.push(`${c.name}: headline $${perDay[1]}/day vs ${ins.arbitrageValuePerDay}`);
      const spread = /([+−-])(\d+\.\d) c\/kWh/.exec(h);
      if (!spread) errs.push(`${c.name}: no spread in "${h}"`);
      else {
        const v = (spread[1] === '+' ? 1 : -1) * parseFloat(spread[2]) / 100;
        const expected = !ins.pays ? ins.bestShiftSpread : ins.bestExportSpread;
        if (Math.abs(v - expected) > 0.0006) errs.push(`${c.name}: headline spread ${v} vs field ${expected} (pays=${ins.pays}, exportPays=${ins.exportPays})`);
      }
      const loss = /(\d+)% losses/.exec(h);
      if (!loss || Number(loss[1]) !== 10) errs.push(`${c.name}: losses in "${h}"`);
      const kwh = /(\d+\.\d) kWh sold back/.exec(h);
      if (ins.exportPays && ins.pays) {
        if (!kwh || Math.abs(parseFloat(kwh[1]) - ins.arbitrageExportKwh) > 0.051) errs.push(`${c.name}: headline kWh vs arbitrageExportKwh ${ins.arbitrageExportKwh}`);
      }
      if (!(ins.exportPays && ins.pays) && /sold back/.test(h)) errs.push(`${c.name}: 'sold back' claimed without exportPays&&pays`);
      if (!ins.pays && !/worth almost nothing/.test(h)) errs.push(`${c.name}: !pays but headline "${h}"`);
      if (ins.pays && /worth almost nothing/.test(h)) errs.push(`${c.name}: pays but headline says almost nothing`);
      if (/stored solar already covers/.test(h) && !(ins.pays && !ins.exportPays && ins.bestExportSpread > 0)) errs.push(`${c.name}: 'stored solar covers' in wrong branch`);
      if (/re-export profitable/.test(h) && !ins.exportPays) errs.push(`${c.name}: headline claims re-export pays but exportPays=false`);
      if (/never pays/.test(h) && ins.bestExportSpread > 0) errs.push(`${c.name}: headline says never pays but spread ${ins.bestExportSpread}`);
      if (/only marginal/.test(h) && ins.bestExportSpread <= 0) errs.push(`${c.name}: headline says marginal but spread<=0`);
    }
    expect(errs).toEqual([]);
  });

  it('headline changes between the default scenario and a 1.0+ $/kWh evening spike', () => {
    const a = insightFor().ins;
    const b = insightFor(DEFAULT_CONFIG, [...defaultEvents(DEFAULT_CONFIG), { id: 'big', kind: 'priceSpike', startStep: 30, durationSteps: 4, magnitude: 1.2 }]).ins;
    expect(b.headline).not.toBe(a.headline);
    expect(a.exportPays).toBe(false);
    expect(b.exportPays).toBe(true);
    expect(b.bestExportSpread).toBeGreaterThan(a.bestExportSpread + 0.1);
    expect(b.arbitrageValue).toBeGreaterThan(a.arbitrageValue);
    expect(b.headline).toMatch(/re-export/);
    expect(a.headline).toMatch(/never pays|stored solar|shifting|almost nothing/);
  });

  it('last-step 1.5 $/kWh spike: claim "stored solar already covers it" checked against the no-grid-charge DP', () => {
    const { sc, dp, ins } = insightFor(DEFAULT_CONFIG, spike(1.5, 95, 1));
    expect(ins.bestExportSpread).toBeGreaterThan(0);
    const noGrid = solveDp(sc, { allowGridCharge: false });
    const batExp = (r: typeof dp, k: number) => Math.min(r.battDischargeKw[k], r.gridExportKw[k]) * DT_H;
    const dpLast = batExp(dp, 95);
    const ngLast = batExp(noGrid, 95);
    console.log(`last-step spike: dp exports ${dpLast.toFixed(3)} kWh from battery in step 95, no-grid-charge DP ${ngLast.toFixed(3)}; arbExport=${ins.arbitrageExportKwh.toFixed(3)} exportPays=${ins.exportPays}`);
    expect(dpLast).toBeLessThanOrEqual(2.5 + 1e-9);
    if (!ins.exportPays) expect(dpLast - ngLast).toBeLessThan(0.1 + 1e-6);
    else expect(dpLast - ngLast).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(ins.arbitrageExportKwh).toBeLessThanOrEqual(2.5 + 1e-9);
  });

  it('arbitrageExportKwh properties over all cases', () => {
    const errs: string[] = [];
    for (const c of allCases) {
      const { ins } = insightFor(c.config, c.events);
      const rt = c.config.battRoundTrip;
      if (!(ins.arbitrageExportKwh >= 0)) errs.push(`${c.name} negative ${ins.arbitrageExportKwh}`);
      if (ins.arbitrageExportKwh > ins.gridChargedKwh * rt + 1e-9) errs.push(`${c.name} > gridCharged*rt`);
      if (ins.arbitrageExportKwh > ins.batteryExportedKwh + 1e-9) errs.push(`${c.name} > batteryExported`);
      if (ins.bestExportSpread <= 0 && ins.arbitrageExportKwh > 1e-9) errs.push(`${c.name} nonzero with spread ${ins.bestExportSpread}`);
    }
    expect(errs).toEqual([]);
  });

  it('constructed case: no PV, 1.5 $/kWh evening spike => buying to re-export is the only profit; exportPays with plausible kWh', () => {
    const config = { ...DEFAULT_CONFIG, pvKwp: 0 };
    for (const [start, dur] of [[26, 4], [28, 4], [30, 6]]) {
      const { ins } = insightFor(config, spike(1.5, start, dur));
      expect(ins.exportPays, `spike ${start}/${dur}`).toBe(true);
      expect(ins.pays).toBe(true);
      expect(ins.arbitrageExportKwh).toBeGreaterThan(2);
      expect(ins.arbitrageExportKwh).toBeLessThanOrEqual(Math.min(config.battKw * 0.5 * dur, config.battKwh) + 1e-9);
      expect(ins.arbitrageExportKwh).toBeLessThanOrEqual(ins.gridChargedKwh * 0.9 + 1e-9);
      expect(ins.headline).toMatch(/re-export profitable/);
    }
    const { ins: none } = insightFor(config, []);
    expect(none.exportPays).toBe(false);
    expect(none.arbitrageExportKwh).toBeLessThan(0.1);
  });

  it('no-spike scenario with nonzero battery export: headline stays honest (export is solar-sourced)', () => {
    const { ins } = insightFor(DEFAULT_CONFIG, []);
    expect(ins.exportPays).toBe(false);
    expect(ins.headline).not.toMatch(/re-export profitable/);
  });

  it('insight is deterministic and does not mutate the DP result', () => {
    const sc = buildScenario(DEFAULT_CONFIG, defaultEvents(DEFAULT_CONFIG));
    const dp = solveDp(sc);
    const snap = Array.from(dp.battChargeKw);
    const a = computeInsight(1, sc, dp);
    const b = computeInsight(1, sc, dp);
    expect(a).toEqual(b);
    expect(Array.from(dp.battChargeKw)).toEqual(snap);
  });

  it('arbitrage value grows with spike size (monotone non-decreasing up to DP tolerance)', () => {
    let prev: ArbitrageInsight | null = null;
    for (const m of [0, 0.2, 0.5, 0.9, 1.5]) {
      const { ins } = insightFor(DEFAULT_CONFIG, spike(m));
      if (prev) {
        expect(ins.arbitrageValue).toBeGreaterThanOrEqual(prev.arbitrageValue - 0.02);
        expect(ins.bestExportSpread).toBeGreaterThanOrEqual(prev.bestExportSpread - 1e-9);
      }
      prev = ins;
    }
  });
});
