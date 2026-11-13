import * as THREE from 'three';

/** Canvas-texture billboards: house labels, kW tags and gauges. Redrawn only when their text changes. */

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

export class Billboard {
  readonly sprite: THREE.Sprite;
  readonly material: THREE.SpriteMaterial;
  protected canvas: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D;
  protected tex: THREE.CanvasTexture;
  protected key = '';
  /** Current opacity target, smoothed by the owner. */
  opacity = 0;

  constructor(w: number, h: number, readonly worldH: number, tint = 1) {
    [this.canvas, this.ctx] = makeCanvas(w, h);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.material = new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    this.material.color.setScalar(tint);
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = 20;
    this.sprite.scale.set(worldH * (w / h), worldH, 1);
    this.sprite.visible = false;
  }

  setOpacity(o: number): void {
    this.opacity = o;
    this.material.opacity = o;
    this.sprite.visible = o > 0.01;
  }

  dispose(): void {
    this.tex.dispose();
    this.material.dispose();
  }
}

/** House name plate: dark pill with a policy-coloured marker. */
export class LabelSprite extends Billboard {
  constructor(private accent: string) {
    super(1024, 144, 1.35, 1.0);
  }

  set(text: string): void {
    if (text === this.key) return;
    this.key = text;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    g.font = `700 64px ${FONT}`;
    const tw = Math.min(W - 150, g.measureText(text).width);
    const pw = tw + 110, x0 = (W - pw) / 2;
    roundRect(g, x0, 14, pw, H - 28, (H - 28) / 2);
    g.fillStyle = 'rgba(10,16,28,0.74)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.stroke();
    g.beginPath();
    g.arc(x0 + 46, H / 2, 15, 0, Math.PI * 2);
    g.fillStyle = this.accent;
    g.shadowColor = this.accent;
    g.shadowBlur = 14;
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = '#f4f7fb';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(text, x0 + 78, H / 2 + 3, W - 150);
    this.tex.needsUpdate = true;
  }
}

/** Small kW read-out next to an active link. */
export class TagSprite extends Billboard {
  constructor(private cssColor: string) {
    super(256, 112, 0.74, 1.0);
  }

  set(line1: string, line2: string, cssColor?: string): void {
    const col = cssColor ?? this.cssColor;
    const k = line1 + '|' + line2 + '|' + col;
    if (k === this.key) return;
    this.key = k;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const two = line2.length > 0;
    roundRect(g, 10, 10, W - 20, H - 20, 26);
    g.fillStyle = 'rgba(8,12,22,0.78)';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = col;
    g.stroke();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${two ? 50 : 58}px ${FONT}`;
    g.fillText(line1, W / 2, two ? H * 0.40 : H / 2 + 2);
    if (two) {
      g.font = `600 28px ${FONT}`;
      g.fillStyle = col;
      g.fillText(line2, W / 2, H * 0.76);
    }
    this.tex.needsUpdate = true;
  }
}

/** Compact gauge: title, fill bar, percentage. */
export class GaugeSprite extends Billboard {
  constructor() {
    super(256, 96, 0.62, 1.0);
  }

  set(title: string, frac: number, cssColor: string, note = ''): void {
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    const k = `${title}|${pct}|${cssColor}|${note}`;
    if (k === this.key) return;
    this.key = k;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    roundRect(g, 6, 6, W - 12, H - 12, 22);
    g.fillStyle = 'rgba(8,12,22,0.8)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.24)';
    g.stroke();
    g.font = `700 26px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#c8d3e2';
    g.fillText(title, 24, 29);
    g.textAlign = 'right';
    g.fillStyle = '#ffffff';
    g.font = `800 30px ${FONT}`;
    g.fillText(note || `${pct}%`, W - 24, 29);
    // bar
    const bx = 24, by = 56, bw = W - 48, bh = 22;
    roundRect(g, bx, by, bw, bh, 11);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fill();
    if (pct > 0) {
      roundRect(g, bx, by, Math.max(bh, (bw * pct) / 100), bh, 11);
      g.fillStyle = cssColor;
      g.fill();
    }
    this.tex.needsUpdate = true;
  }
}
