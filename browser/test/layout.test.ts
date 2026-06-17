// 网格布局契约测试 — 验 computeGridLayout 与 Python build_action_grid 布局一致。
import { describe, it, expect } from 'vitest';
import { computeGridLayout } from '../src/layout';
import type { Geometry } from '../src/geometry';

const geo: Geometry = { cellW: 10, cellH: 20, anchor: [5, 15], scale: 1 };

describe('computeGridLayout', () => {
  it('5 帧 → 3×2 网格 + 尺寸/位置 (upscale2 gap14 pad18)', () => {
    const L = computeGridLayout(5, geo, 2, 14, 18);
    expect([L.cols, L.rows]).toEqual([3, 2]);   // ceil(sqrt5)=3, ceil(5/3)=2
    expect([L.cw, L.ch]).toEqual([20, 40]);     // cellW*2, cellH*2
    expect(L.anchor).toEqual([10, 30]);         // anchor*2
    expect(L.W).toBe(18 * 2 + 3 * 20 + 2 * 14); // 124
    expect(L.H).toBe(18 * 2 + 2 * 40 + 1 * 14); // 130
    expect(L.cells).toHaveLength(5);
    expect(L.cells[0]!.cellXy).toEqual([18, 18]);          // 首格
    expect(L.cells[0]!.cellWh).toEqual([20, 40]);
    expect(L.cells[3]!.cellXy).toEqual([18, 18 + 40 + 14]); // 第二行首格 [18,72]
  });
  it('n=1 → 1×1', () => {
    const L = computeGridLayout(1, geo);
    expect([L.cols, L.rows, L.cells.length]).toEqual([1, 1, 1]);
  });
  it('携带 scale/upscale 给 importer 切回扣缩放', () => {
    const L = computeGridLayout(4, { ...geo, scale: 0.8 }, 2);
    expect(L.scale).toBe(0.8);
    expect(L.upscale).toBe(2);
  });
  it('强制 4×4 (fixedCols/fixedRows): 15 帧 → 4列4行15格, 右下第16格空 + 整图按4×4算', () => {
    const L = computeGridLayout(15, geo, 2, 14, 18, 4, 4);
    expect([L.cols, L.rows]).toEqual([4, 4]);
    expect(L.cells).toHaveLength(15);              // 只 15 格 → 第 16(右下) 恒空 (给 Gemini 水印)
    expect(L.W).toBe(18 * 2 + 4 * 20 + 3 * 14);    // 宽按 4 列
    expect(L.H).toBe(18 * 2 + 4 * 40 + 3 * 14);    // 高按 4 行 (即使帧不满 4 行也撑满)
    expect(L.cells[14]!.cellXy).toEqual([18 + 2 * (20 + 14), 18 + 3 * (40 + 14)]); // 末帧 idx14 = row3col2
  });
});
