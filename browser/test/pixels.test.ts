// 纯 buffer 像素工具契约测试。
import { describe, it, expect } from 'vitest';
import type { RGBA } from '../src/model';
import { getBbox, crop, conformToDnf, canvasAtAxis, columnAlphaProfile, rowAlphaProfile } from '../src/pixels';
import { splitBounds } from '../src/align';

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

describe('getBbox', () => {
  it('内容包围盒 (x1/y1 exclusive)', () => {
    const img = rgba(4, 4, [0, 0, 0, 0]);
    setPx(img, 1, 1, [255, 0, 0, 255]);
    setPx(img, 2, 2, [0, 255, 0, 255]);
    expect(getBbox(img)).toEqual([1, 1, 3, 3]);
  });
  it('全透明 → null', () => expect(getBbox(rgba(2, 2, [0, 0, 0, 0]))).toBeNull());
});

describe('crop', () => {
  it('裁子矩形', () => {
    const img = rgba(4, 4, [0, 0, 0, 0]);
    setPx(img, 1, 1, [255, 0, 0, 255]);
    const c = crop(img, [1, 1, 2, 2]);
    expect([c.width, c.height]).toEqual([1, 1]);
    expect([c.data[0], c.data[3]]).toEqual([255, 255]);
  });
});

describe('conformToDnf (alpha 二值化硬边)', () => {
  it('≥阈值→255, 否则→0, RGB 不动', () => {
    const img = rgba(2, 1, [10, 20, 30, 255]);
    img.data[3] = 100; img.data[7] = 200;
    conformToDnf(img, 128);
    expect(img.data[3]).toBe(0);
    expect(img.data[7]).toBe(255);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([10, 20, 30]);
  });
});

describe('columnAlphaProfile / rowAlphaProfile (投影)', () => {
  it('列/行投影 = 该方向 alpha 均值', () => {
    // 2x2 alpha: (0,0)=0 (1,0)=100 (0,1)=200 (1,1)=100
    const img = rgba(2, 2, [0, 0, 0, 0]);
    setPx(img, 1, 0, [0, 0, 0, 100]); setPx(img, 0, 1, [0, 0, 0, 200]); setPx(img, 1, 1, [0, 0, 0, 100]);
    expect(columnAlphaProfile(img)).toEqual([100, 100]); // col0=(0+200)/2 col1=(100+100)/2
    expect(rowAlphaProfile(img)).toEqual([50, 150]);      // row0=(0+100)/2 row1=(200+100)/2
  });
  it('投影 + splitBounds 协作: 两列内容中间空 → 切中点', () => {
    // 6x2: 内容在 x=0,1 和 x=4,5, 中间 x=2,3 空 → 列投影 [255,255,0,0,255,255]
    const img = rgba(6, 2, [0, 0, 0, 0]);
    for (const y of [0, 1]) for (const x of [0, 1, 4, 5]) setPx(img, x, y, [0, 0, 0, 255]);
    expect(columnAlphaProfile(img)).toEqual([255, 255, 0, 0, 255, 255]);
    expect(splitBounds(columnAlphaProfile(img), 2, 6)).toEqual([0, 3, 6]); // 峰段[0,2)[4,6) 中点3
  });
});

describe('canvasAtAxis (恒等回环核心)', () => {
  it('轴对齐画布中心', () => {
    const img = rgba(1, 1, [255, 0, 0, 255]);
    const out = canvasAtAxis({ img, axis: [0, 0] }, 10); // 轴(0,0)→中心(5,5)
    expect(out[(5 * 10 + 5) * 3]).toBe(255);
  });
  it('裁剪+轴调整 → 字节相等 (drop-in 等价)', () => {
    // A: 3x3 中心红 轴(1,1); B: 1x1 红 轴(0,0) = A 裁到内容、轴减偏移
    const A = rgba(3, 3, [0, 0, 0, 0]);
    setPx(A, 1, 1, [255, 0, 0, 255]);
    const B = rgba(1, 1, [255, 0, 0, 255]);
    const ba = canvasAtAxis({ img: A, axis: [1, 1] }, 10);
    const bb = canvasAtAxis({ img: B, axis: [0, 0] }, 10);
    expect(Array.from(ba)).toEqual(Array.from(bb));
  });
});
