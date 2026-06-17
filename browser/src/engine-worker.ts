// Web Worker: 把 wasm 解包/回封的重活放后台线程跑 → 主线程不冻 (大怪物解包、打包都不卡 UI)。
// ⚠️ 复用 engine.ts 的 DnfEngine (零重复); wasm glue 是全局赋值版(非 ESM, 见 public/wasm/dnf_reskin.js 尾部
// 只兜 CommonJS/AMD) → 用间接 eval 在 worker 全局执行它拿到 self.DnfReskin, 再 DnfEngine.load。
// 引擎方法本身同步(阻塞 worker 线程) = 正解: worker 阻塞不影响主线程, 这正是搬进 worker 的目的。
import { DnfEngine } from './engine';

const g = self as unknown as Record<string, unknown> & { postMessage: (m: unknown) => void };

let engP: Promise<DnfEngine> | null = null;
function getEngine(): Promise<DnfEngine> {
  if (!engP) {
    engP = (async () => {
      // wasm 路径相对 worker 自身 (import.meta.url) → 根路径(腾讯云)与子路径(GitHub Pages /repo/)两用。
      const wurl = (p: string): string => new URL('../wasm/' + p, import.meta.url).href;
      const glue = await (await fetch(wurl('dnf_reskin.js'))).text();
      (0, eval)(glue);                                  // 间接 eval → 全局执行 glue → self.DnfReskin (同 index.html <script> 效果)
      const factory = g.DnfReskin as Parameters<typeof DnfEngine.load>[0];
      const wasm = new Uint8Array(await (await fetch(wurl('dnf_reskin.wasm'))).arrayBuffer());
      return DnfEngine.load(factory, wasm, wurl);
    })();
  }
  return engP;
}

interface Req { id: number; op: string; args: unknown[] }

g.onmessage = async (e: MessageEvent<Req>): Promise<void> => {
  const { id, op, args } = e.data;
  try {
    const eng = await getEngine();
    const a = args as [Uint8Array, ...unknown[]];
    let result: unknown;
    switch (op) {
      case 'unpackMeta': result = eng.unpackMeta(a[0]); break;
      case 'unpack': result = eng.unpack(a[0]); break;
      case 'unpackImg': result = eng.unpackImg(a[0], a[1] as number); break;
      case 'repack': result = eng.repack(a[0], a[1] as Parameters<DnfEngine['repack']>[1], a[2] as Parameters<DnfEngine['repack']>[2]); break;
      case 'hideScan': result = eng.hideScan(a[0]); break;
      case 'hideBuild': result = eng.hideBuild(args[0] as Parameters<DnfEngine['hideBuild']>[0]); break;
      default: throw new Error('unknown op: ' + op);
    }
    g.postMessage({ id, ok: true, result });
  } catch (err) {
    g.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
