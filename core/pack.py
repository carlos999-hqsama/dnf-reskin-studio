"""core/pack.py — 打包编排 + 恒等回环自检 (ARCHITECTURE.md §1 / §3)

通用层与格式层的唯一交互点: 只通过 fmt 的 6 函数 (write / copy_support_files /
verify / load) 干活, 不碰任何 SFF/PCX 字节。接 DNF = 传个 formats.dnf 进来即可, 本文件不改。
"""
from __future__ import annotations
import os
from types import ModuleType
from typing import Any

from core.importer import canvas_at_axis
from core.model import Frame, Project


def pack(fmt: ModuleType, project: Project,
         replace: dict[tuple[int, int], Frame], out_dir: str,
         full: bool = True, verify: bool = True) -> dict[str, Any]:
    """把补丁后的角色打包到 out_dir。

    fmt:     格式模块 (formats.mugen 等), 用其 write/copy_support_files/verify。
    project: core.model.Project (源角色, 提供 sprites + source_dir)。
    replace: dict[(g,i)] = Frame (替换帧)。
    full:    True=重建全部精灵(可玩, 拷支撑文件); False=只打包替换帧(快, 仅测试)。
    verify:  True=回读自检(把写出的精灵整个解回来逐帧核对, 安全但慢)。DNF 本体几千帧时
             这步要把整包解一遍(~36s)+逐张读, 是部署慢的大头; 重封本身已可靠, 故"部署到游戏"
             传 False 跳过它换速度(用户在游戏里眼验), "装回原目录"等破坏性操作仍保留自检。
    返回 {'out', 'size_mb', 'replaced', 'copied':[...]}。
    """
    os.makedirs(out_dir, exist_ok=True)
    if full:
        allspr = dict(project.sprites.frames)
        allspr.update(replace)
        frames = list(allspr.values())
    else:
        frames = list(replace.values())

    out_sff = os.path.join(out_dir, 'Sprite.sff')
    size = fmt.write(frames, out_sff)

    copied: list[str] = []
    if full:
        copied = fmt.copy_support_files(project.source_dir, out_dir)

    # 回读自检: 写出的精灵文件能否被独立解析器读回 + 替换帧全在 (verify=False 时跳过, 见 docstring)
    if verify:
        back = fmt.verify(out_sff)
        for k in replace:
            if k not in back:
                raise AssertionError(f"回读自检: 替换帧 {k} 丢失")

    return {'out': out_dir, 'size_mb': round(size/1024/1024, 1),
            'replaced': len(replace), 'copied': copied}


def identity_roundtrip_rate(fmt: ModuleType, project: Project,
                            replace: dict[tuple[int, int], Frame],
                            out_sff: str) -> tuple[int, int, float]:
    """恒等回环一致率: 写出的替换帧回读 vs 原帧, 按轴对齐比 RGB 掩码。

    仅当 replace 由原帧原样导出再导入 (恒等模式) 时有意义。
    返回 (same, total, rate)。rate==1.0 = 逐帧渲染掩码 100% 等于原帧。
    """
    back = fmt.verify(out_sff)
    same = 0
    pairs = list(replace.keys())
    for k in pairs:
        a = back.get(*k)              # back: SpriteSet, k=(g,i)
        b = project.sprites.get(*k)
        if a is None or b is None:
            continue
        if canvas_at_axis(a) == canvas_at_axis(b):
            same += 1
    rate = same/len(pairs) if pairs else 0.0
    return same, len(pairs), rate
