// main.js — 装配层 (ARCHITECTURE.md §1)。
// 绑定 DOM 引用 → 初始化各组件 → 编排 scan/openChar → 提供全局 toast。
// 自身不持状态 (状态在 store), 不直接碰图片字节 (在 stripview/importer)。

import { store } from './store.js';
import { request } from './api.js';
import { initCharbar } from './ui/charbar.js';
import { initActionList } from './ui/actionlist.js';
import { initStripView } from './ui/stripview.js';
import { initImporter } from './ui/importer.js';

const $ = (s) => document.querySelector(s);

// ---- 全局 toast (唯一提示出口, §5.2 所有 catch 都走它) ----
let _toastTimer = null;
function toast(msg, warn = false) {
  const t = $('#toast');
  if (!t) { (warn ? console.warn : console.log)('[toast]', msg); return; }
  t.textContent = msg;
  t.className = 'toast' + (warn ? ' warn' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), warn ? 3600 : 2400);
}

// ---- 编排: 扫描根目录 ----
async function scan(root) {
  store.setRoot(root);
  store.setLoading('chars', true);
  try {
    const r = await request(`/api/chars?root=${encodeURIComponent(root || '')}`);
    store.setRoot(r.root || root || '');
    store.setChars(r.chars || []);
    if (!r.chars || !r.chars.length) {
      store.setCurrent(null);
      toast('该目录没找到角色 (需 Sprite.sff + Anim.air)', true);
      return;
    }
    // 自动打开第一个。
    await openChar(r.chars[0].path);
  } catch (err) {
    store.setChars([]);
    store.setCurrent(null);
    toast(err.message, true);
  } finally {
    store.setLoading('chars', false);
  }
}

// ---- 编排: 打开角色 ----
async function openChar(path) {
  if (!path) return;
  store.setLoading('chars', true);
  try {
    const filter = store.get().filter;
    const d = await request(`/api/open?path=${encodeURIComponent(path)}&filter=${filter}`);
    await expandSegments(d, path);     // 本体单动作 → 用"分段"作左栏单位(点选看/喂AI)
    // setCurrent 会从 actions[].replaced 恢复绿点 (修绿点 bug)。
    store.setCurrent(d);
    // 默认选第一项。
    if (d && Array.isArray(d.actions) && d.actions.length) {
      store.setAction(d.actions[0].action);
    } else {
      store.setAction(null);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    store.setLoading('chars', false);
  }
}

// 给动作补 _realAction/_seg; 若只有一个动作且能分段, 把"段"展开成左栏单位
// (DNF 本体一个 IMG = 整套动作, 按姿势分段后逐段浏览/喂 AI)。多动作不展开免侧栏爆量。
async function expandSegments(d, path) {
  if (!d || !Array.isArray(d.actions)) return;
  d.actions = d.actions.map((a) => ({ ...a, _realAction: a.action, _seg: null }));
  if (d.actions.length !== 1) return;
  const ra = d.actions[0]._realAction;
  try {
    const res = await request(`/api/segments?path=${encodeURIComponent(path)}&action=${ra}`);
    const segs = (res && res.segments) || [];
    if (segs.length > 1) {
      // 已拆成组 → 左栏只列各组, 不再放"全部"总览条目(三九: 有拆细节了不需要全部)。
      d.actions = segs.map((sg) => ({
        action: ra * 1000 + sg.index,     // 合成唯一选择 id, 不与真动作号撞
        name: `组${sg.index} f${sg.start}-${sg.end}`,
        count: sg.count,
        _realAction: ra,
        _seg: sg.index,
      }));
    }
  } catch { /* 不支持分段(MUGEN)/出错 → 保持单动作 */ }
}

// ---- 启动 ----
function boot() {
  // 顶栏。
  initCharbar(
    {
      root: $('#root'),
      scan: $('#scan'),
      charsel: $('#charsel'),
      stat: $('#stat'),
      pack: $('#pack'),
      apply: $('#apply'),
      restore: $('#restore'),
      hidepatch: $('#hidepatch'),
      deploy: $('#deploy'),
      fltRadios: [...document.querySelectorAll('input[name=flt]')],
    },
    { onScan: scan, onOpenChar: openChar, onFilter: (f) => { store.setFilter(f); const cur = store.get().current; if (cur) openChar(cur.path); }, toast }
  );

  // 左栏动作列表。
  initActionList($('#actions'), { onSelect: (id) => store.setAction(id) });

  // 中栏 (原始图 + 提示词 + GIF + 导出)。
  initStripView(
    {
      aname: $('#aname'),
      ostrip: $('#ostrip'),
      ogif: $('#ogif'),
      export: $('#export'),
      charDesc: $('#charDesc'),
      promptText: $('#promptText'),
      copyPrompt: $('#copyPrompt'),
      plangRadios: [...document.querySelectorAll('input[name=plang]')],
      bgsel: $('#bgsel'),
    },
    { toast }
  );

  // 右栏导入。
  initImporter(
    {
      drop: $('#drop'),
      nstrip: $('#nstrip'),
      ngif: $('#ngif'),
      drophint: $('#drophint'),
      drophintText: $('#drophintText'),
      clear: $('#clear'),
      lock: $('#lock'),
      bgkey: $('#bgkey'),
      bgon: $('#bgon'),
      alignbox: $('#alignbox'),
      alignframes: $('#alignframes'),
      alignoverlay: $('#alignoverlay'),
      alignscale: $('#alignscale'),
      alignscaleval: $('#alignscaleval'),
      alignreset: $('#alignreset'),
    },
    { toast }
  );

  // 全局兜底: 任何漏网的 promise rejection 也给个提示而非静默 (§5.1)。
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason);
    toast(e.reason && e.reason.message ? e.reason.message : '发生未知错误', true);
  });

  // 初始: 不带 root 拉一次, 拿默认 root + 若有角色自动扫描。
  request('/api/chars')
    .then((d) => {
      store.setRoot(d.root || '');
      if ($('#root')) $('#root').value = d.root || '';
      if (d.chars && d.chars.length) {
        store.setChars(d.chars);
        return openChar(d.chars[0].path);
      }
    })
    .catch((err) => toast(err.message, true));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
