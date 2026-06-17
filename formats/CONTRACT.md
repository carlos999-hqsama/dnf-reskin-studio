# 格式层契约 (formats/CONTRACT.md)

> 接新游戏 (如 DNF) = 在 `formats/` 下照 `mugen.py` 写个新模块 (如 `dnf.py`),
> 实现下面 **7 个约定签名的普通函数**, 然后把用到它的地方 `from formats import dnf as fmt`。
> **`core/` 和 `web/` 一行不动。** 不搞抽象基类 / 注册表 / detect 自动发现。

格式模块只负责"字节 ↔ `core.model` 数据结构"的翻译。所有几何/对齐/切片/去背/横图/
GIF/打包编排/恒等回环自检都在 `core/`, 格式层不碰。

## 必须暴露的 7 个函数

```python
from core.model import Frame, SpriteSet, Action, Project

def detect(char_dir: str) -> bool:
    """这个目录是不是本格式的一个角色?
       MUGEN: 有 Sprite.sff + Anim.air。"""

def list_chars(root: str) -> list[dict]:
    """扫描根目录下所有本格式角色 → [{'path':..., 'name':...}], 按 name 排序。"""

def load(char_dir: str, sprite_path: str | None = None) -> Project:
    """读一个角色 → Project (解码全部精灵 sprites: SpriteSet +
       动作序列 actions: dict[int, Action] + 核心动作号 core_action_ids: list[int])。
       每个 Frame.img 是 RGBA PIL.Image (index0→透明已应用), Frame.axis 是 (x, y) 锚点。
       sprite_path: 可选, 指定从哪个精灵文件读帧 (默认角色目录内的)。M3 把补丁文件覆盖回
       原目录后, 服务层传【原版备份】路径, 让工具始终编辑真·原版 (原始锚点常驻)。"""

def write(frames: list[Frame], out_path: str) -> int:
    """把若干 Frame 写成本格式的精灵文件, 返回字节数。
       MUGEN: write_sffv2(PNG32)。"""

def sprite_file(char_dir: str) -> str:
    """游戏运行时加载的精灵文件路径 (MUGEN: <dir>/Sprite.sff)。
       M2 备份原版 / M3 装回原目录靠它定位"哪个文件是精灵" —— 换格式即换定位规则。"""

def copy_support_files(src_dir: str, out_dir: str) -> list[str]:
    """拷贝补丁后角色要的非精灵文件 (判定/指令/音效/调色板等), 返回拷贝清单。
       MUGEN: .air/.cmd/.cns/.def/.snd/.st + Palettes/。"""

def verify(out_path: str) -> SpriteSet:
    """回读自检: 写出的精灵文件能否被独立解析器读回, 返回 SpriteSet。
       MUGEN: read_sffv2_all。core.pack 用它校验替换帧全在 + 恒等回环一致率。"""
```

## 数据结构 (core/model.py, 详见 ARCHITECTURE.md §2)

- `Frame(group:int, image:int, img:RGBA Image, axis:(x,y))` — 一张精灵帧。
- `SpriteSet` — `(group,image) → Frame` 查询容器, `get(group, image)` / dict 风格迭代。
- `Action(id:int, name:str, frames:[(group,image,offx,offy,dur),...])` — 一个动作的帧序列。
- `Project(name, source_dir, sprites:SpriteSet, actions:dict[int,Action], core_action_ids:list[int])`。

## core 怎么用这 6 个函数

- `server.py` / `cli/`: `fmt.detect` 判目录、`fmt.list_chars` 扫描、`fmt.load` 读角色。
- `core.pack.pack(fmt, project, replace, out_dir)`: 调 `fmt.write` 写精灵 + `fmt.copy_support_files`
  拷支撑文件 + `fmt.verify` 回读校验。**这是通用层与格式层的唯一交互点。**
- `core.persist` (格式无关, 渐进补丁闭环): 草稿落盘/恢复(M1 固定生效)、原版备份/还原(M2)、
  装回写回(M3 把 `pack` 产物覆盖到 `fmt.sprite_file(source_dir)`)。只认 `Frame` + 路径, 不碰格式字节。

## 给 DNF 作者的提示

- DNF 用 NPK/IMG 容器, 解码后同样产出 `Frame` (img=RGBA, axis=该帧定位点)。
- `core_action_ids` 是"核心身体集"白名单 (给导出过滤用), 语义由格式层定 (MUGEN 用 CORE_ACTIONS 表)。
- 若新格式没有 .act 共享调色板 / PCX 这类坑, `load` 直接用 PIL 解码即可; MUGEN 的
  `_pcx_decode` 行边界截断修复是 SFFv1/PCX 专属, 别照抄到无关格式。
