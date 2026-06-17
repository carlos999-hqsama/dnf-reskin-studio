"""core/importer.py — 导入: 切片 → 去背 → content_bbox 反推新轴 (ARCHITECTURE.md §1)

不信 AI 保持像素位置: 按"原轴在原内容框里的相对位置 (proportional)"映射到新内容框
→ 反推新轴。同纠 XY 漂移 + 大小抖动。去背统一走 matte.flood_bg (连通域, 不是简单色键)。
产出 core.model.Frame, 不碰任何 SFF/格式字节。

两条入口:
- import_strip:  Web 工作流 — 一张横图 (n 格) → 替换帧 dict。per-cell flood_bg + 尺度归一。
- frame_to_replacement: CLI 工作流 — 单张已规范化的格图 (manifest 的 content_bbox 反推轴)。
"""
from __future__ import annotations
from typing import Any, Optional, Sequence
from PIL import Image

from core.matte import flood_bg, flood_key, key_out, despill_green
from core.render import MARK
from core.model import Frame


def import_strip(img: Image.Image, meta: dict[str, Any],
                 bg_key: Optional[Sequence[int]] = None, flood_tol: int = 80,
                 mark_tol: int = 60, key_tol: int = 34,
                 debug_dir: Optional[str] = None) -> dict[tuple[int, int], Frame]:
    """Web 导入: 一张横图 → {(g,i): Frame} 替换帧。

    img:  PIL.Image (导入的 AI 横图, 已含洋红标记线)。
    meta: build_strip 产出的 meta {'n','anchor','cells':[{'g','i','bbox'},...]}。
    bg_key: 可选 [r,g,b] 用户手动选色补刀。
    返回 dict[(g,i)] = Frame。

    流程: 抠洋红标记 → (可选)色键补刀 → 按格切 → 每格 flood_bg 连通域去背 →
          取新内容 bbox → 缩到与原帧内容等高 (去 AI 大小抖动) →
          原轴在原内容框相对位映射到新内容框 → 反推新轴。
    """
    n = meta['n']
    anchor = meta['anchor']
    img = img.convert('RGBA')
    if debug_dir:
        import os
        os.makedirs(debug_dir, exist_ok=True)
        try:
            img.save(os.path.join(debug_dir, 'raw.png'))   # 探针: 存导入的真图
        except Exception:
            pass
    img = key_out(img, MARK, mark_tol)                     # 抠洋红标记
    if bg_key:
        img = key_out(img, tuple(bg_key), key_tol)         # 手动选色补刀(可选)
    W, H = img.size
    colW = W / n if n else W
    keyed = img.copy()                                     # 探针累积: 每格去背后贴回看
    out: dict[tuple[int, int], Frame] = {}
    for idx, cell in enumerate(meta['cells']):
        col = img.crop((round(idx*colW), 0, round((idx+1)*colW), H))
        col = flood_bg(col, flood_tol)                     # ★ 每格四角连通域去背
        keyed.paste(col, (round(idx*colW), 0))
        nb = col.split()[-1].getbbox()
        if nb is None:
            continue
        sprite = col.crop(nb); nw, nh = sprite.size
        ob = cell['bbox']; ow, oh = max(1, ob[2]-ob[0]), max(1, ob[3]-ob[1])
        # 尺度归一: 新角色缩到与原帧等高 -> 去掉 AI 的大小抖动 (保留原动作各帧的相对大小)
        s = oh / nh
        sprite = sprite.resize((max(1, round(nw*s)), max(1, round(nh*s))), Image.Resampling.LANCZOS)
        sw, sh = sprite.size
        rx, ry = (anchor[0]-ob[0])/ow, (anchor[1]-ob[1])/oh   # 原轴在原内容框的相对位
        nax, nay = rx*sw, ry*sh                               # 映射到归一后新内容框
        out[(cell['g'], cell['i'])] = Frame(cell['g'], cell['i'], sprite,
                                            (int(round(nax)), int(round(nay))))
    if debug_dir:
        import os
        try:
            keyed.save(os.path.join(debug_dir, 'keyed.png'))   # 探针: 每格去背后的样子
        except Exception:
            pass
    return out


def _split_bounds(profile: list, n: int, length: int) -> Optional[list]:
    """投影法找内容分界: profile = 沿某轴的内容浓度(列/行投影)。找 n 个内容峰段 → 返回 n+1 个切分边界
       (峰段之间空隙的中点)。鲁棒于人物在格里偏移/跨格(按内容自然间隙切, 不靠等分)。
       峰段 < n 返回 None(调用方回退等分, 不破坏已对齐的导出图/MUGEN); 峰段 > n 时合并间隙最小的相邻段。"""
    if n <= 1:
        return [0, length]
    mx = max(profile) if profile else 0
    if mx <= 0:
        return None
    thr = mx * 0.06                                  # 内容阈值: 投影 > 峰值6% 算有人
    runs: list = []
    i, L = 0, len(profile)
    while i < L:
        if profile[i] > thr:
            j = i
            while j < L and profile[j] > thr:
                j += 1
            runs.append([i, j])
            i = j
        else:
            i += 1
    if len(runs) < n:
        return None
    while len(runs) > n:                             # 段太多: 把间隙最小的相邻两段并回(同一人物被分裂的碎块)
        gi = min(range(len(runs) - 1), key=lambda r: runs[r + 1][0] - runs[r][1])
        runs[gi][1] = runs[gi + 1][1]
        del runs[gi + 1]
    bounds = [0]
    for r in range(n - 1):
        bounds.append((runs[r][1] + runs[r + 1][0]) // 2)   # 边界 = 相邻峰段空隙中点
    bounds.append(length)
    return bounds


def import_action_grid(img: Image.Image, meta: dict[str, Any],
                       bg_key: Optional[Sequence[int]] = None, flood_tol: int = 80,
                       key_tol: int = 34, debug_dir: Optional[str] = None
                       ) -> dict[tuple[int, int], Frame]:
    """AI 返回的网格图 → {(g,i): Frame}。按 meta 每格位置(比例映射)精确切, 抠绿+despill, 反推轴。

    返回图尺寸可与导出不同: 按 cell_xy/wh 占整图 W/H 的比例映射到返回图 → 精确定位每格,
    不靠"等宽 N 格"。每格 flood_bg 连通域抠绿 + despill 中和边缘残绿 + 内容 bbox +
    尺度归一(缩到与导出格内容等高) + 原轴相对位反推。
    """
    img = img.convert('RGBA')
    IW, IH = img.size
    GW, GH = meta['W'], meta['H']
    anchor = meta['anchor']
    up = meta.get('upscale', 1) or 1   # 导出放大倍数: sprite/轴要缩回 1x 才匹配原帧+SFF+UI渲染
    scale = meta.get('scale', 1.0) or 1.0   # 几何缩放(原帧→格子的缩放, DNF 大画布<1); 定位/尺寸都要扣它
    if debug_dir:
        import os, json
        os.makedirs(debug_dir, exist_ok=True)
        try:
            img.save(os.path.join(debug_dir, 'raw_grid.png'))   # 探针: 原始导入的 AI 图
            probe = {k: meta[k] for k in ('n', 'cols', 'rows', 'cw', 'ch', 'W', 'H', 'anchor')}
            probe['ai_size'] = [IW, IH]
            probe['cell0'] = meta['cells'][0] if meta['cells'] else None
            with open(os.path.join(debug_dir, 'grid_meta.json'), 'w') as f:
                json.dump(probe, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
    if bg_key:
        img = key_out(img, tuple(bg_key), key_tol)
    keyed = img.copy()
    out: dict[tuple[int, int], Frame] = {}
    cols, rows = meta['cols'], meta['rows']
    # 投影法检测每列/每行的内容边界(鲁棒于人物在格里偏移/跨格): 整图抠一次→列/行投影→按内容峰段切。
    # resize((W,1),BOX)=面积平均=列投影(纯 PIL, 不用 numpy)。峰段凑不齐 cols×rows 就回退等分
    # (导出图/MUGEN 本就对齐, 投影≈等分或回退, 不受影响)。
    det_alpha = despill_green(flood_key(img)).split()[-1]
    col_prof = list(det_alpha.resize((IW, 1), Image.Resampling.BOX).getdata())
    row_prof = list(det_alpha.resize((1, IH), Image.Resampling.BOX).getdata())
    col_b = _split_bounds(col_prof, cols, IW) or [round(c * IW / cols) for c in range(cols + 1)]
    row_b = _split_bounds(row_prof, rows, IH) or [round(r * IH / rows) for r in range(rows + 1)]
    for idx, cell in enumerate(meta['cells']):
        gr, gc = divmod(idx, cols)
        cx0, cy0, cx1, cy1 = col_b[gc], row_b[gr], col_b[gc + 1], row_b[gr + 1]
        sub = img.crop((cx0, cy0, cx1, cy1))
        sub = flood_key(sub)                                     # 每格再抠: 四角采样背景色键控, 撞角色硬停不漫穿(保 per-cell 背景自适应)
        sub = despill_green(sub)                                 # 中和边缘残绿(绿底专用; 非绿底无害)
        keyed.paste(sub, (cx0, cy0))
        nb = sub.split()[-1].getbbox()
        if nb is None:
            continue
        sprite = sub.crop(nb); nw, nh = sprite.size
        ob = cell['bbox']; oh = max(1, ob[3]-ob[1])
        k = up * scale       # 放大cell坐标 → 帧原生坐标 总因子(含几何缩放 geo.scale; 扣掉它修 DNF scale<1 双重缩小→偏小)
        s = (oh / k) / nh    # AI 内容缩到原帧原生尺寸(渲染时再 ×scale×up 回到原内容高)
        sprite = sprite.resize((max(1, round(nw*s)), max(1, round(nh*s))), Image.Resampling.LANCZOS)
        # 鲁棒定位: 新内容【底部中心】对齐原内容框(放大cell坐标), 轴 = (锚 - 落点)/k。
        # 不再用 rx=(anchor-ob)/ow 那个"轴必须落在内容框内"的脆假设 —— DNF 锚点离内容远→rx 爆(6+)→轴飞出画布致整格空。
        w_up = nw * oh / nh                      # 新内容在放大cell里的宽(高 = oh)
        tlx = (ob[0] + ob[2]) / 2 - w_up / 2     # 对齐原图【该帧】: 水平中心 = 原内容框中心(每帧各自, 跟原版动画走)
        tly = ob[1]                              # 高 = oh → 底对齐原内容框底(每帧各自)
        nax, nay = (anchor[0] - tlx) / k, (anchor[1] - tly) / k
        out[(cell['g'], cell['i'])] = Frame(cell['g'], cell['i'], sprite,
                                            (int(round(nax)), int(round(nay))))
    if debug_dir:
        import os
        os.makedirs(debug_dir, exist_ok=True)
        try:
            keyed.save(os.path.join(debug_dir, 'keyed_grid.png'))
        except Exception:
            pass
    return out


def foot_anchor_axis(orig_size: tuple[int, int], orig_axis: tuple[int, int],
                     new_size: tuple[int, int]) -> tuple[int, int]:
    """脚底锚定 = 对齐的唯一口径(纯几何, 与格式无关)。

    新精灵的底部中心(脚底接地点)对齐原版帧的底部中心 → 用原版 basePt(axis) + 尺寸差反推新轴:
      水平: 保中心 → axis_x = 原axis_x + (原宽 - 新宽)/2
      垂直: 保底   → axis_y = 原axis_y + (原高 - 新高)
    同尺寸 → 轴 = 原版 basePt 本身(ΔX=ΔY=0); 尺寸变 → 脚底照样落原位。

    orig_size/orig_axis: 原版帧 pic 尺寸 + basePt(游戏内绝对坐标, 绿body 验证过是对的)。
    new_size:            新精灵的【最终】尺寸 —— DNF 调用方须先硬化 alpha + 裁到内容框再传,
                         否则 LANCZOS 软边会让尺寸偏 ~5px(三九实测), 轴随之偏。
    取代旧的"绕预览坐标系反推轴"(漂 +6~12px): 直接拿原版 basePt 重锚, 预览=游戏。
    """
    opw, oph = orig_size
    obx, oby = orig_axis
    npw, nph = new_size
    return (int(round(obx + (opw - npw) / 2.0)), int(round(oby + (oph - nph))))


def apply_adjust(fr: Frame, scale: float = 1.0, dx: int = 0, dy: int = 0) -> Frame:
    """手动对齐: 对替换帧缩放 sprite + 平移轴。scale 整体缩放(轴随之缩), dx/dy 像素平移轴。
    给手动对齐工具用 — 从"导入的原始替换帧" + 这三个参数算出调整后的帧, 可反复调 / 重置归零。
    """
    if scale == 1.0 and dx == 0 and dy == 0:
        return fr
    im = fr.img
    if scale != 1.0:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.Resampling.LANCZOS)
    ax = fr.axis[0] * scale + dx
    ay = fr.axis[1] * scale + dy
    return Frame(fr.group, fr.image, im, (int(round(ax)), int(round(ay))))


def frame_to_replacement(cell_img: Image.Image, manifest_cell: dict[str, Any],
                         cell_w: int, cell_h: int, anchor: Sequence[int],
                         bg_key: Optional[Sequence[int]] = None,
                         mode: str = 'proportional') -> Optional[Frame]:
    """CLI 导入: 单张规范化格图 → Frame (用 manifest 的 content_bbox 反推轴)。

    cell_img:      一张格图 (AI 重绘的同 grp/img 帧, 理想为透明底)。
    manifest_cell: build_grid 产出的 cell {group,image,content_bbox,...}。
    mode: 'proportional' (默认, 容忍漂移) | 'fixed' (按内容 bbox 左上角对齐)。
    返回 Frame | None (空帧返回 None)。
    """
    cell = cell_img.convert('RGBA')
    if cell.size != (cell_w, cell_h):
        cell = cell.resize((cell_w, cell_h), Image.Resampling.LANCZOS)   # AI 出图尺寸不符 -> 拉回格尺寸
    if bg_key:
        cell = key_out(cell, tuple(bg_key), 18)
    bb = cell.split()[-1].getbbox()
    if bb is None:
        return None
    sprite = cell.crop(bb)
    g, i = manifest_cell['group'], manifest_cell['image']
    ob = manifest_cell['content_bbox']
    ow, oh = max(1, ob[2]-ob[0]), max(1, ob[3]-ob[1])
    if mode == 'fixed':
        nax = anchor[0]-bb[0]; nay = anchor[1]-bb[1]
    else:  # proportional: 原轴在原内容框的相对位 -> 映射到新内容框
        rx = (anchor[0]-ob[0])/ow; ry = (anchor[1]-ob[1])/oh
        nax = rx*(bb[2]-bb[0]); nay = ry*(bb[3]-bb[1])
    return Frame(g, i, sprite, (int(round(nax)), int(round(nay))))


def canvas_at_axis(fr: Frame, S: int = 600) -> bytes:
    """把精灵按轴贴到统一画布(轴对齐中心)再压黑底, 返回 RGB 字节。
    裁剪/透明边差异被抹平, 只要可见像素同位置同色 -> 字节相等 = 渲染等价。
    恒等回环自检用 (导出帧原样导入 → 逐帧渲染掩码字节相等)。"""
    cv = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ax, ay = fr.axis
    cv.alpha_composite(fr.img, (S//2 - int(round(ax)), S//2 - int(round(ay))))
    return Image.alpha_composite(Image.new('RGBA', (S, S), (0, 0, 0, 255)), cv).convert('RGB').tobytes()
