/**
 * The overlay HUD: clock, per-policy cost cards, gap readout, arbitrage line,
 * latency readout, loading indicator and error toast. Pure DOM writes; every
 * number comes from SolveResult / ArbitrageInsight / Scenario.
 */
import { DT_H, type ArbitrageInsight, type PolicyId, type PolicyResult, type Scenario, type SolveResult } from '../shared/types';
import { cents, clockLabel, kw, money, signedCents, signedMoney, signedPct } from './format';
import { runningCost, sessionNeedKwh, stepPos, type StepPos } from './frame';

/** Anything that would print as "0.0 kW" is idle. */
const EPS_KW = 0.05;

const ICONS = {
  grid: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5 4.5 14.5M8 1.5l3.5 13M3 5h10M4 9h8M5.5 5l6 4M10.5 5l-6 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  batt: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.5" y="4.5" width="11.5" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M14.5 6.7v2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3.2" y="6.2" width="5" height="3.6" rx=".6" fill="currentColor"/></svg>',
  ev: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 10.5V8.2l1.5-3.1a1 1 0 0 1 .9-.6h7.2a1 1 0 0 1 .9.6L14 8.2v2.3M2 8.2h12M2 10.5h12v1.2a.6.6 0 0 1-.6.6h-1a.6.6 0 0 1-.6-.6v-.4H4.2v.4a.6.6 0 0 1-.6.6h-1a.6.6 0 0 1-.6-.6v-1.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  pv: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="2.8" fill="currentColor"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  load: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2 2 7.2V14h4v-4h4v4h4V7.2L8 2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

/** Writes textContent only when it changed (the HUD updates every frame). */
class Txt {
  private last: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(s: string): void {
    if (s !== this.last) {
      this.last = s;
      this.el.textContent = s;
    }
  }
}

class Cls {
  private last: string | null = null;
  constructor(
    readonly el: HTMLElement,
    private attr: string,
  ) {}
  set(v: string): void {
    if (v !== this.last) {
      this.last = v;
      this.el.setAttribute(this.attr, v);
    }
  }
}

interface CardRefs {
  cost: Txt;
  total: Txt;
  gridV: Txt;
  gridN: Txt;
  gridState: Cls;
  battV: Txt;
  battN: Txt;
  battState: Cls;
  socBar: HTMLElement;
  evV: Txt;
  evN: Txt;
  evBar: HTMLElement;
  evState: Cls;
  pvV: Txt;
  loadV: Txt;
  lastSoc: number;
  lastEv: number;
}

function row(key: string, icon: string, label: string, extra = ''): string {
  return (
    `<div class="row row-${key}" data-state="idle" title="${label}">` +
    `<span class="row-ico">${icon}</span><span class="row-v" data-ref="${key}V">–</span>` +
    `<span class="row-n" data-ref="${key}N"></span>${extra}</div>`
  );
}

function buildCard(root: HTMLElement, policy: PolicyId): CardRefs {
  const name = policy === 'mpc' ? 'MPC' : 'DP';
  const sub = policy === 'mpc' ? 'noisy forecast' : 'perfect hindsight';
  root.innerHTML =
    `<div class="card-head"><span class="dot"></span><span class="card-name">${name}</span><span class="card-sub">${sub}</span></div>` +
    `<div class="card-cost"><span class="cost" data-testid="cost-${policy}">–</span><span class="cost-cap">so far</span>` +
    `<span class="card-total" data-ref="total"></span></div>` +
    `<div class="rows">` +
    row('grid', ICONS.grid, 'Grid') +
    row('batt', ICONS.batt, 'Battery', '<span class="bar"><i data-ref="socBar"></i></span>') +
    row('ev', ICONS.ev, 'EV', '<span class="bar"><i data-ref="evBar"></i></span>') +
    row('pv', ICONS.pv, 'Solar') +
    row('load', ICONS.load, 'Home') +
    `</div>`;
  const q = (ref: string) => root.querySelector(`[data-ref="${ref}"]`) as HTMLElement;
  const rowEl = (key: string) => root.querySelector(`.row-${key}`) as HTMLElement;
  return {
    cost: new Txt(root.querySelector('.cost') as HTMLElement),
    total: new Txt(q('total')),
    gridV: new Txt(q('gridV')),
    gridN: new Txt(q('gridN')),
    gridState: new Cls(rowEl('grid'), 'data-state'),
    battV: new Txt(q('battV')),
    battN: new Txt(q('battN')),
    battState: new Cls(rowEl('batt'), 'data-state'),
    socBar: q('socBar'),
    evV: new Txt(q('evV')),
    evN: new Txt(q('evN')),
    evBar: q('evBar'),
    evState: new Cls(rowEl('ev'), 'data-state'),
    pvV: new Txt(q('pvV')),
    loadV: new Txt(q('loadV')),
    lastSoc: -1,
    lastEv: -1,
  };
}

export class Hud {
  private clock = new Txt(byId('clock', true));
  private latency = new Txt(byId('latency', true));
  private latencyEl = byId('latency', true);
  private gap = new Txt(byId('gap', true));
  private gapEl = byId('gap', true);
  private gapTotal = new Txt(byId('gap-total'));
  private arbEl = byId('arbitrage');
  private arbHeadline = new Txt(byId('arb-headline'));
  private arbDetail = new Txt(byId('arb-detail'));
  private arbTip = byId('arb-detail');
  private loadingEl = byId('loading');
  private loadingText = new Txt(byId('loading-text'));
  private toastEl = byId('toast');
  private brandSub = new Txt(byId('brand-sub'));
  private cards: Record<PolicyId, CardRefs>;
  private toastTimer = 0;

  constructor() {
    const stage = byId('stage');
    const fit = () => {
      const compact = window.innerWidth <= 1200 || stage.clientHeight < 430;
      stage.classList.toggle('compact', compact);
    };
    new ResizeObserver(fit).observe(stage);
    fit();
    this.cards = {
      mpc: buildCard(byId('card-mpc'), 'mpc'),
      dp: buildCard(byId('card-dp'), 'dp'),
    };
  }

  setConfigSummary(scenario: Scenario): void {
    const c = scenario.config;
    this.brandSub.set(
      `${c.pvKwp} kWp solar · ${c.battKwh} kWh battery · EV needs ${c.evNeedKwh} kWh a night · Christchurch`,
    );
  }

  setClock(scenario: Scenario, timeH: number): void {
    this.clock.set(clockLabel(scenario.config, timeH));
  }

  /** Per-frame update of everything that depends on the playhead. */
  update(result: SolveResult, timeH: number): { costMpc: number; costDp: number; gap: number } {
    const s = result.scenario;
    const p = stepPos(s.n, timeH);
    const costMpc = runningCost(result.mpc, p);
    const costDp = runningCost(result.dp, p);
    const gap = costMpc - costDp;
    this.card(this.cards.mpc, s, result.mpc, p, costMpc);
    this.card(this.cards.dp, s, result.dp, p, costDp);

    this.gap.set(`${signedMoney(gap)} (${pctOf(gap, costDp)})`);
    this.gapEl.dataset.sign = gap > 0.005 ? 'pos' : gap < -0.005 ? 'neg' : 'zero';
    const totalGap = result.mpc.totalCost - result.dp.totalCost;
    this.gapTotal.set(
      `full ${Math.round(s.n * DT_H)} h: ${signedMoney(totalGap)} (${pctOf(totalGap, result.dp.totalCost)})`,
    );
    return { costMpc, costDp, gap };
  }

  private card(c: CardRefs, s: Scenario, r: PolicyResult, p: StepPos, cost: number): void {
    const k = p.k;
    c.cost.set(money(cost));
    c.total.set(`${Math.round(s.n * DT_H)} h: ${money(r.totalCost)}`);

    const imp = r.gridImportKw[k];
    const exp = r.gridExportKw[k];
    if (imp > EPS_KW && imp >= exp) {
      c.gridV.set(kw(imp));
      c.gridN.set(`imp ${cents(s.buy[k], 0)}`);
      c.gridState.set('import');
    } else if (exp > EPS_KW) {
      c.gridV.set(kw(exp));
      c.gridN.set(`exp ${cents(s.sell[k], 0)}`);
      c.gridState.set('export');
    } else {
      c.gridV.set(kw(0));
      c.gridN.set('idle');
      c.gridState.set('idle');
    }

    const ch = r.battChargeKw[k];
    const dis = r.battDischargeKw[k];
    const socNow = r.socKwh[k] + p.f * (r.socKwh[k + 1] - r.socKwh[k]);
    const socPct = Math.round((socNow / s.config.battKwh) * 100);
    if (ch > EPS_KW && ch >= dis) {
      c.battV.set(kw(ch));
      c.battN.set(`chg · ${socPct}%`);
      c.battState.set('charge');
    } else if (dis > EPS_KW) {
      c.battV.set(kw(dis));
      c.battN.set(`dis · ${socPct}%`);
      c.battState.set('discharge');
    } else {
      c.battV.set(kw(0));
      c.battN.set(`idle · ${socPct}%`);
      c.battState.set('idle');
    }
    if (socPct !== c.lastSoc) {
      c.lastSoc = socPct;
      c.socBar.style.width = `${Math.max(0, Math.min(100, socPct))}%`;
    }

    const plugged = s.evPlugged[k] === 1;
    const need = sessionNeedKwh(s, k);
    const delivered = plugged
      ? r.evDeliveredKwh[k] + p.f * (r.evDeliveredKwh[k + 1] - r.evDeliveredKwh[k])
      : r.evDeliveredKwh[k];
    c.evV.set(plugged ? kw(r.evKw[k]) : '–');
    if (plugged) {
      c.evN.set(`${delivered.toFixed(1)}/${trim(need)} kWh`);
      c.evState.set(r.evKw[k] > EPS_KW ? 'charge' : 'idle');
    } else {
      c.evN.set(need > 0 ? `away · ${delivered.toFixed(1)} kWh` : 'away');
      c.evState.set('away');
    }
    const evPct = need > 0 ? Math.round(Math.max(0, Math.min(1, delivered / need)) * 100) : 0;
    if (evPct !== c.lastEv) {
      c.lastEv = evPct;
      c.evBar.style.width = `${evPct}%`;
    }

    c.pvV.set(kw(s.pvKw[k]));
    c.loadV.set(kw(s.loadKw[k]));
  }

  setLatency(latencyMs: number, result: SolveResult, drag: { medianMs: number; n: number } | null = null): void {
    const t = result.timing;
    const lp = `${t.lpSolves} LP${t.lpSolves === 1 ? '' : 's'}`;
    this.latency.set(
      `re-solve ${Math.round(latencyMs)} ms · DP ${Math.round(t.dpMs)} · MPC ${Math.round(t.mpcMs)} (${lp})` +
        (drag && drag.n >= 2 ? ` · drag median ${Math.round(drag.medianMs)} ms (n=${drag.n})` : '') +
        ` · ${result.solver}`,
    );
    this.latencyEl.title =
      `Round trip ${latencyMs.toFixed(1)} ms (request posted -> result applied). ` +
      `Worker: scenario ${t.scenarioMs.toFixed(1)} ms, DP ${t.dpMs.toFixed(1)} ms, MPC ${t.mpcMs.toFixed(1)} ms ` +
      `(${t.lpSolves} LPs, re-solved from step ${t.mpcFromStep}), total ${t.totalMs.toFixed(1)} ms. Solver: ${result.solver}.`;
  }

  setLatencyText(text: string): void {
    this.latency.set(text);
  }

  setBusy(busy: boolean): void {
    this.latencyEl.classList.toggle('busy', busy);
  }

  setInsight(insight: ArbitrageInsight | null, stale: boolean): void {
    this.arbEl.classList.toggle('stale', stale && insight !== null);
    if (!insight) return;
    this.arbEl.classList.remove('pending');
    this.arbEl.dataset.pays = insight.pays ? 'yes' : 'no';
    this.arbHeadline.set(insight.headline);
    this.arbDetail.set(
      `arbitrage value ${money(insight.arbitrageValuePerDay)}/day · grid-charged ${insight.gridChargedKwh.toFixed(1)} kWh · ` +
        `best export spread ${signedCents(insight.bestExportSpread)}/kWh · best shift spread ${signedCents(insight.bestShiftSpread)}/kWh · ` +
        (typeof insight.arbitrageExportKwh === 'number'
          ? `re-exported from grid ${insight.arbitrageExportKwh.toFixed(1)} kWh · `
          : '') +
        `no-battery cost ${money(insight.noBatteryCost)}`,
    );
    this.arbEl.title =
      `Hindsight-optimal (DP) runs of this scenario:\n` +
      `  as solved: ${money(insight.dpCost)}\n` +
      `  battery may not charge from the grid: ${money(insight.noGridChargeCost)}\n` +
      `  no battery at all: ${money(insight.noBatteryCost)}\n` +
      `Arbitrage value: ${money(insight.arbitrageValue)} over the scenario (${money(insight.arbitrageValuePerDay)}/day)\n` +
      `Battery charged from grid: ${insight.gridChargedKwh.toFixed(2)} kWh; battery exported to grid: ${insight.batteryExportedKwh.toFixed(2)} kWh` +
      (typeof insight.arbitrageExportKwh === 'number' ? `; re-exported from grid: ${insight.arbitrageExportKwh.toFixed(2)} kWh` : '') + `\n` +
      `Best buy-then-export spread after losses: ${signedCents(insight.bestExportSpread, 2)}/kWh\n` +
      `Best buy-low-avoid-high spread after losses: ${signedCents(insight.bestShiftSpread, 2)}/kWh`;
  }

  setLoading(text: string | null): void {
    if (text === null) {
      this.loadingEl.classList.add('done');
      this.loadingEl.removeAttribute('data-hud-overlay');
    } else {
      this.loadingEl.classList.remove('done');
      this.loadingEl.setAttribute('data-hud-overlay', '');
      this.loadingText.set(text);
    }
  }

  showError(message: string | null, sticky = false): void {
    window.clearTimeout(this.toastTimer);
    const hide = () => {
      this.toastEl.hidden = true;
      this.toastEl.removeAttribute('data-hud-overlay');
    };
    if (message === null) {
      hide();
      return;
    }
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    this.toastEl.setAttribute('data-hud-overlay', '');
    if (!sticky) this.toastTimer = window.setTimeout(hide, 9000);
  }
}

/** Gap as a percentage of the magnitude of the DP cost (n/a when that cost is ~0). */
function pctOf(gap: number, dpCost: number): string {
  if (!(Math.abs(dpCost) > 0.05)) return 'n/a';
  return signedPct(gap / Math.abs(dpCost));
}

function trim(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function byId(id: string, testId = false): HTMLElement {
  const el = testId ? document.querySelector(`[data-testid="${id}"]`) : document.getElementById(id);
  if (!el) throw new Error(`missing element ${id}`);
  return el as HTMLElement;
}
