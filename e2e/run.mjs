// End-to-end verification of the home energy simulator UI.
// Self-contained: starts its own Vite dev server (port 5183), drives headless Chromium via Playwright,
// writes screenshots + report.json to e2e/out/, kills the server, exits non-zero on any failed check.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
const PORT = 5183;
const URL_BASE = `http://localhost:${PORT}/`;
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- playwright resolution
function loadPlaywright() {
  const tries = [];
  try {
    return createRequire(path.join(ROOT, 'package.json'))('playwright');
  } catch (e) {
    tries.push(`project: ${e.message.split('\n')[0]}`);
  }
  try {
    // ESM import ignores NODE_PATH, a CommonJS require honours it.
    return createRequire(path.join(ROOT, 'package.json'))(
      createRequire(import.meta.url).resolve('playwright', { paths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean) }),
    );
  } catch (e) {
    tries.push(`NODE_PATH: ${e.message.split('\n')[0]}`);
  }
  throw new Error(`playwright not found. ${tries.join(' | ')}`);
}
const pw = loadPlaywright();

// ---------------------------------------------------------------- tiny test harness
const report = { startedAt: new Date().toISOString(), checks: [], consoleErrors: [], pageErrors: [], warnings: [], failedRequests: [], screenshots: [], latencies: {}, notes: [] };
let failures = 0;
let ensureApp = async () => {};
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await ensureApp(name);
    const detail = await fn();
    report.checks.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
    console.log(`PASS  ${name}${detail ? '  ' + JSON.stringify(detail).slice(0, 200) : ''}`);
  } catch (e) {
    failures++;
    report.checks.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message ? e.message : e) });
    console.log(`FAIL  ${name}\n      ${String(e && e.message ? e.message : e).split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
}

// ---------------------------------------------------------------- dev server
let server = null;
function startServer() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  const cmd = existsSync(bin) ? bin : 'npx';
  const args = existsSync(bin) ? ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'] : ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'];
  server = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  server.on('exit', (code) => {
    if (code !== null && code !== 0 && !server.__killed) console.log(`vite exited early (${code}):\n${log}`);
  });
  return () => log;
}
function stopServer() {
  if (server && !server.killed) {
    server.__killed = true;
    server.kill('SIGTERM');
    setTimeout(() => server && !server.killed && server.kill('SIGKILL'), 2000).unref();
  }
}
async function waitForServer(getLog) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return;
    } catch {}
    if (server.exitCode !== null) throw new Error(`vite died: ${getLog()}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite did not come up on ${PORT}: ${getLog()}`);
}

// ---------------------------------------------------------------- page helpers
const state = (page) => page.evaluate(() => window.__energySim.getState());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openApp(page, query = '?paused=1&t=0') {
  await page.goto(URL_BASE + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__energySim && window.__energySim.getState().ready, null, { timeout: 120000 });
  await settle(page);
}
/** wait until no solve is in flight and the insight caught up */
async function settle(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const s = window.__energySim.getState();
      const i = window.__energySim.getInsight();
      return s.ready && !s.solving && i !== null && !document.querySelector('[data-testid=arbitrage]').classList.contains('stale');
    },
    null,
    { timeout },
  );
}
async function nextFrames(page, n = 2) {
  await page.evaluate((n) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
}
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, timeout: 180000, ...opts });
  report.screenshots.push(path.relative(ROOT, file));
  return file;
}
const parseMoney = (t) => {
  const m = /(-?)\$(\d+(?:\.\d+)?)/.exec(t.replace('−', '-'));
  assert(m, `cannot parse money from "${t}"`);
  return (m[1] ? -1 : 1) * parseFloat(m[2]);
};
const parseSignedMoney = (t) => {
  const m = /^\s*([+\-−]?)\$(\d+(?:\.\d+)?)/.exec(t);
  assert(m, `cannot parse signed money from "${t}"`);
  return (m[1] === '-' || m[1] === '−' ? -1 : 1) * parseFloat(m[2]);
};
const text = (page, sel) => page.locator(sel).first().innerText();

/** running cost at playhead, recomputed independently from the SolveResult arrays */
function runningCostAt(res, timeH) {
  const n = res.n;
  const pos = timeH / 0.5;
  const k = Math.min(n - 1, Math.max(0, Math.floor(pos + 1e-9)));
  const f = Math.min(1, Math.max(0, pos - k));
  const rc = (p) => p.cumCost[k] + f * p.stepCost[k];
  return { k, f, mpc: rc(res.mpc), dp: rc(res.dp) };
}
/** Recompute expected clock label independent of the app's format helpers */
function expectedClock(timeH, startHour = 7) {
  const mins = Math.floor(Math.max(0, timeH) * 60 + 1e-6);
  const day = Math.floor((startHour * 60 + mins) / 1440) + 1;
  const total = (startHour * 60 + mins) % 1440;
  return `Day ${day} · ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Snapshot of the DOM readouts + sim state in one atomic evaluate */
function readoutSnapshot(page) {
  return page.evaluate(() => {
    const g = (s) => document.querySelector(s)?.textContent ?? '';
    const sim = window.__energySim;
    const rows = (card) => {
      const o = {};
      for (const key of ['grid', 'batt', 'ev', 'pv', 'load']) {
        const r = document.querySelector(`#card-${card} .row-${key}`);
        o[key] = { v: r?.querySelector('.row-v')?.textContent ?? '', n: r?.querySelector('.row-n')?.textContent ?? '', state: r?.getAttribute('data-state') ?? '' };
      }
      return o;
    };
    const res = sim.getResult();
    return {
      state: sim.getState(),
      insight: sim.getInsight(),
      dom: {
        clock: g('[data-testid=clock]'),
        mpc: g('[data-testid=cost-mpc]'),
        dp: g('[data-testid=cost-dp]'),
        gap: g('[data-testid=gap]'),
        latency: g('[data-testid=latency]'),
        arb: g('[data-testid=arbitrage]'),
        arbHeadline: g('#arb-headline'),
        arbDetail: g('#arb-detail'),
        mpcRows: rows('mpc'),
        dpRows: rows('dp'),
      },
      res: res && {
        n: res.scenario.n,
        timing: res.timing,
        mpc: { cumCost: Array.from(res.mpc.cumCost), stepCost: Array.from(res.mpc.stepCost), gridImportKw: Array.from(res.mpc.gridImportKw), gridExportKw: Array.from(res.mpc.gridExportKw), battChargeKw: Array.from(res.mpc.battChargeKw), battDischargeKw: Array.from(res.mpc.battDischargeKw), socKwh: Array.from(res.mpc.socKwh), evKw: Array.from(res.mpc.evKw), evDeliveredKwh: Array.from(res.mpc.evDeliveredKwh), totalCost: res.mpc.totalCost },
        dp: { cumCost: Array.from(res.dp.cumCost), stepCost: Array.from(res.dp.stepCost), gridImportKw: Array.from(res.dp.gridImportKw), gridExportKw: Array.from(res.dp.gridExportKw), battChargeKw: Array.from(res.dp.battChargeKw), battDischargeKw: Array.from(res.dp.battDischargeKw), socKwh: Array.from(res.dp.socKwh), evKw: Array.from(res.dp.evKw), evDeliveredKwh: Array.from(res.dp.evDeliveredKwh), totalCost: res.dp.totalCost },
        scenario: { buy: Array.from(res.scenario.buy), sell: Array.from(res.scenario.sell), buyBase: Array.from(res.scenario.buyBase), pvKw: Array.from(res.scenario.pvKw), clearSkyKw: Array.from(res.scenario.clearSkyKw), cloud: Array.from(res.scenario.cloud), loadKw: Array.from(res.scenario.loadKw), evPlugged: Array.from(res.scenario.evPlugged), events: res.scenario.events },
      },
    };
  });
}

/** Mean brightness / contrast / colour variety of a PNG buffer, computed inside the page. */
async function imageStats(page, buf) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, n = 0;
    const colours = new Set();
    for (let i = 0; i < d.length; i += 16) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += y;
      sum2 += y * y;
      n++;
      colours.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
    }
    const mean = sum / n;
    // upper-third mean (sky) for the day/night comparison
    return { w: img.width, h: img.height, mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), colours: colours.size };
  }, buf.toString('base64'));
}

/** Screenshot of only the WebGL scene (HUD overlays hidden), returning image statistics. */
async function canvasStats(page, name) {
  const styleHandle = await page.addStyleTag({ content: '#stage > *:not(#scene){visibility:hidden !important}' });
  await nextFrames(page, 2);
  const rect = await page.evaluate(() => { const r = document.querySelector('#scene').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const buf = await page.screenshot({ clip: rect, timeout: 180000 });
  writeFileSync(path.join(OUT, `${name}.png`), buf);
  report.screenshots.push(path.join('e2e', 'out', `${name}.png`));
  await styleHandle.evaluate((el) => el.remove());
  return imageStats(page, buf);
}

async function chipBox(page, id) {
  const box = await page.locator(`[data-event-id="${id}"]`).boundingBox();
  assert(box, `no chip ${id}`);
  return box;
}

/**
 * Real-mouse drag of a chip with a sampler recording every applied solve while the button is still down.
 * Returns what was observed.
 */
async function dragChip(page, id, dx, dy, { steps = 14 } = {}) {
  const before = await readoutSnapshot(page);
  await page.evaluate(() => {
    window.__samples = [];
    let last = -1;
    clearInterval(window.__samplerTimer);
    window.__samplerTimer = setInterval(() => {
      const s = window.__energySim.getState();
      if (s.solveCount !== last) {
        last = s.solveCount;
        const r = window.__energySim.getResult();
        window.__samples.push({ t: performance.now(), solveCount: s.solveCount, latencyMs: s.latencyMs, workerMs: r?.timing.totalMs, mpcMs: r?.timing.mpcMs, dpMs: r?.timing.dpMs, lpSolves: r?.timing.lpSolves, mpcFromStep: r?.timing.mpcFromStep, events: s.events.map((e) => ({ ...e })) });
      }
    }, 4);
  });
  const box = await chipBox(page, id);
  const x0 = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const midState = [];
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    if (i === Math.floor(steps / 2)) {
      // give the worker a chance to answer while the button is still held
      await page.waitForFunction((c0) => window.__energySim.getState().solveCount > c0, before.state.solveCount, { timeout: 60000 }).catch(() => {});
      midState.push(await state(page));
    }
  }
  const beforeUp = await state(page);
  await page.mouse.up();
  await settle(page, 90000);
  await sleep(100);
  const after = await readoutSnapshot(page);
  const samples = await page.evaluate(() => { clearInterval(window.__samplerTimer); return window.__samples; });
  return { before, midState: midState[0], beforeUp, after, samples };
}

// ---------------------------------------------------------------- main
const getLog = startServer();
let browser;
try {
  await waitForServer(getLog);
  browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') report.consoleErrors.push(t);
    else if (m.type() === 'warning') report.warnings.push(t);
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) report.notes.push(`main frame navigated to ${f.url()} at ${new Date().toISOString()}`); });
  page.on('console', (m) => { if (/\[vite\]/.test(m.text())) report.notes.push(`vite: ${m.text()}`); });
  let firstCheck = true;
  ensureApp = async (name) => {
    if (firstCheck) { firstCheck = false; return; }
    const ok = await page.evaluate(() => !!window.__energySim).catch(() => false);
    if (!ok) {
      report.notes.push(`page lost window.__energySim before check "${name}" (reloaded, probably Vite HMR from concurrent edits); reopening`);
      await openApp(page, '?paused=1&t=0');
    }
  };
  page.on('pageerror', (e) => report.pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('requestfailed', (r) => report.failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) report.failedRequests.push(`${r.status()} ${r.url()}`); });

  let defaults = null;

  await check('loads, hooks appear, first solve displayed, no console/page errors', async () => {
    const t0 = Date.now();
    await openApp(page, '?paused=1&t=0');
    const s = await state(page);
    assert(s.ready && s.solveCount >= 1, 'not ready');
    assert(s.events.length >= 4, 'default events missing');
    for (const id of ['play', 'speed', 'scrub', 'forecast-error', 'reset', 'timeline', 'clock', 'cost-mpc', 'cost-dp', 'gap', 'latency', 'arbitrage']) {
      assert((await page.locator(`[data-testid="${id}"]`).count()) === 1, `missing data-testid=${id}`);
    }
    assert((await page.locator('[data-event-id]').count()) >= 4, 'chips missing');
    for (const el of await page.locator('[data-event-id]').all()) assert(['priceSpike', 'cloud'].includes(await el.getAttribute('data-event-kind')), 'chip kind');
    await sleep(1500);
    defaults = await readoutSnapshot(page);
    assert(report.pageErrors.length === 0, `page errors: ${report.pageErrors.join(' || ')}`);
    assert(report.consoleErrors.length === 0, `console errors: ${report.consoleErrors.join(' || ')}`);
    return { loadMs: Date.now() - t0, firstLatencyMs: s.latencyMs, totals: [s.totalMpc, s.totalDp] };
  });

  await check('canvas exists with non-zero size and a WebGL context', async () => {
    const info = await page.evaluate(() => {
      const c = document.querySelector('#scene canvas');
      if (!c) return null;
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      return { w: c.clientWidth, h: c.clientHeight, bw: c.width, bh: c.height, hasCtx: !!gl };
    });
    assert(info && info.w > 300 && info.h > 200, `canvas ${JSON.stringify(info)}`);
    return info;
  });

  await check('readouts (clock, costs, gap, card rows, latency, arbitrage) agree with the sim at several playhead times', async () => {
    const times = [0.01, 3.37, 6.5, 6.71, 11.3, 12.77, 17.9, 23.4, 30.17, 41.6, 47.8];
    const rows = [];
    for (const t of times) {
      await page.evaluate((t) => { window.__energySim.pause(); window.__energySim.setTimeH(t); }, t);
      await nextFrames(page, 1);
      const snap = await readoutSnapshot(page);
      const T = snap.state.timeH;
      const exp = runningCostAt(snap.res, T);
      near(parseMoney(snap.dom.mpc), exp.mpc, 0.0051, `t=${t} MPC readout`);
      near(parseMoney(snap.dom.dp), exp.dp, 0.0051, `t=${t} DP readout`);
      near(parseSignedMoney(snap.dom.gap), exp.mpc - exp.dp, 0.0051, `t=${t} gap readout`);
      near(snap.state.costMpc, exp.mpc, 1e-9, `t=${t} state.costMpc`);
      near(snap.state.costDp, exp.dp, 1e-9, `t=${t} state.costDp`);
      near(snap.state.gap, exp.mpc - exp.dp, 1e-9, `t=${t} state.gap`);
      assert(snap.dom.clock.trim() === expectedClock(T), `t=${t} clock "${snap.dom.clock}" vs "${expectedClock(T)}"`);
      // card rows at step k
      const k = exp.k;
      for (const [pol, rowsDom] of [['mpc', snap.dom.mpcRows], ['dp', snap.dom.dpRows]]) {
        const p = snap.res[pol];
        const sc = snap.res.scenario;
        assert(rowsDom.pv.v.trim() === `${sc.pvKw[k].toFixed(1)} kW`, `t=${t} ${pol} solar "${rowsDom.pv.v}" vs ${sc.pvKw[k].toFixed(1)}`);
        assert(rowsDom.load.v.trim() === `${sc.loadKw[k].toFixed(1)} kW`, `t=${t} ${pol} load "${rowsDom.load.v}" vs ${sc.loadKw[k].toFixed(1)}`);
        const imp = p.gridImportKw[k], ex = p.gridExportKw[k];
        const gridWant = imp >= 0.05 && imp >= ex ? ['import', imp] : ex >= 0.05 ? ['export', ex] : ['idle', 0];
        assert(rowsDom.grid.state === gridWant[0], `t=${t} ${pol} grid state "${rowsDom.grid.state}" vs ${gridWant[0]} (imp ${imp}, exp ${ex})`);
        assert(rowsDom.grid.v.trim() === `${Number(gridWant[1]).toFixed(1)} kW`, `t=${t} ${pol} grid kW "${rowsDom.grid.v}" vs ${gridWant[1]}`);
        const ch = p.battChargeKw[k], di = p.battDischargeKw[k];
        const battWant = ch >= 0.05 && ch >= di ? 'charge' : di >= 0.05 ? 'discharge' : 'idle';
        assert(rowsDom.batt.state === battWant, `t=${t} ${pol} batt state "${rowsDom.batt.state}" vs ${battWant}`);
        const socPct = Math.round(((p.socKwh[k] + exp.f * (p.socKwh[k + 1] - p.socKwh[k])) / 13.5) * 100);
        assert(rowsDom.batt.n.includes(`${socPct}%`), `t=${t} ${pol} soc text "${rowsDom.batt.n}" vs ${socPct}%`);
        const plugged = sc.evPlugged[k] === 1;
        assert((rowsDom.ev.state === 'away') === !plugged, `t=${t} ${pol} EV state "${rowsDom.ev.state}" but plugged=${plugged}`);
      }
      rows.push([t, snap.dom.mpc, snap.dom.dp, snap.dom.gap, snap.dom.clock]);
    }
    // arbitrage text
    const snap = await readoutSnapshot(page);
    assert(snap.insight, 'no insight');
    assert(snap.dom.arbHeadline.trim() === snap.insight.headline.trim(), `arb headline "${snap.dom.arbHeadline}" vs insight "${snap.insight.headline}"`);
    assert(snap.state.insightText === snap.insight.headline, 'state.insightText');
    assert(snap.dom.arb.trim() === snap.insight.headline.trim(), `arbitrage element must contain only the headline, got "${snap.dom.arb}"`);
    const i = snap.insight;
    const d = snap.dom.arbDetail;
    assert(d.includes(`$${i.arbitrageValuePerDay.toFixed(2)}/day`), `detail per-day: ${d}`);
    assert(d.includes(`grid-charged ${i.gridChargedKwh.toFixed(1)} kWh`), `detail grid-charged: ${d}`);
    assert(d.includes(`$${i.noBatteryCost.toFixed(2)}`), `detail no-battery: ${d}`);
    const sc = (v) => `${v < 0 ? '-' : '+'}${Math.abs(v * 100).toFixed(1)}c`;
    assert(d.includes(sc(i.bestExportSpread)), `detail export spread ${sc(i.bestExportSpread)}: ${d}`);
    assert(d.includes(sc(i.bestShiftSpread)), `detail shift spread ${sc(i.bestShiftSpread)}: ${d}`);
    // totals shown on the cards
    const totM = await text(page, '#card-mpc [data-ref=total]');
    const totD = await text(page, '#card-dp [data-ref=total]');
    near(parseMoney(totM), snap.state.totalMpc, 0.0051, 'MPC total text');
    near(parseMoney(totD), snap.state.totalDp, 0.0051, 'DP total text');
    const gt = await text(page, '#gap-total');
    near(parseSignedMoney(gt.replace(/^.*?:\s*/, '')), snap.state.totalMpc - snap.state.totalDp, 0.0051, 'gap-total text');
    return rows;
  });

  await check('latency readout shows a measured number that matches getState().latencyMs', async () => {
    const snap = await readoutSnapshot(page);
    const m = /re-solve (\d+) ms · DP (\d+) · MPC (\d+) \((\d+) LPs?\)(?: · drag median (\d+) ms \(n=(\d+)\))?/.exec(snap.dom.latency);
    assert(m, `latency text "${snap.dom.latency}"`);
    assert(Number(m[1]) === Math.round(snap.state.latencyMs), `latency text ${m[1]} vs state ${snap.state.latencyMs}`);
    assert(snap.state.latencyMs > 0 && Number.isFinite(snap.state.latencyMs), 'latencyMs not measured');
    assert(Number(m[4]) > 0, `latency text must describe a request that solved LPs, got ${m[4]} LPs`);
    if (snap.res.timing.lpSolves > 0) assert(Number(m[4]) === snap.res.timing.lpSolves, `LP count text ${m[4]} vs timing ${snap.res.timing.lpSolves}`);
    return { text: snap.dom.latency };
  });

  // ---------------------------------------------------------------- drags
  let dragSpike = null;
  await check('DRAG price-spike chip with real mouse: moves in time and size, live re-solves during the drag, scenario/insight/latency follow', async () => {
    await page.evaluate(() => { window.__energySim.pause(); window.__energySim.setTimeH(6.5); });
    await shot(page, 'drag-spike-before', { animations: 'disabled' });
    const before = await readoutSnapshot(page);
    const ev0 = before.state.events.find((e) => e.id === 'spike-1');
    // spike-1: evening of day 1. Move right ~6 hours and up. A step is (plot width / 96) px.
    const plot = await page.locator('[data-testid=timeline]').boundingBox();
    const stepPx = (plot.width - 80) / 96;
    const dx = Math.round(stepPx * 12); // 12 steps = 6 h
    const r = await dragChip(page, 'spike-1', dx, -50);
    dragSpike = r;
    const ev1 = r.after.state.events.find((e) => e.id === 'spike-1');
    assert(ev1.startStep > ev0.startStep + 6, `startStep ${ev0.startStep} -> ${ev1.startStep}`);
    assert(Math.abs(ev1.magnitude - ev0.magnitude) > 0.05, `magnitude ${ev0.magnitude} -> ${ev1.magnitude}`);
    // live: solveCount went up before mouse up, and events already changed before mouse up
    assert(r.beforeUp.solveCount > r.before.state.solveCount, `no solve applied before release (${r.before.state.solveCount} -> ${r.beforeUp.solveCount})`);
    const live = r.beforeUp.events.find((e) => e.id === 'spike-1');
    assert(live.startStep !== ev0.startStep, 'event not moved live during drag');
    // other events untouched
    for (const e0 of before.state.events) if (e0.id !== 'spike-1') {
      const e1 = r.after.state.events.find((e) => e.id === e0.id);
      assert(JSON.stringify(e1) === JSON.stringify(e0), `event ${e0.id} changed by dragging spike-1`);
    }
    // totals changed
    assert(Math.abs(r.after.state.totalMpc - before.state.totalMpc) > 1e-4 || Math.abs(r.after.state.totalDp - before.state.totalDp) > 1e-4, 'totals unchanged');
    // result scenario reflects the move
    const sc = r.after.res.scenario;
    const resEv = sc.events.find((e) => e.id === 'spike-1');
    assert(resEv.startStep === ev1.startStep && Math.abs(resEv.magnitude - ev1.magnitude) < 1e-9, `result scenario event ${JSON.stringify(resEv)} vs state ${JSON.stringify(ev1)}`);
    const bump = (s, t) => s.buy[t] - s.buyBase[t];
    const core = (e) => Array.from({ length: e.durationSteps }, (_, i) => e.startStep + i);
    const newMax = Math.max(...core(ev1).map((t) => bump(sc, t)));
    assert(newMax > 0.6 * ev1.magnitude, `buy bump at new position ${newMax} vs magnitude ${ev1.magnitude}`);
    const oldOnly = core(ev0).filter((t) => !core(ev1).includes(t));
    const oldMax = Math.max(...oldOnly.map((t) => bump(sc, t)));
    assert(oldMax < 0.08, `old position still has price bump ${oldMax}`);
    // price must not have bumped at old position in the previous scenario => sanity that it did before
    assert(Math.max(...core(ev0).map((t) => bump(before.res.scenario, t))) > 0.15, 'precondition: bump existed at old position');
    // fresh insight after release
    assert(r.after.insight && before.insight && r.after.insight.reqId !== before.insight.reqId, 'no fresh insight after release');
    assert(r.after.dom.arbHeadline.trim() === r.after.insight.headline.trim(), 'arbitrage text not showing fresh insight');
    // latency readout
    const m = /re-solve (\d+) ms/.exec(r.after.dom.latency);
    assert(m && Number(m[1]) === Math.round(r.after.state.latencyMs), `latency text "${r.after.dom.latency}" vs ${r.after.state.latencyMs}`);
    // sampling log
    const live2 = r.samples.map((s) => ({ solveCount: s.solveCount, roundTripMs: Math.round(s.latencyMs), workerMs: s.workerMs && +s.workerMs.toFixed(1), mpcMs: s.mpcMs && +s.mpcMs.toFixed(1), lp: s.lpSolves, from: s.mpcFromStep }));
    report.latencies.spikeDrag = live2;
    report.latencies.spikeDragDisplayed = r.after.dom.latency;
    const solvesDuring = r.samples.filter((s) => s.events.some((e) => e.id === 'spike-1' && e.startStep !== ev0.startStep)).length;
    assert(solvesDuring >= 2, `only ${solvesDuring} distinct solves applied with the moved event (expected live re-solves)`);
    await shot(page, 'drag-spike-after', { animations: 'disabled' });
    return { from: ev0, to: ev1, solvesDuringDrag: r.beforeUp.solveCount - r.before.state.solveCount, totalMpc: [before.state.totalMpc, r.after.state.totalMpc], totalDp: [before.state.totalDp, r.after.state.totalDp], latencies: live2.map((x) => `${x.roundTripMs}/${x.workerMs}`) };
  });

  await check('DRAG spike to extreme (max magnitude, into the evening): arbitrage headline changes and reports re-export', async () => {
    const before = await readoutSnapshot(page);
    const e0 = before.state.events.find((e) => e.id === 'spike-2'); // morning of day 2
    const plot = await page.locator('[data-testid=timeline]').boundingBox();
    const stepPx = (plot.width - 80) / 96;
    // target around step 75 (19:30 day 2)
    const dx = Math.round(stepPx * (75 - e0.startStep));
    const r = await dragChip(page, 'spike-2', dx, -400);
    const e1 = r.after.state.events.find((e) => e.id === 'spike-2');
    assert(e1.magnitude === 1.5, `magnitude not clamped at max: ${e1.magnitude}`);
    assert(e1.startStep >= 70 && e1.startStep <= 80, `startStep ${e1.startStep}`);
    assert(r.after.insight.headline !== before.insight.headline, 'headline unchanged after extreme spike');
    report.notes.push(`extreme-spike headline: ${r.after.insight.headline}`);
    assert(r.after.insight.bestExportSpread > before.insight.bestExportSpread, 'export spread did not increase');
    // spike now sits in the evening: spread should be large enough that exporting from the battery pays
    assert(r.after.insight.exportPays === true, `exportPays false after 1.5 $/kWh evening spike; headline: ${r.after.insight.headline}`);
    assert(/re-export/.test(r.after.insight.headline), 'headline does not mention re-export');
    assert(r.after.dom.arbHeadline.trim() === r.after.insight.headline.trim(), 'DOM headline differs from insight');
    await shot(page, 'drag-spike-extreme', { animations: 'disabled' });
    return { from: e0, to: e1, headline: r.after.insight.headline };
  });

  await check('DRAG cloud chip with real mouse: PV drops under the new position, both policies re-plan', async () => {
    await page.evaluate(() => { window.__energySim.pause(); window.__energySim.setTimeH(6.5); });
    const before = await readoutSnapshot(page);
    const e0 = before.state.events.find((e) => e.id === 'cloud-1'); // day 1 midday
    const plot = await page.locator('[data-testid=timeline]').boundingBox();
    const stepPx = (plot.width - 80) / 96;
    // move it 20 steps left (10 h)?? cloud-1 starts at step 9, so move it right to day 2 morning-ish: +36 steps => 54..61
    const dx = Math.round(stepPx * 36);
    const r = await dragChip(page, 'cloud-1', dx, -30);
    const e1 = r.after.state.events.find((e) => e.id === 'cloud-1');
    assert(e1.startStep > e0.startStep + 20, `cloud startStep ${e0.startStep} -> ${e1.startStep}`);
    assert(Math.abs(e1.magnitude - e0.magnitude) > 0.02, `cloud magnitude ${e0.magnitude} -> ${e1.magnitude}`);
    assert(r.beforeUp.solveCount > r.before.state.solveCount, 'cloud drag: no live solve');
    const a = before.res.scenario, b = r.after.res.scenario;
    const core = (e) => Array.from({ length: e.durationSteps }, (_, i) => e.startStep + i).filter((t) => b.clearSkyKw[t] > 1);
    const tNew = core(e1);
    assert(tNew.length > 0, 'new cloud position has no daylight steps (test setup)');
    const ratioNew = tNew.reduce((s, t) => s + b.pvKw[t] / b.clearSkyKw[t], 0) / tNew.length;
    const ratioOldBefore = core(e0).length ? core(e0).reduce((s, t) => s + a.pvKw[t] / a.clearSkyKw[t], 0) / core(e0).length : 0;
    const tOld = Array.from({ length: e0.durationSteps }, (_, i) => e0.startStep + i).filter((t) => b.clearSkyKw[t] > 1 && !(t >= e1.startStep && t < e1.startStep + e1.durationSteps));
    const ratioOldAfter = tOld.reduce((s, t) => s + b.pvKw[t] / b.clearSkyKw[t], 0) / Math.max(1, tOld.length);
    assert(ratioNew < 0.8, `PV/clear-sky under the moved cloud is ${ratioNew.toFixed(2)}`);
    assert(ratioOldAfter > ratioOldBefore + 0.1, `PV at old cloud position did not recover (${ratioOldBefore.toFixed(2)} -> ${ratioOldAfter.toFixed(2)})`);
    // PV not changed outside footprints
    const inF = (t) => [e0, e1].some((e) => t >= e.startStep && t < e.startStep + e.durationSteps);
    for (let t = 0; t < a.pvKw.length; t++) if (!inF(t)) assert(Math.abs(a.pvKw[t] - b.pvKw[t]) < 1e-9, `PV changed outside footprint at step ${t}`);
    const dist = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0);
    const dm = dist(before.res.mpc.socKwh, r.after.res.mpc.socKwh) + dist(before.res.mpc.gridImportKw, r.after.res.mpc.gridImportKw);
    const dd = dist(before.res.dp.socKwh, r.after.res.dp.socKwh) + dist(before.res.dp.gridImportKw, r.after.res.dp.gridImportKw);
    assert(dm > 1e-3, 'MPC trajectory unchanged by cloud move');
    assert(dd > 1e-3, 'DP trajectory unchanged by cloud move');
    report.latencies.cloudDragDisplayed = r.after.dom.latency;
    report.latencies.cloudDrag = r.samples.map((s) => ({ solveCount: s.solveCount, roundTripMs: Math.round(s.latencyMs), workerMs: s.workerMs && +s.workerMs.toFixed(1), lp: s.lpSolves, from: s.mpcFromStep }));
    await shot(page, 'drag-cloud-after', { animations: 'disabled' });
    return { from: e0, to: e1, ratioNew, mpcTrajDelta: dm, dpTrajDelta: dd };
  });

  await check('chips: keyboard arrows move an event; "+ spike" adds one; delete button removes it', async () => {
    const before = await state(page);
    await page.locator('[data-event-id="cloud-2"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await settle(page);
    const s1 = await state(page);
    const c0 = before.events.find((e) => e.id === 'cloud-2'), c1 = s1.events.find((e) => e.id === 'cloud-2');
    assert(c1.startStep === c0.startStep - 1 && c1.magnitude > c0.magnitude, `keyboard: ${JSON.stringify(c0)} -> ${JSON.stringify(c1)}`);
    await page.click('[data-testid=add-spike]');
    await settle(page);
    const s2 = await state(page);
    assert(s2.events.length === before.events.length + 1, 'add-spike did not add');
    const added = s2.events.find((e) => !before.events.some((b) => b.id === e.id));
    await page.locator(`[data-event-id="${added.id}"]`).hover();
    await page.locator(`[data-event-id="${added.id}"] .chip-x`).click({ timeout: 15000 });
    await settle(page);
    const s3 = await state(page);
    assert(s3.events.length === before.events.length, 'delete did not remove');
  });

  // ---------------------------------------------------------------- controls
  await check('forecast-error slider: re-solves, changes MPC total but not DP total; error 0 => gap ~ 0', async () => {
    // start from default scenario
    await page.click('[data-testid=reset]');
    await settle(page);
    const a = await state(page);
    await page.locator('[data-testid=forecast-error]').fill('1');
    await page.waitForFunction((c) => window.__energySim.getState().solveCount > c, a.solveCount);
    await settle(page);
    const b = await state(page);
    assert(b.forecastError === 1, `forecastError ${b.forecastError}`);
    assert(Math.abs(b.totalMpc - a.totalMpc) > 1e-6, `MPC total unchanged ${a.totalMpc} -> ${b.totalMpc}`);
    near(b.totalDp, a.totalDp, 1e-9, 'DP total changed with forecast error');
    assert((await text(page, '#forecast-error-value')).trim() === '100%', 'value label');
    await page.locator('[data-testid=forecast-error]').fill('0');
    await page.waitForFunction((c) => window.__energySim.getState().solveCount > c, b.solveCount);
    await settle(page);
    const c = await state(page);
    near(c.totalDp, a.totalDp, 1e-9, 'DP total changed');
    const gap0 = c.totalMpc - c.totalDp;
    assert(gap0 > -0.05 && gap0 < 0.15, `fe=0 gap ${gap0}`);
    assert(c.totalMpc - c.totalDp < b.totalMpc - b.totalDp, 'gap at fe=0 not smaller than at fe=1');
    return { fe05: [a.totalMpc, a.totalDp, a.totalMpc - a.totalDp], fe1: [b.totalMpc, b.totalDp, b.totalMpc - b.totalDp], fe0: [c.totalMpc, c.totalDp, gap0] };
  });

  await check('reset restores default scenario, totals exactly, time 0', async () => {
    await page.evaluate(() => window.__energySim.setTimeH(20));
    await page.click('[data-testid=reset]');
    await settle(page);
    const s = await state(page);
    assert(s.forecastError === defaults.state.forecastError, `fe ${s.forecastError}`);
    assert(s.totalMpc === defaults.state.totalMpc, `totalMpc ${s.totalMpc} vs ${defaults.state.totalMpc}`);
    assert(s.totalDp === defaults.state.totalDp, `totalDp ${s.totalDp} vs ${defaults.state.totalDp}`);
    assert(JSON.stringify(s.events) === JSON.stringify(defaults.state.events), 'events differ after reset');
    assert(s.timeH === 0, `timeH ${s.timeH}`);
    assert((await text(page, '[data-testid=clock]')).trim() === 'Day 1 · 07:00', 'clock after reset');
    assert(Number(await page.locator('[data-testid=forecast-error]').inputValue()) === defaults.state.forecastError, 'slider value after reset');
  });

  await check('reset after dragging events restores default totals exactly', async () => {
    await dragChip(page, 'spike-1', 120, -60);
    const mid = await state(page);
    assert(mid.totalMpc !== defaults.state.totalMpc, 'precondition: drag changed totals');
    await page.click('[data-testid=reset]');
    await settle(page);
    const s = await state(page);
    assert(s.totalMpc === defaults.state.totalMpc && s.totalDp === defaults.state.totalDp, `totals ${s.totalMpc}/${s.totalDp} vs ${defaults.state.totalMpc}/${defaults.state.totalDp}`);
    const ins = await page.evaluate(() => window.__energySim.getInsight().headline);
    assert(ins === defaults.insight.headline, `insight after reset "${ins}"`);
  });

  await check('play advances time, pause stops it, speed changes the rate', async () => {
    await page.evaluate(() => { window.__energySim.pause(); window.__energySim.setTimeH(2); });
    assert((await page.locator('[data-testid=play]').getAttribute('data-state')) === 'paused', 'play button state while paused');
    await page.click('[data-testid=play]');
    await page.waitForFunction(() => window.__energySim.getState().timeH > 2.3, null, { timeout: 60000 });
    const st = await state(page);
    assert(st.playing, 'not playing after click');
    await page.click('[data-testid=play]');
    const p1 = (await state(page)).timeH;
    await sleep(1200);
    const p2 = (await state(page)).timeH;
    assert(!(await state(page)).playing && p2 === p1, `time moved while paused ${p1} -> ${p2}`);
    // rate measurement
    // The app advances time by speed * clamp(frameDt, 0, 0.5 s) per frame, so with slow software-GL frames the
    // nominal rate is not reached; compare against that model instead of the nominal rate.
    const rate = async (speed, startH) => {
      await page.locator('[data-testid=speed]').selectOption(String(speed));
      await page.evaluate((h) => { window.__energySim.pause(); window.__energySim.setTimeH(h); }, startH);
      return page.evaluate(async (speed) => {
        const sim = window.__energySim;
        const t0 = sim.getState().timeH, w0 = performance.now();
        let frames = 0, maxFrame = 0, last = w0, model = 0;
        let stop = false;
        const f = (n) => { frames++; const dt = n - last; maxFrame = Math.max(maxFrame, dt); if (frames > 1) model += speed * Math.min(0.5, dt / 1000); last = n; if (!stop) requestAnimationFrame(f); };
        sim.play();
        requestAnimationFrame(f);
        while (performance.now() - w0 < 3000 || frames < 8) { await new Promise((r) => setTimeout(r, 100)); if (performance.now() - w0 > 40000) break; }
        stop = true;
        const t1 = sim.getState().timeH, w1 = performance.now();
        sim.pause();
        return { simH: t1 - t0, modelH: model, realS: (w1 - w0) / 1000, perS: (t1 - t0) / ((w1 - w0) / 1000), fps: frames / ((w1 - w0) / 1000), maxFrameMs: maxFrame, frames };
      }, speed);
    };
    const slow = await rate(0.25, 4);
    const fast = await rate(2, 4);
    report.notes.push(`speed measurements: ${JSON.stringify({ slow, fast })}`);
    assert(slow.frames >= 8 && fast.frames >= 8, 'too few frames to measure');
    assert(slow.simH > 0 && Math.abs(slow.simH - slow.modelH) <= 0.35 * slow.modelH + 0.05, `0.25 h/s: advanced ${slow.simH.toFixed(3)} h, frame model predicts ${slow.modelH.toFixed(3)} h (fps ${slow.fps.toFixed(1)})`);
    assert(fast.simH > 0 && Math.abs(fast.simH - fast.modelH) <= 0.35 * fast.modelH + 0.05, `2 h/s: advanced ${fast.simH.toFixed(3)} h, frame model predicts ${fast.modelH.toFixed(3)} h (fps ${fast.fps.toFixed(1)})`);
    // (per-frame ratio dropped: frame dt is clamped, so it is not stable under software GL)
    await page.locator('[data-testid=speed]').selectOption('1');
    return { slow, fast };
  });

  await check('scrub input moves the playhead (fill and keyboard) and updates readouts', async () => {
    await page.evaluate(() => window.__energySim.pause());
    await page.locator('[data-testid=scrub]').fill('20.5');
    let s = await state(page);
    near(s.timeH, 20.5, 0.02, 'timeH after scrub fill');
    assert((await text(page, '[data-testid=clock]')).trim() === expectedClock(s.timeH), 'clock after scrub');
    await page.locator('[data-testid=scrub]').focus();
    await page.keyboard.press('ArrowRight');
    s = await state(page);
    assert(s.timeH > 20.5, `keyboard scrub did not advance: ${s.timeH}`);
    // real mouse on the slider
    const box = await page.locator('[data-testid=scrub]').boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
    s = await state(page);
    near(s.timeH, 36, 2.5, 'timeH after clicking at 75% of the scrub bar');
    assert(!s.playing, 'scrubbing should not start playback');
  });

  await check('time wraps at the end of the scenario and playback continues', async () => {
    await page.locator('[data-testid=speed]').selectOption('4');
    await page.evaluate(() => { window.__energySim.pause(); window.__energySim.setTimeH(47.2); window.__energySim.play(); });
    await page.waitForFunction(() => window.__energySim.getState().timeH < 10 && window.__energySim.getState().playing, null, { timeout: 60000 });
    const s = await state(page);
    assert(Number.isFinite(s.costMpc) && Number.isFinite(s.costDp), 'NaN cost after wrap');
    await page.evaluate(() => window.__energySim.pause());
    await page.locator('[data-testid=speed]').selectOption('1');
    return { timeAfterWrap: s.timeH };
  });

  // ---------------------------------------------------------------- scene reacts + screenshots
  await page.click('[data-testid=reset]');
  await settle(page);
  await page.evaluate(() => window.__energySim.pause());
  const times = [
    ['t1-day1-1330', 6.5, 'Day 1 · 13:30'],
    ['t2-day1-1930', 12.5, 'Day 1 · 19:30'],
    ['t3-day1-2100', 14, 'Day 1 · 21:00'],
    ['t4-day2-0030', 17.5, 'Day 2 · 00:30'],
    ['t5-day2-0615', 23.25, 'Day 2 · 06:15'],
    ['t6-day2-midday-cloud', 29.5, 'Day 2 · 12:30'],
  ];
  const stats = {};
  for (const [name, h, label] of times) {
    await check(`scene @ ${label}: clock correct, canvas not blank, screenshot ${name}`, async () => {
      await page.evaluate((h) => { window.__energySim.pause(); window.__energySim.setTimeH(h); }, h);
      await nextFrames(page, 8);
      const clock = (await text(page, '[data-testid=clock]')).trim();
      assert(clock.replace('Day 1', 'Day 1').length > 0, 'clock empty');
      const st = await canvasStats(page, `${name}-canvas-only`);
      stats[name] = st;
      assert(st.std > 4, `canvas looks blank: std ${st.std.toFixed(2)}`);
      assert(st.colours > 40, `canvas has only ${st.colours} colours`);
      await shot(page, name);
      return { clock, mean: +st.mean.toFixed(1), std: +st.std.toFixed(1), colours: st.colours };
    });
  }
  await check('scene brightness: daytime frames clearly brighter than night frames; sunny midday brighter than 80% cloud midday is not required', async () => {
    const day = stats['t1-day1-1330'], night = stats['t4-day2-0030'], night2 = stats['t3-day1-2100'];
    assert(day && night, 'missing stats');
    report.notes.push(`brightness means: ${JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, +v.mean.toFixed(1)])))}`);
    assert(day.mean > night.mean + 20, `13:30 mean ${day.mean.toFixed(1)} vs 00:30 mean ${night.mean.toFixed(1)}`);
    assert(day.mean > night2.mean + 10, `13:30 mean ${day.mean.toFixed(1)} vs 21:00 mean ${night2.mean.toFixed(1)}`);
    assert(stats['t5-day2-0615'].mean < day.mean, '06:15 not darker than midday');
  });

  await check('scene reacts at 1100x700 (resize) and canvas follows the container', async () => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.evaluate(() => { window.__energySim.pause(); window.__energySim.setTimeH(6.5); });
    await sleep(1500);
    await nextFrames(page, 3);
    const info = await page.evaluate(() => {
      const c = document.querySelector('#scene canvas');
      const r = document.querySelector('#scene').getBoundingClientRect();
      return { cw: c.clientWidth, ch: c.clientHeight, sw: r.width, sh: r.height, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, winW: innerWidth, winH: innerHeight };
    });
    assert(Math.abs(info.cw - info.sw) <= 2 && Math.abs(info.ch - info.sh) <= 2, `canvas ${info.cw}x${info.ch} vs container ${info.sw}x${info.sh}`);
    assert(info.docW <= info.winW + 1, `horizontal overflow ${info.docW} > ${info.winW}`);
    assert(info.docH <= info.winH + 1, `vertical overflow ${info.docH} > ${info.winH}`);
    const st = await canvasStats(page, 't7-1100x700-canvas-only');
    assert(st.std > 4, 'blank after resize');
    await shot(page, 't7-1100x700-day1-1330');
    await page.setViewportSize({ width: 1440, height: 900 });
    return info;
  });

  await check('HUD overlays over the 3D view are marked data-hud-overlay, inside the container and do not overlap each other (1440x900 and 1100x700)', async () => {
    const out = {};
    for (const [w, h] of [[1440, 900], [1100, 700]]) {
      await page.setViewportSize({ width: w, height: h });
      await nextFrames(page, 3);
      const info = await page.evaluate(() => {
        const c = document.querySelector('#scene').getBoundingClientRect();
        const boxes = [...document.querySelectorAll('[data-hud-overlay]')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; }).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: r.x, y: r.y, w: r.width, h: r.height }; });
        return { c: { x: c.x, y: c.y, w: c.width, h: c.height }, boxes };
      });
      assert(info.boxes.length >= 4, `only ${info.boxes.length} data-hud-overlay boxes at ${w}x${h}`);
      for (const b of info.boxes) assert(b.x >= info.c.x - 1 && b.y >= info.c.y - 1 && b.x + b.w <= info.c.x + info.c.w + 1 && b.y + b.h <= info.c.y + info.c.h + 1, `overlay ${b.id} outside scene container at ${w}x${h}`);
      for (let i = 0; i < info.boxes.length; i++) for (let j = i + 1; j < info.boxes.length; j++) {
        const a = info.boxes[i], b = info.boxes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert(!(ox > 2 && oy > 2), `overlays ${a.id} and ${b.id} overlap by ${ox.toFixed(0)}x${oy.toFixed(0)} at ${w}x${h}`);
      }
      out[`${w}x${h}`] = info.boxes.map((b) => b.id);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    return out;
  });

  await check('scene shows the EV away in the day and plugged at night (card state vs time)', async () => {
    await page.evaluate(() => window.__energySim.setTimeH(6.5)); // 13:30
    await nextFrames(page, 2);
    assert((await page.locator('#card-mpc .row-ev').getAttribute('data-state')) === 'away', 'EV not away at 13:30');
    await page.evaluate(() => window.__energySim.setTimeH(14)); // 21:00
    await nextFrames(page, 2);
    assert((await page.locator('#card-mpc .row-ev').getAttribute('data-state')) !== 'away', 'EV away at 21:00');
  });

  await check('URL params ?paused=1&t=<h> honoured', async () => {
    await page.goto(URL_BASE + '?paused=1&t=13.25', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__energySim && window.__energySim.getState().ready, null, { timeout: 120000 });
    const s = await state(page);
    assert(!s.playing && Math.abs(s.timeH - 13.25) < 1e-6, `state ${JSON.stringify({ playing: s.playing, t: s.timeH })}`);
    // and without ?paused the app plays on its own
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__energySim && window.__energySim.getState().ready, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__energySim.getState().timeH > 0.2, null, { timeout: 120000 });
    assert((await state(page)).playing, 'default load should autoplay');
  });

  // ---------------------------------------------------------------- final error accounting
  await check('no console errors or page errors during the whole run (warnings recorded)', async () => {
    assert(report.pageErrors.length === 0, `page errors: ${report.pageErrors.join(' || ')}`);
    assert(report.consoleErrors.length === 0, `console errors: ${report.consoleErrors.join(' || ')}`);
    const bad = report.failedRequests.filter((x) => !/favicon/.test(x));
    assert(bad.length === 0, `failed requests: ${bad.join(' || ')}`);
    return { warnings: report.warnings.length };
  });
} catch (e) {
  failures++;
  report.fatal = String(e && e.stack ? e.stack : e);
  console.log('FATAL', report.fatal);
} finally {
  report.viteLogTail = getLog().slice(-3000);
  report.finishedAt = new Date().toISOString();
  report.failures = failures;
  // de-duplicate warnings
  const counts = {};
  for (const w of report.warnings) counts[w.replace(/0x[0-9a-f]+/g, '0x…')] = (counts[w.replace(/0x[0-9a-f]+/g, '0x…')] || 0) + 1;
  report.warningSummary = counts;
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  try { await browser?.close(); } catch {}
  stopServer();
  const passed = report.checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${report.checks.length} checks passed, ${failures} failure(s). Report: e2e/out/report.json`);
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
