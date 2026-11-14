/**
 * 武器好不好使。
 *
 * ## 数值从哪来
 *
 * `media/scripts/generated/items/weapon.txt` —— **游戏自己的武器脚本**，409 把、
 * 每把都有 `MaxDamage` / `ConditionMax` / `MaxRange` / `SubCategory`。
 * 不是凭印象写的排行：Katana `MaxDamage=8.0`（断层第一），WoodAxe `3.0/15/1.35`，
 * Sledgehammer `3.0/10/1.35`，Crowbar 只有 `1.15` 但耐久 `15`。
 * 这些数字直接决定评分的形状，换个版本游戏改了数值，评分会跟着变。
 *
 * ## 为什么不能用一条线排
 *
 * 伤害、耐久、攻击距离**不是可以相加的东西**：
 *
 * - 菜刀伤害 0.7、距离 0.9，凑合；
 * - 撬棍伤害只有 1.15，但耐久 15 —— 一整局都断不了，实战里比很多高伤害的更好用；
 * - 大锤伤害 3.0，可它挥得慢，被围住时反而危险（这条评分算不出来，写在注记里）。
 *
 * 所以用**乘积**：伤害是主项，距离和耐久是系数。单看某一项会把「长柄低伤」和
 * 「短柄高伤」排错。
 *
 * ## 枪不算在里面
 *
 * 枪的 `MaxRange` 是 30–40，套进这个公式会碾压一切（步枪能算出 80 分）。
 * 但枪好不好使取决于弹药、技能和你想不想招来一整条街的僵尸 —— 那是另一回事。
 * 所以 Firearm 子类**单独判**，不进这个评分。
 */

export type WeaponTier = 'legend' | 'top' | 'good' | 'ok' | 'poor' | 'unknown';

export interface WeaponStat {
  name: string;
  /** `MaxDamage`。 */
  dmg: number | null;
  /** `MaxRange`。 */
  range: number | null;
  /** `ConditionMax`。 */
  condMax: number | null;
  twoHand: boolean | null;
}

export const TIER_ZH: Record<WeaponTier, string> = {
  legend: '神器',
  top: '顶级',
  good: '好用',
  ok: '能用',
  poor: '凑合',
  unknown: '不好说',
};

/**
 * 评分算不出来的那部分 —— 纯实战经验，按武器内部名（小写）查。
 *
 * 只写「评分会误判」的那几把，不是百科全书。没写的不代表不好用。
 */
const NOTES: Record<string, string> = {
  sledgehammer: '伤害高还能拆墙砸门，但挥得慢，被围住时别指望它救你',
  katana: '伤害断层第一，可惜不好找，耐久也一般',
  crowbar: '伤害不高，但几乎不会断——新手最省心的一把',
  woodaxe: '砍树、劈门、打僵尸一把全包，耐久也是最高那档',
  axe: '比伐木斧轻一点，伤害还是够看',
  machete: '单手，伤害和耐久都好，是最不挑人的一把',
  pickaxe: '伤害高、距离也长，就是重',
  shovel: '距离长，站着能先手，适合不想贴身的打法',
  baseballbat: '伤害一般，但耐久 15，新手最稳的选择',
  fryingpan: '平底锅，聊胜于无，别指望它',
  saucepan: '汤锅，跟平底锅一个水平',
  rollingpin: '擀面杖，凑合挡一下',
  kitchenknife: '菜刀，捅刺距离太短，被贴身才用得上',
  huntingknife: '猎刀，同理——短兵器只适合补刀',
};

/**
 * 近战评分。乘积式，不是加权和。
 *
 * 拆开看每一项为什么这么放：
 * - `dmg` 是主项，乘在最外面 —— 伤害翻倍，这把武器就翻倍好用。
 * - `(1 + (range-1.0)*1.2)`：距离 1.0 是基准。1.6 的铲子拿到 ×1.72，
 *   0.9 的菜刀只有 ×0.88。先手比什么都值钱，但差距不放大到失真。
 * - `(0.6 + min(cond,15)/15*0.4)`：耐久只占四成权重，且封顶 15（再高没有额外收益）。
 *   撬棍靠这一项把分数从 1.15 拉到 1.5。
 */
export function scoreWeapon(w: WeaponStat): number | null {
  const dmg = w.dmg;
  if (dmg === null || !Number.isFinite(dmg) || dmg <= 0) return null;
  const range = w.range !== null && Number.isFinite(w.range) ? w.range : 1.0;
  const cond = w.condMax !== null && Number.isFinite(w.condMax) ? w.condMax : 10;
  const rangeFactor = 1 + (range - 1.0) * 1.2;
  const condFactor = 0.6 + (Math.min(cond, 15) / 15) * 0.4;
  return dmg * rangeFactor * condFactor;
}

/**
 * 分档阈值，全部来自实测分数：
 * Katana 10.3 / WoodAxe 4.3 / Sledge 3.7 / PickAxe 3.6 / Machete 3.6 /
 * Shovel 2.8 / GardenHoe 2.5 / Axe 2.4 / Crowbar 1.5 / BaseballBat 1.4 / 菜刀 0.5
 */
export function weaponTier(score: number | null): WeaponTier {
  if (score === null) return 'unknown';
  if (score >= 8) return 'legend';
  if (score >= 3.2) return 'top';
  if (score >= 2.0) return 'good';
  if (score >= 1.2) return 'ok';
  return 'poor';
}

export interface WeaponRating {
  tier: WeaponTier;
  score: number | null;
  /** 评分之外的实战注记，没有就是 null。 */
  note: string | null;
  label: string;
}

export function rateWeapon(w: WeaponStat): WeaponRating {
  const score = scoreWeapon(w);
  const tier = weaponTier(score);
  const note = NOTES[String(w.name ?? '').toLowerCase()] ?? null;
  return { tier, score, note, label: TIER_ZH[tier] };
}

/** 一句话，塞进 `pz_state` / `describeNow`。读不到数值时只说名字，不评分。 */
export function describeWeaponRating(w: WeaponStat): string | null {
  if (!w.name) return null;
  const r = rateWeapon(w);
  if (r.tier === 'unknown') return null;   // 数值读不到就不评，别嘴硬
  const dmg = w.dmg !== null ? `伤害 ${w.dmg}` : null;
  const bits = [r.label, dmg, r.note].filter(Boolean);
  return bits.join(' · ');
}

/**
 * 「哪把武器好使」的答案。
 *
 * 内置一份清单，理由是：他问这句话时多半手上没武器、或者正站在柜子前，
 * 这时 `pz_state` 里那把的评级帮不上忙。清单只收游戏里常见的那些，
 * 数值照抄 `weapon.txt`，不是印象。
 */
export interface WeaponPick {
  name: string;
  /** 中文叫法。游戏内显示名是本地化的，这里给个能开口的说法。 */
  zh: string;
  tier: WeaponTier;
  why: string;
}

export const WEAPON_PICKS: readonly WeaponPick[] = [
  { name: 'Katana', zh: '武士刀', tier: 'legend', why: '伤害断层第一（8.0），单手挥，就是难遇到、耐久一般' },
  { name: 'WoodAxe', zh: '伐木斧', tier: 'top', why: '伤害 3.0、耐久 15、距离 1.35——砍树劈门打僵尸一把全包' },
  { name: 'Sledgehammer', zh: '大锤', tier: 'top', why: '伤害 3.0，能拆墙砸门；但挥得慢，被围住时别指望它' },
  { name: 'PickAxe', zh: '十字镐', tier: 'top', why: '伤害 2.2、距离 1.6，站着能先手' },
  { name: 'Machete', zh: '砍刀', tier: 'top', why: '伤害 3.0、耐久 13、**单手**——最不挑人的一把' },
  { name: 'Sword', zh: '长剑', tier: 'top', why: '伤害 3.0、耐久 13、距离 1.4，比砍刀更远但要双手' },
  { name: 'Shovel', zh: '铁锹', tier: 'good', why: '伤害 1.9、距离 1.6，不想贴身就用它' },
  { name: 'Axe', zh: '斧头', tier: 'good', why: '伤害 2.0、耐久 13，中规中矩但哪都能找到' },
  { name: 'GardenHoe', zh: '锄头', tier: 'good', why: '伤害 1.7、距离 1.6，田里常见' },
  { name: 'BaseballBat', zh: '棒球棍', tier: 'ok', why: '伤害只有 1.1，但耐久 15、几乎不会断——新手最稳' },
  { name: 'Crowbar', zh: '撬棍', tier: 'ok', why: '伤害 1.15、耐久 15，一整局都断不了' },
  { name: 'Nightstick', zh: '警棍', tier: 'ok', why: '伤害 1.1 但耐久 15，单手，警察局里有' },
  { name: 'KitchenKnife', zh: '菜刀', tier: 'poor', why: '伤害 0.7、距离 0.9——只有贴身才用得上，别当主武器' },
];
