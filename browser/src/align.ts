// 对齐数学 — 对应 Python core/importer.py 的 foot_anchor_axis + _split_bounds。
// 纯几何/数组运算, 与格式/像素无关。这是补丁对齐的精密核心, 重写须逐项等价 (有契约测试护着)。
import type { XY } from './model';

/** 脚底锚定 = 对齐的唯一口径。新精灵底部中心对齐原版 basePt:
 *  水平保中心 axis_x = 原axis_x + (原宽-新宽)/2; 垂直保底 axis_y = 原axis_y + (原高-新高)。
 *  同尺寸 → 轴 = 原版 basePt 本身 (ΔX=ΔY=0)。对应 importer.foot_anchor_axis。 */
export function footAnchorAxis(origSize: XY, origAxis: XY, newSize: XY): XY {
  const [opw, oph] = origSize;
  const [obx, oby] = origAxis;
  const [npw, nph] = newSize;
  return [Math.round(obx + (opw - npw) / 2), Math.round(oby + (oph - nph))];
}

/** 投影法找内容分界。profile = 沿某轴的内容浓度(列/行投影)。找 n 个内容峰段 →
 *  返回 n+1 个切分边界(峰段间隙中点)。峰段<n 返回 null(调用方回退等分);
 *  峰段>n 合并间隙最小的相邻段。对应 importer._split_bounds。 */
export function splitBounds(profile: number[], n: number, length: number): number[] | null {
  if (n <= 1) return [0, length];
  const mx = profile.length ? Math.max(...profile) : 0;
  if (mx <= 0) return null;
  const thr = mx * 0.06; // 内容阈值: 投影 > 峰值6% 算有人
  const runs: [number, number][] = [];
  let i = 0;
  const L = profile.length;
  while (i < L) {
    if (profile[i]! > thr) {
      let j = i;
      while (j < L && profile[j]! > thr) j++;
      runs.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  if (runs.length < n) return null;
  while (runs.length > n) {
    // 间隙最小的相邻两段并回 (同一人物被分裂的碎块)
    let gi = 0, best = Infinity;
    for (let r = 0; r < runs.length - 1; r++) {
      const gap = runs[r + 1]![0] - runs[r]![1];
      if (gap < best) { best = gap; gi = r; }
    }
    runs[gi]![1] = runs[gi + 1]![1];
    runs.splice(gi + 1, 1);
  }
  const bounds = [0];
  for (let r = 0; r < n - 1; r++) {
    bounds.push(Math.floor((runs[r]![1] + runs[r + 1]![0]) / 2)); // 边界=相邻峰段空隙中点 (Python // floor)
  }
  bounds.push(length);
  return bounds;
}
