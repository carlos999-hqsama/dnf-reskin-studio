// importActionGrid 串接契约测试 — 注入纯 JS nearest resize, 在 node 验证
// "投影切格 + per-cell 去背 + 内容 bbox + 缩放归一 + 脚底锚定定位" 整条串接逻辑。
// (resize 质量 [Canvas LANCZOS] 走 preview 真浏览器; 这里验串接对位/定位算得对。)
import { describe, it, expect } from 'vitest';
import type { RGBA } from '../src/model';
import { importActionGrid, type ImportMeta, type ResizeFn } from '../src/import';

function greenGrid(w: number, h: number): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i + 1] = 255; data[i + 3] = 255; } // 绿底 (0,255,0,255)
  return { data, width: w, height: h };
}
function fillRect(img: RGBA, x0: number, y0: number, x1: number, y1: number, c: [number, number, number, number]): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
  }
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

describe('importActionGrid (网格图 → 替换帧)', () => {
  it('两格: 投影切分 + 去绿 + 脚底锚定定位 + 尺度归一', () => {
    // 24×12 绿底, 格0 红块 4×8@(4,2), 格1 蓝块 4×8@(16,2) → 列投影峰段 [4,8)[16,20) 中点切 12
    const img = greenGrid(24, 12);
    fillRect(img, 4, 2, 8, 10, [255, 0, 0, 255]);
    fillRect(img, 16, 2, 20, 10, [0, 0, 255, 255]);
    const meta: ImportMeta = {
      n: 2, cols: 2, rows: 1, W: 24, H: 12, upscale: 1, scale: 1,
      cells: [{ g: 0, i: 0, bbox: [10, 20, 30, 80] }, { g: 0, i: 1, bbox: [10, 20, 30, 80] }],
    };
    const out = importActionGrid(img, meta, { resize: nearest });
    expect(out.size).toBe(2);
    const f0 = out.get('0,0')!;
    // 无 targetH → 回退 targetH=(bbox高 80-20)/k=60; nw=4 nh=8 s=60/8=7.5 → 30×60; 轴=底部中心 (15,60)
    expect([f0.img.width, f0.img.height]).toEqual([30, 60]);
    expect(f0.axis).toEqual([15, 60]);
    // 去绿生效: resize 后帧里应有红色实心像素, 无残留绿底实心 (绿被 floodKey 抠成透明)
    let red = 0, solidGreen = 0;
    for (let p = 0; p < f0.img.data.length; p += 4) {
      const r = f0.img.data[p]!, g = f0.img.data[p + 1]!, b = f0.img.data[p + 2]!, a = f0.img.data[p + 3]!;
      if (a > 200 && r > 200 && g < 60 && b < 60) red++;
      if (a > 200 && g > 200 && r < 60 && b < 60) solidGreen++;
    }
    expect(red).toBeGreaterThan(0);
    expect(solidGreen).toBe(0);
  });

  it('健壮对齐: 异尺寸/异位置内容统一缩到 targetH + 轴=底部中心 (补丁不左右闪、与头身比脱钩)', () => {
    // 两格内容尺寸/位置都不同 (模拟 AI 把异比例角色画得参差): 格0 红 4×8(瘦高), 格1 蓝 8×4(矮宽、偏下)。
    const img = greenGrid(24, 12);
    fillRect(img, 3, 2, 7, 10, [255, 0, 0, 255]);   // 格0: 4×8 @(3,2)
    fillRect(img, 14, 5, 22, 9, [0, 0, 255, 255]);  // 格1: 8×4 @(14,5)
    const meta: ImportMeta = {
      n: 2, cols: 2, rows: 1, W: 24, H: 12, upscale: 1, scale: 1, targetH: 30,
      cells: [{ g: 0, i: 0, bbox: [0, 0, 1, 1] }, { g: 0, i: 1, bbox: [0, 0, 1, 1] }], // 有 targetH → bbox 不参与
    };
    const out = importActionGrid(img, meta, { resize: nearest });
    const f0 = out.get('0,0')!, f1 = out.get('0,1')!;
    // 关键: 两帧高度都=targetH(30)、不随各自原始尺寸变 → 不闪不变形; 轴 y=高(底)、轴 x=宽/2(中心)
    expect(f0.img.height).toBe(30);
    expect(f1.img.height).toBe(30);
    expect(f0.axis).toEqual([Math.round(f0.img.width / 2), 30]);
    expect(f1.axis).toEqual([Math.round(f1.img.width / 2), 30]);
    // 宽度各自保宽高比 (4:8→15, 8:4→60), 不被对方/原版带歪
    expect(f0.img.width).toBe(15);            // 4 * (30/8)
    expect(f1.img.width).toBe(60);            // 8 * (30/4)
  });

  it('家锚 baseDX/baseDY: 轴 = 底部中心 + 家锚 (落地不飘 + 钉一致中心, 修企鹅飘天上)', () => {
    // 单格红块 4×8; baseDX=100 baseDY=200 模拟 DNF basePt 远在内容右下外侧 (原版 offset_y≫内容高)。
    const img = greenGrid(24, 12);
    fillRect(img, 4, 2, 8, 10, [255, 0, 0, 255]);
    const meta: ImportMeta = {
      n: 1, cols: 1, rows: 1, W: 24, H: 12, upscale: 1, scale: 1, targetH: 8, baseDX: 100, baseDY: 200,
      cells: [{ g: 0, i: 0, bbox: [0, 0, 1, 1] }],
    };
    const f = importActionGrid(img, meta, { resize: nearest }).get('0,0')!;
    // nh=8 s=8/8=1 → 4×8; 轴 = (4/2 + 100, 8 + 200) = (102, 208) → 帧钉到原版 basePt 远点 (不飘/不抖)
    expect([f.img.width, f.img.height]).toEqual([4, 8]);
    expect(f.axis).toEqual([102, 208]);
  });

  it('空格 (AI 没画该帧) → 跳过, 不产替换帧', () => {
    const img = greenGrid(24, 12);
    fillRect(img, 4, 2, 8, 10, [255, 0, 0, 255]); // 只画格0
    const meta: ImportMeta = {
      n: 2, cols: 2, rows: 1, W: 24, H: 12, upscale: 1, scale: 1,
      cells: [{ g: 0, i: 0, bbox: [10, 20, 30, 80] }, { g: 0, i: 1, bbox: [10, 20, 30, 80] }],
    };
    const out = importActionGrid(img, meta, { resize: nearest });
    expect(out.has('0,0')).toBe(true);
    expect(out.has('0,1')).toBe(false); // 格1 全绿 → 去背后空 → 跳过
  });
});

function solidGrid(w: number, h: number, bg: [number, number, number]): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255; }
  return { data, width: w, height: h };
}

describe('despill 开关 (背景色切换: 非绿底不削绿, 别误伤绿色角色)', () => {
  // 品红底 + 一个偏绿角色块 [40,200,60] (g>r&&g>b → 正是 despill 会削的那种)。
  function magentaCell(): { img: RGBA; meta: ImportMeta } {
    const img = solidGrid(12, 12, [255, 0, 255]);
    fillRect(img, 3, 2, 9, 10, [40, 200, 60, 255]);
    const meta: ImportMeta = {
      n: 1, cols: 1, rows: 1, W: 12, H: 12, upscale: 1, scale: 1,
      cells: [{ g: 0, i: 0, bbox: [10, 20, 30, 80] }],
    };
    return { img, meta };
  }
  function maxGreen(fr: { img: RGBA }): number {
    let m = 0;
    for (let p = 0; p < fr.img.data.length; p += 4) {
      const r = fr.img.data[p]!, g = fr.img.data[p + 1]!, b = fr.img.data[p + 2]!, a = fr.img.data[p + 3]!;
      if (a > 200 && g > r && g > b) m = Math.max(m, g);
    }
    return m;
  }
  it('品红底 bgKey → 自动跳 despill, 角色绿色保留 (g≈200)', () => {
    const { img, meta } = magentaCell();
    const out = importActionGrid(img, meta, { resize: nearest, bgKey: [255, 0, 255] });
    expect(maxGreen(out.get('0,0')!)).toBeGreaterThan(150);
  });
  it('强制 despill:true → 同样的绿被中和到 max(r,b)≈60', () => {
    const { img, meta } = magentaCell();
    const out = importActionGrid(img, meta, { resize: nearest, bgKey: [255, 0, 255], despill: true });
    expect(maxGreen(out.get('0,0')!)).toBeLessThan(120);
  });
});
