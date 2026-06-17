# DNF 补丁工程结构 (D:\dnf-reskin)

AI 把 DNF 角色本体重绘补丁 → 回封 NPK → 丢进游戏。两层架构: C++ CLI 啃 NPK/IMG 二进制,
Python 工具做 UI + 切片对齐 + 编排; 语言边界 = 进程边界 (Python subprocess 调 exe, PNG+offset 当交换格式)。

## 目录布局
- `OPENCODE/`           — C++ CLI 源 (KoishiEx 引擎 + 自写 unpack/repack/hide/list)。产物
                          `OPENCODE/build/Release/dnf-reskin.exe`。
- `afa-sprite-studio/`  — Python web 工具 (浏览器 localhost:8773)。
  - `server.py`         — HTTP 薄路由 (⚠️ **DNF 专用分叉**, `from formats import dnf`)。
  - `core/`             — 格式无关: 几何/渲染/抠图/导入对齐/打包。
  - `formats/dnf.py`    — DNF 格式层 (7 契约函数, subprocess 调 CLI)。
  - `web/`              — 原生 ES module 前端 (无构建步骤, 改完刷新即生效)。
  - `out/`              — 打包/部署中转产物 (可删, 用时重建)。
- `work/`               — 角色工作目录 (从 ImagePacks2 拷出的目标 NPK; 工具扫这里列角色)。
- `make_hide_patch.py`  — 生成"隐藏某职业全部时装"的覆盖包 (装备隐藏→本体露出)。
- `start_dnf_tool.bat`  — 启动工具 (三九双击; ssh 起的进程随会话死)。
- `verify_segimport.py` — 按组导回的 HTTP 验证脚本。
- `_scratch/`           — 归档的早期一次性诊断脚本 (alpha_check/diag_*/recolor_body…)。
- `_bak_segimport/`     — 改动前备份。

## 权威源 / 分叉 (改哪里 —— 重要)
- `core/` `web/` `formats/dnf.py`: **Mac 权威源** `(本地权威源)`,
  改完 `scp` 到 Windows 同路径; web 改只需刷新浏览器, py 改要重启服务。
- `server.py`: **只在 Windows 改** (DNF 分叉; Mac 那份是 MUGEN/AFA 的, 别覆盖)。
- `OPENCODE/`: Mac 权威源 `~/Documents/OPENCODE`, 在 Windows 用 MSVC+CMake 编译。

## 配置 (写死路径都收在这两处, 均可环境变量覆盖)
- `server.py` 顶部: `DEFAULT_ROOT`(角色目录 `DNF_WORK_ROOT`) / `IMAGEPACKS2`(客户端 `DNF_IMAGEPACKS2`)
  / `HIDE_SCRIPT`(`DNF_HIDE_SCRIPT`)。
- `formats/dnf.py`: `DNF_CLI`(CLI 路径 `DNF_RESKIN_CLI`)。

## 补丁流程 (工具里点几下)
1. 选角色 → 逐组 (九宫格) 导入 AI 图替换 (没换的帧保留原版)。
2. *(可选)* 「生成隐藏时装包」。
3. 「部署到游戏」(自动打包 + 改 `%` 名丢进 ImagePacks2 覆盖加载; 只新增不碰原文件)。
4. 重启游戏。

## 格式要点
- 转换: AI 全彩软边图 → 硬边 (DNF 是 1 位 alpha) + 留色; 颜色 ≤256 留 V4, 超了自动落 V2 全彩。
- 对齐: 新内容按每帧原版 basePt 定位 (预览和游戏同一坐标)。
- 部署: `%` 开头排最前覆盖原版; `.ani` 全程不碰 (保判定/帧时序)。
