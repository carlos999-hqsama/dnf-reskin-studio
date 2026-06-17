# browser/wasm/ — KoishiEx WASM 产物 (vendored, gitignored)

`dnf_reskin.js` + `dnf_reskin.wasm` 是 KoishiEx C++ 引擎编成的 WebAssembly, 浏览器/node 内
**纯客户端解 DNF NPK**(零服务器)。**不进 git**(构建产物 + 体积), 从源码重新生成:

来源: `~/Documents/OPENCODE` (C++/CMake, `wasm-poc` 分支)。

```bash
cd ~/Documents/OPENCODE
source ~/emsdk/emsdk_env.sh
emcmake cmake -S . -B build-wasm -DCMAKE_BUILD_TYPE=Release && cmake --build build-wasm -j4
cp build-wasm/dnf_reskin.js build-wasm/dnf_reskin.wasm \
   browser/wasm/  # 项目内相对路径
```

接法见 `../src/engine.ts` (MODULARIZE / EXPORT_NAME=DnfReskin / `ccall('unpack_npk',...)` + `Module.FS`)。

⚠️ 编译两个命门(已在引擎源修死, 改 wasm 时注意):
1. **32-bit 整数固定宽度** — 引擎 `typedef unsigned long b32` 在 Mac/Linux(LP64) 是 8 字节会打烂 NPK 解析, 必须 `uint32_t`。
2. **libpng 头版本** — vendor 自带 1.5 头别 shadow 系统/port 的 1.6, 否则静默写 0 字节 PNG。

验证(node): `dnf_reskin.wasm` 解 imperialknight NPK = 300 帧, 与 native 逐字节一致 (见 `test/engine.test.ts`)。
