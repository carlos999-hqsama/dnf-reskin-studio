"""tests/test_core_contract.py — core 管线契约 (合成 Frame, 不依赖真角色, ARCHITECTURE.md §6)

验几何/对齐/切片/去背数学:
- 几何: 最大外延算格尺寸 + 锚点 + scale。
- 渲染: render_cell 轴钉锚点 (轴对齐); build_strip 切片 n 格 + meta bbox。
- 去背: flood_bg 连通域吃渐变背景、不误伤角色孤岛。
- 导入: 注入 ±XY 漂移 → import_strip 反推轴 → 脚底Y/中心X 标准差回到 ~0。

可直接跑: .venv/bin/python tests/test_core_contract.py
"""
import io, os, sys, statistics, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image
from core.model import Frame, SpriteSet, Action, Project
from core.geometry import compute_geometry
from core import render
from core.matte import flood_bg, key_out
from core.importer import (import_strip, import_action_grid, frame_to_replacement,
                           canvas_at_axis, foot_anchor_axis)


def _solid_frame(g, i, w, h, axis, color=(200, 60, 60, 255)):
    """造一个纯色块帧 (周围透明) 当合成精灵。"""
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = color
    return Frame(g, i, img, axis)


class TestGeometry(unittest.TestCase):

    def test_max_extent(self):
        """格尺寸 = 各方向最大外延 + 2*margin; 锚点 = (maxL+MG, maxU+MG)。"""
        # 帧A: 20x40, 轴(10,30) → U=30 D=10 L=10 R=10
        # 帧B: 30x20, 轴(5,10)  → U=10 D=10 L=5  R=25
        ss = SpriteSet({
            (0, 0): _solid_frame(0, 0, 20, 40, (10, 30)),
            (0, 1): _solid_frame(0, 1, 30, 20, (5, 10)),
        })
        geo = compute_geometry(ss, [(0, 0), (0, 1)], maxcell=1000, margin=8)
        # maxU=30 maxD=10 maxL=10 maxR=25
        self.assertEqual(geo.cell_w, 10 + 25 + 16)   # 51
        self.assertEqual(geo.cell_h, 30 + 10 + 16)   # 56
        self.assertEqual(geo.anchor, (10 + 8, 30 + 8))  # (18, 38)
        self.assertEqual(geo.scale, 1.0)

    def test_scale_down(self):
        """超 maxcell 按比例缩, scale<1 且锚/格随之缩。"""
        ss = SpriteSet({(0, 0): _solid_frame(0, 0, 400, 400, (200, 200))})
        geo = compute_geometry(ss, [(0, 0)], maxcell=300, margin=8)
        self.assertLess(geo.scale, 1.0)
        self.assertLessEqual(max(geo.cell_w, geo.cell_h), 300)


class TestRenderCell(unittest.TestCase):

    def test_axis_pinned_to_anchor(self):
        """render_cell 把帧的轴钉到 geo.anchor: 轴处像素落在 anchor 像素。"""
        fr = _solid_frame(0, 0, 20, 40, (10, 30), color=(255, 0, 0, 255))
        geo = compute_geometry(SpriteSet({(0, 0): fr}), [(0, 0)], maxcell=1000, margin=8)
        cell = render.render_cell(fr, geo)
        ax, ay = geo.anchor
        # 轴落在内容矩形内 → anchor 像素应不透明 (红块)
        self.assertEqual(cell.load()[ax, ay][3], 255)
        # 内容左上角 = anchor - 轴
        bb = cell.split()[-1].getbbox()
        self.assertEqual(bb[0], ax - 10)   # 内容左边 = 锚x - 轴x
        self.assertEqual(bb[1], ay - 30)   # 内容上边 = 锚y - 轴y


class TestStrip(unittest.TestCase):

    def test_strip_cells_and_meta(self):
        """build_strip 切成 n 格, meta 每格记 (g,i) + content bbox。"""
        ss = SpriteSet({
            (0, 0): _solid_frame(0, 0, 20, 40, (10, 30)),
            (0, 1): _solid_frame(0, 1, 24, 36, (12, 28)),
        })
        act = Action(id=200, name='测试', frames=[(0, 0, 0, 0, 5), (0, 1, 0, 0, 5)])
        geo = compute_geometry(ss, act.unique_cells(), maxcell=1000)
        png, meta = render.build_strip(ss, act, geo, 'orig')
        self.assertEqual(meta['n'], 2)
        self.assertEqual(len(meta['cells']), 2)
        self.assertEqual(meta['cells'][0]['g'], 0)
        # 横图宽 = n * cell_w
        im = Image.open(io.BytesIO(png))
        self.assertEqual(im.width, 2 * geo.cell_w)


class TestMatte(unittest.TestCase):

    def test_flood_bg_eats_gradient_keeps_island(self):
        """连通域去背: 吃掉连到四角的渐变背景, 保留中心不连边的角色孤岛。"""
        w, h = 40, 40
        img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        px = img.load()
        # 背景: 渐变绿 (横向渐变, 连通到四角)
        for y in range(h):
            for x in range(w):
                px[x, y] = (0, 100 + x*3, 0, 255)
        # 角色孤岛: 中心一块红 (与背景硬边跳变, 不连四角)
        for y in range(15, 25):
            for x in range(15, 25):
                px[x, y] = (220, 30, 30, 255)
        out = flood_bg(img.copy(), tol=45)
        opx = out.load()
        # 四角应被清透明
        for c in ((0, 0), (w-1, 0), (0, h-1), (w-1, h-1)):
            self.assertEqual(opx[c][3], 0, f"角 {c} 未去背")
        # 中心角色块应保留 (孤岛)
        self.assertEqual(opx[20, 20][3], 255, "角色孤岛被误伤")

    def test_key_out(self):
        """色键: 抠掉与 key 同色的像素, 别的不动。"""
        img = Image.new('RGBA', (4, 1), (0, 0, 0, 0))
        px = img.load()
        px[0, 0] = (255, 0, 255, 255)   # 洋红 (要抠)
        px[1, 0] = (10, 200, 10, 255)   # 绿 (留)
        out = key_out(img, (255, 0, 255), 30)
        self.assertEqual(out.load()[0, 0][3], 0)
        self.assertEqual(out.load()[1, 0][3], 255)


class TestImportDriftCorrection(unittest.TestCase):
    """注入 ±XY 漂移 → 导入反推轴 → 脚底Y / 中心X 对齐回正 (标准差 ~0)。"""

    def _make_set(self):
        # 三帧同样大小同样轴 (脚底定位点一致), 用于横图
        ss = SpriteSet({
            (0, k): _solid_frame(0, k, 30, 60, (15, 55), color=(180, 60, 60, 255))
            for k in range(3)
        })
        act = Action(id=0, name='站立', frames=[(0, k, 0, 0, 5) for k in range(3)])
        return ss, act

    def test_drift_corrected_by_proportional_axis(self):
        ss, act = self._make_set()
        geo = compute_geometry(ss, act.unique_cells(), maxcell=1000)
        png, meta = render.build_strip(ss, act, geo, 'orig')

        # 构造"AI 横图": 每格内容随机平移 (±XY 漂移), 背景纯黑非透明
        strip = Image.open(io.BytesIO(png)).convert('RGBA')
        W, H = strip.size
        n = meta['n']; colW = W / n
        drifted = Image.new('RGBA', (W, H), (0, 0, 0, 255))   # 黑底 (要被 flood 吃)
        drifts = [(-7, 5), (4, -6), (8, 3)]
        for idx in range(n):
            col = strip.crop((round(idx*colW), 0, round((idx+1)*colW), H))
            # 取该格内容 (洋红标记先抠掉看真内容)
            from core.render import MARK
            col_clean = key_out(col.copy(), MARK, 60)
            bb = col_clean.split()[-1].getbbox()
            if not bb:
                continue
            content = col_clean.crop(bb)
            dx, dy = drifts[idx]
            # 贴回黑底, 加漂移
            paste_x = round(idx*colW) + bb[0] + dx
            paste_y = bb[1] + dy
            drifted.alpha_composite(content, (paste_x, paste_y))

        # 导入: flood_bg 去黑底 + 反推轴
        replace = import_strip(drifted, meta, flood_tol=80)
        self.assertEqual(len(replace), n, "应反推出全部帧的轴")

        # 验对齐: 各帧脚底 Y (轴y) 在等高归一后应一致 → 渲染后内容底边 Y 标准差 ~0
        bottoms, centers = [], []
        for fr in replace.values():
            cell = render.render_cell(fr, geo)
            bb = cell.split()[-1].getbbox()
            if not bb:
                continue
            bottoms.append(bb[3])               # 内容底边 (脚底贴地)
            centers.append((bb[0] + bb[2]) / 2)  # 内容中心 X
        # 漂移被纠正: 底边 / 中心 标准差应很小 (轴反推把 ±XY 漂移拉回)
        self.assertLessEqual(statistics.pstdev(bottoms), 2.0,
                             f"脚底Y 未对齐, stdev={statistics.pstdev(bottoms):.2f}")
        self.assertLessEqual(statistics.pstdev(centers), 2.0,
                             f"中心X 未对齐, stdev={statistics.pstdev(centers):.2f}")


class TestFrameToReplacement(unittest.TestCase):
    """CLI 路径: 规范化格图 → frame_to_replacement 恒等反推。"""

    def test_identity_axis(self):
        fr = _solid_frame(0, 0, 30, 60, (15, 55))
        geo = compute_geometry(SpriteSet({(0, 0): fr}), [(0, 0)], maxcell=1000)
        cell = render.render_cell(fr, geo)
        man_cell = {
            'group': 0, 'image': 0,
            'content_bbox': list(cell.split()[-1].getbbox()),
        }
        new_fr = frame_to_replacement(cell, man_cell, geo.cell_w, geo.cell_h, geo.anchor,
                                      mode='proportional')
        self.assertIsNotNone(new_fr)
        # 恒等: 渲染掩码字节相等
        self.assertEqual(canvas_at_axis(new_fr), canvas_at_axis(fr))


class TestActionGrid(unittest.TestCase):
    """网格闭环 (nano banana 友好导出): build_action_grid 产接近方形网格,
    import_action_grid 按每格位置精确切回。"""

    def _set(self, n):
        ss = SpriteSet({(0, k): _solid_frame(0, k, 30, 60, (15, 55)) for k in range(n)})
        act = Action(id=0, name='测试', frames=[(0, k, 0, 0, 5) for k in range(n)])
        return ss, act

    def test_grid_meta_and_roundtrip(self):
        """网格 meta 记每格位置 + 接近方形 + 绿底; 恒等导回全部帧。"""
        ss, act = self._set(5)
        geo = compute_geometry(ss, act.unique_cells(), maxcell=1000)
        png, meta = render.build_action_grid(ss, act, geo, 'orig')
        self.assertEqual(meta['n'], 5)
        self.assertEqual((meta['cols'], meta['rows']), (3, 2))   # ceil(sqrt5)=3, ceil(5/3)=2
        self.assertIn('cell_xy', meta['cells'][0])
        self.assertIn('W', meta)
        im = Image.open(io.BytesIO(png)).convert('RGBA')
        self.assertLess(max(im.size) / min(im.size), 2.0, "网格应接近方形(非长条)")
        self.assertEqual(im.getpixel((1, 1))[:3], (0, 255, 0), "应绿底")
        # 恒等导回: 网格图当 AI 返回图 → 反推全部帧
        replace = import_action_grid(im, meta)
        self.assertEqual(len(replace), 5)
        for k in range(5):
            self.assertIn((0, k), replace)

    def test_grid_import_resized(self):
        """AI 返回图尺寸常变 → 按比例映射每格仍切对全部帧。"""
        ss, act = self._set(4)
        geo = compute_geometry(ss, act.unique_cells(), maxcell=1000)
        png, meta = render.build_action_grid(ss, act, geo, 'orig')
        im = Image.open(io.BytesIO(png)).convert('RGBA')
        resized = im.resize((int(im.width * 0.8), int(im.height * 0.8)))
        replace = import_action_grid(resized, meta)
        self.assertEqual(len(replace), 4, "返回图缩放后仍应切对全部帧")


class TestFootAnchorAxis(unittest.TestCase):
    """脚底锚定唯一口径 (core.importer.foot_anchor_axis): 同尺寸→零偏移; 尺寸变→脚底落原位。
    这是对齐收口的契约护栏 —— DNF do_import 从内联公式抽到此函数, 行为必须逐项一致。"""

    def test_identity_same_size(self):
        # 同尺寸: 轴 = 原版 basePt 本身 (ΔX=ΔY=0)
        self.assertEqual(foot_anchor_axis((30, 60), (15, 55), (30, 60)), (15, 55))

    def test_narrower_keeps_horizontal_center(self):
        # 新宽少 4 → 水平保中心 → axis_x 右移 2; 同高 → axis_y 不变
        self.assertEqual(foot_anchor_axis((30, 60), (15, 55), (26, 60)), (17, 55))

    def test_shorter_keeps_bottom(self):
        # 新高少 6 → 脚底贴地 → axis_y 下移 6; 同宽 → axis_x 不变
        self.assertEqual(foot_anchor_axis((30, 60), (15, 55), (30, 54)), (15, 61))

    def test_smaller_both(self):
        self.assertEqual(foot_anchor_axis((30, 60), (15, 55), (26, 54)), (17, 61))

    def test_matches_old_inline_formula(self):
        """与 DNF server 旧内联公式逐项等价 = 收口不改行为的回归护栏。"""
        for osz, oax, nsz in [((30, 60), (15, 55), (26, 54)), ((41, 109), (20, 100), (39, 107)),
                              ((10, 20), (5, 18), (6, 16)), ((50, 50), (25, 49), (50, 50))]:
            opw, oph = osz; obx, oby = oax; npw, nph = nsz
            inline = (int(round(obx + (opw - npw) / 2.0)), int(round(oby + (oph - nph))))
            self.assertEqual(foot_anchor_axis(osz, oax, nsz), inline)


if __name__ == '__main__':
    unittest.main(verbosity=2)
