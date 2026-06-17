// 去背 — 对应 Python core/matte.py。统一用 floodBg(四角种子连通域), 不是简单色键。
// 全在 RGBA buffer 上操作(原地改 alpha, RGB 保留), 与 Canvas 无关 → 可合成测。
import type { RGBA } from './model';

/** 四角种子 + 区域生长连通域去背。邻居与【当前像素】色差≤tol 才并入 → 顺背景渐变一路走,
 *  撞角色硬边(大跳变)即停, 角色孤岛不连角落即安全。对应 matte.flood_bg。 */
export function floodBg(img: RGBA, tol = 45): RGBA {
  const { data, width: w, height: h } = img;
  if (w < 2 || h < 2) return img;
  const t2 = tol * tol;
  const seen = new Uint8Array(w * h);
  const qx: number[] = [], qy: number[] = [];
  for (const [sx, sy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
    const i = sy * w + sx;
    if (!seen[i] && data[i * 4 + 3] !== 0) { seen[i] = 1; qx.push(sx); qy.push(sy); }
  }
  let head = 0;
  while (head < qx.length) {
    const x = qx[head]!, y = qy[head]!; head++;
    const ci = (y * w + x) * 4;
    const cr = data[ci]!, cg = data[ci + 1]!, cb = data[ci + 2]!; // 当前像素色(读后再清 alpha)
    data[ci + 3] = 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const ni = ny * w + nx;
        if (!seen[ni]) {
          const pi = ni * 4;
          const dr = data[pi]! - cr, dg = data[pi + 1]! - cg, db = data[pi + 2]! - cb;
          if (data[pi + 3]! && dr * dr + dg * dg + db * db <= t2) {
            seen[ni] = 1; qx.push(nx); qy.push(ny);
          }
        }
      }
    }
  }
  return img;
}

/** 色键去背(辅助): 与 key 色差≤tol 的不透明像素转透明。抠洋红标记线 / 手动选色补刀。
 *  对应 matte.key_out。 */
export function keyOut(img: RGBA, key: readonly [number, number, number], tol: number): RGBA {
  const { data } = img;
  const [kr, kg, kb] = key;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! &&
        Math.abs(data[i]! - kr) <= tol &&
        Math.abs(data[i + 1]! - kg) <= tol &&
        Math.abs(data[i + 2]! - kb) <= tol) {
      data[i + 3] = 0;
    }
  }
  return img;
}

/** 去绿幕溢出: 不透明像素若 green 明显高于 red/blue, 把 green 压到 max(r,b) → 中和边缘残绿。
 *  对应 matte.despill_green (Python int() 截断 → Math.trunc)。 */
export function despillGreen(img: RGBA, amount = 1.0): RGBA {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    if (data[i + 3]! && g > r && g > b) {
      const cap = Math.max(r, b);
      data[i + 1] = Math.trunc(g - (g - cap) * amount);
    }
  }
  return img;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 四角中位背景色 + 全图色键: 自适应任何纯色幕, 还吃掉被角色包住、连不到四角的背景口袋
 *  (手指缝/手臂弯)。对应 matte.flood_key。 */
export function floodKey(img: RGBA, tol = 80): RGBA {
  const { data, width: w, height: h } = img;
  if (w < 2 || h < 2) return img;
  const cs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (const [cx, cy] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
    const i = (cy * w + cx) * 4;
    if (data[i + 3] !== 0) { cs.push(data[i]!); gs.push(data[i + 1]!); bs.push(data[i + 2]!); }
  }
  if (!cs.length) return img;
  const cr = median(cs), cg = median(gs), cb = median(bs);
  const t2 = tol * tol;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]!) {
      const dr = data[i]! - cr, dg = data[i + 1]! - cg, db = data[i + 2]! - cb;
      if (dr * dr + dg * dg + db * db <= t2) data[i + 3] = 0;
    }
  }
  return img;
}
