// 导入: AI 重绘的网格图 → 替换帧。照搬 Python core/importer.py 的 import_action_grid 全流程。
// 投影法切格(鲁棒于人物偏移/跨格) → 每格去背(floodKey 自适应 + despill 中和残绿) → 内容 bbox →
// 统一缩到角色基准高 targetH(保宽高比) + 轴=内容底部中心。算法件全已单测; 只 resize 走 Canvas
// (与 PIL LANCZOS 不逐字节, 靠 preview 真浏览器验对齐) → 做成依赖注入, node 可注 nearest 测串接。
import type { RGBA, XY } from './model';
import { keyOut, floodKey, floodBg, despillGreen, defringeGreen } from './matte';
import { getBbox, crop, columnAlphaProfile, rowAlphaProfile, footCenterX } from './pixels';
import { splitBounds } from './align';

/** 中位数 (升序取上中位, 与 workflow.mid 同口径)。全局本体缩放估计抗个别披风帧用。 */
function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1]! : 1;
}

/** 一格的导入契约: 哪帧 (g,i) + 导出时该格渲染后内容框 bbox (放大 cell 坐标系)。
 *  cellXy/cellWh 是导出布局位置, 导入不用(投影法重检测), 仅调试/参考。 */
export interface ImportCell {
  g: number;
  i: number;
  bbox: [number, number, number, number];
  cellXy?: [number, number];
  cellWh?: [number, number];
  /** 原版该帧的 axis (offset_x/offset_y, 原生 px)。健壮对齐用它保留原版逐帧动画(走位/起跳)。 */
  srcAxis?: [number, number];
  /** 原版该帧的【内容 bbox】[x0,y0,x1,y1] (原生 px, 剔透明边)。脚底(y=oB)+脚底中心定锚, 沿用 srcAxis 口径。 */
  srcBbox?: [number, number, number, number];
  /** 原版该帧的【脚底中心 x】(原生 px)。横向锚点 = 它 (抗披风, 见 footCenterX); 缺省回退内容框中心。 */
  srcFootX?: number;
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

/** 抠图/缩放选项 (importActionGrid / importActionGridFrames 共用)。 */
export interface ImportOpts {
  bgKey?: readonly [number, number, number];
  keyTol?: number;
  resize?: ResizeFn;
  despill?: boolean;
  algo?: 'floodkey' | 'floodbg';
  scaleMult?: number;
}

/** 一帧的【可编辑中间态】: 抠图+缩放后的纯精灵 + 预对齐轴 relAxis。
 *  对齐编辑器在此之上逐帧拖 relAxis (帧间连贯) + 组级 groupOffset (整组锚原版); 最终 axis = relAxis + groupOffset
 *  (见 workflow.commitSegmentEdit)。relAxis 是【单帧画在哪】, groupOffset 是【整组一起平移】— 两层独立互不干扰。 */
export interface EditFrame {
  g: number;
  i: number;
  /** 抠图+缩放后的纯精灵 (已裁到内容 bbox)。 */
  sprite: RGBA;
  /** 预对齐轴 [x,y] (sprite 像素坐标系; = 旧脚底锚定算的 axis, 大部分帧到位)。编辑器逐帧拖动改它。 */
  relAxis: [number, number];
}

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

/** AI 网格图 → 每帧【可编辑中间态 EditFrame】(sprite + 预对齐 relAxis)。meta 来自导出 (buildActionGridCanvas)。
 *  抠图/切格/缩放流程照搬 importer.import_action_grid, 但产出"可编辑中间态"喂对齐编辑器逐帧精调, 而非定死最终帧。
 *  importActionGrid = 本函数 + (relAxis 当最终 axis) 的薄封装 (向后兼容 dev-harness/verify/reskin-demo/测试)。
 *
 *  流程 (照搬 importer.import_action_grid):
 *  1. (可选) bgKey 色键补刀。
 *  2. 投影法检测列/行边界: 整图 floodKey+despill 后取 alpha → 列/行投影 → splitBounds
 *     (峰段凑不齐 cols×rows 回退等分; 鲁棒于人物在格里偏移/跨格)。
 *  3. 每格: crop → floodKey(per-cell 背景自适应) + despill(中和残绿) → 内容 bbox →
 *     全局本体缩放 + 逐帧脚底锚定(沿用原版 axis) → relAxis (走位/起跳逐帧运动作为初值, 本体比例固定)。
 */
export function importActionGridFrames(
  img: RGBA, meta: ImportMeta,
  opts: ImportOpts = {},
): EditFrame[] {
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

  const kFallback = (meta.upscale || 1) * (meta.scale || 1);
  const frames: EditFrame[] = [];

  // 第一遍: 逐格 切格→去背→内容 bbox; 同时收集 (原版内容高/新内容高) 比值 → 算全局本体缩放基准。
  interface Det { cell: ImportCell; sprite0: RGBA; nw: number; nh: number; }
  const dets: Det[] = [];
  const ratios: number[] = []; // oH/nh = AI像素→原生像素 (= 本体若与原版等高的缩放); 取中位抗个别披风帧
  meta.cells.forEach((cell, idx) => {
    const gr = Math.floor(idx / meta.cols), gc = idx % meta.cols;
    const x0 = colB[gc]!, y0 = rowB[gr]!, x1 = colB[gc + 1]!, y1 = rowB[gr + 1]!;
    if (x1 <= x0 || y1 <= y0) return;
    const sub = dsp(floodMatte(crop(work, [x0, y0, x1, y1]))); // crop 出副本 → 原地抠不污染 work
    const nb = getBbox(sub);
    if (!nb) return;                                       // 空格 (该帧 AI 没画) 跳过
    const sprite0 = crop(sub, nb);
    const nw = sprite0.width, nh = sprite0.height;
    dets.push({ cell, sprite0, nw, nh });
    if (cell.srcBbox) ratios.push((cell.srcBbox[3] - cell.srcBbox[1]) / Math.max(1, nh));
  });

  // 全局本体缩放 (核心思路): 本体是【固定比例的整体】, 不该随动作/装饰逐帧缩放 —— 披风等装饰把内容框撑大撑小,
  // 旧的"每帧缩到原版内容高"会让本体跟着脉动。故改用【一个全局缩放】: 基准 = 中位(原版内容高/新内容高)
  // (抗个别披风帧 + 自适应 AI 出图分辨率), 再 × 用户【本体缩放】倍数 (滑杆手调, 因为装饰让自动测不准、但人一眼能比对)。
  // 全段同一缩放 → 本体大小恒定; 引擎只剩 XY 锚定要算 (见下)。
  const sBase = ratios.length ? median(ratios) : 1;
  const s = sBase * (opts.scaleMult ?? 1);

  // 第二遍: 全局缩放 + 逐帧【脚底锚定】(沿用原版 axis) → 走位/起跳逐帧运动保住, 本体比例固定。
  for (const { cell, sprite0, nw, nh } of dets) {
    let sprite: RGBA, axis: XY;
    if (cell.srcBbox && cell.srcAxis) {
      const [oL, oT, oR, oB] = cell.srcBbox;
      const [ax, ay] = cell.srcAxis;
      const ow = Math.max(1, Math.round(nw * s)), oh = Math.max(1, Math.round(nh * s));
      sprite = resize(sprite0, ow, oh);
      // 横向: 新内容【脚底中心】对齐原版脚底中心 (轴相对 origFootX-ax, 抗披风); 纵向: 新内容底对齐原版内容底 (oB-ay)。
      // 脚底中心在【缩放后的 sprite】上量(= 实际入游戏的脚位, 不靠缩放前估算)。轴沿用原版口径(远离精灵本体也照搬)
      // → 原版每帧走位/起跳/前冲全保住; 缩放是全局常数 → 本体不随动作变大小。
      const origFootX = cell.srcFootX ?? (oL + oR) / 2;
      const fx = footCenterX(sprite, [0, 0, ow, oh]);
      axis = [Math.round(fx - (origFootX - ax)), Math.round(oh - (oB - ay))];
    } else {
      // 回退 (旧 meta 无 srcBbox/srcAxis): 归一到 targetH + 内容底中心轴 (会抹平动画, 仅兼容旧契约/测试)。
      const targetH = meta.targetH && meta.targetH > 0 ? meta.targetH : Math.max(1, (cell.bbox[3] - cell.bbox[1]) / kFallback);
      const sf = targetH / nh;
      const ow = Math.max(1, Math.round(nw * sf)), oh = Math.max(1, Math.round(nh * sf));
      sprite = resize(sprite0, ow, oh);
      axis = [Math.round(ow / 2 + (meta.baseDX ?? 0)), Math.round(oh + (meta.baseDY ?? 0))];
    }
    frames.push({ g: cell.g, i: cell.i, sprite, relAxis: [axis[0], axis[1]] });
  }
  return frames;
}

/** AI 网格图 → {(g,i) → 替换帧} (最终 axis = relAxis, 即 groupOffset=0)。importActionGridFrames 的薄封装,
 *  保持旧契约 (dev-harness/verify-opfs/reskin-demo/import.test 用)。带对齐编辑器的流程走
 *  workflow.buildSegmentEdit + commitSegmentEdit (产出可编辑中间态 → 编辑 → 合成最终 axis)。 */
export function importActionGrid(
  img: RGBA, meta: ImportMeta,
  opts: ImportOpts = {},
): Map<string, ImportedFrame> {
  const out = new Map<string, ImportedFrame>();
  for (const f of importActionGridFrames(img, meta, opts)) {
    out.set(`${f.g},${f.i}`, { group: f.g, image: f.i, img: f.sprite, axis: f.relAxis });
  }
  return out;
}
