import type { CausalContext, Dot, DotKey, VersionVector } from './types';

/** Dot -> 字符串键 */
export function dotKey(dot: Dot): DotKey {
  return `${dot.origin}:${dot.counter}`;
}

/** 字符串键 -> Dot（不做合法性校验，校验阶段已保证） */
export function parseDot(key: DotKey): Dot {
  const i = key.lastIndexOf(':');
  return { origin: key.slice(0, i), counter: Number(key.slice(i + 1)) };
}

export function vvZero(): VersionVector {
  return {};
}

/** 深拷贝版本向量 */
export function cloneVV(vv: VersionVector): VersionVector {
  return { ...vv };
}

/**
 * 点云（dot cloud）：版本向量无法压缩的「空洞外」点集合。
 *
 * 不变式：
 *  - 对每个 origin，版本向量记录「连续前缀」长度 n，即点 1..n 全部在云内；
 *  - cloud 中只保存 counter > n 的离散点（空洞之后的点）；
 *  - 插入点后若能与前缀连通（n+1 已在 cloud），则推进前缀并压缩。
 */
export class DotCloud {
  /** origin -> 连续前缀长度 */
  vv: VersionVector = {};
  /** origin -> 离散点计数器集合（仅保存 > 前缀的点） */
  private clouds: Record<string, Set<number>> = {};

  /** 点是否已在云内（见过） */
  has(dot: Dot): boolean {
    const n = this.vv[dot.origin] ?? 0;
    if (dot.counter <= n) return true;
    return this.clouds[dot.origin]?.has(dot.counter) ?? false;
  }

  /**
   * 插入一个点。
   * @returns true 表示新加入；false 表示重复（幂等）
   */
  add(dot: Dot): boolean {
    const n = this.vv[dot.origin] ?? 0;
    if (dot.counter <= n) return false;
    const set = (this.clouds[dot.origin] ??= new Set<number>());
    if (set.has(dot.counter)) return false;
    set.add(dot.counter);
    // 压缩：能接上连续前缀就推进
    let next = n + 1;
    while (set.delete(next)) {
      next++;
    }
    if (next - 1 > n) {
      this.vv[dot.origin] = next - 1;
      if (set.size === 0) delete this.clouds[dot.origin];
    }
    return true;
  }

  /** 当前版本向量（连续前缀压缩视图） */
  versionVector(): VersionVector {
    return cloneVV(this.vv);
  }

  /** 云内全部点的键（前缀展开 + 离散点），用于快照/展示 */
  keys(): DotKey[] {
    const out: DotKey[] = [];
    for (const [origin, n] of Object.entries(this.vv)) {
      for (let c = 1; c <= n; c++) out.push(`${origin}:${c}`);
    }
    for (const [origin, set] of Object.entries(this.clouds)) {
      for (const c of set) out.push(`${origin}:${c}`);
    }
    return out.sort();
  }

  /** 云内点数量 */
  size(): number {
    let s = 0;
    for (const n of Object.values(this.vv)) s += n;
    for (const set of Object.values(this.clouds)) s += set.size;
    return s;
  }
}

/**
 * 因果上下文工具。撤销携带「产生时已见上下文」（版本向量压缩）。
 * 上下文用版本向量表示：向量覆盖到的点，即产生者当时已观察到的点前缀。
 */

/** 点是否被上下文（版本向量）覆盖 */
export function contextCovers(ctx: CausalContext, dot: Dot): boolean {
  return dot.counter <= (ctx[dot.origin] ?? 0);
}

/**
 * 校验一个版本向量形状是否合法：
 *  - 必须是普通对象
 *  - 键为非空字符串
 *  - 值为非负整数
 */
export function isValidVV(x: unknown): x is VersionVector {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.trim() === '') return false;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return false;
  }
  return true;
}

/** 点是否为合法形状（origin 非空、counter 正整数） */
export function isValidDot(dot: unknown): dot is Dot {
  if (typeof dot !== 'object' || dot === null) return false;
  const d = dot as Record<string, unknown>;
  return (
    typeof d.origin === 'string' &&
    d.origin.trim() !== '' &&
    typeof d.counter === 'number' &&
    Number.isInteger(d.counter) &&
    d.counter > 0
  );
}

interface OperationMessageLike {
  dot: Dot;
  context?: CausalContext;
}

/**
 * 收集一条消息尚缺的因果前序点：
 *  1. 同 origin 的连续前缀缺口（counter-1 及之前未见到的点）；
 *  2. 撤销上下文（产生时已见点）中接收方尚未交付的点。
 * 任一缺失即不可交付，必须暂存，等待依赖补齐后释放。
 */
export function missingPrerequisites(cloud: DotCloud, msg: OperationMessageLike): DotKey[] {
  const missing: DotKey[] = [];
  const n = cloud.vv[msg.dot.origin] ?? 0;
  for (let c = n + 1; c < msg.dot.counter; c++) {
    missing.push(`${msg.dot.origin}:${c}`);
  }
  for (const [origin, upto] of Object.entries(msg.context ?? {})) {
    const have = cloud.vv[origin] ?? 0;
    for (let c = have + 1; c <= upto; c++) {
      // 同原点时跳过已由前缀循环覆盖的部分
      if (origin === msg.dot.origin && c < msg.dot.counter) continue;
      missing.push(`${origin}:${c}`);
    }
  }
  return missing;
}

/** 严格因果交付条件：同原点前缀连续且上下文中的点均已交付 */
export function isCausallyReady(cloud: DotCloud, msg: OperationMessageLike): boolean {
  return missingPrerequisites(cloud, msg).length === 0;
}
