#!/usr/bin/env python3
"""make_hide_patch.py — 一键生成"隐藏某职业全部时装"的覆盖 NPK。

原理(从 mySuit/白猫 逆出来的): 把该职业所有装备 avatar 槽(coat/pants/shoes/belt/
neck/cap/hair/face, 含男女 equipment/atequipment)的每个 IMG 都覆盖成空透明帧
(帧 0 真空 + 其余链接到它, 体积小)。游戏照常加载时装槽但帧透明 = 看不见 = 隐藏。
排除 skin 槽(那是身体本体, 要留着显示重绘的皮)。

用法:
  python make_hide_patch.py <职业> <ImagePacks2目录> <输出.npk> [dnf-reskin.exe路径]
例:
  python make_hide_patch.py fighter "E:\\WeGameApps\\地下城与勇士:创新世纪\\ImagePacks2" D:\\dnf-reskin\\out\\fighter_hide.NPK
"""
import os
import subprocess
import sys

DEFAULT_CLI = r'D:\dnf-reskin\OPENCODE\build\Release\dnf-reskin.exe'


# 职业代号 → 中文名(仅显示/报告用; 文件名仍用代号, 游戏按代号匹配内部路径不能改)。
CLASS_ZH = {
    'swordman': '鬼剑士', 'fighter': '格斗家', 'gunner': '神枪手', 'mage': '魔法师',
    'priest': '圣职者', 'thief': '盗贼', 'knight': '守护者', 'archer': '弓箭手',
    'demoniclancer': '暗枪士', 'gunblader': '枪剑士', 'imperialknight': '帝国守卫',
}


def zh(cls: str) -> str:
    return CLASS_ZH.get(cls.lower(), cls)


def find_hide_sources(imagepacks2_dir: str, cls: str) -> list[str]:
    """该职业要隐藏的全部外观 NPK = 装备 avatar(上衣/裤子/头发…) + 武器 weapon(剑/枪/拳套…)。
    都含 atequipment(觉醒/二觉)版本。排除: skin(本体, 要留着显示重绘的身体) +
    growtype/effect(成长槽/技能特效, 不是覆盖身体的外观图层)。
    武器也隐藏: 重绘身体后, 武器握持点/图层会跟原版错位穿模, 藏掉最干净(三九要求)。"""
    prefix = f'sprite_character_{cls}'.lower()
    out = []
    for fn in os.listdir(imagepacks2_dir):
        fl = fn.lower()
        if not (fl.startswith(prefix) and fl.endswith('.npk')):
            continue
        is_avatar = 'equipment_avatar' in fl and 'avatar_skin' not in fl   # 含 atequipment_avatar
        is_weapon = 'equipment_weapon' in fl                                # 含 atequipment_weapon
        if is_avatar or is_weapon:
            out.append(os.path.join(imagepacks2_dir, fn))
    return sorted(out)


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 1
    cls, d, out = sys.argv[1], sys.argv[2], sys.argv[3]
    cli = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_CLI
    srcs = find_hide_sources(d, cls)
    if not srcs:
        print(f"[ERROR] 在 {d} 没找到职业 '{cls}'({zh(cls)}) 的装备/武器 NPK")
        return 1
    print(f"[INFO] 职业 {cls}({zh(cls)}): 隐藏 {len(srcs)} 个外观 NPK(装备 avatar + 武器 weapon)")
    for s in srcs:
        print("   -", os.path.basename(s))
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    # 原子写: 先写 .tmp, 跑完(rc==0)才改名到最终路径。中途被杀/打断只会留下 .tmp 残体,
    # 最终路径要么是上一份完整包、要么不存在 —— 绝不会把半截包当成"已生成"部署进游戏。
    tmp = out + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    r = subprocess.run([cli, 'hide', tmp, *srcs])
    if r.returncode == 0 and os.path.isfile(tmp):
        os.replace(tmp, out)
        mb = round(os.path.getsize(out) / 1024 / 1024, 2)
        print(f"[OK] 隐藏时装包 → {out} ({mb}MB)")
    elif os.path.isfile(tmp):
        os.remove(tmp)   # 失败/被杀 → 清掉残体, 不留垃圾
    return r.returncode


if __name__ == '__main__':
    sys.exit(main())
