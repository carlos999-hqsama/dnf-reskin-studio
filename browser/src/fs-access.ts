// File System Access — 纯文件系统层: 选目录 / 列文件名 / 读 NPK / 写 % 覆盖补丁。
// DNF 无关, 可复用: "什么文件算 skin、补丁怎么命名、哪些是装备" 等规则在 dnf-rules.ts;
// "列哪类文件、怎么组合" 在 workflow.ts。这里只管目录 IO。
//
// 接口自定义而非依赖 lib.dom 的 FSA 类型 (各 TS 版本覆盖不一, 自定义保 typecheck 稳)。
// 鸭子兼容两种 handle 来源: showDirectoryPicker (真实目录, 需用户手势, 限 Chrome 系) /
// navigator.storage.getDirectory (OPFS, 无需手势 → preview 用它真实验证整条数据流)。

export interface FsaWritable {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
}
export interface FsaFileHandle {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(): Promise<FsaWritable>;
}
export interface FsaDirHandle {
  kind: 'directory';
  entries(): AsyncIterableIterator<[string, FsaFileHandle | FsaDirHandle]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsaFileHandle>;
  removeEntry(name: string): Promise<void>;
}

/** 列目录里所有文件名 (不含子目录)。通用, DNF 无关 — 过滤/识别交给调用方 (workflow + dnf-rules)。 */
export async function listFileNames(dir: FsaDirHandle): Promise<string[]> {
  const out: string[] = [];
  let n = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') out.push(name);
    // 真实 ImagePacks2 上万文件: 每 1024 项让出主线程一次 → 枚举不卡 UI (只列文件名, 不解包)。
    if ((++n & 1023) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return out;
}

/** 读目录里一个 NPK → 字节。 */
export async function readNpk(dir: FsaDirHandle, fileName: string): Promise<Uint8Array> {
  const fh = await dir.getFileHandle(fileName);
  const f = await fh.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** 写 % 覆盖补丁回目录 (只新增, 不碰原文件)。⚠️ 名必须 % 开头 — 既是 DNF 覆盖机制, 也是防误写原 NPK
 *  的最后一道护栏 (放最底层写操作 = 深度防御, 任何写补丁路径都过这关)。 */
export async function writePatch(dir: FsaDirHandle, name: string, bytes: Uint8Array): Promise<void> {
  if (!name.startsWith('%')) {
    throw new Error(`补丁名必须以 % 开头 (覆盖机制 + 防误写原 NPK 护栏): ${name}`);
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
}

/** 弹窗选 DNF ImagePacks2 目录 (真实, 需用户手势, 限 Chrome 系)。不可用时抛错。 */
export async function pickImagePacksDir(): Promise<FsaDirHandle> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FsaDirHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('此浏览器不支持 File System Access (showDirectoryPicker) — 请用 Chrome / Edge 等 Chromium 系');
  return picker({ id: 'dnf-imagepacks2', mode: 'readwrite' });
}
