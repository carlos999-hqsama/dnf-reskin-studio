// OPFS 端到端验证 — preview 跑得通 = 整条 File System Access 数据流真实可用 (只 picker 弹窗留真机)。
// showDirectoryPicker 弹窗 preview 没法交互, 但拿到 handle 后的列/读/写是标准 FileSystemDirectoryHandle
// API → OPFS(navigator.storage.getDirectory) 给同一套 handle → 在 preview 用 OPFS 真实跑 (非 mock)。
//
// 泛化到三类对象 (职业/怪物/宠物): 走 openSubject 统一路径, 验"选→解→导出→导回→回封→写%补丁→原包不变"。
// mockRepaint / bytesEq 是验证/demo 共用工具 (reskin-demo 也用) → 在这里导出, 单一来源。
import type { AsyncEngine } from './engine';
import { openSubject, renderActionSegment, importActionSegment, deploySubject } from './workflow';
import { readNpk, writePatch, type FsaDirHandle } from './fs-access';

/** mock "AI 重绘": 保绿底不动, 角色像素 R/B 互换 = 模拟玩家拿导出图去 AI 换了配色。
 *  验证管线对"任意改过的图"都成立 (去背/对齐/回封不依赖具体画了啥)。 */
export function mockRepaint(src: ImageData): ImageData {
  const d = new Uint8ClampedArray(src.data);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    if (!(g > 200 && r < 80 && b < 80)) { d[i] = b; d[i + 2] = r; } // 非绿底 → R/B 互换
  }
  return new ImageData(d, src.width, src.height);
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function writeRaw(dir: FsaDirHandle, name: string, bytes: Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
}

export interface SubjectVerifyResult {
  type: string;
  fileName: string;
  zh: string;
  actions: number;
  segments: number;       // 第 0 个动作的分组数
  imported: number;
  repCount: number;
  imgCount: number;
  patchName: string;
  patchIsPercent: boolean;
  patchBytes: number;
  reunpackedFrames: number;
  srcUnchanged: boolean;
  ok: boolean;
}

/** 用 OPFS (真实 FileSystemDirectoryHandle, 免 picker 弹窗) 跑整条对象补丁数据流:
 *  写样本(按真实文件名) → openSubject → 渲染动作0/组0 → (mock AI 重绘) → 导入 → deploySubject →
 *  writePatch(% 补丁) → 读回 unpack 验证 → 验原包字节不变 → 清理。职业/怪物/宠物通用。 */
export async function verifySubjectWithOpfs(eng: AsyncEngine, sampleNpk: Uint8Array, fileName: string): Promise<SubjectVerifyResult> {
  const root = await (navigator as unknown as { storage: { getDirectory(): Promise<FsaDirHandle> } }).storage.getDirectory();
  await writeRaw(root, fileName, sampleNpk);
  try {
    const open = await openSubject(eng, await readNpk(root, fileName), fileName);
    const { canvas, meta } = await renderActionSegment(eng, open, 0, 0);
    const ai = mockRepaint(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height));
    const imported = importActionSegment(open, { data: ai.data, width: ai.width, height: ai.height }, meta);
    const { outNpk, patchName, repCount, imgCount } = await deploySubject(eng, open);
    await writePatch(root, patchName, outNpk);

    const res2 = await eng.unpack(await readNpk(root, patchName));
    const srcUnchanged = bytesEq(await readNpk(root, fileName), sampleNpk);
    await root.removeEntry(patchName);

    const ok = open.actions.length >= 1 && imported > 0 && repCount >= 1 &&
      res2.frames.length > 0 && srcUnchanged && patchName.startsWith('%');
    return {
      type: open.type, fileName, zh: open.zh, actions: open.actions.length,
      segments: open.actions[0]!.segments.length, imported, repCount, imgCount,
      patchName, patchIsPercent: patchName.startsWith('%'), patchBytes: outNpk.length,
      reunpackedFrames: res2.frames.length, srcUnchanged, ok,
    };
  } finally {
    await root.removeEntry(fileName).catch(() => undefined);
  }
}

/** 职业路径快捷验证 (imperialknight 样本) — 兼容旧 __verifyFsa 钩子。 */
export function verifyWithOpfs(eng: AsyncEngine, sampleNpk: Uint8Array): Promise<SubjectVerifyResult> {
  return verifySubjectWithOpfs(eng, sampleNpk, 'sprite_character_imperialknight_equipment_avatar_skin.NPK');
}
