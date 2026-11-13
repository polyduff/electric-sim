# Home Energy Simulator: interface spec

Normative types live in `src/shared/types.ts` (lead-owned, frozen; propose changes in your report rather than editing). This file explains how the pieces fit.

## Ownership

| Path | Owner |
| --- | --- |
| `src/shared/types.ts`, `docs/`, `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md` | lead |
| `src/sim/**` | simulator agent |
| `src/scene/**` | scene agent |
| `src/ui/**`, `src/main.ts`, `index.html` | UI agent |
| `tests/**`, `e2e/**` | verifier agent |

Never edit another owner's files. If you need a dependency, say so in your report (already installed: `three`, `highs`, `vite`, `typescript`, `vitest`, `@types/three`, `@types/node`).

## Model

- Time: 30-minute steps (`DT_H = 0.5`), scenario = `days * 48` steps (default 2 days = 96), step 0 starts at 07:00 local. Site: Christchurch (lat -43.53), 12 November.
- Hardware: PV 6 kWp; battery 13.5 kWh usable, 5 kW each way, 90% round trip (sqrt(0.9) on charge and on discharge), starts at 50% and must finish at >= 50% (same terminal rule for both policies); EV plugged 18:00 to 07:00, needs 40 kWh per session, 7 kW max, charging lossless, no V2G; grid import/export unlimited.
- Power balance each step, no curtailment: `pv + import + discharge = load + ev + charge + export`.
- Step cost: `(B_t * import - S_t * export) * DT_H`. Invariant `0 < S_t < B_t`.
- Prices: `B_t = TOU_t + W_t`, where `W_t` is a mean-reverting (OU) wholesale component plus spikes (seeded ones and user `priceSpike` events). `S_t` follows a lower TOU schedule plus a share of `W_t`, clamped strictly below `B_t`. NZ-like magnitudes: buy roughly 0.17 to 0.40 $/kWh, feed-in roughly 0.08 to 0.20 $/kWh outside spikes.
- Cloud: seeded mean-reverting cloud cover in 0..1 plus user `cloud` events; `pv = clearSky * attenuation(cloud)`.
- Events: `ScenarioEvent[]` is the single source of truth for draggable disturbances. `defaultEvents(config)` returns the seeded initial set (at least 2 price spikes and 2 cloud events). Base stochastic series depend only on `config.seed`, so moving an event changes only that event's footprint.
- Forecasts: `forecastAt(scenario, k)` is a pure function. Index 0 (the current step) is exact. For lead L > 0 the forecast is a blend of realised value and the deterministic baseline plus persistent noise, with error growing in L and scaled by `config.forecastError`; at `forecastError = 0` the forecast equals the realised series. Forecast feed-in stays below forecast buy.

## Policies

- **MPC** (`policy: 'mpc'`): at each step k, build an LP over `forecastAt(scenario, k)` (horizon 24 h, truncated at scenario end), solve it with a real LP solver (HiGHS via the `highs` package), apply only step k's decision against realised values, roll forward. Hard constraints: SoC bounds, power limits, EV deadline, terminal SoC at scenario end. The applied step must always be feasible in the real world (balance closes via grid).
- **DP** (`policy: 'dp'`): backward dynamic programming over (battery SoC, EV energy delivered) on the realised series, forward pass to extract the trajectory. Perfect hindsight.
- Expected relation: `mpc.totalCost >= dp.totalCost` up to DP grid tolerance.

## Simulation API (`src/sim/index.ts`, pure, main-thread safe, no WASM)

```ts
export const DEFAULT_CONFIG: SimConfig;
export function defaultEvents(config: SimConfig): ScenarioEvent[];
export function buildScenario(config: SimConfig, events: ScenarioEvent[]): Scenario;
export function forecastAt(scenario: Scenario, k: number): Forecast;
export function sunPosition(config: SimConfig, timeH: number): { elevationDeg: number; azimuthDeg: number };
```

Solver entry points (used by the worker and by tests in Node):

```ts
// src/sim/solve.ts
export async function initSolver(): Promise<string>;            // loads HiGHS, returns solver label
export function solveDp(scenario: Scenario, opts?: { allowGridCharge?: boolean; battery?: boolean }): PolicyResult;
export function solveMpc(scenario: Scenario): PolicyResult;     // requires initSolver()
export function solveHindsightLp(scenario: Scenario): PolicyResult; // exact optimum, for tests only
export function solveAll(reqId: number, config: SimConfig, events: ScenarioEvent[]): SolveResult;
export function computeInsight(reqId: number, scenario: Scenario, dp: PolicyResult): ArbitrageInsight;
```

## Worker protocol (`src/sim/worker.ts`, module worker)

UI creates it with `new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' })`.

| Direction | Message | Meaning |
| --- | --- | --- |
| UI to worker | `{ type: 'init' }` | load the LP solver |
| worker to UI | `{ type: 'ready', solver, initMs }` | solver loaded |
| UI to worker | `{ type: 'solve', reqId, config, events, wantInsight }` | build scenario, run DP and MPC |
| worker to UI | `{ type: 'solved', result: SolveResult }` | full trajectories + timing |
| worker to UI | `{ type: 'insight', insight }` | only if `wantInsight`; posted after `solved` |
| worker to UI | `{ type: 'error', reqId, message }` | failure |

Rules: the UI keeps at most one request in flight and remembers only the latest pending one (coalescing during drags). While dragging it sends `wantInsight: false`; on drop it sends a final request with `wantInsight: true`. The UI measures latency as postMessage to result applied and shows it with the worker's `timing`. The worker may reuse a cached MPC prefix when only late steps changed (`timing.mpcFromStep`). Target: full re-solve well under 300 ms, drags typically faster.

## Scene API (`src/scene/index.ts`)

```ts
export function createScene(container: HTMLElement): SceneApi; // setFrame / resize / dispose
```

The scene owns its renderer, camera controls and its own requestAnimationFrame loop; the UI calls `setFrame(SceneFrame)` every frame. Scene imports only `three` and `src/shared/types.ts`.

World convention: +Y up, +X east, -Z north. Sun direction from azimuth `a` (clockwise from north) and elevation `e`: `(sin a cos e, sin e, -cos a cos e)`. Christchurch's midday sun is in the north, so panels sit on the north (-Z) roof face and the default camera looks from the north side. House 0 (MPC) stands to the west/left as seen by the default camera, house 1 (DP) to the right.

Per house, five flow links meet at the switchboard: solar to board (`pvKw`), board to home load (`loadKw`), board to EV (`evKw`), battery to/from board (`battKw`, + = charging), grid to/from board (`gridKw`, + = import). Thickness and particle rate scale with |kW|, direction with sign.

## UI

Layout: 3D view on top (both houses), cost HUD (MPC, DP, live gap), timeline below, controls bar. HUD numbers come from `SolveResult` / `ArbitrageInsight` only. Running cost at fractional time `t = k + f` is `cumCost[k] + f * stepCost[k]`.

HUD overlays and camera framing: every HUD element that floats over the 3D container carries `data-hud-overlay`. The scene reads those elements' bounding boxes (relative to its container) when fitting the camera, and re-fits when they or the container resize, so houses, labels and flows stay clear of the HUD at any window size.

Test hooks (required): `window.__energySim: AppDebug`, and these `data-testid`s: `play`, `speed`, `scrub`, `forecast-error`, `reset`, `timeline`, `clock`, `cost-mpc`, `cost-dp`, `gap`, `latency`, `arbitrage`. Each draggable event is a DOM or SVG element with `data-event-id="<id>"` and `data-event-kind`, draggable with the mouse horizontally (time) and vertically (magnitude).

## Dev ports

Scene agent 5181, UI agent 5182, verifier 5183, lead 5173. Headless Chromium needs `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` for WebGL.
