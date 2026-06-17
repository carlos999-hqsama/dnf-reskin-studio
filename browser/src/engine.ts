// 接 KoishiEx wasm: 浏览器/node 内纯客户端解/封 DNF NPK → PNG 帧 + manifest, 零服务器。
// wasm 产物来自 ~/Documents/OPENCODE (C++ 源 emscripten 编, 见 ../wasm/README.md)。
// 依赖注入 factory → 不耦合加载方式(浏览器 <script> 全局 DnfReskin / node require), node 里可测。

/** emscripten MODULARIZE 模块的最小接口 (只用到的部分)。 */
export interface WasmModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    mkdir(path: string): void;
    readdir(path: string): string[];
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    rmdir(path: string): void;
    analyzePath(path: string): { exists: boolean };
  };
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): number;
}

export type WasmFactory = (opts: {
  wasmBinary?: Uint8Array | ArrayBuffer;
  locateFile?: (path: string) => string;
}) => Promise<WasmModule>;

/** DNF manifest 一帧的元数据 (OPENCODE manifest.h 的 FrameInfo 的 JSON 镜像)。
 *  unpack 产出 (core 用 pic_width/height + offset 当 size/axis); repack 回填后喂回 wasm 重封。
 *  全字段保留 —— C++ load_manifest 用 .at() 取这些键, 缺一个就解析失败。 */
export interface ManifestFrame {
  img_index: number;
  img_name: string;
  frame_index: number;
  file: string;
  offset_x: number;
  offset_y: number;
  frame_width: number;
  frame_height: number;
  pic_width: number;
  pic_height: number;
  format: number;
  compressed: boolean;
  linked: boolean;
  link_to: number;
}

export interface DnfManifest {
  source_npk: string;
  export_time: string;
  frames: ManifestFrame[];
}

export interface UnpackedFrame {
  /** 帧文件名 (对应 manifest 里的条目) */
  name: string;
  /** PNG 字节; 浏览器用 createImageBitmap/Canvas 解成像素再喂 core 的 RGBA */
  png: Uint8Array;
}

export interface UnpackResult {
  frames: UnpackedFrame[];
  manifest: DnfManifest;
}

/** 一帧替换: 用新 PNG(应已 conformToDnf 硬边化 + 编码) 换掉 (imgIndex, frameIndex) 那帧。
 *  axis = core 算好的脚底锚定轴 (footAnchorAxis), 原样写回 manifest 的 offset。
 *  size 可选: 传了就回填 pic_width/height 让 manifest 自洽 (repack 本身从 PNG 读真实尺寸, 不依赖它)。 */
export interface Replacement {
  imgIndex: number;
  frameIndex: number;
  png: Uint8Array;
  axis: readonly [number, number];
  size?: readonly [number, number];
}

/** 一个 IMG 的隐藏信息 (hideScan 产出 → hideBuild 消费): 内部路径名 + 帧数。 */
export interface HideImg {
  name: string;
  frames: number;
}

/** 异步引擎接口 — 与 DnfEngine 同语义但全 Promise 化。
 *  浏览器侧 WorkerEngine 实现它(把活派给 Web Worker, 主线程不冻); node/smoke 仍直接用同步 DnfEngine。
 *  workflow/workbench/verify 一律依赖这个接口 → 主线程零阻塞解包/回封。 */
export interface AsyncEngine {
  unpackMeta(npk: Uint8Array): Promise<DnfManifest>;
  unpack(npk: Uint8Array): Promise<UnpackResult>;
  unpackImg(npk: Uint8Array, imgIndex: number): Promise<UnpackedFrame[]>;
  repack(sourceNpk: Uint8Array, manifest: DnfManifest, replacements: readonly Replacement[]): Promise<Uint8Array>;
  hideScan(npk: Uint8Array): Promise<HideImg[]>;
  hideBuild(imgs: readonly HideImg[]): Promise<Uint8Array>;
}

/** DNF 补丁引擎(浏览器端): 包 KoishiEx wasm, NPK 进 → 帧 PNG + manifest 出, 全程内存(MEMFS)。 */
export class DnfEngine {
  private constructor(private readonly mod: WasmModule) {}

  /** 加载 wasm。factory = dnf_reskin.js 导出的 DnfReskin; wasmBinary = dnf_reskin.wasm 字节。 */
  static async load(
    factory: WasmFactory,
    wasmBinary: Uint8Array,
    locateFile?: (p: string) => string,
  ): Promise<DnfEngine> {
    const mod = await factory({ wasmBinary, locateFile });
    return new DnfEngine(mod);
  }

  /** 解一个 NPK → 帧 PNG + manifest。NPK 字节写进 MEMFS → unpack_npk → 读出。 */
  unpack(npk: Uint8Array): UnpackResult {
    const FS = this.mod.FS;
    this.rmrf('/in.NPK');
    this.rmrf('/out');
    FS.writeFile('/in.NPK', npk);
    FS.mkdir('/out');
    const rc = this.mod.ccall('unpack_npk', 'number', ['string', 'string'], ['/in.NPK', '/out']);
    if (rc !== 0) throw new Error(`unpack_npk 失败 rc=${rc}`);
    const files = FS.readdir('/out').filter((f) => f !== '.' && f !== '..');
    const frames: UnpackedFrame[] = [];
    let manifest: DnfManifest | null = null;
    for (const f of files) {
      if (f === 'manifest.json') {
        manifest = JSON.parse(new TextDecoder().decode(FS.readFile('/out/' + f))) as DnfManifest;
      } else if (f.endsWith('.png')) {
        frames.push({ name: f, png: FS.readFile('/out/' + f) });
      }
    }
    if (!manifest) throw new Error('unpack 没产出 manifest.json');
    return { frames, manifest };
  }

  /** 只取 manifest (meta_only, 不解任何像素/PNG) → 秒开角色, 不会因大 skin NPK 全帧解码而卡死/爆内存。
   *  配 unpackImg 用: 先 unpackMeta 拿全 manifest 算本体, 再 unpackImg 只解本体那一个 IMG。 */
  unpackMeta(npk: Uint8Array): DnfManifest {
    const FS = this.mod.FS;
    this.rmrf('/in.NPK');
    this.rmrf('/out');
    FS.writeFile('/in.NPK', npk);
    FS.mkdir('/out');
    const rc = this.mod.ccall('unpack_npk_ex', 'number', ['string', 'string', 'number', 'number'], ['/in.NPK', '/out', 1, -1]);
    if (rc !== 0) throw new Error(`unpack_npk_ex(meta) 失败 rc=${rc}`);
    return JSON.parse(new TextDecoder().decode(FS.readFile('/out/manifest.json'))) as DnfManifest;
  }

  /** 只解某一个 IMG 的帧 PNG (其它 IMG/骨架变体不解) → 按需渲染本体, 不全解。
   *  ⚠️ only_img 模式不写 manifest (用 unpackMeta 的); 这里只读该 IMG 解出的 PNG。 */
  unpackImg(npk: Uint8Array, imgIndex: number): UnpackedFrame[] {
    const FS = this.mod.FS;
    this.rmrf('/in.NPK');
    this.rmrf('/out');
    FS.writeFile('/in.NPK', npk);
    FS.mkdir('/out');
    const rc = this.mod.ccall('unpack_npk_ex', 'number', ['string', 'string', 'number', 'number'], ['/in.NPK', '/out', 0, imgIndex]);
    if (rc !== 0) throw new Error(`unpack_npk_ex(img=${imgIndex}) 失败 rc=${rc}`);
    const out: UnpackedFrame[] = [];
    for (const f of FS.readdir('/out').filter((x) => x !== '.' && x !== '..')) {
      if (f.endsWith('.png')) out.push({ name: f, png: FS.readFile('/out/' + f) });
    }
    return out;
  }

  /** 回封: 源 NPK 当模板 + 若干替换帧 → 合法 NPK 字节 (纯客户端, MEMFS)。
   *
   *  数据流照搬桌面版 dnf.py write():
   *  - 未替换的非 linked 帧 → 标 linked=true: wasm do_repack 见 linked 就从源 NPK 原样保留,
   *    不重新编码 → 既是提速(只重编改过的 IMG)也是恒等保证(没替换=byte 级回原 NPK)。
   *  - 替换帧 → 写 PNG 进 MEMFS /frames, offset 用 core 算好的脚底锚定轴。该 IMG 若全彩
   *    溢出 V4 调色板, do_repack 自动整 IMG 转 V2(ARGB8888) 重编 (见 repack.cpp)。
   *  - 源 NPK 必须在 MEMFS 上 (manifest.source_npk 指向它), do_repack 会 loadFile 当模板。
   */
  repack(sourceNpk: Uint8Array, manifest: DnfManifest, replacements: readonly Replacement[]): Uint8Array {
    const FS = this.mod.FS;
    this.rmrf('/src.NPK');
    this.rmrf('/frames');
    this.rmrf('/manifest.json');
    this.rmrf('/out.NPK');
    FS.writeFile('/src.NPK', sourceNpk);
    FS.mkdir('/frames');

    const repMap = new Map<string, Replacement>();
    for (const r of replacements) repMap.set(`${r.imgIndex},${r.frameIndex}`, r);
    const unmatched = new Set(repMap.keys());

    const outFrames: ManifestFrame[] = [];
    for (const f of manifest.frames) {
      const m: ManifestFrame = { ...f };
      if (m.linked) {
        outFrames.push(m);                       // 本就链接帧: 原样 (无 PNG)
        continue;
      }
      const key = `${m.img_index},${m.frame_index}`;
      const rep = repMap.get(key);
      if (rep) {
        FS.writeFile('/frames/' + m.file, rep.png);
        m.offset_x = Math.round(rep.axis[0]);
        m.offset_y = Math.round(rep.axis[1]);
        if (rep.size) { m.pic_width = rep.size[0]; m.pic_height = rep.size[1]; }
        m.linked = false;
        unmatched.delete(key);
      } else {
        m.linked = true;                         // 未替换的实帧: 标 linked → repack 保留原字节
      }
      outFrames.push(m);
    }
    if (unmatched.size) {
      throw new Error(`repack: 这些替换帧不在 manifest 里(或本就是 linked 帧): ${[...unmatched].join(' ')}`);
    }

    const newManifest: DnfManifest = { source_npk: '/src.NPK', export_time: '', frames: outFrames };
    FS.writeFile('/manifest.json', new TextEncoder().encode(JSON.stringify(newManifest)));
    const rc = this.mod.ccall(
      'repack_npk', 'number', ['string', 'string', 'string'],
      ['/manifest.json', '/frames', '/out.NPK'],
    );
    if (rc !== 0) throw new Error(`repack_npk 失败 rc=${rc}`);
    return this.mod.FS.readFile('/out.NPK');
  }

  /** 扫一个源 NPK 的 IMG 头 → [{name, frames}] (不解像素)。扫完【立即释放】该源的 MEMFS,
   *  让调用方逐个源扫描、内存峰值只压一个源 —— 整套装备 avatar 可达 ~0.6GB, 一次性塞会爆 tab。 */
  hideScan(npk: Uint8Array): HideImg[] {
    const FS = this.mod.FS;
    this.rmrf('/hs.NPK');
    this.rmrf('/hs.json');
    FS.writeFile('/hs.NPK', npk);
    const rc = this.mod.ccall('hide_scan', 'number', ['string', 'string'], ['/hs.NPK', '/hs.json']);
    if (rc !== 0) { this.rmrf('/hs.NPK'); throw new Error(`hide_scan 失败 rc=${rc}`); }
    const list = JSON.parse(new TextDecoder().decode(FS.readFile('/hs.json'))) as HideImg[];
    this.rmrf('/hs.NPK');     // 立即释放源 (省内存核心)
    this.rmrf('/hs.json');
    return list;
  }

  /** 用累积的 IMG 列表 (多个源 hideScan 合并) 造"全空帧覆盖 NPK" → 隐藏这些装备槽。
   *  不需源像素 (空帧只依赖帧数), 故内存与源大小无关。配 hideScan 用。 */
  hideBuild(imgs: readonly HideImg[]): Uint8Array {
    const FS = this.mod.FS;
    this.rmrf('/hb.json');
    this.rmrf('/hide.NPK');
    FS.writeFile('/hb.json', new TextEncoder().encode(JSON.stringify(imgs)));
    const rc = this.mod.ccall('hide_build', 'number', ['string', 'string'], ['/hb.json', '/hide.NPK']);
    if (rc !== 0) throw new Error(`hide_build 失败 rc=${rc}`);
    return this.mod.FS.readFile('/hide.NPK');
  }

  /** 递归删 MEMFS 路径 (文件或目录), 不存在则忽略 —— 多次 unpack/repack 复用同一 mod 实例, 须清干净。 */
  private rmrf(path: string): void {
    const FS = this.mod.FS;
    let st: { exists: boolean };
    try { st = FS.analyzePath(path); } catch { return; }
    if (!st.exists) return;
    let children: string[] | null = null;
    try { children = FS.readdir(path).filter((c) => c !== '.' && c !== '..'); } catch { children = null; }
    if (children === null) {
      try { FS.unlink(path); } catch { /* 已不在 */ }
      return;
    }
    for (const c of children) this.rmrf(path.replace(/\/$/, '') + '/' + c);
    try { FS.rmdir(path); } catch { /* 已不在 */ }
  }
}
