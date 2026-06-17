// 锚点外延 / 格尺寸 / scale — 对应 Python core/geometry.py:compute_geometry。
import type { SpriteSet, Cell, XY } from './model';

export const MARGIN = 8;

export interface Geometry {
  cellW: number;
  cellH: number;
  anchor: XY;
  scale: number;
}

/** 按"所有出现帧的最大外延"算统一格尺寸 + 锚点 + scale。
 *  外延: 上=axis_y, 下=h-axis_y, 左=axis_x, 右=w-axis_x; 取各方向最大。
 *  Python int() 截断 → Math.trunc (正数=floor)。 */
export function computeGeometry(
  frames: SpriteSet,
  cells: Iterable<Cell>,
  maxcell = 300,
  margin = MARGIN,
  scaleOverride?: number,
): Geometry {
  let mU = 1, mD = 1, mL = 1, mR = 1;
  for (const [g, i] of cells) {
    const fr = frames.get(g, i);
    if (!fr) continue;
    const [w, h] = fr.size;
    const [ax, ay] = fr.axis;
    mU = Math.max(mU, ay);
    mD = Math.max(mD, h - ay);
    mL = Math.max(mL, ax);
    mR = Math.max(mR, w - ax);
  }
  let cw = mL + mR + 2 * margin;
  let ch = mU + mD + 2 * margin;
  let anchor: XY = [mL + margin, mU + margin];
  let scale: number;
  if (scaleOverride !== undefined) {
    scale = scaleOverride; // 分组视图: 沿用整动作全局缩放
  } else {
    scale = 1.0;
    if (Math.max(cw, ch) > maxcell) scale = maxcell / Math.max(cw, ch);
  }
  cw = Math.trunc(cw * scale);
  ch = Math.trunc(ch * scale);
  anchor = [Math.trunc(anchor[0] * scale), Math.trunc(anchor[1] * scale)];
  return { cellW: cw, cellH: ch, anchor, scale };
}

/** 内容贴合几何 — cell = 各帧【自身尺寸】的最大值 (不含脚底锚远点撑出的运动并集)，让单帧内容
 *  填满格子、不再被"举武器/跳跃"的极端帧把所有格子撑大。脚底锚点改成 per-cell (渲染时按内容
 *  居中位置 + 该帧 axis 算，可落格外)，故这里 anchor 只给占位 [0,0] (导出/预览各自用 per-cell)。
 *  用于导出网格 (buildActionGridCanvas) 与左右栏单帧缩略；动画预览仍用 computeGeometry (运动并集
 *  保帧间位置连贯，否则逐帧重心居中会抖)。 */
export function computeContentGeometry(
  frames: SpriteSet,
  cells: Iterable<Cell>,
  maxcell = 300,
  margin = MARGIN,
): Geometry {
  let mw = 1, mh = 1;
  for (const [g, i] of cells) {
    const fr = frames.get(g, i);
    if (!fr) continue;
    mw = Math.max(mw, fr.size[0]);
    mh = Math.max(mh, fr.size[1]);
  }
  let cw = mw + 2 * margin, ch = mh + 2 * margin;
  let scale = 1.0;
  if (Math.max(cw, ch) > maxcell) scale = maxcell / Math.max(cw, ch);
  cw = Math.trunc(cw * scale);
  ch = Math.trunc(ch * scale);
  return { cellW: cw, cellH: ch, anchor: [0, 0], scale };
}
