"""core/segment.py — 把一个动作的帧序列均分成固定大小的组(九宫格浏览 / 分批喂 AI)。

DNF 本体一个 IMG 塞了整套动作的全部帧。这里按顺序每 group_size 帧(默认 9, 正好
渲染成 3×3 九宫格)切一组 —— 均分、整齐, 每组帧少正好一批喂 nano banana。
(之前按姿势跳变的变长分段太碎, 改成均分定长。)
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import List, Tuple

from core.model import SpriteSet, Action


@dataclass
class Segment:
    """一组(均分的一块)。"""
    index: int                       # 组号 (从 1 起)
    start: int                       # 组内首帧在 action.unique_cells() 里的序号
    end: int                         # 末帧序号 (含)
    keys: List[Tuple[int, int]]      # 该组的 (group, image) 帧坐标


def segment_action(sprites: SpriteSet, action: Action, group_size: int = 9) -> List[Segment]:
    """动作去重帧按顺序每 group_size 帧切一组 (默认 9 = 3×3 九宫格)。

    末组若太短 (< 半组) 就并进前一组, 免落单一两帧。sprites 参数保留以对齐调用契约。
    """
    keys = action.unique_cells()
    gs = max(1, group_size)
    starts = list(range(0, len(keys), gs))
    if len(starts) >= 2 and len(keys) - starts[-1] < gs / 2:   # 末组太短 → 并进前一组
        starts.pop()
    segs: List[Segment] = []
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(keys)
        segs.append(Segment(index=n + 1, start=s, end=e - 1, keys=keys[s:e]))
    return segs
