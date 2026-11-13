/**
 * Application controller: owns the state (config, events, time, results), the
 * playback loop, the controls, and wires worker client, HUD, timeline and scene.
 */
import {
  DT_H,
  type AppDebug,
  type AppDebugState,
  type ArbitrageInsight,
  type Scenario,
  type ScenarioEvent,
  type SceneApi,
  type SimConfig,
  type SolveResult,
} from '../shared/types';
import type { Backend } from './backend';
import { clamp, clockLabel } from './format';
import { buildSceneFrame, runningCost, stepPos } from './frame';
import { Hud } from './hud';
import { COLORS } from './theme';
import { CLOUD_MAX, CLOUD_MIN, SPIKE_MAX, SPIKE_MIN, Timeline } from './timeline';
import { SolveClient } from './workerClient';

export interface AppOptions {
  startPaused: boolean;
  initialTimeH: number | null;
}

/** After the last live (no-insight) request, ask for the insight once things go quiet. */
const SETTLE_MS = 350;

export class App {
  private sim: Backend['sim'];
  private config: SimConfig;
  private events: ScenarioEvent[];
  /** Scenario for the current config/events, rebuilt on the main thread (never lags the controls). */
  private preview: Scenario;
  private result: SolveResult | null = null;
  private insight: ArbitrageInsight | null = null;
  private insightStale = false;

  private timeH = 0;
  private playing = true;
  private speed = 1;
  private latencyMs = 0;
  private solveCount = 0;
  private lastFrameAt = 0;
  private settleTimer = 0;
  private settlePending = false;
  private eventSeq = 0;
  private scrubActive = false;
  /** Round trips of the solves (lpSolves > 0) made during the current/last drag or slider gesture. */
  private gestureSamples: number[] = [];
  private gestureOpen = false;
  private hasLatency = false;

  private scene: SceneApi | null = null;
  private hud = new Hud();
  private timeline: Timeline;
  private client: SolveClient;

  private el = {
    play: q<HTMLButtonElement>('#play'),
    reset: q<HTMLButtonElement>('#reset'),
    speed: q<HTMLSelectElement>('#speed'),
    scrub: q<HTMLInputElement>('#scrub'),
    scrubTime: q<HTMLElement>('#scrub-time'),
    scrubEnd: q<HTMLElement>('#scrub-end'),
    fe: q<HTMLInputElement>('#forecast-error'),
    feValue: q<HTMLElement>('#forecast-error-value'),
    reroll: q<HTMLButtonElement>('#reroll'),
    addSpike: q<HTMLButtonElement>('#add-spike'),
    addCloud: q<HTMLButtonElement>('#add-cloud'),
    sceneHost: q<HTMLElement>('#scene'),
    timeline: q<HTMLElement>('#timeline'),
    legend: q<HTMLElement>('#legend'),
  };
  private lastScrubText = '';

  constructor(
    private backend: Backend,
    opts: AppOptions,
  ) {
    this.sim = backend.sim;
    this.config = { ...this.sim.DEFAULT_CONFIG };
    this.events = this.sim.defaultEvents(this.config).map((e) => ({ ...e }));
    this.preview = this.sim.buildScenario(this.config, this.events);
    this.playing = !opts.startPaused;
    if (opts.initialTimeH !== null) this.timeH = clamp(opts.initialTimeH, 0, this.totalH() - 1e-4);

    // 3D scene first, so it is visible while the solver loads.
    try {
      this.scene = backend.createScene(this.el.sceneHost);
      new ResizeObserver(() => this.scene?.resize()).observe(this.el.sceneHost);
    } catch (e) {
      console.error(e);
      this.hud.showError(`3D scene failed to start: ${errText(e)}`, true);
    }

    this.buildLegend();
    this.timeline = new Timeline(this.el.timeline, this.sim, {
      onScrub: (t) => this.setTimeH(t),
      onEventChange: (id, patch, final) => this.changeEvent(id, patch, final),
      onEventDelete: (id) => this.setEvents(this.events.filter((e) => e.id !== id), true),
    });

    this.client = new SolveClient(backend.createWorker(), {
      onReady: (solver) => {
        this.hud.setLatencyText(`${solver} ready · solving…`);
        if (!this.result) this.hud.setLoading('Solving both policies…');
      },
      onSolved: (result) => this.applyResult(result),
      onLatency: (ms, result) => {
        // A request served from the worker's cache (no LP solved) says nothing about solve speed.
        const real = result.timing.lpSolves > 0;
        if (!real && this.hasLatency) return;
        if (real && this.gestureOpen) this.gestureSamples.push(ms);
        this.hasLatency = true;
        this.latencyMs = ms;
        const s = [...this.gestureSamples].sort((x, y) => x - y);
        const median = s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
        this.hud.setLatency(ms, result, s.length >= 2 ? { medianMs: median, n: s.length } : null);
      },
      onInsight: (insight) => this.applyInsight(insight),
      onError: (message) => {
        console.error('[solver]', message);
        this.hud.showError(`Solver problem: ${message}`, !this.result);
        if (!this.result) this.hud.setLoading(null);
      },
      onBusyChange: (busy) => this.hud.setBusy(busy),
    });

    this.bindControls();
    this.syncControls();
    this.hud.setConfigSummary(this.preview);
    this.requestSolve(true);
    this.installDebug();
    this.renderNow(performance.now());
    requestAnimationFrame((t) => this.tick(t));
  }

  // ------------------------------------------------------------------ state changes

  private totalH(): number {
    return this.preview.n * DT_H;
  }

  private requestSolve(final: boolean): void {
    window.clearTimeout(this.settleTimer);
    this.settlePending = false;
    this.insightStale = true;
    if (!final && !this.gestureOpen) {
      this.gestureOpen = true;
      this.gestureSamples = [];
    } else if (final) {
      if (!this.gestureOpen) this.gestureSamples = [];
      this.gestureOpen = false;
    }
    this.hud.setInsight(this.insight, true);
    this.client.request(this.config, this.events, final);
    if (!final) {
      // Safety net: whatever happens to the "release" event, the insight catches up.
      this.settlePending = true;
      this.settleTimer = window.setTimeout(() => {
        this.settlePending = false;
        this.client.request(this.config, this.events, true);
      }, SETTLE_MS);
    }
  }

  private setEvents(events: ScenarioEvent[], final: boolean): void {
    this.events = events;
    this.preview = this.sim.buildScenario(this.config, this.events);
    this.requestSolve(final);
  }

  private changeEvent(id: string, patch: Partial<ScenarioEvent>, final: boolean): void {
    const changed = Object.keys(patch).length > 0;
    if (!changed) {
      if (final) this.requestSolve(true);
      return;
    }
    this.setEvents(
      this.events.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      final,
    );
  }

  private addEvent(kind: ScenarioEvent['kind']): void {
    const n = this.preview.n;
    const { k } = stepPos(n, this.timeH);
    const ids = new Set(this.events.map((e) => e.id));
    let id: string;
    do {
      id = `user-${kind === 'priceSpike' ? 'spike' : 'cloud'}-${++this.eventSeq}`;
    } while (ids.has(id));
    const durationSteps = kind === 'priceSpike' ? 3 : 6;
    // Just ahead of the playhead, so the MPC has to react to it.
    const startStep = clamp(k + 4, 0, n - durationSteps);
    const magnitude = kind === 'priceSpike' ? clamp(0.5, SPIKE_MIN, SPIKE_MAX) : clamp(0.7, CLOUD_MIN, CLOUD_MAX);
    this.setEvents([...this.events, { id, kind, startStep, durationSteps, magnitude }], true);
  }

  private setForecastError(v: number, final: boolean): void {
    const fe = clamp(Math.round(v * 20) / 20, 0, 1);
    if (fe !== this.config.forecastError) {
      this.config = { ...this.config, forecastError: fe };
      this.preview = this.sim.buildScenario(this.config, this.events);
      this.requestSolve(final);
    } else if (final && this.insightStale) {
      this.requestSolve(true);
    }
    this.syncControls();
  }

  private reset(): void {
    this.config = { ...this.sim.DEFAULT_CONFIG };
    this.events = this.sim.defaultEvents(this.config).map((e) => ({ ...e }));
    this.preview = this.sim.buildScenario(this.config, this.events);
    this.timeH = 0;
    this.syncControls();
    this.hud.setConfigSummary(this.preview);
    this.requestSolve(true);
  }

  private reroll(): void {
    let seed = this.config.seed;
    while (seed === this.config.seed) seed = 1 + Math.floor(Math.random() * 2147483646);
    this.config = { ...this.config, seed };
    this.events = this.sim.defaultEvents(this.config).map((e) => ({ ...e }));
    this.preview = this.sim.buildScenario(this.config, this.events);
    this.requestSolve(true);
  }

  private applyResult(result: SolveResult): void {
    const first = !this.result;
    this.result = result;
    this.solveCount++;
    if (first) this.hud.setLoading(null);
    this.hud.showError(null);
    this.renderNow(performance.now());
  }

  private applyInsight(insight: ArbitrageInsight): void {
    // Only an insight for the newest insight request un-dims the line.
    if (this.insight && insight.reqId < this.insight.reqId) return;
    this.insight = insight;
    this.insightStale =
      insight.reqId !== this.client.lastInsightReqId || this.client.hasNewerRequest || this.settlePending;
    this.hud.setInsight(insight, this.insightStale);
  }

  // ------------------------------------------------------------------ playback

  setTimeH(h: number): void {
    if (!Number.isFinite(h)) return;
    this.timeH = clamp(h, 0, this.totalH() - 1e-4);
    this.renderNow(performance.now());
  }

  play(): void {
    this.playing = true;
    this.syncControls();
  }

  pause(): void {
    this.playing = false;
    this.syncControls();
  }

  private tick(now: number): void {
    requestAnimationFrame((t) => this.tick(t));
    const dt = clamp((now - this.lastFrameAt) / 1000, 0, 0.5);
    this.lastFrameAt = now;
    // Time only advances once there is something to show.
    if (this.playing && this.result && !this.scrubActive) {
      const total = this.totalH();
      let t = this.timeH + dt * this.speed;
      if (t >= total) t -= total * Math.floor(t / total); // wrap and keep playing
      this.timeH = t;
    }
    this.renderNow(now);
  }

  /** Push the current state to the scene, the HUD and the timeline. */
  private renderNow(now: number): void {
    const result = this.result;
    const speed = this.playing && result ? this.speed : 0;
    const frame = buildSceneFrame(this.sim, result, this.preview, this.timeH, speed);
    try {
      this.scene?.setFrame(frame);
    } catch (e) {
      console.error(e);
    }
    const s = result ? result.scenario : this.preview;
    this.hud.setClock(s, this.timeH);
    if (result) this.hud.update(result, this.timeH);
    this.timeline.render({ scenario: this.preview, result, events: this.events, timeH: this.timeH }, now);

    const label = clockLabel(this.preview.config, this.timeH);
    if (label !== this.lastScrubText) {
      this.lastScrubText = label;
      this.el.scrubTime.textContent = label;
    }
    if (!this.scrubActive) {
      const v = this.timeH.toFixed(2);
      if (this.el.scrub.value !== v) this.el.scrub.value = v;
    }
  }

  // ------------------------------------------------------------------ controls

  private bindControls(): void {
    const e = this.el;
    const blurAfter = (b: HTMLElement) => b.addEventListener('pointerup', () => b.blur());

    e.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    e.reset.addEventListener('click', () => this.reset());
    e.reroll.addEventListener('click', () => this.reroll());
    e.addSpike.addEventListener('click', () => this.addEvent('priceSpike'));
    e.addCloud.addEventListener('click', () => this.addEvent('cloud'));
    [e.play, e.reset, e.reroll, e.addSpike, e.addCloud].forEach(blurAfter);

    e.speed.addEventListener('change', () => {
      const v = Number(e.speed.value);
      if (Number.isFinite(v) && v > 0) this.speed = v;
      e.speed.blur();
    });

    e.scrub.addEventListener('pointerdown', () => (this.scrubActive = true));
    const scrubDone = () => (this.scrubActive = false);
    e.scrub.addEventListener('pointerup', scrubDone);
    e.scrub.addEventListener('pointercancel', scrubDone);
    e.scrub.addEventListener('blur', scrubDone);
    e.scrub.addEventListener('input', () => this.setTimeH(Number(e.scrub.value)));
    e.scrub.addEventListener('change', scrubDone);

    e.fe.addEventListener('input', () => this.setForecastError(Number(e.fe.value), false));
    e.fe.addEventListener('change', () => this.setForecastError(Number(e.fe.value), true));

    // Space toggles play/pause everywhere except while typing.
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || (t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLTextAreaElement);
    document.addEventListener('keydown', (ev) => {
      if (ev.code !== 'Space' || ev.ctrlKey || ev.metaKey || ev.altKey || isTyping(ev.target)) return;
      ev.preventDefault();
      if (!ev.repeat) (this.playing ? this.pause() : this.play());
    });
    document.addEventListener('keyup', (ev) => {
      // Stops a focused button from also "clicking" on Space release.
      if (ev.code === 'Space' && !isTyping(ev.target)) ev.preventDefault();
    });
  }

  /** Reflect state into the controls (after reset, programmatic changes, etc.). */
  private syncControls(): void {
    const e = this.el;
    e.play.setAttribute('aria-pressed', String(this.playing));
    e.play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    e.play.dataset.state = this.playing ? 'playing' : 'paused';
    const total = this.totalH();
    e.scrub.max = String(total);
    e.scrubEnd.textContent = `${Math.round(total)} h`;
    const fe = this.config.forecastError;
    if (Number(e.fe.value) !== fe) e.fe.value = String(fe);
    e.feValue.textContent = `${Math.round(fe * 100)}%`;
    if (Number(e.speed.value) !== this.speed) e.speed.value = String(this.speed);
  }

  private buildLegend(): void {
    const item = (cls: string, color: string, text: string) =>
      `<span class="lg"><i class="sw ${cls}" style="--sw:${color}"></i>${text}</span>`;
    this.el.legend.innerHTML =
      item('line', COLORS.buy, 'buy price') +
      item('line', COLORS.sell, 'feed-in') +
      item('dash', '#eef2ff', 'MPC forecast') +
      item('dot', '#aab4c8', 'TOU base') +
      item('fill', COLORS.pv, 'solar') +
      item('fill', COLORS.cloud, 'cloud') +
      item('line thick', COLORS.mpc, 'MPC') +
      item('line thick', COLORS.dp, 'DP');
  }

  // ------------------------------------------------------------------ debug hook

  private debugState(): AppDebugState {
    const r = this.result;
    let costMpc = 0;
    let costDp = 0;
    if (r) {
      const p = stepPos(r.scenario.n, this.timeH);
      costMpc = runningCost(r.mpc, p);
      costDp = runningCost(r.dp, p);
    }
    return {
      ready: r !== null,
      timeH: this.timeH,
      playing: this.playing,
      speed: this.speed,
      forecastError: this.config.forecastError,
      events: this.events.map((e) => ({ ...e })),
      costMpc,
      costDp,
      gap: costMpc - costDp,
      totalMpc: r ? r.mpc.totalCost : 0,
      totalDp: r ? r.dp.totalCost : 0,
      latencyMs: this.latencyMs,
      solveCount: this.solveCount,
      solving: this.client.busy || this.settlePending,
      insightText: this.insight ? this.insight.headline : '',
    };
  }

  private installDebug(): void {
    const debug: AppDebug = {
      getState: () => this.debugState(),
      getResult: () => this.result,
      getInsight: () => this.insight,
      setTimeH: (h) => this.setTimeH(h),
      play: () => this.play(),
      pause: () => this.pause(),
    };
    (window as unknown as { __energySim: AppDebug }).__energySim = debug;
  }
}

function q<T extends Element>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
