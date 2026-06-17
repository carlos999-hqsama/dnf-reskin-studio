"""formats/dnf.py — DNF (地下城与勇士) NPK/IMG 格式层 (CONTRACT.md 的 7 契约函数)

把 DNF 的 NPK/IMG 二进制硬活委托给编译好的 KoishiEx CLI (dnf-reskin.exe),
PNG + offset(manifest.json) 当交换格式。core/ 和 web/ 一行不改。
语言边界 = 进程边界: 只 subprocess 调 exe, 不写 C 扩展 / FFI。

模型映射 (DNF → AFA core.model):
  - 补丁单位 = 一个工作目录, 内含一个目标 .NPK (从 ImagePacks2 拷出, 客户端原文件不碰)。
  - Frame.group = IMG 序号 (img_index)，Frame.image = IMG 内帧序号 (frame_index)。
  - Frame.img   = 该帧 pic 的原生像素 PNG (RGBA)，Frame.axis = (offset_x, offset_y) = DNF basePt。
  - 每个 IMG → 一个 Action(id=img_index, name=内部虚拟路径, frames=该 IMG 帧序列)。
  - canvas(frame_width/height)、像素格式、linked/link_to 等 DNF 专属元数据【不进】AFA 模型,
    由本模块用 manifest 缓存维护: load 时缓存, write 时回填给 CLI repack。
    (DNF 帧时序/判定在 .ani 里 —— 全程不读不写, 天然保住。)

⚠️ write() 的上下文问题: AFA 契约的 write(frames, out_path) 不带源 NPK 引用, 但 DNF 回封
   必须要原 NPK 当模板 + 每帧 canvas/格式。本地工具同时只编辑一个角色, 故用模块级
   _ACTIVE 指向最近 load 的角色, write 取其缓存。多角色并发不支持 (本地单用户工具够用)。
"""
from __future__ import annotations
import glob
import json
import os
import shutil
import subprocess
from collections import OrderedDict
from typing import Any, Dict, Iterable, List, Optional, Tuple
from PIL import Image

from core.model import Frame, SpriteSet, Action, Project

# 编译好的 KoishiEx CLI (Windows)。可用环境变量覆盖。
DNF_CLI = os.environ.get(
    'DNF_RESKIN_CLI',
    r'D:\dnf-reskin\OPENCODE\build\Release\dnf-reskin.exe',
)
_DEFAULT_DUR = 6   # DNF 帧时序在 .ani 里(不读), 工具内 GIF 预览用固定时长占位

# 职业代号 → 中文名(列角色/显示用; 目录名/文件名仍用代号, 游戏与 CLI 按代号匹配, 不能改成中文路径)。
CLASS_ZH = {
    'swordman': '鬼剑士', 'fighter': '格斗家', 'gunner': '神枪手', 'mage': '魔法师',
    'priest': '圣职者', 'thief': '盗贼', 'knight': '守护者', 'archer': '弓箭手',
    'demoniclancer': '暗枪士', 'gunblader': '枪剑士', 'imperialknight': '帝国守卫',
}


def _zh_name(dirname: str) -> str:
    """工作目录名(如 swordman_skin)→ 中文名(按职业代号前缀匹配); 认不出就原样返回目录名。"""
    low = dirname.lower()
    for code, zh in CLASS_ZH.items():
        if low.startswith(code):
            return zh
    return dirname

# ── manifest 缓存: load 记下源 NPK + 每帧 DNF 元数据, write 回填 ───────────────
# key = 规范化 char_dir; value = {'npk':源NPK绝对路径, 'frames':{(g,i):meta dict},
#                                 'frames_dir':解帧目录}
_CACHE: Dict[str, Dict[str, Any]] = {}
_ACTIVE: Optional[str] = None   # 最近 load 的 char_dir (write 取它的缓存)


# ── 内部工具 ──────────────────────────────────────────────────────────────────
def _norm(p: str) -> str:
    return os.path.normcase(os.path.abspath(p))


def _find_npk(char_dir: str) -> Optional[str]:
    """工作目录里的目标源 NPK = 从 ImagePacks2 拷出来、要补丁的那一个原版。
       必须排除我们自己产生的杂项, 否则会被当成源底图导致重绘叠错底 —— 三九踩过实坑:
       work 目录里混进了 %27_..._skin_reskin / %27_GREEN_... / repacked.NPK, 而本函数按文件名
       排序取第一个, '%'(0x25)排在字母前 → 一直把绿色测试 body 当底图。
       排除: 回封中间件(_repack/.stage)、部署输出(% 开头)、测试件(repacked/_GREEN)。"""
    def _is_artifact(name: str) -> bool:
        n = name.lower()
        return (n.startswith('%') or n.startswith('repacked')
                or '_repack' in n or '.stage' in n or '_green' in n)
    cands = sorted(
        f for f in glob.glob(os.path.join(char_dir, '*.[Nn][Pp][Kk]'))
        if not _is_artifact(os.path.basename(f))
    )
    return cands[0] if cands else None


def _run_cli(*args: str) -> str:
    """调 dnf-reskin.exe, 失败抛 RuntimeError(带 stderr)。返回 stdout。"""
    if not os.path.isfile(DNF_CLI):
        raise FileNotFoundError(f"找不到 DNF CLI: {DNF_CLI} (设环境变量 DNF_RESKIN_CLI 覆盖)")
    r = subprocess.run([DNF_CLI, *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError(f"dnf-reskin {args[0]} 失败 (exit {r.returncode}):\n{r.stderr or r.stdout}")
    return r.stdout


def _read_manifest(frames_dir: str) -> dict:
    with open(os.path.join(frames_dir, 'manifest.json'), encoding='utf-8') as f:
        return json.load(f)


def _pretty(img_name: str) -> str:
    """sanitized 内部路径 → 易读动作名 (UI 用)。CLI 把 '/'→'_2F'、'.'→'_2E' 转义,
       这里还原后取 basename 去 .img。例: sprite_2F..._2Fgrounddodge_2Eimg → grounddodge。
       (完整内部路径仍存在 manifest 缓存里, 部署时用。)"""
    s = img_name.replace('_2F', '/').replace('_2E', '.')
    base = s.rsplit('/', 1)[-1]
    if base.lower().endswith('.img'):
        base = base[:-4]
    return base or img_name


def _core_action_ids(cache_frames: "OrderedDict[Tuple[int, int], dict]") -> List[int]:
    """挑出"本体"动作, 把无关皮肤排除在默认(core)视图外。

    DNF 的 avatar skin NPK 里, 大量 IMG 是【同一副骨架】的皮肤变体 —— 逐帧的
    尺寸/偏移完全一致(只是像素不同); 另有少量【特殊皮肤】(天使带翅膀、披风、女仆…)
    几何各异。按"逐帧几何签名"聚类: 若存在一个明显占优的簇(≥次大簇 2 倍), 它就是
    本体骨架 → 只它算 core, 其余特殊皮肤不进默认视图(仍可 filter=all 看全部)。
    若各动作几何本就各不相同(如 grappler 这种真·多动作角色, 每簇都=1)→ 不误伤, 全算 core。
    """
    from collections import defaultdict
    by_g: Dict[int, List[dict]] = defaultdict(list)
    for (g, _i), fr in cache_frames.items():
        by_g[g].append(fr)

    def sig(frs: List[dict]) -> Tuple:
        frs = sorted(frs, key=lambda f: int(f['frame_index']))
        return tuple((int(f.get('pic_width', 0)), int(f.get('pic_height', 0)),
                      int(f.get('offset_x', 0)), int(f.get('offset_y', 0))) for f in frs)

    clusters: Dict[Tuple, List[int]] = defaultdict(list)
    for g, frs in by_g.items():
        clusters[sig(frs)].append(g)
    sizes = sorted((len(ids) for ids in clusters.values()), reverse=True)
    biggest = max(clusters.values(), key=len)
    # 占优簇里那一堆是【同一副骨架】的皮肤变体, 对补丁等价(部署时 _expand_replace_to_variants
    # 会按相同几何自动铺到全部变体) —— 默认只露一个代表本体, 不让一堆雷同的刷屏; 其余皮肤靠 filter=all 看。
    #   · 多簇: 最大簇 ≥ 次大簇 2 倍 = 有明显占优本体 + 杂皮肤。
    #   · 单簇且 ≥2 个 IMG: 只有一种几何 = 全是同骨架皮肤变体(如帝国守卫 2 个 ik_body), 同样收成 1 代表。
    if len(biggest) >= 2 and (len(sizes) == 1 or sizes[0] >= 2 * sizes[1]):
        return [sorted(biggest)[0]]
    return sorted(by_g.keys())                          # 无占优簇(如真·多动作角色): 全部算 core, 不误伤


class _LazyFrame:
    """惰性帧: 鸭子类型兼容 core.Frame(.group/.image/.img/.axis/.size)。

    要害: open 一个角色时, 通用层只用 .size/.axis 算几何(compute_geometry), 【不碰像素】;
    真正要像素是在某个动作被渲染成横图时(build_strip)。本类把 .size/.axis 从 manifest
    直出(零解码), 仅当 .img 首次被访问才解 PNG → 真·RGBA PIL 图(渲染/打包都能直接用,
    因为是真 Image 实例, alpha_composite 等不挑)。这样 open 从"解 5304 帧 ~35s"降到秒级。
    """
    __slots__ = ('group', 'image', 'axis', '_path', '_size', '_img', '_npk', '_fdir')

    def __init__(self, group: int, image: int, path: str,
                 size: Tuple[int, int], axis: Tuple[int, int],
                 npk: str, fdir: str) -> None:
        self.group = group
        self.image = image
        self.axis = axis
        self._path = path
        self._size = size
        self._img: Optional[Image.Image] = None
        self._npk = npk        # 源 NPK 绝对路径, 给按需解码用
        self._fdir = fdir      # 解帧目录

    @property
    def size(self) -> Tuple[int, int]:
        return self._size              # manifest 直出, 不解码

    @property
    def img(self) -> Image.Image:
        if self._img is None:
            if not os.path.isfile(self._path):     # --meta 打开没解像素 → 现解这个 IMG 的所有帧(秒级)
                _run_cli('unpack', self._npk, '-o', self._fdir, '--img', str(self.group))
            with Image.open(self._path) as im:     # with → 解完即关句柄, 不泄漏
                self._img = im.convert('RGBA')
        return self._img

    @img.setter
    def img(self, value: Image.Image) -> None:
        self._img = value


# ── AI 全彩图 → DNF 像素化 ─────────────────────────────────────────────────────
# 实扒客户端原版定的画风(别瞎猜): DNF 是【高色数 + 硬边(无抗锯齿)+ 多色做细腻渐变】的精细像素画
# (详细角色 200-310 色; 裸体本体 skin 才 10-11 色因只是皮肤)。所以转换【只硬化边、不砍色】:
#   - alpha 二值化 → 硬边(DNF 是 1 位 alpha, 没有半透明软边); 这是"像 AI"和"像 DNF"的关键区别。
#   - RGB/配色原样保留(DNF 本就高色数, 砍成低彩=廉价复古, 错)。
# 回封时该 IMG 颜色≤256 自动留 V4(原格式, 真机最稳)、超了自动落 V2 全彩(DNF 特效原生就是 V2)——见 repack.cpp。
def _conform_to_dnf(img_rgba: Image.Image, alpha_threshold: int = 128) -> Image.Image:
    """AI 全彩软边图 → DNF 像素: alpha 二值化(硬边), 颜色不动。半透明像素 ≥阈值算实心、否则透明。"""
    a = img_rgba.getchannel('A').point(lambda v: 255 if v >= alpha_threshold else 0)
    out = img_rgba.convert('RGBA')
    out.putalpha(a)
    return out


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  对外契约 7 函数 (formats/CONTRACT.md)                                      ║
# ╚══════════════════════════════════════════════════════════════════════════╝

def detect(char_dir: str) -> bool:
    """这个目录是不是一个 DNF 补丁单位? (含一个目标 .NPK)。"""
    return os.path.isdir(char_dir) and _find_npk(char_dir) is not None


def list_chars(root: str) -> List[dict]:
    """扫 root 下每个含 .NPK 的子目录 → [{'path','name'}], 按 name 排序。"""
    out: List[dict] = []
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        if name.startswith('_'):                 # _stash / _scratch 等内部目录不算角色
            continue
        d = os.path.join(root, name)
        if os.path.isdir(d) and _find_npk(d):
            out.append({'path': d, 'name': name, 'zh': _zh_name(name)})
    return sorted(out, key=lambda c: c['name'])


def load(char_dir: str, sprite_path: Optional[str] = None) -> Project:
    """读一个 DNF 补丁单位 → Project。调 CLI unpack 把 NPK 解成逐帧 PNG + manifest,
       建 SpriteSet(每帧) + Actions(每 IMG 一个) + core_action_ids(全部 IMG)。
       sprite_path: 可选, 指定源 NPK (默认目录里的)。"""
    global _ACTIVE
    npk = sprite_path or _find_npk(char_dir)
    if not npk:
        raise FileNotFoundError(f"{char_dir} 里没有目标 NPK")
    frames_dir = os.path.join(char_dir, '_frames')
    os.makedirs(frames_dir, exist_ok=True)
    # 跳过冗余解包: _frames 的 manifest 不比源 NPK 旧就直接复用(首次 / NPK 更新过才解)。
    mpath = os.path.join(frames_dir, 'manifest.json')
    fresh = os.path.isfile(mpath) and os.path.getmtime(mpath) >= os.path.getmtime(npk)
    if not fresh:
        # --meta: 只解元数据(秒开 + 不触发大包解码崩溃)。像素按需解(见 _LazyFrame.img 按 IMG 现解)。
        _run_cli('unpack', npk, '-o', frames_dir, '--meta')
    mani = _read_manifest(frames_dir)

    sprites = SpriteSet()
    cache_frames: "OrderedDict[Tuple[int, int], dict]" = OrderedDict()
    by_img: "OrderedDict[int, List[Tuple[int, int, int, int, int]]]" = OrderedDict()
    img_names: Dict[int, str] = {}

    for fr in mani['frames']:
        g, i = int(fr['img_index']), int(fr['frame_index'])
        cache_frames[(g, i)] = fr
        img_names.setdefault(g, fr.get('img_name', f'img{g}'))
        by_img.setdefault(g, []).append((g, i, 0, 0, _DEFAULT_DUR))
        if fr.get('linked'):
            continue  # 链接帧无 PNG: 不建可编辑 Frame, repack 时按 manifest 原样保留
        # 惰性帧: 不在此解码(几何只需 size/axis, 都在 manifest); 像素等渲染时才解。
        sprites[(g, i)] = _LazyFrame(  # type: ignore[assignment]  # 鸭子兼容 core.Frame
            g, i, os.path.join(frames_dir, fr['file']),
            (int(fr['pic_width']), int(fr['pic_height'])),
            (int(fr['offset_x']), int(fr['offset_y'])),
            os.path.abspath(npk), frames_dir)

    actions: Dict[int, Action] = {}
    for g, seq in by_img.items():
        actions[g] = Action(id=g, name=_pretty(img_names.get(g, f'img{g}')), frames=seq)
    core_ids = _core_action_ids(cache_frames)   # 只留"本体"骨架, 无关特殊皮肤排除在默认视图外

    _CACHE[_norm(char_dir)] = {'npk': os.path.abspath(npk),
                               'frames': cache_frames, 'frames_dir': frames_dir}
    _ACTIVE = _norm(char_dir)
    return Project(name=os.path.basename(char_dir.rstrip('/\\')), source_dir=char_dir,
                   sprites=sprites, actions=actions, core_action_ids=core_ids)


def write(frames: Iterable[Frame], out_path: str) -> int:
    """把若干 Frame 回封成 DNF NPK(写到 out_path), 返回字节数。
       靠最近 load 的 manifest 缓存补齐 canvas/格式/linked + 源 NPK 模板, 调 CLI repack。
       对齐(offset/axis)由 core/ 算好后通过 Frame.axis 传进来, 本函数原样写回。"""
    if _ACTIVE is None or _ACTIVE not in _CACHE:
        raise RuntimeError("write 前必须先 load 一个 DNF 角色 (manifest 缓存为空)")
    ctx = _CACHE[_ACTIVE]
    by_key = {(f.group, f.image): f for f in frames}

    stage = out_path + '.stage'
    fr_dir = os.path.join(stage, 'frames')
    if os.path.isdir(stage):
        shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(fr_dir, exist_ok=True)

    out_frames: List[dict] = []
    for (g, i), meta in ctx['frames'].items():
        m = dict(meta)   # 浅拷贝原 manifest 条目, 保留 canvas/format/linked/link_to 等
        if not m.get('linked'):
            fr = by_key.get((g, i))
            if fr is not None and not isinstance(fr, _LazyFrame):
                # 真·替换帧(reskin, core.model.Frame)才硬化+编码。轴用 core 算好的(脚底锚定)。
                out_img = _conform_to_dnf(fr.img.convert('RGBA'))   # 硬边化(留色), 见 _conform_to_dnf
                out_img.save(os.path.join(fr_dir, m['file']))
                m['offset_x'], m['offset_y'] = int(fr.axis[0]), int(fr.axis[1])
                # 回填新精灵真实尺寸: 原 m 沿用原版 pic 尺寸(陈旧), 与实际存的 PNG 不符 → 回填保持一致。
                m['pic_width'], m['pic_height'] = out_img.size
            else:
                # 未替换的原版帧(_LazyFrame 或没给): 标 linked → repack 从源 NPK 原样保留。
                # ① 不碰 fr.img → 不触发按需解码(配合 --meta 打开, 不把整身体几千帧全解一遍)
                # ② repack 只重编改过的帧 → 部署大提速(原来全身重编)。源 NPK = ctx['npk'], repack 会加载。
                m['linked'] = True
        out_frames.append(m)

    manifest = {'source_npk': ctx['npk'], 'export_time': '', 'frames': out_frames}
    mpath = os.path.join(stage, 'manifest.json')
    with open(mpath, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False)

    _run_cli('repack', mpath, '-i', fr_dir, '-o', out_path)
    return os.path.getsize(out_path)


def sprite_file(char_dir: str) -> str:
    """游戏(经我们)实际加载的精灵文件 = 工作目录里的目标 NPK。
       M2 备份 / M3 定位靠它。⚠️ DNF 真机部署走「覆盖 NPK」机制(新 NPK 丢进
       ImagePacks2、引擎按内部路径覆盖原版, 原文件不碰), 与 MUGEN 的原地覆盖不同,
       由部署步骤单独处理, 不经 persist.place_sprite。"""
    return _find_npk(char_dir) or os.path.join(char_dir, 'target.NPK')


def copy_support_files(src_dir: str, out_dir: str) -> List[str]:
    """DNF 的补丁单位就是自包含的 NPK, 工作目录里没有需要随包拷贝的支撑文件
       (.ani 在客户端别处、全程不动)。返回空清单。"""
    return []


def verify(out_path: str) -> SpriteSet:
    """回读自检: 回封的 NPK 能否被独立(再调 CLI)解回。返回 SpriteSet。
       core.pack 用它确认替换帧都在。"""
    tmp = out_path + '.verify'
    if os.path.isdir(tmp):
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    _run_cli('unpack', out_path, '-o', tmp)
    mani = _read_manifest(tmp)
    ss = SpriteSet()
    for fr in mani['frames']:
        if fr.get('linked'):
            continue
        png = os.path.join(tmp, fr['file'])
        if os.path.isfile(png):
            img = Image.open(png).convert('RGBA')
            img.load()
            ss[(int(fr['img_index']), int(fr['frame_index']))] = Frame(
                int(fr['img_index']), int(fr['frame_index']), img,
                (int(fr['offset_x']), int(fr['offset_y'])))
    return ss
