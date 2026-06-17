// importer.js — 右栏: 拖拽导入 + 纯色底扣除 + 替换后 GIF + 还原 + 逐帧手动对齐 (ARCHITECTURE.md §1)。
// 导入/调整走 api 统一错误; 替换后图走 blob + 竞态 + revoke。手动对齐: 每帧缩放/位移, 后端从导入原始算, 可重置。

import { store } from '../store.js';
import { request, ApiError } from '../api.js';

let els = null;
let toast = null;
let curNStripURL = null;
let curNGifURL = null;
let curOverlayURL = null;

// 手动对齐缓存: key `${action}#${idx}` → {scale,dx,dy}。前端持久(切回动作恢复 UI), 后端是真相。
const alignState = {};
const MOVE_STEP = 2;
let selIdx = 0;            // 当前选中对齐的帧序号 (点帧 chip 选中)
let adjustTimer = null;

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function clearNStrip() { if (curNStripURL) { URL.revokeObjectURL(curNStripURL); curNStripURL = null; } els.nstrip.removeAttribute('src'); }
function clearNGif() { if (curNGifURL) { URL.revokeObjectURL(curNGifURL); curNGifURL = null; } els.ngif.removeAttribute('src'); }
function clearOverlay() { if (curOverlayURL) { URL.revokeObjectURL(curOverlayURL); curOverlayURL = null; } els.alignoverlay && els.alignoverlay.removeAttribute('src'); }

// 当前选中条目的 API 标识: 真动作号 + 段号。段条目带 _realAction/_seg; 普通动作 seg=null。
// ⚠️ 只喂 API URL/body; UI 状态(绿点/alignState/replaced 集)仍按 store 选择 id(段=合成 id), 两者别混。
function apiAct() {
  const a = store.currentAction();
  if (!a) return { realAction: null, seg: null };
  return { realAction: a._realAction != null ? a._realAction : a.action, seg: a._seg != null ? a._seg : null };
}
function segQ(seg) { return seg != null ? `&seg=${seg}` : ''; }

// 显示"替换后"横图 + GIF (blob, 防 4xx 当图; 竞态丢弃)。
async function showReplaced(path, token) {
  const { realAction, seg } = apiAct(); if (realAction == null) return;
  const qs = `action=${realAction}${segQ(seg)}`;
  try {
    const u = await request(`/api/strip?path=${encodeURIComponent(path)}&${qs}&kind=new`, { expect: 'blob' });
    if (store.isStale(token)) { URL.revokeObjectURL(u); return; }
    if (curNStripURL) URL.revokeObjectURL(curNStripURL);
    curNStripURL = u; els.nstrip.onerror = () => els.nstrip.removeAttribute('src'); els.nstrip.src = u;
    els.drophint.style.display = 'none';
  } catch (err) { if (!(err instanceof ApiError && err.code === 'aborted')) clearNStrip(); }
  try {
    const u = await request(`/api/gif?path=${encodeURIComponent(path)}&${qs}&kind=new`, { expect: 'blob' });
    if (store.isStale(token)) { URL.revokeObjectURL(u); return; }
    if (curNGifURL) URL.revokeObjectURL(curNGifURL);
    curNGifURL = u; els.ngif.onerror = () => els.ngif.removeAttribute('src'); els.ngif.src = u;
  } catch (err) { if (!(err instanceof ApiError && err.code === 'aborted')) clearNGif(); }
}

// ---- 逐帧手动对齐: 点帧选中 + 方向键移动 + 原图淡色叠底参照 ----
function akey(action, idx) { return `${action}#${idx}`; }
function frameCount() { const a = store.currentAction(); return a ? a.count : 0; }
function hideAlign() { if (els.alignbox) els.alignbox.hidden = true; }

function setupAlign(action, n) {
  if (!els.alignbox || !n) { hideAlign(); return; }
  els.alignframes.innerHTML = '';                    // 帧选择 chips
  for (let i = 0; i < n; i++) {
    const c = document.createElement('button');
    c.className = 'fchip'; c.dataset.i = i; c.textContent = i + 1;
    c.addEventListener('click', () => selectFrame(action, i));
    els.alignframes.appendChild(c);
  }
  els.alignbox.hidden = false;
  selectFrame(action, 0);
}

// 选中某帧: 高亮 chip + 灌缩放值 + 加载叠图。
function selectFrame(action, idx) {
  selIdx = idx;
  if (els.alignframes) for (const c of els.alignframes.children) c.classList.toggle('on', Number(c.dataset.i) === idx);
  displayFrame(action, idx);
  const s = store.get(); if (s.current) loadOverlay(s.current.path, idx, store.token());
}

// 把某帧当前缩放值灌进滑块。
function displayFrame(action, idx) {
  const st = alignState[akey(action, idx)] || { scale: 1, dx: 0, dy: 0 };
  els.alignscale.value = st.scale;
  els.alignscaleval.textContent = (+st.scale).toFixed(2);
}

// 加载叠图(原帧 ghost + 替换帧, blob, 竞态丢弃)。
async function loadOverlay(path, idx, token) {
  if (!els.alignoverlay) return;
  const { realAction, seg } = apiAct(); if (realAction == null) return;
  try {
    const u = await request(`/api/overlay?path=${encodeURIComponent(path)}&action=${realAction}${segQ(seg)}&idx=${idx}`, { expect: 'blob' });
    if (store.isStale(token)) { URL.revokeObjectURL(u); return; }
    if (curOverlayURL) URL.revokeObjectURL(curOverlayURL);
    curOverlayURL = u; els.alignoverlay.onerror = () => els.alignoverlay.removeAttribute('src'); els.alignoverlay.src = u;
  } catch (err) { if (!(err instanceof ApiError && err.code === 'aborted')) clearOverlay(); }
}

async function applyAdjust(action, idx) {
  const s = store.get();
  if (!s.current) return;
  const { realAction, seg } = apiAct();                      // action=UI 选择 id(段=合成 id, 给 akey); API 用 realAction+seg
  const st = alignState[akey(action, idx)] || { scale: 1, dx: 0, dy: 0 };
  try {
    const body = { path: s.current.path, action: realAction, idx, scale: st.scale, dx: st.dx, dy: st.dy };
    if (seg != null) body.seg = seg;
    await request('/api/adjust', { method: 'POST', body });
    loadOverlay(s.current.path, idx, store.token());          // 叠图实时更新
    showReplaced(s.current.path, store.token());              // 右侧新图/GIF 也跟着更新
  } catch (err) { toast(`对齐失败: ${err.message}`, true); }
}

function onScaleInput() {
  const s = store.get(); if (!s.current || s.action == null) return;
  const k = akey(s.action, selIdx);
  const st = alignState[k] || { scale: 1, dx: 0, dy: 0 };
  st.scale = parseFloat(els.alignscale.value); alignState[k] = st;
  els.alignscaleval.textContent = st.scale.toFixed(2);
  clearTimeout(adjustTimer); adjustTimer = setTimeout(() => applyAdjust(s.action, selIdx), 180);  // 防抖
}

// 方向键移动选中帧。dir: 'left'|'right'|'up'|'down' (按视觉方向, dx/dy 调轴致图反向, 故右=dx-)。
function nudge(dir) {
  const s = store.get(); if (!s.current || s.action == null) return;
  const k = akey(s.action, selIdx);
  const st = alignState[k] || { scale: 1, dx: 0, dy: 0 };
  if (dir === 'right') st.dx -= MOVE_STEP; else if (dir === 'left') st.dx += MOVE_STEP;
  else if (dir === 'up') st.dy += MOVE_STEP; else if (dir === 'down') st.dy -= MOVE_STEP;
  alignState[k] = st; applyAdjust(s.action, selIdx);
}

async function resetFrame() {
  const s = store.get(); if (!s.current || s.action == null) return;
  const k = akey(s.action, selIdx);
  alignState[k] = { scale: 1, dx: 0, dy: 0 }; displayFrame(s.action, selIdx);
  const { realAction, seg } = apiAct();
  try {
    const body = { path: s.current.path, action: realAction, idx: selIdx };
    if (seg != null) body.seg = seg;
    await request('/api/reset_frame', { method: 'POST', body });
    loadOverlay(s.current.path, selIdx, store.token());
    showReplaced(s.current.path, store.token());
  } catch (err) { toast(`重置失败: ${err.message}`, true); }
}

// ---- 导入 ----
function fileToDataURL(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取文件失败')); fr.readAsDataURL(file); });
}

async function doImport(file) {
  const s = store.get();
  if (!s.current || s.action == null) { toast('先选个动作', true); return; }
  if (!file) return;
  const path = s.current.path, action = s.action, token = store.token();   // action=UI 选择 id(段=合成 id)
  const { realAction, seg } = apiAct();                                     // API 用真动作号+段号 → 只切该组
  store.setLoading('import', true); setDropBusy(true); toast('切片对齐中…');
  try {
    const body = { path, action: realAction, image: await fileToDataURL(file) };
    if (seg != null) body.seg = seg;
    if (els.bgon.checked) body.bg_key = hex(els.bgkey.value);
    const r = await request('/api/import', { method: 'POST', body });
    if (store.isStale(token)) return;
    if (r.replaced > 0) {
      store.markReplaced(action); els.clear.disabled = false;               // 绿点按 UI 选择 id → 每组独立
      for (let i = 0; i < frameCount(); i++) delete alignState[akey(action, i)];  // 新导入清对齐缓存
      await showReplaced(path, store.token());
      setupAlign(action, r.replaced);
      toast(`已替换 ${r.replaced} 帧 · 下方可逐帧微调大小/位置`);
    } else {
      store.unmarkReplaced(action); hideAlign();
      toast('没识别到帧 — 检查横图是否同 N 格、背景能否抠净', true);
    }
  } catch (err) { toast(`导入失败: ${err.message}`, true); }
  finally { store.setLoading('import', false); setDropBusy(false); }
}

async function clearAction() {
  const s = store.get(); if (!s.current || s.action == null) return;
  const path = s.current.path, action = s.action;          // action=UI 选择 id(绿点/akey)
  const { realAction, seg } = apiAct();                    // API 用真动作号+段号 → 只还原该组
  els.clear.disabled = true;
  try {
    const body = { path, action: realAction };
    if (seg != null) body.seg = seg;
    await request('/api/clear_action', { method: 'POST', body });
    store.unmarkReplaced(action);
    store.unmarkLocked(action);          // 后端 clear 同时解锁(共享帧的边角差异重开自愈)
    for (let i = 0; i < frameCount(); i++) delete alignState[akey(action, i)];
    if (store.get().action === action) { clearNStrip(); clearNGif(); els.drophint.style.display = ''; hideAlign(); }
    toast('已还原此动作');
  } catch (err) { els.clear.disabled = false; toast(`还原失败: ${err.message}`, true); }
}

// M1 固定生效: 把当前动作的替换帧持久化到草稿 → 蓝点, 重启/切角色不丢。
async function lockAction() {
  const s = store.get(); if (!s.current || s.action == null) return;
  const action = s.action;
  if (els.lock) els.lock.disabled = true;
  try {
    await request('/api/lock', { method: 'POST', body: { path: s.current.path, action } });
    store.markLocked(action);
    toast('已固定生效 — 重启 / 切角色不丢，可继续换其它动作');
  } catch (err) { toast(`固定失败: ${err.message}`, true); }
}

function setDropBusy(busy) {
  els.drop.classList.toggle('busy', busy);
  els.drophintText && (els.drophintText.textContent = busy ? '处理中…' : els.drophintText.dataset.def);
}

// 订阅: 动作变 → 显示替换图 + 对齐面板(已替换) 或 清空(未替换)。
let lastKey = null;
function render() {
  if (!els) return;
  const s = store.get();
  const key = s.current && s.action != null ? `${s.current.path}#${s.action}` : null;
  const hasAction = !!key;
  const replaced = hasAction && s.replaced.has(s.action);
  const locked = hasAction && s.locked.has(s.action);
  const cur = store.currentAction();
  const isSeg = !!(cur && cur._seg != null);                 // 选的是"组"(非整动作)
  els.clear.disabled = !replaced;
  // 固定生效(草稿持久化)按整动作存, 没接组维度 → 选组时禁用, 引导切「全部」固定整套。
  if (els.lock) {
    els.lock.style.display = isSeg ? 'none' : '';   // 分组模式(DNF): 无"全部"入口、不走草稿持久化 → 藏掉固定生效
    els.lock.disabled = !(replaced && !locked);
    els.lock.textContent = locked ? '已生效' : '固定生效';
  }
  els.drop.classList.toggle('disabled', !hasAction);
  if (key === lastKey) return;
  lastKey = key;
  clearNStrip(); clearNGif(); clearOverlay(); els.drophint.style.display = ''; hideAlign();
  if (!key) return;
  if (s.replaced.has(s.action)) {
    showReplaced(s.current.path, store.token());
    setupAlign(s.action, frameCount());   // 已替换动作切回: 恢复对齐面板(值从 alignState 取)
  }
}

export function initImporter(refs, handlers) {
  els = {
    drop: refs.drop, nstrip: refs.nstrip, ngif: refs.ngif, drophint: refs.drophint, drophintText: refs.drophintText,
    clear: refs.clear, lock: refs.lock, bgkey: refs.bgkey, bgon: refs.bgon,
    alignbox: refs.alignbox, alignframes: refs.alignframes, alignoverlay: refs.alignoverlay,
    alignscale: refs.alignscale, alignscaleval: refs.alignscaleval, alignreset: refs.alignreset,
  };
  toast = handlers.toast;
  if (els.drophintText) els.drophintText.dataset.def = els.drophintText.textContent;

  els.drop.addEventListener('click', () => {
    if (store.get().action == null) { toast('先选个动作', true); return; }
    if (store.get().loading.import) return;
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
    i.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) doImport(f); }); i.click();
  });
  els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault(); els.drop.classList.remove('over');
    if (store.get().action == null) { toast('先选个动作', true); return; }
    if (store.get().loading.import) return;
    const f = e.dataTransfer.files[0]; if (f) doImport(f);
  });
  els.clear.addEventListener('click', clearAction);
  if (els.lock) els.lock.addEventListener('click', lockAction);

  // 对齐控件: 滑块缩放 + 重置 + 方向键移动选中帧
  if (els.alignscale) els.alignscale.addEventListener('input', onScaleInput);
  if (els.alignreset) els.alignreset.addEventListener('click', resetFrame);
  document.addEventListener('keydown', (e) => {
    if (!els.alignbox || els.alignbox.hidden) return;
    const s = store.get(); if (!s.current || s.action == null) return;
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;   // 不抢输入框/滑块
    const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    if (!dir) return;
    e.preventDefault();
    nudge(dir);
  });

  store.subscribe(render);
  render();
}
