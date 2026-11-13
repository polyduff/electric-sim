/**
 * DEV-ONLY placeholder for src/scene (used only with ?mock=1): a flat 2D canvas
 * sketch of the two houses so the HUD can be laid out without the 3D module.
 */
import type { CreateScene, HouseFrame, SceneFrame } from '../../shared/types';

export const createMockScene: CreateScene = (container) => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  let frame: SceneFrame | null = null;
  let raf = 0;
  let w = 0;
  let h = 0;
  let phase = 0;
  let last = performance.now();

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = container.clientWidth;
    h = container.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const link = (x0: number, y0: number, x1: number, y1: number, kw: number, color: string) => {
    const a = Math.abs(kw);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (a < 0.02) return;
    const dir = kw >= 0 ? 1 : -1;
    const nDots = 5;
    ctx.fillStyle = color;
    for (let i = 0; i < nDots; i++) {
      let u = (i / nDots + phase * dir * (0.4 + a / 6)) % 1;
      if (u < 0) u += 1;
      ctx.beginPath();
      ctx.arc(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, 1.5 + Math.min(4, a * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const house = (f: HouseFrame, cx: number, gy: number, s: number, color: string) => {
    ctx.fillStyle = '#1f2a3d';
    ctx.fillRect(cx - 60 * s, gy - 70 * s, 120 * s, 70 * s);
    ctx.beginPath();
    ctx.moveTo(cx - 72 * s, gy - 70 * s);
    ctx.lineTo(cx, gy - 120 * s);
    ctx.lineTo(cx + 72 * s, gy - 70 * s);
    ctx.closePath();
    ctx.fillStyle = '#2b3a55';
    ctx.fill();
    const bx = cx;
    const by = gy - 35 * s;
    link(cx - 20 * s, gy - 100 * s, bx, by, f.pvKw, '#ffd75e');
    link(bx, by, cx + 40 * s, gy - 20 * s, f.loadKw, '#e8eefc');
    link(bx, by, cx + 120 * s, gy - 10 * s, f.evKw, '#7ee08a');
    link(bx, by, cx - 95 * s, gy - 20 * s, f.battKw, color);
    link(cx - 170 * s, gy - 90 * s, bx, by, f.gridKw, '#ff7a90');
    ctx.fillStyle = '#0d1422';
    ctx.fillRect(cx - 108 * s, gy - 46 * s, 26 * s, 46 * s);
    ctx.fillStyle = color;
    ctx.fillRect(cx - 105 * s, gy - 3 * s - 40 * s * f.socFrac, 20 * s, 40 * s * f.socFrac);
    if (f.evPresent) {
      ctx.fillStyle = '#39507a';
      ctx.fillRect(cx + 95 * s, gy - 22 * s, 60 * s, 22 * s);
      ctx.fillStyle = '#7ee08a';
      ctx.fillRect(cx + 97 * s, gy - 5 * s, 56 * s * f.evFrac, 3 * s);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `600 ${Math.round(12 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(f.label, cx, gy - 132 * s);
  };

  const draw = (now: number) => {
    raf = requestAnimationFrame(draw);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!frame) return;
    phase += dt * (frame.simSpeed > 0 ? 1 : 0.15);
    const el = frame.sunElevationDeg;
    const day = Math.max(0, Math.min(1, (el + 6) / 18));
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const mix = (a: number, b: number) => Math.round(a + (b - a) * day);
    const dim = 1 - 0.45 * frame.cloud * day;
    g.addColorStop(0, `rgb(${mix(6, 70) * dim},${mix(10, 130) * dim},${mix(24, 200) * dim})`);
    g.addColorStop(1, `rgb(${mix(14, 150) * dim},${mix(20, 190) * dim},${mix(40, 220) * dim})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const gy = h * 0.8;
    if (el > -2) {
      const az = (frame.sunAzimuthDeg * Math.PI) / 180;
      const sx = w / 2 - Math.sin(az) * w * 0.4;
      const sy = gy - (el / 70) * h * 0.7;
      ctx.fillStyle = `rgba(255,236,170,${0.9 - 0.5 * frame.cloud})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = day > 0.5 ? '#2c4a3a' : '#0c141c';
    ctx.fillRect(0, gy, w, h - gy);
    const s = Math.max(0.7, Math.min(1.6, h / 420));
    house(frame.houses[0], w * 0.3, gy, s, '#ff9a3d');
    house(frame.houses[1], w * 0.7, gy, s, '#4cc3ff');
  };

  resize();
  raf = requestAnimationFrame(draw);
  return {
    setFrame(f) {
      frame = f;
    },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
};
