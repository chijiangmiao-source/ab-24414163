import type { ReplayInput } from './core/types';

/**
 * 内置示例：3 台地面终端 A / B / C，断网期间各自维护禁飞标签。
 *
 * 事件设计（覆盖验收点）：
 *  - A:1 新增 NFZ-ALPHA；B:1 新增 NFZ-BRAVO；C:1 新增 NFZ-GAMMA（三者并发）。
 *  - A:2 撤销，产生时只见过 A:1（context {A:1}）：
 *      · 只能撤掉 NFZ-ALPHA；
 *      · 未见过的并发新增 NFZ-BRAVO / NFZ-GAMMA 绝不能被误删。
 *  - 终端 B 先收到 A:2 再收到 A:1：撤销缺少因果前序，必须暂存，A:1 到达后释放。
 *  - 终端 A 的收件箱中 B:1 被投递两次：重复投递不得重复改变状态。
 *
 * 所有终端最终应收敛到 { NFZ-BRAVO, NFZ-GAMMA }。
 */
export const SAMPLE_INPUT: ReplayInput = {
  terminals: [
    {
      id: 'A',
      operations: [
        { type: 'add', tag: 'NFZ-ALPHA', dot: 'A:1', note: 'A 地本地新增 ALPHA 禁飞区' },
        {
          type: 'remove',
          tag: '撤销批次/A 已见 ALPHA',
          dot: 'A:2',
          context: { A: 1 },
          note: '产生时仅观察到 A:1，撤掉 ALPHA；未见过 B/C 的并发新增'
        }
      ]
    },
    {
      id: 'B',
      operations: [
        { type: 'add', tag: 'NFZ-BRAVO', dot: 'B:1', note: 'B 地本地新增 BRAVO 禁飞区' }
      ]
    },
    {
      id: 'C',
      operations: [
        { type: 'add', tag: 'NFZ-GAMMA', dot: 'C:1', note: 'C 地本地新增 GAMMA 禁飞区' }
      ]
    }
  ],
  deliveries: [
    {
      node: 'A',
      inbox: ['A:1', 'B:1', 'B:1', 'A:2', 'C:1', 'C:1']
    },
    {
      // 乱序：撤销先于它依赖的新增到达，须暂存后释放
      node: 'B',
      inbox: ['A:2', 'B:1', 'A:1', 'C:1']
    },
    {
      node: 'C',
      inbox: ['C:1', 'A:1', 'B:1', 'A:2']
    }
  ]
};

/** 非法示例：点标识 A:1 被复用但载荷不同 + 终端标识冲突，用于演示定位拒绝 */
export const SAMPLE_INVALID: ReplayInput = {
  terminals: [
    {
      id: 'A',
      operations: [
        { type: 'add', tag: 'NFZ-ALPHA', dot: 'A:1' },
        { type: 'add', tag: 'NFZ-TAMPERED', dot: 'A:1' }
      ]
    },
    {
      id: 'A',
      operations: [{ type: 'add', tag: 'NFZ-BRAVO', dot: 'A:1' }]
    }
  ],
  deliveries: [
    { node: 'A', inbox: ['A:1'] },
    { node: 'A', inbox: ['A:1'] }
  ]
} as unknown as ReplayInput;
