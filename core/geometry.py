"""core/geometry.py — 锚点外延 / 格尺寸 / scale 计算 (单一权威, ARCHITECTURE.md §1)

把"取所有出现帧的最大外延 → 统一格尺寸 + 锚点 + scale"这套几何收成一处,
给 web (server.open_char) 和 cli (export/import) 共用。锚点口径: 每帧的"轴"
(脚底/定位点) 钉在格子固定锚点 → 所有帧"站"在同一处, AI 套形象时框架一致。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Optional

from core.model import SpriteSet

MARGIN = 8   # 格内留边 (上下左右各 MG)


@dataclass
class Geometry:
    """一个角色统一的格几何。

    cell_w/cell_h: 格尺寸 (已含 scale)。
    anchor:        (x, y) 轴在格内的钉点 (已含 scale)。
    scale:         为不超 maxcell 而做的缩放 (1.0 = 不缩)。
    """
    cell_w: int
    cell_h: int
    anchor: tuple[int, int]
    scale: float


def compute_geometry(frames: SpriteSet, cells: Iterable[tuple[int, int]],
                     maxcell: int = 300, margin: int = MARGIN,
                     scale_override: Optional[float] = None) -> Geometry:
    """按"所有出现帧的最大外延"算统一格尺寸 + 锚点 + scale。

    frames: SpriteSet | dict[(g,i)] = Frame (查帧)。
    cells:  可迭代 (group, image) — 参与几何的帧坐标 (通常是若干动作的去重并集)。
    maxcell: 格长边上限, 超出按比例缩 (默认 300, server 口径; cli 用 320)。

    外延: 上=axis_y, 下=h-axis_y, 左=axis_x, 右=w-axis_x; 取各方向最大值。
    返回 Geometry。
    """
    mU = mD = mL = mR = 1
    for (g, i) in cells:
        fr = frames.get(g, i)        # frames: SpriteSet (get(group, image))
        if not fr:
            continue
        w, h = fr.size
        ax, ay = fr.axis
        mU = max(mU, ay); mD = max(mD, h - ay)
        mL = max(mL, ax); mR = max(mR, w - ax)
    cw = mL + mR + 2 * margin
    ch = mU + mD + 2 * margin
    anchor = (mL + margin, mU + margin)
    if scale_override is not None:   # 分组视图: 沿用整动作全局缩放(角色同比例可拼回), 格子收到本组外延
        scale = scale_override
    else:
        scale = 1.0
        if max(cw, ch) > maxcell:
            scale = maxcell / max(cw, ch)
    cw = int(cw * scale)
    ch = int(ch * scale)
    anchor = (int(anchor[0] * scale), int(anchor[1] * scale))
    return Geometry(cell_w=cw, cell_h=ch, anchor=anchor, scale=scale)
