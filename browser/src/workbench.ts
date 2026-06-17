// 补丁工作台 UI (页面 DOM + 事件) — 两栏布局: 左 = 原素材 (类型/对象/动作选择 + 原始序列帧 + 导出给 AI),
// 右 = 成品 (导入 AI 重绘图 → 抠图 → 隐藏时装[仅职业] → 打包补丁)。两栏同时铺, 共用当前对象/动作/组。
//
// 对象三类 (职业/怪物/宠物): 一级选类型, 二级选对象 (怪物上千个 → 枚举一次+搜索), 多动作对象再选动作。
// 全走 workflow.openSubject 统一编排 (职业=单本体动作, 怪物/宠物=多独立动作)。数据流在 workflow(无 DOM),
// 这里只管 DOM / 事件 / 动画预览 / 进度条。真实目录走 showDirectoryPicker(需用户手势, 限 Chrome 系)。
import type { AsyncEngine, HideImg } from './engine';
import { renderCellCanvas } from './render-canvas';
import type { ImportMeta } from './import';
import { SpriteSet, type Cell, type RGBA } from './model';
import type { Geometry } from './geometry';
import {
  openSubject, setGrid, renderActionSegment, importActionSegment, deploySubject,
  listSkins, listHideSources, filterSubjects, type OpenSubject, type SubjectEntry, type GridSpec,
} from './workflow';
import { parseSkin, hidePatchName, type SubjectType } from './dnf-rules';
import { readNpk, writePatch, pickImagePacksDir, listFileNames, type FsaDirHandle } from './fs-access';

const EXPORT_BG = '#00ff00'; // 导出素材图固定绿底 (AI 抠图友好); 幕布只管预览不碰它

/** 预览幕布预设 — 垫在透明帧/成品帧后面看抠图干不干净 (白残留切深色照出来)。绿/蓝/白/黑/灰。 */
interface BgChoice { key: string; label: string; css: string; }
const BG_PRESETS: BgChoice[] = [
  { key: 'gray', label: '灰', css: '#8a8d93' },
  { key: 'green', label: '绿', css: '#00ff00' },
  { key: 'blue', label: '蓝', css: '#1e66ff' },
  { key: 'white', label: '白', css: '#ffffff' },
  { key: 'black', label: '黑', css: '#000000' },
];

type Algo = 'floodkey' | 'floodbg';
// 对象类型暴露表。⚠️ 怪物/宠物补丁能力已实现+验证(openSubject 多动作/Web Worker/三类 OPFS 全过),
// 但【暂隐藏不暴露】—— 怪物/宠物非标准人形, 玩家拿导出网格去 AI 重绘出不了能用的结果 (三九 0618 决定)。
// 代码全保留(workflow.openSubject 等通用), 要恢复把 ['monster','怪物'],['pet','宠物'] 加回本表即可。
const TYPE_DEFS: [SubjectType, string][] = [['class', '职业']];

// 导出网格预设(下拉)。默认 4×4·16; 3×3 格大、AI 出图更稳; 留空=末格(右下)空着给 Gemini/nano banana 水印砸。
const GRID_PRESETS: { key: string; label: string; spec: GridSpec }[] = [
  { key: '4x4', label: '4×4 · 16 帧（满）', spec: { cols: 4, rows: 4, segSize: 16 } },
  { key: '4x4b', label: '4×4 · 15 帧（留空避水印）', spec: { cols: 4, rows: 4, segSize: 15 } },
  { key: '3x3', label: '3×3 · 9 帧（格大 · AI 更稳）', spec: { cols: 3, rows: 3, segSize: 9 } },
  { key: '3x3b', label: '3×3 · 8 帧（留空避水印）', spec: { cols: 3, rows: 3, segSize: 8 } },
];
const gridSpecOf = (key: string): GridSpec => (GRID_PRESETS.find((p) => p.key === key) ?? GRID_PRESETS[0]!).spec;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function toImageData(img: RGBA): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}
// 让出主线程喘一下 (让"…中"提示先画出来再跑同步活)。⚠️ 用 setTimeout 不用 requestAnimationFrame:
// 后台/隐藏标签页 rAF 会被浏览器暂停 → await 永久挂起 → 整个流程卡死 (preview 隐藏标签页实测中招)。
const raf = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 在 canvas 上循环播放一组帧 (轴锚定: 每帧 axis 钉同锚 + 统一 scale → 角色按游戏注册点原地动、与导出图一致)
 *  = 循环预览。返回 setInterval id, 调用方负责 clearInterval (切组/重渲时停)。DNF 帧时序在 .ani(不读) → 固定节拍。
 *  canvas 内部分辨率 = geo cell; 显示尺寸交给 CSS (.preview aspect-ratio:1 方框 + canvas object-fit:contain
 *  按比例 letterbox 填入), 不在 JS 设 inline 宽高 — 否则会被 .preview 的 max 约束各自裁剪致角色变形。 */
function animateStrip(canvas: HTMLCanvasElement, ss: SpriteSet, cells: Cell[], geo: Geometry, bg: string): number {
  canvas.width = geo.cellW;
  canvas.height = geo.cellH;
  const ctx = canvas.getContext('2d')!;
  const present = cells.filter(([g, i]) => ss.get(g, i)?.img);
  let idx = 0;
  const tick = (): void => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!present.length) return;
    const cell = present[idx % present.length]!;
    const fr = ss.get(cell[0], cell[1])!;
    ctx.drawImage(renderCellCanvas(fr.img as ImageData, fr.axis, geo), 0, 0);
    idx++;
  };
  tick();
  return setInterval(tick, 90) as unknown as number; // ~11 fps
}

/** 进度条 (非阻断): pct 省略 = 不确定态(忙碌中, wasm 同步调用那下会冻、靠文字告知); 给 pct = 真进度。 */
function makePg(): HTMLElement {
  const pg = el('div', 'pg');
  pg.innerHTML = '<div class="pg-track"><div class="pg-fill"></div></div><div class="pg-label"></div>';
  return pg;
}
function pgShow(pg: HTMLElement, label: string, pct?: number): void {
  pg.classList.add('on');
  const fill = pg.querySelector('.pg-fill') as HTMLElement;
  (pg.querySelector('.pg-label') as HTMLElement).textContent = label;
  if (pct === undefined) { fill.classList.add('indet'); fill.style.width = ''; }
  else { fill.classList.remove('indet'); fill.style.width = `${Math.round(pct * 100)}%`; }
}
function pgHide(pg: HTMLElement): void { pg.classList.remove('on'); }

// ── 记住上次选的目录 (FileSystemDirectoryHandle 可结构化克隆 → 存 IndexedDB, 下次免重选) ──────
const IDB_DB = 'dnf-reskin', IDB_STORE = 'handles', DIR_KEY = 'imagepacks2';
type PermHandle = FsaDirHandle & {
  name?: string;
  queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
};
function openIdb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  try {
    return await new Promise<T | undefined>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => res(rq.result as T | undefined); rq.onerror = () => rej(rq.error);
    });
  } finally { db.close(); }
}
/** 确认对句柄有读写权限。request=true 时(须用户手势内)主动申请。OPFS 等无权限模型的句柄视为可用。 */
async function ensureRw(h: PermHandle, request: boolean): Promise<boolean> {
  const o = { mode: 'readwrite' };
  if (!h.queryPermission) return true;
  if ((await h.queryPermission(o)) === 'granted') return true;
  if (request && h.requestPermission && (await h.requestPermission(o)) === 'granted') return true;
  return false;
}

export interface WorkbenchEls {
  pick: HTMLButtonElement;
  dir: HTMLElement;
  panelL: HTMLElement;
  panelR: HTMLElement;
}
export interface WorkbenchHandle {
  openWithDir: (d: FsaDirHandle) => Promise<void>;
}

export function mountWorkbench(getEngine: () => Promise<AsyncEngine>, els: WorkbenchEls): WorkbenchHandle {
  let dir: FsaDirHandle | null = null;
  let subjType: SubjectType = 'class';
  let allFiles: string[] | null = null;      // 目录枚举缓存 (monster/pet 列对象用; class 走 listSkins 不枚举)
  let objects: SubjectEntry[] = [];          // 当前类型的对象列表
  let objQuery = '';                         // 对象搜索词
  let open: OpenSubject | null = null;
  let curAction = 0;
  let curSeg = 0;
  let leftBg: BgChoice = BG_PRESETS[0]!;
  let rightBg: BgChoice = BG_PRESETS[0]!;
  let algo: Algo = 'floodkey';
  let despill = true;
  let gridKey = '4x4';                       // 导出网格预设 key (见 GRID_PRESETS), 默认 4×4·16
  const importedKeys = new Set<string>();    // `${action}:${seg}` 已导入完成
  const rawAiByKey = new Map<string, RGBA>(); // `${action}:${seg}` → 上传的原始 AI 图 (改算法重抠)

  // 当前组渲染缓存 (切动作/组/对象才失效; 换幕布不重解码)。
  let cur: { meta: ImportMeta; geo: Geometry; cells: Cell[]; ss: SpriteSet; exportCanvas: HTMLCanvasElement } | null = null;
  let curForKey = '';
  let animTimers: number[] = [];

  const segKey = (): string => `${curAction}:${curSeg}`;
  // 当前动作"满组"帧数 (最大分段长度): 末组帧少时, 网格按它补空格 → 各组同高、切组不跳。
  const fullSegLen = (): number => (open?.actions[curAction]?.segments ?? []).reduce((m, s) => Math.max(m, s.length), 0);

  // 持久进度条: 插在两栏上方, 不随面板 renderBoth 重建而消失。
  const headPg = makePg();
  { const panels = els.panelL.parentElement; panels?.parentElement?.insertBefore(headPg, panels); }

  async function ensureCur(): Promise<void> {
    if (!open) return;
    const key = segKey();
    if (cur && curForKey === key) return;             // 缓存命中(换幕布/算法不重渲) → 不弹进度, 免闪
    // 仅当首次解该动作像素(走 Worker, 慢)才弹进度条; 同动作切组像素已缓存→渲染快→不弹, 免进度条占位推挤布局(切组跳动主因之一)。
    const action = open.actions[curAction];
    const slow = !action || !open.loadedImgs.has(action.imgIndex);
    if (slow) { pgShow(headPg, '渲染中…'); await raf(); }
    const eng = await getEngine();
    const r = await renderActionSegment(eng, open, curAction, curSeg, EXPORT_BG); // 懒解该动作像素
    cur = { meta: r.meta, geo: r.geo, cells: r.cells, ss: r.ss, exportCanvas: r.canvas };
    curForKey = key;
    if (slow) pgHide(headPg);
  }

  // ── 重抠当前组 (导入新图 / 改算法 / 改 despill / 改补刀色 时调) ──────────────────
  function reimportCurrent(): void {
    if (!open || !cur) return;
    const key = segKey();
    for (const [g, i] of cur.cells) open.replaced.delete(`${g},${i}`); // 先清这组旧帧再重抠
    const raw = rawAiByKey.get(key);
    if (!raw) { importedKeys.delete(key); return; }
    const n = importActionSegment(open, raw, cur.meta, { algo, despill });
    if (n > 0) importedKeys.add(key); else importedKeys.delete(key);
  }

  // 切「16格放空」重分组后, 按已换帧(open.replaced)重建各组"已重绘✓"标记 (分组变了, 换过的帧还在)。
  function rebuildImportedKeys(): void {
    importedKeys.clear();
    if (!open) return;
    const o = open;
    o.actions.forEach((a, ai) => a.segments.forEach((seg, si) => {
      if (seg.some(([g, i]) => o.replaced.has(`${g},${i}`))) importedKeys.add(`${ai}:${si}`);
    }));
  }

  // AI 图降采样上限(px): 抠图/对齐是 O(像素) 同步活, AI 出图常 ~1.5-2K, 整图跑好几遍会卡死主线程;
  // 输出精灵才 ~百 px, 1024 已绰绰有余 → 降采样后导入快很多、不再冻 UI。
  const MAX_AI_EDGE = 1024;
  async function onImportFile(file: File): Promise<void> {
    if (!open || !cur) return;
    pgShow(headPg, '处理重绘图中…'); await raf();
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, MAX_AI_EDGE / Math.max(bmp.width, bmp.height));
    const cw = Math.max(1, Math.round(bmp.width * sc)), ch = Math.max(1, Math.round(bmp.height * sc));
    const c = el('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, cw, ch); bmp.close();
    const id = ctx.getImageData(0, 0, cw, ch);
    rawAiByKey.set(segKey(), { data: id.data, width: id.width, height: id.height });
    reimportCurrent();
    pgHide(headPg);
    await renderBoth();
  }

  // ── 小部件 ──────────────────────────────────────────────────────────────────────
  function swatchRow(get: () => BgChoice, set: (b: BgChoice) => void): HTMLElement {
    const row = el('div', 'bg-row');
    row.appendChild(el('span', 'lbl', '幕布 (看抠图)'));
    for (const opt of BG_PRESETS) {
      const sw = el('button', 'bg-sw' + (get().key === opt.key ? ' active' : ''));
      sw.style.background = opt.css; sw.title = opt.label;
      sw.addEventListener('click', () => { set(opt); void renderBoth(); });
      row.appendChild(sw);
    }
    return row;
  }
  function typeTabs(): HTMLElement {
    const tabs = el('div', 'tabs');
    for (const [t, lab] of TYPE_DEFS) {
      const b = el('button', 'tab' + (subjType === t ? ' active' : ''), lab);
      b.addEventListener('click', () => { if (subjType !== t) void switchType(t); });
      tabs.appendChild(b);
    }
    return tabs;
  }
  /** 对象选择器: 搜索框(怪物/宠物) + 滚动列表。输入只重建列表(不 renderBoth) → 不丢输入焦点。 */
  function objectPicker(): HTMLElement {
    const box = el('div', 'objpick');
    const list = el('div', 'objlist');
    const renderList = (): void => {
      list.replaceChildren();
      const ql = objQuery.trim().toLowerCase();
      const filtered = ql
        ? objects.filter((o) => o.zh.toLowerCase().includes(ql) || o.label.toLowerCase().includes(ql) || o.fileName.toLowerCase().includes(ql))
        : objects;
      const CAP = 80;
      for (const o of filtered.slice(0, CAP)) {
        const row = el('button', 'objrow' + (open && o.fileName === open.fileName ? ' active' : ''));
        row.appendChild(el('span', 'objzh', o.zh));
        if (o.zh !== o.label) row.appendChild(el('span', 'objlabel', o.label));
        row.addEventListener('click', () => void selectObject(o));
        list.appendChild(row);
      }
      if (!objects.length) list.appendChild(el('p', 'muted', '此目录没找到该类型对象'));
      else if (!filtered.length) list.appendChild(el('p', 'muted', '没匹配的, 换个关键词'));
      else if (filtered.length > CAP) list.appendChild(el('p', 'muted', `显示前 ${CAP}/${filtered.length} 个，输入关键词缩小`));
    };
    if (subjType !== 'class') {
      const q = el('input', 'sel'); q.type = 'search';
      q.placeholder = subjType === 'monster' ? '搜怪物名 (英文/拼音)…' : '搜宠物名…';
      q.value = objQuery;
      q.addEventListener('input', () => { objQuery = q.value; renderList(); });
      box.appendChild(q);
    }
    renderList();
    box.appendChild(list);
    return box;
  }
  function actionNav(): HTMLElement {
    const nav = el('div', 'seg-nav');
    open!.actions.forEach((a, idx) => {
      const b = el('button', 'seg act' + (idx === curAction ? ' active' : ''), a.name + (a.isEffect ? ' ·特效' : ''));
      b.title = a.name + (a.isEffect ? ' (特效层: 黑底加色, 抠图可能要留黑)' : '');
      b.addEventListener('click', () => {
        if (idx === curAction) return;
        curAction = idx; curSeg = 0; cur = null; curForKey = '';
        void renderBoth();
      });
      nav.appendChild(b);
    });
    return nav;
  }
  function segNav(): HTMLElement {
    const nav = el('div', 'seg-nav');
    const segs = open!.actions[curAction]?.segments ?? [];
    segs.forEach((_, idx) => {
      const done = importedKeys.has(`${curAction}:${idx}`);
      const b = el('button', 'seg' + (idx === curSeg ? ' active' : '') + (done ? ' done' : ''), done ? `${idx + 1}✓` : `${idx + 1}`);
      b.addEventListener('click', () => { curSeg = idx; void renderBoth(); });
      nav.appendChild(b);
    });
    return nav;
  }
  function gridCell(canvas: HTMLCanvasElement | null, bg: string, placeholder?: string): HTMLElement {
    const c = el('div', 'cell' + (canvas ? '' : ' empty'));
    c.style.background = bg;
    if (canvas) c.appendChild(canvas); else if (placeholder) c.textContent = placeholder;
    return c;
  }

  // ── 左栏: 类型/对象/动作选择 + 原素材 ─────────────────────────────────────────────
  function buildLeft(): HTMLElement {
    const panel = el('section', 'panel');
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-tag', '原素材'), el('h2', undefined, open ? `${open.zh} · 原始序列帧` : '原始序列帧'));
    panel.appendChild(head);
    const actName = open && open.actions[curAction] ? open.actions[curAction]!.name : '';
    const actPrefix = open && open.actions.length > 1 ? `${actName} · ` : ''; // 单动作(职业)不显示 techy IMG 名
    panel.appendChild(el('p', 'panel-sub', open
      ? `${actPrefix}第 ${curSeg + 1}/${open.actions[curAction]?.segments.length ?? 0} 组 · 切组 → 导出给 AI`
      : '选个职业开始做补丁。'));

    const main = el('div', 'panel-main');
    const gridCol = el('div', 'bggrid-col');
    if (open && cur) {
      const grid = el('div', 'bggrid');
      grid.style.gridTemplateColumns = `repeat(${open.gridCols}, 1fr)`; // 显示列数随导出网格 (3 或 4)
      for (const [gr, im] of cur.cells) {
        const fr = cur.ss.get(gr, im);
        grid.appendChild(gridCell(fr?.img ? renderCellCanvas(fr.img as ImageData, fr.axis, cur.geo) : null, leftBg.css));
      }
      for (let k = cur.cells.length; k < fullSegLen(); k++) grid.appendChild(gridCell(null, leftBg.css)); // 末组帧少→补空格, 行数恒定不塌(切组不跳)
      gridCol.appendChild(grid);
      const gs = el('div', 'gridsegs');                    // 序列帧分组挪到网格下方 (左右布局协调)
      gs.appendChild(el('span', 'lbl', '序列帧分组'));
      gs.appendChild(segNav());
      gridCol.appendChild(gs);
    } else {
      gridCol.appendChild(el('p', 'muted', open ? '渲染中…' : '选个职业开始 →'));
    }
    main.appendChild(gridCol);

    const side = el('div', 'side');
    // 一级类型 + 二级对象 (始终在)。只暴露一个类型时(当前=只职业)不显示类型 tab, 直接列对象。
    if (TYPE_DEFS.length > 1) {
      side.appendChild(el('span', 'lbl', '对象类型'));
      side.appendChild(typeTabs());
    }
    side.appendChild(el('span', 'lbl', subjType === 'class' ? '选职业' : subjType === 'monster' ? '选怪物' : '选宠物'));
    side.appendChild(objectPicker());

    if (open && cur) {
      side.appendChild(el('p', 'preview-lbl', '原版 (循环播放)'));
      const prev = el('div', 'preview'); const pc = el('canvas');
      animTimers.push(animateStrip(pc, cur.ss, cur.cells, cur.geo, leftBg.css)); prev.appendChild(pc);
      side.appendChild(prev);
      if (open.actions.length > 1) { side.appendChild(el('span', 'lbl', `动作 (${open.actions.length})`)); side.appendChild(actionNav()); }
      const o = open, g = cur;
      // 导出网格下拉: 3×3 格大、AI 出图更稳 / 4×4 塞更多帧但每格小。切换 → setGrid 重设网格+重分组, 已换帧保留。
      side.appendChild(el('span', 'lbl', '导出网格'));
      const gsel = el('select', 'sel');
      for (const p of GRID_PRESETS) {
        const opt = el('option', undefined, p.label); opt.value = p.key;
        if (p.key === gridKey) opt.selected = true;
        gsel.appendChild(opt);
      }
      gsel.addEventListener('change', () => {
        gridKey = gsel.value;
        setGrid(o, gridSpecOf(gridKey));
        curSeg = 0; cur = null; curForKey = ''; rawAiByKey.clear(); rebuildImportedKeys();
        void renderBoth();
      });
      side.appendChild(gsel);
      const dl = el('button', 'btn block', '导出素材图');
      dl.addEventListener('click', () => g.exportCanvas.toBlob((bl) => {
        if (!bl) return;
        const a = el('a'); a.href = URL.createObjectURL(bl);
        a.download = `${o.zh}_${actName}_seg${curSeg + 1}.png`.replace(/[^\w.-]+/g, '_'); a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png'));
      side.appendChild(dl);
    }
    main.appendChild(side);
    panel.appendChild(main);
    return panel;
  }

  // ── 右栏: 成品 ───────────────────────────────────────────────────────────────────
  function buildRight(): HTMLElement {
    const panel = el('section', 'panel');
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-tag', '成品'), el('h2', undefined, '成品补丁'));
    panel.appendChild(head);
    const segN = open?.actions[curAction]?.segments.length ?? 0;
    const doneN = open ? [...importedKeys].filter((k) => k.startsWith(`${curAction}:`)).length : 0;
    panel.appendChild(el('p', 'panel-sub', open
      ? `把 AI 重绘图拖/点进网格 → 抠图 → 打包补丁 · 本动作已重绘 ${doneN}/${segN} 组`
      : '选对象后, 把 AI 重绘图拖/点进这边。'));

    const main = el('div', 'panel-main');
    const gridCol = el('div', 'bggrid-col');
    if (open && cur) {
      const o = open, g = cur;
      const grid = el('div', 'bggrid dropzone');
      grid.style.gridTemplateColumns = `repeat(${o.gridCols}, 1fr)`; // 显示列数随导出网格 (3 或 4)
      for (const [gr, im] of g.cells) {
        const fr = o.replaced.get(`${gr},${im}`);
        grid.appendChild(gridCell(fr ? renderCellCanvas(toImageData(fr.img), fr.axis, g.geo) : null, rightBg.css, '拖重绘图到这'));
      }
      for (let k = g.cells.length; k < fullSegLen(); k++) grid.appendChild(gridCell(null, rightBg.css)); // 末组补空格, 与左栏同高不跳
      const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'image/png,image/*'; fileIn.style.display = 'none';
      fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) void onImportFile(f); });
      grid.addEventListener('click', () => fileIn.click());
      grid.addEventListener('dragover', (e) => { e.preventDefault(); grid.classList.add('over'); });
      grid.addEventListener('dragleave', () => grid.classList.remove('over'));
      grid.addEventListener('drop', (e) => {
        e.preventDefault(); grid.classList.remove('over');
        const f = e.dataTransfer?.files?.[0]; if (f) void onImportFile(f);
      });
      gridCol.append(grid, fileIn);
      const gs = el('div', 'gridsegs');                    // 序列帧分组挪到网格下方 (与左栏对齐)
      gs.appendChild(el('span', 'lbl', '序列帧分组'));
      gs.appendChild(segNav());
      gridCol.appendChild(gs);
    } else {
      gridCol.appendChild(el('p', 'muted', '（先选个职业）'));
    }
    main.appendChild(gridCol);

    if (open && cur) {
      const o = open, g = cur;
      const side = el('div', 'side');
      side.appendChild(el('p', 'preview-lbl', '成品 (循环播放)'));
      const prev = el('div', 'preview'); const pc = el('canvas');
      const repSS = new SpriteSet();
      for (const [gr, im] of g.cells) {
        const fr = o.replaced.get(`${gr},${im}`);
        if (fr) repSS.set({ group: gr, image: im, size: [fr.img.width, fr.img.height], axis: fr.axis, img: toImageData(fr.img) });
      }
      animTimers.push(animateStrip(pc, repSS, g.cells, g.geo, rightBg.css)); prev.appendChild(pc);
      side.appendChild(prev);
      side.appendChild(swatchRow(() => rightBg, (b) => { rightBg = b; }));

      side.appendChild(buildAlgo());

      if (subjType === 'class') {                       // 隐藏时装仅职业有意义 (怪物/宠物无装备槽)
        const hide = el('button', 'btn block', '隐藏装备·露出本体');
        hide.addEventListener('click', () => void onHide(panel, hide));
        side.appendChild(hide);
      }
      const dep = el('button', 'btn primary block', '一键打包');
      dep.disabled = o.replaced.size === 0;
      dep.addEventListener('click', () => void onDeploy(panel, dep));
      side.appendChild(dep);
      main.appendChild(side);
    }
    panel.appendChild(main);
    return panel;
  }

  function buildAlgo(): HTMLElement {
    const box = el('div', 'algo');
    box.appendChild(el('span', 'lbl', '抠图算法'));
    const sel = el('select', 'sel');
    for (const [v, t] of [['floodkey', '自适应色键 (快)'], ['floodbg', '连通域 (撞色用)']] as const) {
      const op = el('option', undefined, t); op.value = v; if (algo === v) op.selected = true; sel.appendChild(op);
    }
    sel.addEventListener('change', () => { algo = sel.value as Algo; reimportCurrent(); void renderBoth(); });
    box.appendChild(sel);

    const chk = el('label', 'chk');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = despill;
    cb.addEventListener('change', () => { despill = cb.checked; reimportCurrent(); void renderBoth(); });
    chk.append(cb, document.createTextNode(' 去绿溢出 (绿色角色关掉)'));
    box.appendChild(chk);
    return box;
  }

  // ── 渲染编排 ─────────────────────────────────────────────────────────────────────
  async function renderBoth(): Promise<void> {
    animTimers.forEach((t) => clearInterval(t)); animTimers = [];
    if (open) await ensureCur();
    const sy = window.scrollY; // 整栏 replaceWith 后还原滚动位 → 切组/换算法不把页面弹走
    els.panelL.replaceWith(Object.assign(buildLeft(), { id: 'panelL' }));
    els.panelL = document.getElementById('panelL')!;
    els.panelR.hidden = false;
    els.panelR.replaceWith(Object.assign(buildRight(), { id: 'panelR' }));
    els.panelR = document.getElementById('panelR')!;
    if (window.scrollY !== sy) window.scrollTo({ top: sy });
  }

  // ── 类型切换 / 对象选择 ──────────────────────────────────────────────────────────
  async function switchType(t: SubjectType): Promise<void> {
    if (!dir) return;
    subjType = t; open = null; cur = null; curForKey = ''; curAction = 0; curSeg = 0; objQuery = '';
    importedKeys.clear(); rawAiByKey.clear();
    if (t === 'class') {
      objects = (await listSkins(dir)).map((s) => ({ fileName: s.fileName, label: s.zh, zh: s.zh, type: 'class' as const }));
    } else {
      if (!allFiles) {                                  // 首次切怪物/宠物 → 枚举整目录一次 (上万文件, 几秒, 之后缓存复用)
        pgShow(headPg, '扫描目录中…（上万文件，首次稍慢，之后秒切）'); await raf();
        allFiles = await listFileNames(dir);
        pgHide(headPg);
      }
      objects = filterSubjects(allFiles, t);
    }
    await renderBoth();
  }

  async function selectObject(entry: SubjectEntry): Promise<void> {
    if (!dir) return;
    els.panelL.innerHTML = '<p class="muted" style="padding:8px 0">解包中…</p>';
    els.panelR.hidden = false;
    els.panelR.innerHTML = '<p class="muted" style="padding:8px 0">解包中…</p>';
    pgShow(headPg, `解包 ${entry.zh}…（只解这一个对象, 不全解）`); await raf();
    try {
      const eng = await getEngine();
      const srcNpk = await readNpk(dir, entry.fileName);
      open = await openSubject(eng, srcNpk, entry.fileName, gridSpecOf(gridKey));
      curAction = 0; curSeg = 0; cur = null; curForKey = '';
      importedKeys.clear(); rawAiByKey.clear();
      await renderBoth();
    } catch (e) {
      pgHide(headPg);
      els.panelL.innerHTML = `<p class="failbar">打开失败: ${e instanceof Error ? e.message : String(e)}</p>`;
    }
  }

  async function onDeploy(panel: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (!open || !dir) return;
    btn.disabled = true;
    // 打包只重编改过的帧 (未改帧标 linked → wasm 原样字节拷贝), 不遍历全盘 → 通常很快, 忙碌态告知。
    pgShow(headPg, '回封补丁中…'); await raf();
    const eng = await getEngine();
    const { outNpk, patchName: pname, repCount, imgCount } = await deploySubject(eng, open);
    await writePatch(dir, pname, outNpk);
    pgHide(headPg);
    panel.appendChild(el('div', 'okbar',
      `已写 ${pname}（${(outNpk.length / 1024).toFixed(0)} KB）回目录 · 替换 ${repCount} 帧 / ${imgCount} 个 IMG · 原文件未改动 · 重启 DNF 看效果`));
  }

  async function onHide(panel: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    if (!open || !dir) return;
    const klass = parseSkin(open.fileName)?.klass;
    if (!klass) { panel.appendChild(el('div', 'failbar', '隐藏装备仅职业本体可用')); return; }
    const eng = await getEngine();
    btn.disabled = true;
    const sources = await listHideSources(dir, klass);
    if (!sources.length) { btn.disabled = false; panel.appendChild(el('div', 'failbar', '没找到该职业的装备/武器 NPK')); return; }
    const allImgs: HideImg[] = [];
    for (let i = 0; i < sources.length; i++) {       // 逐源 scan, 每个扫完即释放 → 内存峰值=单源 (避免一次性塞 ~0.6GB)
      pgShow(headPg, `扫描装备 ${i + 1}/${sources.length}…`, i / sources.length); await raf();
      allImgs.push(...await eng.hideScan(await readNpk(dir, sources[i]!)));
    }
    pgShow(headPg, '造隐藏包…', 0.96); await raf();
    const patch = await eng.hideBuild(allImgs);
    const name = hidePatchName(klass);
    await writePatch(dir, name, patch);
    pgHide(headPg);
    panel.appendChild(el('div', 'okbar',
      `已写 ${name}（${(patch.length / 1024).toFixed(0)} KB）· 藏 ${sources.length} 个装备/武器包共 ${allImgs.length} 槽 · 只藏${open.zh}、原文件未改 · 重启 DNF 露出本体`));
  }

  // 选目录: 默认进职业(直取已知职业名, 不枚举/不解包) → 渲两栏空态(左栏带类型+对象选择) → 选对象才解包。
  async function openWithDir(d: FsaDirHandle): Promise<void> {
    dir = d;
    open = null; cur = null; curForKey = ''; allFiles = null; subjType = 'class'; objQuery = '';
    curAction = 0; curSeg = 0;
    importedKeys.clear(); rawAiByKey.clear();
    els.dir.hidden = false;
    els.dir.textContent = '查找角色…';
    els.panelL.innerHTML = '<p class="muted" style="padding:8px 0">查找职业中…（按已知职业名直取，不枚举目录、不解包）</p>';
    els.panelR.hidden = true;
    await raf();
    objects = (await listSkins(d)).map((s) => ({ fileName: s.fileName, label: s.zh, zh: s.zh, type: 'class' as const }));
    els.dir.textContent = `职业 ${objects.length} 个`;
    await renderBoth(); // 两栏空态, 左栏选对象; 选了才解包那一个
  }

  els.pick.addEventListener('click', async () => {
    try {
      const d = await pickImagePacksDir();
      void idbSet(DIR_KEY, d).catch(() => undefined);
      await openWithDir(d);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // 用户取消选目录 = 正常操作, 不当错误显示
      els.dir.hidden = false;
      els.dir.textContent = e instanceof Error ? e.message : String(e);
    }
  });

  // 上次目录需"再点一次授权"时的提示按钮 (浏览器安全: 跨会话恢复读写要一次用户手势)。
  function showResume(h: PermHandle): void {
    const name = h.name ?? '上次的目录';
    const box = el('div'); box.style.padding = '8px 0';
    box.appendChild(el('p', 'muted', `上次选过 “${name}”。点下面恢复访问(浏览器要你确认一次), 不用重新翻目录。`));
    const b = el('button', 'btn primary', `继续上次目录：${name}`);
    b.addEventListener('click', async () => {
      if (await ensureRw(h, true)) { void idbSet(DIR_KEY, h).catch(() => undefined); await openWithDir(h); }
      else { els.dir.hidden = false; els.dir.textContent = '没拿到授权, 请用上方"选择 DNF 目录"重选'; }
    });
    box.appendChild(b);
    els.panelL.replaceChildren(box);
    els.panelR.hidden = true;
  }

  async function tryRestore(): Promise<void> {
    let h: PermHandle | undefined;
    try { h = await idbGet<PermHandle>(DIR_KEY); } catch { return; }
    if (!h) return;
    try {
      if (await ensureRw(h, false)) await openWithDir(h);
      else showResume(h);
    } catch { /* 句柄失效(目录被删/移走), 保持默认"选择 DNF 目录" */ }
  }
  void tryRestore();

  return { openWithDir };
}
