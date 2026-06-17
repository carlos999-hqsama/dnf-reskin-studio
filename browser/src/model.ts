// 浏览器端 core 数据契约 — 对应 Python core/model.py。
// 纯几何/对齐层只需 size + axis; 像素(img)在 Canvas 实现里才用, 故可选(ImageData)。

export type Cell = readonly [group: number, image: number];
export type XY = readonly [x: number, y: number];

export interface Frame {
  group: number;
  image: number;
  /** [w, h] 像素尺寸 */
  size: XY;
  /** [x, y] 轴 = 脚底/定位锚点 (DNF basePt) */
  axis: XY;
  /** RGBA 像素; 纯几何/对齐不需要, Canvas 渲染/抠图才用 */
  img?: RGBA;
}

/** 轻量 RGBA 像素缓冲 — 鸭子兼容浏览器 ImageData (data = Uint8ClampedArray, 每像素 4 字节 r,g,b,a)。
 *  纯算法层在它上面抠图/合成, 不依赖真 Canvas → node/vitest 里造 plain object 即可测。 */
export interface RGBA {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** (group,image) → Frame 的查询容器 (薄封装 Map, 对应 core.model.SpriteSet)。 */
export class SpriteSet {
  readonly frames = new Map<string, Frame>();
  constructor(frames?: Iterable<Frame>) {
    if (frames) for (const f of frames) this.set(f);
  }
  private static key(g: number, i: number): string {
    return `${g},${i}`;
  }
  get(group: number, image: number): Frame | undefined {
    return this.frames.get(SpriteSet.key(group, image));
  }
  set(f: Frame): void {
    this.frames.set(SpriteSet.key(f.group, f.image), f);
  }
  has(group: number, image: number): boolean {
    return this.frames.has(SpriteSet.key(group, image));
  }
  get size(): number {
    return this.frames.size;
  }
}

/** 一个动作 (动画) 的帧序列。frames: [group, image, offx, offy, dur] per frame。 */
export interface Action {
  id: number;
  name: string;
  frames: ReadonlyArray<readonly [number, number, number, number, number]>;
}

/** 去重后的 (group,image), 保持首次出现顺序。对应 Action.unique_cells()。 */
export function uniqueCells(action: Action): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const f of action.frames) {
    const key = `${f[0]},${f[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([f[0], f[1]]);
    }
  }
  return out;
}

export interface Project {
  name: string;
  sourceDir: string;
  sprites: SpriteSet;
  actions: Map<number, Action>;
  coreActionIds: number[];
}
