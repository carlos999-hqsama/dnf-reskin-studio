// 对齐数学契约测试 — 从 Python tests/test_core_contract.py 移植。
// 目的: 证明 core 的精密对齐逻辑 TS 重写与 Python 版逐项等价 (无回归)。
import { describe, it, expect } from 'vitest';
import { SpriteSet, uniqueCells, type Frame, type Action } from '../src/model';
import { computeGeometry, computeContentGeometry } from '../src/geometry';
import { footAnchorAxis, splitBounds } from '../src/align';
import { segmentAction } from '../src/segment';

function solidFrame(g: number, i: number, w: number, h: number, axis: [number, number]): Frame {
  return { group: g, image: i, size: [w, h], axis };
}

describe('Geometry (对应 TestGeometry)', () => {
  it('最大外延算格尺寸 + 锚点', () => {
    // 帧A 20x40 轴(10,30): U30 D10 L10 R10; 帧B 30x20 轴(5,10): U10 D10 L5 R25
    const ss = new SpriteSet([solidFrame(0, 0, 20, 40, [10, 30]), solidFrame(0, 1, 30, 20, [5, 10])]);
    const geo = computeGeometry(ss, [[0, 0], [0, 1]], 1000, 8);
    expect(geo.cellW).toBe(10 + 25 + 16); // 51
    expect(geo.cellH).toBe(30 + 10 + 16); // 56
    expect(geo.anchor).toEqual([10 + 8, 30 + 8]); // [18,38]
    expect(geo.scale).toBe(1.0);
  });
  it('超 maxcell 按比例缩', () => {
    const ss = new SpriteSet([solidFrame(0, 0, 400, 400, [200, 200])]);
    const geo = computeGeometry(ss, [[0, 0]], 300, 8);
    expect(geo.scale).toBeLessThan(1.0);
    expect(Math.max(geo.cellW, geo.cellH)).toBeLessThanOrEqual(300);
  });
});

describe('computeContentGeometry (内容贴合: cell=最大帧内容, 不被脚底锚远点撑大)', () => {
  it('cell = 最大帧 w/h + 2*margin', () => {
    // 帧A 20×40, 帧B 30×20 → 各维取 max = 30×40 → cell (30+16)×(40+16)
    const ss = new SpriteSet([solidFrame(0, 0, 20, 40, [10, 30]), solidFrame(0, 1, 30, 20, [5, 10])]);
    const geo = computeContentGeometry(ss, [[0, 0], [0, 1]], 1000, 8);
    expect([geo.cellW, geo.cellH]).toEqual([46, 56]);
    expect(geo.scale).toBe(1.0);
  });
  it('超 maxcell 按比例缩', () => {
    const ss = new SpriteSet([solidFrame(0, 0, 400, 400, [0, 0])]);
    const geo = computeContentGeometry(ss, [[0, 0]], 300, 8);
    expect(geo.scale).toBeLessThan(1.0);
    expect(Math.max(geo.cellW, geo.cellH)).toBeLessThanOrEqual(300);
  });
  it('脚底锚远离内容时 cell 远小于 computeGeometry 的运动并集 (修空白)', () => {
    // 帧 30×40 轴(200,300) 远在内容外 → computeGeometry 外延被锚撑爆; 内容贴合仍贴帧 30×40
    const ss = new SpriteSet([solidFrame(0, 0, 30, 40, [200, 300])]);
    const content = computeContentGeometry(ss, [[0, 0]], 1000, 8);
    const union = computeGeometry(ss, [[0, 0]], 1000, 8);
    expect([content.cellW, content.cellH]).toEqual([46, 56]);
    expect(content.cellW).toBeLessThan(union.cellW);
    expect(content.cellH).toBeLessThan(union.cellH);
  });
});

describe('footAnchorAxis (对应 TestFootAnchorAxis)', () => {
  it('同尺寸 → 零偏移 (ΔX=ΔY=0)', () => expect(footAnchorAxis([30, 60], [15, 55], [30, 60])).toEqual([15, 55]));
  it('变窄 4 → 保水平中心 (x+2)', () => expect(footAnchorAxis([30, 60], [15, 55], [26, 60])).toEqual([17, 55]));
  it('变矮 6 → 保底 (y+6)', () => expect(footAnchorAxis([30, 60], [15, 55], [30, 54])).toEqual([15, 61]));
  it('同时窄矮', () => expect(footAnchorAxis([30, 60], [15, 55], [26, 54])).toEqual([17, 61]));
  it('与旧内联公式逐项等价', () => {
    const cases: Array<[[number, number], [number, number], [number, number]]> = [
      [[30, 60], [15, 55], [26, 54]], [[41, 109], [20, 100], [39, 107]],
      [[10, 20], [5, 18], [6, 16]], [[50, 50], [25, 49], [50, 50]],
    ];
    for (const [osz, oax, nsz] of cases) {
      const inline: [number, number] = [
        Math.round(oax[0] + (osz[0] - nsz[0]) / 2),
        Math.round(oax[1] + (osz[1] - nsz[1])),
      ];
      expect(footAnchorAxis(osz, oax, nsz)).toEqual(inline);
    }
  });
});

describe('splitBounds (投影切分)', () => {
  it('n=1 直接全长', () => expect(splitBounds([1, 2, 3], 1, 3)).toEqual([0, 3]));
  it('两峰段 → 间隙中点切', () => {
    // [10,10,0,0,10,10]: 峰段 [0,2) [4,6), 中点 (2+4)/2=3
    expect(splitBounds([10, 10, 0, 0, 10, 10], 2, 6)).toEqual([0, 3, 6]);
  });
  it('峰段不足 n → null (回退等分)', () => expect(splitBounds([10, 10], 3, 2)).toBeNull());
  it('全空 profile → null', () => expect(splitBounds([0, 0, 0], 2, 3)).toBeNull());
});

describe('segmentAction (均分分组) + uniqueCells', () => {
  function act(n: number): Action {
    return { id: 0, name: 't', frames: Array.from({ length: n }, (_, k) => [0, k, 0, 0, 5] as const) };
  }
  it('20 帧 @9 → 末组 2<4.5 并进 → [9,11]', () => {
    const segs = segmentAction(act(20), 9);
    expect(segs.length).toBe(2);
    expect(segs.map((s) => s.keys.length)).toEqual([9, 11]);
    expect(segs[0]!.index).toBe(1);
  });
  it('18 帧 @9 整除 → [9,9]', () => {
    expect(segmentAction(act(18), 9).map((s) => s.keys.length)).toEqual([9, 9]);
  });
  it('mergeShortTail=false: 不并尾组 → 每组严格≤groupSize (固定 4×4 不爆格)', () => {
    expect(segmentAction(act(17), 15, false).map((s) => s.keys.length)).toEqual([15, 2]); // 不并
    expect(segmentAction(act(17), 15).map((s) => s.keys.length)).toEqual([17]);            // 默认会并(2<7.5)→爆格, 故补丁用 false
  });
  it('uniqueCells 去重保序', () => {
    const a: Action = { id: 0, name: 't', frames: [[0, 0, 0, 0, 5], [0, 1, 0, 0, 5], [0, 0, 0, 0, 5]] };
    expect(uniqueCells(a)).toEqual([[0, 0], [0, 1]]);
  });
});
