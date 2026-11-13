import { DT_H } from '../shared/types';
import type { PolicyId, PolicyResult, Scenario } from '../shared/types';

/** Charge and discharge efficiencies: the round trip is split evenly (sqrt each way). */
export function batteryEff(scenario: Scenario): { etaC: number; etaD: number } {
  const e = Math.sqrt(scenario.config.battRoundTrip);
  return { etaC: e, etaD: e };
}

export function initialSocKwh(scenario: Scenario): number {
  return scenario.config.battKwh * scenario.config.battInitFrac;
}

/** Largest state-of-charge discrepancy (kWh) treated as numerical dust. */
const SNAP_KWH = 1e-7;

/**
 * Makes every EV session deliver at least its need in exact floating-point
 * terms. Solvers meet the deadline to within ~1e-9 kWh; this tops up the last
 * charging step of a session by that dust so `delivered >= need` holds exactly.
 * A genuine shortfall (> 1e-6 kWh) is left alone so it stays visible.
 */
export function settleEvSessions(scenario: Scenario, evKw: Float64Array): void {
  const maxKw = scenario.config.evKw;
  for (const sess of scenario.evSessions) {
    for (let pass = 0; pass < 4; pass++) {
      let delivered = 0;
      for (let k = sess.arriveStep; k < sess.departStep; k++) delivered += evKw[k] * DT_H;
      const short = sess.needKwh - delivered;
      if (short <= 0 || short > 1e-6) break;
      const add = (short / DT_H) * (1 + 1e-9) + 1e-15 * (pass + 1);
      let k = sess.departStep - 1;
      while (k > sess.arriveStep && !(evKw[k] > 0 && evKw[k] + add <= maxKw)) k--;
      evKw[k] += add;
    }
  }
}

/**
 * Turns a dispatch (battery charge / discharge and EV power per step) into a
 * full PolicyResult using the REALISED scenario: state of charge from the
 * battery equation, grid import/export from the power balance, costs from the
 * realised prices. Every policy goes through this one function, so their
 * accounting is identical.
 */
export function assembleResult(
  scenario: Scenario,
  policy: PolicyId,
  battChargeKw: Float64Array,
  battDischargeKw: Float64Array,
  evKw: Float64Array,
): PolicyResult {
  const n = scenario.n;
  const { etaC, etaD } = batteryEff(scenario);
  const cap = scenario.config.battKwh;
  const gridImportKw = new Float64Array(n);
  const gridExportKw = new Float64Array(n);
  const socKwh = new Float64Array(n + 1);
  const evDeliveredKwh = new Float64Array(n + 1);
  const stepCost = new Float64Array(n);
  const cumCost = new Float64Array(n + 1);

  const arrive = new Uint8Array(n);
  for (const s of scenario.evSessions) arrive[s.arriveStep] = 1;

  socKwh[0] = initialSocKwh(scenario);
  let delivered = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    if (arrive[k]) delivered = 0;
    evDeliveredKwh[k] = delivered;
    const c = battChargeKw[k];
    const d = battDischargeKw[k];
    const e = evKw[k];
    const net = scenario.loadKw[k] + e + c - scenario.pvKw[k] - d; // > 0: import
    if (net >= 0) gridImportKw[k] = net;
    else gridExportKw[k] = -net;
    let soc = socKwh[k] + (etaC * c - d / etaD) * DT_H;
    // Remove floating-point / LP-tolerance dust at the bounds (never more than SNAP_KWH).
    if (soc < 0 && soc > -SNAP_KWH) soc = 0;
    else if (soc > cap && soc < cap + SNAP_KWH) soc = cap;
    socKwh[k + 1] = soc;
    delivered += e * DT_H;
    const cost = (scenario.buy[k] * gridImportKw[k] - scenario.sell[k] * gridExportKw[k]) * DT_H;
    stepCost[k] = cost;
    cumCost[k] = total;
    total += cost;
  }
  cumCost[n] = total;
  evDeliveredKwh[n] = delivered;
  const init = socKwh[0];
  if (socKwh[n] < init && socKwh[n] > init - SNAP_KWH) socKwh[n] = init;

  return {
    policy,
    battChargeKw,
    battDischargeKw,
    evKw,
    gridImportKw,
    gridExportKw,
    socKwh,
    evDeliveredKwh,
    stepCost,
    cumCost,
    totalCost: total,
  };
}
