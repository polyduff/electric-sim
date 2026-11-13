/**
 * Dev-only smoke page: spawns the real sim worker, runs init + solves and
 * writes timings / checks to the DOM and to window.__smoke. Not part of the app.
 */
import type { ArbitrageInsight, ScenarioEvent, SolveResult, WorkerRequest, WorkerResponse } from '../../shared/types';
import { DEFAULT_CONFIG, defaultEvents } from '../index';

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
const out = document.getElementById('out')!;
const status = document.getElementById('status')!;
const log = (s: string): void => {
  out.textContent += s + '\n';
};

function request(msg: WorkerRequest, want: Array<WorkerResponse['type']>): Promise<WorkerResponse[]> {
  return new Promise((resolve, reject) => {
    const got: WorkerResponse[] = [];
    const onMsg = (e: MessageEvent<WorkerResponse>): void => {
      got.push(e.data);
      if (e.data.type === 'error') {
        worker.removeEventListener('message', onMsg);
        reject(new Error(e.data.message));
      } else if (want.every((t) => got.some((g) => g.type === t))) {
        worker.removeEventListener('message', onMsg);
        resolve(got);
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage(msg);
  });
}

async function solve(reqId: number, events: ScenarioEvent[], insight: boolean, fe = DEFAULT_CONFIG.forecastError) {
  const t0 = performance.now();
  const msgs = await request(
    { type: 'solve', reqId, config: { ...DEFAULT_CONFIG, forecastError: fe }, events, wantInsight: insight },
    insight ? ['solved', 'insight'] : ['solved'],
  );
  const roundTripMs = performance.now() - t0;
  const solved = msgs.find((m) => m.type === 'solved') as { result: SolveResult };
  const ins = msgs.find((m) => m.type === 'insight') as { insight: ArbitrageInsight } | undefined;
  const order = msgs.map((m) => m.type).join('>');
  const r = solved.result;
  return {
    reqId,
    order,
    roundTripMs: +roundTripMs.toFixed(1),
    timing: Object.fromEntries(Object.entries(r.timing).map(([k, v]) => [k, +(+v).toFixed(2)])),
    mpcCost: +r.mpc.totalCost.toFixed(4),
    dpCost: +r.dp.totalCost.toFixed(4),
    headline: ins?.insight.headline ?? null,
    solver: r.solver,
    typed: r.mpc.socKwh instanceof Float64Array && r.scenario.evPlugged instanceof Uint8Array,
  };
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {};
  const t0 = performance.now();
  const ready = (await request({ type: 'init' }, ['ready']))[0] as { solver: string; initMs: number };
  results.init = { solver: ready.solver, workerInitMs: +ready.initMs.toFixed(1), roundTripMs: +(performance.now() - t0).toFixed(1) };
  log('init ' + JSON.stringify(results.init));

  const events = defaultEvents(DEFAULT_CONFIG);
  const runs: unknown[] = [];
  runs.push({ label: 'first solve (+insight)', ...(await solve(1, events, true)) });
  for (let i = 0; i < 4; i++) runs.push({ label: 'repeat unchanged', ...(await solve(2 + i, events, false)) });
  // Different config each time: from-scratch MPC (forecastError changes the forecasts).
  for (let i = 0; i < 4; i++) runs.push({ label: 'from scratch (fe change)', ...(await solve(10 + i, events, false, 0.4 + 0.01 * i)) });
  // Drag a late event (cloud-2 in the second day) and an early one.
  const late = (d: number) => events.map((e) => (e.id === 'cloud-2' ? { ...e, startStep: e.startStep + d } : e));
  await solve(20, events, false);
  for (let d = 1; d <= 4; d++) runs.push({ label: `late event moved +${d}`, ...(await solve(20 + d, late(d * 3), false)) });
  const early = events.map((e) => (e.id === 'spike-1' ? { ...e, startStep: e.startStep - 3 } : e));
  runs.push({ label: 'early event moved', ...(await solve(30, early, false)) });
  const spike = [...events, { id: 'big', kind: 'priceSpike', startStep: 36, durationSteps: 6, magnitude: 1.0 } as ScenarioEvent];
  runs.push({ label: 'huge spike (+insight)', ...(await solve(31, spike, true)) });
  runs.push({ label: 'back to default (+insight)', ...(await solve(32, events, true)) });
  results.runs = runs;
  for (const r of runs as Array<Record<string, unknown>>) log(JSON.stringify(r));

  // 'solve' on a fresh worker without init must init lazily.
  const w2 = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  const lazy = await new Promise<string>((resolve) => {
    w2.onmessage = (e: MessageEvent<WorkerResponse>) => resolve(e.data.type);
    w2.postMessage({ type: 'solve', reqId: 99, config: DEFAULT_CONFIG, events, wantInsight: false } satisfies WorkerRequest);
  });
  w2.terminate();
  results.lazyInit = lazy;
  log('lazy init: first message ' + lazy);
  results.done = true;
  (window as unknown as { __smoke: unknown }).__smoke = results;
  status.textContent = 'done';
}

main().catch((err) => {
  status.textContent = 'error: ' + (err instanceof Error ? err.message : String(err));
  (window as unknown as { __smoke: unknown }).__smoke = { error: String(err) };
  log('ERROR ' + String(err));
});
