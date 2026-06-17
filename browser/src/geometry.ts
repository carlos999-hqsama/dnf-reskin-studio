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

// 注: 旧的 computeContentGeometry (内容居中贴合几何) 已弃用删除 —— 它丢了游戏注册锚点, 对跳跃/倒地等
// 动作帧会各自居中乱飘 (导出乱)。导出/预览改用 workflow.segmentUnionGeo (按内容 bbox 的轴相对并集,
// 见 workflow.ts): 既紧贴本组姿势 (角色大), 又按 axis 摆放保帧间连贯。
