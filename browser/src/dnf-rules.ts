// DNF 业务规则单一权威源 — 命名 / skin 识别 / 装备枚举 / 补丁命名 / 骨架变体聚类。
// 对应桌面版 formats/dnf.py 的角色: 把"什么是本体、怎么命名补丁、哪些是该隐藏的装备、
// 哪些 IMG 是同骨架"这些 DNF 专属知识收成一处。
//
// 纯函数 + 纯逻辑: 不碰文件系统 / DOM / Canvas, 只依赖 engine 的 manifest 类型 → 全可单测。
// fs-access(纯文件系统) 与 workflow(编排) 组合调用这里; 反向不依赖它们。
import type { DnfManifest, ManifestFrame, Replacement } from './engine';

// ── 职业命名 ──────────────────────────────────────────────────────────────────

/** 职业代号 → 中文名 (列角色/显示用; 文件名/路径仍用代号, 游戏按代号匹配)。搬自 formats/dnf.py CLASS_ZH。 */
export const CLASS_ZH: Record<string, string> = {
  swordman: '鬼剑士', fighter: '格斗家', gunner: '神枪手', mage: '魔法师',
  priest: '圣职者', thief: '盗贼', knight: '守护者', archer: '弓箭手',
  demoniclancer: '暗枪士', gunblader: '枪剑士', imperialknight: '帝国守卫',
};

// ── skin (本体) 识别 ─────────────────────────────────────────────────────────

// 本体 skin NPK = 没穿装备的身体 (avatar 的 skin 槽), 补丁主目标。见 dnf-reskin-project 记忆。
const SKIN_RE = /sprite_character_([a-z0-9]+)_equipment_avatar_skin\.npk$/i;

export interface SkinEntry {
  fileName: string;
  klass: string;
  zh: string;
}

/** 文件名 → skin 角色信息 (非 skin NPK 返回 null)。纯函数, 可单测。 */
export function parseSkin(fileName: string): SkinEntry | null {
  const m = SKIN_RE.exec(fileName);
  if (!m) return null;
  const klass = m[1]!.toLowerCase();
  return { fileName, klass, zh: CLASS_ZH[klass] ?? klass };
}

/** 构造某职业本体 skin NPK 文件名 (与 SKIN_RE 同一命名约定)。
 *  → listSkins 按【已知职业】直接 getFileHandle 探测, 免枚举整个上万文件的 ImagePacks2。 */
export function skinFileName(klass: string): string {
  return `sprite_character_${klass}_equipment_avatar_skin.NPK`;
}

// ── 补丁命名 (% 覆盖机制) ────────────────────────────────────────────────────

/** 补丁本体补丁名 = % 开头 → 排序最前抢加载覆盖原版。纯函数, 可单测。
 *  对应桌面版 deploy 的 %27_<职业>_skin_reskin.NPK。 */
export function patchName(klass: string): string {
  return `%27_${klass}_skin_reskin.NPK`;
}

/** 隐藏装备补丁名 = % 开头覆盖。对应桌面版 %27_<职业>_hide.NPK。 */
export function hidePatchName(klass: string): string {
  return `%27_${klass}_hide.NPK`;
}

// ── 装备隐藏源识别 ───────────────────────────────────────────────────────────

/** 是不是【该职业】要隐藏的外观源? = 该职业的装备 avatar(上衣/裤子/头发…含 atequipment) + 武器 weapon。
 *  排 skin(本体, 要留着显示重绘的身体) + growtype/effect(成长槽/特效, 非覆盖身体的外观)。
 *  ⚠️ 严格按职业前缀: 只藏指定职业, 绝不波及别的职业。对应桌面版 find_hide_sources。纯函数可测。 */
export function isHideSource(fileName: string, klass: string): boolean {
  const fl = fileName.toLowerCase();
  if (!(fl.startsWith(`sprite_character_${klass.toLowerCase()}_`) && fl.endsWith('.npk'))) return false;
  const isAvatar = fl.includes('equipment_avatar') && !fl.includes('avatar_skin'); // 含 atequipment_avatar, 排本体 skin
  const isWeapon = fl.includes('equipment_weapon');                                // 含 atequipment_weapon
  return isAvatar || isWeapon;
}

// 隐藏时装: 该职业要藏的 avatar 装备槽 token (排 skin 本体)。来自桌面版 make_hide_patch 逆向出来的槽位。
const AVATAR_HIDE_PARTS = ['coat', 'pants', 'shoes', 'belt', 'neck', 'cap', 'hair', 'face'] as const;

/** 构造该职业要隐藏的全部 avatar 装备 NPK 候选名 (equipment 普通 + atequipment 觉醒, 各槽各一)。
 *  → listHideSources 按名直取(getFileHandle), 免枚举上万文件整目录。武器命名按型号、不是固定 token,
 *  无法可靠盲构造, 故不在此 (要藏武器得拿到真实武器文件名)。对应桌面版 find_hide_sources 的 avatar 部分。 */
export function hideAvatarNames(klass: string): string[] {
  const k = klass.toLowerCase();
  const out: string[] = [];
  for (const eq of ['equipment', 'atequipment']) {
    for (const p of AVATAR_HIDE_PARTS) out.push(`sprite_character_${k}_${eq}_avatar_${p}.NPK`);
  }
  return out;
}

// ── 骨架变体聚类 (真机生效关键) ──────────────────────────────────────────────
// DNF avatar skin NPK 里大量 IMG 是【同一副骨架】的皮肤变体: 逐帧 size+axis 完全一致, 只像素不同
// (游戏按肤色/动画渲染不同的那个)。补丁只改一个变体 → 游戏渲染没改的那个 = 看着像没换
// (dnf-reskin-hide-fix 记忆 根因④)。部署时须把替换帧铺到所有同骨架变体。
// 对应桌面版 server.py 的 _skeleton_variants + _expand_replace_to_variants。

/** 一次遍历算出每个 IMG 的逐帧几何签名 (size+axis 序列, 按 frame_index 排序) → Map<imgIndex, sig>。
 *  同签名 = 同骨架。⚠️ 一趟建好, 避免"每个 IMG 重扫全部帧"的 O(n²) (大角色帧多会卡几十秒)。 */
function frameSigs(manifest: DnfManifest): Map<number, string> {
  const byImg = new Map<number, ManifestFrame[]>();
  for (const f of manifest.frames) {
    const arr = byImg.get(f.img_index);
    if (arr) arr.push(f); else byImg.set(f.img_index, [f]);
  }
  const sigs = new Map<number, string>();
  for (const [img, frames] of byImg) {
    frames.sort((a, b) => a.frame_index - b.frame_index);
    sigs.set(img, frames.map((f) => `${f.pic_width},${f.pic_height},${f.offset_x},${f.offset_y}`).join('|'));
  }
  return sigs;
}

/** 与 imgIndex 同骨架 (逐帧 size+axis 签名全同) 的所有 IMG 序号 (含自身, 升序)。 */
export function skeletonVariants(manifest: DnfManifest, imgIndex: number): number[] {
  const sigs = frameSigs(manifest);
  const target = sigs.get(imgIndex);
  return [...sigs.keys()].filter((g) => sigs.get(g) === target).sort((a, b) => a - b);
}

/** 智能选本体源 IMG — skin NPK 多是【同骨架皮肤变体】(几何全同) + 少量【特殊皮肤】(翅膀/披风, 几何各异)。
 *  按逐帧几何签名聚类: 占优簇(同骨架变体堆)的代表 = 本体, 避开特殊皮肤; 无占优(真·多动作角色)
 *  则取第一个有真实帧的 IMG, 不误伤。对应桌面版 formats/dnf.py 的 _core_action_ids
 *  (那边返回 core 列表当默认视图; 补丁只需单个本体源, 故收成一个代表)。
 *  比"取第一个非 linked IMG"准: 特殊皮肤 IMG 排在本体前时不会选错。 */
export function coreSourceImg(manifest: DnfManifest): number {
  const firstReal = manifest.frames.find((f) => !f.linked)?.img_index ?? 0;
  const realImgs = [...new Set(manifest.frames.filter((f) => !f.linked).map((f) => f.img_index))];
  if (realImgs.length <= 1) return firstReal;
  const sigs = frameSigs(manifest);
  const clusters = new Map<string, number[]>();
  for (const g of realImgs) {
    const s = sigs.get(g)!;
    const arr = clusters.get(s);
    if (arr) arr.push(g); else clusters.set(s, [g]);
  }
  const groups = [...clusters.values()];
  const sizes = groups.map((ids) => ids.length).sort((a, b) => b - a);
  const biggest = groups.reduce((a, b) => (b.length > a.length ? b : a));
  // 占优簇 = 同骨架变体堆: 多簇时最大 ≥ 次大 2 倍, 或只有一种几何(单簇) → 取簇内最小 group 当代表本体。
  if (biggest.length >= 2 && (sizes.length === 1 || sizes[0]! >= 2 * sizes[1]!)) {
    return Math.min(...biggest);
  }
  return firstReal; // 无占优(真·多动作角色): 兜底第一个有真实帧的 IMG。
}

/** 把 sourceImg 的替换帧 (已编码 png/axis/size) 铺到所有同骨架变体的对应帧 → 完整 Replacement[]。
 *  只铺到变体中【非 linked】的帧 (linked 帧无独立像素, repack 会从源保留)。
 *  encoded: frame_index → {png, axis, size} (各替换帧编码一次, 多个变体共用同一 png)。 */
export function expandToVariants(
  manifest: DnfManifest, sourceImg: number,
  encoded: Map<number, { png: Uint8Array; axis: readonly [number, number]; size: readonly [number, number] }>,
): Replacement[] {
  const variants = skeletonVariants(manifest, sourceImg);
  const nonLinked = new Set(
    manifest.frames.filter((f) => !f.linked).map((f) => `${f.img_index},${f.frame_index}`),
  );
  const reps: Replacement[] = [];
  for (const v of variants) {
    for (const [frameIndex, e] of encoded) {
      if (nonLinked.has(`${v},${frameIndex}`)) {
        reps.push({ imgIndex: v, frameIndex, png: e.png, axis: e.axis, size: e.size });
      }
    }
  }
  return reps;
}

// ── 对象类型: 职业 / 怪物 / 宠物 ───────────────────────────────────────────────
// 职业(class) = 本体 skin + 骨架变体 + 隐藏装备 (上面那套现有模型, 不动)。
// 怪物(monster) / 宠物(pet) = 一个 NPK 里多个【独立动作 IMG】, 各自补丁, 无骨架变体扩展 / 无隐藏装备。
//   宠物含 sprite_pet_* 与 sprite_creature_* (DNF 把契约生物/坐骑/节日宠归 creature)。
// 实扒 ImagePacks2 确认 (2026-06-18): monster 一包几十个 attack_x_y 各异动作 IMG; pet/creature
// 动作 IMG + 内嵌 _eff 特效层混在一包; 多 V5 (V5 回封已验无损)。

export type SubjectType = 'class' | 'monster' | 'pet';

const MONSTER_RE = /^sprite_monster_.+\.npk$/i;
const PET_RE = /^sprite_(pet|creature)_.+\.npk$/i;

/** 文件名 → 对象类型 (非可补丁对象返回 null)。% 开头(我们的补丁)/地图/界面/道具等不算。纯函数可测。 */
export function subjectType(fileName: string): SubjectType | null {
  if (fileName.startsWith('%')) return null;
  if (parseSkin(fileName)) return 'class';
  if (PET_RE.test(fileName)) return 'pet';      // pet/creature 先判 (与 monster 互斥, 命名不重叠)
  if (MONSTER_RE.test(fileName)) return 'monster';
  return null;
}

/** 像不像图标/特效桩 NPK (列表里降权/可过滤; 不是本体而是 icon/effect/aura 小包)。 */
export function isLikelyStubNpk(fileName: string): boolean {
  return /(effect|_eff_|aura|_icon\b|stackable)/i.test(fileName);
}

/** 某 IMG 的内部路径名 (manifest 里该 IMG 第一帧的 img_name), 还原成可读路径。
 *  ⚠️ 引擎 manifest/PNG 文件名把 `/` 编码成 `_2F`、`.` 编码成 `_2E` (文件名安全)。必须解码后再按路径
 *  解析, 否则 editableImgs 的 /item/ 桩过滤、isEffectImg 的 effect 段判定、动作展示名都会在真数据上失效。 */
export function imgName(manifest: DnfManifest, imgIndex: number): string {
  const raw = manifest.frames.find((f) => f.img_index === imgIndex)?.img_name ?? '';
  return raw.replace(/_2F/g, '/').replace(/_2E/g, '.');
}

/** 这个 IMG 是不是特效层 (黑底 + 加色混合) → 抠图要【留黑】不能 alpha 抠 (身体层走 alpha)。
 *  DNF 特效 IMG 路径含 effect / _eff 段。best-effort, 不准确没事 (v1)。 */
export function isEffectImg(name: string): boolean {
  return /(?:^|[/_])eff(?:ect)?s?(?:[/_.]|$)/i.test(name);
}

/** 用户可补丁的 IMG 序号列表。
 *  class: 本体 coreSourceImg 一个 (deploy 时 expandToVariants 铺到骨架变体)。
 *  monster/pet: 所有有真实帧的动作 IMG (排图标/道具桩), 各自独立换、不互相扩展。 */
export function editableImgs(manifest: DnfManifest, type: SubjectType): number[] {
  if (type === 'class') return [coreSourceImg(manifest)];
  const real = [...new Set(manifest.frames.filter((f) => !f.linked).map((f) => f.img_index))];
  return real
    .filter((img) => !/(?:\b(icon|stackable)\b|\/item\/)/i.test(imgName(manifest, img)))
    .sort((a, b) => a - b);
}

/** deploy 时某个被换 IMG 的帧要写到哪些 IMG (含自身)。
 *  class: 同骨架变体全铺 (真机才显示, 见 skeletonVariants)。
 *  monster/pet: 只它自己 (各动作 IMG 几何各异、独立; v1 不自动联动 dodge/normal, 避免误改)。 */
export function deployTargets(manifest: DnfManifest, type: SubjectType, imgIndex: number): number[] {
  return type === 'class' ? skeletonVariants(manifest, imgIndex) : [imgIndex];
}

/** 已编码替换帧 (硬边化 + PNG 编码后): buildReplacements 的输入单元。 */
export interface EncodedFrame {
  png: Uint8Array;
  axis: readonly [number, number];
  size: readonly [number, number];
}

/** 通用 deploy 展开: 每源 IMG 的已编码帧 → Replacement[] (喂 engine.repack)。
 *  按 deployTargets 决定铺到哪些 IMG (class 铺骨架变体 / monster·pet 只自身), 只铺到目标里【非 linked】的对应帧。
 *  ⚠️ encodedByImg 外层键 = 源 IMG 序号 → 多源(怪物多动作)各自独立, frame_index 不跨 IMG 撞车。
 *  class 单源时与 expandToVariants 等价 (deployTargets(class)=skeletonVariants)。 */
export function buildReplacements(
  manifest: DnfManifest, type: SubjectType,
  encodedByImg: ReadonlyMap<number, ReadonlyMap<number, EncodedFrame>>,
): Replacement[] {
  const nonLinked = new Set(manifest.frames.filter((f) => !f.linked).map((f) => `${f.img_index},${f.frame_index}`));
  const reps: Replacement[] = [];
  for (const [img, encoded] of encodedByImg) {
    for (const t of deployTargets(manifest, type, img)) {
      for (const [frameIndex, e] of encoded) {
        if (nonLinked.has(`${t},${frameIndex}`)) {
          reps.push({ imgIndex: t, frameIndex, png: e.png, axis: e.axis, size: e.size });
        }
      }
    }
  }
  return reps;
}

/** 补丁名 (% 开头 → 排序最前, 按内部 IMG 路径覆盖原包)。
 *  class: %27_<职业>_skin_reskin.NPK (覆盖本体 skin NPK)。
 *  monster/pet: %27_<原NPK基名>.NPK (覆盖原怪物/宠物 NPK)。 */
export function patchNameForSubject(type: SubjectType, fileName: string, klass?: string): string {
  if (type === 'class') return patchName(klass ?? parseSkin(fileName)?.klass ?? 'unknown');
  return `%27_${fileName.replace(/\.npk$/i, '')}.NPK`;
}

// ── 对象展示名 / 汉化 (best-effort, 三九授权"不准确没事") ─────────────────────────
const MONSTER_ZH: Record<string, string> = {
  anton: '安徒恩', luise: '露西', quinbi: '奎因比', bakal: '巴卡尔', ozma: '奥兹玛',
  cosmofiend: '寂静城使徒', sirocco: '希洛克', killiart: '黑雾之源',
};
const PET_ZH: Record<string, string> = {
  falcon: '猎鹰', gold: '黄金鸟', seria: '塞丽亚', sandman: '沙人',
};

/** 对象展示名: 去 sprite_<类>_ 前缀 + 常见内容/地区/日期前缀, 下划线转空格。best-effort。 */
export function subjectLabel(fileName: string): string {
  let s = fileName.replace(/\.npk$/i, '').replace(/^sprite_(monster|creature|pet|character)_/i, '');
  s = s.replace(/^(chn|kor|gbl|china|gcontents|kcontents\d*|contents|event|else|sd)_/i, '');
  s = s.replace(/^\d{6,8}_/, '');     // 去日期前缀 (210128_ 之类)
  return s.replace(/_/g, ' ').trim() || fileName.replace(/\.npk$/i, '');
}

/** best-effort 中文名: 命中 ZH 词表则用中文, 否则用清理后的展示名 (不准确没事)。 */
export function subjectZh(fileName: string, type: SubjectType): string {
  if (type === 'class') return parseSkin(fileName)?.zh ?? subjectLabel(fileName);
  const label = subjectLabel(fileName);
  const map = type === 'pet' ? PET_ZH : MONSTER_ZH;
  for (const [k, zh] of Object.entries(map)) {
    if (new RegExp(`\\b${k}\\b`, 'i').test(label)) return zh;
  }
  return label;
}
