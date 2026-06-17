# -*- coding: utf-8 -*-
"""撤下已部署的补丁/隐藏补丁(move 到 stash, 重启游戏即还原)。只动我们写的 %27_ 补丁,
你自己下载的 %(...) mod 一律不碰。

用法:
  python undo_deploy.py                 # 撤下全部 %27_ 补丁 → 回到全原版
  python undo_deploy.py fighter         # 只保留格斗家的补丁, 撤掉其他所有职业
                                        #   → 解决"想只留格斗家素模, 结果全职业都素模了"
  python undo_deploy.py fighter mage    # 保留多个职业

职业代号: swordman/fighter/gunner/mage/priest/thief/knight/archer/demoniclancer/gunblader/imperialknight
"""
import os, shutil, sys

IP = r"E:\WeGameApps\地下城与勇士：创新世纪\ImagePacks2"
STASH = r"D:\dnf-reskin\afa-sprite-studio\out\_deployed_stash"
os.makedirs(STASH, exist_ok=True)

keep = {a.lower() for a in sys.argv[1:]}   # 要保留的职业代号(空 = 全撤)
moved = kept = 0
for fn in os.listdir(IP):
    if not (fn.startswith("%27_") and ("_hide.NPK" in fn or "_skin_reskin.NPK" in fn)):
        continue
    cls = fn[len("%27_"):].split("_")[0].lower()   # %27_fighter_hide.NPK -> fighter
    if cls in keep:
        print("保留", fn); kept += 1; continue
    shutil.move(os.path.join(IP, fn), os.path.join(STASH, fn)); print("撤下", fn); moved += 1

if keep:
    print("\n保留 %d 个(%s), 撤下 %d 个 → 重启游戏只剩保留职业生效, 其余职业恢复原版时装。"
          % (kept, "/".join(sorted(keep)), moved))
else:
    print("\n共撤下 %d 个补丁(留底到 out/_deployed_stash, 重启游戏即全还原)。你的 %%(...) mod 没动。" % moved)
