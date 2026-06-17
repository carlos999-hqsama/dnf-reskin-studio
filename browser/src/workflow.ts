// 补丁编排 (无页面 DOM, 纯数据流) — 列角色 → 解包分组 → 渲染导出网格(canvas 数据) → 导入去背对齐
// → 累积替换帧 → 骨架变体扩展 + 回封 → NPK。工作台 UI(workbench) 与 OPFS 验证(verify-opfs) 共用这层。
//
// 这层组合 core(几何/分组) + engine(wasm 解封) + render(Canvas 像素) + import(去背对齐)
// + dnf-rules(DNF 规则) + fs-access(目录 IO)。它产出 canvas/NPK 等数据, 但不碰页面 DOM/事件
// (那是 workbench 的事) → 可被 UI 与自检共用。
import type { AsyncEngine, DnfManifest } from './engine';
import { decodePng, encodePng } from './png';
import { buildActionGridCanvas } from './render-canvas';
import { importActionGrid, type ImportMeta, type ImportedFrame } from './import';
import { conformToDnf } from './pixels';
import { SpriteSet, type Cell, type Action } from './model';
import { computeContentGeometry, type Geometry } from './geometry';
import { segmentAction } from './segment';
import {
  CLASS_ZH, skinFileName, hideAvatarNames, type SkinEntry,
  subjectType, editableImgs, imgName, isEffectImg, subjectZh, subjectLabel, isLikelyStubNpk,
  patchNameForSubject, buildReplacements, parseSkin, type SubjectType, type EncodedFrame,
} from './dnf-rules';
import { type FsaDirHandle } from './fs-access';

export const GRID_COLS = 4, GRID_ROWS = 4; // 固定 4×4 网格 (16 格)
// 每组帧数: 默认 16 占满 4×4; 用户勾「16格放空」→ 15, 右下第16格留空给 Gemini/nano banana 水印(导入丢弃)。
export const SEG_FULL = 16, SEG_BLANK16 = 15;
// nano banana(Gemini Flash Image)图生图甜区: 输入按 768 切片、出图 1K-2K, 太小细节不足。
// 内容贴合 cell≈142×146, ×3 → 每格~430px、3×3 网格≈1.3-1.4Kpx (PNG, 近 1:1; 编辑模式保留输入画布原样改)。
export const EXPORT_UPSCALE = 3;   // NEAREST 放大倍数 (整数→像素均匀锐利)
export const EXPORT_GAP = 16;      // 帧间隙: 配内容贴合的格内 margin, 让 AI 看清格界 + 投影切分稳
export const EXPORT_PAD = 16;      // 网格四周边距

// ── 列角色 / 列隐藏源 (文件系统遍历 + DNF 规则过滤的组合) ───────────────────────
// % 开头 = 我们自己写的补丁, 不当源 (parseSkin/isHideSource 也拒它, 这里显式再保险一层)。

/** 列目录里有哪些角色 skin NPK。文件名是确定的 (sprite_character_<职业>_equipment_avatar_skin.NPK),
 *  故按【已知职业】逐个 getFileHandle 直接探测 (≤22 次), **不枚举整目录** —— 真实 ImagePacks2 上万文件,
 *  枚举几秒且没必要; 有就收、没有 catch 跳过。新职业未收进 CLASS_ZH 才需补表。 */
export async function listSkins(dir: FsaDirHandle): Promise<SkinEntry[]> {
  const out: SkinEntry[] = [];
  for (const klass of Object.keys(CLASS_ZH)) {
    // 试规范 .NPK 与小写 .npk 两种 (大小写文件系统差异); 命中即收, 取实际命中的名当 fileName。
    for (const name of [skinFileName(klass), skinFileName(klass).replace(/\.NPK$/, '.npk')]) {
      try {
        await dir.getFileHandle(name);
        out.push({ fileName: name, klass, zh: CLASS_ZH[klass]! });
        break;
      } catch { /* 该名不存在, 试下一个 */ }
    }
  }
  return out.sort((a, b) => a.klass.localeCompare(b.klass));
}

/** 列该职业要隐藏的 avatar 装备 NPK (按已知槽位名直取, ≤32 次 getFileHandle, **不枚举整目录**)。
 *  武器暂不含 (型号命名不固定无法盲构造; 要藏武器得拿到真实武器文件名再加)。 */
export async function listHideSources(dir: FsaDirHandle, klass: string): Promise<string[]> {
  const out: string[] = [];
  for (const base of hideAvatarNames(klass)) {
    for (const name of [base, base.replace(/\.NPK$/, '.npk')]) {
      try { await dir.getFileHandle(name); out.push(name); break; } catch { /* 不存在, 试下一个 */ }
    }
  }
  return out.sort();
}

/** 一个可补丁对象的列表项 (类型选择器二级用)。 */
export interface SubjectEntry { fileName: string; label: string; zh: string; type: SubjectType; }

/** 从已枚举的目录文件名里挑出某类型的对象 (汉化 best-effort, 桩包排后)。
 *  ⚠️ monster/pet 无固定名清单 → 必须枚举 ImagePacks2 一次(上万文件, listFileNames 每 1024 让出主线程);
 *  调用方应缓存 allFiles 复用, 别每次重枚举。class 用 listSkins 直取更快(免枚举), 不必走这里。 */
export function filterSubjects(allFiles: string[], type: SubjectType): SubjectEntry[] {
  const out: SubjectEntry[] = [];
  for (const fn of allFiles) {
    if (subjectType(fn) !== type) continue;
    out.push({ fileName: fn, label: subjectLabel(fn), zh: subjectZh(fn, type), type });
  }
  out.sort((a, b) => {
    const sa = isLikelyStubNpk(a.fileName) ? 1 : 0, sb = isLikelyStubNpk(b.fileName) ? 1 : 0; // 桩(effect/icon)排后, 本体优先
    return sa - sb || a.label.localeCompare(b.label);
  });
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════
// 多类型对象补丁 (职业/怪物/宠物 统一) — OpenSubject
// ────────────────────────────────────────────────────────────────────────────────
// 怪物/宠物一个 NPK 含多个【独立动作 IMG】(quinbi boss 60 个 attack_x_y / 宠物 stand·walk·…),
// 与职业"单本体 + 骨架变体"不同 → 抽象成"对象有多个可补丁动作, 各算自己几何/锚点"。
// 元数据 (geo/分组/targetH/家锚) 全从 manifest 的 size/axis 算 (不解像素) → 开包秒回;
// 像素按动作【懒解】(渲染某动作才 unpackImg 那一个 IMG) → 60-IMG 大怪物不一次性全解爆内存。
// 职业也走这套 (actions=[本体一个], deployTargets 铺骨架变体)。引擎走 AsyncEngine → 解包/回封都在
// Web Worker 后台线程跑, 主线程不冻 (见 worker-engine/engine-worker)。

const mid = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0; };

export interface SubjectAction {
  imgIndex: number;
  name: string;          // 动作展示名 (IMG 路径末段, 如 00_stand / quinbi_attack_0_0)
  isEffect: boolean;     // 特效层 (黑底+加色) → 抠图应留黑 (v1 仍走普通抠图, UI 标注提醒)
  cells: Cell[];         // 该 IMG 的真实帧 [imgIndex, frame_index]
  segments: Cell[][];    // 4×4 网格分组
  geo: Geometry;
  targetH: number;
  baseDX: number;
  baseDY: number;
}

export interface OpenSubject {
  type: SubjectType;
  fileName: string;
  zh: string;
  srcNpk: Uint8Array;
  manifest: DnfManifest;
  actions: SubjectAction[];
  metaSS: SpriteSet;                     // 所有动作的 size/axis (算几何/渲染查元数据)
  fileByCell: Map<string, string>;       // "g,i" → file (全动作, 从 manifest 建)
  pngByFile: Map<string, Uint8Array>;    // file → PNG; 按动作懒填
  loadedImgs: Set<number>;               // 已解像素的 IMG (懒解去重)
  replaced: Map<string, ImportedFrame>;  // "g,i" → 替换帧 (跨动作累积; g=img_index 故不撞)
}

/** 从 manifest 收一个 IMG 的 size/axis + cells + file 映射 (不解像素, 写进传入的 ss/fileByCell)。 */
function collectImg(manifest: DnfManifest, imgIndex: number, ss: SpriteSet, fileByCell: Map<string, string>): Cell[] {
  const cells: Cell[] = [];
  for (const mf of manifest.frames) {
    if (mf.img_index !== imgIndex || mf.linked) continue;
    ss.set({ group: mf.img_index, image: mf.frame_index, size: [mf.pic_width, mf.pic_height], axis: [mf.offset_x, mf.offset_y] });
    fileByCell.set(`${mf.img_index},${mf.frame_index}`, mf.file);
    cells.push([mf.img_index, mf.frame_index]);
  }
  return cells;
}

/** 一个 IMG 的 cells → SubjectAction (几何/分组/targetH/家锚, 全从 size/axis 算)。与 openChar 同一套公式。 */
function buildAction(metaSS: SpriteSet, cells: Cell[], imgIndex: number, name: string, isEffect: boolean, segSize: number): SubjectAction {
  const action: Action = { id: imgIndex, name, frames: cells.map(([g, i]) => [g, i, 0, 0, 6] as const) };
  const segments = segmentAction(action, segSize, false).map((s) => s.keys); // 不并尾组 → 每组 ≤segSize 不爆 4×4
  const geo = computeContentGeometry(metaSS, cells, 300);
  const targetH = cells.length ? mid(cells.map(([g, i]) => metaSS.get(g, i)!.size[1])) || 64 : 64;
  const baseDX = mid(cells.map(([g, i]) => { const f = metaSS.get(g, i)!; return f.axis[0] - f.size[0] / 2; }));
  const baseDY = mid(cells.map(([g, i]) => { const f = metaSS.get(g, i)!; return f.axis[1] - f.size[1]; }));
  return { imgIndex, name, isEffect, cells, segments, geo, targetH, baseDX, baseDY };
}

/** IMG 路径末段名 (sprite/.../00_stand.img → 00_stand)。动作展示用。 */
function imgShortName(fullName: string): string {
  return (fullName.split('/').pop() ?? fullName).replace(/\.img$/i, '');
}

/** 解一个对象 (职业/怪物/宠物) → 多动作元数据 (不解像素, 秒回)。像素按动作懒解 (renderActionSegment 内部触发)。 */
export async function openSubject(eng: AsyncEngine, srcNpk: Uint8Array, fileName: string, segSize: number = SEG_FULL): Promise<OpenSubject> {
  const type = subjectType(fileName);
  if (!type) throw new Error(`不是可补丁对象 (职业/怪物/宠物): ${fileName}`);
  const manifest = await eng.unpackMeta(srcNpk);
  const metaSS = new SpriteSet();
  const fileByCell = new Map<string, string>();
  const actions: SubjectAction[] = [];
  for (const img of editableImgs(manifest, type)) {
    const cells = collectImg(manifest, img, metaSS, fileByCell);
    if (!cells.length) continue;
    const name = imgName(manifest, img);
    actions.push(buildAction(metaSS, cells, img, imgShortName(name), isEffectImg(name), segSize));
  }
  return {
    type, fileName, zh: subjectZh(fileName, type), srcNpk, manifest, actions,
    metaSS, fileByCell, pngByFile: new Map(), loadedImgs: new Set(), replaced: new Map(),
  };
}

/** 改每组帧数(切「16格放空」时)重新分组。只重算 segments(纯 manifest 元数据), 不动像素/已换帧
 *  → 已重绘的帧(open.replaced 按 img,frame 存, 与分组无关)全保留。 */
export function resegmentSubject(open: OpenSubject, segSize: number): void {
  for (const a of open.actions) {
    const action: Action = { id: a.imgIndex, name: a.name, frames: a.cells.map(([g, i]) => [g, i, 0, 0, 6] as const) };
    a.segments = segmentAction(action, segSize, false).map((s) => s.keys);
  }
}

/** 懒解某动作 IMG 的像素 (只解这一个 IMG; 已解则跳过) → 填 pngByFile。走 Worker, 主线程不冻。 */
export async function ensureActionPixels(eng: AsyncEngine, open: OpenSubject, imgIndex: number): Promise<void> {
  if (open.loadedImgs.has(imgIndex)) return;
  for (const f of await eng.unpackImg(open.srcNpk, imgIndex)) open.pngByFile.set(f.name, f.png);
  open.loadedImgs.add(imgIndex);
}

/** 渲染某动作的某组 → 导出网格 canvas + meta (注入该动作的 targetH/家锚)。懒解该动作像素。 */
export async function renderActionSegment(
  eng: AsyncEngine, open: OpenSubject, actionIndex: number, segIndex: number, bg?: string,
): Promise<{ canvas: HTMLCanvasElement; meta: ImportMeta; geo: Geometry; cells: Cell[]; ss: SpriteSet }> {
  const action = open.actions[actionIndex];
  if (!action) throw new Error(`动作越界: ${actionIndex}`);
  await ensureActionPixels(eng, open, action.imgIndex);
  const cells = action.segments[segIndex] ?? [];
  const ss = new SpriteSet();
  for (const [g, i] of cells) {
    const file = open.fileByCell.get(`${g},${i}`);
    const png = file ? open.pngByFile.get(file) : undefined;
    const m = open.metaSS.get(g, i);
    if (!png || !m) continue;
    ss.set({ group: g, image: i, size: m.size, axis: m.axis, img: await decodePng(png) });
  }
  const { canvas, meta } = buildActionGridCanvas(ss, cells, action.geo, { upscale: EXPORT_UPSCALE, gap: EXPORT_GAP, pad: EXPORT_PAD, bg, cols: GRID_COLS, rows: GRID_ROWS });
  meta.targetH = action.targetH; meta.baseDX = action.baseDX; meta.baseDY = action.baseDY;
  return { canvas, meta, geo: action.geo, cells, ss };
}

/** 导入某组 AI 图 → 去背对齐 → 累积进 open.replaced (键 "img,frame" 跨动作不撞)。返回导入帧数。 */
export function importActionSegment(
  open: OpenSubject, aiImg: { data: Uint8ClampedArray; width: number; height: number }, meta: ImportMeta,
  opts: { bgKey?: readonly [number, number, number]; algo?: 'floodkey' | 'floodbg'; despill?: boolean } = {},
): number {
  const rep = importActionGrid(aiImg, meta, opts);
  for (const [k, v] of rep) open.replaced.set(k, v);
  return rep.size;
}

/** 回封: 累积替换帧硬边化+编码 → 按类型展开 (class 铺骨架变体 / monster·pet 各动作独立) → repack → 补丁 NPK。 */
export async function deploySubject(
  eng: AsyncEngine, open: OpenSubject,
): Promise<{ outNpk: Uint8Array; patchName: string; repCount: number; imgCount: number }> {
  const encodedByImg = new Map<number, Map<number, EncodedFrame>>();
  for (const fr of open.replaced.values()) {
    const hard = conformToDnf({ data: new Uint8ClampedArray(fr.img.data), width: fr.img.width, height: fr.img.height });
    const enc: EncodedFrame = { png: await encodePng(hard), axis: fr.axis, size: [fr.img.width, fr.img.height] };
    let mm = encodedByImg.get(fr.group);
    if (!mm) { mm = new Map(); encodedByImg.set(fr.group, mm); }
    mm.set(fr.image, enc);
  }
  const reps = buildReplacements(open.manifest, open.type, encodedByImg);
  const outNpk = await eng.repack(open.srcNpk, open.manifest, reps);
  const klass = open.type === 'class' ? parseSkin(open.fileName)?.klass : undefined;
  return {
    outNpk, patchName: patchNameForSubject(open.type, open.fileName, klass),
    repCount: reps.length, imgCount: new Set(reps.map((r) => r.imgIndex)).size,
  };
}
