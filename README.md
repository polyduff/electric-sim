# Home Energy Lab

Interactive 3D simulator of a Christchurch house with 6 kW solar, a 13.5 kWh battery, an EV and a grid connection. Two policies run live on one 48-hour scenario: a rolling-horizon MPC (LP via HiGHS, noisy forecasts) and a dynamic-programming benchmark with perfect hindsight.

## Run

```bash
npm install && npm run dev
```

```bash
npm test
```

`npm run e2e` drives the app in headless Chromium (needs Playwright, not a dependency). Drag timeline chips to move price spikes and clouds; drag vertically to resize.

## Headline numbers (default scenario, from my runs)

- 48 h cost: MPC $14.68, DP $14.32, gap +$0.36 (2.5%) at 50% forecast error; $0.00 at 0%, +$0.45 at 100%.
- Arbitrage: pays $0.22/day, only by shifting cheap imports into dearer hours; buying to re-export never pays (best spread −2.4 c/kWh). A 1.5 $/kWh evening spike flips it: $1.18/day, 10.4 kWh re-exported.
- Re-solve while dragging: worker median 112 ms (DP 61, 96 LPs 50); round trip 114 ms. Headless Chromium, 4-core VM.
- 80 tests, 26 end-to-end checks pass.

## Choices made

30-minute steps from 07:00 on 12 November. EV away 07:00–18:00, lossless charging. Battery must end at or above its 50% start. Forecast skill decays with lead time. Prices and load are synthetic, not real tariffs. Playback loops.

## Known limitations

- The DP is discretised: within $0.005 of the exact optimum on default hardware, up to $0.06 off on unusual configurations, so the MPC can appear marginally cheaper.
- Under software WebGL the drag round trip was 464 ms (rendering blocked the main thread). Real-GPU frame rate was never measured.
- The default camera faces south, so the sun disc is behind it; orbit to see it.

## How the work was delegated

The lead wrote `docs/spec.md` and shared types, then ran subagents in parallel. The first three hit a usage limit; cheaper-model agents continued from their files.

1. **Simulator**: seeded generators, forecasts, MPC, DP, arbitrage insight, Web Worker.
2. **Scene**: houses, flows, day/night, clouds, camera fit.
3. **UI**: draggable timeline, controls, HUD, worker wiring.
4. **Verifier**: property tests, headless drag run, screenshot review.

Verifier-caught bugs, all fixed: DP up to 3 c worse than optimal; arbitrage sentence counted stored solar as re-export; HUD cards and scene tags disagreed by up to 2×; wrong day after midnight; latency readout showed a cached request.
