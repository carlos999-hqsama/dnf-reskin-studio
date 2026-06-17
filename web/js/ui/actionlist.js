// actionlist.js — 左栏: 动作列表 + 帧数 + 已替换绿点 (ARCHITECTURE.md §1)。
// 绿点完全从 store.replaced 渲染 (来自后端 actions[].replaced), 切角色再切回不丢 (修绿点 bug §4)。

import { store } from '../store.js';

let nav = null;
let onSelect = null;

// 记录上次渲染的角色路径, 决定是整列重建还是只更新选中/绿点态。
let lastPath = null;
let lastActionsSig = '';

function buildList(s) {
  nav = nav;
  nav.innerHTML = '';
  const actions = (s.current && s.current.actions) || [];
  if (!actions.length) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = s.current ? '该角色没有动作' : (s.loading.chars ? '解析中…' : '选角色后这里列动作');
    nav.appendChild(ph);
    return;
  }
  for (const a of actions) {
    const el = document.createElement('a');
    el.dataset.a = a.action;
    const label = a._seg != null ? escapeHtml(a.name) : `[${a.action}] ${escapeHtml(a.name)}`;
    el.innerHTML =
      `<span class="t">${label}</span>` +
      `<span class="c">${a.count}</span><i class="badge" title="已替换"></i>`;
    el.addEventListener('click', () => onSelect(a.action));
    nav.appendChild(el);
  }
}

// 只更新 on / done / locked class, 不重建 DOM (保滚动位置 + 不打断)。
function syncStates(s) {
  for (const el of nav.querySelectorAll('a')) {
    const id = Number(el.dataset.a);
    const locked = s.locked.has(id);
    el.classList.toggle('on', id === s.action);
    el.classList.toggle('locked', locked);                          // 蓝点: 已固定生效
    el.classList.toggle('done', s.replaced.has(id) && !locked);     // 绿点: 本次替换(未固定)
  }
}

function render() {
  if (!nav) return;
  const s = store.get();
  const path = s.current ? s.current.path : null;
  const sig = ((s.current && s.current.actions) || []).map(a => `${a.action}:${a.count}`).join('|');

  // 角色或动作集变了 → 重建; 否则只同步态。
  if (path !== lastPath || sig !== lastActionsSig) {
    lastPath = path;
    lastActionsSig = sig;
    buildList(s);
  }
  syncStates(s);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function initActionList(navEl, handlers) {
  nav = navEl;
  onSelect = handlers.onSelect;
  store.subscribe(render);
  render();
}
