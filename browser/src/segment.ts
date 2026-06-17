// 动作帧均分定长分组 — 对应 Python core/segment.py。
// 把一个动作的去重帧按顺序每 groupSize 帧切一组 (默认 9 = 3×3 九宫格, 整批喂 AI)。
import type { Action, Cell } from './model';
import { uniqueCells } from './model';

export interface Segment {
  /** 组号 (从 1 起) */
  index: number;
  /** 组内首帧在 uniqueCells 里的序号 */
  start: number;
  /** 末帧序号 (含) */
  end: number;
  /** 该组的 (group, image) 帧坐标 */
  keys: Cell[];
}

/** 去重帧每 groupSize 切一组; 末组若 < 半组就并进前一组 (免落单一两帧)。
 *  mergeShortTail=false: 不并尾组 → 每组严格 ≤ groupSize (固定网格容量场景必须, 否则并入会超格)。 */
export function segmentAction(action: Action, groupSize = 9, mergeShortTail = true): Segment[] {
  const keys = uniqueCells(action);
  const gs = Math.max(1, groupSize);
  const starts: number[] = [];
  for (let s = 0; s < keys.length; s += gs) starts.push(s);
  if (mergeShortTail && starts.length >= 2 && keys.length - starts[starts.length - 1]! < gs / 2) {
    starts.pop(); // 末组太短 → 并进前一组
  }
  const segs: Segment[] = [];
  for (let n = 0; n < starts.length; n++) {
    const s = starts[n]!;
    const e = n + 1 < starts.length ? starts[n + 1]! : keys.length;
    segs.push({ index: n + 1, start: s, end: e - 1, keys: keys.slice(s, e) });
  }
  return segs;
}
