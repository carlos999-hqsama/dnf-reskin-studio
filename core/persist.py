"""core/persist.py — 渐进补丁草稿 (M1) + 原版备份 (M2) 持久化 (ARCHITECTURE.md §1)

格式无关: 只认 core.model.Frame + 文件路径, 不碰任何 SFF/PCX/格式字节。
- 草稿 (M1 渐进补丁): 把"已固定生效"的替换帧落盘 out/_wip/<角色>/, 重启 / 切角色不丢,
  打开角色时恢复。存透明 PNG + draft.json(每帧轴 + 已固定动作号集)。
- 原版备份 (M2): 打开角色即把原始精灵文件复制进 out/_backup/<角色>/ (已备过绝不覆盖),
  一键还原 = 用备份覆盖回原目录。原始精灵自带原始锚点, 复制即备份。
"""
from __future__ import annotations
import json
import os
import shutil
import stat
from PIL import Image

from core.model import Frame


def _chmod_w(path: str) -> None:
    """给文件补 u+w (MUGEN 原始文件常只读, 覆盖前先放开写权限)。"""
    try:
        os.chmod(path, os.stat(path).st_mode | stat.S_IWUSR)
    except OSError:
        pass


# ── M2 原版备份 ──────────────────────────────────────────────────────────────
def backup_sprite(sprite_path: str, backup_dir: str) -> bool:
    """把原始精灵文件复制进备份库。已备过则跳过 (关键: 保证备份永远是最初的原版,
    不会在 M3 覆盖后把改过的当原版备走)。返回备份文件是否就位。"""
    if not os.path.isfile(sprite_path):
        return False
    os.makedirs(backup_dir, exist_ok=True)
    dst = os.path.join(backup_dir, os.path.basename(sprite_path))
    if not os.path.exists(dst):
        shutil.copy2(sprite_path, dst)
        _chmod_w(dst)
    return os.path.isfile(dst)


def backup_path(sprite_path: str, backup_dir: str) -> str:
    """备份库里该精灵文件的路径 (不保证存在)。"""
    return os.path.join(backup_dir, os.path.basename(sprite_path))


def place_sprite(src_sff: str, dst_sff: str) -> None:
    """把 src_sff 覆盖到 dst_sff (先放开目标只读)。M2 还原 / M3 装回原目录共用的写回动作。"""
    if os.path.exists(dst_sff):
        _chmod_w(dst_sff)
    shutil.copy2(src_sff, dst_sff)


def restore_sprite(backup_dir: str, sprite_path: str) -> bool:
    """用备份库的原始精灵文件覆盖回原目录。返回是否成功 (无备份 → False)。"""
    src = os.path.join(backup_dir, os.path.basename(sprite_path))
    if not os.path.isfile(src):
        return False
    place_sprite(src, sprite_path)
    return True


# ── M1 渐进补丁草稿 ──────────────────────────────────────────────────────────
def save_draft(wip_dir: str, frames: dict[tuple[int, int], Frame],
               locked_actions: set[int]) -> None:
    """把已固定的替换帧落盘草稿 (全量重写, 幂等):
    frames/<g>_<i>.png (透明) + draft.json {locked:[...], frames:{"g_i":{axis:[x,y]}}}。"""
    fr_dir = os.path.join(wip_dir, 'frames')
    os.makedirs(fr_dir, exist_ok=True)
    # 全量重写: 先清旧 PNG (移除已不再固定的帧), 再写当前集
    for fn in os.listdir(fr_dir):
        if fn.endswith('.png'):
            try:
                os.remove(os.path.join(fr_dir, fn))
            except OSError:
                pass
    meta: dict[str, object] = {'locked': sorted(locked_actions), 'frames': {}}
    fmeta: dict[str, object] = {}
    for (g, i), fr in frames.items():
        fr.img.save(os.path.join(fr_dir, f'{g}_{i}.png'))
        fmeta[f'{g}_{i}'] = {'axis': [fr.axis[0], fr.axis[1]]}
    meta['frames'] = fmeta
    with open(os.path.join(wip_dir, 'draft.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


def load_draft(wip_dir: str) -> tuple[dict[tuple[int, int], Frame], set[int]]:
    """读草稿 → (替换帧 dict, 已固定动作号集)。无草稿 → ({}, set())。"""
    dj = os.path.join(wip_dir, 'draft.json')
    if not os.path.isfile(dj):
        return {}, set()
    with open(dj, encoding='utf-8') as f:
        meta = json.load(f)
    fr_dir = os.path.join(wip_dir, 'frames')
    frames: dict[tuple[int, int], Frame] = {}
    for key, info in (meta.get('frames') or {}).items():
        parts = str(key).split('_')
        if len(parts) != 2:
            continue
        try:
            g, i = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        png = os.path.join(fr_dir, f'{g}_{i}.png')
        if not os.path.isfile(png):
            continue
        img = Image.open(png).convert('RGBA')
        img.load()
        ax = (info or {}).get('axis', [0, 0])
        frames[(g, i)] = Frame(g, i, img, (int(ax[0]), int(ax[1])))
    locked = {int(a) for a in (meta.get('locked') or [])}
    return frames, locked
