import { isValidVV } from './dotcloud';
import type {
  ReplayInput,
  ScriptOperation,
  TerminalScript,
  ValidationIssue,
  ValidationResult
} from './types';

interface ParsedOp {
  terminal: string;
  opIndex: number;
  op: ScriptOperation;
  origin: string;
  counter: number;
}

/**
 * 导入校验。任何错误都须精确定位（终端 / 操作下标 / 点 / 投递下标），
 * UI 在校验失败时清除旧回放，绝不带错运行。
 */
export function validate(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, issues: [issue('BAD_SCRIPT_SHAPE', '导入内容必须是 JSON 对象。')] };
  }
  const doc = input as Partial<ReplayInput>;
  if (!Array.isArray(doc.terminals)) {
    issues.push(issue('BAD_SCRIPT_SHAPE', '缺少 terminals 数组。'));
    return { ok: false, issues };
  }
  if (!Array.isArray(doc.deliveries)) {
    issues.push(issue('BAD_SCRIPT_SHAPE', '缺少 deliveries 数组。'));
    return { ok: false, issues };
  }

  const terminals = doc.terminals;
  if (terminals.length < 2 || terminals.length > 4) {
    issues.push(
      issue('BAD_SCRIPT_SHAPE', `终端数量必须为 2 至 4 个，当前为 ${terminals.length} 个。`)
    );
  }

  // ---- 第一遍：终端标识 + 点收集 ----
  const nodeIds = new Set<string>();
  for (const t of terminals) {
    if (typeof t !== 'object' || t === null || typeof (t as TerminalScript).id !== 'string') {
      issues.push(issue('TERMINAL_ID_INVALID', '终端必须为带字符串 id 的对象。'));
      continue;
    }
    const id = (t as TerminalScript).id.trim();
    if (id === '') {
      issues.push(issue('TERMINAL_ID_INVALID', '存在空终端标识。'));
    } else if (nodeIds.has(id)) {
      issues.push(
        issue('TERMINAL_ID_CONFLICT', `终端标识「${id}」重复，多个终端不得共用标识。`, {
          terminal: id
        })
      );
    } else {
      nodeIds.add(id);
    }
  }

  /** 全局存在的点集合（origin -> 最大计数器；每终端计数器连续） */
  const globalMax: Record<string, number> = {};
  /** 每个终端自己的点序列（用于严格递增检查） */
  const byTerminal: ParsedOp[][] = [];
  /** 点键 -> 首次定义处（复用检测） */
  const dotFirst = new Map<string, ParsedOp>();

  terminals.forEach((t) => {
    const parsed: ParsedOp[] = [];
    if (typeof t !== 'object' || t === null) {
      byTerminal.push(parsed);
      return;
    }
    const term = t as TerminalScript;
    const nodeId = typeof term.id === 'string' ? term.id.trim() : '';
    if (!Array.isArray(term.operations)) {
      issues.push(
        issue('BAD_SCRIPT_SHAPE', '终端脚本缺少 operations 数组。', { terminal: nodeId })
      );
      byTerminal.push(parsed);
      return;
    }

    term.operations.forEach((op, idx) => {
      const base = { terminal: nodeId, opIndex: idx };
      if (typeof op !== 'object' || op === null) {
        issues.push(issue('BAD_SCRIPT_SHAPE', '操作必须为对象。', base));
        return;
      }
      if (op.type !== 'add' && op.type !== 'remove') {
        issues.push(
          issue('BAD_SCRIPT_SHAPE', `非法操作类型「${String(op.type)}」，只允许 add/remove。`, {
            ...base,
            dot: op.dot
          })
        );
      }
      if (typeof op.tag !== 'string' || op.tag.trim() === '') {
        issues.push(issue('TAG_EMPTY', '标签载荷不能为空。', { ...base, dot: op.dot }));
      }

      const p = parseDotKey(op.dot);
      if (!p) {
        issues.push(
          issue('DOT_COUNTER_INVALID', `点标识「${String(op.dot)}」非法，应为「终端:正整数」。`, {
            ...base,
            dot: op.dot
          })
        );
        return;
      }

      if (nodeId && p.origin !== nodeId) {
        issues.push(
          issue(
            'DOT_ORIGIN_MISMATCH',
            `点标识「${op.dot}」的 origin 与所在终端「${nodeId}」不一致，终端只能产生自己的点。`,
            { ...base, dot: op.dot }
          )
        );
      }

      parsed.push({ terminal: nodeId, opIndex: idx, op, origin: p.origin, counter: p.counter });
      globalMax[p.origin] = Math.max(globalMax[p.origin] ?? 0, p.counter);
    });
    byTerminal.push(parsed);
  });

  // ---- 第二遍：序列连续、上下文、点复用 ----
  byTerminal.forEach((parsed) => {
    let expected = 1;
    for (const po of parsed) {
      const { op, origin, counter, terminal: nodeId, opIndex: idx } = po;
      const base = { terminal: nodeId, opIndex: idx };

      if (counter !== expected) {
        issues.push(
          issue(
            'DOT_COUNTER_INVALID',
            `终端「${nodeId}」第 ${idx + 1} 条操作的点计数器应为 ${expected}（严格递增、从 1 开始、不得复用），实际为 ${counter}。`,
            { ...base, dot: op.dot }
          )
        );
      }
      // 即使不连续也继续推进，尽量报出更多问题
      expected = counter + 1;

      if (op.type === 'remove') {
        if (op.context === undefined || op.context === null) {
          issues.push(
            issue('REMOVE_CONTEXT_REQUIRED', '撤销操作必须携带产生时已见上下文 context（版本向量）。', {
              ...base,
              dot: op.dot
            })
          );
        } else if (!isValidVV(op.context)) {
          issues.push(
            issue('CONTEXT_INVALID', '撤销上下文必须是 {终端: 非负整数} 形式的版本向量。', {
              ...base,
              dot: op.dot
            })
          );
        } else {
          for (const [k, v] of Object.entries(op.context)) {
            if (!nodeIds.has(k)) {
              issues.push(
                issue('CONTEXT_INVALID', `撤销上下文引用了不存在的终端「${k}」。`, {
                  ...base,
                  dot: op.dot
                })
              );
            } else if (v > (globalMax[k] ?? 0)) {
              issues.push(
                issue(
                  'CONTEXT_INVALID',
                  `撤销上下文声称已见 ${k}:${v}，但该点在全部脚本中不存在（非法因果上下文）。`,
                  { ...base, dot: op.dot }
                )
              );
            }
          }
          const self = op.context[origin] ?? 0;
          if (self >= counter) {
            issues.push(
              issue(
                'CONTEXT_INVALID',
                `撤销 ${op.dot} 的上下文包含其自身或未来点（${origin}:${counter}），产生时不可能已见。`,
                { ...base, dot: op.dot }
              )
            );
          }
        }
      } else if (op.context !== undefined && !isValidVV(op.context)) {
        issues.push(
          issue('CONTEXT_INVALID', '新增操作携带的 context 形状非法。', { ...base, dot: op.dot })
        );
      }

      const prev = dotFirst.get(op.dot);
      if (prev) {
        const samePayload =
          prev.op.type === op.type &&
          prev.op.tag === op.tag &&
          JSON.stringify(prev.op.context ?? {}) === JSON.stringify(op.context ?? {});
        if (!samePayload) {
          issues.push(
            issue(
              'DOT_REUSE_PAYLOAD_MISMATCH',
              `点标识「${op.dot}」被复用但载荷不同：首次出现于终端「${prev.terminal}」第 ${
                prev.opIndex + 1
              } 条操作，又出现于终端「${nodeId}」第 ${idx + 1} 条。点标识必须全局唯一。`,
              { ...base, dot: op.dot }
            )
          );
        } else {
          issues.push(
            issue(
              'DUP_DOT_IN_SCRIPT',
              `点标识「${op.dot}」在脚本中重复定义（网络重复投递由收件箱表达，脚本中不得重复）。`,
              { ...base, dot: op.dot }
            )
          );
        }
      } else {
        dotFirst.set(op.dot, po);
      }
    }
  });

  // ---- 收件顺序 ----
  const scheduleNodes = new Set<string>();
  doc.deliveries.forEach((s, schedIdx) => {
    if (typeof s !== 'object' || s === null || typeof s.node !== 'string') {
      issues.push(
        issue('BAD_SCRIPT_SHAPE', '投递计划必须为带 node 字段的对象。', {
          scheduleIndex: schedIdx
        })
      );
      return;
    }
    const node = s.node.trim();
    if (!nodeIds.has(node)) {
      issues.push(
        issue('DELIVERY_NODE_UNKNOWN', `投递计划引用了未知终端「${node}」。`, {
          scheduleIndex: schedIdx
        })
      );
      return;
    }
    if (scheduleNodes.has(node)) {
      issues.push(
        issue('DELIVERY_NODE_UNKNOWN', `终端「${node}」存在多份投递计划，每个终端须恰好一份。`, {
          terminal: node,
          scheduleIndex: schedIdx
        })
      );
    }
    scheduleNodes.add(node);

    if (!Array.isArray(s.inbox)) {
      issues.push(
        issue('BAD_SCRIPT_SHAPE', `终端「${node}」的投递计划缺少 inbox 数组。`, { terminal: node })
      );
      return;
    }
    s.inbox.forEach((key, i) => {
      if (typeof key !== 'string' || !dotFirst.has(key)) {
        issues.push(
          issue(
            'UNKNOWN_MESSAGE_KEY',
            `终端「${node}」收件箱第 ${i + 1} 项「${String(key)}」不指向任何已定义操作。`,
            { terminal: node, scheduleIndex: i, dot: String(key) }
          )
        );
      }
    });
  });

  for (const id of nodeIds) {
    if (!scheduleNodes.has(id)) {
      issues.push(
        issue('DELIVERY_NODE_UNKNOWN', `终端「${id}」缺少投递计划，每个终端须恰好一份 inbox。`, {
          terminal: id
        })
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

function issue(
  code: ValidationIssue['code'],
  message: string,
  loc?: Partial<ValidationIssue>
): ValidationIssue {
  return { severity: 'error', code, message, ...loc };
}

function parseDotKey(key: unknown): { origin: string; counter: number } | null {
  if (typeof key !== 'string') return null;
  const i = key.lastIndexOf(':');
  if (i <= 0 || i === key.length - 1) return null;
  const origin = key.slice(0, i);
  const counter = Number(key.slice(i + 1));
  if (origin.trim() === '' || !Number.isInteger(counter) || counter <= 0) return null;
  return { origin, counter };
}
