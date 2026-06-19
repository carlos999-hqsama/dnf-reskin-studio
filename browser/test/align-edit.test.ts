// 对齐编辑中间态契约测试 — 守住两层模型 (axis = relAxis + groupOffset) 的合成/锚原版/产出逻辑不回归。
// 纯数据运算 (无 Canvas), node 可测; resize 注入 nearest。配合 import.test (旧 importActionGrid 契约仍全过)。
import { describe, it, expect } from 'vitest';
import { commitSegmentEdit, autoGroupOffset } from '../src/workflow';
import type { SegmentEdit, OpenSubject } from '../src/workflow';
import { importActionGridFrames } from '../src/import';
import type { ImportMeta, ResizeFn } from '../src/import';
import type { RGBA, Cell } from '../src/model';

function fakeSprite(w = 2, h = 2): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
  return { data, width: w, height: h };
}
const nearest: ResizeFn = (img, w, h) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
    data[di] = img.data[si]!; data[di + 1] = img.data[si + 1]!; data[di + 2] = img.data[si + 2]!; data[di + 3] = img.data[si + 3]!;
  }
  return { data, width: w, height: h };
};

describe('commitSegmentEdit (合成 axis = relAxis + groupOffset → replaced)', () => {
  it('每帧 axis = relAxis + groupOffset; 先清这组旧帧 (含 AI 没画的空格)', () => {
    const replaced = new Map();
    const open = { replaced } as unknown as OpenSubject;
    const edit: SegmentEdit = {
      frames: [
        { g: 0, i: 0, sprite: fakeSprite(), relAxis: [10, 20] },
        { g: 0, i: 1, sprite: fakeSprite(), relAxis: [30, 40] },
      ],
      groupOffset: [5, -3],
    };
    replaced.set('0,2', { group: 0, image: 2, img: fakeSprite(), axis: [0, 0] }); // 空格旧帧, 应被清
    const cells: Cell[] = [[0, 0], [0, 1], [0, 2]];
    commitSegmentEdit(open, cells, edit);
    expect(replaced.get('0,0')!.axis).toEqual([15, 17]); // 10+5, 20-3
    expect(replaced.get('0,1')!.axis).toEqual([35, 37]); // 30+5, 40-3
    expect(replaced.has('0,2')).toBe(false);             // AI 没画的旧帧被清掉
    expect(replaced.size).toBe(2);
  });
  it('groupOffset=[0,0] → axis 即 relAxis (向后兼容旧自动定死行为)', () => {
    const replaced = new Map();
    commitSegmentEdit({ replaced } as unknown as OpenSubject, [[0, 0]],
      { frames: [{ g: 0, i: 0, sprite: fakeSprite(), relAxis: [7, 88] }], groupOffset: [0, 0] });
    expect(replaced.get('0,0')!.axis).toEqual([7, 88]);
  });
});

describe('autoGroupOffset (整组锚原版 = median(srcAxis) − median(relAxis))', () => {
  it('整组偏移 = 原版锚点中位 − 新帧锚点中位 (不逐帧贴)', () => {
    const edit: SegmentEdit = {
      frames: [
        { g: 0, i: 0, sprite: fakeSprite(), relAxis: [10, 10] },
        { g: 0, i: 1, sprite: fakeSprite(), relAxis: [20, 20] },
        { g: 0, i: 2, sprite: fakeSprite(), relAxis: [30, 30] },
      ],
      groupOffset: [0, 0],
    };
    const meta = {
      cells: [
        { g: 0, i: 0, bbox: [0, 0, 1, 1], srcAxis: [100, 200] },
        { g: 0, i: 1, bbox: [0, 0, 1, 1], srcAxis: [110, 210] },
        { g: 0, i: 2, bbox: [0, 0, 1, 1], srcAxis: [120, 220] },
      ],
    } as unknown as ImportMeta;
    // median(srcAxis)=[110,210], median(relAxis)=[20,20] → [90,190]
    expect(autoGroupOffset(edit, meta)).toEqual([90, 190]);
  });
  it('原版 axis 个别帧抖动不带歪整组 (中位抗极值)', () => {
    const edit: SegmentEdit = {
      frames: [
        { g: 0, i: 0, sprite: fakeSprite(), relAxis: [0, 0] },
        { g: 0, i: 1, sprite: fakeSprite(), relAxis: [0, 0] },
        { g: 0, i: 2, sprite: fakeSprite(), relAxis: [0, 0] },
      ],
      groupOffset: [0, 0],
    };
    // 中间帧 srcAxis 暴抖 (+999), 中位仍取 [50,50] → 不被极值带歪
    const meta = {
      cells: [
        { g: 0, i: 0, bbox: [0, 0, 1, 1], srcAxis: [50, 50] },
        { g: 0, i: 1, bbox: [0, 0, 1, 1], srcAxis: [999, 999] },
        { g: 0, i: 2, bbox: [0, 0, 1, 1], srcAxis: [50, 50] },
      ],
    } as unknown as ImportMeta;
    expect(autoGroupOffset(edit, meta)).toEqual([50, 50]);
  });
  it('无 srcAxis (旧 meta) → [0,0]', () => {
    const edit: SegmentEdit = { frames: [{ g: 0, i: 0, sprite: fakeSprite(), relAxis: [10, 10] }], groupOffset: [0, 0] };
    expect(autoGroupOffset(edit, { cells: [{ g: 0, i: 0, bbox: [0, 0, 1, 1] }] } as unknown as ImportMeta)).toEqual([0, 0]);
  });
});

describe('importActionGridFrames (产出可编辑中间态 = importActionGrid 的拆分上游)', () => {
  it('产出 EditFrame[]: sprite + 预对齐 relAxis (与 importActionGrid 同口径)', () => {
    const W = 24, H = 12, data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) { data[i + 1] = 255; data[i + 3] = 255; } // 绿底
    for (let y = 2; y < 10; y++) for (let x = 4; x < 8; x++) { const i = (y * W + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255; } // 格0 红块 4×8
    const meta: ImportMeta = { n: 1, cols: 1, rows: 1, W, H, upscale: 1, scale: 1, cells: [{ g: 0, i: 0, bbox: [10, 20, 30, 80] }] };
    const frames = importActionGridFrames({ data, width: W, height: H }, meta, { resize: nearest });
    expect(frames.length).toBe(1);
    const f = frames[0]!;
    expect([f.g, f.i]).toEqual([0, 0]);
    // 无 targetH → 回退 targetH=(80-20)/k=60; nw=4 nh=8 s=7.5 → 30×60; relAxis=底部中心 (15,60) (同 import.test f0.axis)
    expect([f.sprite.width, f.sprite.height]).toEqual([30, 60]);
    expect(f.relAxis).toEqual([15, 60]);
  });
  it('空格 (AI 没画) → 不产 EditFrame', () => {
    const W = 24, H = 12, data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) { data[i + 1] = 255; data[i + 3] = 255; }
    for (let y = 2; y < 10; y++) for (let x = 4; x < 8; x++) { const i = (y * W + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255; } // 只画格0
    const meta: ImportMeta = { n: 2, cols: 2, rows: 1, W, H, upscale: 1, scale: 1, cells: [{ g: 0, i: 0, bbox: [10, 20, 30, 80] }, { g: 0, i: 1, bbox: [10, 20, 30, 80] }] };
    const frames = importActionGridFrames({ data, width: W, height: H }, meta, { resize: nearest });
    expect(frames.map((f) => `${f.g},${f.i}`)).toEqual(['0,0']); // 格1 全绿 → 空 → 不产
  });
});
