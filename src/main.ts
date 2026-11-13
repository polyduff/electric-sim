/**
 * Entry point. Uses the real simulator, worker and 3D scene by default;
 * `?mock=1` swaps in the dev-only fakes from src/ui/dev (see src/ui/backend.ts).
 *
 * URL parameters (for deterministic screenshots/tests):
 *   ?paused=1    start paused
 *   ?t=<hours>   initial time, hours since scenario start
 *   ?mock=1      dev mocks instead of the real modules (or a subset: ?mock=scene, ?mock=worker)
 */
import './ui/styles.css';
import { App } from './ui/app';
import { loadBackend, parseMockParam } from './ui/backend';
import { installCssVars } from './ui/theme';

installCssVars();

const params = new URLSearchParams(location.search);
const flag = (name: string): boolean => {
  const v = params.get(name);
  return v !== null && v !== '0' && v !== 'false';
};
const tParam = params.get('t');
const t = tParam !== null && tParam.trim() !== '' ? Number(tParam) : NaN;

loadBackend(parseMockParam(params.get('mock')))
  .then((backend) => {
    if (backend.mock) document.documentElement.dataset.mock = '1';
    new App(backend, {
      startPaused: flag('paused'),
      initialTimeH: Number.isFinite(t) ? t : null,
    });
  })
  .catch((err: unknown) => {
    console.error(err);
    const toast = document.getElementById('toast');
    const loading = document.getElementById('loading');
    if (loading) loading.classList.add('done');
    if (toast) {
      toast.hidden = false;
      toast.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
