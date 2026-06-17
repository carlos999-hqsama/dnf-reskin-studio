// openSubject 多动作编排测试 — 用 mock 引擎 (只 stub unpackMeta, 不碰 wasm/Canvas)。
// 验证: 怪物多动作拆分 / 宠物单动作 / 特效层标记 / 图标桩排除 / 非对象抛错。
// (Canvas 全链路 render→import→deploy 走 smoke + preview OPFS, 这里只测纯编排元数据。)
// openSubject 现走 AsyncEngine(Web Worker) → 返回 Promise, 测试 await。
import { describe, it, expect } from 'vitest';
import { openSubject } from '../src/workflow';
import type { AsyncEngine, DnfManifest, ManifestFrame } from '../src/engine';

function frame(img: number, fi: number, name: string, linked = false): ManifestFrame {
  return {
    img_index: img, img_name: name, frame_index: fi, file: `img${img}_${fi}.png`,
    offset_x: 10, offset_y: 40, frame_width: 40, frame_height: 50, pic_width: 40, pic_height: 50,
    format: 5, compressed: false, linked, link_to: linked ? 0 : -1,
  };
}
const manifest = (frames: ManifestFrame[]): DnfManifest => ({ source_npk: '/x.NPK', export_time: '', frames });
// openSubject 只调 unpackMeta → mock 它即可 (Promise 化, 不解像素)。
const mockEng = (m: DnfManifest): AsyncEngine => ({ unpackMeta: () => Promise.resolve(m) } as unknown as AsyncEngine);

describe('openSubject (多动作元数据)', () => {
  it('怪物 → 每个真实动作 IMG 一个 action, 图标桩排除', async () => {
    const m = manifest([
      frame(0, 0, 'sprite/monster/x/00_stand.img'), frame(0, 1, 'sprite/monster/x/00_stand.img'),
      frame(1, 0, 'sprite/monster/x/01_attack.img'),
      frame(2, 0, 'sprite/item/stackable/icon.img'),       // 图标桩 → 排除
    ]);
    const open = await openSubject(mockEng(m), new Uint8Array(), 'sprite_monster_anton_phase3_po.NPK');
    expect(open.type).toBe('monster');
    expect(open.zh).toBe('安徒恩');
    expect(open.actions.map((a) => a.imgIndex)).toEqual([0, 1]);   // icon 桩不在
    expect(open.actions[0]!.name).toBe('00_stand');
    expect(open.actions[0]!.cells.length).toBe(2);
    expect(open.actions[1]!.name).toBe('01_attack');
    expect(open.actions[0]!.segments.length).toBeGreaterThanOrEqual(1);
    expect(open.actions[0]!.targetH).toBeGreaterThan(0); // 几何各组渲染时现算; 这里只验动作级 targetH
  });

  it('宠物 falcon 单 IMG → 单 action', async () => {
    const fr: ManifestFrame[] = [];
    for (let i = 0; i < 9; i++) fr.push(frame(0, i, 'sprite/pet/falcon/falcon.img'));
    const open = await openSubject(mockEng(manifest(fr)), new Uint8Array(), 'sprite_pet_falcon.NPK');
    expect(open.type).toBe('pet');
    expect(open.zh).toBe('猎鹰');
    expect(open.actions.length).toBe(1);
    expect(open.actions[0]!.cells.length).toBe(9);
  });

  it('特效 IMG (_eff) 标 isEffect, 身体层不标', async () => {
    const m = manifest([
      frame(0, 0, 'sprite/creature/g/00_stand.img'),
      frame(1, 0, 'sprite/creature/g/03_eff_dodge.img'),
    ]);
    const open = await openSubject(mockEng(m), new Uint8Array(), 'sprite_creature_chn_gold.NPK');
    expect(open.actions.find((a) => a.imgIndex === 0)!.isEffect).toBe(false);
    expect(open.actions.find((a) => a.imgIndex === 1)!.isEffect).toBe(true);
  });

  it('replaced 跨动作累积键 = "img,frame" → 起始空', async () => {
    const m = manifest([frame(0, 0, 'a/00_stand.img'), frame(1, 0, 'a/01_walk.img')]);
    const open = await openSubject(mockEng(m), new Uint8Array(), 'sprite_monster_x.NPK');
    expect(open.actions.length).toBe(2);
    expect(open.replaced.size).toBe(0); // 键空间 "g,i" 由 importActionGrid 保证不撞 (见 buildReplacements 测试)
  });

  it('非可补丁对象 (地图/界面) → 抛错 (async reject)', async () => {
    await expect(openSubject(mockEng(manifest([])), new Uint8Array(), 'sprite_map_town.NPK')).rejects.toThrow();
  });
});
