"""tests/test_persist.py — core.persist 持久化契约 (M2 备份 + M1 草稿, 格式无关)

纯持久化数学 (合成 Frame, 不依赖真角色): save/load_draft 轴+帧回环; backup 已备不覆盖; restore 覆盖回。
(原 TestReskinFlow 服务层流程是 KOF/MUGEN 视角[真角色 + import server], 解耦独立项目时剥离;
 DNF 的服务层 persist 由 test_format_dnf 的恒等回环 + 实机覆盖验证。)

可直接跑: .venv/bin/python tests/test_persist.py
"""
import os, sys, shutil, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image
from core.model import Frame
from core import persist


def _frame(g, i, color, size=(20, 30), axis=(10, 28)):
    return Frame(g, i, Image.new('RGBA', size, color), axis)


class TestPersistUnit(unittest.TestCase):
    """纯持久化数学, 合成帧, 不依赖真角色。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='dnf_persist_')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_draft_roundtrip(self):
        wip = os.path.join(self.tmp, 'wip')
        frames = {(0, 0): _frame(0, 0, (255, 0, 0, 255), axis=(10, 28)),
                  (5, 2): _frame(5, 2, (0, 255, 0, 255), size=(40, 50), axis=(20, 47))}
        persist.save_draft(wip, frames, {0, 200})
        got, locked = persist.load_draft(wip)
        self.assertEqual(locked, {0, 200})
        self.assertEqual(set(got.keys()), {(0, 0), (5, 2)})
        self.assertEqual(got[(0, 0)].axis, (10, 28))
        self.assertEqual(got[(5, 2)].axis, (20, 47))
        self.assertEqual(got[(5, 2)].img.size, (40, 50))

    def test_draft_full_rewrite_drops_removed(self):
        wip = os.path.join(self.tmp, 'wip')
        persist.save_draft(wip, {(0, 0): _frame(0, 0, (1, 2, 3, 255)),
                                 (1, 1): _frame(1, 1, (4, 5, 6, 255))}, {0})
        persist.save_draft(wip, {(0, 0): _frame(0, 0, (1, 2, 3, 255))}, {0})   # 重写去掉 (1,1)
        got, _ = persist.load_draft(wip)
        self.assertEqual(set(got.keys()), {(0, 0)}, "全量重写应清掉已移除帧的 PNG")

    def test_load_draft_absent(self):
        got, locked = persist.load_draft(os.path.join(self.tmp, 'none'))
        self.assertEqual(got, {})
        self.assertEqual(locked, set())

    def test_backup_skip_if_exists(self):
        src = os.path.join(self.tmp, 'target.NPK'); bdir = os.path.join(self.tmp, 'bk')
        with open(src, 'wb') as f: f.write(b'ORIGINAL')
        self.assertTrue(persist.backup_sprite(src, bdir))
        with open(src, 'wb') as f: f.write(b'MODIFIED')      # 改源后再备份
        persist.backup_sprite(src, bdir)
        with open(persist.backup_path(src, bdir), 'rb') as f:
            self.assertEqual(f.read(), b'ORIGINAL', "已备过绝不覆盖 — 备份须恒为最初原版")

    def test_restore_overwrites_source(self):
        src = os.path.join(self.tmp, 'target.NPK'); bdir = os.path.join(self.tmp, 'bk')
        with open(src, 'wb') as f: f.write(b'ORIGINAL')
        persist.backup_sprite(src, bdir)
        with open(src, 'wb') as f: f.write(b'APPLIED')        # 模拟装回覆盖
        self.assertTrue(persist.restore_sprite(bdir, src))
        with open(src, 'rb') as f:
            self.assertEqual(f.read(), b'ORIGINAL')

    def test_restore_no_backup(self):
        self.assertFalse(persist.restore_sprite(
            os.path.join(self.tmp, 'nobk'), os.path.join(self.tmp, 'x.NPK')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
