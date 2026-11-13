/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from '../shared/types';
import highsWasmUrl from 'highs/runtime?url';
import { computeInsight, initSolver, solveAll } from './solve';

/**
 * Module Web Worker implementing the protocol in docs/spec.md.
 * The HiGHS .wasm is referenced through Vite's asset pipeline (`?url`), which
 * works in the dev server and in a production build.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

let ready: Promise<string> | null = null;
let initMs = 0;

function ensureInit(): Promise<string> {
  if (!ready) {
    const t0 = performance.now();
    const p = initSolver({ wasmUrl: highsWasmUrl }).then((label) => {
      initMs = performance.now() - t0;
      return label;
    });
    p.catch(() => {
      ready = null;
    });
    ready = p;
  }
  return ready;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handle(req: WorkerRequest): Promise<void> {
  if (req.type === 'init') {
    try {
      const solver = await ensureInit();
      post({ type: 'ready', solver, initMs });
    } catch (err) {
      post({ type: 'error', reqId: null, message: errorMessage(err) });
    }
    return;
  }
  if (req.type === 'solve') {
    try {
      await ensureInit();
      const result = solveAll(req.reqId, req.config, req.events);
      post({ type: 'solved', result });
      if (req.wantInsight) {
        const insight = computeInsight(req.reqId, result.scenario, result.dp);
        post({ type: 'insight', insight });
      }
    } catch (err) {
      post({ type: 'error', reqId: req.reqId, message: errorMessage(err) });
    }
  }
}

// Requests are handled strictly in arrival order (init is async).
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(ev.data));
};
