// openSubject 多动作编排测试 — 用 mock 引擎 (只 stub unpackMeta, 不碰 wasm/Canvas)。
// 验证: 怪物多动作拆分 / 宠物单动作 / 特效层标记 / 图标桩排除 / 非对象抛错。
// (Canvas 全链路 render→import→deploy 走 smoke + preview OPFS, 这里只测纯编排元数据。)
// openSubject 现走 AsyncEngine(Web Worker) → 返回 Promise, 测试 await。
import { describe, it, expect } from 'vitest';
import { openSubject, ensureActionContentStats } from '../src/workflow';
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

  it('ensureActionContentStats: targetH/家锚按【真实内容】算, 剔除帧图透明边 (修放大根因)', async () => {
    // 帧图 50×120, 轴(25,90); 但内容只在 [10,20)-(40,100) = 30×80, 四周透明边。
    const f: ManifestFrame = {
      img_index: 0, img_name: 'body', frame_index: 0, file: 'f.png',
      offset_x: 25, offset_y: 90, frame_width: 50, frame_height: 120, pic_width: 50, pic_height: 120,
      format: 5, compressed: false, linked: false, link_to: -1,
    };
    const open = await openSubject(mockEng(manifest([f])), new Uint8Array(), 'sprite_monster_x.NPK');
    // 注入解码缓存 (跳过 decodePng/Canvas): 50×120 RGBA, 内容矩形 [10,20)-(40,100) alpha=255。
    const W = 50, H = 120, data = new Uint8ClampedArray(W * H * 4);
    for (let y = 20; y < 100; y++) for (let x = 10; x < 40; x++) data[(y * W + x) * 4 + 3] = 255;
    open.imgDataByCell.set('0,0', { data, width: W, height: H } as unknown as ImageData);
    await ensureActionContentStats(open, open.actions[0]!);
    const a = open.actions[0]!;
    expect(a.targetH).toBe(80);   // 内容高 80, 不是帧图高 120 (按帧图算会放大)
    expect(a.baseDX).toBe(0);     // 轴x25 - 内容水平中心(10+40)/2=25 → 0
    expect(a.baseDY).toBe(-10);   // 轴y90 - 内容底100 → -10 (按帧图算会是 90-120=-30)
    expect(a.statsReady).toBe(true);
  });
});
