/** Single source of truth for colours used by both CSS (as custom properties) and the canvas timeline. */
export const COLORS = {
  mpc: '#ff9a3d',
  dp: '#4cc3ff',
  buy: '#ff6b9a',
  sell: '#63e6a3',
  pv: '#ffd75e',
  cloud: '#b9c6da',
  ev: '#9be37a',
  text: '#e8eefc',
  textDim: '#93a0b8',
  textFaint: '#5d6a82',
} as const;

export const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function installCssVars(root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(COLORS)) root.style.setProperty(`--c-${k}`, v);
}

/** '#rrggbb' + alpha -> 'rgba(...)'. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
