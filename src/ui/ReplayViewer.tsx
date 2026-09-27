import { useState } from 'react';
import type { ReplayResult } from './useReplayWorker';
import type { CausalEvidence, TerminalTrace } from '../core/types';

const KIND_LABEL: Record<CausalEvidence['kind'], string> = {
  'applied-add': '应用新增',
  'applied-remove': '应用撤销',
  buffered: '暂存（缺前序）',
  duplicate: '重复投递 · 幂等',
  'buffer-released': '缓冲释放',
  'noop-remove': '撤销空操作'
};

export function ReplayViewer({ result }: { result: ReplayResult }) {
  const { traces, converged, consensusTags } = result;
  const [nodeIdx, setNodeIdx] = useState(0);
  const trace: TerminalTrace = traces[Math.min(nodeIdx, traces.length - 1)];
  const [stepIdx, setStepIdx] = useState(0);

  const safeStep = Math.min(stepIdx, Math.max(trace.steps.length - 1, 0));
  const step = trace.steps[safeStep];

  const nodeTab = (i: number) => {
    setNodeIdx(i);
    setStepIdx(0);
  };

  return (
    <div className="viewer">
      <div className={`converge ${converged ? 'ok' : 'bad'}`}>
        {converged ? (
          <>
            <strong>✓ 各终端已收敛</strong>
            <span className="tag-set">
              共识有效标签：
              {consensusTags.length === 0 ? '（空集）' : consensusTags.join('、')}
            </span>
          </>
        ) : (
          <>
            <strong>✗ 尚未收敛</strong>
            <span>各终端有效标签集合不一致（可能仍有待处理消息）。</span>
          </>
        )}
      </div>

      <div className="tabs">
        {traces.map((t, i) => (
          <button
            key={t.node}
            className={`tab ${i === nodeIdx ? 'active' : ''}`}
            onClick={() => nodeTab(i)}
          >
            终端 {t.node}
            {t.final.pending.length > 0 && (
              <em className="pend-dot" title="最终仍有待处理消息">
                {t.final.pending.length}
              </em>
            )}
          </button>
        ))}
      </div>

      <div className="step-controls">
        <button disabled={safeStep === 0} onClick={() => setStepIdx(safeStep - 1)}>
          ← 上一步
        </button>
        <span className="step-pos">
          第 {safeStep + 1} / {trace.steps.length} 次投递
        </span>
        <button
          disabled={safeStep >= trace.steps.length - 1}
          onClick={() => setStepIdx(safeStep + 1)}
        >
          下一步 →
        </button>
        <button className="ghost" onClick={() => setStepIdx(trace.steps.length - 1)}>
          跳到末尾
        </button>
      </div>

      {step && (
        <>
          <div className="delivery-line">
            尝试投递消息 <code>{step.messageKey}</code>
          </div>

          <div className="evidence-list">
            {step.evidence.map((ev, i) => (
              <div key={i} className={`evidence ev-${ev.kind}`}>
                <span className="ev-kind">{KIND_LABEL[ev.kind]}</span>
                <span className="ev-summary">{ev.summary}</span>
                {ev.missing && ev.missing.length > 0 && (
                  <span className="ev-missing">尚缺前序：{ev.missing.join(', ')}</span>
                )}
                {ev.affectedDots && ev.affectedDots.length > 0 && (
                  <span className="ev-affected">影响点：{ev.affectedDots.join(', ')}</span>
                )}
              </div>
            ))}
          </div>

          <div className="state-grid">
            <StateCard title="有效标签">
              <TagList tags={step.activeTags} />
            </StateCard>
            <StateCard title="版本向量（压缩点云前缀）">
              <VVView vv={step.versionVector} origins={originsOf(traces)} />
            </StateCard>
            <StateCard title={`待处理消息（${step.pending.length}）`}>
              {step.pending.length === 0 ? (
                <em className="muted">无</em>
              ) : (
                <ul className="dotlist">
                  {step.pending.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </StateCard>
            <StateCard title={`点云（已见 ${step.cloud.length} 点）`}>
              <ul className="dotlist compact">
                {step.cloud.map((d) => (
                  <li key={d} className={step.liveDots[d] ? 'live' : 'dead'}>
                    {d}
                    {step.liveDots[d] ? ` → ${step.liveDots[d]}` : '（已撤）'}
                  </li>
                ))}
              </ul>
            </StateCard>
          </div>
        </>
      )}

      <FinalSummary trace={trace} />
    </div>
  );
}

function StateCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="state-card">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <em className="muted">空集</em>;
  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </div>
  );
}

function VVView({ vv, origins }: { vv: Record<string, number>; origins: string[] }) {
  return (
    <div className="vv">
      {origins.map((o) => (
        <span key={o} className="vv-item">
          {o}: <strong>{vv[o] ?? 0}</strong>
        </span>
      ))}
    </div>
  );
}

function FinalSummary({ trace }: { trace: TerminalTrace }) {
  return (
    <details className="final-summary">
      <summary>终端 {trace.node} 最终状态</summary>
      <ul>
        <li>有效标签：{trace.final.activeTags.join('、') || '（空集）'}</li>
        <li>版本向量：{JSON.stringify(trace.final.versionVector)}</li>
        <li>
          待处理消息：
          {trace.final.pending.length === 0 ? '无' : trace.final.pending.join(', ')}
        </li>
        <li>存活点：{Object.keys(trace.final.liveDots).join(', ') || '无'}</li>
      </ul>
    </details>
  );
}

function originsOf(traces: TerminalTrace[]): string[] {
  const s = new Set<string>();
  for (const t of traces) for (const k of Object.keys(t.final.versionVector)) s.add(k);
  return [...s].sort();
}
