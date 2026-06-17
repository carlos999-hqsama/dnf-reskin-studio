// DNF 业务规则契约测试 — skin 识别 / 补丁命名 / 装备枚举 / 骨架变体聚类。
// (目录 IO 走 preview OPFS 验证; 这里测 dnf-rules.ts 的纯函数/纯逻辑。)
import { describe, it, expect } from 'vitest';
import {
  parseSkin, patchName, isHideSource, hidePatchName, skeletonVariants, expandToVariants, coreSourceImg,
  subjectType, isEffectImg, editableImgs, deployTargets, patchNameForSubject, subjectLabel, subjectZh,
  buildReplacements, imgName, type EncodedFrame,
} from '../src/dnf-rules';
import type { DnfManifest, ManifestFrame } from '../src/engine';

function frame(img: number, fi: number, pw: number, ph: number, ox: number, oy: number, linked = false): ManifestFrame {
  return {
    img_index: img, img_name: `img${img}`, frame_index: fi, file: `img${img}_${fi}.png`,
    offset_x: ox, offset_y: oy, frame_width: pw, frame_height: ph, pic_width: pw, pic_height: ph,
    format: 14, compressed: false, linked, link_to: linked ? 0 : -1,
  };
}
function manifest(frames: ManifestFrame[]): DnfManifest {
  return { source_npk: '/x.NPK', export_time: '', frames };
}

describe('parseSkin / patchName', () => {
  it('识别 skin NPK → 职业 + 中文名', () => {
    expect(parseSkin('sprite_character_fighter_equipment_avatar_skin.NPK')).toEqual(
      { fileName: 'sprite_character_fighter_equipment_avatar_skin.NPK', klass: 'fighter', zh: '格斗家' });
    expect(parseSkin('sprite_character_imperialknight_equipment_avatar_skin.npk')?.zh).toBe('帝国守卫');
  });
  it('非 skin NPK → null', () => {
    expect(parseSkin('sprite_character_fighter_equipment_avatar_coat.NPK')).toBeNull();
    expect(parseSkin('%27_fighter_skin_reskin.NPK')).toBeNull();
    expect(parseSkin('random.NPK')).toBeNull();
  });
  it('未知职业 → 代号当中文名兜底', () => expect(parseSkin('sprite_character_xyz_equipment_avatar_skin.NPK')?.zh).toBe('xyz'));
  it('补丁名 % 开头 (覆盖机制)', () => expect(patchName('fighter')).toBe('%27_fighter_skin_reskin.NPK'));
});

describe('isHideSource / hidePatchName (按职业隐藏装备)', () => {
  it('该职业装备 avatar + 武器 weapon(含 atequipment) → 是', () => {
    expect(isHideSource('sprite_character_fighter_equipment_avatar_coat.NPK', 'fighter')).toBe(true);
    expect(isHideSource('sprite_character_fighter_atequipment_avatar_pants.NPK', 'fighter')).toBe(true);
    expect(isHideSource('sprite_character_fighter_equipment_weapon_knuckle.NPK', 'fighter')).toBe(true);
  });
  it('skin 本体 / 别职业 / 非外观槽 / % 补丁 → 否', () => {
    expect(isHideSource('sprite_character_fighter_equipment_avatar_skin.NPK', 'fighter')).toBe(false); // 本体要留
    expect(isHideSource('sprite_character_mage_equipment_avatar_coat.NPK', 'fighter')).toBe(false);    // 别职业, 绝不波及
    expect(isHideSource('sprite_character_fighter_growtype.NPK', 'fighter')).toBe(false);              // 非外观
    expect(isHideSource('%27_fighter_hide.NPK', 'fighter')).toBe(false);                               // 我们的补丁
  });
  it('职业前缀不互相误伤 (knight ≠ imperialknight)', () => {
    expect(isHideSource('sprite_character_imperialknight_equipment_avatar_coat.NPK', 'knight')).toBe(false);
    expect(isHideSource('sprite_character_imperialknight_equipment_avatar_coat.NPK', 'imperialknight')).toBe(true);
  });
  it('hidePatchName % 开头', () => expect(hidePatchName('fighter')).toBe('%27_fighter_hide.NPK'));
});

describe('skeletonVariants (同骨架聚类)', () => {
  const m = manifest([
    frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3),  // img0
    frame(1, 0, 10, 20, 2, 3), frame(1, 1, 10, 20, 2, 3),  // img1 同签名
    frame(2, 0, 99, 99, 0, 0),                             // img2 不同
  ]);
  it('img0/img1 逐帧 size+axis 全同 → 同骨架; img2 不同 → 排除', () => {
    expect(skeletonVariants(m, 0)).toEqual([0, 1]);
    expect(skeletonVariants(m, 2)).toEqual([2]);
  });
});

describe('expandToVariants (替换帧铺到所有变体)', () => {
  const enc = (n: number) => new Uint8Array([n]);
  const encoded = new Map([
    [0, { png: enc(0), axis: [2, 3] as const, size: [10, 20] as const }],
    [1, { png: enc(1), axis: [2, 3] as const, size: [10, 20] as const }],
  ]);
  it('铺到所有同骨架变体的对应帧', () => {
    const m = manifest([
      frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3),
      frame(1, 0, 10, 20, 2, 3), frame(1, 1, 10, 20, 2, 3),
    ]);
    const reps = expandToVariants(m, 0, encoded);
    expect(reps.map((r) => `${r.imgIndex},${r.frameIndex}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });
  it('跳过变体里 linked 的帧 (无独立像素, repack 从源保留)', () => {
    const m = manifest([
      frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3),
      frame(1, 0, 10, 20, 2, 3), frame(1, 1, 10, 20, 2, 3, true), // img1 f1 linked
    ]);
    const reps = expandToVariants(m, 0, encoded);
    expect(reps.map((r) => `${r.imgIndex},${r.frameIndex}`).sort()).toEqual(['0,0', '0,1', '1,0']);
  });
});

describe('coreSourceImg (智能选本体源)', () => {
  it('占优骨架簇(本体变体堆) + 特殊皮肤 → 选簇代表(最小 group), 避开特殊皮肤', () => {
    // img0/1/2 同骨架(本体变体), img3 几何各异(特殊皮肤) → 选 0 (不选可能排前的特殊皮肤)
    const m = manifest([
      frame(0, 0, 10, 20, 2, 3), frame(1, 0, 10, 20, 2, 3), frame(2, 0, 10, 20, 2, 3),
      frame(3, 0, 99, 99, 0, 0),
    ]);
    expect(coreSourceImg(m)).toBe(0);
  });
  it('单簇多变体(全同骨架, 如帝国守卫 2 个 ik_body) → 选最小 group', () => {
    const m = manifest([frame(1, 0, 10, 20, 2, 3), frame(2, 0, 10, 20, 2, 3)]);
    expect(coreSourceImg(m)).toBe(1);
  });
  it('真·多动作角色(各簇=1, 无占优) → 兜底第一个有真实帧 IMG, 不误伤', () => {
    const m = manifest([frame(0, 0, 10, 20, 0, 0), frame(1, 0, 30, 40, 0, 0), frame(2, 0, 50, 60, 0, 0)]);
    expect(coreSourceImg(m)).toBe(0);
  });
  it('跳过 linked-only 的 IMG, 只从有真实帧的里选', () => {
    // img0 全 linked(无独立像素), img1/2 同骨架真实帧 → 选 1
    const m = manifest([frame(0, 0, 10, 20, 2, 3, true), frame(1, 0, 10, 20, 2, 3), frame(2, 0, 10, 20, 2, 3)]);
    expect(coreSourceImg(m)).toBe(1);
  });
});

// ── 对象类型 (职业/怪物/宠物) 泛化 ────────────────────────────────────────────
const named = (img: number, fi: number, name: string, linked = false): ManifestFrame =>
  ({ ...frame(img, fi, 10, 20, 2, 3, linked), img_name: name });

describe('subjectType (对象类型识别)', () => {
  it('职业 skin → class', () => expect(subjectType('sprite_character_fighter_equipment_avatar_skin.NPK')).toBe('class'));
  it('怪物 → monster', () => expect(subjectType('sprite_monster_anton_phase3_po.NPK')).toBe('monster'));
  it('宠物 pet / creature → pet', () => {
    expect(subjectType('sprite_pet_falcon.NPK')).toBe('pet');
    expect(subjectType('sprite_creature_chn_dnf_time_gold.NPK')).toBe('pet');
  });
  it('% 补丁 / 地图 / 界面 / 职业装备 → null', () => {
    expect(subjectType('%27_sprite_monster_x.NPK')).toBeNull();
    expect(subjectType('sprite_map_town.NPK')).toBeNull();
    expect(subjectType('sprite_interface2_raid.NPK')).toBeNull();
    expect(subjectType('sprite_character_fighter_equipment_avatar_coat.NPK')).toBeNull(); // 装备非本体
  });
});

describe('isEffectImg (特效层判定 → 抠图留黑)', () => {
  it('含 effect / _eff 段 → 是', () => {
    expect(isEffectImg('sprite/creature/gold/03_random_01_eff_dodge.img')).toBe(true);
    expect(isEffectImg('sprite/monster/x/effect/boss.img')).toBe(true);
    expect(isEffectImg('04_call_eff_cha.img')).toBe(true);
  });
  it('纯身体 / 动作 IMG → 否', () => {
    expect(isEffectImg('sprite/creature/gold/00_stand.img')).toBe(false);
    expect(isEffectImg('quinbi_attack_0_0.img')).toBe(false);
    expect(isEffectImg('ft_body0000.img')).toBe(false);
  });
});

describe('editableImgs (可补丁 IMG)', () => {
  it('class → 只本体 coreSourceImg', () => {
    const m = manifest([named(0, 0, 'a/skin/body0000.img'), named(1, 0, 'a/skin/body0001.img')]); // 同骨架 → core=0
    expect(editableImgs(m, 'class')).toEqual([0]);
  });
  it('monster/pet → 所有真实动作 IMG, 排图标/道具桩 + linked-only', () => {
    const m = manifest([
      named(0, 0, 'sprite/monster/x/stand.img'),
      named(1, 0, 'sprite/monster/x/attack.img'),
      named(2, 0, 'sprite/item/stackable/icon.img'),       // 道具图标桩 → 排除
      named(3, 0, 'sprite/monster/x/dead.img', true),      // 全 linked → 无真实帧, 不出现
    ]);
    expect(editableImgs(m, 'monster')).toEqual([0, 1]);
  });
});

describe('deployTargets (写到哪些 IMG)', () => {
  const m = manifest([
    frame(0, 0, 10, 20, 2, 3), frame(1, 0, 10, 20, 2, 3),  // 同骨架
    frame(2, 0, 99, 99, 0, 0),                             // 各异
  ]);
  it('class → 同骨架变体全铺', () => expect(deployTargets(m, 'class', 0)).toEqual([0, 1]));
  it('monster/pet → 只它自己 (不联动)', () => {
    expect(deployTargets(m, 'monster', 0)).toEqual([0]);
    expect(deployTargets(m, 'pet', 1)).toEqual([1]);
  });
});

describe('patchNameForSubject (补丁命名)', () => {
  it('class → %27_<职业>_skin_reskin', () =>
    expect(patchNameForSubject('class', 'sprite_character_fighter_equipment_avatar_skin.NPK', 'fighter')).toBe('%27_fighter_skin_reskin.NPK'));
  it('monster/pet → %27_<原名> 覆盖原包', () => {
    expect(patchNameForSubject('monster', 'sprite_monster_anton_phase3_po.NPK')).toBe('%27_sprite_monster_anton_phase3_po.NPK');
    expect(patchNameForSubject('pet', 'sprite_pet_falcon.npk')).toBe('%27_sprite_pet_falcon.NPK');
  });
});

describe('subjectLabel / subjectZh (展示名 + 汉化)', () => {
  it('去前缀/日期 → 干净展示名', () => {
    expect(subjectLabel('sprite_monster_gcontents_210128_ilrustrea_boss_quinbi.NPK')).toBe('ilrustrea boss quinbi');
    expect(subjectLabel('sprite_pet_falcon.NPK')).toBe('falcon');
  });
  it('命中词表 → 中文; 否则展示名兜底', () => {
    expect(subjectZh('sprite_pet_falcon.NPK', 'pet')).toBe('猎鹰');
    expect(subjectZh('sprite_monster_anton_phase3_po.NPK', 'monster')).toBe('安徒恩');
    expect(subjectZh('sprite_monster_unknownboss_x.NPK', 'monster')).toBe('unknownboss x'); // 没命中 → 展示名
  });
  it('class 用 CLASS_ZH', () => expect(subjectZh('sprite_character_fighter_equipment_avatar_skin.NPK', 'class')).toBe('格斗家'));
});

describe('buildReplacements (通用 deploy 展开)', () => {
  const enc = (n: number): EncodedFrame => ({ png: new Uint8Array([n]), axis: [1, 2], size: [3, 4] });
  it('class → 铺到同骨架变体', () => {
    const m = manifest([
      frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3),
      frame(1, 0, 10, 20, 2, 3), frame(1, 1, 10, 20, 2, 3),    // img1 同骨架
    ]);
    const reps = buildReplacements(m, 'class', new Map([[0, new Map([[0, enc(0)], [1, enc(1)]])]]));
    expect(reps.map((r) => `${r.imgIndex},${r.frameIndex}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
  });
  it('monster → 多源各自独立, 不铺别 IMG, frame_index 跨 IMG 不撞', () => {
    const m = manifest([
      frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3),    // 动作0 (2帧)
      frame(1, 0, 50, 60, 0, 0),                               // 动作1 几何各异
    ]);
    const reps = buildReplacements(m, 'monster', new Map([
      [0, new Map([[0, enc(0)]])],
      [1, new Map([[0, enc(9)]])],   // frame_index 同为 0, 但 img 不同 → 各归各
    ]));
    expect(reps.map((r) => `${r.imgIndex},${r.frameIndex}`).sort()).toEqual(['0,0', '1,0']);
    expect(reps.find((r) => r.imgIndex === 1)!.png[0]).toBe(9);  // 没串源
  });
  it('跳过目标里 linked 的帧 (无独立像素)', () => {
    const m = manifest([frame(0, 0, 10, 20, 2, 3), frame(0, 1, 10, 20, 2, 3, true)]); // f1 linked
    const reps = buildReplacements(m, 'monster', new Map([[0, new Map([[0, enc(0)], [1, enc(1)]])]]));
    expect(reps.map((r) => `${r.imgIndex},${r.frameIndex}`)).toEqual(['0,0']);
  });
});

describe('imgName 解码 + 真数据桩过滤 (引擎 _2F/_2E 文件名编码)', () => {
  it('imgName 把 _2F→/ 、_2E→. 还原', () => {
    const m = manifest([named(0, 0, 'sprite_2Fmonster_2Fx_2Fpo_2Eimg')]);
    expect(imgName(m, 0)).toBe('sprite/monster/x/po.img');
  });
  it('editableImgs 在编码名上也能排掉 item/icon 桩 (真数据)', () => {
    const m = manifest([
      named(0, 0, 'sprite_2Fmonster_2Fx_2Fstand_2Eimg'),
      named(1, 0, 'sprite_2Fitem_2Fstackable_2Ficon_2Eimg'),  // 编码的图标桩 → 仍应排除
    ]);
    expect(editableImgs(m, 'monster')).toEqual([0]);
  });
  it('isEffectImg 配 imgName 解码 → 编码的 effect 段也判得出', () => {
    const m = manifest([named(0, 0, 'sprite_2Fmonster_2Fx_2Feffect_2Fboss_2Eimg')]);
    expect(isEffectImg(imgName(m, 0))).toBe(true);
  });
});
