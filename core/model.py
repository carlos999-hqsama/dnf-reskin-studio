"""core/model.py — 数据契约 (单一权威, ARCHITECTURE.md §2)

通用层 (core/) 只认这四个结构, 永远不碰 SFF/PCX/AIR 字节, 也不理解动作号语义
(200=轻拳之类只有 formats/ 知道)。格式层 (formats/mugen.py 等) 负责把字节解码成
这些结构, 通用层只在这些结构上做几何/对齐/切片/去背/打包编排。
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import ItemsView, Iterator, KeysView, ValuesView
from PIL import Image


@dataclass
class Frame:
    """一张精灵帧。

    group/image: 帧在精灵集里的 (组号, 图号) 坐标 (MUGEN 概念, 通用层只当 key)。
    img:         PIL.Image.Image, RGBA, index0→透明已由格式层应用。
    axis:        (x, y) 定位点/锚点 (MUGEN 叫"轴", 即脚底定位点)。
    """
    __slots__ = ('group', 'image', 'img', 'axis')
    group: int
    image: int
    img: Image.Image       # RGBA, index0→透明已由格式层应用
    axis: tuple[int, int]

    @property
    def size(self) -> tuple[int, int]:
        return self.img.size


class SpriteSet:
    """(group, image) → Frame 的查询容器。

    薄封装 dict; 既支持 ss[(g,i)] / ss.get(g,i), 也能像 dict 一样迭代/更新,
    方便打包时 dict(sprites) + update(replace)。
    """
    __slots__ = ('frames',)

    frames: dict[tuple[int, int], Frame]

    def __init__(self, frames: dict[tuple[int, int], Frame] | None = None) -> None:
        self.frames = dict(frames) if frames else {}

    def get(self, group: int, image: int) -> Frame | None:
        return self.frames.get((group, image))

    # ── dict 风格便利 (打包/迭代用) ─────────────────────────────
    def __getitem__(self, key: tuple[int, int]) -> Frame:
        return self.frames[key]

    def __setitem__(self, key: tuple[int, int], value: Frame) -> None:
        self.frames[key] = value

    def __contains__(self, key: tuple[int, int]) -> bool:
        return key in self.frames

    def __len__(self) -> int:
        return len(self.frames)

    def __iter__(self) -> Iterator[tuple[int, int]]:
        return iter(self.frames)

    def keys(self) -> KeysView[tuple[int, int]]:
        return self.frames.keys()

    def values(self) -> ValuesView[Frame]:
        return self.frames.values()

    def items(self) -> ItemsView[tuple[int, int], Frame]:
        return self.frames.items()


@dataclass
class Action:
    """一个动作 (动画) 的帧序列。

    id:     动作号。
    name:   人看的名字 (格式层给, 通用层不懂语义)。
    frames: [(group, image, offx, offy, dur), ...] 含每帧时长/偏移, 给 GIF 用。
    """
    id: int
    name: str
    frames: list[tuple[int, int, int, int, int]] = field(default_factory=list)

    def unique_cells(self) -> list[tuple[int, int]]:
        """去重后的 (group, image) 列表, 保持首次出现顺序 (横图/逐帧用)。"""
        seen: set[tuple[int, int]] = set()
        out: list[tuple[int, int]] = []
        for f in self.frames:
            k = (f[0], f[1])
            if k not in seen:
                seen.add(k)
                out.append(k)
        return out


@dataclass
class Project:
    """一个角色的完整模型 (格式层 load() 的产物)。

    sprites:         全部精灵。
    actions:         动作号 → Action (全部动作)。
    core_action_ids: "核心身体集"动作号 (格式层判定, 通用层只当过滤白名单)。
    """
    name: str
    source_dir: str
    sprites: SpriteSet
    actions: dict[int, Action]
    core_action_ids: list[int]
