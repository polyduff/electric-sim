import { DT_H, STEPS_PER_DAY } from '../shared/types';
import type { EvSession, Scenario, ScenarioEvent, SimConfig } from '../shared/types';
import { ar1Series, gaussian, mulberry32, streamSeed } from './rng';
import { clearSkyStepKw } from './sun';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SimConfig = {
  seed: 20261112,
  days: 2,
  startHour: 7,
  dayOfYear: 316,
  latitudeDeg: -43.53,
  forecastError: 0.5,
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

// ---------------------------------------------------------------------------
// Tariffs (NZD/kWh). Deterministic time-of-use parts; the wholesale component
// W_t is added on top.
// ---------------------------------------------------------------------------

/** Feed-in price follows this share of the wholesale component W_t. */
export const SELL_WHOLESALE_SHARE = 0.3;
/** Feed-in is always at least this far below the buy price. */
export const SELL_MARGIN = 0.02;
export const MIN_BUY_PRICE = 0.05;
export const MIN_SELL_PRICE = 0.01;

/** Wholesale OU noise: stationary sd ($/kWh) and correlation time (h). */
const WHOLESALE_SIGMA = 0.009;
const WHOLESALE_TAU_H = 3;

/** Retail time-of-use buy price at local clock hour h (0..24). */
export function touBuy(h: number): number {
  if (h < 7) return 0.185; // off-peak night
  if (h < 9.5) return 0.37; // morning peak
  if (h < 17) return 0.27; // shoulder
  if (h < 21) return 0.39; // evening peak
  if (h < 23) return 0.27; // shoulder
  return 0.185; // off-peak night
}

/** Feed-in time-of-use price at local clock hour h (0..24). Always well below touBuy. */
export function touSell(h: number): number {
  if (h < 7) return 0.08;
  if (h < 9.5) return 0.12;
  if (h < 17) return 0.1;
  if (h < 21) return 0.16;
  if (h < 23) return 0.1;
  return 0.08;
}

// ---------------------------------------------------------------------------
// Cloud and PV
// ---------------------------------------------------------------------------

const CLOUD_TAU_H = 6;
/** Extra exponential smoothing of the latent state so cloud cover drifts rather than flickers. */
const CLOUD_SMOOTH = 0.6;
const CLOUD_GAIN = 3;
const CLOUD_OFFSET = 0.3;
const CLOUD_FAST_NOISE = 0.04;

/** Fraction of clear-sky PV output that survives cloud cover c (0..1): 1 -> 0.2. */
export function cloudAttenuation(cloud: number): number {
  const c = cloud < 0 ? 0 : cloud > 1 ? 1 : cloud;
  return 1 - 0.8 * Math.pow(c, 1.6);
}

function baseCloudFromLatent(x: number): number {
  return 1 / (1 + Math.exp(-CLOUD_GAIN * (x - CLOUD_OFFSET)));
}

/**
 * Exponentially smooths a unit-variance AR(1) series (in place) and rescales it
 * back to unit stationary variance, giving a slowly drifting latent weather
 * state: long clear spells and long cloudy spells after the sigmoid.
 */
function smoothedLatent(x: Float64Array): Float64Array {
  const rho = Math.exp(-DT_H / CLOUD_TAU_H);
  const a = CLOUD_SMOOTH;
  const variance = ((1 - a) / (1 + a)) * ((1 + a * rho) / (1 - a * rho));
  const scale = 1 / Math.sqrt(variance);
  let y = x.length > 0 ? x[0] * Math.sqrt(variance) : 0;
  for (let t = 0; t < x.length; t++) {
    y = a * y + (1 - a) * x[t];
    x[t] = y * scale;
  }
  return x;
}

/**
 * Climatological mean attenuation of the seeded cloud process (no events):
 * expectation over the stationary N(0,1) latent state, by quadrature. This is
 * what a forecaster with no skill would assume.
 */
export const MEAN_CLOUD_ATTENUATION: number = (() => {
  let num = 0;
  let den = 0;
  for (let i = -400; i <= 400; i++) {
    const x = i / 100;
    const w = Math.exp(-0.5 * x * x);
    num += w * cloudAttenuation(baseCloudFromLatent(x));
    den += w;
  }
  return num / den;
})();

// ---------------------------------------------------------------------------
// Household load
// ---------------------------------------------------------------------------

const LOAD_NOISE_SIGMA = 0.22;
const APPLIANCE_PROB = 0.08;
const APPLIANCE_MIN_KW = 0.8;
const APPLIANCE_MAX_KW = 2.0;

function bump(h: number, centre: number, width: number): number {
  // Wrap around midnight so the profile is periodic.
  let d = h - centre;
  if (d > 12) d -= 24;
  if (d < -12) d += 24;
  return Math.exp(-0.5 * (d / width) * (d / width));
}

function awake(h: number): number {
  return h >= 6.5 && h < 23 ? 1 : 0;
}

/** Smooth part of the household load (kW) at clock hour h: base + morning and evening peaks. */
function loadShapeKw(h: number): number {
  const daytime = 0.25 / (1 + Math.exp(-(h - 9) * 2)) / (1 + Math.exp((h - 17) * 2));
  return 0.3 + 1.1 * bump(h, 7.4, 0.9) + daytime + 1.6 * bump(h, 19.2, 1.5);
}

/** Expected household load (kW) for a step starting at clock hour h; the forecaster's baseline. */
export function loadMeanKw(h: number): number {
  const mid = (h + DT_H / 2) % 24;
  return (
    loadShapeKw(mid) + awake(mid) * APPLIANCE_PROB * 0.5 * (APPLIANCE_MIN_KW + APPLIANCE_MAX_KW)
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Soft-edged window over an event's span: 1 across the core, cosine tapers on
 * the outer quarters. u is the position of the step centre in (0, 1).
 */
function eventWindow(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  const edge = 0.25;
  const d = Math.min(u, 1 - u);
  if (d >= edge) return 1;
  return 0.5 * (1 - Math.cos((Math.PI * d) / edge));
}

/** Adds `magnitude * window` of every event of `kind` into `out` (length n). */
function accumulateEvents(
  events: readonly ScenarioEvent[],
  kind: ScenarioEvent['kind'],
  n: number,
  out: Float64Array,
): void {
  for (const ev of events) {
    if (ev.kind !== kind) continue;
    const start = Math.round(ev.startStep);
    const dur = Math.max(1, Math.round(ev.durationSteps));
    const mag = Number.isFinite(ev.magnitude) ? Math.max(0, ev.magnitude) : 0;
    if (mag === 0) continue;
    // Normalise so the peak over the covered steps is exactly `magnitude`.
    let peak = 0;
    for (let i = 0; i < dur; i++) peak = Math.max(peak, eventWindow((i + 0.5) / dur));
    for (let i = 0; i < dur; i++) {
      const t = start + i;
      if (t < 0 || t >= n) continue;
      out[t] += (mag * eventWindow((i + 0.5) / dur)) / peak;
    }
  }
}

function stepAtClock(config: SimConfig, day: number, clockHour: number): number {
  return Math.round(day * STEPS_PER_DAY + (clockHour - config.startHour) / DT_H);
}

/**
 * The initial draggable disturbances. They are chosen for the demo: a price
 * spike in the first evening peak, a cloud bank across the first midday, a
 * smaller spike in the second morning peak and a heavy cloud bank over the
 * second midday (the one the hindsight policy pre-charges for overnight).
 */
export function defaultEvents(config: SimConfig): ScenarioEvent[] {
  const n = Math.max(1, Math.round(config.days * STEPS_PER_DAY));
  const lastDay = Math.max(0, Math.ceil(config.days) - 1);
  const place = (
    id: string,
    kind: ScenarioEvent['kind'],
    day: number,
    clockHour: number,
    durationSteps: number,
    magnitude: number,
  ): ScenarioEvent => {
    // Clock hours earlier than the start hour belong to the next calendar morning.
    const h = clockHour < config.startHour ? clockHour + 24 : clockHour;
    let start = stepAtClock(config, Math.min(day, lastDay), h);
    const dur = Math.max(1, Math.min(durationSteps, n));
    start = ((start % n) + n) % n;
    if (start + dur > n) start = n - dur;
    return { id, kind, startStep: start, durationSteps: dur, magnitude };
  };
  return [
    place('spike-1', 'priceSpike', 0, 18.5, 4, 0.3),
    place('spike-2', 'priceSpike', 1, 7.5, 3, 0.15),
    place('cloud-1', 'cloud', 0, 11.5, 7, 0.6),
    place('cloud-2', 'cloud', 1, 10.5, 12, 0.8),
  ];
}

// ---------------------------------------------------------------------------
// EV sessions
// ---------------------------------------------------------------------------

function isPluggedHour(config: SimConfig, h: number): boolean {
  const a = config.evArriveHour;
  const d = config.evDepartHour;
  if (a === d) return false;
  return a < d ? h >= a && h < d : h >= a || h < d;
}

function fullSessionSteps(config: SimConfig): number {
  let hours = config.evDepartHour - config.evArriveHour;
  if (hours <= 0) hours += 24;
  return Math.max(1, Math.round(hours / DT_H));
}

function buildEvSessions(config: SimConfig, clockHour: Float64Array, plugged: Uint8Array): EvSession[] {
  const n = clockHour.length;
  const sessions: EvSession[] = [];
  const full = fullSessionSteps(config);
  let k = 0;
  while (k < n) {
    if (!plugged[k]) {
      k++;
      continue;
    }
    const arriveStep = k;
    while (k < n && plugged[k]) k++;
    const departStep = k;
    const len = departStep - arriveStep;
    // A session cut by the scenario boundary needs a pro-rata share of the energy.
    let needKwh = len >= full ? config.evNeedKwh : (config.evNeedKwh * len) / full;
    needKwh = Math.min(needKwh, config.evKw * DT_H * len);
    sessions.push({ arriveStep, departStep, needKwh });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Builds the realised world. The seeded base series (wholesale noise, cloud
 * process, load) depend only on `config`; events are layered on top, so moving
 * an event changes only the steps it covers.
 */
export function buildScenario(config: SimConfig, events: ScenarioEvent[]): Scenario {
  const n = Math.max(1, Math.round(config.days * STEPS_PER_DAY));
  const seed = config.seed;

  const clockHour = new Float64Array(n);
  const buy = new Float64Array(n);
  const sell = new Float64Array(n);
  const buyBase = new Float64Array(n);
  const sellBase = new Float64Array(n);
  const cloud = new Float64Array(n);
  const clearSkyKw = new Float64Array(n);
  const pvKw = new Float64Array(n);
  const loadKw = new Float64Array(n);
  const evPlugged = new Uint8Array(n);

  // --- seeded base series (config only) ---
  const wholesale = ar1Series(seed, 1, n, Math.exp(-DT_H / WHOLESALE_TAU_H));
  const cloudLatent = smoothedLatent(ar1Series(seed, 2, n, Math.exp(-DT_H / CLOUD_TAU_H)));
  const cloudFast = gaussian(mulberry32(streamSeed(seed, 3)));
  const loadNoise = ar1Series(seed, 4, n, 0.6);
  const appliance = mulberry32(streamSeed(seed, 5));

  // --- event footprints ---
  const spike = new Float64Array(n);
  const cloudExtra = new Float64Array(n);
  accumulateEvents(events, 'priceSpike', n, spike);
  accumulateEvents(events, 'cloud', n, cloudExtra);

  for (let k = 0; k < n; k++) {
    const hRaw = config.startHour + k * DT_H;
    const h = ((hRaw % 24) + 24) % 24;
    clockHour[k] = h;

    // Prices
    const w = WHOLESALE_SIGMA * wholesale[k] + spike[k];
    buyBase[k] = touBuy(h);
    sellBase[k] = touSell(h);
    const b = Math.max(MIN_BUY_PRICE, buyBase[k] + w);
    let s = sellBase[k] + SELL_WHOLESALE_SHARE * w;
    s = Math.min(s, b - SELL_MARGIN);
    s = Math.max(s, MIN_SELL_PRICE);
    buy[k] = b;
    sell[k] = s;

    // Cloud and PV
    const baseCloud = clamp01(baseCloudFromLatent(cloudLatent[k]) + CLOUD_FAST_NOISE * cloudFast());
    cloud[k] = clamp01(baseCloud + cloudExtra[k]);
    clearSkyKw[k] = clearSkyStepKw(config, k * DT_H, DT_H);
    pvKw[k] = clearSkyKw[k] * cloudAttenuation(cloud[k]);

    // Household load: smooth profile x log-normal AR(1) noise + occasional appliance.
    const mid = (h + DT_H / 2) % 24;
    const shape = loadShapeKw(mid);
    const mult = Math.exp(LOAD_NOISE_SIGMA * loadNoise[k] - 0.5 * LOAD_NOISE_SIGMA * LOAD_NOISE_SIGMA);
    const u1 = appliance();
    const u2 = appliance();
    const extra =
      awake(mid) && u1 < APPLIANCE_PROB ? APPLIANCE_MIN_KW + (APPLIANCE_MAX_KW - APPLIANCE_MIN_KW) * u2 : 0;
    loadKw[k] = Math.max(0.05, shape * mult + extra);

    evPlugged[k] = isPluggedHour(config, h) ? 1 : 0;
  }

  const evSessions = buildEvSessions(config, clockHour, evPlugged);

  return {
    config: { ...config },
    events: events.map((e) => ({ ...e })),
    n,
    clockHour,
    buy,
    sell,
    buyBase,
    sellBase,
    cloud,
    clearSkyKw,
    pvKw,
    loadKw,
    evPlugged,
    evSessions,
  };
}
