# ARCHITECTURE — browser/ (浏览器自助补丁)

桌面版 (`../`) 是 Python core + 本地 server + KoishiEx CLI；这里是**纯客户端浏览器版**：
core 走 TS+Canvas 重写、NPK 解/封走 KoishiEx **wasm**、文件走 File System Access、服务器零负担。
对应关系见 `PORTING.md`。

## 分层与数据流

```
玩家 ──选 DNF 目录 / 拖 AI 图──┐
                               ▼
   main.ts          入口: 引擎单例(getEngine) + 挂工作台 + 装开发自检
        │
        ▼
   workbench.ts     UI 层: DOM / 事件 / 动画预览 / 背景色控件 (唯一碰页面 DOM 的产品代码)
        │ 调用 (纯数据进出, 无 DOM)
        ▼
   workflow.ts      编排: 列角色 → openChar 解包分组 → renderSegment 导出网格
        │           → importSegment 去背对齐累积 → deployChar 变体扩展+回封
   ┌────┼──────────┬───────────┬────────────┬──────────┐
   ▼    ▼          ▼           ▼            ▼          ▼
 core  engine    render     dnf-rules      fs        (import.ts 属 render)
 纯算法 wasm桥接  Canvas     DNF 规则       纯文件系统
 几何   解/封/    渲染/PNG   命名/skin识别  FSA+OPFS
 对齐   隐藏      /导入去背  /装备枚举      列名/读/写%补丁
 抠图    │                  /骨架变体
 分组    ▼                  /选本体
       KoishiEx wasm (public/wasm/dnf_reskin.wasm, 451KB)
       ← 源码 ~/Documents/OPENCODE `wasm-poc` 分支 (emscripten 编)
```

**一句话**：`workbench` 只管界面，`workflow` 串起整条补丁数据流（不碰页面 DOM → 可被 UI 和自检共用），
底下五层各管一摊。语言边界 = wasm 边界（NPK 二进制解/封交给 C++ 引擎编的 wasm，TS 只调 `ccall` + 读 MEMFS）。

## 依赖方向 (单向, 无环)

```
main → engine, workbench, dev-harness
workbench → workflow, dnf-rules, fs, render, core, engine(类型)
workflow → core, engine, render, import, dnf-rules, fs
dnf-rules → engine(仅类型 DnfManifest/Replacement)
fs → (无依赖, DNF 无关, 可复用)
core → (无依赖, 纯算法)
dev-harness / verify-opfs / reskin-demo → workflow + 各层 (仅开发期)
```

- **`fs-access.ts` 零 DNF 依赖**：只管目录 IO（`listFileNames`/`readNpk`/`writePatch`/`pickImagePacksDir`），
  鸭子兼容 `showDirectoryPicker`(真实目录) 与 `navigator.storage.getDirectory()`(OPFS, 给 preview 验)。
  "什么算 skin、补丁怎么命名" 这类规则在 `dnf-rules.ts`，"列哪类、怎么组合" 在 `workflow.ts`。
- **`core/` 零依赖纯算法**：model/geometry/align/matte/pixels/segment/layout，全 ≤95 行，有契约测试。

## DNF 专属知识收在两处 (可替换边界)

浏览器版不像桌面版有 `formats/` 插件层；DNF 专属逻辑收敛在：

1. **`dnf-rules.ts`** — 命名/识别规则单一权威源：`CLASS_ZH`(中文名) / `parseSkin`(skin 识别) /
   `patchName`+`hidePatchName`(% 覆盖补丁名) / `isHideSource`(按职业枚举装备) /
   `skeletonVariants`+`expandToVariants`(同骨架变体, 真机生效关键) / `coreSourceImg`(智能选本体)。
2. **engine 的 wasm** — NPK/IMG 二进制解封 (`unpack`/`repack`/`hideScan`/`hideBuild`)。

其余层 (core/render/fs/workflow 骨架) 格式无关。换个游戏格式 ≈ 换这两处。

## 对齐口径 (唯一权威)

脚底锚定 (新精灵底部中心对齐原版 basePt) 是唯一口径，纯几何函数 `align.ts` 的 `footAnchorAxis` /
`gridCellAxis`，有契约测试 `test/core.test.ts` 与 Python 版逐项等价护着。**手动逐帧对齐已否决**
(逐帧各调破坏帧间一致性、动画抖 → 纯自动脚底锚定)。导入去背前先 `conformToDnf` 硬化 alpha。

背景色: 角色撞绿底时换非绿纯色底 (`workbench` 底色控件)。导入端 `floodKey` 自适应去任何纯色底,
**非绿底自动跳 `despillGreen`** (它削任何 g>r&&g>b 像素, 会误伤绿色角色) — `importActionGrid` 的
`despill` 开关按 bgKey 是否绿系自动判。

## DNF 模型映射

- 补丁单位 = 选中的 `ImagePacks2` 目录里一个 skin `.NPK`（客户端原文件不碰, 只新增 `%` 补丁）。
- `Frame.group` = IMG 序号, `Frame.image` = IMG 内帧序号, `Frame.axis` = DNF basePt。`.ani` 不读不写。
- 同骨架皮肤变体默认只露一个本体代表编辑 (`coreSourceImg`), 部署时 `expandToVariants` 自动铺到全部变体。

## 验证三命脉 (反馈环)

| 命令 | 验什么 | 环境 | 为什么这样分 |
|---|---|---|---|
| `npm test` (vitest) | core + dnf-rules + import 串接的**纯算法/逻辑契约** | node | 不碰 Canvas/wasm; 精密对齐/规则逐项可测 |
| `npm run smoke` (tsx) | wasm engine **恒等回环** (unpack/repack/hide byte 级) | 真 node | ⚠️ **别用 vitest 测 wasm** — vitest sandbox 跟 emscripten glue 不合 (factory not a function) |
| `npm run dev` + preview | Canvas 渲染 + **FSA 数据流** (OPFS 真实验证整条工作台) | 真浏览器 | picker 弹窗留真机; OPFS 给同一套 handle 在 preview 跑通核心流 |
| `npm run typecheck` (tsc) | 类型护栏 (strict + noUncheckedIndexedAccess) | — | 重写精密逻辑的护栏 |

## wasm 重编命门 (改 OPENCODE 后)

`source ~/emsdk/emsdk_env.sh && emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release && cmake --build build-wasm`
→ 拷 `dnf_reskin.{js,wasm}` 到 `browser/{wasm,public/wasm}/` (gitignored, 重建见 `wasm/README.md`)。
两个坑 (已修死别回退): ① `b32` 必须 `uint32_t` 固定宽度 (LP64 坑); ② vendor libpng 1.5 头别被系统 1.6 shadow。

## 真机待验 (preview 验不了的, 留 Windows + DNF)

`showDirectoryPicker` 弹窗 (需用户手势+真目录) / 写出的 `%` 补丁丢进真 `ImagePacks2` 重启看本体补丁 +
对齐手感 (Canvas LANCZOS resize 与 PIL 不逐字节) / V4→V2 转过的本体 IMG 游戏认不认 / fighter ~0.6GB 装备料隐藏内存。
