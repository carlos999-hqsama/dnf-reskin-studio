// engine.ts wasm 接入冒烟验证 — tsx 真 node 跑 (绕开 vitest sandbox 对 emscripten glue 的 transform)。
// ① unpack: 解 imperialknight NPK → 应 300 帧 + manifest, 帧是 PNG; 若 /tmp/verify_native 在则逐字节对账。
// ② repack 恒等: 不替换任何帧 → 输出 NPK 应 byte 等于源 (未改帧全标 linked → do_repack 原样保留)。
// ③ repack 替换: 用另一帧 PNG 换掉某帧 → re-unpack 确认那帧真变了 + 帧数不变 (结构完整)。
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DnfEngine, type WasmFactory, type Replacement } from '../src/engine';

const require = createRequire(import.meta.url);
const wasmDir = fileURLToPath(new URL('../wasm/', import.meta.url));
const npkPath = fileURLToPath(new URL('../test/fixtures/imperialknight.NPK', import.meta.url));

const m = require(wasmDir + 'dnf_reskin.js');
const factory = (m.default ?? m) as WasmFactory; // node 原生 require 直返 function, default 兜底
const eng = await DnfEngine.load(factory, readFileSync(wasmDir + 'dnf_reskin.wasm'), (p) => wasmDir + p);

const srcNpk = readFileSync(npkPath);
const res = eng.unpack(new Uint8Array(srcNpk));

// ── ① unpack ──
const png = res.frames[0]!.png;
const okPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
const manFrames = res.manifest.frames.length;

let byte = 'skip(无 native 参照)';
const natDir = '/tmp/verify_native';
if (existsSync(natDir)) {
  let same = 0, diff = 0;
  for (const f of res.frames) {
    const np = `${natDir}/${f.name}`;
    if (existsSync(np)) (Buffer.from(f.png).equals(readFileSync(np)) ? same++ : diff++);
  }
  byte = `${same} identical / ${diff} diff`;
}

// ── ② repack 恒等回环: 不替换 → byte 对账源 NPK ──
const idNpk = eng.repack(new Uint8Array(srcNpk), structuredClone(res.manifest), []);
const identityOk = Buffer.from(idNpk).equals(srcNpk);

// ── ③ repack 替换路径: 用 donor 帧的 PNG 换掉 target 帧 → re-unpack 验证 ──
const byFile = new Map(res.frames.map((f) => [f.name, f.png]));
const realMeta = res.manifest.frames.filter((f) => !f.linked && byFile.has(f.file));
const target = realMeta[0]!;
const targetPng = byFile.get(target.file)!;
const donor = realMeta.find((f) => !Buffer.from(byFile.get(f.file)!).equals(Buffer.from(targetPng)));
let changed = false, frameCountOk = false, replaceNote = 'skip(找不到内容不同的 donor 帧)';
if (donor) {
  const reps: Replacement[] = [{
    imgIndex: target.img_index, frameIndex: target.frame_index,
    png: byFile.get(donor.file)!, axis: [target.offset_x, target.offset_y],
  }];
  const outNpk = eng.repack(new Uint8Array(srcNpk), structuredClone(res.manifest), reps);
  const res2 = eng.unpack(outNpk);
  const newTarget = new Map(res2.frames.map((f) => [f.name, f.png])).get(target.file);
  changed = !!newTarget && !Buffer.from(newTarget).equals(Buffer.from(targetPng));
  frameCountOk = res2.frames.length === res.frames.length;
  replaceNote = `target=${target.file} donor=${donor.file} → changed=${changed} frames=${res2.frames.length}/${res.frames.length}`;
}

// ④ hide scan + build (按职业隐藏装备的省内存路径: scan 逐源只读头, build 用累积列表造空帧)
const scanned = eng.hideScan(new Uint8Array(srcNpk));
const hideNpk = eng.hideBuild(scanned);
const hres = eng.unpack(hideNpk);
const hideOk = scanned.length === 2 && scanned.every((x) => x.frames === 150) &&
  hres.manifest.frames.length === 300 && hideNpk.length < 10000;

// ⑤⑥ monster(V5) / pet(V2) fixture: 引擎层回环 — identity byte-equal(linked 原样保留) + replace 路径。
// 多类型补丁的格式级铁证: V5 怪物 + V2 宠物在浏览器引擎里解/封无损 (桌面 CLI 是全重编, 这里走 linked 字节保留)。
function roundtrip(name: string, file: string): { tag: string; ok: boolean } {
  const p = fileURLToPath(new URL('../test/fixtures/' + file, import.meta.url));
  if (!existsSync(p)) return { tag: `${name}: skip (无 fixture ${file})`, ok: true };
  const src = readFileSync(p);
  const r = eng.unpack(new Uint8Array(src));
  const imgs = new Set(r.manifest.frames.map((f) => f.img_index)).size;
  const idNpkM = eng.repack(new Uint8Array(src), structuredClone(r.manifest), []);
  const idOk = Buffer.from(idNpkM).equals(src);
  const bf = new Map(r.frames.map((f) => [f.name, f.png]));
  const real = r.manifest.frames.filter((f) => !f.linked && bf.has(f.file));
  const tgt = real[0];
  let chg = true, fc = true, note = 'skip(无真实帧)';
  if (tgt) {
    const tgtPng = bf.get(tgt.file)!;
    const don = real.find((f) => !Buffer.from(bf.get(f.file)!).equals(Buffer.from(tgtPng)));
    if (don) {
      const reps: Replacement[] = [{
        imgIndex: tgt.img_index, frameIndex: tgt.frame_index, png: bf.get(don.file)!, axis: [tgt.offset_x, tgt.offset_y],
      }];
      const out = eng.repack(new Uint8Array(src), structuredClone(r.manifest), reps);
      const r2 = eng.unpack(out);
      const nt = new Map(r2.frames.map((f) => [f.name, f.png])).get(tgt.file);
      chg = !!nt && !Buffer.from(nt).equals(Buffer.from(tgtPng));
      fc = r2.frames.length === r.frames.length;
      note = `replace changed=${chg} frames=${r2.frames.length}/${r.frames.length}`;
    } else { note = 'replace skip(帧全同)'; }
  }
  const ok = idOk && chg && fc;
  return { tag: `${name}: ${r.frames.length}帧/${imgs}IMG · identity=${idOk} · ${note} · ${ok ? 'OK' : 'FAIL'}`, ok };
}
const mon = roundtrip('⑤ monster(V5)', 'monster_anton_po.NPK');
const pet = roundtrip('⑥ pet(V2)', 'pet_falcon.NPK');

console.log(`① unpack:   frames=${res.frames.length}  manifest=${manFrames}  png魔数=${okPng}  byteVsNative=${byte}`);
console.log(`② identity: repack(无替换) byte==源NPK = ${identityOk}  (${idNpk.length} vs ${srcNpk.length} 字节)`);
console.log(`③ replace:  ${replaceNote}`);
console.log(`④ hide:     scan ${scanned.length} IMG(${scanned.map((x) => x.frames).join('/')}帧) → build ${(hideNpk.length / 1024).toFixed(1)}KB 空帧包 → re-unpack ${hres.manifest.frames.length} 帧 · ${hideOk ? 'OK' : 'FAIL'}`);
console.log(mon.tag);
console.log(pet.tag);

const ok = res.frames.length === 300 && manFrames === 300 && okPng &&
  (byte.startsWith('skip') || byte.startsWith('300 ')) &&
  identityOk && changed && frameCountOk && hideOk && mon.ok && pet.ok;
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
if (!ok) process.exit(1);
