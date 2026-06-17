// 纯 buffer 像素工具 — 不依赖 Canvas, 可在 node/vitest 测。
// bbox/crop/硬边/轴对齐画布 对应 PIL 的 getbbox/crop + dnf._conform_to_dnf + importer.canvas_at_axis。
import type { RGBA, XY } from './model';

/** 非透明内容包围盒 [x0,y0,x1,y1] (x1/y1 exclusive, 同 PIL getbbox); 全透明返回 null。 */
export function getBbox(img: RGBA): [number, number, number, number] | null {
  const { data, width: w, height: h } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3]!) {
        found = true;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return found ? [x0, y0, x1 + 1, y1 + 1] : null;
}

/** 裁子矩形 (复制), box=[x0,y0,x1,y1] exclusive。对应 PIL crop。 */
export function crop(img: RGBA, box: [number, number, number, number]): RGBA {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * img.width + (x0 + x)) * 4, di = (y * w + x) * 4;
      data[di] = img.data[si]!; data[di + 1] = img.data[si + 1]!;
      data[di + 2] = img.data[si + 2]!; data[di + 3] = img.data[si + 3]!;
    }
  }
  return { data, width: w, height: h };
}

/** AI 全彩软边图 → DNF 硬边: alpha 二值化(≥阈值=255 否则 0), 颜色不动。对应 dnf._conform_to_dnf。
 *  原地改 alpha。 */
export function conformToDnf(img: RGBA, threshold = 128): RGBA {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) data[i + 3] = data[i + 3]! >= threshold ? 255 : 0;
  return img;
}

/** 列投影: 每列 alpha 均值 (长度=width)。对应 PIL alpha.resize((W,1), BOX) 取 getdata —
 *  全高度面积平均。投影法切分(splitBounds)靠它找内容峰段, 鲁棒于人物在格里偏移/跨格。 */
export function columnAlphaProfile(img: RGBA): number[] {
  const { data, width: w, height: h } = img;
  const prof = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) prof[x]! += data[(row + x) * 4 + 3]!;
  }
  if (h > 0) for (let x = 0; x < w; x++) prof[x]! /= h;
  return prof;
}

/** 行投影: 每行 alpha 均值 (长度=height)。对应 PIL alpha.resize((1,H), BOX) 取 getdata。 */
export function rowAlphaProfile(img: RGBA): number[] {
  const { data, width: w, height: h } = img;
  const prof = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) s += data[(row + x) * 4 + 3]!;
    prof[y] = w > 0 ? s / w : 0;
  }
  return prof;
}

/** 把精灵按轴贴到 S×S 画布(轴对齐画布中心)再压黑底, 返回 RGB 字节。
 *  裁剪/透明边差异被抹平, 只要可见像素同位置同色 → 字节相等 = 渲染等价 (恒等回环自检)。
 *  对应 importer.canvas_at_axis。 */
export function canvasAtAxis(fr: { img: RGBA; axis: XY }, S = 600): Uint8ClampedArray {
  const out = new Uint8ClampedArray(S * S * 3); // 黑底 (0,0,0)
  const { img, axis } = fr;
  const ax = Math.round(axis[0]), ay = Math.round(axis[1]);
  const ox = Math.floor(S / 2) - ax, oy = Math.floor(S / 2) - ay; // 轴对齐画布中心 (Python S//2 - axis)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3]!;
      if (a === 0) continue;
      const px = ox + x, py = oy + y;
      if (px < 0 || px >= S || py < 0 || py >= S) continue;
      const si = (y * img.width + x) * 4, di = (py * S + px) * 3;
      const af = a / 255; // alpha composite over black: src*a (black=0)
      out[di] = Math.round(img.data[si]! * af);
      out[di + 1] = Math.round(img.data[si + 1]! * af);
      out[di + 2] = Math.round(img.data[si + 2]! * af);
    }
  }
  return out;
}
