/**
 * The timeline: a HiDPI canvas (curves) plus a DOM overlay (draggable event chips).
 *
 * Tracks, top to bottom, on one shared time axis:
 *   PRICES  realised buy / feed-in, TOU baselines, MPC forecast issued at the playhead
 *   SOLAR   clear-sky PV, realised PV, forecast PV, cloud band
 *   BATTERY state of charge, MPC vs DP
 *   GRID    import (up) / export (down), MPC vs DP
 *   EV      charging power, MPC vs DP
 *
 * Everything drawn comes from Scenario / forecastAt / SolveResult.
 */
import { DT_H, type Forecast, type PolicyResult, type Scenario, type ScenarioEvent, type SolveResult } from '../shared/types';
import type { SimApi } from './backend';
import { clamp, clockHourAt, dayAt, hhmm, niceStep } from './format';
import { stepPos } from './frame';
import { COLORS, FONT, rgba } from './theme';

export interface TimelineView {
  /** Scenario for the CURRENT events/config (rebuilt on the main thread, so it never lags a drag). */
  scenario: Scenario;
  /** Last solved result (may briefly lag the scenario while a re-solve is in flight). */
  result: SolveResult | null;
  events: ScenarioEvent[];
  timeH: number;
}

export interface TimelineHandlers {
  onScrub(timeH: number): void;
  /** `final` = pointer released / discrete edit: the app then asks for the insight too. */
  onEventChange(id: string, patch: Partial<ScenarioEvent>, final: boolean): void;
  onEventDelete(id: string): void;
}

export const SPIKE_MIN = 0.05;
export const SPIKE_MAX = 1.5;
export const CLOUD_MIN = 0.1;
export const CLOUD_MAX = 1.0;
const DURATION_MAX = 16;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  px: number; // plot left
  pw: number; // plot width
  axis: Rect;
  price: Rect;
  solar: Rect;
  soc: Rect;
  grid: Rect;
  ev: Rect;
}

interface Chip {
  el: HTMLDivElement;
  label: HTMLSpanElement;
  sub: HTMLSpanElement;
  text: string;
  subText: string;
  width: number;
  height: number;
}

interface Drag {
  id: string;
  pointerId: number;
  x0: number;
  y0: number;
  startStep0: number;
  magnitude0: number;
  /** Magnitude change per pixel of upward movement (frozen at drag start). */
  perPx: number;
  moved: boolean;
}

const ICON_BOLT =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9.3 1 3.5 9h3.6L6.2 15l6.3-8.4H8.8L9.3 1z" fill="currentColor"/></svg>';
const ICON_CLOUD =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.6 12.5a3.1 3.1 0 0 1-.5-6.16 4.2 4.2 0 0 1 8.06 1.02A2.6 2.6 0 0 1 11.6 12.5H4.6z" fill="currentColor"/></svg>';

export function eventLabel(e: ScenarioEvent): string {
  return e.kind === 'priceSpike' ? `+${Math.round(e.magnitude * 100)}c` : `${Math.round(e.magnitude * 100)}% cloud`;
}

export class Timeline {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLDivElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** Canvas text scale (bigger on very large viewports). */
  private fs = 1;
  private L: Layout | null = null;
  private view: TimelineView | null = null;
  private dirty = true;
  private lastNow = 0;

  // Animated y-scales.
  private priceMax = 0;
  private gridUp = 0;
  private gridDown = 0;

  private fc: Forecast | null = null;
  private fcScenario: Scenario | null = null;
  private fcK = -1;
  private nightKey = '';
  private nights: Array<[number, number]> = [];

  private chips = new Map<string, Chip>();
  private drag: Drag | null = null;
  private scrubbing = false;
  private lastMovedDragAt = -1e9;
  private tip: HTMLDivElement;
  /** Hovered position in steps (fractional), or -1. */
  private hoverStep = -1;
  private hoverX = 0;
  private hoverY = 0;

  constructor(
    private root: HTMLElement,
    private sim: SimApi,
    private handlers: TimelineHandlers,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tl-canvas';
    this.overlay = document.createElement('div');
    this.overlay.className = 'tl-overlay';
    this.tip = document.createElement('div');
    this.tip.className = 'tl-tip';
    this.tip.hidden = true;
    this.overlay.appendChild(this.tip);
    root.append(this.canvas, this.overlay);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.bindScrub();
  }

  /** Id of the event being dragged, if any. */
  get draggingId(): string | null {
    return this.drag ? this.drag.id : null;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Call every animation frame; redraws only when something changed. */
  render(view: TimelineView, now: number): void {
    const prev = this.view;
    if (
      !prev ||
      prev.scenario !== view.scenario ||
      prev.result !== view.result ||
      prev.events !== view.events ||
      prev.timeH !== view.timeH
    ) {
      this.dirty = true;
    }
    this.view = view;
    const dt = clamp((now - this.lastNow) / 1000, 0, 0.1);
    this.lastNow = now;
    if (this.w < 10 || this.h < 10) return;

    // Forecast issued at the playhead step.
    const { k } = stepPos(view.scenario.n, view.timeH);
    if (this.fcScenario !== view.scenario || this.fcK !== k) {
      this.fc = this.sim.forecastAt(view.scenario, k);
      this.fcScenario = view.scenario;
      this.fcK = k;
      this.dirty = true;
    }
    if (this.easeScales(view, dt)) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.L = this.computeLayout();
    this.draw(view, this.L);
    this.syncChips(view, this.L);
    this.syncTip(view);
  }

  // ------------------------------------------------------------------ layout

  private resize(): void {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.fs = w >= 1900 ? 1.2 : 1;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.dirty = true;
    // Redraw right away so a resize never shows a blank frame.
    if (this.view && w >= 10 && h >= 10) {
      this.dirty = false;
      this.L = this.computeLayout();
      this.draw(this.view, this.L);
      this.syncChips(this.view, this.L);
    }
  }

  private computeLayout(): Layout {
    const gutL = Math.round(58 * this.fs);
    const gutR = 14;
    const axisH = 24;
    const gap = this.h < 230 ? 4 : 6;
    const px = gutL;
    const pw = Math.max(50, this.w - gutL - gutR);
    const avail = Math.max(60, this.h - axisH - gap * 4 - 3);
    const weights = this.h < 230 ? [1.6, 1.0, 0.56, 0.66, 0.42] : [1.4, 0.95, 0.62, 0.7, 0.48];
    const sum = weights.reduce((a, b) => a + b, 0);
    let y = axisH;
    const rects: Rect[] = weights.map((wt) => {
      const hh = Math.floor((avail * wt) / sum);
      const r = { x: px, y, w: pw, h: hh };
      y += hh + gap;
      return r;
    });
    return {
      px,
      pw,
      axis: { x: px, y: 0, w: pw, h: axisH },
      price: rects[0],
      solar: rects[1],
      soc: rects[2],
      grid: rects[3],
      ev: rects[4],
    };
  }

  private font(weight: number, px: number): string {
    return `${weight} ${Math.round(px * this.fs * 10) / 10}px ${FONT}`;
  }

  private xOf(L: Layout, n: number, step: number): number {
    return L.px + (step / n) * L.pw;
  }

  // ------------------------------------------------------------------ scales

  private easeScales(view: TimelineView, dt: number): boolean {
    const s = view.scenario;
    let pm = 0.3;
    for (let i = 0; i < s.n; i++) pm = Math.max(pm, s.buy[i]);
    if (this.fc) for (let j = 0; j < this.fc.length; j++) pm = Math.max(pm, this.fc.buy[j]);
    pm *= 1.14;
    let up = 2;
    let down = 2;
    const r = view.result;
    if (r) {
      for (const p of [r.mpc, r.dp]) {
        for (let i = 0; i < p.gridImportKw.length; i++) {
          up = Math.max(up, p.gridImportKw[i]);
          down = Math.max(down, p.gridExportKw[i]);
        }
      }
    }
    up *= 1.12;
    down *= 1.12;
    const a = this.priceMax === 0 ? 1 : 1 - Math.exp(-dt * 9);
    let moving = false;
    const ease = (cur: number, target: number): number => {
      const next = cur + (target - cur) * a;
      if (Math.abs(next - target) > target * 0.002) {
        moving = true;
        return next;
      }
      if (next !== cur) moving = true;
      return target;
    };
    this.priceMax = ease(this.priceMax, pm);
    this.gridUp = ease(this.gridUp, up);
    this.gridDown = ease(this.gridDown, down);
    return moving;
  }

  private nightBands(s: Scenario): Array<[number, number]> {
    const c = s.config;
    const key = `${c.days}|${c.startHour}|${c.dayOfYear}|${c.latitudeDeg}`;
    if (key === this.nightKey) return this.nights;
    const out: Array<[number, number]> = [];
    const sub = 6; // samples per step (5 minutes)
    let start = -1;
    for (let i = 0; i <= s.n * sub; i++) {
      const stepF = i / sub;
      const night = this.sim.sunPosition(c, stepF * DT_H).elevationDeg < 0;
      if (night && start < 0) start = stepF;
      if (!night && start >= 0) {
        out.push([start, stepF]);
        start = -1;
      }
    }
    if (start >= 0) out.push([start, s.n]);
    this.nightKey = key;
    this.nights = out;
    return out;
  }

  // ------------------------------------------------------------------ drawing

  private draw(view: TimelineView, L: Layout): void {
    const ctx = this.ctx;
    const s = view.scenario;
    const n = s.n;
    const { k } = stepPos(n, view.timeH);
    const tStep = clamp(view.timeH / DT_H, 0, n);
    const xPlay = this.xOf(L, n, tStep);
    const X = (step: number) => this.xOf(L, n, step);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';

    const tracks = [L.price, L.solar, L.soc, L.grid, L.ev];
    const nights = this.nightBands(s);

    // Track backgrounds + night bands + day separators.
    for (const r of tracks) {
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 5);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(3,6,16,0.5)';
      for (const [a, b] of nights) ctx.fillRect(X(a), r.y, X(b) - X(a), r.h);
      ctx.restore();
    }

    this.drawAxis(ctx, L, s, nights, xPlay);
    this.drawPrice(ctx, L, s, k, xPlay, view.events);
    this.drawSolar(ctx, L, s, k, xPlay, view.events);
    this.drawDispatch(ctx, L, s, view.result);

    // Day separators through all tracks.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (let m = Math.ceil((s.config.startHour + 1e-9) / 24) * 24; m < s.config.startHour + n * DT_H - 1e-9; m += 24) {
      const x = Math.round(X((m - s.config.startHour) / DT_H)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, L.axis.h - 4);
      ctx.lineTo(x, L.ev.y + L.ev.h);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Hover cursor.
    const bottom = L.ev.y + L.ev.h;
    if (this.hoverStep >= 0 && !this.drag && !this.scrubbing) {
      const xh = Math.round(X(this.hoverStep)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xh, L.axis.h - 2);
      ctx.lineTo(xh, bottom);
      ctx.stroke();
    }

    // Playhead.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(xPlay, L.axis.h - 2);
    ctx.lineTo(xPlay, bottom);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(xPlay, L.axis.h - 2);
    ctx.lineTo(xPlay, bottom);
    ctx.stroke();
    const tag = hhmm(clockHourAt(s.config, Math.floor(view.timeH * 60 + 1e-6) / 60));
    ctx.font = this.font(700, 10.5);
    const tw = ctx.measureText(tag).width + 12;
    const tx = clamp(xPlay - tw / 2, 1, this.w - tw - 1);
    ctx.fillStyle = '#f4f7ff';
    roundRect(ctx, tx, 3, tw, 16, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(xPlay - 4, 18.5);
    ctx.lineTo(xPlay + 4, 18.5);
    ctx.lineTo(xPlay, 23);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, tx + tw / 2, 11.5);
  }

  private drawAxis(ctx: CanvasRenderingContext2D, L: Layout, s: Scenario, nights: Array<[number, number]>, xPlay: number): void {
    const n = s.n;
    const X = (step: number) => this.xOf(L, n, step);
    const pxPerHour = L.pw / (n * DT_H);
    const labelEvery = pxPerHour * 3 >= 62 ? 3 : pxPerHour * 6 >= 62 ? 6 : 12;
    const base = L.axis.h;

    // Night strip along the axis baseline.
    ctx.fillStyle = 'rgba(120,140,220,0.28)';
    for (const [a, b] of nights) ctx.fillRect(X(a), base - 3, X(b) - X(a), 2);

    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const totalH = n * DT_H;
    const start = s.config.startHour;
    const firstHour = Math.ceil(start);
    for (let hAbs = firstHour; hAbs <= start + totalH + 1e-9; hAbs++) {
      const t = hAbs - start;
      const x = Math.round(X(t / DT_H)) + 0.5;
      const clock = ((hAbs % 24) + 24) % 24;
      const major = clock % labelEvery === 0;
      const mid = clock % 3 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.38)' : mid ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(x, base - (major ? 7 : mid ? 5 : 3));
      ctx.lineTo(x, base - 1);
      ctx.stroke();
      if (major && x > L.px + 14 && x < L.px + L.pw - 14 && Math.abs(x - xPlay) > 36) {
        ctx.font = this.font(500, 10);
        ctx.fillStyle = clock === 0 ? COLORS.text : COLORS.textDim;
        ctx.textAlign = 'center';
        ctx.fillText(hhmm(clock), x, 10);
      }
      // Faint hour grid lines in the tracks at major ticks.
      if (major) {
        ctx.strokeStyle = 'rgba(255,255,255,0.045)';
        ctx.beginPath();
        ctx.moveTo(x, L.price.y);
        ctx.lineTo(x, L.ev.y + L.ev.h);
        ctx.stroke();
      }
    }
    // Day labels (a "day" is a 24 h block from the scenario start).
    ctx.font = this.font(700, 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    const dayMarks: Array<[number, number]> = [[0, 1]];
    for (let m = 24; m < start + totalH - 1e-9; m += 24) {
      if (m > start) dayMarks.push([(m - start) / DT_H, Math.floor(m / 24) + 1]);
    }
    for (const [step, day] of dayMarks) {
      const x = X(step) + (step === 0 ? 4 : 20);
      if (Math.abs(x + 12 - xPlay) > 36) ctx.fillText(`Day ${day}`, x, 10);
    }
  }

  private gutter(ctx: CanvasRenderingContext2D, r: Rect, title: string, unit: string, ticks: Array<[number, string]>): void {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = this.font(700, 9);
    ctx.fillStyle = COLORS.textDim;
    const titleY = r.y + 7;
    ctx.fillText(title, 4, titleY);
    const titleW = ctx.measureText(title).width;
    if (unit && r.h >= 30) {
      ctx.font = this.font(500, 9);
      ctx.fillStyle = COLORS.textFaint;
      ctx.fillText(unit, 4, titleY + 11);
    }
    ctx.font = this.font(500, 9.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textDim;
    const gutW = r.x - 6;
    const blockedBelow = titleY + (unit && r.h >= 30 ? 17 : 6);
    for (const [y, label] of ticks) {
      if (y < r.y - 1 || y > r.y + r.h + 1) continue;
      const lw = ctx.measureText(label).width;
      const yy = clamp(y, r.y + 5, r.y + r.h - 5);
      const collides = yy - 5 < blockedBelow && gutW - lw < 4 + titleW + 4;
      const collidesUnit = unit && r.h >= 30 && yy - 5 < blockedBelow && yy + 5 > titleY + 5 && gutW - lw < 4 + 30;
      if (collides || collidesUnit) continue;
      ctx.fillText(label, gutW, yy);
    }
  }

  private drawPrice(
    ctx: CanvasRenderingContext2D,
    L: Layout,
    s: Scenario,
    k: number,
    xPlay: number,
    events: ScenarioEvent[],
  ): void {
    const r = L.price;
    const n = s.n;
    const X = (step: number) => this.xOf(L, n, step);
    const max = this.priceMax;
    const Y = (v: number) => r.y + r.h - 1 - (v / max) * (r.h - 4);

    // Ticks in c/kWh.
    const stepC = niceStep(max * 100, r.h > 70 ? 4 : 3);
    const ticks: Array<[number, string]> = [];
    ctx.lineWidth = 1;
    for (let c = 0; c <= max * 100 + 1e-9; c += stepC) {
      const y = Math.round(Y(c / 100)) + 0.5;
      ticks.push([y, String(Math.round(c))]);
      if (c > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
        ctx.stroke();
      }
    }
    this.gutter(ctx, r, 'PRICE', 'c/kWh', ticks);

    ctx.save();
    roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.clip();

    // Event footprints.
    for (const e of events) {
      if (e.kind !== 'priceSpike') continue;
      const x0 = X(e.startStep);
      const x1 = X(e.startStep + e.durationSteps);
      const active = this.drag?.id === e.id;
      ctx.fillStyle = rgba(COLORS.buy, active ? 0.2 : 0.1);
      ctx.fillRect(x0, r.y, x1 - x0, r.h);
      ctx.fillStyle = rgba(COLORS.buy, active ? 0.9 : 0.55);
      ctx.fillRect(x0, r.y + r.h - 2, x1 - x0, 2);
    }

    // TOU baselines (what a forecaster knows for certain).
    ctx.setLineDash([1.5, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(COLORS.buy, 0.5);
    stepPath(ctx, s.buyBase, 0, n, X, Y);
    ctx.stroke();
    ctx.strokeStyle = rgba(COLORS.sell, 0.5);
    stepPath(ctx, s.sellBase, 0, n, X, Y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Realised prices: full strength in the past, dimmer in the (not yet known) future.
    const realised = (alpha: number) => {
      // buy area
      const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
      g.addColorStop(0, rgba(COLORS.buy, 0.22 * alpha));
      g.addColorStop(1, rgba(COLORS.buy, 0.0));
      stepPath(ctx, s.buy, 0, n, X, Y);
      ctx.lineTo(X(n), r.y + r.h);
      ctx.lineTo(X(0), r.y + r.h);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(COLORS.sell, alpha);
      stepPath(ctx, s.sell, 0, n, X, Y);
      ctx.stroke();
      ctx.lineWidth = 1.7;
      ctx.strokeStyle = rgba(COLORS.buy, alpha);
      stepPath(ctx, s.buy, 0, n, X, Y);
      ctx.stroke();
    };
    splitAt(ctx, r, xPlay, () => realised(1), () => realised(0.5));

    // MPC forecast issued at the playhead (dashed, from the playhead forward).
    const fc = this.fc;
    if (fc && fc.length > 0) {
      const end = k + fc.length;
      ctx.save();
      ctx.beginPath();
      ctx.rect(xPlay, r.y, r.x + r.w - xPlay, r.h);
      ctx.clip();
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#d9fbe8';
      stepPathOffset(ctx, fc.sell, k, end, X, Y);
      ctx.stroke();
      ctx.strokeStyle = '#ffe3ec';
      stepPathOffset(ctx, fc.buy, k, end, X, Y);
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      // Label the end of the look-ahead unless a spike chip sits there.
      const xEnd = X(end);
      const clear = !events.some((e) => {
        if (e.kind !== 'priceSpike') return false;
        const cx = X(e.startStep + e.durationSteps / 2);
        return cx > xEnd - 50 && cx < xEnd + 130;
      });
      this.horizonMark(ctx, r, xEnd, end < n && clear);
    }
    ctx.restore();
  }

  /** Thin marker where the MPC's look-ahead ends. */
  private horizonMark(ctx: CanvasRenderingContext2D, r: Rect, x: number, label: boolean): void {
    if (x >= r.x + r.w - 1) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, r.y);
    ctx.lineTo(Math.round(x) + 0.5, r.y + r.h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label && x + 74 < r.x + r.w) {
      ctx.font = this.font(600, 8.5);
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('MPC HORIZON', x + 4, r.y + 7);
    }
  }

  private drawSolar(
    ctx: CanvasRenderingContext2D,
    L: Layout,
    s: Scenario,
    k: number,
    xPlay: number,
    events: ScenarioEvent[],
  ): void {
    const r = L.solar;
    const n = s.n;
    const X = (step: number) => this.xOf(L, n, step);
    let max = 0.5;
    for (let i = 0; i < n; i++) max = Math.max(max, s.clearSkyKw[i], s.pvKw[i]);
    const fc = this.fc;
    if (fc) for (let j = 0; j < fc.length; j++) max = Math.max(max, fc.pvKw[j]);
    max *= 1.3; // headroom for the cloud band
    const Y = (v: number) => r.y + r.h - 1 - (v / max) * (r.h - 3);
    const tk = niceStep(max / 1.3, 2);
    const ticks: Array<[number, string]> = [];
    for (let v = 0; v <= max / 1.3 + 1e-9; v += tk) ticks.push([Math.round(Y(v)) + 0.5, String(Math.round(v * 10) / 10)]);
    this.gutter(ctx, r, 'SOLAR', 'kW', ticks);

    ctx.save();
    roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.clip();

    for (const e of events) {
      if (e.kind !== 'cloud') continue;
      const x0 = X(e.startStep);
      const x1 = X(e.startStep + e.durationSteps);
      const active = this.drag?.id === e.id;
      ctx.fillStyle = rgba(COLORS.cloud, active ? 0.2 : 0.1);
      ctx.fillRect(x0, r.y, x1 - x0, r.h);
      ctx.fillStyle = rgba(COLORS.cloud, active ? 0.9 : 0.55);
      ctx.fillRect(x0, r.y + r.h - 2, x1 - x0, 2);
    }

    // Clear-sky outline.
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(COLORS.pv, 0.4);
    ctx.setLineDash([1.5, 3]);
    centrePath(ctx, s.clearSkyKw, 0, n, 0, X, Y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Realised PV.
    const pv = (alpha: number) => {
      const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
      g.addColorStop(0, rgba(COLORS.pv, 0.6 * alpha));
      g.addColorStop(1, rgba(COLORS.pv, 0.1 * alpha));
      centrePath(ctx, s.pvKw, 0, n, 0, X, Y);
      ctx.lineTo(X(n), Y(0));
      ctx.lineTo(X(0), Y(0));
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(COLORS.pv, alpha);
      centrePath(ctx, s.pvKw, 0, n, 0, X, Y);
      ctx.stroke();
    };
    splitAt(ctx, r, xPlay, () => pv(1), () => pv(0.5));

    // Cloud cover: soft band hanging from the top of the track.
    const depth = Math.min(r.h * 0.42, 26);
    const cg = ctx.createLinearGradient(0, r.y, 0, r.y + depth);
    cg.addColorStop(0, rgba(COLORS.cloud, 0.62));
    cg.addColorStop(1, rgba(COLORS.cloud, 0.16));
    const YC = (c: number) => r.y + clamp(c, 0, 1) * depth;
    centrePath(ctx, s.cloud, 0, n, 0, X, YC);
    ctx.lineTo(X(n), r.y);
    ctx.lineTo(X(0), r.y);
    ctx.closePath();
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(COLORS.cloud, 0.55);
    centrePath(ctx, s.cloud, 0, n, 0, X, YC);
    ctx.stroke();

    // Forecast PV from the playhead.
    if (fc && fc.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(xPlay, r.y, r.x + r.w - xPlay, r.h);
      ctx.clip();
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#fff6d6';
      centrePath(ctx, fc.pvKw, 0, fc.length, k, X, Y);
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      this.horizonMark(ctx, r, X(k + fc.length), false);
    }
    ctx.restore();
  }

  private drawDispatch(ctx: CanvasRenderingContext2D, L: Layout, s: Scenario, result: SolveResult | null): void {
    const n = s.n;
    const X = (step: number) => this.xOf(L, n, step);
    const cfg = s.config;

    // --- Battery SoC
    {
      const r = L.soc;
      const Y = (kwh: number) => r.y + r.h - 2 - (kwh / cfg.battKwh) * (r.h - 4);
      this.gutter(ctx, r, 'BATTERY', r.h >= 30 ? 'SoC %' : '', [
        [Y(cfg.battKwh), '100'],
        [Y(0), '0'],
      ]);
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 5);
      ctx.clip();
      // Required final SoC (= initial SoC).
      const yT = Math.round(Y(cfg.battInitFrac * cfg.battKwh)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(r.x, yT);
      ctx.lineTo(r.x + r.w, yT);
      ctx.stroke();
      ctx.setLineDash([]);
      if (result) {
        const line = (p: PolicyResult, color: string, width: number) => {
          const m = Math.min(n, p.socKwh.length - 1);
          ctx.beginPath();
          for (let i = 0; i <= m; i++) {
            const x = X(i);
            const y = Y(p.socKwh[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.stroke();
        };
        line(result.dp, rgba(COLORS.dp, 0.95), 2.4);
        line(result.mpc, COLORS.mpc, 1.4);
      }
      ctx.restore();
    }

    // --- Grid import (up) / export (down)
    {
      const r = L.grid;
      const up = this.gridUp;
      const down = this.gridDown;
      const Y = (v: number) => r.y + 2 + ((up - v) / (up + down)) * (r.h - 4);
      const y0 = Math.round(Y(0)) + 0.5;
      this.gutter(ctx, r, 'GRID', r.h >= 30 ? 'kW ±' : '', [
        [Y(up / 1.12), `+${Math.round(up / 1.12)}`],
        [Y(-down / 1.12), `-${Math.round(down / 1.12)}`],
      ]);
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 5);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x, y0);
      ctx.lineTo(r.x + r.w, y0);
      ctx.stroke();
      if (result) {
        const series = (p: PolicyResult, color: string, width: number) => {
          const m = Math.min(n, p.gridImportKw.length);
          const val = (i: number) => p.gridImportKw[i] - p.gridExportKw[i];
          ctx.beginPath();
          ctx.moveTo(X(0), Y(0));
          for (let i = 0; i < m; i++) {
            const y = Y(val(i));
            ctx.lineTo(X(i), y);
            ctx.lineTo(X(i + 1), y);
          }
          ctx.lineTo(X(m), Y(0));
          ctx.closePath();
          ctx.fillStyle = rgba(color, 0.16);
          ctx.fill();
          ctx.beginPath();
          for (let i = 0; i < m; i++) {
            const y = Y(val(i));
            if (i === 0) ctx.moveTo(X(i), y);
            else ctx.lineTo(X(i), y);
            ctx.lineTo(X(i + 1), y);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.stroke();
        };
        series(result.dp, COLORS.dp, 2.2);
        series(result.mpc, COLORS.mpc, 1.3);
      }
      ctx.font = this.font(600, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.34)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      if (r.h >= 26) {
        ctx.fillText('IMPORT', r.x + 5, r.y + 6);
        ctx.fillText('EXPORT', r.x + 5, r.y + r.h - 6);
      }
      ctx.restore();
    }

    // --- EV charging power
    {
      const r = L.ev;
      const Y = (v: number) => r.y + r.h - 1 - (v / (cfg.evKw * 1.1)) * (r.h - 3);
      this.gutter(ctx, r, 'EV', r.h >= 30 ? 'kW' : '', [[Y(cfg.evKw), String(cfg.evKw)]]);
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 5);
      ctx.clip();
      // Plug-in windows.
      for (const ses of s.evSessions) {
        const x0 = X(ses.arriveStep);
        const x1 = X(ses.departStep);
        ctx.fillStyle = rgba(COLORS.ev, 0.1);
        ctx.fillRect(x0, r.y, x1 - x0, r.h);
        ctx.fillStyle = rgba(COLORS.ev, 0.55);
        ctx.fillRect(x0, r.y, 1.5, r.h);
        ctx.fillRect(x1 - 1.5, r.y, 1.5, r.h);
      }
      if (result) {
        const series = (p: PolicyResult, color: string, width: number) => {
          const m = Math.min(n, p.evKw.length);
          ctx.beginPath();
          ctx.moveTo(X(0), Y(0));
          for (let i = 0; i < m; i++) {
            const y = Y(p.evKw[i]);
            ctx.lineTo(X(i), y);
            ctx.lineTo(X(i + 1), y);
          }
          ctx.lineTo(X(m), Y(0));
          ctx.closePath();
          ctx.fillStyle = rgba(color, 0.16);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.stroke();
        };
        series(result.dp, COLORS.dp, 2.2);
        series(result.mpc, COLORS.mpc, 1.3);
      }
      ctx.restore();
      // Plug-in window captions (above the fills so they stay legible).
      ctx.font = this.font(600, 8);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(COLORS.ev, 0.8);
      for (const ses of s.evSessions) {
        const x0 = X(ses.arriveStep);
        const x1 = X(ses.departStep);
        const text = `EV PLUGGED IN · NEEDS ${Math.round(ses.needKwh * 10) / 10} kWh`;
        const short = 'EV PLUGGED IN';
        const room = x1 - x0 - 10;
        const label = ctx.measureText(text).width <= room ? text : ctx.measureText(short).width <= room ? short : '';
        if (label && r.h >= 22) ctx.fillText(label, x0 + 6, r.y + 6);
      }
      // The same windows as a thin strip on the axis.
      ctx.fillStyle = rgba(COLORS.ev, 0.55);
      for (const ses of s.evSessions) {
        ctx.fillRect(X(ses.arriveStep), L.axis.h - 6, X(ses.departStep) - X(ses.arriveStep), 1.5);
      }
    }
  }

  // ------------------------------------------------------------------ chips

  private syncChips(view: TimelineView, L: Layout): void {
    const s = view.scenario;
    const n = s.n;
    const seen = new Set<string>();
    for (const e of view.events) {
      seen.add(e.id);
      let chip = this.chips.get(e.id);
      if (!chip) {
        chip = this.createChip(e);
        this.chips.set(e.id, chip);
      }
      const text = eventLabel(e);
      if (text !== chip.text) {
        chip.text = text;
        chip.label.textContent = text;
        chip.width = 0;
      }
      const startClock = hhmm(clockHourAt(s.config, e.startStep * DT_H));
      const subText = `${startClock} · ${(e.durationSteps * DT_H).toFixed(1)} h`;
      if (subText !== chip.subText) {
        chip.subText = subText;
        chip.sub.textContent = subText;
        chip.width = 0;
        chip.el.title =
          (e.kind === 'priceSpike' ? `Price spike ${text}/kWh` : `Cloud event, ${text}`) +
          ` from ${startClock} for ${(e.durationSteps * DT_H).toFixed(1)} h. Drag sideways to move, up/down to resize, wheel to change duration, double-click to delete.`;
      }
      chip.el.setAttribute('aria-valuenow', String(e.magnitude));
      const dragging = this.drag?.id === e.id;
      chip.el.classList.toggle('dragging', dragging);
      if (chip.width === 0 || dragging) {
        chip.width = chip.el.offsetWidth;
        chip.height = chip.el.offsetHeight;
      }
      const chipH = chip.height || 20;
      const cx = this.xOf(L, n, e.startStep + e.durationSteps / 2);
      const half = chip.width / 2;
      const x = clamp(cx, half + 2, this.w - half - 2);
      let y: number;
      if (e.kind === 'priceSpike') {
        const r = L.price;
        let peak = 0;
        const a = clamp(e.startStep, 0, n - 1);
        const b = clamp(e.startStep + e.durationSteps, a + 1, n);
        for (let i = a; i < b; i++) peak = Math.max(peak, s.buy[i]);
        const yPeak = r.y + r.h - 1 - (peak / this.priceMax) * (r.h - 4);
        y = clamp(yPeak - chipH - 5, r.y + 2, r.y + r.h - chipH - 2);
      } else {
        y = L.solar.y + 3;
      }
      chip.el.style.transform = `translate(${Math.round(x - half)}px, ${Math.round(y)}px)`;
    }
    for (const [id, chip] of this.chips) {
      if (!seen.has(id)) {
        chip.el.remove();
        this.chips.delete(id);
      }
    }
  }

  private createChip(e: ScenarioEvent): Chip {
    const el = document.createElement('div');
    el.className = `chip chip-${e.kind === 'priceSpike' ? 'spike' : 'cloud'}`;
    el.dataset.eventId = e.id;
    el.dataset.eventKind = e.kind;
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', e.kind === 'priceSpike' ? 'Price spike event' : 'Cloud event');
    el.setAttribute('aria-valuemin', String(e.kind === 'priceSpike' ? SPIKE_MIN : CLOUD_MIN));
    el.setAttribute('aria-valuemax', String(e.kind === 'priceSpike' ? SPIKE_MAX : CLOUD_MAX));
    el.innerHTML =
      `<span class="chip-icon">${e.kind === 'priceSpike' ? ICON_BOLT : ICON_CLOUD}</span>` +
      `<span class="chip-label"></span><span class="chip-sub"></span>` +
      `<button class="chip-x" type="button" tabindex="-1" aria-label="Delete event" title="Delete event">` +
      `<svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
    const chip: Chip = {
      el,
      label: el.querySelector('.chip-label') as HTMLSpanElement,
      sub: el.querySelector('.chip-sub') as HTMLSpanElement,
      text: '',
      subText: '',
      width: 0,
      height: 0,
    };
    const id = e.id;
    const x = el.querySelector('.chip-x') as HTMLButtonElement;
    x.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.handlers.onEventDelete(id);
    });

    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || this.drag) return;
      const cur = this.currentEvent(id);
      if (!cur || !this.L) return;
      ev.preventDefault();
      el.focus({ preventScroll: true });
      el.setPointerCapture(ev.pointerId);
      const perPx =
        cur.kind === 'priceSpike'
          ? this.priceMax / Math.max(20, this.L.price.h - 4)
          : (CLOUD_MAX - CLOUD_MIN) / Math.max(60, this.L.solar.h * 1.6);
      this.drag = {
        id,
        pointerId: ev.pointerId,
        x0: ev.clientX,
        y0: ev.clientY,
        startStep0: cur.startStep,
        magnitude0: cur.magnitude,
        perPx,
        moved: false,
      };
      this.dirty = true;
    });
    el.addEventListener('pointermove', (ev) => {
      const d = this.drag;
      if (!d || d.id !== id || ev.pointerId !== d.pointerId) return;
      this.applyDrag(d, ev.clientX, ev.clientY, false);
    });
    const end = (ev: PointerEvent, cancelled: boolean) => {
      const d = this.drag;
      if (!d || d.id !== id || ev.pointerId !== d.pointerId) return;
      if (!cancelled) this.applyDrag(d, ev.clientX, ev.clientY, true);
      else if (d.moved) this.handlers.onEventChange(id, {}, true);
      if (d.moved) this.lastMovedDragAt = performance.now();
      this.drag = null;
      this.dirty = true;
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    el.addEventListener('pointerup', (ev) => end(ev, false));
    el.addEventListener('pointercancel', (ev) => end(ev, true));
    el.addEventListener('lostpointercapture', (ev) => end(ev, true));

    el.addEventListener('dblclick', (ev) => {
      // A drag that ends where it started must not count as a "double click to delete".
      if (performance.now() - this.lastMovedDragAt < 700) return;
      ev.preventDefault();
      this.handlers.onEventDelete(id);
    });

    el.addEventListener(
      'wheel',
      (ev) => {
        const cur = this.currentEvent(id);
        if (!cur || !this.view) return;
        ev.preventDefault();
        const n = this.view.scenario.n;
        const dur = clamp(cur.durationSteps + (ev.deltaY < 0 ? 1 : -1), 1, Math.min(DURATION_MAX, n));
        if (dur === cur.durationSteps) return;
        this.handlers.onEventChange(id, { durationSteps: dur, startStep: clamp(cur.startStep, 0, n - dur) }, true);
      },
      { passive: false },
    );

    el.addEventListener('keydown', (ev) => {
      const cur = this.currentEvent(id);
      if (!cur || !this.view) return;
      const n = this.view.scenario.n;
      const spike = cur.kind === 'priceSpike';
      const dm = spike ? 0.05 : 0.05;
      let patch: Partial<ScenarioEvent> | null = null;
      switch (ev.key) {
        case 'ArrowLeft':
          patch = { startStep: clamp(cur.startStep - 1, 0, n - cur.durationSteps) };
          break;
        case 'ArrowRight':
          patch = { startStep: clamp(cur.startStep + 1, 0, n - cur.durationSteps) };
          break;
        case 'ArrowUp':
          patch = { magnitude: this.clampMag(cur.kind, cur.magnitude + dm) };
          break;
        case 'ArrowDown':
          patch = { magnitude: this.clampMag(cur.kind, cur.magnitude - dm) };
          break;
        case 'Delete':
        case 'Backspace':
          ev.preventDefault();
          ev.stopPropagation();
          this.handlers.onEventDelete(id);
          return;
        default:
          return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.handlers.onEventChange(id, patch, true);
    });

    this.overlay.appendChild(el);
    return chip;
  }

  private currentEvent(id: string): ScenarioEvent | undefined {
    return this.view?.events.find((e) => e.id === id);
  }

  private clampMag(kind: ScenarioEvent['kind'], m: number): number {
    const v = kind === 'priceSpike' ? clamp(m, SPIKE_MIN, SPIKE_MAX) : clamp(m, CLOUD_MIN, CLOUD_MAX);
    return Math.round(v * 100) / 100;
  }

  private applyDrag(d: Drag, clientX: number, clientY: number, final: boolean): void {
    const cur = this.currentEvent(d.id);
    if (!cur || !this.view || !this.L) return;
    const dx = clientX - d.x0;
    const dy = clientY - d.y0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    if (!d.moved) return; // a plain click changes nothing
    const n = this.view.scenario.n;
    const stepPx = this.L.pw / n;
    const startStep = clamp(d.startStep0 + Math.round(dx / stepPx), 0, n - cur.durationSteps);
    const magnitude = this.clampMag(cur.kind, d.magnitude0 - dy * d.perPx);
    const changed = startStep !== cur.startStep || magnitude !== cur.magnitude;
    if (changed || final) this.handlers.onEventChange(d.id, changed ? { startStep, magnitude } : {}, final);
  }

  // ------------------------------------------------------------------ hover readout

  private syncTip(view: TimelineView): void {
    const tip = this.tip;
    if (this.hoverStep < 0 || this.drag || this.scrubbing) {
      if (!tip.hidden) tip.hidden = true;
      return;
    }
    const s = view.scenario;
    const k = clamp(Math.floor(this.hoverStep), 0, s.n - 1);
    const c = (v: number) => `${(v * 100).toFixed(1)}c`;
    const sg = (v: number) => `${v > 0.005 ? '+' : v < -0.005 ? '-' : ''}${Math.abs(v).toFixed(1)}`;
    const day = dayAt(s.config, k * DT_H);
    const t0 = hhmm(clockHourAt(s.config, k * DT_H));
    const t1 = hhmm(clockHourAt(s.config, (k + 1) * DT_H));
    let html =
      `<div class="tip-h">Day ${day} · ${t0}–${t1}</div>` +
      `<div><i style="background:${COLORS.buy}"></i>buy <b>${c(s.buy[k])}</b> <i style="background:${COLORS.sell}"></i>feed-in <b>${c(s.sell[k])}</b></div>` +
      `<div><i style="background:${COLORS.pv}"></i>solar <b>${s.pvKw[k].toFixed(1)} kW</b> of ${s.clearSkyKw[k].toFixed(1)} clear-sky · cloud <b>${Math.round(s.cloud[k] * 100)}%</b></div>`;
    const r = view.result;
    if (r && r.scenario.n === s.n) {
      const line = (name: string, color: string, p: PolicyResult) =>
        `<div><i style="background:${color}"></i><b style="color:${color}">${name}</b> grid <b>${sg(p.gridImportKw[k] - p.gridExportKw[k])}</b> · ` +
        `battery <b>${sg(p.battChargeKw[k] - p.battDischargeKw[k])}</b> (${Math.round((p.socKwh[k] / s.config.battKwh) * 100)}%) · ` +
        `EV <b>${p.evKw[k].toFixed(1)}</b> kW</div>`;
      html += line('MPC', COLORS.mpc, r.mpc) + line('DP', COLORS.dp, r.dp);
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = this.hoverX + 14 + tw > this.w - 4 ? this.hoverX - 14 - tw : this.hoverX + 14;
    const y = clamp(this.hoverY - th - 8, 2, Math.max(2, this.h - th - 2));
    tip.style.transform = `translate(${Math.round(Math.max(2, x))}px, ${Math.round(y)}px)`;
  }

  // ------------------------------------------------------------------ scrubbing

  private bindScrub(): void {
    const c = this.canvas;
    const timeAt = (ev: PointerEvent): number | null => {
      if (!this.L || !this.view) return null;
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const n = this.view.scenario.n;
      const total = n * DT_H;
      return clamp(((x - this.L.px) / this.L.pw) * total, 0, total - 1e-4);
    };
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !this.L) return;
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      if (x < this.L.px - 6 || x > this.L.px + this.L.pw + 6) return;
      ev.preventDefault();
      c.setPointerCapture(ev.pointerId);
      this.scrubbing = true;
      c.classList.add('scrubbing');
      const t = timeAt(ev);
      if (t !== null) this.handlers.onScrub(t);
    });
    c.addEventListener('pointermove', (ev) => {
      if (this.scrubbing) {
        const t = timeAt(ev);
        if (t !== null) this.handlers.onScrub(t);
        return;
      }
      if (!this.L || !this.view || ev.pointerType === 'touch') return;
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const inside = x >= this.L.px && x <= this.L.px + this.L.pw;
      const step = inside ? ((x - this.L.px) / this.L.pw) * this.view.scenario.n : -1;
      if (step !== this.hoverStep) {
        this.hoverStep = step;
        this.hoverX = x;
        this.hoverY = ev.clientY - rect.top;
        this.dirty = true;
      }
    });
    c.addEventListener('pointerleave', () => {
      if (this.hoverStep >= 0) {
        this.hoverStep = -1;
        this.dirty = true;
      }
    });
    const stop = (ev: PointerEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      c.classList.remove('scrubbing');
      if (c.hasPointerCapture(ev.pointerId)) c.releasePointerCapture(ev.pointerId);
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
  }
}

// -------------------------------------------------------------------- helpers

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Piecewise-constant path: value arr[i] holds over step [i, i+1). */
function stepPath(
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  from: number,
  to: number,
  X: (step: number) => number,
  Y: (v: number) => number,
): void {
  ctx.beginPath();
  for (let i = from; i < to; i++) {
    const y = Y(arr[i]);
    if (i === from) ctx.moveTo(X(i), y);
    else ctx.lineTo(X(i), y);
    ctx.lineTo(X(i + 1), y);
  }
}

/** Same, for a forecast array whose index 0 is step `from`. */
function stepPathOffset(
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  from: number,
  to: number,
  X: (step: number) => number,
  Y: (v: number) => number,
): void {
  ctx.beginPath();
  for (let i = from; i < to; i++) {
    const y = Y(arr[i - from]);
    if (i === from) ctx.moveTo(X(i), y);
    else ctx.lineTo(X(i), y);
    ctx.lineTo(X(i + 1), y);
  }
}

/** Smooth-ish path through step centres; arr[j] belongs to step offset + j. */
function centrePath(
  ctx: CanvasRenderingContext2D,
  arr: ArrayLike<number>,
  from: number,
  to: number,
  offset: number,
  X: (step: number) => number,
  Y: (v: number) => number,
): void {
  ctx.beginPath();
  if (to <= from) return;
  ctx.moveTo(X(offset + from), Y(arr[from]));
  for (let j = from; j < to; j++) ctx.lineTo(X(offset + j + 0.5), Y(arr[j]));
  ctx.lineTo(X(offset + to), Y(arr[to - 1]));
}

/** Run `past` clipped to the left of x and `future` clipped to the right. */
function splitAt(ctx: CanvasRenderingContext2D, r: Rect, x: number, past: () => void, future: () => void): void {
  const xc = clamp(x, r.x, r.x + r.w);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, xc - r.x, r.h);
  ctx.clip();
  past();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(xc, r.y, r.x + r.w - xc, r.h);
  ctx.clip();
  future();
  ctx.restore();
}
