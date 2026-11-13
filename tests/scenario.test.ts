import { describe, expect, it } from 'vitest';
import type { Scenario, ScenarioEvent, SimConfig } from '../src/shared/types';
import { buildScenario, DEFAULT_CONFIG, defaultEvents, forecastAt, sunPosition } from '../src/sim/index';
import { eventSets, SEEDS } from './helpers';

const SERIES = ['clockHour', 'buy', 'sell', 'buyBase', 'sellBase', 'cloud', 'clearSkyKw', 'pvKw', 'loadKw', 'evPlugged'] as const;

function identical(a: Scenario, b: Scenario): string[] {
  const out: string[] = [];
  for (const k of SERIES) {
    const x = a[k];
    const y = b[k];
    if (x.length !== y.length) out.push(`${k} length`);
    else for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { out.push(`${k}[${i}]`); break; }
  }
  return out;
}

function diffSteps(a: Scenario, b: Scenario, key: (typeof SERIES)[number], eps = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.n; i++) if (Math.abs(a[key][i] - b[key][i]) > eps) out.push(i);
  return out;
}

const ev = (id: string, kind: 'priceSpike' | 'cloud', startStep: number, durationSteps: number, magnitude: number): ScenarioEvent => ({
  id, kind, startStep, durationSteps, magnitude,
});

describe('scenario invariants', () => {
  it('is deterministic: same config + events => identical arrays; event order irrelevant', () => {
    for (const seed of SEEDS) {
      const config = { ...DEFAULT_CONFIG, seed };
      const events = defaultEvents(config);
      const a = buildScenario(config, events);
      const b = buildScenario({ ...config }, events.map((e) => ({ ...e })));
      expect(identical(a, b)).toEqual([]);
      const c = buildScenario(config, [...events].reverse());
      expect(identical(a, c)).toEqual([]);
    }
  });

  it('different seeds give different scenarios', () => {
    const a = buildScenario({ ...DEFAULT_CONFIG, seed: 1 }, []);
    const b = buildScenario({ ...DEFAULT_CONFIG, seed: 2 }, []);
    expect(identical(a, b).length).toBeGreaterThan(0);
  });

  it('does not mutate its inputs and does not alias them', () => {
    const events = defaultEvents(DEFAULT_CONFIG);
    const snap = JSON.stringify(events);
    const cfg = { ...DEFAULT_CONFIG };
    const sc = buildScenario(cfg, events);
    expect(JSON.stringify(events)).toBe(snap);
    cfg.seed = 5;
    expect(sc.config.seed).toBe(DEFAULT_CONFIG.seed);
  });

  it('default events: >= 2 price spikes and >= 2 cloud events, valid ranges', () => {
    const e = defaultEvents(DEFAULT_CONFIG);
    expect(e.filter((x) => x.kind === 'priceSpike').length).toBeGreaterThanOrEqual(2);
    expect(e.filter((x) => x.kind === 'cloud').length).toBeGreaterThanOrEqual(2);
    expect(new Set(e.map((x) => x.id)).size).toBe(e.length);
    for (const x of e) {
      expect(x.startStep).toBeGreaterThanOrEqual(0);
      expect(x.startStep + x.durationSteps).toBeLessThanOrEqual(96);
      expect(Number.isInteger(x.startStep) && Number.isInteger(x.durationSteps)).toBe(true);
    }
  });

  it('0 < sell < buy, finite, everywhere, for every seed x event set (incl. 1.5 $/kWh spikes)', () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const config = { ...DEFAULT_CONFIG, seed };
      for (const [name, events] of Object.entries(eventSets(config))) {
        const sc = buildScenario(config, events);
        for (let t = 0; t < sc.n; t++) {
          const { buy, sell } = { buy: sc.buy[t], sell: sc.sell[t] };
          if (!(Number.isFinite(buy) && Number.isFinite(sell) && sell > 0 && sell < buy)) bad.push(`${seed}/${name} t=${t} buy=${buy} sell=${sell}`);
          if (!(sc.buyBase[t] > sc.sellBase[t] && sc.sellBase[t] > 0)) bad.push(`${seed}/${name} base t=${t}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('0 < sell < buy under pathological event sets (stacked spikes, huge magnitudes, zero magnitude)', () => {
    const stacks = [
      Array.from({ length: 10 }, (_, i) => ev(`s${i}`, 'priceSpike', 20, 10, 1.5)),
      [ev('z', 'priceSpike', 20, 4, 0), ev('m', 'priceSpike', 20, 4, 1.5)],
      [ev('big', 'priceSpike', 0, 96, 1.5), ev('c', 'cloud', 0, 96, 1)],
    ];
    for (const events of stacks) {
      const sc = buildScenario(DEFAULT_CONFIG, events);
      for (let t = 0; t < sc.n; t++) {
        expect(sc.sell[t]).toBeGreaterThan(0);
        expect(sc.sell[t]).toBeLessThan(sc.buy[t]);
        expect(Number.isFinite(sc.pvKw[t])).toBe(true);
      }
    }
  });

  it('cloud in [0,1]; 0 <= pv <= clearSky; clear-sky is 0 at night; plausible 6 kWp peak', () => {
    for (const seed of SEEDS) {
      const config = { ...DEFAULT_CONFIG, seed };
      for (const [name, events] of Object.entries(eventSets(config))) {
        const sc = buildScenario(config, events);
        let peak = 0;
        for (let t = 0; t < sc.n; t++) {
          expect(sc.cloud[t], `${name} cloud ${t}`).toBeGreaterThanOrEqual(0);
          expect(sc.cloud[t]).toBeLessThanOrEqual(1);
          expect(sc.pvKw[t]).toBeGreaterThanOrEqual(0);
          expect(sc.pvKw[t]).toBeLessThanOrEqual(sc.clearSkyKw[t] + 1e-12);
          expect(sc.clearSkyKw[t]).toBeGreaterThanOrEqual(0);
          peak = Math.max(peak, sc.clearSkyKw[t]);
          const h = sc.clockHour[t];
          if (h < 4.5 || h > 21.5) expect(sc.clearSkyKw[t], `night pv at h=${h}`).toBe(0);
        }
        expect(peak).toBeGreaterThan(3.5);
        expect(peak).toBeLessThanOrEqual(6.0 + 1e-9);
      }
    }
  });

  it('100% cloud event knocks PV down inside its footprint and leaves price untouched', () => {
    const base = buildScenario(DEFAULT_CONFIG, []);
    const cl = buildScenario(DEFAULT_CONFIG, [ev('c', 'cloud', 0, 48, 1)]);
    for (let t = 8; t < 36; t++) {
      if (base.clearSkyKw[t] > 1) expect(cl.pvKw[t]).toBeLessThanOrEqual(0.5 * base.clearSkyKw[t] + 1e-9);
    }
    expect(diffSteps(base, cl, 'buy')).toEqual([]);
    expect(diffSteps(base, cl, 'loadKw')).toEqual([]);
  });

  it('clock and EV plug window: 07:00 start, 30-min steps, plugged 18:00-07:00', () => {
    const sc = buildScenario(DEFAULT_CONFIG, []);
    expect(sc.n).toBe(96);
    expect(sc.clockHour[0]).toBe(7);
    expect(sc.clockHour[1]).toBe(7.5);
    expect(sc.clockHour[48]).toBe(7);
    for (let t = 0; t < 96; t++) {
      const h = sc.clockHour[t];
      expect(sc.evPlugged[t]).toBe(h >= 18 || h < 7 ? 1 : 0);
    }
    const sc3 = buildScenario({ ...DEFAULT_CONFIG, days: 3 }, []);
    expect(sc3.n).toBe(144);
  });

  it('moving a price spike changes only buy/sell, only inside old U new footprint', () => {
    for (const seed of SEEDS) {
      const config = { ...DEFAULT_CONFIG, seed };
      const events = defaultEvents(config);
      const spike = events.find((e) => e.kind === 'priceSpike')!;
      for (const shift of [-12, 5, 20, 40]) {
        const ns = Math.max(0, Math.min(96 - spike.durationSteps, spike.startStep + shift));
        const moved = events.map((e) => (e.id === spike.id ? { ...e, startStep: ns } : e));
        const a = buildScenario(config, events);
        const b = buildScenario(config, moved);
        const inFoot = (t: number) =>
          (t >= spike.startStep && t < spike.startStep + spike.durationSteps) || (t >= ns && t < ns + spike.durationSteps);
        const changed = [...diffSteps(a, b, 'buy'), ...diffSteps(a, b, 'sell')];
        expect(changed.length).toBeGreaterThan(0);
        for (const t of changed) expect(inFoot(t), `seed ${seed} shift ${shift} t=${t}`).toBe(true);
        for (const key of ['cloud', 'pvKw', 'loadKw', 'clearSkyKw', 'buyBase', 'sellBase', 'evPlugged'] as const) {
          expect(diffSteps(a, b, key), key).toEqual([]);
        }
      }
    }
  });

  it('moving a cloud event changes only cloud/pv, only inside old U new footprint', () => {
    for (const seed of SEEDS) {
      const config = { ...DEFAULT_CONFIG, seed };
      const events = defaultEvents(config);
      const cl = events.find((e) => e.kind === 'cloud')!;
      for (const shift of [-10, 6, 30]) {
        const ns = Math.max(0, Math.min(96 - cl.durationSteps, cl.startStep + shift));
        const moved = events.map((e) => (e.id === cl.id ? { ...e, startStep: ns } : e));
        const a = buildScenario(config, events);
        const b = buildScenario(config, moved);
        const inFoot = (t: number) =>
          (t >= cl.startStep && t < cl.startStep + cl.durationSteps) || (t >= ns && t < ns + cl.durationSteps);
        for (const key of ['cloud', 'pvKw'] as const) for (const t of diffSteps(a, b, key)) expect(inFoot(t), `${key} t=${t}`).toBe(true);
        expect(diffSteps(a, b, 'cloud').length).toBeGreaterThan(0);
        for (const key of ['buy', 'sell', 'loadKw', 'clearSkyKw'] as const) expect(diffSteps(a, b, key), key).toEqual([]);
      }
    }
  });

  it('spike magnitude is the peak added to buy; zero events == no events baseline; magnitude monotone', () => {
    const base = buildScenario(DEFAULT_CONFIG, []);
    let prevMax = 0;
    for (const m of [0.05, 0.3, 0.8, 1.5]) {
      const sc = buildScenario(DEFAULT_CONFIG, [ev('s', 'priceSpike', 30, 6, m)]);
      let maxAdd = 0;
      for (let t = 0; t < sc.n; t++) maxAdd = Math.max(maxAdd, sc.buy[t] - base.buy[t]);
      expect(maxAdd).toBeCloseTo(m, 6);
      expect(maxAdd).toBeGreaterThan(prevMax);
      prevMax = maxAdd;
    }
  });

  it('realised price/PV/load magnitudes are NZ-plausible without events', () => {
    for (const seed of SEEDS) {
      const sc = buildScenario({ ...DEFAULT_CONFIG, seed }, []);
      let loadE = 0;
      for (let t = 0; t < sc.n; t++) {
        expect(sc.buy[t]).toBeGreaterThan(0.12);
        expect(sc.buy[t]).toBeLessThan(0.5);
        expect(sc.sell[t]).toBeGreaterThan(0.04);
        expect(sc.sell[t]).toBeLessThan(0.25);
        expect(sc.loadKw[t]).toBeGreaterThan(0);
        expect(sc.loadKw[t]).toBeLessThan(6);
        loadE += sc.loadKw[t] * 0.5;
      }
      const perDay = loadE / 2;
      expect(perDay).toBeGreaterThan(8);
      expect(perDay).toBeLessThan(30);
    }
  });

  it('sun: Christchurch 12 Nov noon elevation ~64 deg, in the north; negative at midnight', () => {
    let best = { el: -90, az: 0, h: 0 };
    for (let h = 0; h < 24; h += 0.25) {
      const p = sunPosition(DEFAULT_CONFIG, h);
      if (p.elevationDeg > best.el) best = { el: p.elevationDeg, az: p.azimuthDeg, h };
    }
    expect(best.el).toBeGreaterThan(60);
    expect(best.el).toBeLessThan(68);
    const azFromNorth = Math.min(best.az, 360 - best.az);
    expect(azFromNorth).toBeLessThan(20);
    // midnight = 17 h after 07:00
    expect(sunPosition(DEFAULT_CONFIG, 17).elevationDeg).toBeLessThan(0);
    // morning sun is in the east, evening in the west
    const am = sunPosition(DEFAULT_CONFIG, 2); // 09:00
    const pm = sunPosition(DEFAULT_CONFIG, 10); // 17:00
    expect(am.azimuthDeg).toBeGreaterThan(0);
    expect(am.azimuthDeg).toBeLessThan(180);
    expect(pm.azimuthDeg).toBeGreaterThan(180);
    expect(pm.azimuthDeg).toBeLessThan(360);
  });
});

describe('forecasts', () => {
  const cfgFor = (fe: number, seed = DEFAULT_CONFIG.seed): SimConfig => ({ ...DEFAULT_CONFIG, forecastError: fe, seed });

  it('index 0 is exact for every step, every error level, every event set', () => {
    for (const fe of [0, 0.5, 1]) {
      for (const [name, events] of Object.entries(eventSets(cfgFor(fe)))) {
        const sc = buildScenario(cfgFor(fe), events);
        for (let k = 0; k < sc.n; k++) {
          const f = forecastAt(sc, k);
          expect(f.buy[0], `${name} k=${k}`).toBe(sc.buy[k]);
          expect(f.sell[0]).toBe(sc.sell[k]);
          expect(f.pvKw[0]).toBe(sc.pvKw[k]);
          expect(f.loadKw[0]).toBe(sc.loadKw[k]);
          expect(f.issuedAtStep).toBe(k);
        }
      }
    }
  });

  it('length is min(horizon, n-k)', () => {
    const sc = buildScenario(cfgFor(0.5), []);
    for (let k = 0; k < sc.n; k++) {
      const f = forecastAt(sc, k);
      expect(f.length).toBe(Math.min(48, sc.n - k));
      expect(f.buy.length).toBeGreaterThanOrEqual(f.length);
    }
    const sc2 = buildScenario({ ...cfgFor(0.5), mpcHorizonSteps: 12 }, []);
    expect(forecastAt(sc2, 0).length).toBe(12);
  });

  it('forecastError = 0 => forecast equals realised series at every lead (exactly, within 1e-9)', () => {
    for (const [name, events] of Object.entries(eventSets(cfgFor(0)))) {
      const sc = buildScenario(cfgFor(0), events);
      for (let k = 0; k < sc.n; k++) {
        const f = forecastAt(sc, k);
        for (let j = 0; j < f.length; j++) {
          expect(Math.abs(f.buy[j] - sc.buy[k + j]), `${name} k=${k} j=${j} buy`).toBeLessThan(1e-9);
          expect(Math.abs(f.sell[j] - sc.sell[k + j])).toBeLessThan(1e-9);
          expect(Math.abs(f.pvKw[j] - sc.pvKw[k + j])).toBeLessThan(1e-9);
          expect(Math.abs(f.loadKw[j] - sc.loadKw[k + j])).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('forecast: 0 < sell < buy, pv in [0, clearSky], load > 0, finite, for all error levels and event sets', () => {
    const bad: string[] = [];
    for (const fe of [0.5, 1]) {
      for (const seed of SEEDS) {
        for (const [name, events] of Object.entries(eventSets(cfgFor(fe, seed)))) {
          const sc = buildScenario(cfgFor(fe, seed), events);
          for (let k = 0; k < sc.n; k++) {
            const f = forecastAt(sc, k);
            for (let j = 0; j < f.length; j++) {
              const t = k + j;
              if (!(f.sell[j] > 0 && f.sell[j] < f.buy[j])) bad.push(`fe${fe} s${seed} ${name} k=${k} j=${j} sell ${f.sell[j]} buy ${f.buy[j]}`);
              if (!(f.pvKw[j] >= 0)) bad.push(`pv<0 ${name} k=${k} j=${j}`);
              if (f.pvKw[j] > sc.clearSkyKw[t] + 1e-9) bad.push(`fe${fe} s${seed} ${name} forecast pv ${f.pvKw[j].toFixed(3)} > clearSky ${sc.clearSkyKw[t].toFixed(3)} (k=${k}, j=${j})`);
              if (!(f.loadKw[j] > 0)) bad.push(`load<=0 ${name} k=${k} j=${j}`);
              if (![f.buy[j], f.sell[j], f.pvKw[j], f.loadKw[j]].every(Number.isFinite)) bad.push(`non-finite ${name} k=${k}`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('forecast at night has zero PV (clear sky = 0)', () => {
    const sc = buildScenario(cfgFor(1), []);
    for (let k = 0; k < sc.n; k++) {
      const f = forecastAt(sc, k);
      for (let j = 0; j < f.length; j++) if (sc.clearSkyKw[k + j] === 0) expect(f.pvKw[j]).toBe(0);
    }
  });

  it('forecasts are pure: repeated calls identical; consistent with scenario rebuilt from same inputs', () => {
    const sc = buildScenario(cfgFor(1), defaultEvents(cfgFor(1)));
    const sc2 = buildScenario(cfgFor(1), defaultEvents(cfgFor(1)));
    for (const k of [0, 10, 33, 70, 95]) {
      const a = forecastAt(sc, k);
      const b = forecastAt(sc, k);
      const c = forecastAt(sc2, k);
      expect(Array.from(a.buy)).toEqual(Array.from(b.buy));
      expect(Array.from(a.buy)).toEqual(Array.from(c.buy));
      expect(Array.from(a.pvKw)).toEqual(Array.from(c.pvKw));
    }
  });

  it('error magnitude: larger forecastError => larger mean abs error; error grows with lead (averaged over seeds)', () => {
    const mae = (fe: number, jlo: number, jhi: number) => {
      let s = 0;
      let c = 0;
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const sc = buildScenario(cfgFor(fe, seed), []);
        for (let k = 0; k < sc.n - jhi; k++) {
          const f = forecastAt(sc, k);
          for (let j = jlo; j <= jhi; j++) {
            s += Math.abs(f.buy[j] - sc.buy[k + j]) / 0.1 + Math.abs(f.loadKw[j] - sc.loadKw[k + j]) / 1 + Math.abs(f.pvKw[j] - sc.pvKw[k + j]) / 2;
            c++;
          }
        }
      }
      return s / c;
    };
    const e0 = mae(0, 1, 40);
    const e5 = mae(0.5, 1, 40);
    const e10 = mae(1, 1, 40);
    console.log(`forecast MAE (normalised) fe0=${e0.toFixed(4)} fe0.5=${e5.toFixed(4)} fe1=${e10.toFixed(4)}`);
    expect(e0).toBeLessThan(1e-9);
    expect(e5).toBeGreaterThan(0.01);
    expect(e10).toBeGreaterThan(e5);
    const near = mae(1, 1, 4);
    const far = mae(1, 24, 40);
    console.log(`fe=1 MAE near(1-4)=${near.toFixed(4)} far(24-40)=${far.toFixed(4)}`);
    expect(far).toBeGreaterThan(near);
  });

  it('forecast sees a user spike inside the horizon (at fe = 0 exactly; at fe=0.5 at least partly)', () => {
    const events = [ev('s', 'priceSpike', 40, 4, 1.5)];
    const sc0 = buildScenario(cfgFor(0), events);
    const f0 = forecastAt(sc0, 36);
    expect(f0.buy[5]).toBeCloseTo(sc0.buy[41], 9);
    expect(f0.buy[5]).toBeGreaterThan(1);
    const sc5 = buildScenario(cfgFor(0.5), events);
    const f5 = forecastAt(sc5, 36);
    const baseline = sc5.buyBase[41];
    expect(f5.buy[5]).toBeGreaterThan(baseline + 0.3);
  });

  it('NZ-plausible forecast magnitudes without events', () => {
    const sc = buildScenario(cfgFor(1), []);
    for (let k = 0; k < sc.n; k++) {
      const f = forecastAt(sc, k);
      for (let j = 0; j < f.length; j++) {
        expect(f.buy[j]).toBeGreaterThan(0.05);
        expect(f.buy[j]).toBeLessThan(0.7);
        expect(f.sell[j]).toBeLessThan(0.3);
        expect(f.loadKw[j]).toBeLessThan(8);
        expect(f.pvKw[j]).toBeLessThan(6.5);
      }
    }
  });
});
