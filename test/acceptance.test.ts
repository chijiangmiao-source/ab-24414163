import { describe, it, expect } from 'vitest';
import { DotCloud } from '../src/core/dotcloud';
import { runReplay, checkConvergence } from '../src/core/replay';
import { validate } from '../src/core/validate';
import type { ReplayInput } from '../src/core/types';

/** 便捷构造 */
function makeInput(
  terminals: ReplayInput['terminals'],
  deliveries: Array<[string, string[]]>
): ReplayInput {
  return {
    terminals,
    deliveries: deliveries.map(([node, inbox]) => ({ node, inbox }))
  };
}

const TERMINALS_AB = [
  {
    id: 'A',
    operations: [
      { type: 'add' as const, tag: 'X', dot: 'A:1' },
      { type: 'remove' as const, tag: 'rm', dot: 'A:2', context: { A: 1 } }
    ]
  },
  { id: 'B', operations: [{ type: 'add' as const, tag: 'Y', dot: 'B:1' }] }
];

describe('observed-remove 归并：并发新增不被误删', () => {
  it('撤销只清除产生时已观察到的点，未见过的并发新增存活，各终端收敛', () => {
    const input = makeInput(TERMINALS_AB, [
      ['A', ['A:1', 'B:1', 'A:2']],
      ['B', ['B:1', 'A:1', 'A:2']]
    ]);
    expect(validate(input).ok).toBe(true);
    const traces = runReplay(input);
    const { converged, consensusTags } = checkConvergence(traces);
    expect(converged).toBe(true);
    // A:1(X) 被 A:2 撤销；B:1(Y) 是撤销者未见过的并发新增，必须存活
    expect(consensusTags).toEqual(['Y']);
  });

  it('撤销上下文覆盖多点时只删除被覆盖且存活的点', () => {
    const terminals = [
      { id: 'A', operations: [{ type: 'add' as const, tag: 'X', dot: 'A:1' }] },
      { id: 'B', operations: [{ type: 'add' as const, tag: 'Y', dot: 'B:1' }] },
      {
        id: 'C',
        operations: [
          {
            type: 'remove' as const,
            tag: 'rmXY',
            dot: 'C:1',
            // C 产生撤销时已通过回传同时见过 X 和 Y
            context: { A: 1, B: 1 }
          }
        ]
      }
    ];
    const input = makeInput(terminals, [
      ['A', ['A:1', 'B:1', 'C:1']],
      ['B', ['B:1', 'C:1', 'A:1']], // C:1 先到但缺 A:1 前序 -> 暂存
      ['C', ['A:1', 'C:1', 'B:1']] // C:1 先到但缺 B:1 前序 -> 暂存
    ]);
    const traces = runReplay(input);
    const { converged, consensusTags } = checkConvergence(traces);
    expect(converged).toBe(true);
    expect(consensusTags).toEqual([]);
    // B 终端：第一步后 C:1 必须在缓冲中
    expect(traces[1].steps[1].pending).toContain('C:1');
    // A:1 到达后释放，最终无待处理
    expect(traces[1].final.pending).toEqual([]);
  });
});

describe('乱序：缺少因果前序暂存，依赖补齐后释放', () => {
  it('撤销先于所依赖的新增到达时暂存，新增到达后连锁释放并生效', () => {
    const input = makeInput(TERMINALS_AB, [
      ['A', ['A:1', 'B:1', 'A:2']],
      // B 先收到撤销 A:2（它依赖 A:1），再收到 B:1，再收到 A:1
      ['B', ['A:2', 'B:1', 'A:1']]
    ]);
    const traces = runReplay(input);
    const b = traces[1];

    // 第 1 次投递：A:2 缺前序 A:1 -> 暂存
    expect(b.steps[0].pending).toContain('A:2');
    expect(b.steps[0].evidence[0].kind).toBe('buffered');
    expect(b.steps[0].evidence[0].missing).toContain('A:1');
    expect(b.steps[0].activeTags).toEqual([]);

    // 第 3 次投递 A:1 后：A:1 应用并解锁 A:2，X 立即被撤，最终只剩 Y
    const last = b.steps[2];
    const kinds = last.evidence.map((e) => e.kind);
    expect(kinds).toContain('applied-add');
    expect(kinds).toContain('buffer-released');
    expect(last.activeTags).toEqual(['Y']);
    expect(last.pending).toEqual([]);

    const { converged, consensusTags } = checkConvergence(traces);
    expect(converged).toBe(true);
    expect(consensusTags).toEqual(['Y']);
  });

  it('深空洞：跨计数器的前序缺口按序暂存与释放', () => {
    const terminals = [
      {
        id: 'A',
        operations: [
          { type: 'add' as const, tag: 'X1', dot: 'A:1' },
          { type: 'add' as const, tag: 'X2', dot: 'A:2' },
          { type: 'add' as const, tag: 'X3', dot: 'A:3' }
        ]
      },
      { id: 'B', operations: [] }
    ];
    const input = makeInput(terminals, [
      ['A', ['A:1', 'A:2', 'A:3']],
      ['B', ['A:3', 'A:1', 'A:2']]
    ]);
    const b = runReplay(input)[1];
    expect(b.steps[0].pending).toEqual(['A:3']); // A:3 缺 A:1,A:2
    // A:1 到达后 A:3 仍缺 A:2
    expect(b.steps[1].pending).toEqual(['A:3']);
    // A:2 到达后连锁释放 A:3
    expect(b.steps[2].pending).toEqual([]);
    expect(b.final.activeTags).toEqual(['X1', 'X2', 'X3']);
  });
});

describe('重复投递幂等', () => {
  it('同一消息任意次数重复不重复改变状态', () => {
    const input = makeInput(TERMINALS_AB, [
      ['A', ['A:1', 'A:1', 'B:1', 'B:1', 'B:1', 'A:2', 'A:2']],
      ['B', ['B:1', 'A:1', 'A:2', 'A:1', 'B:1']]
    ]);
    const traces = runReplay(input);
    const a = traces[0];

    // 第二次 A:1 -> duplicate 证据，标签不变
    expect(a.steps[1].evidence[0].kind).toBe('duplicate');
    expect(a.steps[1].activeTags).toEqual(['X']);
    // 重复的 B:1 不产生重复标签（集合语义）
    const b1First = a.steps[2].activeTags;
    expect(a.steps[3].evidence[0].kind).toBe('duplicate');
    expect(a.steps[3].activeTags).toEqual(b1First);
    expect(a.steps[4].activeTags).toEqual(['X', 'Y']);
    // 重复撤销也是幂等空操作，不再删除任何点
    expect(a.steps[6].evidence[0].kind).toBe('duplicate');
    expect(a.steps[6].activeTags).toEqual(['Y']);

    const { converged, consensusTags } = checkConvergence(traces);
    expect(converged).toBe(true);
    expect(consensusTags).toEqual(['Y']);
  });

  it('缓冲中的消息重复投递不产生重复副本，释放只发生一次', () => {
    const input = makeInput(TERMINALS_AB, [
      ['A', ['A:1', 'B:1', 'A:2']],
      ['B', ['B:1', 'A:2', 'A:2', 'A:1']]
    ]);
    const b = runReplay(input)[1];
    // 两次尝试 A:2（step1、step2），缓冲始终只有一份
    expect(b.steps[1].pending).toEqual(['A:2']);
    expect(b.steps[2].pending).toEqual(['A:2']);
    // A:1 到达（step3），释放一次
    const releaseCount = b.steps[3].evidence.filter(
      (e) => e.kind === 'buffer-released'
    ).length;
    expect(releaseCount).toBe(1);
    expect(b.final.activeTags).toEqual(['Y']);
  });
});

describe('observed-remove 墓碑：先到的撤销抑制后到的新增（经因果暂存）', () => {
  it('撤销与新增乱序到达，最终被撤点不复活', () => {
    // C 的撤销同时覆盖 A:1；在 C 终端撤销甚至先于 A:1 被尝试投递
    const terminals = [
      { id: 'A', operations: [{ type: 'add' as const, tag: 'X', dot: 'A:1' }] },
      { id: 'B', operations: [{ type: 'add' as const, tag: 'Y', dot: 'B:1' }] },
      {
        id: 'C',
        operations: [
          { type: 'remove' as const, tag: 'rm', dot: 'C:1', context: { A: 1 } }
        ]
      }
    ];
    const input = makeInput(terminals, [
      ['A', ['C:1', 'A:1', 'B:1']],
      ['B', ['A:1', 'C:1', 'B:1']],
      ['C', ['C:1', 'A:1', 'B:1']]
    ]);
    const traces = runReplay(input);
    // 所有终端：X 被撤，Y（不在撤销上下文）存活
    for (const t of traces) {
      expect(t.final.activeTags).toEqual(['Y']);
      expect(t.final.pending).toEqual([]);
    }
    // A 终端：C:1 先暂存，A:1 到达后同批释放 C:1：X 先入集合随即被撤销清除
    const a = traces[0];
    expect(a.steps[0].evidence[0].kind).toBe('buffered');
    const addEv = a.steps[1].evidence.find(
      (e) => e.kind === 'applied-add' && e.affectedDots?.includes('A:1')
    );
    const rmEv = a.steps[1].evidence.find(
      (e) => e.kind === 'buffer-released' && e.affectedDots?.includes('A:1')
    );
    expect(addEv).toBeDefined();
    expect(rmEv).toBeDefined();
    // 该步结束 X 已不在有效集合，之后 B:1 到达也不会让 X 复活
    expect(a.steps[1].activeTags).toEqual([]);
    expect(a.final.activeTags).toEqual(['Y']);
  });
});

describe('点云压缩', () => {
  it('连续前缀推进版本向量，离散点保留在云外集合，重复插入幂等', () => {
    const c = new DotCloud();
    expect(c.add({ origin: 'A', counter: 1 })).toBe(true);
    expect(c.add({ origin: 'A', counter: 1 })).toBe(false);
    expect(c.vv.A).toBe(1);
    // 空洞点 A:3 先到 -> 保留离散
    expect(c.add({ origin: 'A', counter: 3 })).toBe(true);
    expect(c.vv.A).toBe(1);
    expect(c.has({ origin: 'A', counter: 3 })).toBe(true);
    // A:2 到达 -> 压缩推进到 3
    expect(c.add({ origin: 'A', counter: 2 })).toBe(true);
    expect(c.vv.A).toBe(3);
    expect(c.keys().sort()).toEqual(['A:1', 'A:2', 'A:3']);
  });
});

describe('导入校验：精确定位拒绝', () => {
  it('点标识复用但载荷不同 -> DOT_REUSE_PAYLOAD_MISMATCH', () => {
    const input = {
      terminals: [
        {
          id: 'A',
          operations: [
            { type: 'add', tag: 'X', dot: 'A:1' },
            { type: 'add', tag: 'TAMPERED', dot: 'A:1' }
          ]
        },
        { id: 'B', operations: [{ type: 'add', tag: 'Y', dot: 'B:1' }] }
      ],
      deliveries: [
        { node: 'A', inbox: ['A:1'] },
        { node: 'B', inbox: ['B:1'] }
      ]
    };
    const r = validate(input);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'DOT_REUSE_PAYLOAD_MISMATCH');
    expect(issue).toBeDefined();
    expect(issue!.terminal).toBe('A');
    expect(issue!.opIndex).toBe(1);
  });

  it('终端标识冲突 -> TERMINAL_ID_CONFLICT', () => {
    const r = validate({
      terminals: [
        { id: 'A', operations: [] },
        { id: 'A', operations: [] }
      ],
      deliveries: []
    });
    expect(r.issues.some((i) => i.code === 'TERMINAL_ID_CONFLICT')).toBe(true);
  });

  it('非法上下文（引用不存在的点）与撤销缺少上下文均被拒', () => {
    const r1 = validate({
      terminals: [
        {
          id: 'A',
          operations: [
            { type: 'add', tag: 'X', dot: 'A:1' },
            { type: 'remove', tag: 'rm', dot: 'A:2', context: { A: 9 } }
          ]
        },
        { id: 'B', operations: [{ type: 'add', tag: 'Y', dot: 'B:1' }] }
      ],
      deliveries: [
        { node: 'A', inbox: ['A:1', 'A:2'] },
        { node: 'B', inbox: ['B:1'] }
      ]
    });
    expect(r1.issues.some((i) => i.code === 'CONTEXT_INVALID')).toBe(true);

    const r2 = validate({
      terminals: [
        {
          id: 'A',
          operations: [{ type: 'remove', tag: 'rm', dot: 'A:1' }]
        },
        { id: 'B', operations: [{ type: 'add', tag: 'Y', dot: 'B:1' }] }
      ],
      deliveries: [
        { node: 'A', inbox: ['A:1'] },
        { node: 'B', inbox: ['B:1'] }
      ]
    });
    expect(r2.issues.some((i) => i.code === 'REMOVE_CONTEXT_REQUIRED')).toBe(true);
  });

  it('收件箱引用未知消息 / 终端数越界被拒', () => {
    const r = validate({
      terminals: [
        { id: 'A', operations: [{ type: 'add', tag: 'X', dot: 'A:1' }] },
        { id: 'B', operations: [{ type: 'add', tag: 'Y', dot: 'B:1' }] }
      ],
      deliveries: [
        { node: 'A', inbox: ['A:1', 'ZZ:9'] },
        { node: 'B', inbox: ['B:1'] }
      ]
    });
    expect(r.issues.some((i) => i.code === 'UNKNOWN_MESSAGE_KEY')).toBe(true);

    const r2 = validate({ terminals: [], deliveries: [] });
    expect(r2.ok).toBe(false);
  });

  it('合法内置示例通过校验且三终端收敛到 BRAVO/GAMMA', () => {
    const input = makeInput(
      [
        {
          id: 'A',
          operations: [
            { type: 'add' as const, tag: 'NFZ-ALPHA', dot: 'A:1' },
            { type: 'remove' as const, tag: 'rm', dot: 'A:2', context: { A: 1 } }
          ]
        },
        { id: 'B', operations: [{ type: 'add' as const, tag: 'NFZ-BRAVO', dot: 'B:1' }] },
        { id: 'C', operations: [{ type: 'add' as const, tag: 'NFZ-GAMMA', dot: 'C:1' }] }
      ],
      [
        ['A', ['A:1', 'B:1', 'B:1', 'A:2', 'C:1', 'C:1']],
        ['B', ['A:2', 'B:1', 'A:1', 'C:1']],
        ['C', ['C:1', 'A:1', 'B:1', 'A:2']]
      ]
    );
    expect(validate(input).ok).toBe(true);
    const { converged, consensusTags } = checkConvergence(runReplay(input));
    expect(converged).toBe(true);
    expect(consensusTags).toEqual(['NFZ-BRAVO', 'NFZ-GAMMA']);
  });
});
