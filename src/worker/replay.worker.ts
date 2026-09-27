import { runReplay, checkConvergence } from '../core/replay';
import { validate } from '../core/validate';
import type { ReplayInput, WorkerRequest, WorkerResponse } from '../core/types';

/** 结构化的 Worker 全局（避免 DOM / WebWorker lib 中 self 类型冲突） */
interface WorkerGlobal {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const worker = globalThis as unknown as WorkerGlobal;

worker.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.kind === 'validate') {
      const result = validate(req.input);
      worker.postMessage({ kind: 'validated', result });
      return;
    }
    if (req.kind === 'replay') {
      const result = validate(req.input);
      if (!result.ok) {
        worker.postMessage({ kind: 'error', message: '输入未通过校验，拒绝回放。' });
        return;
      }
      const traces = runReplay(req.input as ReplayInput);
      const { converged, consensusTags } = checkConvergence(traces);
      worker.postMessage({ kind: 'replayed', traces, converged, consensusTags });
      return;
    }
  } catch (err) {
    worker.postMessage({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err)
    });
  }
};
