/**
 * Pure, main-thread-safe simulation API. Nothing reachable from this file
 * imports the WASM LP solver; the solver entry points live in ./solve.
 */
export { DEFAULT_CONFIG, defaultEvents, buildScenario } from './scenario';
export { forecastAt } from './forecast';
export { sunPosition } from './sun';
