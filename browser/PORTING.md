# browser/ — Python core → TS 移植 + 分层 (浏览器自助化)

> **分层架构 / 依赖方向 / 验证三命脉 / wasm 重编命门 → 见 `ARCHITECTURE.md`。** 本文档记移植进度 + 真机待验。

## 为什么
浏览器自助化要把 `../core/` 搬进浏览器。不用 Pyodide(运行时 10-15MB 太重), 改 **TS + 浏览器原生 Canvas** 重写。
精密对齐逻辑有契约测试护栏 → 重写逐项验等价。NPK 解/封委托 KoishiEx **wasm** (零服务器)。

## 命令
- `npm test` — vitest 纯算法/纯逻辑契约 (54 测, node, 不碰 Canvas/wasm)
- `npm run smoke` — tsx 真 node 验 wasm engine (unpack/repack 恒等回环 + 替换; ⚠️ 别用 vitest 测 wasm)
- `npm run dev` — vite (:5174): 补丁工作台 + 开发自检 PoC
- `npm run typecheck` — tsc 严格 (strict + noUncheckedIndexedAccess)

## 七层 (详见 ARCHITECTURE.md)
| 层 | 文件 | 职责 |
|---|---|---|
| core | model/geometry/align/segment/matte/pixels/layout | 纯算法, 零依赖, 有契约测试 |
| engine | engine.ts | wasm 桥接 (unpack/repack/hideScan/hideBuild) |
| render | render-canvas/png/import | Canvas 渲染 + PNG + 导入去背对齐 |
| dnf-rules | dnf-rules.ts | DNF 规则单一权威源 (命名/识别/变体/选本体) |
| fs | fs-access.ts | 纯文件系统 (FSA+OPFS, DNF 无关可复用) |
| workflow | workflow.ts | 补丁编排 (无页面 DOM): open/render/import/deploy + 列角色 |
| ui | workbench.ts + main.ts | DOM/事件/动画/背景色控件 + 入口 |
| (dev) | dev-harness/verify-opfs/reskin-demo | 开发自检 (PoC 钩子 + OPFS 端到端 + 闭环 demo) |

## Python → TS 模块映射
| TS | Python | 内容 |
|---|---|---|
| model/geometry/align/segment/matte/pixels/layout | core/*.py | 几何/对齐/分组/去背/像素/布局 (逐项契约等价) |
| dnf-rules.ts | formats/dnf.py 角色 + server._skeleton_variants/_core_action_ids | parseSkin/patchName/isHideSource/CLASS_ZH/skeletonVariants/expandToVariants/coreSourceImg |
| engine.ts | formats/dnf.py 的 subprocess CLI | wasm 替代 (unpack/repack/hide) |
| render-canvas / import | core/render.py + importer.py | Canvas 像素合成 + 网格导入去背对齐 |
| workflow.ts | server.py 的 open/render/import/deploy 编排 | 补丁编排 |
| fs-access.ts | (新) File System Access | 目录 IO |

## 已完成
- ✅ **阶段1 wasm 可行性** — KoishiEx 编 wasm, native/node 逐字节 300/300 等价 (见 dnf-reskin-project 记忆)
- ✅ **阶段2 core TS 化** — 纯算法层逐项契约等价 (geometry/align/matte/pixels/segment/layout)
- ✅ **补丁三件事** — 导入串接 / 回封 wasm / File System Access UI (全程 preview 真浏览器验)
- ✅ **隐藏装备** (按职业, 省内存逐源扫描) + **分组导出** (9帧/组 3×3) + **动画预览** (Canvas 循环)
- ✅ **重构: 七层分层解耦** (2026-06-16) — `fs-app` 拆 `workflow`/`workbench`/`verify-opfs`, 规则抽 `dnf-rules`,
  `fs-access` 回归纯文件系统, main 钩子收 `dev-harness`; 最大文件 398→245 行, 依赖单向
- ✅ **P2 导出底色切换 + 选色补刀** — 撞绿换非绿纯色底, 非绿底自动跳 despill (不削绿误伤角色)
- ✅ **P2 智能选本体** — `coreSourceImg` 几何聚类占优簇代表, 避开特殊皮肤 (对应 `_core_action_ids`)

## 补丁三件事 (核心闭环)
1. **导入串接** (import.ts): AI 网格图 → 投影切格 → 去背(floodKey 自适应 + 条件 despill) → 内容 bbox → 缩放归一 → 脚底锚定反推轴。
2. **回封 wasm** (engine.repack): 源 NPK 当模板, 未改帧标 linked 保原字节, 替换帧硬边化+编码, V4 溢出自动转 V2。
3. **File System Access UI** (workbench/fs-access/dnf-rules): 选目录 → 列 skin → 导出/导入 → 骨架变体扩展 → 写 `%` 覆盖补丁 (只新增, 原文件不碰)。

## 真机待验 (preview 验不了的, 留 Windows + DNF)
- `showDirectoryPicker` 弹窗 (需用户手势 + 真目录; 拿到 handle 后的列/读/写已用 OPFS 在 preview 验通)。
- 写出的 `%` 补丁丢进真 `ImagePacks2` → 重启 DNF → 看本体补丁 + 对齐手感 (Canvas LANCZOS resize 与 PIL 不逐字节)。
- V4→V2 转过的本体 IMG 游戏认不认; fighter 真实 ~0.6GB 装备料隐藏内存 / 耗时。

## 未做 / 可增强 (按需, 非阻塞)
- `build_gif`: 动作 GIF **文件导出** (已用 Canvas 实时动画替代"看效果"预览; 仅想导出 GIF 分享才需, gif.js 自托管)。
- 手动逐帧微调: **已否决** (逐帧各调破坏帧间一致性、动画抖 → 纯自动脚底锚定; 桌面版那套 apply_adjust/build_overlay 不移植)。
