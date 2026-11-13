/**
 * DEV-ONLY fake of src/sim/worker.ts (used only with ?mock=1). Runs on the main
 * thread with artificial delays and speaks the exact worker protocol.
 */
import type { Scenario, ScenarioEvent, SimConfig, WorkerRequest, WorkerResponse } from '../../shared/types';
import type { WorkerLike } from '../backend';
import { mockInsight, mockSolve } from './mockSim';

export function createMockWorker(
  build?: (config: SimConfig, events: ScenarioEvent[]) => Scenario,
): WorkerLike {
  let dead = false;
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: WorkerRequest) {
      const emit = (r: WorkerResponse, delay: number) =>
        setTimeout(() => {
          if (!dead) w.onmessage?.(r);
        }, delay);
      if (msg.type === 'init') {
        emit({ type: 'ready', solver: 'mock heuristic (no LP)', initMs: 700 }, 700);
        return;
      }
      setTimeout(() => {
        if (dead) return;
        try {
          const result = mockSolve(msg.reqId, msg.config, msg.events, build);
          w.onmessage?.({ type: 'solved', result });
          if (msg.wantInsight) emit({ type: 'insight', insight: mockInsight(msg.reqId, result.scenario, result.dp) }, 25);
        } catch (e) {
          w.onmessage?.({ type: 'error', reqId: msg.reqId, message: String(e) });
        }
      }, 45);
    },
    terminate() {
      dead = true;
    },
  };
  return w;
}
