/**
 * The ONE indirection between the UI and the other modules (simulator, worker,
 * 3D scene). Everything else in src/ui talks to a `Backend`.
 *
 * Default: the real modules (src/sim/index.ts, src/sim/worker.ts, src/scene/index.ts).
 * `?mock=1`: dev-only fakes from src/ui/dev (lazy-loaded, never part of the default path).
 */
import type {
  CreateScene,
  Forecast,
  Scenario,
  ScenarioEvent,
  SimConfig,
  WorkerRequest,
  WorkerResponse,
} from '../shared/types';

/** Pure, main-thread-safe simulator API (spec: "Simulation API"). */
export interface SimApi {
  DEFAULT_CONFIG: SimConfig;
  defaultEvents(config: SimConfig): ScenarioEvent[];
  buildScenario(config: SimConfig, events: ScenarioEvent[]): Scenario;
  forecastAt(scenario: Scenario, k: number): Forecast;
  sunPosition(config: SimConfig, timeH: number): { elevationDeg: number; azimuthDeg: number };
}

/** The slice of the Worker interface the UI uses (lets a fake stand in for it). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  onmessage: ((msg: WorkerResponse) => void) | null;
  onerror: ((message: string) => void) | null;
  terminate(): void;
}

export interface Backend {
  mock: boolean;
  sim: SimApi;
  createScene: CreateScene;
  createWorker(): WorkerLike;
}

// Lazy loaders. import.meta.glob tolerates a module that does not exist (yet),
// which a plain static import would not.
const simMods = import.meta.glob('../sim/index.ts');
const sceneMods = import.meta.glob('../scene/index.ts');

function wrapWorker(w: Worker): WorkerLike {
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => w.terminate(),
  };
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => like.onmessage?.(ev.data);
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault?.();
    like.onerror?.(ev.message || 'worker failed to load');
  };
  w.onmessageerror = () => like.onerror?.('worker message could not be deserialised');
  return like;
}

/** Which parts to replace with dev mocks: `?mock=1` (all) or e.g. `?mock=scene`, `?mock=worker,scene`. */
export interface MockParts {
  sim: boolean;
  worker: boolean;
  scene: boolean;
}

export function parseMockParam(value: string | null): MockParts {
  if (value === null || value === '0' || value === 'false') return { sim: false, worker: false, scene: false };
  const parts = value.split(',').map((p) => p.trim());
  const all = parts.some((p) => p === '1' || p === 'true' || p === 'all' || p === '');
  // The mock worker's results only match the main-thread preview if both use the same scenario builder,
  // which mockWorker gets from whichever sim is active.
  return {
    sim: all || parts.includes('sim'),
    worker: all || parts.includes('worker') || parts.includes('sim'),
    scene: all || parts.includes('scene'),
  };
}

export async function loadBackend(mock: MockParts): Promise<Backend> {
  let sim: SimApi;
  if (mock.sim) {
    sim = await import('./dev/mockSim');
  } else {
    const loader = simMods['../sim/index.ts'];
    if (!loader) throw new Error('src/sim/index.ts is missing (simulator not built yet); ?mock=1 runs the dev mock');
    sim = (await loader()) as SimApi;
  }

  let createScene: CreateScene;
  if (mock.scene) {
    createScene = (await import('./dev/mockScene')).createMockScene;
  } else {
    const loader = sceneMods['../scene/index.ts'];
    if (!loader) throw new Error('src/scene/index.ts is missing (3D scene not built yet); ?mock=scene runs a placeholder');
    createScene = ((await loader()) as { createScene: CreateScene }).createScene;
  }

  let createWorker: () => WorkerLike;
  if (mock.worker) {
    const { createMockWorker } = await import('./dev/mockWorker');
    createWorker = () => createMockWorker(sim.buildScenario);
  } else {
    createWorker = () => wrapWorker(new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' }));
  }

  return { mock: mock.sim || mock.worker || mock.scene, sim, createScene, createWorker };
}
