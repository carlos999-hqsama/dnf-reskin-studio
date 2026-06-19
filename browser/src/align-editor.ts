// 对齐编辑器 (全屏 modal) — 把"导入 AI 重绘图"从【自动定死】改成【人工逐帧精调】。蓝图核心: 两层独立对齐
//   每帧最终 axis = relAxis (逐帧拖, 治"游戏里一跳一跳") + groupOffset (整组平移锚原版, 绝不逐帧贴 — 原版 axis 抖 200px)。
// 纯 UI: 几何/像素全复用 core (render-canvas / pixels / workflow.motionGeo), 这里只管 DOM/事件/拖拽/洋葱皮/循环预览。
// 用法: const result = await openAlignEditor({...}); 确认 → 返回编辑后的 SegmentEdit; 取消 → null。原 edit 不被改 (内部克隆)。
import { SpriteSet, type Cell, type RGBA } from './model';
import type { Geometry } from './geometry';
import type { ImportMeta, EditFrame } from './import';
import { type SegmentEdit, autoGroupOffset, motionGeo } from './workflow';
import { getBbox, footCenterX } from './pixels';
import { renderCellCanvas, drawGhost } from './render-canvas';

const mid = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0; };
const toImageData = (img: RGBA): ImageData => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function cloneEdit(e: SegmentEdit): SegmentEdit {
  return {
    frames: e.frames.map((f) => ({ ...f, relAxis: [f.relAxis[0], f.relAxis[1]] as [number, number] })),
    groupOffset: [e.groupOffset[0], e.groupOffset[1]],
  };
}

export interface AlignEditorOpts {
  /** 要编辑的中间态 (frames + groupOffset)。编辑器内部克隆, 确认才返回新值 (取消不污染原 edit)。 */
  edit: SegmentEdit;
  /** 这组的 (g,i) 顺序 (帧平铺/预览参考)。 */
  cells: Cell[];
  /** 原版帧 (叠原版洋葱皮 + 脚底参考线 + 循环预览对照)。img 须为真 ImageData。 */
  origSS: SpriteSet;
  /** 导出 meta (srcAxis → 一键对齐原版用)。 */
  meta: ImportMeta;
  /** 幕布色 (看抠图干不干净)。 */
  bg: string;
  /** 标题 (如 "格斗家 · 走 · 第 2 组")。 */
  title?: string;
}

const STYLE_ID = 'ae-style';
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = el('style');
  s.id = STYLE_ID;
  s.textContent = `
.ae-overlay{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;
  background:rgba(20,20,22,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);padding:18px}
.ae-modal{background:var(--card);border-radius:16px;box-shadow:0 16px 60px rgba(0,0,0,.4);
  width:min(1120px,96vw);height:min(880px,92vh);display:flex;flex-direction:column;padding:16px 18px;gap:12px}
.ae-head{display:flex;align-items:center;gap:12px}
.ae-head h3{font-size:16px;font-weight:600;margin:0;letter-spacing:-.01em}
.ae-head .ae-grow{flex:1}
.ae-tag{font-size:11.5px;color:var(--ink3);background:var(--bg);border-radius:980px;padding:4px 11px}
.ae-body{display:flex;gap:16px;flex:1;min-height:0}
.ae-stage{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;
  background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;position:relative}
.ae-canvas{max-width:100%;max-height:100%;image-rendering:pixelated;cursor:grab;touch-action:none}
.ae-canvas.grabbing{cursor:grabbing}
.ae-side{width:300px;flex:none;display:flex;flex-direction:column;gap:11px;overflow-y:auto;padding-right:3px}
.ae-strip{display:flex;flex-wrap:wrap;gap:5px}
.ae-thumb{width:54px;height:54px;border:2px solid var(--line2);border-radius:8px;overflow:hidden;
  cursor:pointer;background:var(--bg);padding:0;line-height:0;position:relative}
.ae-thumb.active{border-color:var(--blue);box-shadow:0 0 0 3px #f0f7ff}
.ae-thumb canvas{width:100%;height:100%;display:block}
.ae-prevs{display:flex;gap:10px}
.ae-prevbox{flex:1;display:flex;flex-direction:column;gap:3px;align-items:center;min-width:0}
.ae-prevbox .preview{border:1px solid var(--line);border-radius:10px;background:#8a8d93;
  aspect-ratio:1;position:relative;overflow:hidden;line-height:0;width:100%}
.ae-prevbox .preview canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.ae-prevbox .ae-plbl{font-size:11px;color:var(--ink3);margin:0}
.ae-modebtns{display:flex;gap:6px}
.ae-modebtns .btn{flex:1}
.ae-modebtns .btn.on{border-color:var(--blue);color:var(--blue);background:#f0f7ff}
.ae-hint{font-size:11.5px;color:var(--ink3);line-height:1.55;margin:0}
.ae-hint b{color:var(--ink);font-weight:600}
.ae-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ae-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:14px}
`;
  document.head.appendChild(s);
}

/** 打开对齐编辑器。Promise resolve: 确认 → 编辑后的 SegmentEdit; 取消/Esc → null。 */
export function openAlignEditor(opts: AlignEditorOpts): Promise<SegmentEdit | null> {
  return new Promise((resolve) => {
    ensureStyle();
    const work = cloneEdit(opts.edit);
    const frames = work.frames;

    let curIdx = 0;
    let mode: 'frame' | 'group' = 'frame';
    let showPrev = true, showNext = true, showOrig = false;
    let ghostA = 0.4;
    const timers: number[] = [];

    // 当前帧的有效轴 = relAxis + groupOffset (实际入游戏的 axis)。
    const eff = (f: EditFrame): [number, number] => [f.relAxis[0] + work.groupOffset[0], f.relAxis[1] + work.groupOffset[1]];

    // 原版组脚底落点中位 (内容底/脚底中心 相对原版 axis) → 编辑画布上的参考线 (当前帧脚底贴它 = 对齐原版)。
    const ofy: number[] = [], ofx: number[] = [];
    for (const f of frames) {
      const o = opts.origSS.get(f.g, f.i);
      if (!o?.img) continue;
      const bb = getBbox(o.img as RGBA);
      if (!bb) continue;
      ofy.push(bb[3] - o.axis[1]);
      ofx.push(footCenterX(o.img as RGBA, bb) - o.axis[0]);
    }
    const refFootRelY = ofy.length ? mid(ofy) : 0;
    const refMidRelX = ofx.length ? mid(ofx) : 0;

    // 编辑画布几何: 按所有帧 effectiveAxis 的内容世界并集 + 大 padding 给拖动余量。固定 (拖动不重算, 免画布跳); "重置视图"重算。
    function computeEditGeo(): Geometry {
      let UL = Infinity, UT = Infinity, UR = -Infinity, UB = -Infinity;
      for (const f of frames) {
        const bb = getBbox(f.sprite);
        if (!bb) continue;
        const [ax, ay] = eff(f);
        UL = Math.min(UL, bb[0] - ax); UT = Math.min(UT, bb[1] - ay);
        UR = Math.max(UR, bb[2] - ax); UB = Math.max(UB, bb[3] - ay);
      }
      if (!Number.isFinite(UL)) return { cellW: 240, cellH: 240, anchor: [120, 120], scale: 1 };
      // 参考线也要进可视范围 (脚底参考可能在内容外)。
      UT = Math.min(UT, refFootRelY); UB = Math.max(UB, refFootRelY);
      UL = Math.min(UL, refMidRelX); UR = Math.max(UR, refMidRelX);
      const PAD = 70;
      return {
        cellW: Math.round(UR - UL) + 2 * PAD, cellH: Math.round(UB - UT) + 2 * PAD,
        anchor: [Math.round(-UL) + PAD, Math.round(-UT) + PAD], scale: 1,
      };
    }
    let editGeo = computeEditGeo();

    // ── DOM 骨架 ───────────────────────────────────────────────────────────────────
    const overlay = el('div', 'ae-overlay');
    const modal = el('div', 'ae-modal');
    const head = el('div', 'ae-head');
    head.appendChild(el('h3', undefined, opts.title ?? '对齐编辑器'));
    head.appendChild(el('span', 'ae-tag', '拖帧对齐 · 看预览两边运动一致'));
    head.appendChild(el('div', 'ae-grow'));
    const cancelBtn = el('button', 'btn', '取消');
    const okBtn = el('button', 'btn primary', '确认并应用');
    head.append(cancelBtn, okBtn);
    modal.appendChild(head);

    const body = el('div', 'ae-body');
    const stage = el('div', 'ae-stage');
    const mainCv = el('canvas', 'ae-canvas');
    const side = el('div', 'ae-side');
    body.append(stage, side);
    modal.appendChild(body);
    overlay.appendChild(modal);

    function cleanup(): void {
      timers.forEach((t) => clearInterval(t));
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }

    // frames 空 (AI 这组全没画/全去背成空) → 只能取消。
    if (!frames.length) {
      stage.appendChild(el('div', 'ae-empty', '这组没识别到重绘帧 (AI 没画或全被去背)。换张图或调抠图算法。'));
      okBtn.disabled = true;
      cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      return;
    }

    mainCv.width = editGeo.cellW;
    mainCv.height = editGeo.cellH;
    stage.appendChild(mainCv);
    const ctx = mainCv.getContext('2d')!;

    // ── 主画布渲染 ─────────────────────────────────────────────────────────────────
    function redraw(): void {
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, mainCv.width, mainCv.height);
      // 参考线: 蓝竖=横向注册中线 (原版脚底中心), 红横=脚底基线 (原版内容底)。当前帧脚底贴交点 = 对齐原版。
      const lx = Math.round(editGeo.anchor[0] + refMidRelX), ly = Math.round(editGeo.anchor[1] + refFootRelY);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,113,227,.55)';
      ctx.beginPath(); ctx.moveTo(lx + 0.5, 0); ctx.lineTo(lx + 0.5, mainCv.height); ctx.stroke();
      ctx.strokeStyle = 'rgba(220,40,40,.6)';
      ctx.beginPath(); ctx.moveTo(0, ly + 0.5); ctx.lineTo(mainCv.width, ly + 0.5); ctx.stroke();

      const cur = frames[curIdx]!;
      if (showOrig) {
        const o = opts.origSS.get(cur.g, cur.i);
        if (o?.img) drawGhost(ctx, o.img as ImageData, o.axis, editGeo.anchor, editGeo.scale, ghostA, 'rgba(110,200,120,.95)');
      }
      if (showPrev && curIdx > 0) {
        const p = frames[curIdx - 1]!;
        drawGhost(ctx, toImageData(p.sprite), eff(p), editGeo.anchor, editGeo.scale, ghostA, 'rgba(50,120,255,.95)');
      }
      if (showNext && curIdx < frames.length - 1) {
        const nx = frames[curIdx + 1]!;
        drawGhost(ctx, toImageData(nx.sprite), eff(nx), editGeo.anchor, editGeo.scale, ghostA, 'rgba(255,70,70,.95)');
      }
      drawGhost(ctx, toImageData(cur.sprite), eff(cur), editGeo.anchor, editGeo.scale, 1); // 当前帧实色最上
    }

    // ── 拖拽: 改当前帧 relAxis (frame) 或整组 groupOffset (group) ──────────────────
    let dragging = false, sx = 0, sy = 0;
    let startRel: [number, number] = [0, 0], startGO: [number, number] = [0, 0];
    const canvasXY = (e: PointerEvent): [number, number] => {
      const r = mainCv.getBoundingClientRect();
      return [(e.clientX - r.left) * (mainCv.width / r.width), (e.clientY - r.top) * (mainCv.height / r.height)];
    };
    mainCv.addEventListener('pointerdown', (e) => {
      dragging = true; mainCv.classList.add('grabbing');
      try { mainCv.setPointerCapture(e.pointerId); } catch { /* 合成事件无 active pointer 时忽略 */ }
      [sx, sy] = canvasXY(e);
      const c = frames[curIdx]!;
      startRel = [c.relAxis[0], c.relAxis[1]];
      startGO = [work.groupOffset[0], work.groupOffset[1]];
    });
    mainCv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const [x, y] = canvasXY(e);
      const dx = (x - sx) / editGeo.scale, dy = (y - sy) / editGeo.scale; // 视觉位移 (右/下正)
      if (mode === 'group') work.groupOffset = [Math.round(startGO[0] - dx), Math.round(startGO[1] - dy)];
      else frames[curIdx]!.relAxis = [Math.round(startRel[0] - dx), Math.round(startRel[1] - dy)]; // axis = anchor-draw → 视觉右移=axis减
      redraw();
    });
    const endDrag = (): void => { if (!dragging) return; dragging = false; mainCv.classList.remove('grabbing'); refreshThumb(curIdx); restartPreview(); };
    mainCv.addEventListener('pointerup', endDrag);
    mainCv.addEventListener('pointercancel', endDrag);

    // ── 帧平铺缩略图 ──────────────────────────────────────────────────────────────
    function thumbCanvas(f: EditFrame): HTMLCanvasElement {
      const c = el('canvas'); c.width = 54; c.height = 54;
      const x = c.getContext('2d')!;
      x.fillStyle = opts.bg; x.fillRect(0, 0, 54, 54);
      const bb = getBbox(f.sprite);
      if (bb) {
        const cw = bb[2] - bb[0], ch = bb[3] - bb[1], s = Math.min(46 / cw, 46 / ch, 2);
        const tmp = el('canvas'); tmp.width = f.sprite.width; tmp.height = f.sprite.height;
        tmp.getContext('2d')!.putImageData(toImageData(f.sprite), 0, 0);
        x.imageSmoothingEnabled = s !== 1;
        x.drawImage(tmp, bb[0], bb[1], cw, ch, (54 - cw * s) / 2, (54 - ch * s) / 2, cw * s, ch * s);
      }
      return c;
    }
    const strip = el('div', 'ae-strip');
    const thumbWraps: HTMLButtonElement[] = [];
    frames.forEach((f, idx) => {
      const w = el('button', 'ae-thumb' + (idx === curIdx ? ' active' : ''));
      w.appendChild(thumbCanvas(f));
      w.addEventListener('click', () => { curIdx = idx; refreshActive(); redraw(); });
      thumbWraps.push(w);
      strip.appendChild(w);
    });
    function refreshActive(): void { thumbWraps.forEach((w, i) => w.classList.toggle('active', i === curIdx)); frameLbl.textContent = `第 ${curIdx + 1} / ${frames.length} 帧`; }
    function refreshThumb(idx: number): void {
      const w = thumbWraps[idx]; if (!w) return;
      w.replaceChildren(thumbCanvas(frames[idx]!));
    }

    const frameLbl = el('p', 'ae-hint', `第 ${curIdx + 1} / ${frames.length} 帧`);

    // ── 模式: 拖单帧 / 拖整组 ─────────────────────────────────────────────────────
    const modeBox = el('div', 'ae-modebtns');
    const mFrame = el('button', 'btn on', '拖单帧');
    const mGroup = el('button', 'btn', '拖整组');
    mFrame.addEventListener('click', () => { mode = 'frame'; mFrame.classList.add('on'); mGroup.classList.remove('on'); });
    mGroup.addEventListener('click', () => { mode = 'group'; mGroup.classList.add('on'); mFrame.classList.remove('on'); });
    modeBox.append(mFrame, mGroup);

    // ── 洋葱皮控制 ────────────────────────────────────────────────────────────────
    function chk(label: string, init: boolean, on: (v: boolean) => void): HTMLElement {
      const l = el('label', 'chk'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = init;
      cb.addEventListener('change', () => { on(cb.checked); redraw(); });
      l.append(cb, document.createTextNode(' ' + label));
      return l;
    }
    const onionBox = el('div', 'algo');
    onionBox.appendChild(el('span', 'lbl', '洋葱皮 (叠半透明残影对齐)'));
    onionBox.appendChild(chk('前一帧 (蓝)', showPrev, (v) => (showPrev = v)));
    onionBox.appendChild(chk('后一帧 (红)', showNext, (v) => (showNext = v)));
    onionBox.appendChild(chk('原版 (绿)', showOrig, (v) => (showOrig = v)));
    const aRow = el('div', 'ae-row');
    aRow.appendChild(el('span', 'lbl', '残影透明度'));
    const aRng = el('input', 'sel'); aRng.type = 'range'; aRng.min = '0.15'; aRng.max = '0.75'; aRng.step = '0.05'; aRng.value = String(ghostA); aRng.style.flex = '1';
    aRng.addEventListener('input', () => { ghostA = +aRng.value; redraw(); });
    aRow.appendChild(aRng);
    onionBox.appendChild(aRow);

    // ── 对齐原版 (整组) + 重置视图 ───────────────────────────────────────────────
    const alignBox = el('div', 'algo');
    alignBox.appendChild(el('span', 'lbl', '整组锚原版 (大差不差即可, 别逐帧贴)'));
    const autoBtn = el('button', 'btn block', '一键对齐原版');
    autoBtn.addEventListener('click', () => {
      work.groupOffset = autoGroupOffset(work, opts.meta);
      redraw(); restartPreview();
    });
    alignBox.appendChild(autoBtn);
    alignBox.appendChild(el('p', 'ae-hint', '或切「拖整组」在画布上拖到大致贴原版。'));
    const resetBtn = el('button', 'btn block', '重置视图 (帧拖出框时用)');
    resetBtn.addEventListener('click', () => { editGeo = computeEditGeo(); mainCv.width = editGeo.cellW; mainCv.height = editGeo.cellH; redraw(); });
    alignBox.appendChild(resetBtn);

    // ── 循环预览: 成品 vs 原版 (运动一致 = 对齐对) ──────────────────────────────────
    const prevs = el('div', 'ae-prevs');
    const repBox = el('div', 'ae-prevbox'); const repPrev = el('div', 'preview'); const repCv = el('canvas'); repPrev.appendChild(repCv);
    repBox.append(repPrev, el('p', 'ae-plbl', '成品'));
    const origBox = el('div', 'ae-prevbox'); const origPrev = el('div', 'preview'); const origCv = el('canvas'); origPrev.appendChild(origCv);
    origBox.append(origPrev, el('p', 'ae-plbl', '原版'));
    prevs.append(repBox, origBox);

    function animate(cv: HTMLCanvasElement, ss: SpriteSet, cells: Cell[], bg: string): number {
      const mg = motionGeo(ss, cells);
      cv.width = mg.cellW; cv.height = mg.cellH;
      const x = cv.getContext('2d')!;
      const present = cells.filter(([g, i]) => ss.get(g, i)?.img);
      let i = 0;
      const tick = (): void => {
        x.fillStyle = bg; x.fillRect(0, 0, cv.width, cv.height);
        if (!present.length) return;
        const [g, im] = present[i % present.length]!;
        const fr = ss.get(g, im)!;
        x.drawImage(renderCellCanvas(fr.img as ImageData, fr.axis, mg), 0, 0);
        i++;
      };
      tick();
      return setInterval(tick, 90) as unknown as number;
    }
    function restartPreview(): void {
      timers.forEach((t) => clearInterval(t)); timers.length = 0;
      const cellsP = frames.map((f) => [f.g, f.i] as Cell);
      const repSS = new SpriteSet();
      for (const f of frames) {
        const e = eff(f);
        repSS.set({ group: f.g, image: f.i, size: [f.sprite.width, f.sprite.height], axis: [e[0], e[1]], img: toImageData(f.sprite) });
      }
      timers.push(animate(repCv, repSS, cellsP, opts.bg));
      timers.push(animate(origCv, opts.origSS, cellsP, opts.bg));
    }

    // ── 键盘: ←→↑↓ 微调 (Shift×10), Esc 取消, Enter 确认 ─────────────────────────
    function nudge(vx: number, vy: number): void {
      if (mode === 'group') work.groupOffset = [work.groupOffset[0] - vx, work.groupOffset[1] - vy];
      else { const c = frames[curIdx]!; c.relAxis = [c.relAxis[0] - vx, c.relAxis[1] - vy]; refreshThumb(curIdx); }
      redraw(); restartPreview();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { cleanup(); resolve(null); return; }
      if (e.key === 'Enter') { cleanup(); resolve(work); return; }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudge(-step, 0);
      else if (e.key === 'ArrowRight') nudge(step, 0);
      else if (e.key === 'ArrowUp') nudge(0, -step);
      else if (e.key === 'ArrowDown') nudge(0, step);
      else return;
      e.preventDefault();
    }

    // ── 装配右栏 ──────────────────────────────────────────────────────────────────
    side.appendChild(el('span', 'lbl', '帧 (点选要调的帧)'));
    side.appendChild(strip);
    side.appendChild(frameLbl);
    side.appendChild(modeBox);
    side.appendChild(onionBox);
    side.appendChild(alignBox);
    side.appendChild(prevs);
    const tip = el('p', 'ae-hint');
    tip.innerHTML = '<b>拖画布</b>挪当前帧 · <b>←→↑↓</b> 微调(Shift×10) · 叠<b>前/后帧</b>拖到衔接连贯 · 看两个预览<b>运动一致</b>就对了';
    side.appendChild(tip);

    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });
    okBtn.addEventListener('click', () => { cleanup(); resolve(work); });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    redraw();
    restartPreview();
  });
}
