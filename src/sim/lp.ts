import highsLoader from 'highs';
import type { Highs, InitOptions } from 'highs';

/**
 * HiGHS (WASM) runtime management.
 *
 * - `initSolver()` loads the runtime once. In Node the package finds its own
 *   .wasm file; in a browser worker the caller passes the asset URL (or bytes).
 * - A second, idle runtime is instantiated in the background. If the active
 *   runtime ever aborts (WASM trap, out of memory), `recoverSolver()` swaps the
 *   spare in synchronously, so the synchronous solve functions can retry
 *   without awaiting, and a new spare is prepared in the background.
 */

export interface SolverInitOptions {
  /** URL of highs.wasm (browser / worker). Ignored in Node when not given. */
  wasmUrl?: string;
  /** The .wasm bytes, if the caller already has them. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Set false to skip preparing the stand-by runtime (default true). */
  spare?: boolean;
}

let active: Highs | null = null;
let spare: Highs | null = null;
let sparePending: Promise<void> | null = null;
let initPending: Promise<string> | null = null;
let loaderOptions: InitOptions = {};
let wantSpare = true;
let label = '';
let generation = 0;
let recoveries = 0;

async function resolveLoaderOptions(opts: SolverInitOptions | undefined): Promise<InitOptions> {
  if (opts?.wasmBinary) {
    try {
      return { wasmModule: await WebAssembly.compile(opts.wasmBinary as BufferSource) };
    } catch {
      return { wasmBinary: opts.wasmBinary };
    }
  }
  if (opts?.wasmUrl) {
    const url = opts.wasmUrl;
    // Fetch and compile once so the stand-by runtime does not download it again.
    if (typeof fetch === 'function') {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const bytes = await response.arrayBuffer();
          return { wasmModule: await WebAssembly.compile(bytes) };
        }
      } catch {
        // fall through to locateFile
      }
    }
    return { locateFile: () => url };
  }
  return {};
}

function prepareSpare(): void {
  if (!wantSpare || spare || sparePending) return;
  // A fresh options object per runtime: the Emscripten loader mutates the object it is given,
  // so sharing one between the active and the stand-by runtime makes them clobber each other.
  sparePending = highsLoader({ ...loaderOptions })
    .then((h) => {
      spare = h;
    })
    .catch(() => {
      // No stand-by available; recovery will simply fail and surface the error.
    })
    .finally(() => {
      sparePending = null;
    });
}

/** Loads HiGHS (idempotent) and returns a label such as "HiGHS 1.11.0 (WASM)". */
export function initSolver(opts?: SolverInitOptions): Promise<string> {
  if (active) return Promise.resolve(label);
  if (!initPending) {
    initPending = (async () => {
      loaderOptions = await resolveLoaderOptions(opts);
      wantSpare = opts?.spare !== false;
      const h = await highsLoader({ ...loaderOptions });
      active = h;
      generation++;
      label = `HiGHS ${h.version.string} (WASM)`;
      prepareSpare();
      return label;
    })();
    initPending.catch(() => {
      initPending = null;
    });
  }
  return initPending;
}

export function isSolverReady(): boolean {
  return active !== null;
}

/** The active runtime. Throws if `initSolver()` has not completed. */
export function getHighs(): Highs {
  if (!active) throw new Error('LP solver not initialised: await initSolver() first');
  return active;
}

export function solverLabel(): string {
  return label;
}

/** Changes whenever the active runtime is replaced; persistent models belong to one generation. */
export function solverGeneration(): number {
  return generation;
}

/** Number of times a broken runtime has been replaced by the stand-by. */
export function solverRecoveries(): number {
  return recoveries;
}

/** Resolves once the stand-by runtime (if any) has finished loading. */
export async function spareReady(): Promise<boolean> {
  if (sparePending) await sparePending;
  return spare !== null;
}

/**
 * Replaces the active runtime with the stand-by after a failure. Returns false
 * if no stand-by is ready (the caller should then fall back or rethrow).
 */
export function recoverSolver(): boolean {
  if (!spare) {
    prepareSpare();
    return false;
  }
  active = spare;
  spare = null;
  generation++;
  recoveries++;
  prepareSpare();
  return true;
}
