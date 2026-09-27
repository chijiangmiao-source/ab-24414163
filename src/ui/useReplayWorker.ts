import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReplayInput,
  TerminalTrace,
  ValidationResult,
  WorkerResponse
} from '../core/types';
import ReplayWorker from '../worker/replay.worker.ts?worker';

export type WorkerStatus = 'idle' | 'busy' | 'done' | 'error';

export interface ReplayResult {
  traces: TerminalTrace[];
  converged: boolean;
  consensusTags: string[];
}

/** 计算放入 Web Worker：校验与全量回放均不在主线程执行 */
export function useReplayWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<WorkerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const ensure = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new ReplayWorker();
      workerRef.current.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.kind === 'validated') {
          setValidation(msg.result);
          setStatus('done');
        } else if (msg.kind === 'replayed') {
          setResult({
            traces: msg.traces,
            converged: msg.converged,
            consensusTags: msg.consensusTags
          });
          setStatus('done');
        } else {
          setError(msg.message);
          setStatus('error');
        }
      };
      workerRef.current.onerror = (e) => {
        setError(e.message || 'Worker 发生未知错误');
        setStatus('error');
      };
    }
    return workerRef.current;
  }, []);

  const validateOnly = useCallback(
    (input: ReplayInput) => {
      setStatus('busy');
      setError(null);
      setValidation(null);
      ensure().postMessage({ kind: 'validate', input });
    },
    [ensure]
  );

  const replay = useCallback(
    (input: ReplayInput) => {
      setStatus('busy');
      setError(null);
      setResult(null);
      ensure().postMessage({ kind: 'replay', input });
    },
    [ensure]
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setValidation(null);
    setResult(null);
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return { status, error, validation, result, validateOnly, replay, reset };
}
