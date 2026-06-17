import { defineConfig } from 'vitest/config';

// wasm 解包 (~2s/包) 比纯算法慢, 放宽超时; 纯测试仍 ms 级不受影响。
export default defineConfig({
  test: { testTimeout: 30000 },
});
