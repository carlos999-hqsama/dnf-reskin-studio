// 补丁核心闭环 demo — 验收: 浏览器里导入一张改过的图 → 去背对齐 → engine.repack 出合法 NPK
// → 能再被 unpack 解回。整条纯客户端 (wasm + TS core + Canvas), 零服务器。
import type { AsyncEngine, Replacement } from './engine';
import { decodePng, encodePng } from './png';
import { buildStripCanvas, buildActionGridCanvas } from './render-canvas';
import { importActionGrid } from './import';
import { conformToDnf } from './pixels';
import { SpriteSet, type Cell, type RGBA } from './model';
import { computeGeometry } from './geometry';
import { mockRepaint, bytesEq } from './verify-opfs'; // 去重: 闭环 demo 与 OPFS 验证共用同一 mock 重绘/比对

function toCanvas(id: ImageData): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = id.width; cv.height = id.height;
  cv.getContext('2d')!.putImageData(id, 0, 0);
  return cv;
}
function toImageData(img: RGBA): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}
function panel(parent: HTMLElement, title: string, cv: HTMLCanvasElement): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:inline-block;vertical-align:top;margin:6px;max-width:340px';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:12px;color:#6e6e73;margin-bottom:4px;max-width:340px';
  cv.style.cssText = 'border:1px solid #d2d2d7;max-width:340px;image-rendering:pixelated;display:block;background:#f5f5f7';
  wrap.appendChild(h); wrap.appendChild(cv);
  parent.appendChild(wrap);
}

export interface ReskinResult {
  exported: { n: number; W: number; H: number };
  imported: number;
  repackedBytes: number;
  reunpacked: { frames: number; changed: number; expected: number };
  ok: boolean;
}

/** 跑完整补丁闭环, 把各阶段图画进 container, 返回统计 (供 preview 断言)。 */
export async function runReskinLoop(
  eng: AsyncEngine, npk: Uint8Array, container: HTMLElement, imgIndex = 0, maxFrames = 12,
): Promise<ReskinResult> {
  container.innerHTML = '<p>补丁闭环跑动中…</p>';
  const res = await eng.unpack(npk);
  const byFile = new Map(res.frames.map((f) => [f.name, f.png]));
  const metaFrames = res.manifest.frames.filter((f) => f.img_index === imgIndex && !f.linked).slice(0, maxFrames);

  // 建 SpriteSet (decode 帧像素)
  const ss = new SpriteSet();
  const cells: Cell[] = [];
  for (const mf of metaFrames) {
    const png = byFile.get(mf.file);
    if (!png) continue;
    const img = await decodePng(png);
    ss.set({ group: mf.img_index, image: mf.frame_index, size: [mf.pic_width, mf.pic_height], axis: [mf.offset_x, mf.offset_y], img });
    cells.push([mf.img_index, mf.frame_index]);
  }
  const geo = computeGeometry(ss, cells, 300);

  // ① 导出网格图 → ② mock AI 重绘 → ③ 导入去背对齐 → ④ 硬边+编码 → ⑤ repack → ⑥ re-unpack
  const { canvas: gridCv, meta } = buildActionGridCanvas(ss, cells, geo);
  const aiImg = mockRepaint(gridCv.getContext('2d')!.getImageData(0, 0, gridCv.width, gridCv.height));
  const replaced = importActionGrid({ data: aiImg.data, width: aiImg.width, height: aiImg.height }, meta);

  const reps: Replacement[] = [];
  for (const fr of replaced.values()) {
    const hard = conformToDnf({ data: new Uint8ClampedArray(fr.img.data), width: fr.img.width, height: fr.img.height });
    reps.push({ imgIndex: fr.group, frameIndex: fr.image, png: await encodePng(hard), axis: fr.axis, size: [fr.img.width, fr.img.height] });
  }

  const outNpk = await eng.repack(npk, res.manifest, reps);
  const res2 = await eng.unpack(outNpk);
  const byFile2 = new Map(res2.frames.map((f) => [f.name, f.png]));
  let changed = 0;
  for (const mf of metaFrames) {
    const before = byFile.get(mf.file), after = byFile2.get(mf.file);
    if (before && after && !bytesEq(before, after)) changed++;
  }

  // 可视化: 原帧横图 vs 替换帧横图 (脚底应都贴红线 = 对齐对)
  const newSS = new SpriteSet();
  for (const fr of replaced.values()) newSS.set({ group: fr.group, image: fr.image, size: [fr.img.width, fr.img.height], axis: fr.axis, img: toImageData(fr.img) });

  const ok = replaced.size > 0 && outNpk.length > 0 &&
    res2.frames.length === res.frames.length && changed === metaFrames.length;

  container.innerHTML = '';
  const stat = document.createElement('p');
  stat.className = ok ? 'stat' : 'fail';
  stat.textContent = `闭环: 导出 ${meta.n} 帧网格 → 导入 ${replaced.size} 替换帧 → 回封 ${(outNpk.length / 1024).toFixed(0)}KB 合法 NPK → re-unpack ${res2.frames.length} 帧, ${changed}/${metaFrames.length} 替换帧确认变了 · ${ok ? 'PASS' : 'FAIL'}`;
  container.appendChild(stat);
  panel(container, '① 导出网格图 (给玩家拿去 AI 重绘)', gridCv);
  panel(container, '② mock AI 重绘 (角色 R/B 换色)', toCanvas(aiImg));
  panel(container, '③ 原帧对齐横图 (红线=脚底锚)', buildStripCanvas(ss, cells, geo));
  panel(container, '④ 补丁后对齐横图 (脚底应贴齐红线)', buildStripCanvas(newSS, cells, geo));

  const r: ReskinResult = {
    exported: { n: meta.n, W: meta.W, H: meta.H },
    imported: replaced.size,
    repackedBytes: outNpk.length,
    reunpacked: { frames: res2.frames.length, changed, expected: metaFrames.length },
    ok,
  };
  (window as unknown as { __RESKIN__: unknown }).__RESKIN__ = r;
  return r;
}
