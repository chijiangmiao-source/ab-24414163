import { useEffect, useMemo, useRef, useState } from 'react';
import { useReplayWorker } from './useReplayWorker';
import { ReplayViewer } from './ReplayViewer';
import { SAMPLE_INPUT, SAMPLE_INVALID } from '../sample';
import type { ReplayInput, ValidationIssue } from '../core/types';

type ParseState =
  | { ok: true; input: ReplayInput }
  | { ok: false; error: string };

const CODE_LABEL: Record<ValidationIssue['code'], string> = {
  TERMINAL_ID_CONFLICT: '终端标识冲突',
  TERMINAL_ID_INVALID: '终端标识非法',
  DOT_REUSE_PAYLOAD_MISMATCH: '点标识复用且载荷冲突',
  DOT_COUNTER_INVALID: '点计数器非法',
  DOT_ORIGIN_MISMATCH: '点来源不匹配',
  DUP_DOT_IN_SCRIPT: '脚本中点重复定义',
  CONTEXT_INVALID: '非法因果上下文',
  UNKNOWN_MESSAGE_KEY: '收件箱引用未知消息',
  DELIVERY_NODE_UNKNOWN: '投递计划终端未知/缺失',
  BAD_SCRIPT_SHAPE: '脚本结构非法',
  REMOVE_CONTEXT_REQUIRED: '撤销缺少上下文',
  TAG_EMPTY: '标签为空'
};

export function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLE_INPUT, null, 2));
  const [parse, setParse] = useState<ParseState | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const { status, error, validation, result, validateOnly, replay, reset } = useReplayWorker();
  const pendingReplay = useRef(false);

  // 实时解析（仅语法/形状，严格规则在 Worker 中执行）
  useEffect(() => {
    try {
      const obj = JSON.parse(text) as ReplayInput;
      setParse({ ok: true, input: obj });
      setIssues(null);
    } catch (e) {
      setParse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [text]);

  // 编辑内容即清除旧回放，避免展示与输入不一致的陈旧结果；同时取消待执行回放
  useEffect(() => {
    pendingReplay.current = false;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // 先校验，通过后自动回放；失败则清除旧回放并定位问题
  useEffect(() => {
    if (!validation) return;
    if (validation.ok && pendingReplay.current && parse?.ok) {
      pendingReplay.current = false;
      replay(parse.input);
    } else if (!validation.ok) {
      pendingReplay.current = false;
      setIssues(validation.issues);
    }
  }, [validation, parse, replay]);

  const handleValidate = () => {
    if (!parse?.ok) return;
    pendingReplay.current = false;
    setIssues(null);
    validateOnly(parse.input);
  };

  const handleReplay = () => {
    if (!parse?.ok) return;
    pendingReplay.current = true;
    setIssues(null);
    validateOnly(parse.input);
  };

  const busy = status === 'busy';
  const termCount = useMemo(
    () => (parse?.ok ? parse.input.terminals?.length ?? 0 : null),
    [parse]
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>野外无人机编队 · 禁飞标签 OR-Set 因果收敛回放</h1>
        <p className="subtitle">
          点集（dot set）+ 因果上下文（版本向量）实现 observed-remove 归并 ·
          缺前序暂存释放 · 重复投递幂等
        </p>
      </header>

      <div className="layout">
        <section className="panel editor-panel">
          <div className="panel-head">
            <h2>① 导入脚本与收件顺序（2–4 个终端）</h2>
            <div className="btn-row">
              <button onClick={() => setText(JSON.stringify(SAMPLE_INPUT, null, 2))}>
                载入合法示例
              </button>
              <button
                className="ghost"
                onClick={() => setText(JSON.stringify(SAMPLE_INVALID, null, 2))}
              >
                载入非法示例
              </button>
            </div>
          </div>
          <textarea
            className="editor"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="panel-foot">
            <span className={parse?.ok ? 'ok-text' : 'err-text'}>
              {parse === null
                ? ''
                : parse.ok
                  ? `JSON 语法正确 · 终端数 ${termCount}`
                  : `JSON 解析失败：${parse.error}`}
            </span>
            <div className="btn-row">
              <button disabled={!parse?.ok || busy} onClick={handleValidate}>
                仅校验
              </button>
              <button
                className="primary"
                disabled={!parse?.ok || busy}
                onClick={handleReplay}
              >
                {busy ? 'Worker 计算中…' : '启动回放'}
              </button>
            </div>
          </div>

          {error && <div className="alert err">Worker 错误：{error}</div>}

          {issues && issues.length > 0 && (
            <div className="issues">
              <h3>校验拒绝（{issues.length} 项）— 已清除旧回放，定位如下：</h3>
              <ul>
                {issues.map((it, i) => (
                  <li key={i}>
                    <span className={`badge badge-${it.severity}`}>
                      {CODE_LABEL[it.code]}
                    </span>
                    <span>{it.message}</span>
                    <span className="loc">
                      {[
                        it.terminal ? `终端 ${it.terminal}` : null,
                        it.opIndex !== undefined ? `第 ${it.opIndex + 1} 条操作` : null,
                        it.dot ? `点 ${it.dot}` : null,
                        it.scheduleIndex !== undefined ? `收件箱第 ${it.scheduleIndex + 1} 项` : null
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {validation?.ok && (
            <div className="alert ok">校验通过：点标识唯一、上下文合法、收件箱均可解析。</div>
          )}

          <details className="help">
            <summary>脚本格式说明</summary>
            <pre>{FORMAT_HELP}</pre>
          </details>
        </section>

        <section className="panel viewer-panel">
          <h2>② 逐终端回放与因果依据</h2>
          {result ? (
            <ReplayViewer result={result} />
          ) : (
            <div className="placeholder">
              导入 2–4 个终端的操作脚本与各自收件顺序，点击「启动回放」。
              <br />
              回放后可按终端逐步查看：有效标签、版本向量、待处理消息、点云与每步因果依据。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const FORMAT_HELP = `{
  "terminals": [
    {
      "id": "A",
      "operations": [
        { "type": "add",    "tag": "NFZ-ALPHA", "dot": "A:1" },
        { "type": "remove", "tag": "撤销批次1",  "dot": "A:2",
          "context": { "A": 1 } }   // 撤销必须携带产生时已见上下文
      ]
    }
  ],
  "deliveries": [
    { "node": "A", "inbox": ["A:1", "A:2"] }  // 该终端收件顺序；重复键=重复投递
  ]
}
规则：点 "终端:n" 在该终端脚本内从 1 严格递增且全局唯一；
撤销只清除 context 覆盖到的已观察点，未见过的并发新增不会被删除；
缺因果前序的消息暂存，依赖补齐后自动释放。`;
