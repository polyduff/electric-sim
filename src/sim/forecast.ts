import { DT_H } from '../shared/types';
import type { Forecast, Scenario } from '../shared/types';
import { ar1Series } from './rng';
import {
  loadMeanKw,
  MEAN_CLOUD_ATTENUATION,
  MIN_BUY_PRICE,
  MIN_SELL_PRICE,
  SELL_MARGIN,
  SELL_WHOLESALE_SHARE,
} from './scenario';

/**
 * Forecast model.
 *
 * For a target step t seen from step k (lead L = t - k steps, L > 0):
 *
 *   forecast = baseline[t]
 *            + (realised[t] - baseline[t]) * skill(L)
 *            + forecastError * sigma * growth(L) * Z[t]
 *
 * - baseline: what is known for certain (TOU tariff; clear-sky PV times the
 *   climatological mean attenuation; mean load profile).
 * - skill(L) = exp(-forecastError * L*dt / SKILL_TAU_H): how much of the
 *   deviation from baseline (weather, wholesale noise, user-dragged events) the
 *   forecaster already sees. 1 at L = 0, decays faster for larger error levels.
 * - growth(L) = 1 - exp(-L*dt / NOISE_TAU_H): spurious error that grows with lead.
 * - Z[t]: seeded unit-variance AR(1) noise keyed on the TARGET step, so
 *   successive forecasts of the same step are consistent and converge on the
 *   realised value as the step approaches.
 *
 * With forecastError = 0, skill = 1 and the noise term vanishes: the forecast
 * is the realised series.
 */
const SKILL_TAU_H = 4;
const NOISE_TAU_H = 6;
const PRICE_NOISE_SIGMA = 0.035; // $/kWh
const PV_NOISE_REL = 0.25; // fraction of clear-sky output
const LOAD_NOISE_REL = 0.3; // fraction of the mean load
const MIN_LOAD_KW = 0.05;

interface ForecastNoise {
  price: Float64Array;
  pv: Float64Array;
  load: Float64Array;
  loadBase: Float64Array;
}

const noiseCache = new WeakMap<Scenario, ForecastNoise>();

function noiseFor(scenario: Scenario): ForecastNoise {
  let z = noiseCache.get(scenario);
  if (!z) {
    const { n, config, clockHour } = scenario;
    const loadBase = new Float64Array(n);
    for (let t = 0; t < n; t++) loadBase[t] = loadMeanKw(clockHour[t]);
    z = {
      price: ar1Series(config.seed, 11, n, 0.7),
      pv: ar1Series(config.seed, 12, n, 0.8),
      load: ar1Series(config.seed, 13, n, 0.5),
      loadBase,
    };
    noiseCache.set(scenario, z);
  }
  return z;
}

/**
 * What the MPC believes at step k about steps k .. k+length-1. Pure: depends
 * only on the scenario's data and config. Index 0 is exact.
 */
export function forecastAt(scenario: Scenario, k: number): Forecast {
  const { n, config } = scenario;
  const k0 = Math.max(0, Math.min(n, Math.floor(k)));
  const length = Math.max(0, Math.min(Math.round(config.mpcHorizonSteps), n - k0));
  const buy = new Float64Array(length);
  const sell = new Float64Array(length);
  const pvKw = new Float64Array(length);
  const loadKw = new Float64Array(length);
  if (length === 0) return { issuedAtStep: k0, length, buy, sell, pvKw, loadKw };

  const fe = Math.max(0, Math.min(1, config.forecastError));
  const z = noiseFor(scenario);
  const rBuy = scenario.buy;
  const rSell = scenario.sell;
  const rPv = scenario.pvKw;
  const rLoad = scenario.loadKw;

  buy[0] = rBuy[k0];
  sell[0] = rSell[k0];
  pvKw[0] = rPv[k0];
  loadKw[0] = rLoad[k0];
  if (fe === 0) {
    for (let j = 1; j < length; j++) {
      const t = k0 + j;
      buy[j] = rBuy[t];
      sell[j] = rSell[t];
      pvKw[j] = rPv[t];
      loadKw[j] = rLoad[t];
    }
    return { issuedAtStep: k0, length, buy, sell, pvKw, loadKw };
  }

  const skillStep = Math.exp((-fe * DT_H) / SKILL_TAU_H);
  const growStep = Math.exp(-DT_H / NOISE_TAU_H);
  let skill = 1;
  let grow = 1;
  for (let j = 1; j < length; j++) {
    const t = k0 + j;
    skill *= skillStep;
    grow *= growStep;
    const noise = fe * (1 - grow);

    // Prices: buy and feed-in share the same wholesale noise so they move together.
    const zp = z.price[t];
    const bBase = scenario.buyBase[t];
    const sBase = scenario.sellBase[t];
    let fb = bBase + (rBuy[t] - bBase) * skill + noise * PRICE_NOISE_SIGMA * zp;
    if (fb < MIN_BUY_PRICE) fb = MIN_BUY_PRICE;
    let fs = sBase + (rSell[t] - sBase) * skill + noise * PRICE_NOISE_SIGMA * SELL_WHOLESALE_SHARE * zp;
    if (fs > fb - SELL_MARGIN) fs = fb - SELL_MARGIN;
    if (fs < MIN_SELL_PRICE) fs = MIN_SELL_PRICE;
    buy[j] = fb;
    sell[j] = fs;

    // PV: within [0, clear sky].
    const clear = scenario.clearSkyKw[t];
    const pvBase = clear * MEAN_CLOUD_ATTENUATION;
    let fpv = pvBase + (rPv[t] - pvBase) * skill + noise * PV_NOISE_REL * clear * z.pv[t];
    if (fpv > clear) fpv = clear;
    if (fpv < 0) fpv = 0;
    pvKw[j] = fpv;

    // Load: strictly positive.
    const lBase = z.loadBase[t];
    let fl = lBase + (rLoad[t] - lBase) * skill + noise * LOAD_NOISE_REL * lBase * z.load[t];
    if (fl < MIN_LOAD_KW) fl = MIN_LOAD_KW;
    loadKw[j] = fl;
  }
  return { issuedAtStep: k0, length, buy, sell, pvKw, loadKw };
}
