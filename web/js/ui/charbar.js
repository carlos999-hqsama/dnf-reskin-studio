// charbar.js — 顶栏: 根目录 / 扫描 / 选角色 / 核心·全部过滤 / 打包 (ARCHITECTURE.md §1)。
// 从 store 渲染 + 订阅。打包用页内输入框 (无原生 prompt, §5.6)。

import { store } from '../store.js';
import { request } from '../api.js';

let els = null;
let onScan = null, onOpenChar = null, onFilter = null, toast = null;

// 缓存上次渲染的角色列表签名, 避免重建 <option> 打断用户操作。
let lastCharsSig = '';

function render() {
  const s = store.get();
  if (!els) return;

  // 角色下拉: 仅在列表变化时重建。
  const sig = s.chars.map(c => c.path).join('|');
  if (sig !== lastCharsSig) {
    lastCharsSig = sig;
    els.charsel.innerHTML = '';
    for (const c of s.chars) {
      const o = document.createElement('option');
      o.value = c.path;
      o.textContent = c.zh || c.name;     // 列角色用中文名(代号仍是内部标识)
      els.charsel.appendChild(o);
    }
  }
  // 同步选中项 (current 可能由别处设置)。加载中不拉回 —— 否则把用户刚选的
  // 下拉值在 openChar 完成前跳回旧角色, 造成闪烁。
  if (!s.loading.chars && s.current && els.charsel.value !== s.current.path) {
    els.charsel.value = s.current.path;
  }

  // 状态文字。
  if (s.current) {
    els.stat.textContent = `${s.current.zh || s.current.name} · ${(s.current.actions || []).length} 动作`;
  } else if (s.loading.chars) {
    els.stat.textContent = '解析中…';
  } else {
    els.stat.textContent = '';
  }

  // 按钮禁用态: 扫描/选角色中禁扫描+下拉; 打包按 current + pack loading。
  const busy = s.loading.chars;
  els.scan.disabled = busy;
  els.charsel.disabled = busy || s.chars.length === 0;
  els.pack.disabled = !s.current || s.loading.pack;
  els.pack.textContent = s.loading.pack ? '打包中…' : '打包新角色';

  // M3 装回: 要有角色 + 至少替换/固定过一个动作; M2 还原: 要有角色 + 已备份原版。
  const hasReplace = s.replaced.size > 0 || s.locked.size > 0;
  if (els.apply) { els.apply.disabled = !s.current || !hasReplace || s.loading.pack; els.apply.textContent = s.loading.pack ? '装回中…' : '装回原目录'; }
  if (els.restore) els.restore.disabled = !s.current || !s.backedUp;
  if (els.hidepatch && !hideBusy) els.hidepatch.disabled = !s.current;   // 隐藏包: 有角色就能点(生成中由 doHidePatch 自管)
  if (els.deploy && !deployBusy) els.deploy.disabled = !s.current || (s.replaced.size === 0 && s.locked.size === 0);  // 部署: 要先换过帧
  // DNF(分组模式): 藏掉「打包新角色」(部署已含它) + MUGEN 路径的「装回原目录/还原原版」, 只留「部署到游戏」+「生成隐藏时装包」。
  const isDnf = !!(s.current && (s.current.actions || []).some(a => a && a._seg != null));
  for (const b of [els.pack, els.apply, els.restore]) { if (b) b.style.display = isDnf ? 'none' : ''; }

  // 过滤 radio 同步。
  for (const r of els.fltRadios) r.checked = (r.value === s.filter);
}

// ---- 打包: 页内弹层取名字 (替代 window.prompt) ----
function openPackDialog() {
  const s = store.get();
  if (!s.current) return;
  const defName = `${s.current.name}_reskin`;

  // 极简弹层 (复用现有 Apple 风, 不引第三方)。
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">打包新角色</div>
      <div class="modal-sub">替换帧 + 拷贝判定/指令/音效, 输出到 out/&lt;名字&gt;/</div>
      <input class="modal-input" type="text" id="packNameInput" autocomplete="off" spellcheck="false">
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn primary" data-act="ok">开始打包</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const input = mask.querySelector('#packNameInput');
  input.value = defName;
  // 选中默认名方便直接改。
  setTimeout(() => { input.focus(); input.select(); }, 0);

  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const submit = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); toast && toast('给个角色名', true); return; }
    close();
    doPack(name);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') submit();
  };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('[data-act=cancel]').onclick = close;
  mask.querySelector('[data-act=ok]').onclick = submit;
}

async function doPack(name) {
  const s = store.get();
  if (!s.current) return;
  store.setLoading('pack', true);
  toast && toast('打包中…(全量重建几秒)');
  try {
    const r = await request('/api/pack', {
      method: 'POST',
      body: { path: s.current.path, name },
      timeout: 0,               // 打包慢且时间因机器而异 → 不写死超时(刷新页面即取消)
    });
    // r.out 是绝对路径; 取末段角色名显示, 别和 'out/' 前缀重复拼接。
    const outName = String(r.out || name).replace(/\/+$/, '').split('/').pop();
    toast && toast(`已打包: ${r.replaced ?? '?'} 帧替换 · ${r.size_mb ?? '?'}MiB → out/${outName}/`);
  } catch (err) {
    toast && toast(err.message, true);
  } finally {
    store.setLoading('pack', false);
  }
}

// 慢操作按钮计时: 在按钮上滚动显示已用秒数, 让用户看见"在动、没死、能取消", 返回 stop 函数(放 finally 调)。
function startElapsed(btn, label) {
  let sec = 0;
  btn.textContent = `${label} 0s…(点取消)`;
  const id = setInterval(() => { sec += 1; btn.textContent = `${label} ${sec}s…(点取消)`; }, 1000);
  return () => clearInterval(id);
}

// 生成隐藏时装包(单独按钮, 三九自己决定要不要): 后端枚举该职业全部装备 avatar 置空透明 → out/%27_<职业>_hide.NPK。
let hideBusy = false, hideAbort = null;
async function doHidePatch() {
  const s = store.get();
  if (!s.current || hideBusy) return;
  hideBusy = true; hideAbort = new AbortController();
  els.hidepatch.disabled = false;
  const stopT = startElapsed(els.hidepatch, '生成中');   // 显示已用秒数(约几秒)
  toast && toast('隐藏装备·露出本体 生成中…(约几秒; 不想等再点一下取消)');
  try {
    const r = await request('/api/hide_patch', { method: 'POST', body: { path: s.current.path }, timeout: 0, signal: hideAbort.signal });
    toast && toast(`隐藏时装包已生成并放入 ImagePacks2: ${r.cls} · ${r.size_mb ?? '?'}MB · 重启游戏即生效(out/ 也留了底)`);
  } catch (err) {
    if (err.code === 'aborted') toast && toast('已取消(后台可能还在生成, 不影响)');
    else toast && toast(`生成隐藏包失败: ${err.message}`, true);
  } finally {
    stopT();
    hideBusy = false; hideAbort = null;
    els.hidepatch.disabled = !store.get().current;
    els.hidepatch.textContent = '隐藏装备·露出本体';
  }
}

// 一键部署到游戏: 后端打包本体 + 把本体包/隐藏包改 % 名丢进 ImagePacks2(只新增不碰原文件)。
let deployBusy = false, deployAbort = null;
async function doDeploy() {
  const s = store.get();
  if (!s.current || deployBusy) return;
  deployBusy = true; deployAbort = new AbortController();
  els.deploy.disabled = false;
  const stopT = startElapsed(els.deploy, '部署中');   // 显示已用秒数, 时间因机器而异不写死超时
  toast && toast('部署到游戏中…(打包本体 + 复制到 ImagePacks2; 不想等再点一下取消)');
  try {
    const r = await request('/api/deploy_game', { method: 'POST', body: { path: s.current.path }, timeout: 0, signal: deployAbort.signal });
    const n = (r.deployed || []).length;
    const hideNote = r.hide_included ? '(含隐藏包)' : '(未含隐藏包 — 要的话点「隐藏装备·露出本体」)';
    toast && toast(`已部署 ${n} 个 NPK 到 ImagePacks2 ${hideNote} · 重启游戏看效果`);
  } catch (err) {
    if (err.code === 'aborted') toast && toast('已取消(后台可能还在打包, 不影响下次)');
    else toast && toast(`部署失败: ${err.message}`, true);
  } finally {
    stopT();
    deployBusy = false; deployAbort = null;
    els.deploy.disabled = !store.get().current;
    els.deploy.textContent = '部署到游戏';
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 通用二次确认弹层 (破坏性操作前; 复用 pack 弹层的 Apple 风样式, §5.6 不用原生 confirm)。
function confirmDialog(title, subHtml, okLabel, onOk) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${esc(title)}</div>
      <div class="modal-sub">${subHtml}</div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn primary" data-act="ok">${esc(okLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const ok = () => { close(); onOk(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'Enter') ok(); };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('[data-act=cancel]').onclick = close;
  mask.querySelector('[data-act=ok]').onclick = ok;
}

// M3 装回原目录: 打包覆盖回角色原目录 Sprite.sff (破坏性, 备份兜底)。
async function doApply() {
  const s = store.get(); if (!s.current) return;
  store.setLoading('pack', true);
  toast && toast('打包并覆盖回原目录中…(全量重建几秒)');
  try {
    const r = await request('/api/apply', { method: 'POST', body: { path: s.current.path }, timeout: 0 });
    toast && toast(`已装回原目录: ${r.replaced ?? '?'} 帧替换 · ${r.size_mb ?? '?'}MiB → 重编 bundle 后刷新竞技场看实机`);
  } catch (err) { toast && toast(`装回失败: ${err.message}`, true); }
  finally { store.setLoading('pack', false); }
}

// M2 还原原版: 备份覆盖回原目录。
async function doRestore() {
  const s = store.get(); if (!s.current) return;
  try {
    await request('/api/restore', { method: 'POST', body: { path: s.current.path } });
    toast && toast('已还原原版 — 重编 bundle 后刷新竞技场回原版');
  } catch (err) { toast && toast(`还原失败: ${err.message}`, true); }
}

export function initCharbar(refs, handlers) {
  els = {
    root: refs.root,
    scan: refs.scan,
    charsel: refs.charsel,
    stat: refs.stat,
    pack: refs.pack,
    apply: refs.apply,
    restore: refs.restore,
    hidepatch: refs.hidepatch,
    deploy: refs.deploy,
    fltRadios: refs.fltRadios,
  };
  onScan = handlers.onScan;
  onOpenChar = handlers.onOpenChar;
  onFilter = handlers.onFilter;
  toast = handlers.toast;

  els.scan.addEventListener('click', () => onScan(els.root.value.trim()));
  els.root.addEventListener('keydown', (e) => { if (e.key === 'Enter') onScan(els.root.value.trim()); });
  els.charsel.addEventListener('change', (e) => onOpenChar(e.target.value));
  for (const r of els.fltRadios) {
    r.addEventListener('change', () => { if (r.checked) onFilter(r.value); });
  }
  els.pack.addEventListener('click', openPackDialog);
  if (els.apply) els.apply.addEventListener('click', () => {
    const s = store.get(); if (!s.current) return;
    confirmDialog('装回原目录(试穿)',
      `把打包结果(替换帧 + 未替换原帧)覆盖回 <b>${esc(s.current.name)}</b> 原目录的 Sprite.sff。<br>原版已备份, 不满意可一键还原。`,
      '覆盖并装回', doApply);
  });
  if (els.restore) els.restore.addEventListener('click', () => {
    const s = store.get(); if (!s.current) return;
    confirmDialog('还原原版',
      `用备份的原版精灵覆盖回 <b>${esc(s.current.name)}</b> 原目录, 撤销所有装回。`,
      '还原原版', doRestore);
  });
  if (els.hidepatch) els.hidepatch.addEventListener('click', () => {
    if (hideBusy) { if (hideAbort) hideAbort.abort(); return; }   // 运行中再点 = 取消
    doHidePatch();
  });
  if (els.deploy) els.deploy.addEventListener('click', () => {
    if (deployBusy) { if (deployAbort) deployAbort.abort(); return; }   // 运行中再点 = 取消
    const s = store.get(); if (!s.current) return;
    confirmDialog('部署到游戏',
      `把本体补丁包(+ 隐藏包若已生成)改 % 名丢进 <b>ImagePacks2</b> 覆盖加载。<br>只新增 % 文件、不碰客户端原文件; 重启游戏即生效。`,
      '打包并部署', doDeploy);
  });

  store.subscribe(render);
  render();
}
