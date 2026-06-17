"""core/render.py — 渲染 (轴钉锚点 + 横条 + 网格 + GIF, 格式无关, ARCHITECTURE.md §1)

只吃 Frame + Geometry, 不碰任何 SFF/PCX/AIR。轴钉锚点 = 每帧的轴贴到格内固定锚点。
- render_cell:   单帧 → 一格 RGBA (轴对齐)
- build_overlay: 单帧 原帧ghost + 替换帧实色 叠加 (轴钉同锚) → PNG (逐帧手动对齐参照)
- build_strip:   一动作的去重帧 → 横条 PNG + 每格 meta (含 content_bbox, 给导入反推轴)
- build_gif:     一动作完整序列 (含时长/偏移) → GIF
- build_grid:    多动作 → 带标签的网格图 (clean 无标注 / reference 有锚十字), 给导出/AI
"""
from __future__ import annotations
import io
from collections import OrderedDict
from typing import Any, Iterable, Optional
from PIL import Image, ImageDraw, ImageFont
from PIL.ImageFont import FreeTypeFont, ImageFont as DefaultImageFont

from core.model import Action, Frame, SpriteSet
from core.geometry import Geometry

MARK = (255, 0, 255)     # 旧版横图分隔线色(纯洋红); 导入端仍兼容抠除, 新导出不再画
GREEN = (0, 255, 0)      # 横图绿底 #00FF00: nano banana 友好(单一纯色背景) + HSV 抠图友好, 替代透明底+洋红线
TOP_M, BASE_M = 24, 16   # 横图上/下页边(绿边留白)
GRAY = (138, 141, 147)   # GIF 底色(配 UI 画布)


def _bg_rgba(bg: str) -> tuple[int, int, int, int]:
    """横图/网格背景色名 → RGBA。green=#00FF00(抠图友好默认); white/black/gray=备选;
       dark=深色; transparent=透明底。背景色由前端一个开关统一管(显示+导出+导入抠图同色),
       绿对多数角色抠得最干净, 用户可自行切黑/白(按自己角色不撞色挑)。"""
    return {'green': (*GREEN, 255), 'gray': (*GRAY, 255),
            'white': (255, 255, 255, 255), 'black': (0, 0, 0, 255),
            'dark': (28, 30, 36, 255), 'transparent': (0, 0, 0, 0)}.get(bg, (*GREEN, 255))


def _cjk(size: int, bold: bool = False) -> FreeTypeFont | DefaultImageFont:
    import os
    for p, idx in [("/System/Library/Fonts/Hiragino Sans GB.ttc", 1 if bold else 0),
                   ("/System/Library/Fonts/STHeiti Medium.ttc", 0)]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=idx)
            except Exception:
                pass
    return ImageFont.load_default()


def render_cell(fr: Frame, geo: Geometry) -> Image.Image:
    """单帧 → 一格 RGBA (透明底, 轴钉到 geo.anchor)。"""
    im = fr.img
    ax: float = fr.axis[0]
    ay: float = fr.axis[1]
    s = geo.scale
    if s != 1.0:
        im = im.resize((max(1, int(im.size[0]*s)), max(1, int(im.size[1]*s))), Image.Resampling.LANCZOS)
        ax, ay = ax*s, ay*s
    cell = Image.new('RGBA', (geo.cell_w, geo.cell_h), (0, 0, 0, 0))
    cell.alpha_composite(im, (int(geo.anchor[0]-ax), int(geo.anchor[1]-ay)))
    return cell


def build_overlay(sprites: SpriteSet, replace: dict[tuple[int, int], Frame],
                  geo: Geometry, g: int, i: int, upscale: int = 2) -> bytes:
    """单帧对齐叠图: 原帧(半透明 ghost 当参照) + 替换帧(实色, 在上) 轴钉同一锚点 → PNG。
    用于逐帧手动对齐: 三九 看新帧偏离原帧多少, 方向键挪到贴合。锚点画十字十字参照。
    """
    cw, ch = geo.cell_w, geo.cell_h
    canvas = Image.new('RGBA', (cw, ch), (*GRAY, 255))
    orig = sprites.get(g, i)
    if orig is not None:                              # 原帧 ghost (淡, 当对齐参照)
        co = render_cell(orig, geo)
        r, gg, b, a = co.split()
        ghost = Image.merge('RGBA', (r, gg, b, a.point(lambda v: int(v * 0.40))))
        canvas.alpha_composite(ghost)
    new = replace.get((g, i))
    if new is not None:                               # 替换帧 实色 (在上, 被挪的对象)
        canvas.alpha_composite(render_cell(new, geo))
    dr = ImageDraw.Draw(canvas)                       # 锚点十字 (脚底定位参照)
    ax, ay = int(geo.anchor[0]), int(geo.anchor[1])
    dr.line([ax-8, ay, ax+8, ay], fill=(255, 80, 80, 170), width=1)
    dr.line([ax, ay-8, ax, ay+8], fill=(255, 80, 80, 170), width=1)
    if upscale != 1:
        canvas = canvas.resize((cw*upscale, ch*upscale), Image.Resampling.NEAREST)
    b2 = io.BytesIO(); canvas.save(b2, format='PNG')
    return b2.getvalue()


def build_strip(sprites: SpriteSet, action: Action, geo: Geometry,
                kind: str = 'orig',
                replace: Optional[dict[tuple[int, int], Frame]] = None
                ) -> tuple[bytes, dict[str, Any]]:
    """一动作的去重帧 → (横条 PNG bytes, meta)。

    sprites: SpriteSet (查原帧)。
    action:  core.model.Action。
    replace: dict[(g,i)] = Frame, kind=='new' 时优先取 (替换帧)。
    meta:    {'n', 'cw', 'ch', 'anchor', 'cells':[{'g','i','bbox'},...]} — 导入按 bbox 反推轴。
    """
    replace = replace or {}

    def pick(g: int, i: int) -> Frame | None:
        if kind == 'new' and (g, i) in replace:
            return replace[(g, i)]
        return sprites.get(g, i)

    uq = [k for k in action.unique_cells() if sprites.get(*k)]
    n = len(uq)
    cw, ch, anchor = geo.cell_w, geo.cell_h, geo.anchor
    W, H = n*cw, TOP_M+ch+BASE_M
    # 绿底 (#00FF00) 替代透明底 + 洋红线: nano banana 对单一纯色背景友好, 洋红线是
    # 分布外噪声会干扰它。帧之间靠格内留白(geo MG)天然分隔; 对齐数据全走 meta(旁路),
    # 不再依赖图上画线。详见项目设计笔记
    strip = Image.new('RGBA', (W, H), (*GREEN, 255))
    meta_cells: list[dict[str, Any]] = []
    for i, (g, im) in enumerate(uq):
        # uq 已过滤掉 sprites.get 为空的格 → pick 在此恒非 None (kind='new' 取 replace 帧亦为 Frame)
        cell = render_cell(pick(g, im), geo)  # type: ignore[arg-type]
        strip.alpha_composite(cell, (i*cw, TOP_M))
        bb = cell.split()[-1].getbbox() or (anchor[0], anchor[1], anchor[0]+1, anchor[1]+1)
        meta_cells.append({'g': g, 'i': im, 'bbox': list(bb)})
    meta: dict[str, Any] = {'n': n, 'cw': cw, 'ch': ch, 'anchor': anchor, 'cells': meta_cells}
    b = io.BytesIO(); strip.save(b, format='PNG')
    return b.getvalue(), meta


def build_action_grid(sprites: SpriteSet, action: Action, geo: Geometry,
                      kind: str = 'orig',
                      replace: Optional[dict[tuple[int, int], Frame]] = None,
                      upscale: int = 2, gap: int = 14, pad: int = 18,
                      bg: str = 'green'
                      ) -> tuple[bytes, dict[str, Any]]:
    """一动作去重帧 → 接近正方形网格 PNG bytes + meta (nano banana 友好导出)。
    bg: 背景色名 (green 默认=AI 抠图; gray/dark/transparent=显示用, 不影响 meta/导入)。

    方块布局(非长条)避开 Gemini 把长条切 tile 拉糊那个最硬的根因; 绿底 #00FF00 +
    帧间绿间隙 + 每帧放大 upscale 倍(NEAREST 保像素锐边)。一张图一次重绘 → 帧间一致。
    meta 记每格精确位置(cell_xy/cell_wh) + 整图 W/H, 导入按比例精确定位每格,
    不靠"等宽 N 格"那个一漂就错的脆假设。详见 nano-banana 图生图格式诊断报告。
    """
    import math
    replace = replace or {}

    def pick(g: int, i: int) -> Frame | None:
        if kind == 'new' and (g, i) in replace:
            return replace[(g, i)]
        return sprites.get(g, i)

    uq = [k for k in action.unique_cells() if sprites.get(*k)]
    n = len(uq)
    cols = max(1, math.ceil(math.sqrt(n))) if n else 1
    rows = max(1, math.ceil(n / cols)) if n else 1
    cw, ch = geo.cell_w * upscale, geo.cell_h * upscale
    ax, ay = geo.anchor[0] * upscale, geo.anchor[1] * upscale
    W = pad * 2 + cols * cw + (cols - 1) * gap
    H = pad * 2 + rows * ch + (rows - 1) * gap
    grid = Image.new('RGBA', (W, H), _bg_rgba(bg))
    meta_cells: list[dict[str, Any]] = []
    for idx, (g, im) in enumerate(uq):
        r, c = divmod(idx, cols)
        x, y = pad + c * (cw + gap), pad + r * (ch + gap)
        # uq 已过滤空格 → pick 恒非 None
        cell = render_cell(pick(g, im), geo)  # type: ignore[arg-type]  # cell_w×cell_h 透明底, 轴钉锚点
        if upscale != 1:
            cell = cell.resize((cw, ch), Image.Resampling.NEAREST)   # 像素放大保锐边
        grid.alpha_composite(cell, (x, y))
        bb = cell.split()[-1].getbbox() or (int(ax), int(ay), int(ax) + 1, int(ay) + 1)
        meta_cells.append({'g': g, 'i': im, 'cell_xy': [x, y], 'cell_wh': [cw, ch], 'bbox': list(bb)})
    meta: dict[str, Any] = {'n': n, 'cols': cols, 'rows': rows, 'cw': cw, 'ch': ch,
            'anchor': [ax, ay], 'W': W, 'H': H, 'upscale': upscale, 'scale': geo.scale, 'cells': meta_cells}
    b = io.BytesIO(); grid.save(b, format='PNG')
    return b.getvalue(), meta


def build_gif(sprites: SpriteSet, action: Action, geo: Geometry,
              kind: str = 'orig',
              replace: Optional[dict[tuple[int, int], Frame]] = None) -> bytes:
    """一动作完整序列 (含时长/偏移) → GIF bytes。"""
    replace = replace or {}

    def pick(g: int, i: int) -> Frame | None:
        if kind == 'new' and (g, i) in replace:
            return replace[(g, i)]
        return sprites.get(g, i)

    cw, ch, anchor, s = geo.cell_w, geo.cell_h, geo.anchor, geo.scale
    frames: list[Image.Image] = []
    durs: list[int] = []
    for (g, i, ox, oy, dur) in action.frames:
        fr = pick(g, i)
        if not fr:
            continue
        canvas = Image.new('RGBA', (cw, ch), (*GRAY, 255))
        im = fr.img
        ax: float = fr.axis[0]
        ay: float = fr.axis[1]
        if s != 1.0:
            im = im.resize((max(1, int(im.size[0]*s)), max(1, int(im.size[1]*s))), Image.Resampling.LANCZOS)
            ax, ay = ax*s, ay*s
        canvas.alpha_composite(im, (int(anchor[0]-ax+ox*s), int(anchor[1]-ay+oy*s)))
        frames.append(canvas.convert('P', palette=Image.Palette.ADAPTIVE))
        durs.append(max(33, int((dur if dur > 0 else 6)*1000/60)))
    if not frames:
        frames = [Image.new('P', (cw, ch))]; durs = [100]
    b = io.BytesIO()
    frames[0].save(b, format='GIF', save_all=True, append_images=frames[1:], duration=durs, loop=0, disposal=2)
    return b.getvalue()


def build_grid(sprites: SpriteSet, actions: Iterable[Action], geo: Geometry,
               cols: int = 8, gutter: int = 150, label_h: int = 22
               ) -> tuple[Image.Image, Image.Image, list[dict[str, Any]]]:
    """多动作 → (clean RGBA, reference RGBA, manifest_cells)。

    sprites: SpriteSet。actions: 有序 [Action,...] (按动作收唯一帧, 每动作另起一行)。
    clean:     透明底无标注 (喂 AI 的母版)。
    reference: 深底 + 锚十字/地脚线/grp,img/动作名 (给人看导航)。
    manifest_cells: 每格 {idx,action,action_name,group,image,orig_size,orig_axis,cell_xy,content_bbox}。
    """
    cw, ch, anchor, scale = geo.cell_w, geo.cell_h, geo.anchor, geo.scale

    # 按动作收唯一帧 (去重, 记首次所属动作)
    seen: set[tuple[int, int]] = set()
    by_action: OrderedDict[int, tuple[str, list[dict[str, Any]]]] = OrderedDict()   # action_id -> (name, [cell dicts])
    for act in actions:
        for (g, i) in act.unique_cells():
            if (g, i) in seen:
                continue
            seen.add((g, i))
            fr = sprites.get(g, i)
            if not fr:
                continue
            by_action.setdefault(act.id, (act.name, []))[1].append(
                {'action': act.id, 'action_name': act.name, 'group': g, 'image': i, 'frame': fr})

    rows_plan: list[tuple[int, str, list[dict[str, Any]], int]] = []   # (action, name, [cells], nrows)
    for a, (nm, cs) in by_action.items():
        nrows = (len(cs) + cols - 1) // cols
        rows_plan.append((a, nm, cs, nrows))

    sheetW = gutter + cols*cw + 16
    sheetH = sum(nr*(ch+label_h) for _, _, _, nr in rows_plan) + 16

    clean = Image.new('RGBA', (sheetW, sheetH), (0, 0, 0, 0))
    ref = Image.new('RGBA', (sheetW, sheetH), (24, 26, 32, 255))
    dr = ImageDraw.Draw(ref)
    f_lab = _cjk(15, bold=True); f_sm = _cjk(12)

    manifest_cells: list[dict[str, Any]] = []
    y = 8
    idx = 0
    for a, nm, cs, nrows in rows_plan:
        dr.text((8, y+4), f"[{a}] {nm}", fill=(120, 200, 255, 255), font=f_lab)
        for r in range(nrows):
            row_cs = cs[r*cols:(r+1)*cols]
            for col, c in enumerate(row_cs):
                cx = gutter + col*cw
                cy = y + r*(ch+label_h)
                cell_img = render_cell(c['frame'], geo)
                clean.alpha_composite(cell_img, (cx, cy))
                ref.alpha_composite(cell_img, (cx, cy))
                dr.rectangle([cx, cy, cx+cw-1, cy+ch-1], outline=(70, 74, 84, 255))
                axp = (cx+anchor[0], cy+anchor[1])
                dr.line([axp[0]-6, axp[1], axp[0]+6, axp[1]], fill=(255, 80, 80, 200), width=1)
                dr.line([axp[0], axp[1]-6, axp[0], axp[1]+6], fill=(255, 80, 80, 200), width=1)
                dr.line([cx, axp[1], cx+cw, axp[1]], fill=(255, 80, 80, 70), width=1)
                dr.text((cx+3, cy+ch+2), f"{c['group']},{c['image']}", fill=(190, 195, 205, 255), font=f_sm)
                bb = cell_img.split()[-1].getbbox() or (anchor[0], anchor[1], anchor[0]+1, anchor[1]+1)
                manifest_cells.append({
                    'idx': idx, 'action': a, 'action_name': nm,
                    'group': c['group'], 'image': c['image'],
                    'orig_size': list(c['frame'].size), 'orig_axis': list(c['frame'].axis),
                    'cell_xy': [cx, cy], 'content_bbox': list(bb),
                })
                idx += 1
        y += nrows*(ch+label_h)
    return clean, ref, manifest_cells
