// stripview.js — 中栏: 原始序列横图 + 提示词框 + 动作 GIF + 导出 (ARCHITECTURE.md §1)。
// 图走 request(expect:'blob') 拿 objectURL (能捕获 4xx) + img.onerror 兜底 + 用完 revoke (§5.3)。
// 竞态: 起请求拿 token, 回来若 stale 丢弃 (§5.4)。

import { store } from '../store.js';
import { request, ApiError } from '../api.js';

let els = null;
let toast = null;

// 持有当前已赋给 <img> 的 objectURL, 切换/卸载时 revoke 防泄漏。
let curStripURL = null;
let curGifURL = null;

// ---- 提示词模板 (绿底网格版, 对齐 nano banana 友好格式) ----
// {n}=当前动作帧数(自动), {char}=你填的角色。背景纯绿无标记线; 抠图走 despill 故不要求白描边。
const PROMPT = {
  zh: (n, c) => `编辑这张序列帧动画图：同一个格斗角色的 ${n} 个姿势，排列在纯绿色背景的网格里。

把角色【整个人从头到脚彻底换成一个全新角色】：
${c}
要换的是整体——脸、发型、体型、服装、配色全部重画成上面描述的角色。这是完全换人，不是只改头或脸。

唯一必须严格保持不变的是【姿势和布局】：
- 必须正好 ${n} 帧、网格顺序一样（从左到右、从上到下）——不许增删、合并或调换任何一帧
- 每帧的动作、身体朝向、四肢角度、在各自格子里的位置和大小，跟原图一模一样
- 每个姿势待在自己的格子里，不要跨格、不要重叠、不要挪动格子

背景（方便后期抠图，务必照做）：
- 整张图铺【纯绿 #00FF00】背景，所有格子统一同一个绿、干净平涂，不要任何场景、阴影、地面、渐变或纹理。
- 角色身上避免用到纯绿，以免和背景混淆。

保持清晰的像素风和分辨率，整图尺寸不变。把整张网格图作为一张图返回。`,
  en: (n, c) => `Edit this sprite animation sheet: one fighting-game character in ${n} poses, laid out on a grid over a solid green background.

COMPLETELY redraw the ENTIRE fighter as a brand-new character, head to toe:
${c}
Replace the WHOLE figure — face, hair, body, outfit and colors — with the character above. This is a full redesign of the whole body, NOT just a new head or face.

The ONLY thing that must stay identical is the POSE and LAYOUT:
- exactly ${n} frames in the same grid order (left to right, top to bottom) — do NOT add, drop, merge, or reorder any frame
- in every frame keep the same action, body angle, limb positions, and the same size and placement within its own cell as the original
- each pose stays inside its own cell — no spilling across cells, no overlap, no moving the cells

Background (for clean keying afterward — please follow exactly):
- fill the whole image with PURE GREEN #00FF00, the same green for every cell, cleanly painted — no scenery, shadow, ground, gradient or texture.
- avoid pure green anywhere on the character itself, to prevent confusion with the background.

Keep the crisp pixel-art style, resolution and overall image size. Return the whole grid as one single image.`,
};

function plang() {
  const r = els.plangRadios.find(x => x.checked);
  return (r && r.value) || 'zh';
}
function charText() { return (els.charDesc.value || '').trim(); }
// 背景色: 用户选 (绿幕/白/黑/灰), 默认绿。显示 + 导出 + 导入抠图都用它
// (导出什么底, AI 就在什么底画, 导入按角落色抠掉)。绿对多数角色抠得最干净, 但可自己切。
function bgMode() { return (els.bgsel && els.bgsel.value) || 'green'; }

function curCount() {
  const a = store.currentAction();
  return a ? a.count : 0;
}

function updatePrompt() {
  const lang = plang();
  const n = curCount() || (lang === 'zh' ? '所有' : 'all');
  const ph = lang === 'zh' ? '<在上面填写你要的角色>' : '<your character above>';
  els.promptText.value = PROMPT[lang](n, charText() || ph);
}

// 剪贴板复制: secure context 用原生, 否则退回 execCommand (HTTP 下也能用)。
async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch { /* 焦点/权限问题 → 退回 */ }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; } finally { ta.remove(); }
  return ok;
}

async function copyPrompt() {
  if (!charText()) { els.charDesc.focus(); return toast('先填一下你要的角色', true); }
  if (!curCount()) return toast('先选个动作', true);
  const ok = await copyText(PROMPT[plang()](curCount(), charText()));
  if (ok) toast('提示词已复制 · 连同导出的横图一起发给 AI');
  else toast('复制失败, 请手动选中复制', true);
}

// ---- 图片加载 (blob + 竞态 + 兜底) ----
function clearStrip() {
  if (curStripURL) { URL.revokeObjectURL(curStripURL); curStripURL = null; }
  els.ostrip.removeAttribute('src');
}
function clearGif() {
  if (curGifURL) { URL.revokeObjectURL(curGifURL); curGifURL = null; }
  els.ogif.removeAttribute('src');
}

// 选中条目 → API 的 action(+seg) 查询片段。段视图条目带 _realAction/_seg; 普通动作 _seg=null。
function apiActionQS(act) {
  const ra = act && act._realAction != null ? act._realAction : (act ? act.action : 0);
  return `action=${ra}` + (act && act._seg != null ? `&seg=${act._seg}` : '');
}

async function loadStrip(path, act, token) {
  store.setLoading('strip', true);
  els.ostrip.classList.add('loading');
  try {
    const url = await request(
      `/api/strip?path=${encodeURIComponent(path)}&${apiActionQS(act)}&kind=orig&bg=${bgMode()}`,
      { expect: 'blob' }
    );
    if (store.isStale(token)) { URL.revokeObjectURL(url); return; }  // 切走了, 丢弃
    if (curStripURL) URL.revokeObjectURL(curStripURL);
    curStripURL = url;
    els.ostrip.onerror = () => { els.ostrip.removeAttribute('src'); toast('原始横图加载失败', true); };
    els.ostrip.src = url;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'aborted') return;
    clearStrip();
    toast(`原始横图: ${err.message}`, true);
  } finally {
    if (!store.isStale(token)) { store.setLoading('strip', false); els.ostrip.classList.remove('loading'); }
  }
}

async function loadGif(path, act, token) {
  try {
    const url = await request(
      `/api/gif?path=${encodeURIComponent(path)}&${apiActionQS(act)}&kind=orig`,
      { expect: 'blob' }
    );
    if (store.isStale(token)) { URL.revokeObjectURL(url); return; }
    if (curGifURL) URL.revokeObjectURL(curGifURL);
    curGifURL = url;
    els.ogif.onerror = () => { els.ogif.removeAttribute('src'); };
    els.ogif.src = url;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'aborted') return;
    clearGif();
    // GIF 是锦上添花, 失败不弹 toast 干扰, 只清空。
  }
}

// 导出: 直接拿 blob 触发下载 (走 api 统一错误处理)。底色跟随你选的背景(黑/白/绿) ——
// 导出什么底, AI 就在什么底上画, 导入时按角落色抠掉, 全程一个设置说了算。
async function exportStrip() {
  const s = store.get();
  const act = store.currentAction();
  if (!s.current || !act) return;
  els.export.disabled = true;
  try {
    const url = await request(
      `/api/strip?path=${encodeURIComponent(s.current.path)}&${apiActionQS(act)}&kind=orig&bg=${bgMode()}`,
      { expect: 'blob' }
    );
    const ra = act._realAction != null ? act._realAction : act.action;
    const tag = act._seg != null ? `_a${ra}_seg${act._seg}` : `_a${ra}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.current.name}${tag}_strip.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('已导出序列图 → 丢给 nano banana');
  } catch (err) {
    toast(`导出失败: ${err.message}`, true);
  } finally {
    els.export.disabled = (store.currentAction() == null);
  }
}

// 订阅: action 变 → 重新拉图 + 刷提示词帧数 + 标题。
let lastKey = null;  // `${path}#${action}` 防重复加载
function render() {
  if (!els) return;
  const s = store.get();
  const a = store.currentAction();

  // 标题 + 导出按钮态。段视图条目带 _seg, 不显示合成 id。
  if (a) {
    els.aname.textContent = (a._seg != null ? a.name : `[${a.action}] ${a.name}`) + ` · ${a.count} 帧`;
    els.export.disabled = false;
  } else {
    els.aname.textContent = '—';
    els.export.disabled = true;
  }

  // 提示词帧数实时跟随。
  updatePrompt();

  const key = s.current && s.action != null ? `${s.current.path}#${s.action}` : null;
  if (key === lastKey) return;     // 同一选择, 不重复拉图
  lastKey = key;

  if (!key) { clearStrip(); clearGif(); return; }

  const token = store.token();
  clearStrip(); clearGif();
  loadStrip(s.current.path, a, token);
  loadGif(s.current.path, a, token);
}

export function initStripView(refs, handlers) {
  els = {
    aname: refs.aname,
    ostrip: refs.ostrip,
    ogif: refs.ogif,
    export: refs.export,
    charDesc: refs.charDesc,
    promptText: refs.promptText,
    copyPrompt: refs.copyPrompt,
    plangRadios: refs.plangRadios,
    bgsel: refs.bgsel,
  };
  toast = handlers.toast;

  // localStorage 容错恢复 (读取可能抛 → 静默降级)。
  try {
    els.charDesc.value = localStorage.getItem('afa_char') || '';
  } catch { /* localStorage 不可用 (隐私模式等), 用空值 */ }
  let savedLang = 'zh';
  try { savedLang = localStorage.getItem('afa_plang') || 'zh'; } catch { /* 同上 */ }
  const langR = els.plangRadios.find(r => r.value === savedLang);
  if (langR) langR.checked = true;

  els.charDesc.addEventListener('input', () => {
    try { localStorage.setItem('afa_char', charText()); } catch { /* 配额/隐私模式, 忽略 */ }
    updatePrompt();
  });
  for (const r of els.plangRadios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      try { localStorage.setItem('afa_plang', r.value); } catch { /* 忽略 */ }
      updatePrompt();
    });
  }
  // 背景下拉: 恢复偏好 + 切换时强制重拉横图(换背景)。
  try { const v = localStorage.getItem('afa_bgsel'); if (els.bgsel && v) els.bgsel.value = v; } catch { /* 忽略 */ }
  if (els.bgsel) els.bgsel.addEventListener('change', () => {
    try { localStorage.setItem('afa_bgsel', els.bgsel.value); } catch { /* 忽略 */ }
    lastKey = null;   // 背景变了, 强制重新加载横图
    render();
  });
  els.copyPrompt.addEventListener('click', copyPrompt);
  els.export.addEventListener('click', exportStrip);

  store.subscribe(render);
  updatePrompt();
  render();
}
