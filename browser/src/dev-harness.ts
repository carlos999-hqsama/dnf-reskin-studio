// 开发自检入口 (PoC) — 把阶段 1/2 的验证脚手架 (解包显示 / core 对齐渲染 / 补丁闭环 / OPFS 数据流)
// 收成一处, 与产品工作台 (workbench) 隔离。这些按钮 + window 钩子只为开发期 preview 验证, 不是玩家功能。
import type { AsyncEngine } from './engine';
import { decodePng } from './png';
import { buildStripCanvas } from './render-canvas';
import { SpriteSet, type Cell } from './model';
import { computeGeometry } from './geometry';
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
