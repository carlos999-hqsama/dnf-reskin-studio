// 网格布局 — 对应 Python core/render.py:build_action_grid 的布局部分 (纯几何, 不含像素合成)。
// 导出/导入的几何契约: importer 切回靠每格 cellXy/cellWh + 整图 W/H 按比例精确映射, 不靠"等宽 N 格"。
import type { Geometry } from './geometry';

export interface GridCell {
  /** 该格左上在整图的位置 [x, y] */
  cellXy: [number, number];
  /** 格尺寸 [w, h] (含 upscale) */
  cellWh: [number, number];
}

export interface GridLayout {
  n: number;
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  anchor: [number, number];
  W: number;
  H: number;
  upscale: number;
  scale: number;
  cells: GridCell[];
}

/** 接近正方形网格布局: cols=ceil(sqrt(n)), 每帧放大 upscale 倍, 帧间 gap 间隙, 四周 pad。
 *  方块布局(非长条)避开 AI 把长条切 tile 拉糊。像素(轴钉锚点/抠图后 bbox)在 Canvas 实现里补。
 *  fixedCols/fixedRows: 强制固定网格(如补丁的 4×4, n≤cols*rows-1 → 右下角恒空给 Gemini 水印, 导入丢弃)。 */
export function computeGridLayout(n: number, geo: Geometry, upscale = 2, gap = 14, pad = 18, fixedCols?: number, fixedRows?: number): GridLayout {
  const cols = fixedCols ?? (n ? Math.max(1, Math.ceil(Math.sqrt(n))) : 1);
  const rows = fixedRows ?? (n ? Math.max(1, Math.ceil(n / cols)) : 1);
  const cw = geo.cellW * upscale, ch = geo.cellH * upscale;
  const ax = geo.anchor[0] * upscale, ay = geo.anchor[1] * upscale;
  const W = pad * 2 + cols * cw + (cols - 1) * gap;
  const H = pad * 2 + rows * ch + (rows - 1) * gap;
  const cells: GridCell[] = [];
  for (let idx = 0; idx < n; idx++) {
    const r = Math.floor(idx / cols), c = idx % cols;
    cells.push({ cellXy: [pad + c * (cw + gap), pad + r * (ch + gap)], cellWh: [cw, ch] });
  }
  return { n, cols, rows, cw, ch, anchor: [ax, ay], W, H, upscale, scale: geo.scale, cells };
}
