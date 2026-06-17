#!/usr/bin/env python3
"""server.py — Sprite Studio 本地 Web 服务 (薄 HTTP 路由层, ARCHITECTURE.md §4)

只做: 路由 → 调 core → 序列化响应。二进制脏活全在 core/ + formats/。
左选角色→选动作; 主区上=原始序列横图(可导出)+下=原始GIF; 右=导入区(贴AI横图)+新GIF; 一键替换→打包。
起: .venv/bin/python server.py [角色根目录]  →  http://127.0.0.1:8773
"""
import io, json, os, sys, base64, shutil, threading, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional, Sequence
from urllib.parse import urlparse, parse_qs
from PIL import Image

from formats import dnf as fmt
from core.geometry import compute_geometry
from core import render, segment
from core import persist
from core.importer import import_action_grid, apply_adjust, foot_anchor_axis
from core.model import Action, Frame

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8773
OUT = os.path.join(HERE, 'out')

# ── DNF 补丁配置(集中一处, 均可环境变量覆盖)──────────────────────────────────────
# 独立项目 dnf-reskin-studio 的 server(from formats import dnf); 部署路径默认按 D:\dnf-reskin 布局。
DEFAULT_ROOT = sys.argv[1] if len(sys.argv) > 1 else \
    os.environ.get('DNF_WORK_ROOT', r'D:\dnf-reskin\work')             # 角色工作目录(扫这里列角色)
IMAGEPACKS2 = os.environ.get('DNF_IMAGEPACKS2',                        # 客户端 ImagePacks2: 部署目标 + 隐藏包枚举装备来源
                             r'E:\WeGameApps\地下城与勇士：创新世纪\ImagePacks2')
HIDE_SCRIPT = os.environ.get('DNF_HIDE_SCRIPT',                        # 隐藏时装包生成脚本(项目内 _win/)
                             os.path.join(HERE, '_win', 'make_hide_patch.py'))
# (KoishiEx CLI 路径在 formats/dnf.py 的 DNF_RESKIN_CLI)


def _backup_dir(name: str) -> str:
    return os.path.join(OUT, '_backup', name)


def _wip_dir(name: str) -> str:
    return os.path.join(OUT, '_wip', name)

# 静态资源 Content-Type
_CTYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.map': 'application/json',
}

STATE: dict[str, dict[str, Any]] = {}    # path -> {'project','geo','replace','replace_base','adjust','locked','stripmeta'}
LOCK = threading.Lock()

# 重活(隐藏包/部署/打包)串行闸: 同时只允许一个在跑。前端重复点击时, 第二次直接 409 "正在跑",
# 不再各起一条 HTTP 线程、各拉一个 dnf-reskin.exe 把机器叠死(三九遇到的"俩 CLI 一起跑"就是这病:
# 取消只断了前端连接, 后台 subprocess 照跑, 再点又起一个)。
_BUILD_LOCK = threading.Lock()


def _serialized(fn):
    """重活串行装饰器: 抢不到 _BUILD_LOCK(已有任务在跑)就抛 409, 而不是叠一个新任务。"""
    def wrap(*a: Any, **k: Any) -> Any:
        if not _BUILD_LOCK.acquire(blocking=False):
            raise ApiError('已有打包/部署任务在跑, 等它完成再点(别重复点击叠任务)', 'busy', 409)
        try:
            return fn(*a, **k)
        finally:
            _BUILD_LOCK.release()
    return wrap


class ApiError(Exception):
    """业务错误: 带 HTTP 状态码 + 机器码。"""
    def __init__(self, message: str, code: str = 'bad_request', status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


# ── 角色加载 / 几何 (调 core + fmt) ─────────────────────────────────────────
def open_char(path: Optional[str], flt: str = 'core') -> dict[str, Any]:
    if not path:
        raise ApiError('缺 path 参数', 'missing_param', 400)
    if not os.path.isdir(path):
        raise ApiError(f'目录不存在: {path}', 'not_found', 404)
    if not fmt.detect(path):
        raise ApiError(f'不是有效角色目录 (缺 Sprite.sff/Anim.air): {path}', 'not_found', 404)
    with LOCK:
        name = os.path.basename(path.rstrip('/'))
        sprite_path = fmt.sprite_file(path)
        bdir = _backup_dir(name)
        backed_up = persist.backup_sprite(sprite_path, bdir)          # M2: 首开即备份原版(已备跳过)
        # 原始帧恒从备份读 → 原始锚点常驻; M3 覆盖源后仍看真·原版(且不拿 v1 读器读覆盖后的 v2)
        src_sprite = persist.backup_path(sprite_path, bdir) if backed_up else None
        project = fmt.load(path, sprite_path=src_sprite)
        # 选动作: core 过滤白名单 or 全部
        if flt == 'core':
            want = [a for a in project.core_action_ids]
        else:
            want = [a for a, act in project.actions.items() if act.frames]
        # 几何: 所有出现帧的最大外延 (统一格/锚, 各动作同尺度)
        cells: list[tuple[int, int]] = []
        seen: set[tuple[int, int]] = set()
        for a in want:
            for k in project.actions[a].unique_cells():
                if k not in seen:
                    seen.add(k); cells.append(k)
        geo = compute_geometry(project.sprites, cells, maxcell=300)
        prev = STATE.get(path)
        if prev:                          # 同会话切走再切回: 用内存真相(已含草稿 + 本次编辑)
            replace = prev['replace']
            replace_base = prev.get('replace_base', {})
            adjust = prev.get('adjust', {})
            locked = prev.get('locked', set())
        else:                             # M1: 首开从草稿恢复已固定的替换帧
            draft_frames, locked = persist.load_draft(_wip_dir(name))
            replace = dict(draft_frames)
            replace_base = dict(draft_frames)         # 草稿帧作对齐基准(可继续微调)
            adjust = {}
        STATE[path] = {'project': project, 'geo': geo, 'replace': replace,
                       'replace_base': replace_base, 'adjust': adjust,
                       'locked': locked, 'stripmeta': {}}
        actions: list[dict[str, Any]] = []
        for a in want:
            act = project.actions[a]
            uq = [k for k in act.unique_cells() if project.sprites.get(*k)]
            if not uq:
                continue
            replaced = any(k in replace for k in uq)   # §4: 从 STATE 真相算
            actions.append({'action': a, 'name': act.name, 'count': len(uq),
                            'seq_len': len(act.frames), 'replaced': replaced,
                            'locked': a in locked})     # M1: 已固定生效(蓝点)
    return {'path': path, 'name': project.name, 'zh': fmt._zh_name(project.name),
            'cell_w': geo.cell_w, 'cell_h': geo.cell_h,
            'anchor': list(geo.anchor), 'backed_up': backed_up, 'actions': actions}


def _state(path: Optional[str]) -> dict[str, Any]:
    st = STATE.get(path) if path else None
    if not st:
        raise ApiError('角色未打开 (先调 /api/open)', 'not_open', 400)
    return st


def _action(st: dict[str, Any], action: int) -> Action:
    act = st['project'].actions.get(action)
    if not act:
        raise ApiError(f'动作 {action} 不存在', 'not_found', 404)
    return act


def _segments(st: dict[str, Any], action: int) -> list:
    """该动作的自动分段(按姿势跳变), 缓存在 state 里(首次解帧算一次)。"""
    cache = st.setdefault('segments', {})
    if action not in cache:
        cache[action] = segment.segment_action(st['project'].sprites, _action(st, action))
    return cache[action]


def _seg_action(st: dict[str, Any], action: int, seg: Optional[int]) -> Action:
    """seg 给定→返回该段的子 Action(几何沿用整动作保持对齐); 否则返回整动作。"""
    act = _action(st, action)
    if seg is None:
        return act
    segs = _segments(st, action)
    if seg < 1 or seg > len(segs):
        raise ApiError(f'段 {seg} 不存在 (该动作共 {len(segs)} 段)', 'not_found', 404)
    keyset = set(segs[seg - 1].keys)
    return Action(id=act.id, name=f'{act.name}#seg{seg}',
                  frames=[f for f in act.frames if (f[0], f[1]) in keyset])


def _geo_for(st: dict[str, Any], act: Action, seg: Optional[int]):
    """seg 给定→格子按本组外延收紧(缩放沿用整动作全局缩放, 角色同比例、能拼回);
       否则用整动作几何。收紧后小姿势组不再大片空白, 九宫格一屏放得下。"""
    if seg is None:
        return st['geo']
    return compute_geometry(st['project'].sprites, act.unique_cells(),
                            scale_override=st['geo'].scale)


def build_strip(path: Optional[str], action: int, kind: str = 'orig',
                bg: str = 'green', seg: Optional[int] = None) -> bytes:
    st = _state(path); act = _seg_action(st, action, seg)
    png, meta = render.build_action_grid(st['project'].sprites, act, _geo_for(st, act, seg), kind, st['replace'], bg=bg)
    st['stripmeta'][(action, seg) if seg is not None else action] = meta
    return png


def build_gif(path: Optional[str], action: int, kind: str = 'orig',
              seg: Optional[int] = None) -> bytes:
    st = _state(path); act = _seg_action(st, action, seg)
    return render.build_gif(st['project'].sprites, act, _geo_for(st, act, seg), kind, st['replace'])


def build_overlay(path: Optional[str], action: int, idx: int, seg: Optional[int] = None) -> bytes:
    """逐帧对齐叠图: 动作(或某组)第 idx 帧的 原帧ghost + 替换帧实色 (轴钉同锚点) → PNG。"""
    st = _state(path); act = _seg_action(st, action, seg)
    g, i = _cell_gi(st, action, idx, seg)
    return render.build_overlay(st['project'].sprites, st['replace'], _geo_for(st, act, seg), g, i)


def do_import(path: Optional[str], action: int, img: Image.Image,
              bg_key: Optional[Sequence[int]] = None, seg: Optional[int] = None) -> int:
    st = _state(path); act = _seg_action(st, action, seg)          # seg→只切该组那几帧的版面
    key = (action, seg) if seg is not None else action
    if key not in st['stripmeta']:                                 # 坑①: (action,seg)版面要"看过该组横图"才有, 没有现渲一次
        _, meta = render.build_action_grid(st['project'].sprites, act, _geo_for(st, act, seg), 'orig', st['replace'])
        st['stripmeta'][key] = meta
    meta = st['stripmeta'][key]                                    # 坑②: 几何走 _geo_for(act,seg), 与导出一致
    new = import_action_grid(img, meta, bg_key=bg_key, debug_dir=os.path.join(HERE, 'out', '_debug'))
    # ★脚底锚定 = 对齐的唯一权威。导入算出的轴绕了预览坐标系来回换算(漂 +6~12px, 三九实测), 弃用;
    # 直接拿【原版帧的 basePt(游戏内绝对坐标, 绿body验证过是对的)】重算: 新 pic 的底部中心(脚底接地点)
    # 对齐原版 pic 的底部中心。同尺寸角色→结果=原版 basePt 本身、零偏移; Q版矮角色→脚底照样落原位。
    # 预览也按这个轴渲染→预览=游戏(根治"前端坐标≠游戏坐标")。
    for (g, i) in list(new):
        orig = st['project'].sprites.get(g, i)
        if orig is None:
            continue
        # 先按部署口径硬化 alpha + 裁到最终内容框(LANCZOS 软边部署时会被硬化裁掉,
        # 用软边尺寸算轴偏 ~5px); 再用 foot_anchor_axis 拿原版 basePt 脚底重锚 = 对齐唯一口径。
        img2 = fmt._conform_to_dnf(new[(g, i)].img.convert('RGBA'))
        bb = img2.split()[-1].getbbox()
        if bb is not None:
            img2 = img2.crop(bb)
        axis = foot_anchor_axis(orig.size, orig.axis, img2.size)
        new[(g, i)] = Frame(g, i, img2, axis)
    st['replace'].update(new)              # 坑③: meta只含该组cells → new只含该组(g,i) → 只加不动别组
    st['replace_base'].update(new)        # 存导入原始(手动对齐基准, 可重置)
    for k in new:
        st['adjust'].pop(k, None)          # 新导入帧重置手动对齐
    return len(new)


def clear_action(path: Optional[str], action: int, seg: Optional[int] = None) -> None:
    st = _state(path); act = _seg_action(st, action, seg)        # seg→只还原该组那几帧
    project = st['project']
    # 别误删其它【仍固定】动作共享引用的帧(KOF 各动作常复用待机帧)
    protect: set[tuple[int, int]] = set()
    for aid in st['locked']:
        if aid == action:
            continue
        a = project.actions.get(aid)
        if a:
            protect.update(a.unique_cells())
    for k in act.unique_cells():
        if k in protect:
            continue
        st['replace'].pop(k, None)
        st['replace_base'].pop(k, None)
        st['adjust'].pop(k, None)
    if seg is None:              # 整动作还原才动 locked/草稿; 单组还原只清该组帧, 不解锁整动作
        was_locked = action in st['locked']
        st['locked'].discard(action)
        if was_locked:
            _save_draft(st)      # 固定过的动作被还原 → 重写草稿(移除其专属帧)


def _save_draft(st: dict[str, Any]) -> None:
    """把当前所有【已固定】动作引用且仍在 replace 里的帧落盘草稿(全量重写, 幂等)。"""
    project = st['project']
    frames: dict[tuple[int, int], Frame] = {}
    for aid in st['locked']:
        a = project.actions.get(aid)
        if not a:
            continue
        for k in a.unique_cells():
            fr = st['replace'].get(k)
            if fr is not None:
                frames[k] = fr
    persist.save_draft(_wip_dir(project.name), frames, st['locked'])


def lock_action(path: Optional[str], action: int) -> dict[str, Any]:
    """M1 固定生效: 把该动作的替换帧持久化到草稿, 标记已固定(蓝点)。重启/切角色不丢。"""
    st = _state(path); act = _action(st, action)
    if not any(k in st['replace'] for k in act.unique_cells()):
        raise ApiError('该动作还没替换帧, 无法固定生效', 'not_replaced', 400)
    st['locked'].add(action)
    _save_draft(st)
    return {'locked': sorted(st['locked'])}


def _cell_gi(st: dict[str, Any], action: int, idx: int, seg: Optional[int] = None) -> tuple[int, int]:
    """动作(或某组)第 idx 帧 → (g,i)。从 (action,seg) 版面取(没有则先建)。idx 相对该组。"""
    key = (action, seg) if seg is not None else action
    if key not in st['stripmeta']:
        act = _seg_action(st, action, seg)
        _, meta = render.build_action_grid(st['project'].sprites, act, _geo_for(st, act, seg), 'orig', st['replace'])
        st['stripmeta'][key] = meta
    cells = st['stripmeta'][key]['cells']
    if not (0 <= idx < len(cells)):
        raise ApiError(f'帧序号 {idx} 越界 (共 {len(cells)} 帧)', 'bad_param', 400)
    return cells[idx]['g'], cells[idx]['i']


def adjust_frame(path: Optional[str], action: int, idx: int,
                 scale: float, dx: int, dy: int, seg: Optional[int] = None) -> dict[str, Any]:
    """手动对齐: 调动作第 idx 帧的缩放 scale + 位移 dx/dy。从导入原始帧算, 存 adjust 可反复调。"""
    st = _state(path); _seg_action(st, action, seg)
    g, i = _cell_gi(st, action, idx, seg)
    base = st['replace_base'].get((g, i))
    if base is None:
        raise ApiError('该帧还没导入替换 (先拖图导入)', 'not_replaced', 400)
    st['adjust'][(g, i)] = {'scale': scale, 'dx': dx, 'dy': dy}
    st['replace'][(g, i)] = apply_adjust(base, scale, dx, dy)
    return {'g': g, 'i': i, 'scale': scale, 'dx': dx, 'dy': dy}


def reset_frame(path: Optional[str], action: int, idx: int, seg: Optional[int] = None) -> None:
    """重置某帧手动对齐 → 回到导入原始。"""
    st = _state(path); _seg_action(st, action, seg)
    g, i = _cell_gi(st, action, idx, seg)
    st['adjust'].pop((g, i), None)
    base = st['replace_base'].get((g, i))
    if base is not None:
        st['replace'][(g, i)] = base


def do_pack(path: Optional[str], name: Optional[str], full: bool = True) -> dict[str, Any]:
    from core.pack import pack
    st = _state(path)
    if not name:
        raise ApiError('缺打包名', 'missing_param', 400)
    out_dir = os.path.join(OUT, name)
    return pack(fmt, st['project'], st['replace'], out_dir, full=full)


def _char_class(project: Any) -> str:
    """从角色内部 IMG 路径 sprite/character/<职业>/… 推职业(隐藏包/部署用)。"""
    try:
        with open(os.path.join(project.source_dir, '_frames', 'manifest.json'), encoding='utf-8') as f:
            frs = json.load(f).get('frames') or []
        parts = ((frs[0].get('img_name', '') if frs else '').replace('_2F', '/').replace('_2E', '.')).split('/')
        if 'character' in parts:
            return parts[parts.index('character') + 1]
    except Exception:
        pass
    raise ApiError('推不出职业(看角色内部 IMG 路径 sprite/character/<职业>/…)', 'no_class', 400)


def _require_imagepacks() -> None:
    if not os.path.isdir(IMAGEPACKS2):
        raise ApiError(f'找不到 ImagePacks2 目录: {IMAGEPACKS2}(设环境变量 DNF_IMAGEPACKS2)', 'no_imagepacks', 400)


@_serialized
def make_hide_patch(path: Optional[str]) -> dict[str, Any]:
    """生成"隐藏该职业全部时装"的覆盖 NPK 并【直接放进游戏 ImagePacks2】(隐藏包独立于本体重绘, 生成即部署)。
    枚举该职业装备 avatar 全置空透明 → out/%27_<职业>_hide.NPK + 复制进 ImagePacks2。装备隐藏后本体 skin 才露得出来。
    引擎已是 O(n)(~4s), 所以每次都老老实实重新生成 —— 不搞幂等复用, 按钮就是字面意思: 点一下 = 重做一份。"""
    st = _state(path); cls = _char_class(st['project'])
    _require_imagepacks()
    out_npk = os.path.join(OUT, f'%27_{cls}_hide.NPK')                 # 先生成到 out/(留底)
    r = subprocess.run([sys.executable, HIDE_SCRIPT, cls, IMAGEPACKS2, out_npk],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0 or not os.path.isfile(out_npk):
        raise ApiError(f'生成隐藏包失败: {((r.stderr or r.stdout) or "")[-200:]}', 'hide_failed', 500)
    game_dst = os.path.join(IMAGEPACKS2, f'%27_{cls}_hide.NPK')        # 直接丢进游戏(% 覆盖, 只新增不碰原文件)
    shutil.copy2(out_npk, game_dst)
    return {'cls': cls, 'out': out_npk, 'deployed': os.path.basename(game_dst),
            'size_mb': round(os.path.getsize(out_npk) / 1048576, 2)}


def _skeleton_variants(project: Any, g0: int) -> list[int]:
    """与代表 IMG g0 逐帧几何(size+axis)完全一致的所有 IMG = 同一副骨架的皮肤变体(含 g0)。
    DNF 身体 skin 有几十个 ft_body 变体: 几何相同、像素不同, 游戏按肤色/动画渲染不同的那个。
    core 去重只露一个代表给用户编辑(省得一堆雷同的刷屏), 但部署必须把重绘复制到全部变体 ——
    否则游戏渲染到没改的变体就看不到补丁(三九踩的实坑: 39 个 ft_body 只改了 ft_body0000)。"""
    from collections import defaultdict
    by_g: dict[int, dict[int, tuple]] = defaultdict(dict)
    for (g, i), fr in project.sprites.frames.items():
        by_g[g][i] = (tuple(fr.size), tuple(fr.axis))
    def sig(g: int) -> tuple:
        return tuple(by_g[g][i] for i in sorted(by_g[g]))
    if g0 not in by_g:
        return [g0]
    s0 = sig(g0)
    return [g for g in by_g if sig(g) == s0]


def _expand_replace_to_variants(project: Any, replace: dict) -> dict:
    """把对代表 IMG 的重绘帧, 复制到所有同骨架皮肤变体 IMG(几何一致 → 同图同轴直接套用)。
    这样无论游戏渲染哪个变体都能看到补丁。返回扩展后的 replace(不改原 dict)。"""
    out = dict(replace)
    cols: dict[int, list] = {}
    for (g, i), fr in replace.items():
        cols.setdefault(g, []).append((i, fr))
    for g0, frs in cols.items():
        for g in _skeleton_variants(project, g0):
            if g == g0:
                continue
            for i, fr in frs:
                out[(g, i)] = Frame(g, i, fr.img, fr.axis)
    return out


@_serialized
def deploy_to_game(path: Optional[str]) -> dict[str, Any]:
    """一键部署到游戏: 打包本体(替换帧+原版帧) + 把本体包和隐藏包(若已生成)都改 % 名直接丢进 ImagePacks2
    (% 排最前 → 覆盖原版加载)。只【新增】% 覆盖文件, 绝不动客户端原文件。重启游戏即生效。"""
    from core.pack import pack
    st = _state(path); project = st['project']
    cls = _char_class(project)
    _require_imagepacks()
    if not st['replace']:
        raise ApiError('还没换任何帧, 先导入替换再部署', 'nothing_to_deploy', 400)
    out_dir = os.path.join(OUT, '_deploy', project.name)              # 打包本体到中转目录
    # 把重绘复制到全部同骨架皮肤变体(39 个 ft_body), 游戏渲染哪个变体都能看到补丁(见 _expand_...)。
    full_replace = _expand_replace_to_variants(project, st['replace'])
    # verify=False: 跳过回读自检 —— DNF 本体几千帧, 自检要把整包解一遍(~36s)+逐张读, 是部署慢的大头。
    # 重封(repack)本身已可靠, 部署效果用户在游戏里眼验, 不值这一两分钟。破坏性的"装回原目录"仍保留自检。
    res = pack(fmt, project, full_replace, out_dir, full=True, verify=False)
    cands = [os.path.join(out_dir, f) for f in os.listdir(out_dir)
             if f.lower().endswith(('.npk', '.sff')) and os.path.isfile(os.path.join(out_dir, f))]
    if not cands:
        raise ApiError('打包没产出 NPK', 'pack_no_out', 500)
    deployed = []
    body_dst = os.path.join(IMAGEPACKS2, f'%27_{cls}_skin_reskin.NPK')  # % 开头覆盖本体 skin
    shutil.copy2(cands[0], body_dst); deployed.append(os.path.basename(body_dst))
    hide_src = os.path.join(OUT, f'%27_{cls}_hide.NPK')               # 隐藏包若已生成, 一并部署
    if os.path.isfile(hide_src):
        hide_dst = os.path.join(IMAGEPACKS2, f'%27_{cls}_hide.NPK')
        shutil.copy2(hide_src, hide_dst); deployed.append(os.path.basename(hide_dst))
    return {'cls': cls, 'replaced': res.get('replaced'), 'deployed': deployed,
            'hide_included': any('hide' in d for d in deployed), 'dir': IMAGEPACKS2}


def restore_original(path: Optional[str]) -> dict[str, Any]:
    """M2 一键还原: 用备份库的原始精灵覆盖回角色原目录。游戏重新加载即回原版。"""
    st = _state(path); project = st['project']
    sprite_path = fmt.sprite_file(project.source_dir)
    if not persist.restore_sprite(_backup_dir(project.name), sprite_path):
        raise ApiError('没有原版备份(打开角色时才会备份)', 'no_backup', 400)
    return {'restored': sprite_path}


def apply_to_game(path: Optional[str]) -> dict[str, Any]:
    """M3 装回原目录: 打包(替换帧 + 未替换原帧)全量 SFF → 覆盖回角色原目录的精灵文件。
    破坏性 —— 靠 M2 备份兜底(无备份拒绝覆盖)。换过的动作显示新图、其余原版。"""
    from core.pack import pack
    st = _state(path); project = st['project']
    sprite_path = fmt.sprite_file(project.source_dir)
    if not os.path.isfile(persist.backup_path(sprite_path, _backup_dir(project.name))):
        raise ApiError('没有原版备份, 拒绝覆盖原目录(先重开角色触发备份)', 'no_backup', 400)
    out_dir = os.path.join(OUT, '_apply', project.name)
    res = pack(fmt, project, st['replace'], out_dir, full=True)      # 含回读自检
    packed = os.path.join(out_dir, os.path.basename(sprite_path))
    persist.place_sprite(packed, sprite_path)                        # 覆盖回原目录
    return {'overwritten': sprite_path, 'replaced': res['replaced'], 'size_mb': res['size_mb']}


# ── HTTP 路由层 ─────────────────────────────────────────────────────────────
class H(BaseHTTPRequestHandler):
    def _send(self, code: int, body: Any, ctype: str = 'application/json') -> None:
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, e: Exception) -> None:
        """统一错误响应: 正确状态码 + {error, code} (二进制接口失败也走这, 前端据 Content-Type 区分)。"""
        if isinstance(e, ApiError):
            self._send(e.status, {'error': e.message, 'code': e.code})
        else:
            self._send(500, {'error': str(e), 'code': 'internal'})

    def log_message(self, *a: Any) -> None:
        pass

    def do_GET(self) -> None:
        u = urlparse(self.path); q = parse_qs(u.query)
        g1 = lambda k, d=None: q.get(k, [d])[0]
        try:
            if u.path == '/api/chars':
                root = g1('root', DEFAULT_ROOT)
                return self._send(200, {'root': root, 'chars': fmt.list_chars(root)})
            if u.path == '/api/open':
                return self._send(200, open_char(g1('path'), g1('filter', 'core')))
            if u.path == '/api/strip':
                action = self._int(g1('action'), 'action')
                return self._send(200, build_strip(g1('path'), action, g1('kind', 'orig'), g1('bg', 'green'), self._seg(g1('seg'))), 'image/png')
            if u.path == '/api/segments':
                action = self._int(g1('action'), 'action')
                segs = _segments(_state(g1('path')), action)
                return self._send(200, {'action': action, 'segments': [
                    {'index': s.index, 'start': s.start, 'end': s.end, 'count': len(s.keys)} for s in segs]})
            if u.path == '/api/gif':
                action = self._int(g1('action'), 'action')
                return self._send(200, build_gif(g1('path'), action, g1('kind', 'orig'), self._seg(g1('seg'))), 'image/gif')
            if u.path == '/api/overlay':
                action = self._int(g1('action'), 'action')
                idx = self._int(g1('idx'), 'idx')
                return self._send(200, build_overlay(g1('path'), action, idx, self._seg(g1('seg'))), 'image/png')
        except ApiError as e:
            return self._err(e)
        except Exception as e:
            return self._err(e)
        # 静态资源 (web/ 含 js/ 子目录)
        return self._static(u.path)

    def do_POST(self) -> None:
        u = urlparse(self.path)
        try:
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}'
            data = json.loads(raw)
        except Exception:
            return self._err(ApiError('请求体非合法 JSON', 'bad_json', 400))
        try:
            if u.path == '/api/import':
                path = data.get('path'); action = self._int(data.get('action'), 'action')
                img_data = data.get('image')
                if not img_data:
                    raise ApiError('缺 image (dataURL)', 'missing_param', 400)
                try:
                    rawimg = base64.b64decode(img_data.split(',')[-1])
                    img = Image.open(io.BytesIO(rawimg))
                except Exception:
                    raise ApiError('image 解码失败 (非合法图片)', 'bad_image', 400)
                n = do_import(path, action, img, data.get('bg_key'), self._seg(data.get('seg')))
                return self._send(200, {'ok': True, 'replaced': n})
            if u.path == '/api/clear_action':
                clear_action(data.get('path'), self._int(data.get('action'), 'action'), self._seg(data.get('seg')))
                return self._send(200, {'ok': True})
            if u.path == '/api/adjust':
                res = adjust_frame(data.get('path'), self._int(data.get('action'), 'action'),
                                   self._int(data.get('idx'), 'idx'),
                                   float(data.get('scale', 1.0)), int(data.get('dx', 0)), int(data.get('dy', 0)),
                                   self._seg(data.get('seg')))
                return self._send(200, {'ok': True, **res})
            if u.path == '/api/reset_frame':
                reset_frame(data.get('path'), self._int(data.get('action'), 'action'),
                            self._int(data.get('idx'), 'idx'), self._seg(data.get('seg')))
                return self._send(200, {'ok': True})
            if u.path == '/api/pack':
                res = do_pack(data.get('path'), data.get('name'), data.get('full', True))
                return self._send(200, {'ok': True, **res})
            if u.path == '/api/hide_patch':
                return self._send(200, {'ok': True, **make_hide_patch(data.get('path'))})
            if u.path == '/api/deploy_game':
                return self._send(200, {'ok': True, **deploy_to_game(data.get('path'))})
            if u.path == '/api/lock':
                res = lock_action(data.get('path'), self._int(data.get('action'), 'action'))
                return self._send(200, {'ok': True, **res})
            if u.path == '/api/restore':
                return self._send(200, {'ok': True, **restore_original(data.get('path'))})
            if u.path == '/api/apply':
                return self._send(200, {'ok': True, **apply_to_game(data.get('path'))})
        except ApiError as e:
            return self._err(e)
        except Exception as e:
            return self._err(e)
        return self._send(404, {'error': 'not found', 'code': 'not_found'})

    def _int(self, v: Any, name: str) -> int:
        try:
            return int(v)
        except (TypeError, ValueError):
            raise ApiError(f'参数 {name} 需为整数', 'bad_param', 400)

    def _seg(self, v: Any) -> Optional[int]:
        """可选 seg(组号): 空/缺 → None(整动作); 否则转 int。"""
        if v in (None, ''):
            return None
        return self._int(v, 'seg')

    def _static(self, path: str) -> None:
        rel = path.lstrip('/')
        if rel in ('', 'index.html'):
            rel = 'index.html'
        # 防目录穿越 (commonpath 比 startswith 严谨, 排除 web2/ 这类同前缀)
        webroot = os.path.realpath(os.path.join(HERE, 'web'))
        full = os.path.realpath(os.path.join(webroot, rel))
        if os.path.commonpath([webroot, full]) != webroot or not os.path.isfile(full):
            return self._send(404, {'error': f'未找到: {path}', 'code': 'not_found'})
        ext = os.path.splitext(full)[1].lower()
        ctype = _CTYPES.get(ext, 'application/octet-stream')
        with open(full, 'rb') as f:
            self._send(200, f.read(), ctype)


if __name__ == '__main__':
    print(f"Sprite Studio  →  http://127.0.0.1:{PORT}\n扫描根目录: {DEFAULT_ROOT}")
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
