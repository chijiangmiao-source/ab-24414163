/**
 * 核心领域类型：禁飞标签 observed-remove 因果收敛回放
 *
 * 模型说明
 * --------
 * - 每个新增操作产生一个全局唯一的「点」(dot)：{ origin, counter }。
 *   例如终端 A 的第 1 次新增产生点 (A,1)，同一终端的点计数器严格递增、绝不复用。
 * - 每个操作（新增 / 撤销）都携带「产生时已见上下文」：
 *   一个压缩版本向量（dot 云见 dotcloud 模块），表达该操作因果上见过哪些点。
 * - 撤销不是针对标签，而是携带「撤销时点集」——只能撤销其产生时已经观察到的点，
 *   未见过的并发新增不会被误删（observed-remove 语义）。
 * - 终端按各自收件顺序处理消息；缺少因果前序的消息进入待处理缓冲，
 *   依赖补齐后自动释放；重复投递幂等，绝不重复改变状态。
 */

/** 终端标识（非空字符串） */
export type NodeId = string;

/** 版本向量：origin -> 已连续见收到的该 origin 最大计数器 */
export type VersionVector = Record<string, number>;

/** 因果点：全局唯一操作标识 */
export interface Dot {
  origin: NodeId;
  counter: number;
}

/** 点的压缩表示 "origin:counter" */
export type DotKey = string;

/**
 * 撤销消息携带的因果上下文（产生时已观察到的点集，用版本向量压缩表示）。
 * 撤销只能清除落在该上下文中的新增点。
 */
export type CausalContext = VersionVector;

/** 脚本中的操作种类 */
export type ScriptOpType = 'add' | 'remove';

/** 导入脚本中的单条操作（用户编写） */
export interface ScriptOperation {
  /** 序号（仅用于展示，可缺省） */
  seq?: number;
  type: ScriptOpType;
  /** 标签载荷，例如禁飞区编号 */
  tag: string;
  /**
   * 新增时：该点的全局唯一点标识（"A:3"）。同一终端脚本内必须严格递增且不复用。
   * 撤销时：必填，作为撤销操作自身的点标识（用于去重与因果追踪）。
   */
  dot: DotKey;
  /**
   * 撤销专用：携带产生时已见上下文（版本向量），
   * 只能撤销向量覆盖到的新增点。新增时忽略。
   */
  context?: CausalContext;
  /** 备注（可选，仅展示） */
  note?: string;
}

/** 单个终端的导入脚本 */
export interface TerminalScript {
  /** 终端标识，如 "A" */
  id: NodeId;
  /** 该终端本地依次产生的操作 */
  operations: ScriptOperation[];
}

/**
 * 收件顺序：每个终端一份「投递计划」。
 * 元素为消息唯一键 `${origin}:${counter}`，指向某终端脚本里的某条操作。
 * 本地操作与远端消息统一进入收件箱，按此顺序尝试交付（不满足因果前序则缓冲）。
 */
export interface DeliverySchedule {
  /** 终端标识 */
  node: NodeId;
  /** 按投递尝试顺序排列的消息键 */
  inbox: DotKey[];
}

/** 顶层导入文档 */
export interface ReplayInput {
  terminals: TerminalScript[];
  deliveries: DeliverySchedule[];
}

/** 一条在网络中传播的不可变消息 */
export interface OperationMessage {
  type: ScriptOpType;
  tag: string;
  dot: Dot;
  /** 撤销时：产生时已见上下文；新增时为空向量 */
  context: CausalContext;
  note?: string;
}

/** 单步因果依据，供 UI 展示“为什么这样合并” */
export interface CausalEvidence {
  /** 结论级别 */
  kind:
    | 'applied-add'        // 应用新增：点加入点云，标签生效
    | 'applied-remove'     // 应用撤销：移除上下文中已观察到的点
    | 'buffered'           // 缺少因果前序，暂存
    | 'duplicate'          // 重复投递，状态不变
    | 'buffer-released'    // 缓冲依赖补齐，释放应用
    | 'noop-remove';       // 撤销上下文中无现存点（幂等空操作）
  /** 人类可读的因果解释 */
  summary: string;
  /** 被本步影响（新增生效 / 被撤销清除）的点 */
  affectedDots?: DotKey[];
  /** 若暂存：尚缺的前序点 */
  missing?: DotKey[];
  /** 若为缓冲释放：本步新补齐、从而解锁该消息的点 */
  unlockedBy?: DotKey[];
}

/** 一次投递尝试的处理结果（回放中的一步） */
export interface ReplayStep {
  /** 全局步号（跨终端连续编号，仅展示） */
  index: number;
  node: NodeId;
  /** 尝试投递的消息键 */
  messageKey: DotKey;
  /** 处理前 -> 处理后（缓冲释放可能连续应用多条，记录最终结果） */
  evidence: CausalEvidence[];
  /** 处理后该终端的有效标签 */
  activeTags: string[];
  /** 处理后版本向量 */
  versionVector: VersionVector;
  /** 处理后待处理（缓冲）消息键，按入缓冲顺序 */
  pending: DotKey[];
  /** 该终端累计已见点（点云快照，键形式） */
  cloud: DotKey[];
  /** 当前存活点 -> 标签（被撤销清除的点不在其中） */
  liveDots: Record<DotKey, string>;
}

/** 单个终端的完整回放轨迹 */
export interface TerminalTrace {
  node: NodeId;
  steps: ReplayStep[];
  /** 最终状态快照 */
  final: {
    activeTags: string[];
    versionVector: VersionVector;
    pending: DotKey[];
    cloud: DotKey[];
    liveDots: Record<DotKey, string>;
  };
}

/** 校验问题 */
export interface ValidationIssue {
  severity: 'error';
  code:
    | 'TERMINAL_ID_CONFLICT'
    | 'TERMINAL_ID_INVALID'
    | 'DOT_REUSE_PAYLOAD_MISMATCH'
    | 'DOT_COUNTER_INVALID'
    | 'DOT_ORIGIN_MISMATCH'
    | 'DUP_DOT_IN_SCRIPT'
    | 'CONTEXT_INVALID'
    | 'UNKNOWN_MESSAGE_KEY'
    | 'DELIVERY_NODE_UNKNOWN'
    | 'BAD_SCRIPT_SHAPE'
    | 'REMOVE_CONTEXT_REQUIRED'
    | 'TAG_EMPTY';
  message: string;
  /** 定位 */
  terminal?: NodeId;
  /** 操作在脚本 operations 中的下标（0 起） */
  opIndex?: number;
  dot?: DotKey;
  scheduleIndex?: number;
}

/** 校验结果 */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Worker 请求 */
export type WorkerRequest =
  | { kind: 'validate'; input: ReplayInput }
  | { kind: 'replay'; input: ReplayInput };

/** Worker 应答 */
export type WorkerResponse =
  | {
      kind: 'validated';
      result: ValidationResult;
    }
  | {
      kind: 'replayed';
      traces: TerminalTrace[];
      /** 全部终端最终有效标签集合（收敛核对） */
      converged: boolean;
      consensusTags: string[];
    }
  | { kind: 'error'; message: string };
