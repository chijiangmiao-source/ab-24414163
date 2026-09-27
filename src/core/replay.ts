import {
  DotCloud,
  contextCovers,
  dotKey,
  isCausallyReady,
  missingPrerequisites
} from './dotcloud';
import type {
  CausalEvidence,
  DotKey,
  OperationMessage,
  ReplayInput,
  ReplayStep,
  TerminalScript,
  TerminalTrace
} from './types';

/**
 * observed-remove 集合（OR-Set）的单副本状态。
 *
 *  - cloud：已见点云（含压缩版本向量），承担去重与因果交付判定。
 *  - live：存活点 -> 标签载荷。新增点加入；撤销把「产生时上下文覆盖且仍存活」的点清除。
 *  - tombstones：被任意已交付撤销的上下文所覆盖的点。保证「先到的撤销」不会让
 *    「后到的、但撤销者产生时已见过的并发/前序新增」复活。
 *    并发新增（撤销上下文中不包含的点）绝不受影响——这正是 observed-remove 与
 *    普通「删除标签」的区别，避免未见过的并发新增被误删。
 */
export class ORSetReplica {
  node: string;
  cloud = new DotCloud();
  /** 存活点键 -> 标签 */
  live = new Map<DotKey, string>();
  /** 已交付撤销的上下文列表（合并为逐 origin 最大前缀即可，因为上下文都是前缀向量） */
  private removeCtx: Record<string, number> = {};
  /** 已交付消息键（幂等去重，cloud 已含该信息，这里显式留存便于说明） */
  seen = new Set<DotKey>();

  constructor(node: string) {
    this.node = node;
  }

  /** 点是否被任意已见撤销的上下文覆盖（应被抑制） */
  private tombstoned(dotKey: DotKey): boolean {
    const i = dotKey.lastIndexOf(':');
    const origin = dotKey.slice(0, i);
    const counter = Number(dotKey.slice(i + 1));
    return counter <= (this.removeCtx[origin] ?? 0);
  }

  /**
   * 交付一条已满足因果前序的消息。
   * @returns 因果依据（可能包含撤销引发的多点清除）
   */
  deliver(msg: OperationMessage): CausalEvidence {
    const key = dotKey(msg.dot);

    // 幂等：重复投递绝不重复改变状态
    if (this.seen.has(key)) {
      return {
        kind: 'duplicate',
        summary: `重复投递 ${key}（${msg.type}），该消息已交付过，状态保持不变。`,
        affectedDots: []
      };
    }

    if (msg.type === 'add') {
      this.seen.add(key);
      this.cloud.add(msg.dot);
      const affected: DotKey[] = [];
      // 仅当没有任何已见撤销覆盖该点时才存活
      if (!this.tombstoned(key)) {
        this.live.set(key, msg.tag);
        affected.push(key);
      }
      return {
        kind: 'applied-add',
        summary:
          affected.length > 0
            ? `应用新增 ${key}：点加入点云，标签「${msg.tag}」生效。`
            : `应用新增 ${key}：点加入点云，但该点已被先前到达的撤销上下文覆盖（observed-remove 墓碑），标签「${msg.tag}」不复活。`,
        affectedDots: affected
      };
    }

    // remove：合并撤销上下文（逐 origin 取最大前缀），清除当前存活且被覆盖的点
    this.seen.add(key);
    this.cloud.add(msg.dot);
    const removed: DotKey[] = [];
    for (const [origin, n] of Object.entries(msg.context)) {
      const cur = this.removeCtx[origin] ?? 0;
      if (n > cur) this.removeCtx[origin] = n;
    }
    for (const key2 of [...this.live.keys()]) {
      const i = key2.lastIndexOf(':');
      const dot = { origin: key2.slice(0, i), counter: Number(key2.slice(i + 1)) };
      if (contextCovers(msg.context, dot)) {
        removed.push(key2);
        this.live.delete(key2);
      }
    }
    if (removed.length === 0) {
      return {
        kind: 'noop-remove',
        summary: `应用撤销 ${key}：其产生时上下文 ${fmtVV(msg.context)} 中当前没有存活的新增点（可能已被删除或点尚未到达而记入墓碑），无点可清除。`,
        affectedDots: []
      };
    }
    return {
      kind: 'applied-remove',
      summary: `应用撤销 ${key}：按 observed-remove 语义，仅清除其产生时已观察到的上下文中的存活点 ${removed.join(
        ', '
      )}；未见过的并发新增不受影响。`,
      affectedDots: removed
    };
  }

  activeTags(): string[] {
    return [...new Set(this.live.values())].sort();
  }

  vv() {
    return this.cloud.versionVector();
  }

  liveSnapshot(): Record<DotKey, string> {
    return Object.fromEntries([...this.live.entries()].sort());
  }
}

function fmtVV(vv: Record<string, number>): string {
  const ent = Object.entries(vv)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  return `{${ent}}`;
}

/** 单个终端的回放器：按收件顺序尝试交付，缺前序则缓冲，依赖补齐后释放 */
class NodeReplayer {
  replica: ORSetReplica;
  /** 缓冲：消息键 -> 消息 */
  buffer = new Map<DotKey, OperationMessage>();

  constructor(node: string, private catalog: Map<DotKey, OperationMessage>) {
    this.replica = new ORSetReplica(node);
  }

  /** 尝试把一条消息（及其解锁的缓冲链）交付，返回逐步证据与最终缓冲状态 */
  attempt(key: DotKey): Omit<ReplayStep, 'index' | 'node' | 'messageKey'> {
    const evidence: CausalEvidence[] = [];
    const msg = this.catalog.get(key)!;
    const unlockedBy: DotKey[] = [];

    if (this.replica.seen.has(key)) {
      evidence.push(this.replica.deliver(msg)); // duplicate evidence
    } else if (isCausallyReady(this.replica.cloud, msg)) {
      evidence.push(this.replica.deliver(msg));
      unlockedBy.push(key);
    } else {
      // 缺少因果前序 -> 暂存
      if (!this.buffer.has(key)) this.buffer.set(key, msg);
      evidence.push({
        kind: 'buffered',
        summary: `消息 ${key} 缺少因果前序，暂存待依赖补齐。`,
        missing: missingPrerequisites(this.replica.cloud, msg)
      });
    }

    // 每次交付后，循环尝试释放缓冲中可能已就绪的消息（可能连锁释放）
    let progressed = unlockedBy.length > 0;
    while (progressed) {
      progressed = false;
      for (const [bKey, bMsg] of this.buffer) {
        if (isCausallyReady(this.replica.cloud, bMsg)) {
          this.buffer.delete(bKey);
          const ev = this.replica.deliver(bMsg);
          evidence.push({
            ...ev,
            kind: ev.kind === 'duplicate' ? 'duplicate' : 'buffer-released',
            summary: `依赖补齐，释放缓冲消息 ${bKey}：${ev.summary}`,
            unlockedBy
          } as CausalEvidence);
          progressed = true;
          break; // 重新从头扫描，保持确定性顺序
        }
      }
    }

    return {
      evidence,
      activeTags: this.replica.activeTags(),
      versionVector: this.replica.vv(),
      pending: [...this.buffer.keys()],
      cloud: this.replica.cloud.keys(),
      liveDots: this.replica.liveSnapshot()
    };
  }
}

/**
 * 执行全量回放（输入应已通过 validate）。
 * 为每个终端独立构造副本，按各自收件顺序处理同一批不可变消息。
 */
export function runReplay(input: ReplayInput): TerminalTrace[] {
  const catalog = buildCatalog(input.terminals);
  const traces: TerminalTrace[] = [];

  for (const schedule of input.deliveries) {
    const replayer = new NodeReplayer(schedule.node, catalog);
    const steps: ReplayStep[] = [];
    let globalIndex = 0;
    for (const key of schedule.inbox) {
      const r = replayer.attempt(key);
      steps.push({
        index: globalIndex,
        node: schedule.node,
        messageKey: key,
        ...r
      });
      globalIndex++;
    }
    traces.push({
      node: schedule.node,
      steps,
      final: {
        activeTags: replayer.replica.activeTags(),
        versionVector: replayer.replica.vv(),
        pending: [...replayer.buffer.keys()],
        cloud: replayer.replica.cloud.keys(),
        liveDots: replayer.replica.liveSnapshot()
      }
    });
  }
  return traces;
}

/** 从所有终端脚本汇总不可变消息目录（dot 键 -> 消息） */
export function buildCatalog(terminals: TerminalScript[]): Map<DotKey, OperationMessage> {
  const catalog = new Map<DotKey, OperationMessage>();
  for (const t of terminals) {
    for (const op of t.operations) {
      const i = op.dot.lastIndexOf(':');
      const dot = { origin: op.dot.slice(0, i), counter: Number(op.dot.slice(i + 1)) };
      catalog.set(op.dot, {
        type: op.type,
        tag: op.tag,
        dot,
        context: op.context ?? {},
        note: op.note
      });
    }
  }
  return catalog;
}

/** 全部终端最终是否收敛到同一有效标签集合 */
export function checkConvergence(traces: TerminalTrace[]): {
  converged: boolean;
  consensusTags: string[];
} {
  if (traces.length === 0) return { converged: true, consensusTags: [] };
  const first = JSON.stringify(traces[0].final.activeTags);
  const converged = traces.every((t) => JSON.stringify(t.final.activeTags) === first);
  return { converged, consensusTags: traces[0].final.activeTags };
}
