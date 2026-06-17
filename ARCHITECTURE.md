# ARCHITECTURE — dnf-reskin-studio

## 分层与数据流

```
玩家 ──拖 AI 图──┐
                 ▼
  web/ (原生 ES module UI)  ──HTTP──▶  server.py (本地 HTTP :8773)
                                          │
                          ┌───────────────┼────────────────┐
                          ▼               ▼                ▼
                     core/ (格式无关)   formats/dnf.py   _win/ 运维脚本
                     几何/抠图/对齐/    (契约实现)        (隐藏包/部署/回滚)
                     打包/持久化/分组        │
                                            ▼ subprocess
                                   KoishiEx CLI (dnf-reskin.exe)
                                   ← 源码在 ~/Documents/OPENCODE (独立仓)
                                            │
                                            ▼
                              DNF NPK/IMG  ←→  PNG + offset(manifest.json)
```

**一句话**：`core/` 干所有格式无关的图像 / 几何活；`formats/dnf.py` 把"啃 NPK/IMG 二进制"这块委托给 C++ 引擎；`web/` 只是界面。语言边界 = 进程边界（只 subprocess 调 exe，不写 FFI）。

## 契约边界（可替换层）

格式专属逻辑全部隔离在 `formats/dnf.py`，实现 `formats/CONTRACT.md` 定义的契约函数（`detect / list_chars / load / write / sprite_file / copy_support_files / verify`）。

**接一个新格式 = 只写一个 `formats/<x>.py` 实现这套契约 + 让 server `import` 它**，`core/` 一行不改。这正是当初 DNF 复用 AFA 架构、以及现在 DNF 能独立的原因 —— KOF(`formats/mugen.py`) 和 DNF(`formats/dnf.py`) 就差这一个模块。

## 对齐口径（唯一权威）

脚底锚定（新精灵底部中心对齐原版 basePt）是对齐的唯一口径，纯几何函数 `core/importer.py:foot_anchor_axis()`，有契约测试 `tests/test_core_contract.py::TestFootAnchorAxis` 护着。DNF 在 `server.py` 的 `do_import` 里先硬化 alpha（`_conform_to_dnf`）再调它。

## DNF 模型映射

- 补丁单位 = 一个工作目录，内含一个目标 `.NPK`（从游戏 `ImagePacks2` 拷出，客户端原文件不碰）。
- `Frame.group` = IMG 序号，`Frame.image` = IMG 内帧序号，`Frame.axis` = DNF basePt。
- 每个 IMG → 一个 `Action`。`.ani`（帧时序 / 判定）全程不读不写。
- 同骨架皮肤变体（几何一致、像素不同）默认只露一个本体代表编辑，部署时 `_skeleton_variants` 自动铺到全部变体。

## Windows 部署布局（运行态）

工具实际运行在 Windows（`D:\dnf-reskin\`，KoishiEx 须 MSVC 编）。`server.py` 顶部路径默认按该布局，均可环境变量覆盖：

| 配置 | 默认 | 含义 |
|---|---|---|
| `DNF_WORK_ROOT` | `D:\dnf-reskin\work` | 角色工作目录（扫这里列角色） |
| `DNF_IMAGEPACKS2` | 客户端 `…\ImagePacks2` | 部署目标 + 隐藏包枚举来源 |
| `DNF_HIDE_SCRIPT` | `_win/make_hide_patch.py` | 隐藏包生成脚本 |
| `DNF_RESKIN_CLI` | `D:\dnf-reskin\OPENCODE\build\Release\dnf-reskin.exe` | C++ 引擎（见 `formats/dnf.py`） |

部署机制：回封的本体包 + 隐藏包改 `%` 名直接丢进 `ImagePacks2`（`%` 排最前 → 覆盖原版加载，**只新增不碰客户端原文件**），重启游戏生效。

## 解耦由来 & 未来方向

- **2026-06-16 阶段0**：从 `afa-sprite-studio` 解耦，DNF 自带 `core/` 副本独立。剥离了 KOF 件（`mugen.py` / KOF 测试 / `conftest` 的拳皇角色根）。`afa-sprite-studio` 保持不动继续当 KOF 试金石。
- **方向**：浏览器自助化（`core/` 走 TS+Canvas 重写、KoishiEx 编 WASM、File System Access 选 DNF 目录、AI 交玩家、服务器零负担）。（浏览器自助化是项目演进方向）。
