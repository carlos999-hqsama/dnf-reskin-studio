// WorkerEngine — 主线程侧的 AsyncEngine 实现: 把每个调用 postMessage 给 engine-worker 后台线程, 等回执。
// 主线程全程不跑 wasm → 解大怪物 / 打包都不冻 UI。结构化克隆传 NPK 字节 (几百 KB, 开销远小于解包耗时;
// 不用 transferable 因为调用方会复用同一 srcNpk 跨多次调用[openSubject 后还要 unpackImg/repack])。
import type { AsyncEngine, DnfManifest, UnpackResult, UnpackedFrame, Replacement, HideImg } from './engine';

interface Reply { id: number; ok: boolean; result?: unknown; error?: string }

export class WorkerEngine implements AsyncEngine {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Reply>): void => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error ?? 'worker error'));
    };
    this.worker.onerror = (e: ErrorEvent): void => {
      // worker 整体崩 → 让所有在途调用失败 (别永久挂起)
      for (const [, p] of this.pending) p.reject(new Error('engine worker 崩溃: ' + e.message));
      this.pending.clear();
    };
  }

  private call<T>(op: string, args: unknown[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  unpackMeta(npk: Uint8Array): Promise<DnfManifest> { return this.call('unpackMeta', [npk]); }
  unpack(npk: Uint8Array): Promise<UnpackResult> { return this.call('unpack', [npk]); }
  unpackImg(npk: Uint8Array, imgIndex: number): Promise<UnpackedFrame[]> { return this.call('unpackImg', [npk, imgIndex]); }
  repack(sourceNpk: Uint8Array, manifest: DnfManifest, replacements: readonly Replacement[]): Promise<Uint8Array> {
    return this.call('repack', [sourceNpk, manifest, replacements]);
  }
  hideScan(npk: Uint8Array): Promise<HideImg[]> { return this.call('hideScan', [npk]); }
  hideBuild(imgs: readonly HideImg[]): Promise<Uint8Array> { return this.call('hideBuild', [imgs]); }
}
