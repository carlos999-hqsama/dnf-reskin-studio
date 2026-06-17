"""core/matte.py — 去背 (单一权威实现, ARCHITECTURE.md §1 / 关键不回归点 2)

去背统一用 flood_bg (四角种子 + 区域生长连通域), 不是简单色键。
key_out (色键) 仅作辅助: 抠导出标记的纯洋红线 + 用户手动选色补刀。
"""
from __future__ import annotations
from collections import deque
from typing import Any, Sequence
from PIL import Image


def flood_bg(img: Image.Image, tol: int = 45) -> Image.Image:
    """连通域去背 (FrameRonin 思路 + 区域生长强化, 四角种子):
    从四角漫水, 邻居与【当前像素】色差≤tol 才并入 → 顺着背景渐变一路走(渐变绿/蓝深浅全吃),
    撞到角色硬边(大跳变 >tol)即停, 不误伤角色; 角色是孤岛不连角落, 身上有同色也安全。
    比"邻居比固定种子"更扛渐变(种子法漫到半路色差超阈就断, 留中间带)。按格调用穿过洋红格线。
    """
    img = img.convert('RGBA'); w, h = img.size
    if w < 2 or h < 2:
        return img
    px: Any = img.load()  # RGBA 已转, 像素访问类型按模式动态 → Any (PIL stub 把 load() 标 Optional+联合, 此处恒非 None)
    t2 = tol * tol
    seen = bytearray(w * h); dq: deque[tuple[int, int]] = deque()
    for sx, sy in ((0, 0), (w-1, 0), (0, h-1), (w-1, h-1)):
        i = sy * w + sx
        if not seen[i] and px[sx, sy][3] != 0:
            seen[i] = 1; dq.append((sx, sy))
    while dq:
        x, y = dq.popleft()
        cr, cg, cb, _ = px[x, y]       # 当前像素色(读后再清, RGB 保留)
        px[x, y] = (cr, cg, cb, 0)
        for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
            if 0 <= nx < w and 0 <= ny < h:
                ni = ny * w + nx
                if not seen[ni]:
                    pr, pg, pb, pa = px[nx, ny]
                    if pa and (pr-cr)**2 + (pg-cg)**2 + (pb-cb)**2 <= t2:
                        seen[ni] = 1; dq.append((nx, ny))
    return img


def key_out(img: Image.Image, key: Sequence[int], tol: int) -> Image.Image:
    """色键去背 (辅助): 把与 key 色差 ≤tol 的不透明像素转透明。
    用途: 抠导出横图的纯洋红标记线 (MARK), 或用户手动选色补刀。RGB 保留只清 alpha。
    """
    img = img.convert('RGBA')
    px: Any = img.load(); w, h = img.size  # 像素访问按模式动态 → Any
    kr, kg, kb = key
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and abs(r-kr) <= tol and abs(g-kg) <= tol and abs(b-kb) <= tol:
                px[x, y] = (r, g, b, 0)
    return img


def despill_green(img: Image.Image, amount: float = 1.0) -> Image.Image:
    """去绿幕溢出 (绿底抠像收尾): 不透明像素若 green 明显高于 red/blue, 把 green 压到
    max(r,b) → 中和角色边缘那圈"角色色和绿混"的残留绿 (flood_bg 抠不掉的半透明边缘),
    既不留绿边、也不像白描边那样给角色加一圈白。角色身上避开纯绿时几乎不动本色。
    """
    img = img.convert('RGBA')
    px: Any = img.load(); w, h = img.size  # 像素访问按模式动态 → Any
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and g > r and g > b:
                cap = max(r, b)
                px[x, y] = (r, int(g - (g - cap) * amount), b, a)
    return img


def flood_key(img: Image.Image, tol: int = 80) -> Image.Image:
    """纯色幕去背 (四角采样背景色 + 全图色键): 取**四角中位背景色**(抗噪) → 自适应任何纯色幕
    (绿/蓝/洋红/灰…, 换模型换底色都不用改); 然后**全图扫一遍, 把所有"接近背景色"的像素抠掉**
    ——不只大面积背景, 还包括**被角色包住、连不到四角的背景口袋**(手指缝/手臂弯/裤裆等,
    连通域漫水进不去会漏绿)。纯色幕 + 角色身上避开幕色(提示词已要求)时安全。
    tol 是固定背景容差(任何纯色幕通用, 不用按图调); 边缘抗锯齿过渡由 despill_green 收尾中和。
    """
    import statistics
    img = img.convert('RGBA'); w, h = img.size
    if w < 2 or h < 2:
        return img
    px: Any = img.load()  # 像素访问按模式动态 → Any
    corners = [p for p in (px[0, 0], px[w-1, 0], px[0, h-1], px[w-1, h-1]) if p[3] != 0]
    if not corners:
        return img
    cr = statistics.median(c[0] for c in corners)
    cg = statistics.median(c[1] for c in corners)
    cb = statistics.median(c[2] for c in corners)
    t2 = tol * tol
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and (r-cr)**2 + (g-cg)**2 + (b-cb)**2 <= t2:
                px[x, y] = (r, g, b, 0)
    return img
