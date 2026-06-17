// store.js — 单一状态源 + 订阅 (ARCHITECTURE.md §5.5)。
// 状态不存 DOM。UI 从这里读 + 订阅变更。
// 含竞态令牌 §5.4: 异步响应回来若 (char,action) 已变, 调用方据 token 丢弃过期结果。

const state = {
  root: '',                 // 扫描根目录
  chars: [],                // [{path, name}]
  current: null,            // 当前 Project: {name, path, cell_w, cell_h, anchor, actions:[Act]}
  action: null,             // 当前选中动作号 (int) 或 null
  filter: 'core',           // 'core' | 'all'
  replaced: new Set(),      // 已替换帧的动作号集合 (真相来自后端 actions[].replaced)
  locked: new Set(),        // M1 已固定生效的动作号 (真相来自后端 actions[].locked, 蓝点)
  backedUp: false,          // M2 原版是否已备份 (后端 open.backed_up)
  loading: {                // 各区 loading 态, 用于禁用按钮/显示进度
    chars: false,           //   扫描/打开角色中
    strip: false,           //   原始横图/GIF 加载中
    import: false,          //   导入切片中
    pack: false,            //   打包中
  },
};

const subs = new Set();
function emit() { for (const fn of subs) { try { fn(state); } catch (e) { console.error('[store sub]', e); } } }

// 竞态令牌: 每次切角色/动作自增。异步任务起跑时拿一份, 回来比对。
let _token = 0;

export const store = {
  get: () => state,

  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },

  // 当前 (char,action) 令牌 — 起异步前拿, 回来用 isStale 判断。
  token: () => _token,
  isStale: (t) => t !== _token,
  bumpToken: () => { _token += 1; return _token; },

  // ---- 状态变更 (集中, 改完 emit) ----

  setRoot(root) { state.root = root || ''; emit(); },

  setChars(chars) { state.chars = Array.isArray(chars) ? chars : []; emit(); },

  setFilter(f) { state.filter = f === 'all' ? 'all' : 'core'; emit(); },

  // 打开新角色: 重置 action/replaced, 从后端 actions[].replaced 恢复绿点 (修绿点 bug §4)。
  setCurrent(project) {
    _token += 1;                       // 角色变 → 作废在途请求
    state.current = project || null;
    state.action = null;
    state.replaced = new Set();
    state.locked = new Set();
    state.backedUp = !!(project && project.backed_up);
    if (project && Array.isArray(project.actions)) {
      for (const a of project.actions) {
        if (a && a.replaced) state.replaced.add(a.action);
        if (a && a.locked) state.locked.add(a.action);   // M1: 已固定生效(蓝点)
      }
    }
    emit();
  },

  setAction(actionId) {
    if (state.action !== actionId) _token += 1;   // 动作变 → 作废在途请求
    state.action = actionId;
    emit();
  },

  // 标记某动作已替换 (导入成功后)。
  markReplaced(actionId) {
    state.replaced.add(actionId);
    emit();
  },

  // 取消替换标记 (还原后)。
  unmarkReplaced(actionId) {
    state.replaced.delete(actionId);
    emit();
  },

  isReplaced(actionId) { return state.replaced.has(actionId); },

  // M1 固定生效标记。
  markLocked(actionId) { state.locked.add(actionId); emit(); },
  unmarkLocked(actionId) { state.locked.delete(actionId); emit(); },
  isLocked(actionId) { return state.locked.has(actionId); },

  // loading 态: setLoading('import', true)
  setLoading(key, val) {
    if (key in state.loading) {
      state.loading[key] = !!val;
      emit();
    }
  },

  // 当前选中的 Act 对象 (从 current.actions 找)。
  currentAction() {
    if (!state.current || state.action == null) return null;
    return (state.current.actions || []).find(a => a.action === state.action) || null;
  },
};
