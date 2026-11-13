/**
 * Client for the solver worker (protocol in src/shared/types.ts, docs/spec.md).
 *
 * Coalescing: at most ONE request is in flight; while it is, only the LATEST
 * requested state is remembered and sent as soon as the worker answers. A
 * request with wantInsight stays "in flight" until its insight has arrived.
 */
import type { ArbitrageInsight, ScenarioEvent, SimConfig, SolveResult } from '../shared/types';
import type { WorkerLike } from './backend';

export interface SolveClientHandlers {
  onReady(solver: string, initMs: number): void;
  /** Apply the result to the app (state + DOM). Latency is measured after this returns. */
  onSolved(result: SolveResult): void;
  /** Called right after onSolved with the measured round trip (postMessage -> applied). */
  onLatency(latencyMs: number, result: SolveResult): void;
  onInsight(insight: ArbitrageInsight): void;
  onError(message: string): void;
  /** Busy/idle transitions (in flight or queued). */
  onBusyChange(busy: boolean): void;
}

interface Pending {
  config: SimConfig;
  events: ScenarioEvent[];
  wantInsight: boolean;
}

interface InFlight {
  reqId: number;
  sentAt: number;
  wantInsight: boolean;
  solved: boolean;
  insightTimer: number;
}

/** Give up waiting for an 'insight' message this long after its 'solved' (worker bug guard). */
const INSIGHT_TIMEOUT_MS = 8000;

export class SolveClient {
  private worker: WorkerLike;
  private ready = false;
  private nextReqId = 1;
  private inFlight: InFlight | null = null;
  private pending: Pending | null = null;
  private lastAppliedReqId = 0;
  private lastBusy = false;
  /** reqId of the most recently SENT request (0 = none). */
  lastSentReqId = 0;
  /** reqId of the most recently sent request that asked for an insight. */
  lastInsightReqId = 0;

  constructor(
    worker: WorkerLike,
    private handlers: SolveClientHandlers,
  ) {
    this.worker = worker;
    worker.onmessage = (msg) => {
      switch (msg.type) {
        case 'ready':
          this.ready = true;
          this.handlers.onReady(msg.solver, msg.initMs);
          this.pump();
          break;
        case 'solved':
          this.handleSolved(msg.result);
          break;
        case 'insight':
          this.handleInsight(msg.insight);
          break;
        case 'error':
          this.handleError(msg.reqId, msg.message);
          break;
      }
    };
    worker.onerror = (message) => this.handleError(null, message);
    worker.postMessage({ type: 'init' });
  }

  get busy(): boolean {
    return this.inFlight !== null || this.pending !== null;
  }

  /** True when a newer state than the last applied result has been requested. */
  get hasNewerRequest(): boolean {
    return this.pending !== null || (this.inFlight !== null && !this.inFlight.solved);
  }

  /** Request a solve of this state. Supersedes any queued (not yet sent) request. */
  request(config: SimConfig, events: ScenarioEvent[], wantInsight: boolean): void {
    this.pending = {
      config: { ...config },
      events: events.map((e) => ({ ...e })),
      wantInsight,
    };
    this.pump();
    this.notifyBusy();
  }

  dispose(): void {
    if (this.inFlight) window.clearTimeout(this.inFlight.insightTimer);
    this.worker.terminate();
  }

  private pump(): void {
    if (!this.ready || this.inFlight || !this.pending) return;
    const p = this.pending;
    this.pending = null;
    const reqId = this.nextReqId++;
    this.inFlight = { reqId, sentAt: performance.now(), wantInsight: p.wantInsight, solved: false, insightTimer: 0 };
    this.lastSentReqId = reqId;
    if (p.wantInsight) this.lastInsightReqId = reqId;
    this.worker.postMessage({ type: 'solve', reqId, config: p.config, events: p.events, wantInsight: p.wantInsight });
  }

  private handleSolved(result: SolveResult): void {
    const fl = this.inFlight;
    const mine = fl !== null && fl.reqId === result.reqId;
    if (result.reqId > this.lastAppliedReqId) {
      this.lastAppliedReqId = result.reqId;
      this.handlers.onSolved(result);
      if (mine) this.handlers.onLatency(performance.now() - fl.sentAt, result);
    } // else: stale result (older than what is on screen) -> ignore
    if (mine) {
      if (fl.wantInsight) {
        fl.solved = true;
        fl.insightTimer = window.setTimeout(() => {
          if (this.inFlight === fl) {
            this.inFlight = null;
            this.handlers.onError('insight timed out');
            this.pump();
            this.notifyBusy();
          }
        }, INSIGHT_TIMEOUT_MS);
      } else {
        this.inFlight = null;
        this.pump();
      }
    }
    this.notifyBusy();
  }

  private handleInsight(insight: ArbitrageInsight): void {
    this.handlers.onInsight(insight);
    const fl = this.inFlight;
    if (fl && fl.reqId === insight.reqId) {
      window.clearTimeout(fl.insightTimer);
      this.inFlight = null;
      this.pump();
    }
    this.notifyBusy();
  }

  private handleError(reqId: number | null, message: string): void {
    const fl = this.inFlight;
    if (fl && (reqId === null || reqId === fl.reqId)) {
      window.clearTimeout(fl.insightTimer);
      this.inFlight = null;
    }
    this.handlers.onError(message);
    // A load failure before 'ready' leaves requests queued; nothing more to pump then.
    this.pump();
    this.notifyBusy();
  }

  private notifyBusy(): void {
    const b = this.busy;
    if (b !== this.lastBusy) {
      this.lastBusy = b;
      this.handlers.onBusyChange(b);
    }
  }
}
