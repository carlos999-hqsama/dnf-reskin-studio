// 开发自检入口 (PoC) — 把阶段 1/2 的验证脚手架 (解包显示 / core 对齐渲染 / 补丁闭环 / OPFS 数据流)
// 收成一处, 与产品工作台 (workbench) 隔离。这些按钮 + window 钩子只为开发期 preview 验证, 不是玩家功能。
import type { AsyncEngine, DnfManifest } from './engine';
import { decodePng } from './png';
import { buildStripCanvas, renderCellCanvas } from './render-canvas';
import { SpriteSet, type Cell, type RGBA } from './model';
import { computeGeometry } from './geometry';
import { coreSourceImg } from './dnf-rules';
import { getBbox, footCenterX } from './pixels';
import { openSubject, renderActionSegment, motionGeo, buildSegmentEdit, type OpenSubject } from './workflow';
import { importActionGrid } from './import';
import { openAlignEditor } from './align-editor';
import { runReskinLoop } from './reskin-demo';
import { verifyWithOpfs, verifySubjectWithOpfs } from './verify-opfs';
import type { WorkbenchHandle } from './workbench';
import type { FsaDirHandle } from './fs-access';

interface ManFrame {
  img_index: number; frame_index: number; file: string;
  pic_width: number; pic_height: number; offset_x: number; offset_y: number; linked: boolean;
}

/** 解包 → 把前 24 帧画出来 (纯客户端, 零服务器)。设 window.__DEMO__ 供 preview 断言。 */
async function unpackAndShow(eng: AsyncEngine, out: HTMLElement, npk: Uint8Array): Promise<number> {
  out.innerHTML = '解包中…';
  const t0 = performance.now();
  const res = await eng.unpack(npk);
  const ms = Math.round(performance.now() - t0);
  const manFrames = (res.manifest as { frames: unknown[] }).frames.length;
  out.innerHTML = `<p class="stat">解出 ${res.frames.length} 帧 · manifest ${manFrames} 条 · ${ms}ms (纯浏览器, 零服务器)</p>`;
  for (const f of res.frames.slice(0, 24)) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(new Blob([new Uint8Array(f.png)], { type: 'image/png' }));
    img.title = f.name;
    out.appendChild(img);
  }
  (window as unknown as { __DEMO__: unknown }).__DEMO__ = { frames: res.frames.length, manFrames, ms };
  return res.frames.length;
}

/** 解包 → PNG decode → 构造 Frame → core 算几何 → 渲对齐横图。设 window.__ALIGN__ 供 preview 断言。 */
async function renderAligned(eng: AsyncEngine, out: HTMLElement, npk: Uint8Array): Promise<void> {
  out.innerHTML = '解包 + TS core 对齐渲染中…';
  const res = await eng.unpack(npk);
  const man = res.manifest as { frames: ManFrame[] };
  const metaFrames = man.frames.filter((f) => f.img_index === 0 && !f.linked).slice(0, 12);
  const pngByFile = new Map(res.frames.map((f) => [f.name, f.png]));
  const ss = new SpriteSet();
  const cells: Cell[] = [];
  for (const mf of metaFrames) {
    const png = pngByFile.get(mf.file);
    if (!png) continue;
    const img = await decodePng(png);
    ss.set({ group: mf.img_index, image: mf.frame_index, size: [mf.pic_width, mf.pic_height], axis: [mf.offset_x, mf.offset_y], img });
    cells.push([mf.img_index, mf.frame_index]);
  }
  const geo = computeGeometry(ss, cells, 300);
  const strip = buildStripCanvas(ss, cells, geo);
  strip.style.cssText = 'border:1px solid #d2d2d7;max-width:100%;image-rendering:pixelated;display:block;margin-top:8px';
  out.innerHTML = `<p class="stat">TS core 渲染对齐横图: ${cells.length} 帧 · 格 ${geo.cellW}×${geo.cellH} · scale ${geo.scale.toFixed(2)} · 锚 (${geo.anchor[0]},${geo.anchor[1]}) — 红线=脚底锚, 各帧脚底应贴齐</p>`;
  out.appendChild(strip);
  (window as unknown as { __ALIGN__: unknown }).__ALIGN__ = { cells: cells.length, cellW: geo.cellW, cellH: geo.cellH, scale: geo.scale, anchor: geo.anchor };
}

/** 装上所有 PoC 按钮 + window 自检钩子。getEngine 单例由 main 提供; wb 用于 OPFS 驱动工作台。 */
export function installDevHarness(getEngine: () => Promise<AsyncEngine>, wb: WorkbenchHandle): void {
  const out = document.getElementById('out') as HTMLDivElement;
  const fetchNpk = async (): Promise<Uint8Array> => new Uint8Array(await (await fetch('/test.NPK')).arrayBuffer());

  document.getElementById('btn')!.addEventListener('click', async () => { await unpackAndShow(await getEngine(), out, await fetchNpk()); });
  document.getElementById('file')!.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) await unpackAndShow(await getEngine(), out, new Uint8Array(await f.arrayBuffer()));
  });
  document.getElementById('btnAlign')!.addEventListener('click', async () => { await renderAligned(await getEngine(), out, await fetchNpk()); });
  document.getElementById('btnReskin')!.addEventListener('click', async () => { await runReskinLoop(await getEngine(), await fetchNpk(), out); });

  // preview 自动验证钩子。
  const w = window as unknown as Record<string, unknown>;
  const fetchBytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(path)).arrayBuffer());
  w.__runDemo = async () => unpackAndShow(await getEngine(), out, await fetchNpk());
  w.__runAlign = async () => renderAligned(await getEngine(), out, await fetchNpk());
  w.__runReskin = async () => runReskinLoop(await getEngine(), await fetchNpk(), out);
  w.__verifyFsa = async () => verifyWithOpfs(await getEngine(), await fetchNpk());
  // 三类对象 OPFS 端到端验证 (职业/怪物/宠物) — 数据流真实跑, 免 picker。
  w.__verifyAll = async () => {
    const eng = await getEngine();
    const cls = await verifySubjectWithOpfs(eng, await fetchNpk(), 'sprite_character_imperialknight_equipment_avatar_skin.NPK');
    const mon = await verifySubjectWithOpfs(eng, await fetchBytes('/monster.NPK'), 'sprite_monster_anton_phase3_po.NPK');
    const pet = await verifySubjectWithOpfs(eng, await fetchBytes('/pet.NPK'), 'sprite_pet_falcon.NPK');
    return { cls, mon, pet, allOk: cls.ok && mon.ok && pet.ok };
  };
  // ── 序列帧对齐诊断 (dev-only): 量格斗家本体每帧真实 size/axis/内容bbox, 砸实"对齐"猜想 ──────────
  // 真值用真·格斗家 (public/fighter.NPK, 紧裁包复现不出 → 必须用它)。decodePng 走浏览器 canvas。
  w.__measureFighter = async () => {
    const eng = await getEngine();
    const res = await eng.unpack(await fetchBytes('/fighter.NPK'));
    const man = res.manifest as DnfManifest;
    const bodyImg = coreSourceImg(man);
    const frames = man.frames.filter((f) => f.img_index === bodyImg && !f.linked)
      .sort((a, b) => a.frame_index - b.frame_index);
    const pngByFile = new Map(res.frames.map((f) => [f.name, f.png]));
    const rows: Record<string, number | null>[] = [];
    for (const mf of frames) {
      const png = pngByFile.get(mf.file);
      if (!png) continue;
      const img = await decodePng(png);
      const bb = getBbox(img as unknown as RGBA); // [x0,y0,x1,y1] exclusive; 全透明 null
      rows.push({
        fi: mf.frame_index, w: mf.pic_width, h: mf.pic_height, ax: mf.offset_x, ay: mf.offset_y,
        bbT: bb ? bb[1] : null, bbB: bb ? bb[3] : null, bbL: bb ? bb[0] : null, bbR: bb ? bb[2] : null,
        cW: bb ? bb[2] - bb[0] : 0, cH: bb ? bb[3] - bb[1] : 0,
        footMinusAxisY: bb ? bb[3] - mf.offset_y : null,           // 内容底 - axis_y (axis_y 在不在脚底?)
        cxMinusAxisX: bb ? Math.round((bb[0] + bb[2]) / 2 - mf.offset_x) : null, // 内容水平中心 - axis_x
      });
    }
    const stat = (key: string): { min: number; med: number; max: number; range: number } => {
      const xs = rows.map((r) => r[key]).filter((v): v is number => v != null).sort((a, b) => a - b);
      return { min: xs[0]!, med: xs[xs.length >> 1]!, max: xs[xs.length - 1]!, range: xs[xs.length - 1]! - xs[0]! };
    };
    const summary = { bodyImg, n: rows.length, cH: stat('cH'), footMinusAxisY: stat('footMinusAxisY'), cxMinusAxisX: stat('cxMinusAxisX') };
    (window as unknown as Record<string, unknown>).__FIGHTER_MEASURE = { summary, rows };
    return summary;
  };

  // ── 对齐验证 (dev-only): 用真·重绘图跑真 import, 量化"成品逐帧 placed-by-axis 的稳定性" + 画轴对齐横图 ──
  // segIdx 0-based; redrawUrl=public 下的重绘图 (如 /redraw5.jpg)。结果写 window.__TEST_IMPORT (eval 超时则轮询)。
  let fighterOpen: OpenSubject | null = null;
  const decodeUrlToRGBA = async (url: string): Promise<RGBA> => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const MAX = 1024, sc = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const cw = Math.max(1, Math.round(bmp.width * sc)), ch = Math.max(1, Math.round(bmp.height * sc));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, cw, ch); bmp.close();
    const id = ctx.getImageData(0, 0, cw, ch);
    return { data: id.data, width: cw, height: ch };
  };
  const rng = (xs: number[]): { min: number; max: number; range: number } => {
    const s = xs.slice().sort((a, b) => a - b);
    return { min: s[0]!, max: s[s.length - 1]!, range: s[s.length - 1]! - s[0]! };
  };
  w.__testImport = async (segIdx: number, redrawUrl: string, scaleMult = 1) => {
    const eng = await getEngine();
    if (!fighterOpen) fighterOpen = await openSubject(eng, await fetchBytes('/fighter.NPK'), 'sprite_character_fighter_equipment_avatar_skin.NPK');
    const open = fighterOpen;
    const r = await renderActionSegment(eng, open, 0, segIdx, '#00ff00');
    const ai = await decodeUrlToRGBA(redrawUrl);
    const rep = importActionGrid(ai, r.meta, { algo: 'floodkey', despill: true, scaleMult });
    // 成品逐帧: placed-by-axis 后内容的 脚底中心x/脚底y(相对 axis) → 走位 = 这些量的 range (应 ≈ 原版); 高 = 本体大小(应稳)。
    const repSS = new SpriteSet();
    const iH: number[] = [], iFoot: number[] = [], iFootX: number[] = [];
    for (const [g, i] of r.cells) {
      const fr = rep.get(`${g},${i}`);
      if (!fr) continue;
      repSS.set({ group: g, image: i, size: [fr.img.width, fr.img.height], axis: fr.axis, img: new ImageData(new Uint8ClampedArray(fr.img.data), fr.img.width, fr.img.height) });
      const fx = footCenterX(fr.img as RGBA, [0, 0, fr.img.width, fr.img.height]);
      iH.push(fr.img.height); iFoot.push(fr.img.height - fr.axis[1]); iFootX.push(Math.round(fx - fr.axis[0]));
    }
    // 原版同段对照 (脚底相对 axis 的 横向/纵向 — 这才是动画"该有的"走位)
    const oH: number[] = [], oFoot: number[] = [], oFootX: number[] = [];
    for (const [g, i] of r.cells) {
      const fr = r.ss.get(g, i); if (!fr?.img) continue;
      const bb = getBbox(fr.img as unknown as RGBA); if (!bb) continue;
      oH.push(bb[3] - bb[1]); oFoot.push(bb[3] - fr.axis[1]); oFootX.push(Math.round(footCenterX(fr.img as unknown as RGBA, bb) - fr.axis[0]));
    }
    // 画两条【入游戏运动】filmstrip 到 #out: 每帧按 axis 钉锚点 (motionGeo+renderCellCanvas) → 角色逐帧位移如实呈现。
    // 上=原版(运动该有的样子) 下=成品。两条运动一致(只换皮) = 对齐对; 成品被钉死不动 = 对齐错。
    const out = document.getElementById('out')!;
    out.innerHTML = `<p class="stat">seg${segIdx + 1} · 导入 ${repSS.size}/${r.cells.length} 帧 · 入游戏运动 filmstrip: 上=原版 下=成品 (运动应一致)</p>`;
    const drawStrip = (ss: SpriteSet, label: string): void => {
      const mg = motionGeo(ss, r.cells);
      const present = r.cells.filter(([g, i]) => ss.get(g, i)?.img);
      const strip = document.createElement('canvas');
      strip.width = Math.max(1, present.length * mg.cellW); strip.height = mg.cellH;
      const x = strip.getContext('2d')!; x.fillStyle = '#8a8d93'; x.fillRect(0, 0, strip.width, strip.height);
      present.forEach(([g, i], k) => { const fr = ss.get(g, i)!; x.drawImage(renderCellCanvas(fr.img as ImageData, fr.axis, mg), k * mg.cellW, 0); });
      strip.style.cssText = 'border:1px solid #888;max-width:100%;image-rendering:pixelated;display:block;margin:4px 0';
      const lab = document.createElement('p'); lab.className = 'stat'; lab.textContent = `${label} · ${present.length}帧 · 格${mg.cellW}×${mg.cellH}`;
      out.appendChild(lab); out.appendChild(strip);
    };
    drawStrip(r.ss, '原版(入游戏运动)'); drawStrip(repSS, '成品(入游戏运动)');
    const summary = {
      seg: segIdx + 1, imported: repSS.size, total: r.cells.length, scaleMult,
      原版: { 高: rng(oH), 脚纵向相对轴: rng(oFoot), 脚横向相对轴: rng(oFootX) },
      成品: { 高: rng(iH), 脚纵向相对轴: rng(iFoot), 脚横向相对轴: rng(iFootX) },
    };
    (window as unknown as Record<string, unknown>).__TEST_IMPORT = summary;
    return summary;
  };

  // ── 回环对齐诊断 (dev-only, 无需外部重绘图) ──────────────────────────────────────
  // 把导出图原样喂回 import (identity) 或 在脚底带染稀疏红噪点 (perturb, 模拟 AI 重绘脚底形变/抠图残留),
  // 逐帧量 [成品 脚底中心x / 内容底 相对轴] − [原版同量] = dx/dy。identity 应全≈0 (测往返管线干不干净);
  // perturb 若个别帧 dx/dy 暴增 = footCenterX(横向)/getBbox(纵向) 对形变敏感 → 复现"个别帧飘"的机制。
  w.__loopId = async (segIdx = 0, mode = 'identity', scaleMult = 1) => {
    const eng = await getEngine();
    if (!fighterOpen) fighterOpen = await openSubject(eng, await fetchBytes('/fighter.NPK'), 'sprite_character_fighter_equipment_avatar_skin.NPK');
    const open = fighterOpen;
    const r = await renderActionSegment(eng, open, 0, segIdx, '#00ff00');
    let id = r.canvas.getContext('2d')!.getImageData(0, 0, r.canvas.width, r.canvas.height);
    if (mode === 'jpeg') {
      // 真实流程: AI 出的图是 JPEG (绿底+角色边缘有压缩伪影)。导出 canvas → JPEG → 解回 → 喂导入,
      // 复现"抠图边缘逐帧抖动 → bbox/footCenterX 抖"。
      const url = r.canvas.toDataURL('image/jpeg', 0.85);
      const im = new Image(); im.src = url; await im.decode();
      const c = document.createElement('canvas'); c.width = r.canvas.width; c.height = r.canvas.height;
      c.getContext('2d')!.drawImage(im, 0, 0);
      id = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    } else if (mode === 'perturb') {
      const d = id.data, W = id.width, H = id.height;
      const isG = (p: number): boolean => d[p + 1]! > 180 && d[p]! < 90 && d[p + 2]! < 90;
      // 角色像素正下方 1-4px 的绿底, 按确定性图案染红 = 模拟 AI 把脚底/影子多画一点 + 抠图残留 (非绿→不被去背)。
      for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (!isG(p)) continue;
        let nearChar = false;
        for (let k = 1; k <= 4 && y - k >= 0; k++) if (!isG(((y - k) * W + x) * 4)) { nearChar = true; break; }
        if (nearChar && ((x * 7 + y * 13) % 11 === 0)) { d[p] = 200; d[p + 1] = 30; d[p + 2] = 30; d[p + 3] = 255; }
      }
    }
    const rep = importActionGrid({ data: id.data, width: id.width, height: id.height }, r.meta, { algo: 'floodkey', despill: false, scaleMult });
    const rows: { gi: string; dx?: number; dy?: number; missing?: boolean }[] = [];
    for (const [g, i] of r.cells) {
      const o = r.ss.get(g, i); if (!o?.img) continue;
      const ob = getBbox(o.img as unknown as RGBA); if (!ob) continue;
      const oFx = Math.round(footCenterX(o.img as unknown as RGBA, ob) - o.axis[0]);
      const oFy = ob[3] - o.axis[1];
      const f = rep.get(`${g},${i}`);
      if (!f) { rows.push({ gi: `${g},${i}`, missing: true }); continue; }
      const fFx = Math.round(footCenterX(f.img, [0, 0, f.img.width, f.img.height]) - f.axis[0]);
      const fFy = f.img.height - f.axis[1];
      rows.push({ gi: `${g},${i}`, dx: fFx - oFx, dy: fFy - oFy });
    }
    const present = rows.filter((rr): rr is { gi: string; dx: number; dy: number } => !rr.missing);
    const absMax = (k: 'dx' | 'dy'): number => present.reduce((m, rr) => Math.max(m, Math.abs(rr[k])), 0);
    const worst = present.slice().sort((a, b) => (Math.abs(b.dx) + Math.abs(b.dy)) - (Math.abs(a.dx) + Math.abs(a.dy))).slice(0, 8);
    const summary = { seg: segIdx + 1, mode, frames: present.length, missing: rows.length - present.length, dxAbsMax: absMax('dx'), dyAbsMax: absMax('dy'), worst };
    (window as unknown as Record<string, unknown>).__LOOP_ID = { summary, rows };
    return summary;
  };

  // ── 对齐编辑器真机验证 (dev-only): 用真格斗家某组 identity 回环 (导出图喂回) 打开对齐编辑器 ──
  // 验编辑器组件: 帧平铺/主画布渲染/洋葱皮/拖拽/双循环预览/确认。identity 不复现"飘", 但 UI/几何/交互全可验。
  // 确认 → window.__EDIT_RESULT = {frames, groupOffset}; 取消 → null。真重绘图的飘修复留三九拿真图走 UI 验收。
  w.__editFighterSeg = async (segIdx = 0) => {
    const eng = await getEngine();
    if (!fighterOpen) fighterOpen = await openSubject(eng, await fetchBytes('/fighter.NPK'), 'sprite_character_fighter_equipment_avatar_skin.NPK');
    const open = fighterOpen;
    const r = await renderActionSegment(eng, open, 0, segIdx, '#00ff00');
    const id = r.canvas.getContext('2d')!.getImageData(0, 0, r.canvas.width, r.canvas.height);
    const edit = buildSegmentEdit(open, `0:${segIdx}`, { data: id.data, width: id.width, height: id.height }, r.meta, { algo: 'floodkey', despill: true });
    const result = await openAlignEditor({ edit, cells: r.cells, origSS: r.ss, meta: r.meta, bg: '#8a8d93', title: `格斗家 · 第${segIdx + 1}组 (identity 回环验证)` });
    const summary = result ? { frames: result.frames.length, groupOffset: result.groupOffset } : null;
    (window as unknown as Record<string, unknown>).__EDIT_RESULT = summary;
    return summary;
  };

  // dev-only: 用真格斗家某组导出图生成 PNG File 存 window.__aiFile, 供 eval 注入右栏 dropzone 验完整 UI 流程
  // (上传→预对齐→自动进编辑器→确认→右栏成品更新→打包)。identity 回环 (导出图喂回), 验集成串接, 非真重绘效果。
  w.__makeAiFile = async (segIdx = 0) => {
    const eng = await getEngine();
    if (!fighterOpen) fighterOpen = await openSubject(eng, await fetchBytes('/fighter.NPK'), 'sprite_character_fighter_equipment_avatar_skin.NPK');
    const r = await renderActionSegment(eng, fighterOpen, 0, segIdx, '#00ff00');
    const blob = await new Promise<Blob | null>((res) => r.canvas.toBlob(res, 'image/png'));
    (window as unknown as Record<string, unknown>).__aiFile = new File([blob as Blob], 'ai.png', { type: 'image/png' });
    return blob ? 'ok' : 'no-blob';
  };

  // OPFS 写【只格斗家】当目录, 驱动真 UI (用真·格斗家走完整 导出→导入→打包 链路验证对齐)。
  w.__wbFighter = async () => {
    const root = await (navigator as unknown as { storage: { getDirectory(): Promise<FsaDirHandle> } }).storage.getDirectory();
    const fh = await root.getFileHandle('sprite_character_fighter_equipment_avatar_skin.NPK', { create: true });
    const wr = await fh.createWritable(); await wr.write(await fetchBytes('/fighter.NPK') as unknown as BufferSource); await wr.close();
    await wb.openWithDir(root);
    return 'ok';
  };

  // OPFS 写三类样本当目录, 驱动工作台 UI (验类型切换/对象列表/导出/打包, 免 picker 弹窗)。
  w.__wbDemoOpfs = async () => {
    const root = await (navigator as unknown as { storage: { getDirectory(): Promise<FsaDirHandle> } }).storage.getDirectory();
    const write = async (fn: string, bytes: Uint8Array): Promise<void> => {
      const fh = await root.getFileHandle(fn, { create: true });
      const wr = await fh.createWritable(); await wr.write(bytes as unknown as BufferSource); await wr.close();
    };
    const skin = await fetchNpk();
    await write('sprite_character_imperialknight_equipment_avatar_skin.NPK', skin);
    await write('sprite_character_imperialknight_equipment_avatar_coat.NPK', skin);
    await write('sprite_monster_anton_phase3_po.NPK', await fetchBytes('/monster.NPK'));
    await write('sprite_pet_falcon.NPK', await fetchBytes('/pet.NPK'));
    await wb.openWithDir(root);
    return 'ok';
  };
}
