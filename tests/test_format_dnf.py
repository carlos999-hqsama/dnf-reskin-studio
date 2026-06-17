"""tests/test_format_dnf.py — DNF 格式层契约测试 (走真实 KoishiEx CLI + grappler 夹具)。

需要 Windows 环境: dnf-reskin.exe + D:\\dnf-reskin\\work\\grappler 里有 grappler.NPK。
没有就整体 skip(便于在 Mac/CI 上跳过, 不污染既有 MUGEN 测试)。
"""
import os
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

WORK = r'D:\dnf-reskin\work\grappler'
CLI = os.environ.get('DNF_RESKIN_CLI', r'D:\dnf-reskin\OPENCODE\build\Release\dnf-reskin.exe')

pytestmark = pytest.mark.skipif(
    not (os.path.isfile(CLI) and os.path.isdir(WORK)),
    reason="需要 Windows 的 dnf-reskin.exe + grappler 工作目录",
)


def _dnf():
    from formats import dnf
    return dnf


def test_detect_and_list():
    dnf = _dnf()
    assert dnf.detect(WORK)
    chars = dnf.list_chars(os.path.dirname(WORK))
    assert any(c['name'] == 'grappler' for c in chars)


def test_load_structure():
    dnf = _dnf()
    proj = dnf.load(WORK)
    assert len(proj.sprites) == 47          # grappler: 4 IMG × (7+8+12+20)
    assert len(proj.actions) == 4           # 一个 IMG 一个动作组
    assert proj.core_action_ids             # 非空
    # 每个 Frame: RGBA + 合理的轴
    g, i = next(iter(proj.sprites.frames))
    fr = proj.sprites.get(g, i)
    assert fr.img.mode == 'RGBA'
    assert isinstance(fr.axis, tuple) and len(fr.axis) == 2


def test_identity_roundtrip(tmp_path):
    """恒等回环: 全部原帧原样打包 → 回读 → 逐帧轴对齐掩码 100% 一致。"""
    dnf = _dnf()
    from core import pack as corepack
    proj = dnf.load(WORK)
    replace = dict(proj.sprites.frames)
    out_dir = str(tmp_path / 'packout')
    res = corepack.pack(dnf, proj, replace, out_dir, full=True)
    assert res['replaced'] == 47
    out_sff = os.path.join(out_dir, 'Sprite.sff')
    same, total, rate = corepack.identity_roundtrip_rate(dnf, proj, replace, out_sff)
    assert rate == 1.0, f"恒等回环只有 {same}/{total}"
