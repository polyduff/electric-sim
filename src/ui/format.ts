/** Small formatting helpers shared by the HUD, controls and timeline. */
import type { SimConfig } from '../shared/types';

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** "$12.34" / "-$1.20" (ASCII minus so the text parses back to a number). */
export function money(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r < 0 ? '-' : ''}$${Math.abs(r).toFixed(2)}`;
}

/** "+$0.42" / "-$0.42" / "$0.00". */
export function signedMoney(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return '$0.00';
  return `${r < 0 ? '-' : '+'}$${Math.abs(r).toFixed(2)}`;
}

export function signedPct(frac: number, digits = 1): string {
  const p = frac * 100;
  const s = p.toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${p < 0 ? '-' : '+'}${Math.abs(p).toFixed(digits)}%`;
}

/** $/kWh -> "31.2c". */
export function cents(dollarsPerKwh: number, digits = 1): string {
  return `${(dollarsPerKwh * 100).toFixed(digits)}c`;
}

export function signedCents(dollarsPerKwh: number, digits = 1): string {
  const c = dollarsPerKwh * 100;
  const s = Math.abs(c).toFixed(digits);
  if (Number(s) === 0) return `${s}c`;
  return `${c < 0 ? '-' : '+'}${s}c`;
}

export function kw(v: number, digits = 1): string {
  return `${Math.abs(v).toFixed(digits)} kW`;
}

export function hhmm(clockHour: number): string {
  const total = Math.round((((clockHour % 24) + 24) % 24) * 60) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Local clock hour (0..24) at `timeH` hours since scenario start. */
export function clockHourAt(config: SimConfig, timeH: number): number {
  return (((config.startHour + timeH) % 24) + 24) % 24;
}

/** Calendar day (1-based): Day 1 runs from the scenario start to the first midnight, Day 2 is the next calendar day, ... */
export function dayAt(config: SimConfig, timeH: number): number {
  return Math.floor((config.startHour + Math.max(0, timeH) + 1e-9) / 24) + 1;
}

/** "Day 1 · 14:30" (minutes floored so the clock never shows a time not yet reached). */
export function clockLabel(config: SimConfig, timeH: number): string {
  const mins = Math.floor(Math.max(0, timeH) * 60 + 1e-6);
  const t = mins / 60;
  const ch = clockHourAt(config, t);
  const h = Math.floor(ch + 1e-9);
  const m = Math.round((ch - h) * 60) % 60;
  return `Day ${dayAt(config, t)} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Tick spacing giving roughly `target` ticks over [0, max]. */
export function niceStep(max: number, target: number): number {
  if (!(max > 0)) return 1;
  const raw = max / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * pow;
}
