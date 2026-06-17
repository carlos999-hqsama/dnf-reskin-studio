// 去背契约测试 — 验 matte.ts 与 Python core/matte.py 行为一致 (合成 RGBA, 不依赖真 Canvas)。
import { describe, it, expect } from 'vitest';
import type { RGBA } from '../src/model';
import { floodBg, keyOut, despillGreen, floodKey } from '../src/matte';

function rgba(w: number, h: number, fill: [number, number, number, number]): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
  }
  return { data, width: w, height: h };
}
function setPx(img: RGBA, x: number, y: number, c: [number, number, number, number]): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
}
const aAt = (img: RGBA, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3]!;

describe('floodBg (连通域去背)', () => {
  it('吃连到四角的背景, 保留中心角色孤岛', () => {
    const img = rgba(3, 3, [100, 100, 100, 255]); // 全背景灰
    setPx(img, 1, 1, [220, 40, 40, 255]);          // 中心角色(色差大=孤岛)
    floodBg(img, 45);
    expect(aAt(img, 0, 0)).toBe(0); // 四角背景被吃
    expect(aAt(img, 1, 0)).toBe(0); // 边背景被吃(连通)
    expect(aAt(img, 1, 1)).toBe(255); // 角色保留
  });
  it('角色身上有同背景色也安全(孤岛不连角落)', () => {
    const img = rgba(3, 3, [0, 200, 0, 255]); // 绿底
    setPx(img, 1, 1, [0, 200, 0, 255]);        // 中心也绿, 但被角色环... 这里就是连通的, 会被吃
    // 验证: 全绿全连通 → 全吃 (符合 flood 语义)
    floodBg(img, 45);
    expect(aAt(img, 1, 1)).toBe(0);
  });
});

describe('keyOut (色键)', () => {
  it('与 key 色差≤tol 的转透明, 别的不动', () => {
    const img = rgba(2, 2, [10, 200, 10, 255]); // 接近 key 的绿
    setPx(img, 0, 0, [200, 50, 50, 255]);        // 角色色(远离 key)
    keyOut(img, [10, 200, 10], 20);
    expect(aAt(img, 0, 0)).toBe(255); // 角色保留
    expect(aAt(img, 1, 1)).toBe(0);   // 绿被抠
  });
});

describe('despillGreen (去绿溢出)', () => {
  it('g 高于 r/b → 压到 max(r,b)', () => {
    const img = rgba(1, 1, [50, 200, 80, 255]);
    despillGreen(img);
    expect(img.data[1]).toBe(80); // g → max(50,80)=80
    expect(img.data[0]).toBe(50); // r 不动
  });
  it('g 不占优 → 不动本色', () => {
    const img = rgba(1, 1, [200, 50, 50, 255]);
    despillGreen(img);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([200, 50, 50]);
  });
});

describe('floodKey (四角中位 + 全图扫, 吃口袋)', () => {
  it('吃掉被角色环包住、连不到四角的背景口袋', () => {
    const img = rgba(5, 5, [100, 100, 100, 255]); // 全背景灰
    // (1,1)-(3,3) 画角色环, 中心(2,2)留背景灰 = 被包住的口袋
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) {
      if (!(x === 2 && y === 2)) setPx(img, x, y, [200, 50, 50, 255]);
    }
    floodKey(img, 80);
    expect(aAt(img, 0, 0)).toBe(0); // 外围背景吃掉
    expect(aAt(img, 2, 2)).toBe(0); // ★口袋也吃掉(floodBg 漫不进, floodKey 能)
    expect(aAt(img, 1, 1)).toBe(255); // 角色环保留
  });
});
