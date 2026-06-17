// 导入: AI 重绘的网格图 → 替换帧。照搬 Python core/importer.py 的 import_action_grid 全流程。
// 投影法切格(鲁棒于人物偏移/跨格) → 每格去背(floodKey 自适应 + despill 中和残绿) → 内容 bbox →
// 统一缩到角色基准高 targetH(保宽高比) + 轴=内容底部中心。算法件全已单测; 只 resize 走 Canvas
// (与 PIL LANCZOS 不逐字节, 靠 preview 真浏览器验对齐) → 做成依赖注入, node 可注 nearest 测串接。
import type { RGBA, XY } from './model';
import { keyOut, floodKey, floodBg, despillGreen, defringeGreen } from './matte';
import { getBbox, crop, columnAlphaProfile, rowAlphaProfile } from './pixels';
import { splitBounds } from './align';

/** 一格的导入契约: 哪帧 (g,i) + 导出时该格渲染后内容框 bbox (放大 cell 坐标系)。
 *  cellXy/cellWh 是导出布局位置, 导入不用(投影法重检测), 仅调试/参考。 */
export interface ImportCell {
  g: number;
  i: number;
  bbox: [number, number, number, number];
  cellXy?: [number, number];
  cellWh?: [number, number];
}

/** 导出/导入契约 (buildActionGridCanvas 产出 → importActionGrid 消费)。对应 render.build_action_grid 的 meta。 */
export interface ImportMeta {
  n: number;
  cols: number;
  rows: number;
  W: number;
  H: number;
  /** 导出放大倍数 */
  upscale: number;
  /** 几何缩放 (原帧→格子; DNF 大画布 <1) */
  scale: number;
  /** 角色基准内容高 (原版中位内容高, 原生 px)。健壮对齐: 新内容统一缩到它 → 与原版逐帧高度/头身比脱钩, 不抖。
   *  缺省 (旧 meta) 时按各格 bbox 回退。 */
  targetH?: number;
  /** "家锚"偏移 (原版 basePt 相对内容底部中心的中位偏移, 原生 px)。补丁轴 = 新内容底部中心 + (baseDX, baseDY):
   *  baseDY 把帧落到原版脚底(不飘), baseDX 钉一致水平中心(不左右抖)。缺省回退 0 (=纯底部中心)。 */
  baseDX?: number;
  baseDY?: number;
  cells: ImportCell[];
}

/** 替换帧: importActionGrid 产出, 喂 conformToDnf + encodePng + engine.repack。 */
export interface ImportedFrame {
  group: number;
  image: number;
  img: RGBA;
  axis: XY;
}

export type ResizeFn = (img: RGBA, w: number, h: number) => RGBA;

function cloneRGBA(img: RGBA): RGBA {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** 等分边界 (投影切分凑不齐 n 段时回退)。对应 importer.py 的 [round(c*L/n) ...]。 */
function equalBounds(n: number, length: number): number[] {
  const b: number[] = [];
  for (let c = 0; c <= n; c++) b.push(Math.round((c * length) / n));
  return b;
}

/** Canvas 缩放 (默认 resize, 浏览器): imageSmoothing high ≈ PIL LANCZOS (不逐字节, preview 验)。
 *  module load 时只定义不执行 → node import import.ts 不碰 document; 测试注入纯 JS resize 即可。 */
const canvasResize: ResizeFn = (img, w, h) => {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, img.width, img.height, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { data: d.data, width: w, height: h };
};

/** AI 网格图 → {(g,i) → 替换帧}。meta 来自导出 (buildActionGridCanvas)。
 *
 *  流程 (照搬 importer.import_action_grid):
 *  1. (可选) bgKey 色键补刀。
 *  2. 投影法检测列/行边界: 整图 floodKey+despill 后取 alpha → 列/行投影 → splitBounds
 *     (峰段凑不齐 cols×rows 回退等分; 鲁棒于人物在格里偏移/跨格)。
 *  3. 每格: crop → floodKey(per-cell 背景自适应) + despill(中和残绿) → 内容 bbox →
 *     统一缩到角色基准高 meta.targetH(保宽高比) → 轴=内容底部中心 (与原版逐帧/头身比脱钩, 不左右闪)。
 */
export function importActionGrid(
  img: RGBA, meta: ImportMeta,
  opts: { bgKey?: readonly [number, number, number]; keyTol?: number; resize?: ResizeFn; despill?: boolean; algo?: 'floodkey' | 'floodbg' } = {},
): Map<string, ImportedFrame> {
  const resize = opts.resize ?? canvasResize;
  const keyTol = opts.keyTol ?? 34;
  const IW = img.width, IH = img.height;

  // 抠图算法 (matte): floodkey=四角中位全图色键(默认, 快, 撞色会吃角色); floodbg=四角连通域
  // (只吃连到角落的背景, 角色身上同色的孤岛保得住 → 撞色用它)。对应右栏"抠图算法"下拉。
  const algo = opts.algo ?? 'floodkey';
  const floodMatte = (im: RGBA): RGBA => (algo === 'floodbg' ? floodBg(im) : floodKey(im));

  // despill 削绿幕溢出: 只在【绿底】用 — 它会削任何 g>r&&g>b 的像素, 非绿底会误伤绿色角色
  // (恰是换非绿底想保护的)。floodKey 已自适应去任何纯色底, 故非绿底只去背、不削绿。
  // 显式 despill 优先; 否则按 bgKey 是否绿系自动判 (不传 bgKey = 默认绿幕流程 → 削)。
  const isGreen = (k: readonly [number, number, number]): boolean => k[1] > k[0] && k[1] > k[2];
  const despill = opts.despill ?? (opts.bgKey ? isGreen(opts.bgKey) : true);
  // 绿底流程: 先 defringe 抹掉绿污染 AA 暗边, 再 despill 中和残绿 (顺序不能反 — 反了暗边已成形)。
  const dsp = (im: RGBA): RGBA => (despill ? despillGreen(defringeGreen(im)) : im);

  let work = cloneRGBA(img);
  if (opts.bgKey) work = keyOut(work, opts.bgKey, keyTol);

  // 投影检测: 整图抠一次 (floodMatte 自适应背景 + despill) 取 alpha → 列/行投影。
  const det = dsp(floodMatte(cloneRGBA(work)));
  const colB = splitBounds(columnAlphaProfile(det), meta.cols, IW) ?? equalBounds(meta.cols, IW);
  const rowB = splitBounds(rowAlphaProfile(det), meta.rows, IH) ?? equalBounds(meta.rows, IH);

  const k = (meta.upscale || 1) * (meta.scale || 1);
  const out = new Map<string, ImportedFrame>();
  meta.cells.forEach((cell, idx) => {
    const gr = Math.floor(idx / meta.cols), gc = idx % meta.cols;
    const x0 = colB[gc]!, y0 = rowB[gr]!, x1 = colB[gc + 1]!, y1 = rowB[gr + 1]!;
    if (x1 <= x0 || y1 <= y0) return;
    const sub = dsp(floodMatte(crop(work, [x0, y0, x1, y1]))); // crop 出副本 → 原地抠不污染 work
    const nb = getBbox(sub);
    if (!nb) return;                                       // 空格 (该帧 AI 没画) 跳过
    const sprite0 = crop(sub, nb);
    const nw = sprite0.width, nh = sprite0.height;
    // 健壮对齐 (与原版逐帧高度/头身比脱钩): 新内容统一缩到角色基准高 targetH(保宽高比), 轴=内容底部中心。
    // 旧做法把新图塞进原版每帧内容框(缩到原帧高+按原帧中心摆+原帧 basePt)→ 原版逐帧在动 + 异比例角色 → 左右闪/变形。
    // 现在每帧同高、脚底中心钉同一锚 → 补丁角色原地动、不闪、企鹅/任何头身比都成立。缺 targetH(旧 meta)回退原帧内容高。
    const targetH = meta.targetH && meta.targetH > 0 ? meta.targetH : Math.max(1, (cell.bbox[3] - cell.bbox[1]) / k);
    const s = targetH / nh;
    const ow = Math.max(1, Math.round(nw * s)), oh = Math.max(1, Math.round(nh * s));
    const sprite = resize(sprite0, ow, oh);
    // 轴 = 内容底部中心 + 角色"家锚"(baseDX/baseDY): baseDY 落到原版脚底(不飘), baseDX 钉一致中心(不左右抖); 缺省回退纯底部中心。
    const axis: XY = [Math.round(ow / 2 + (meta.baseDX ?? 0)), Math.round(oh + (meta.baseDY ?? 0))];
    out.set(`${cell.g},${cell.i}`, { group: cell.g, image: cell.i, img: sprite, axis });
  });
  return out;
}
