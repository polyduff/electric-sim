/**
 * DEV-ONLY stand-in for src/sim (used only with ?mock=1). It produces plausible
 * data with the exact shared types so the UI can be developed and demoed without
 * the real simulator. The "policies" here are simple heuristics, NOT an LP/DP.
 */
import {
  DT_H,
  type ArbitrageInsight,
  type EvSession,
  type Forecast,
  type PolicyId,
  type PolicyResult,
  type Scenario,
  type ScenarioEvent,
  type SimConfig,
  type SolveResult,
} from '../../shared/types';

export const DEFAULT_CONFIG: SimConfig = {
  seed: 20261112,
  days: 2,
  startHour: 7,
  dayOfYear: 316,
  latitudeDeg: -43.53,
  forecastError: 0.35,
  mpcHorizonSteps: 48,
  pvKwp: 6,
  battKwh: 13.5,
  battKw: 5,
  battRoundTrip: 0.9,
  battInitFrac: 0.5,
  evNeedKwh: 40,
  evKw: 7,
  evArriveHour: 18,
  evDepartHour: 7,
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function sunPosition(config: SimConfig, timeH: number): { elevationDeg: number; azimuthDeg: number } {
  const d2r = Math.PI / 180;
  const clock = config.startHour + timeH;
  const doy = config.dayOfYear + Math.floor(clock / 24);
  const decl = -23.44 * d2r * Math.cos((2 * Math.PI * (doy + 10)) / 365);
  const lat = config.latitudeDeg * d2r;
  const h = ((((clock % 24) + 24) % 24) - 13) * 15 * d2r; // solar noon ~13:00 NZDT
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
  const el = Math.asin(clamp(sinEl, -1, 1));
  const azS = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
  const az = ((azS / d2r + 180) % 360 + 360) % 360;
  return { elevationDeg: el / d2r, azimuthDeg: az };
}

export function defaultEvents(config: SimConfig): ScenarioEvent[] {
  const r = rng(config.seed ^ 0x51ed);
  const n = config.days * 48;
  const j = () => Math.floor(r() * 5) - 2;
  const ev = (id: string, kind: ScenarioEvent['kind'], s: number, d: number, m: number): ScenarioEvent => ({
    id,
    kind,
    startStep: clamp(s, 0, n - d),
    durationSteps: d,
    magnitude: m,
  });
  return [
    ev('spike-1', 'priceSpike', 21 + j(), 3, 0.45 + Math.round(r() * 20) / 100),
    ev('spike-2', 'priceSpike', 68 + j(), 4, 0.3 + Math.round(r() * 20) / 100),
    ev('cloud-1', 'cloud', 9 + j(), 6, 0.7),
    ev('cloud-2', 'cloud', 56 + j(), 8, 0.55),
  ];
}

function bump(ev: ScenarioEvent, k: number): number {
  const u = (k + 0.5 - ev.startStep) / ev.durationSteps;
  if (u <= 0 || u >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * u), 0.8);
}

export function buildScenario(config: SimConfig, events: ScenarioEvent[]): Scenario {
  const n = config.days * 48;
  const s: Scenario = {
    config: { ...config },
    events: events.map((e) => ({ ...e })),
    n,
    clockHour: new Float64Array(n),
    buy: new Float64Array(n),
    sell: new Float64Array(n),
    buyBase: new Float64Array(n),
    sellBase: new Float64Array(n),
    cloud: new Float64Array(n),
    clearSkyKw: new Float64Array(n),
    pvKw: new Float64Array(n),
    loadKw: new Float64Array(n),
    evPlugged: new Uint8Array(n),
    evSessions: [],
  };
  const rp = rng(config.seed);
  const rc = rng(config.seed ^ 0xc10d);
  const rl = rng(config.seed ^ 0x10ad);
  let w = 0;
  let c = 0.25;
  for (let k = 0; k < n; k++) {
    const h = (config.startHour + k * DT_H) % 24;
    s.clockHour[k] = h;
    const peak = (h >= 7 && h < 11) || (h >= 17 && h < 21);
    const night = h >= 23 || h < 7;
    s.buyBase[k] = peak ? 0.36 : night ? 0.18 : 0.26;
    s.sellBase[k] = peak ? 0.17 : night ? 0.09 : 0.12;
    w += -0.25 * w + 0.022 * gauss(rp);
    let spike = 0;
    c = clamp(c + 0.15 * (0.3 - c) + 0.09 * gauss(rc), 0, 0.85);
    let cl = c;
    for (const e of events) {
      if (e.kind === 'priceSpike') spike += e.magnitude * bump(e, k);
      else cl = Math.max(cl, cl + (1 - cl) * e.magnitude * bump(e, k));
    }
    s.buy[k] = Math.max(0.1, s.buyBase[k] + w + spike);
    s.sell[k] = clamp(s.sellBase[k] + 0.5 * (w + spike), 0.03, s.buy[k] - 0.02);
    s.cloud[k] = clamp(cl, 0, 1);
    const el = sunPosition(config, (k + 0.5) * DT_H).elevationDeg;
    s.clearSkyKw[k] = el > 0 ? config.pvKwp * 0.92 * Math.pow(Math.sin((el * Math.PI) / 180), 1.15) : 0;
    s.pvKw[k] = s.clearSkyKw[k] * (1 - 0.8 * Math.pow(s.cloud[k], 1.6));
    const morning = Math.exp(-0.5 * Math.pow((h - 7.5) / 1.2, 2));
    const evening = Math.exp(-0.5 * Math.pow((h - 19) / 1.8, 2));
    s.loadKw[k] = Math.max(0.2, 0.35 + 1.1 * morning + 2.0 * evening + 0.12 * gauss(rl));
  }
  // EV sessions: arrive at evArriveHour, depart at evDepartHour next morning.
  let open: EvSession | null = null;
  for (let k = 0; k < n; k++) {
    const h = s.clockHour[k];
    if (open && h === config.evDepartHour) {
      open.departStep = k;
      s.evSessions.push(open);
      open = null;
    }
    if (!open && h === config.evArriveHour) open = { arriveStep: k, departStep: n, needKwh: config.evNeedKwh };
  }
  if (open) s.evSessions.push(open);
  for (const ses of s.evSessions) for (let k = ses.arriveStep; k < ses.departStep; k++) s.evPlugged[k] = 1;
  return s;
}

export function forecastAt(scenario: Scenario, k: number): Forecast {
  const { n, config } = scenario;
  const len = Math.max(0, Math.min(config.mpcHorizonSteps, n - k));
  const f: Forecast = {
    issuedAtStep: k,
    length: len,
    buy: new Float64Array(len),
    sell: new Float64Array(len),
    pvKw: new Float64Array(len),
    loadKw: new Float64Array(len),
  };
  const r = rng((config.seed ^ 0xf0ca) + k * 7919);
  let nb = 0;
  let np = 0;
  for (let j = 0; j < len; j++) {
    const t = k + j;
    const a = j === 0 ? 0 : clamp(config.forecastError * (0.25 + j / 24), 0, 1);
    nb = 0.8 * nb + 0.03 * gauss(r);
    np = 0.8 * np + 0.25 * gauss(r);
    f.buy[j] = Math.max(0.05, (1 - a) * scenario.buy[t] + a * (scenario.buyBase[t] + nb));
    f.sell[j] = clamp((1 - a) * scenario.sell[t] + a * (scenario.sellBase[t] + 0.5 * nb), 0.02, f.buy[j] - 0.01);
    f.pvKw[j] = clamp((1 - a) * scenario.pvKw[t] + a * scenario.clearSkyKw[t] * clamp(0.7 + np, 0, 1), 0, config.pvKwp);
    f.loadKw[j] = scenario.loadKw[t];
  }
  return f;
}

/** Heuristic dispatch (mock): cheapest-slot EV charging, threshold battery. */
function heuristic(s: Scenario, policy: PolicyId, price: Float64Array, batt = true, gridCharge = true): PolicyResult {
  const { n, config: c } = s;
  const eta = Math.sqrt(c.battRoundTrip);
  const res: PolicyResult = {
    policy,
    battChargeKw: new Float64Array(n),
    battDischargeKw: new Float64Array(n),
    evKw: new Float64Array(n),
    gridImportKw: new Float64Array(n),
    gridExportKw: new Float64Array(n),
    socKwh: new Float64Array(n + 1),
    evDeliveredKwh: new Float64Array(n + 1),
    stepCost: new Float64Array(n),
    cumCost: new Float64Array(n + 1),
    totalCost: 0,
  };
  for (const ses of s.evSessions) {
    const idx: number[] = [];
    for (let k = ses.arriveStep; k < ses.departStep; k++) idx.push(k);
    idx.sort((a, b) => price[a] - price[b]);
    let need = ses.needKwh;
    for (const k of idx) {
      const p = Math.min(c.evKw, need / DT_H);
      res.evKw[k] = p;
      need -= p * DT_H;
      if (need <= 1e-9) break;
    }
  }
  const sorted = Array.from(price).sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.3)];
  const hi = sorted[Math.floor(n * 0.65)];
  let soc = c.battInitFrac * c.battKwh;
  const target = c.battInitFrac * c.battKwh;
  let delivered = 0;
  for (let k = 0; k < n; k++) {
    if (s.evSessions.some((x) => x.arriveStep === k)) delivered = 0;
    res.socKwh[k] = soc;
    res.evDeliveredKwh[k] = delivered;
    const net = s.loadKw[k] + res.evKw[k] - s.pvKw[k];
    let ch = 0;
    let dis = 0;
    if (batt) {
      const room = (c.battKwh - soc) / (eta * DT_H);
      const avail = (soc * eta) / DT_H;
      const stepsLeft = n - k;
      const mustCharge = (target - soc) / (eta * DT_H) / Math.max(1, stepsLeft - 1);
      if (net < 0) ch = Math.min(c.battKw, room, -net);
      else if (price[k] >= hi && stepsLeft > 4) dis = Math.min(c.battKw, avail, net);
      if (gridCharge && price[k] <= lo) ch = Math.max(ch, Math.min(c.battKw, room));
      if (stepsLeft <= 6 && soc < target) {
        dis = 0;
        ch = Math.max(ch, Math.min(c.battKw, room, mustCharge * 1.5 + 0.5));
      }
    }
    res.battChargeKw[k] = ch;
    res.battDischargeKw[k] = dis;
    const g = net + ch - dis;
    res.gridImportKw[k] = Math.max(0, g);
    res.gridExportKw[k] = Math.max(0, -g);
    soc = clamp(soc + (eta * ch - dis / eta) * DT_H, 0, c.battKwh);
    delivered += res.evKw[k] * DT_H;
    res.stepCost[k] = (s.buy[k] * res.gridImportKw[k] - s.sell[k] * res.gridExportKw[k]) * DT_H;
    res.cumCost[k + 1] = res.cumCost[k] + res.stepCost[k];
  }
  res.socKwh[n] = soc;
  res.evDeliveredKwh[n] = delivered;
  res.totalCost = res.cumCost[n];
  return res;
}

export function mockSolve(
  reqId: number,
  config: SimConfig,
  events: ScenarioEvent[],
  build: (config: SimConfig, events: ScenarioEvent[]) => Scenario = buildScenario,
): SolveResult {
  const t0 = performance.now();
  const scenario = build(config, events);
  const t1 = performance.now();
  const dp = heuristic(scenario, 'dp', scenario.buy);
  const t2 = performance.now();
  // "MPC": plans on a forecast-like price (blend of realised and baseline).
  const believed = new Float64Array(scenario.n);
  const a = clamp(config.forecastError, 0, 1);
  for (let k = 0; k < scenario.n; k++) believed[k] = (1 - a) * scenario.buy[k] + a * scenario.buyBase[k];
  const mpc = heuristic(scenario, 'mpc', believed);
  if (mpc.totalCost < dp.totalCost) {
    // keep the expected ordering for the mock
    const swap = heuristic(scenario, 'mpc', scenario.buy);
    Object.assign(mpc, swap, { policy: 'mpc' });
  }
  const t3 = performance.now();
  return {
    reqId,
    scenario,
    mpc,
    dp,
    timing: {
      scenarioMs: t1 - t0,
      dpMs: t2 - t1,
      mpcMs: t3 - t2,
      totalMs: t3 - t0,
      lpSolves: scenario.n,
      mpcFromStep: 0,
    },
    solver: 'mock heuristic (no LP)',
  };
}

export function mockInsight(reqId: number, scenario: Scenario, dp: PolicyResult): ArbitrageInsight {
  const noGrid = heuristic(scenario, 'dp', scenario.buy, true, false);
  const noBatt = heuristic(scenario, 'dp', scenario.buy, false, false);
  const rt = scenario.config.battRoundTrip;
  let bestExport = -Infinity;
  let bestShift = -Infinity;
  let minBuy = Infinity;
  let gridCharged = 0;
  let battExported = 0;
  for (let k = 0; k < scenario.n; k++) {
    if (k > 0) {
      bestExport = Math.max(bestExport, rt * scenario.sell[k] - minBuy);
      bestShift = Math.max(bestShift, rt * scenario.buy[k] - minBuy);
    }
    minBuy = Math.min(minBuy, scenario.buy[k]);
    gridCharged += Math.min(dp.battChargeKw[k], dp.gridImportKw[k]) * DT_H;
    battExported += Math.min(dp.battDischargeKw[k], dp.gridExportKw[k]) * DT_H;
  }
  const value = noGrid.totalCost - dp.totalCost;
  const perDay = value / scenario.config.days;
  const pays = value > 0.05;
  const exportPays = bestExport > 0 && battExported > 0.1;
  const headline = pays
    ? `Grid arbitrage pays: charging ${gridCharged.toFixed(1)} kWh from the grid saves $${perDay.toFixed(2)}/day (mock numbers).`
    : `Grid arbitrage does not pay here: the best round trip earns ${(bestShift * 100).toFixed(1)}c/kWh (mock numbers).`;
  return {
    reqId,
    dpCost: dp.totalCost,
    noGridChargeCost: noGrid.totalCost,
    noBatteryCost: noBatt.totalCost,
    arbitrageValue: value,
    arbitrageValuePerDay: perDay,
    gridChargedKwh: gridCharged,
    batteryExportedKwh: battExported,
    arbitrageExportKwh: 0,
    bestExportSpread: bestExport,
    bestShiftSpread: bestShift,
    pays,
    exportPays,
    headline,
  };
}
