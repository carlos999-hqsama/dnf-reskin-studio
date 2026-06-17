// 浏览器入口: 起 Web Worker 引擎(单例, wasm 在后台线程, 主线程不冻) → 挂载补丁工作台 → 装自检脚手架。
import type { AsyncEngine } from './engine';
import { WorkerEngine } from './worker-engine';
import { mountWorkbench } from './workbench';
import { installDevHarness } from './dev-harness';

let engineP: Promise<AsyncEngine> | null = null;
function getEngine(): Promise<AsyncEngine> {
  // WorkerEngine 构造即起 worker(同步); wasm 在 worker 内首次调用时懒加载。主线程从不跑 wasm。
  if (!engineP) engineP = Promise.resolve(new WorkerEngine());
  return engineP;
}

// 补丁工作台 (File System Access, 两栏): 选目录 → 左栏列角色/导出 → 右栏导入/抠图/打包。
const wb = mountWorkbench(getEngine, {
  pick: document.getElementById('wbPick') as HTMLButtonElement,
  dir: document.getElementById('wbDir')!,
  panelL: document.getElementById('panelL')!,
  panelR: document.getElementById('panelR')!,
});

// 开发期自检脚手架 (PoC 按钮 + preview 钩子), 与产品工作台隔离。
installDevHarness(getEngine, wb);
