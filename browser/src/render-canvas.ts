// 浏览器 Canvas 渲染层 — 对应 Python core/render.py 的像素合成部分 (render_cell + build_strip + build_action_grid)。
// 几何/对齐数学全走已验证的 core (geometry.ts/layout.ts); 这里只做 Canvas 像素合成 (轴钉锚点 + 缩放)。
import type { Cell, SpriteSet } from './model';
import { type Geometry } from './geometry';
import { computeGridLayout } from './layout';
import { getBbox, footCenterX } from './pixels';
import type { ImportMeta, ImportCell } from './import';

/** 一帧 → cellW×cellH canvas: 帧的轴(脚底)钉到 geo.anchor。scale≠1 时 drawImage 缩放。
 *  对应 render.render_cell。fr.img 必须是真 ImageData (decodePng 产出)。 */
export function renderCellCanvas(img: ImageData, axis: readonly [number, number], geo: Geometry): HTMLCanvasElement {
  const cell = document.createElement('canvas');
  cell.width = geo.cellW;
  cell.height = geo.cellH;
  const ctx = cell.getContext('2d')!;
  const tmp = document.createElement('canvas'); // ImageData → 可 drawImage 的源
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  const s = geo.scale;
  const dw = Math.max(1, Math.round(img.width * s)), dh = Math.max(1, Math.round(img.height * s));
  const ax = axis[0] * s, ay = axis[1] * s; // 轴随 scale 缩
  ctx.imageSmoothingEnabled = s !== 1;
  ctx.drawImage(tmp, 0, 0, img.width, img.height, Math.round(geo.anchor[0] - ax), Math.round(geo.anchor[1] - ay), dw, dh);
  return cell;
}

/** 一帧 → cellW×cellH canvas: 【参考图式对齐】(AI 重绘友好)。横向把帧 axis_x 钉到 geo.anchor[0]
 *  (角色注册位, 不左右飘); 纵向把【内容底】对齐到 geo.anchor[1] 基线(脚踩同一线, 不随姿势上下飘)。
 *  为何纵向不用 axis_y: DNF 的 axis(offset)是世界坐标偏移、常远离精灵本体, axis_y 不在脚底, 用它纵向定位
 *  会让脚随姿势乱飘(尤其跳跃/腾空帧)。故纵向改用真实内容底 → 每帧角色同一脚底线、同一水平位, 只姿势变。 */
export function renderCellGrounded(img: ImageData, axis: readonly [number, number], geo: Geometry): HTMLCanvasElement {
  const cell = document.createElement('canvas');
  cell.width = geo.cellW;
  cell.height = geo.cellH;
  const ctx = cell.getContext('2d')!;
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  const s = geo.scale;
  const dw = Math.max(1, Math.round(img.width * s)), dh = Math.max(1, Math.round(img.height * s));
  const bb = getBbox({ data: img.data, width: img.width, height: img.height }); // 内容底对齐基线
  const contentBottom = bb ? bb[3] : img.height;
  const dx = Math.round(geo.anchor[0] - axis[0] * s);       // axis_x → anchor_x (横向注册, 不飘)
  const dy = Math.round(geo.anchor[1] - contentBottom * s); // 内容底 → 基线 anchor_y (纵向接地)
  ctx.imageSmoothingEnabled = s !== 1;
  ctx.drawImage(tmp, 0, 0, img.width, img.height, dx, dy, dw, dh);
  return cell;
}

/** 去重帧 → 横图 canvas (绿底 + 脚底锚线)。所有帧的轴钉同锚 → 脚底应贴齐红线。
 *  对应 render.build_strip 的合成部分 (布局走 core, 这里画像素)。 */
export function buildStripCanvas(frames: SpriteSet, cells: Cell[], geo: Geometry): HTMLCanvasElement {
  const present = cells.filter(([g, i]) => frames.get(g, i)?.img);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, present.length * geo.cellW);
  cv.height = geo.cellH;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#00ff00'; // 绿底 (像桌面版, AI 抠图友好)
  ctx.fillRect(0, 0, cv.width, cv.height);
  present.forEach(([g, i], idx) => {
    const fr = frames.get(g, i)!;
    ctx.drawImage(renderCellCanvas(fr.img as ImageData, fr.axis, geo), idx * geo.cellW, 0);
  });
  ctx.strokeStyle = 'rgba(220,40,40,.8)'; // 脚底锚线: 各帧脚底应贴它 = 对齐正确
  ctx.beginPath();
  ctx.moveTo(0, geo.anchor[1] + 0.5);
  ctx.lineTo(cv.width, geo.anchor[1] + 0.5);
  ctx.stroke();
  return cv;
}

export interface GridExport {
  canvas: HTMLCanvasElement;
  meta: ImportMeta;
}

/** 去重帧 → 接近正方形网格 canvas + meta (对应 render.build_action_grid; nano banana 友好导出)。
 *  每帧【参考图式对齐】放入格 (renderCellGrounded: 横向 axis_x 钉同锚不左右飘 + 纵向内容底对齐统一基线
 *  脚踩同线不上下飘 → 每帧角色同位同脚线、只姿势变, AI 重绘最稳) → NEAREST 放大 upscale 倍保锐边
 *  → 贴格; meta 记 cols/rows + 每格内容 bbox (仅导入 targetH 缺省时的回退参考)。
 *  导入 importActionGrid 按 cols/rows 投影切回, 新内容统一缩到 meta.targetH + 内容底部中心锚
 *  (见 import.ts; 与原版逐帧/头身比脱钩, 不左右闪)。布局走 computeGridLayout。 */
export function buildActionGridCanvas(
  frames: SpriteSet, cells: Cell[], geo: Geometry,
  opts: { upscale?: number; gap?: number; pad?: number; bg?: string; cols?: number; rows?: number } = {},
): GridExport {
  const upscale = opts.upscale ?? 2, gap = opts.gap ?? 14, pad = opts.pad ?? 18, bg = opts.bg ?? '#00ff00';
  const present = cells.filter(([g, i]) => frames.get(g, i)?.img);
  const layout = computeGridLayout(present.length, geo, upscale, gap, pad, opts.cols, opts.rows);
  const cv = document.createElement('canvas');
  cv.width = layout.W;
  cv.height = layout.H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = bg; // 绿底 #00ff00: AI 抠图友好
  ctx.fillRect(0, 0, layout.W, layout.H);
  const metaCells: ImportCell[] = [];
  present.forEach(([g, i], idx) => {
    const fr = frames.get(g, i)!;
    const small = renderCellGrounded(fr.img as ImageData, fr.axis, geo); // 参考图式: 横向 axis_x + 纵向内容底基线
    const big = document.createElement('canvas');
    big.width = layout.cw;
    big.height = layout.ch;
    const bctx = big.getContext('2d')!;
    bctx.imageSmoothingEnabled = false; // NEAREST 放大保像素锐边
    bctx.drawImage(small, 0, 0, geo.cellW, geo.cellH, 0, 0, layout.cw, layout.ch);
    const slot = layout.cells[idx]!;
    ctx.drawImage(big, slot.cellXy[0], slot.cellXy[1]);
    const bd = bctx.getImageData(0, 0, layout.cw, layout.ch);
    const bb = getBbox({ data: bd.data, width: layout.cw, height: layout.ch });
    // bbox = 该格渲染后内容框 (放大 cell 坐标); 仅作导入 targetH 缺省时的回退参考 (默认走 meta.targetH)。
    // srcAxis/srcBbox/srcFootX = 原版该帧的 axis + 内容 bbox + 脚底中心 (原生 px) → 导入端健壮对齐用它保留
    // 原版逐帧运动(走位/起跳); 脚底中心当横向锚点(抗披风)。
    const srcImg = { data: (fr.img as ImageData).data, width: fr.img!.width, height: fr.img!.height };
    const srcBb = getBbox(srcImg);
    metaCells.push({
      g, i, bbox: bb ?? [0, 0, 1, 1], cellXy: slot.cellXy, cellWh: slot.cellWh,
      srcAxis: [fr.axis[0], fr.axis[1]], srcBbox: srcBb ?? undefined,
      srcFootX: srcBb ? footCenterX(srcImg, srcBb) : undefined,
    });
  });
  const meta: ImportMeta = {
    n: present.length, cols: layout.cols, rows: layout.rows,
    W: layout.W, H: layout.H, upscale, scale: layout.scale, cells: metaCells,
  };
  return { canvas: cv, meta };
}

/** 洋葱皮叠帧 (对齐编辑器用): 在 ctx 上把一帧按 axis 钉到 anchor 画出 (坐标同 renderCellCanvas: sprite 画在 anchor-axis)。
 *  alpha<1 = 半透明残影; tint!=null 用 source-atop 给不透明像素染色 (前/后帧/原版用不同色调区分, 不挡当前帧)。
 *  当前帧 alpha=1 无 tint 实色画在最上, 前后帧/原版半透明垫底 → 拖当前帧到与前后帧衔接连贯。 */
export function drawGhost(
  ctx: CanvasRenderingContext2D, img: ImageData, axis: readonly [number, number],
  anchor: readonly [number, number], scale: number, alpha: number, tint?: string,
): void {
  const tmp = document.createElement('canvas');
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  let src: HTMLCanvasElement = tmp;
  if (tint) {
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
    const tx = t.getContext('2d')!;
    tx.drawImage(tmp, 0, 0);
    tx.globalCompositeOperation = 'source-atop'; // 只在不透明像素上铺色 → 染色保留轮廓
    tx.fillStyle = tint; tx.fillRect(0, 0, img.width, img.height);
    src = t;
  }
  const dw = Math.max(1, Math.round(img.width * scale)), dh = Math.max(1, Math.round(img.height * scale));
  const dx = Math.round(anchor[0] - axis[0] * scale), dy = Math.round(anchor[1] - axis[1] * scale);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = scale !== 1;
  ctx.drawImage(src, 0, 0, img.width, img.height, dx, dy, dw, dh);
  ctx.restore();
}
