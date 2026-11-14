/**
 * 感知层：把一堆字段翻译成「现在是个什么局面」。
 *
 * 这一层存在的理由：模型不该看到 `fatigue: 0.83`，它该看到「快站着睡着了」。
 * 但**翻译不能加戏** —— 数字算得出来的（血量、档位、缺不缺绷带）在这里算死，
 * 算不出来的（这波僵尸是不是冲你来的、天亮还有多久）明说不知道。
 *
 * 特别地：PZ 的日落随季节和纬度变，这里**不推算天黑还有几分钟**。
 * 只有「游戏说现在算不算夜里」这一个事实，和一个「天在暗了」的定性判断。
 * 编一个「还有 40 分钟」比不说更糟 —— 他会照着安排行程。
 */
import type { RawGear, RawLoot, RawPlayer, RawState } from './types.ts';
import { describeWeaponRating, type WeaponStat } from './weapon.ts';

export type LinkKind = 'ok' | 'menu' | 'no-root' | 'no-data' | 'stale' | 'unreadable';

export type HpBand = 'ok' | 'hurt' | 'bad' | 'critical' | 'unknown';
export type ThreatBand = 'clear' | 'few' | 'swarm' | 'horde' | 'unknown';

/**
 * 需求/状态档位。四条，事件判定和提示词共用一套。
 *
 * 为什么不再细分：`0.83` 和 `0.87` 对她没有任何区别，而多出来的档只会让
 * 她说出「你现在饥饿度 83%」这种不像人话的句子。
 */
export type NeedBand = 'ok' | 'mild' | 'bad' | 'critical';

/** 武器耐久档位。`unknown` = 读不到（空手、或者这把东西根本没有耐久）。 */
export type WeaponBand = 'ok' | 'worn' | 'low' | 'critical' | 'unknown';

export interface NeedSpec {
  /** `Situation` 上的字段名，也是去重用的键。 */
  key: 'hunger' | 'thirst' | 'fatigue' | 'endurance' | 'stress' | 'panic' | 'pain' | 'boredom' | 'unhappy';
  /** 说人话的名字。 */
  name: string;
  /** true = 越低越糟（体力）。算档位前先取反，后面所有阈值都按「越高越糟」写。 */
  inverse?: boolean;
  mildAt: number;
  /** 进事件的最低档。低于这个档位她不该主动开口。 */
  badAt: number;
  critAt: number;
  /** 「有点」的说法。 */
  mild: string;
  /** 该开口时的说法。带一点画面，但别夸张成段子。 */
  bad: string;
  /** 顶格的说法。 */
  crit: string;
  /** 建议里那半句：这时候该干什么。 */
  fix: string;
}

/**
 * 九条状态，按「越靠前越该先说」排。
 *
 * 阈值不是拍脑袋：PZ 里饥饿/口渴到 0.7 已经掉体力上限了，0.9 是掉血边缘；
 * stress/boredom 涨得慢但掉心情，0.7 才值得提；panic 只在被追时飙，
 * 所以它的档位要更高一点，否则一只僵尸从街角路过她就喊。
 * 这些数只影响「什么时候值得开口」，不影响事实本身 —— 事实永远来自游戏。
 */
export const NEED_SPECS: readonly NeedSpec[] = [
  {
    key: 'hunger', name: '饿',
    mildAt: 0.45, badAt: 0.7, critAt: 0.9,
    mild: '有点饿', bad: '饿到发慌了', crit: '饿得快站不住了',
    fix: '包里翻点现成的吃，别等饿了才想起来找——那时候翻箱子的手是抖的。',
  },
  {
    key: 'thirst', name: '渴',
    mildAt: 0.45, badAt: 0.7, critAt: 0.9,
    mild: '有点渴', bad: '渴得嗓子发干', crit: '快脱水了',
    fix: '先喝一口。渴到这个程度掉的是体力上限，不是口渴本身。',
  },
  {
    key: 'fatigue', name: '累',
    mildAt: 0.45, badAt: 0.72, critAt: 0.9,
    mild: '有点累', bad: '眼皮快撑不开了', crit: '站着都能睡过去',
    fix: '找个能关门的地方躺下。困着打，打不了两下就喘。',
  },
  {
    key: 'endurance', name: '体力', inverse: true,
    mildAt: 0.5, badAt: 0.72, critAt: 0.88,
    mild: '体力有点跟不上了', bad: '体力见底', crit: '一点力气都没有了',
    fix: '别跑，也别再开打。这个状态下你跑不掉，只能先脱离接触。',
  },
  {
    key: 'pain', name: '疼',
    mildAt: 0.3, badAt: 0.55, critAt: 0.8,
    mild: '身上有点疼', bad: '疼得厉害', crit: '疼到影响动作了',
    fix: '疼不是新伤，是旧伤在说话。先包扎，别硬扛着继续搜。',
  },
  {
    key: 'panic', name: '惊恐',
    mildAt: 0.4, badAt: 0.65, critAt: 0.88,
    mild: '还有点发慌', bad: '手在抖', crit: '整个人都在抖',
    fix: '恐慌降下来之前命中率是打折扣的。找个关门的地方站一会儿，别硬碰。',
  },
  {
    key: 'stress', name: '压力',
    mildAt: 0.4, badAt: 0.62, critAt: 0.85,
    mild: '心里有点躁', bad: '心里很躁', crit: '整个人绷得很紧',
    fix: '抽烟、听歌、洗个澡、吃顿好的——僵毁里这几种都能压压力。',
  },
  {
    key: 'unhappy', name: '心情',
    mildAt: 0.45, badAt: 0.68, critAt: 0.88,
    mild: '心情有点低', bad: '心情很差', crit: '整个人都蔫了',
    fix: '吃点好吃的、换身干净衣服、把屋里收拾一下。心情低会连带掉别的。',
  },
  {
    key: 'boredom', name: '无聊',
    mildAt: 0.6, badAt: 0.8, critAt: 0.95,
    mild: '有点闷', bad: '无聊到发闷', crit: '闲得发慌',
    fix: '找本书、开个收音机，或者干脆出去转一圈——无聊会慢慢拽低心情。',
  },
];

export const NEED_ORDER: readonly NeedBand[] = ['ok', 'mild', 'bad', 'critical'];

export function needBandIndex(band: NeedBand): number {
  return NEED_ORDER.indexOf(band);
}

/** 读不到返回 null —— **不是 ok**。「不知道他饿不饿」不等于「他不饿」。 */
export function needBandOf(v: number | null, spec: NeedSpec): NeedBand | null {
  if (v === null || !Number.isFinite(v)) return null;
  const x = clamp01(v);
  const score = spec.inverse ? 1 - x : x;
  if (score >= spec.critAt) return 'critical';
  if (score >= spec.badAt) return 'bad';
  if (score >= spec.mildAt) return 'mild';
  return 'ok';
}

/**
 * 武器耐久档。
 *
 * 20% 以下才叫 low —— 一把刀从 80% 掉到 60% 说一句就是在报数，
 * 而这个数字每天都在变，报三次他就开始跳着听了。
 */
export function weaponBandOf(pct: number | null): WeaponBand {
  if (pct === null || !Number.isFinite(pct)) return 'unknown';
  if (pct >= 50) return 'ok';
  if (pct >= 20) return 'worn';
  if (pct >= 5) return 'low';
  return 'critical';
}

export const WEAPON_ORDER: readonly WeaponBand[] = ['unknown', 'ok', 'worn', 'low', 'critical'];

export interface Situation {
  link: LinkKind;
  linkNote: string;
  seq: number;
  session: string | null;
  inGame: boolean;
  /**
   * 世界坐标。她自己能走路之后这就是必需品：
   * `walk` 没有坐标等于没有参数，而坐标只能由游戏给，不能推。
   */
  x: number | null;
  y: number | null;
  day: number | null;
  hour: number | null;
  /**
   * 游戏内分钟。电视节目表要精确到这个粒度 ——
   * 只有整点的话「开播前 30 分钟」和「开播后 60 分钟」这两个窗口
   * 会退化成「整点那一刻」，提醒就永远慢半拍。
   */
  minute: number | null;
  clockText: string | null;
  night: boolean;
  /** 天在暗了（傍晚到入夜之间）。定性判断，不是倒计时。 */
  duskSoon: boolean;
  indoors: boolean | null;
  placeText: string;
  hp: number | null;
  hpBand: HpBand;
  infected: boolean | null;
  infectionLevel: number | null;
  hunger: number | null;
  thirst: number | null;
  fatigue: number | null;
  endurance: number | null;
  /** 心情四项。整片可能是 null —— 这份构建里读不到，不是 0。 */
  stress: number | null;
  panic: number | null;
  pain: number | null;
  boredom: number | null;
  unhappy: number | null;
  visible: number | null;
  threatBand: ThreatBand;
  /**
   * 三格内的僵尸数和最近距离 —— **游戏侧反射层量的**，比 `visible` 准，
   * 因为它不看视野，僵尸从背后摸过来也照样算。
   *
   * `threatCount` 和 `threatNear` 同时为 null 才是「不知道」；
   * `threatCount === 0` 是「确认身边没有」。
   */
  threatCount: number | null;
  threatNear: number | null;
  /** 反射层开着没有。null = 老版本 mod 没这个字段。 */
  reflexOn: boolean | null;
  /** 这一局它自己出手了多少次。 */
  reflexCount: number | null;
  /** 最近那次它干了什么（ascii）。 */
  reflexAct: string | null;
  /** 他是不是正在自己操作（举枪 / 按着方向键 / 点地走）。true 时她不该下任何指令。 */
  handsOn: boolean;
  /** 游戏侧判「他在操作」的依据，只用于排查。 */
  handsWhy: string;
  /** 她刚看过的那一格（`look` 的结果）。 */
  peek: RawPeek | null;
  /** 她刚问过的「这儿能做什么」（右键菜单的选项）。 */
  menu: RawMenu | null;
  /** Rimboid 的小队名册。 */
  squad: RawSquad | null;
  /** 她的第二具身体（一条狗）。null = 没装 Companion Dogs。 */
  dog: RawDog | null;
  weapon: string | null;
  weaponCondText: string | null;
  /** 耐久百分比 0–100。`null` = 空手或读不到。`weaponCondText` 是它的说法版。 */
  weaponPct: number | null;
  /** 耐久上限。换武器判定要用，所以单独留着。 */
  weaponMax: number | null;
  weaponBand: WeaponBand;
  /**
   * 手上这把的武器脚本数值。三项一起用，缺一项就不评 ——
   * `description` 里只写名字，绝不拿名字猜好坏。
   */
  weaponStat: WeaponStat;
  /** 技能等级。null = 读不到；某个键缺失 = 那一项读不到，不是 0 级。 */
  skills: Record<string, number> | null;
  gear: RawGear | null;
  /** 他**正打开着**的那个容器。`null` = 没在翻东西，不是「柜子是空的」。 */
  loot: RawLoot | null;
  kills: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 归一「背包那四样」。
 *
 * ⚠️ 真机事故（0.6.2 → 0.6.3）：游戏刚启动、还没读档时，桥接写出的是一份
 * `{"v":1,"seq":0,"ts":...,"alive":false,"boot":true,"load":2,"events":[]}` ——
 * **整个 `gear` 键都不存在**。于是 `raw.gear` 是 `undefined`，而不是设计时假设的 `null`。
 *
 * 下游那些写成 `gear !== null && gear.water > 0` 的判据全被它骗过去了
 * （`undefined !== null` 为真），接着读 `.water` 就抛。而 `start()` 第一句是
 * `await this.tick()`，异常直接冒到宿主，表现成**整个扩展开不起来**（「切换失败」），
 * 而不是「某个功能坏了」。
 *
 * 所以在这里统一收口：不是对象就当「读不到」，是对象就把每项夹成数字（缺的按 0，
 * 跟桥接那边 `ni()` 的写法一致）。
 *
 * 教训：**外部数据里「键不存在」和「键是 null」是两件事**，
 * `!== null` 只挡得住后者。凡是跨进程 / 跨版本的边界，判空要用真值判断。
 */
function normGear(g: unknown): RawGear | null {
  if (!g || typeof g !== 'object') return null;
  const o = g as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    bandage: num(o.bandage),
    food: num(o.food),
    water: num(o.water),
    light: num(o.light),
  };
}

/**
 * 把一项 0..1 的需求读数夹进 0..1，并**兜住旧版 mod 送来的 0..100 量纲**。
 *
 * 为什么前端还要再防一道：Lua 侧已经按枚举自带的 `getMaximumValue()` 归一了
 * （那才是真正的修法），但 **mod 要重开游戏才生效，扩展是重启宿主就生效** ——
 * 中间那段时间旧 Lua 仍在往外送原始值。真机实测收到过 `pain = 1.9`，
 * 乘以 100 就成了「疼痛读数 190%」，她还照这个说「疼到影响动作了」。
 *
 * 0..1 的比值不可能超过 1.5；超过了就只可能是 0..100 那一路，按百分比收进来。
 */
function ratio(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const x = v > 1.5 ? v / 100 : v;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function hpBandOf(hp: number | null): HpBand {
  if (hp === null) return 'unknown';
  if (hp >= 75) return 'ok';
  if (hp >= 50) return 'hurt';
  if (hp >= 25) return 'bad';
  return 'critical';
}

/** 档位就这四个，事件判定和提示词共用一套，不许各写一份。 */
export function threatBandOf(visible: number | null): ThreatBand {
  if (visible === null) return 'unknown';
  if (visible <= 2) return 'clear';
  if (visible <= 5) return 'few';
  if (visible <= 11) return 'swarm';
  return 'horde';
}

export function threatBandIndex(band: ThreatBand): number {
  return { unknown: -1, clear: 0, few: 1, swarm: 2, horde: 3 }[band];
}

function placeOf(p: RawPlayer | null): string {
  if (!p) return '不知道在哪';
  const outside = p.outside;
  const room = p.room?.trim() || null;
  const building = p.building?.trim() || null;
  if (outside === true) return '在外面';
  if (outside === false) {
    if (room && building) return `屋里 · ${building}的${room}`;
    if (room) return `屋里 · ${room}`;
    if (building) return `屋里 · ${building}`;
    return '屋里';
  }
  // outside 取不到时，有房间名也说明是在室内
  if (room) return `屋里 · ${room}`;
  return '不知道在室内还是外面';
}

function condText(p: RawPlayer | null): string | null {
  if (!p || !p.weapon) return null;
  const pct = condPct(p);
  return pct === null ? null : `耐久 ${pct}%`;
}

/** 耐久百分比。`weaponCondText` 和事件判定都从这里出，别一处解析字符串一处重算。 */
function condPct(p: RawPlayer | null): number | null {
  if (!p || !p.weapon) return null;
  const c = p.weaponCond;
  const m = p.weaponMax;
  if (c === null || m === null || m <= 0) return null;
  return Math.round(clamp01(c / m) * 100);
}

export interface BuildOptions {
  nowMs: number;
  staleSeconds: number;
  /** 找不到存档根目录时给的原因，直接当成 linkNote。 */
  rootProblem?: string | null;
}

/**
 * 「多久没数据了」怎么说。
 *
 * 原来一律报精确秒数，游戏关了 22 小时就显示「数据停在 79987 秒前」——
 * 那个数字对他没有任何信息量：关了五分钟和关了二十二小时，他看到的
 * 是同一件事（游戏没开）。而一个不断涨的五位数看起来像故障。
 *
 * 分档之后，短时间内的秒数还有用（能判断是不是读档卡住了），
 * 长时间没开就直接说「没在运行」，那是状态，不是错误。
 */
function gapText(age: number | null): string {
  if (age === null) return '数据没在更新，但读不出最后更新的时间。';
  const secs = Math.round(age);
  if (secs < 90) return `数据停在 ${secs} 秒前。`;
  const min = Math.round(secs / 60);
  if (min < 60) return `数据停在 ${min} 分钟前。`;
  const h = Math.floor(secs / 3600);
  if (h < 48) return `游戏没在运行（最后一次读档在 ${h} 小时前）。`;
  return `游戏没在运行（最后一次读档在 ${Math.floor(h / 24)} 天前）。`;
}

export function buildSituation(raw: RawState | null, opts: BuildOptions): Situation {
  const empty = (link: LinkKind, note: string): Situation => ({
    link,
    linkNote: note,
    seq: 0,
    session: null,
    inGame: false,
    x: null,
    y: null,
    day: null,
    hour: null,
    minute: null,
    clockText: null,
    night: false,
    duskSoon: false,
    indoors: null,
    placeText: '不知道在哪',
    hp: null,
    hpBand: 'unknown',
    infected: null,
    infectionLevel: null,
    hunger: null,
    thirst: null,
    fatigue: null,
    endurance: null,
    stress: null,
    panic: null,
    pain: null,
    boredom: null,
    unhappy: null,
    visible: null,
    threatBand: 'unknown',
    threatCount: null,
    threatNear: null,
    reflexOn: null,
    reflexCount: null,
    reflexAct: null,
    handsOn: false,
    handsWhy: '',
    peek: null,
    menu: null,
    squad: null,
    dog: null,
    weapon: null,
    weaponCondText: null,
    weaponPct: null,
    weaponMax: null,
    weaponBand: 'unknown',
    weaponStat: { name: '', dmg: null, range: null, condMax: null, twoHand: null },
    skills: null,
    gear: null,
    loot: null,
    kills: 0,
  });

  if (!raw) return empty('no-data', opts.rootProblem || '游戏还没写出数据。');

  // 顶层这几个字段在「精简过的 / 旧版的 / 刚启动的」state 里可能**整个键都不存在**，
  // 拿到的是 `undefined` 而不是 `null` —— 而 `x !== null` 拦不住 `undefined`。
  // 这里统一收口（gear 那次翻车就是这个形状，见 normGear 的注释）。
  const age = typeof raw.ts === 'number' && raw.ts > 0 ? opts.nowMs / 1000 - raw.ts : null;
  const stale = age !== null && age > opts.staleSeconds;
  const clock = raw.clock;
  const p = raw.player;

  // `p != null` 而不是 `p !== null`：`player` 键缺失时 p 是 undefined，
  // 用 `!== null` 会把「没读到玩家」判成「在游戏里」，后面一路拿 undefined 算。
  const inGame = raw.alive === true && p != null;
  const hour = clock?.hour ?? null;
  const night = clock?.night === true;
  const duskSoon = !night && hour !== null && hour >= 17;

  const hp = p?.health !== null && p?.health !== undefined ? Math.round(clamp01(p.health) * 100) : null;
  const visible = p?.visible !== null && p?.visible !== undefined ? Math.round(p.visible) : null;
  // 反射层的读数和 `visible` 是两套来源，各自可能缺 —— 不互相兜底。
  const th = raw.threat;
  const rf = raw.reflex;
  const threatCount = th && typeof th.n === 'number' ? th.n : null;
  const threatNear = th && typeof th.d === 'number' ? th.d : null;

  let link: LinkKind = 'ok';
  let note = '';
  if (stale) {
    link = 'stale';
    note = gapText(age);
  } else if (!inGame) {
    link = 'menu';
    note = '游戏在跑，但没在读档（主菜单不产生数据）。';
  } else {
    note = '在跟。';
  }

  return {
    link,
    linkNote: note,
    seq: typeof raw.seq === 'number' ? raw.seq : 0,
    session: typeof raw.session === 'string' ? raw.session : null,
    inGame,
    x: p?.x ?? null,
    y: p?.y ?? null,
    day: clock?.day ?? null,
    hour,
    minute: clock?.minute ?? null,
    clockText: hour !== null
      ? `${String(hour).padStart(2, '0')}:${String(Math.round(clock?.minute ?? 0)).padStart(2, '0')}`
      : null,
    night,
    duskSoon,
    indoors: p?.outside === null || p?.outside === undefined ? null : !p.outside,
    placeText: placeOf(p),
    hp,
    hpBand: hpBandOf(hp),
    infected: p?.infected ?? null,
    infectionLevel: p?.infection ?? null,
    hunger: ratio(p?.hunger),
    thirst: ratio(p?.thirst),
    fatigue: ratio(p?.fatigue),
    endurance: ratio(p?.endurance),
    stress: ratio(p?.stress),
    panic: ratio(p?.panic),
    pain: ratio(p?.pain),
    boredom: ratio(p?.boredom),
    unhappy: ratio(p?.unhappy),
    visible,
    threatBand: threatBandOf(visible),
    threatCount,
    threatNear,
    reflexOn: rf && typeof rf.on === 'boolean' ? rf.on : null,
    reflexCount: rf && typeof rf.n === 'number' ? rf.n : null,
    reflexAct: rf && typeof rf.act === 'string' ? rf.act : null,
    handsOn: raw.hands?.on === true,
    handsWhy: typeof raw.hands?.why === 'string' ? raw.hands.why : '',
    peek: raw.peek ?? null,
    menu: raw.menu ?? null,
    squad: raw.squad ?? null,
    dog: raw.dog ?? null,
    weapon: p?.weapon ?? null,
    weaponCondText: condText(p),
    weaponPct: condPct(p),
    weaponMax: p?.weaponMax ?? null,
    weaponBand: weaponBandOf(condPct(p)),
    weaponStat: {
      name: p?.weapon ?? '',
      dmg: p?.weaponDmg ?? null,
      range: p?.weaponRng ?? null,
      condMax: p?.weaponMax ?? null,
      twoHand: p?.weaponTwo ?? null,
    },
    skills: p?.skills ?? null,
    gear: normGear(raw.gear),
    loot: raw.loot ?? null,
    kills: raw.kills ?? 0,
  };
}

/* ---------------------------------------------------------------- 说人话 */

const BAND_ZH: Record<ThreatBand, string> = {
  clear: '没什么（0–2 只）',
  few: '有几只（3–5 只）',
  swarm: '一群（6–11 只）',
  horde: '一大片（12 只以上）',
  unknown: '不知道',
};

const HP_ZH: Record<HpBand, string> = {
  ok: '还行',
  hurt: '见血了',
  bad: '伤得重',
  critical: '快撑不住',
  unknown: '不知道',
};

/** 身体那几项，一行说完。 */
const BODY_KEYS: ReadonlySet<string> = new Set(['hunger', 'thirst', 'fatigue', 'endurance']);
/** 情绪那几项，单独一行 —— 和「饿了」拼在同一行里读起来像病历。 */
const MIND_KEYS: ReadonlySet<string> = new Set(['pain', 'panic', 'stress', 'unhappy', 'boredom']);

/** 只收 mild 及以上。ok 就不提 —— 没人需要被告知「你现在不饿」。 */
function needWords(sit: Situation, keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const spec of NEED_SPECS) {
    if (!keys.has(spec.key)) continue;
    const band = needBandOf(sit[spec.key], spec);
    if (band === null || band === 'ok') continue;
    out.push(band === 'critical' ? spec.crit : band === 'bad' ? spec.bad : spec.mild);
  }
  return out;
}

/**
 * 一份给模型看的「现在怎么样」。
 *
 * 这份文本有两条出口：环境提示词的 `{{pz.now}}`（每回合都在），和 `pz_state` 的回执。
 * **两边必须是同一个函数** —— 各拼一套的后果是她说的话和面板对不上，
 * 而他一定会去对。
 */
export function describeNow(sit: Situation): string {
  if (!sit.inGame) {
    // 只给一句。出问题的细节在 `pz.status` 里已经有了，
    // 两处都写一遍会让提示词里同一句话出现两次。
    return '现在没有进行中的存档。';
  }
  const lines: string[] = [];
  const when = [sit.day !== null ? `第 ${sit.day} 天` : null, sit.clockText, sit.night ? '夜里' : null]
    .filter(Boolean).join(' ');
  lines.push(`${when} · ${sit.placeText}`);

  const vitals: string[] = [];
  if (sit.hp !== null) vitals.push(`血量 ${sit.hp}%（${HP_ZH[sit.hpBand]}）`);
  if (sit.infected === true) vitals.push('**已经感染了**');
  else if (sit.infected === false) vitals.push('没感染');
  lines.push(vitals.join('，'));

  const needs = needWords(sit, BODY_KEYS);
  if (needs.length) lines.push(needs.join('、'));

  // 情绪单独一行。和「有点饿」拼一起读起来像病历，而她自己是有态度的。
  const mind = needWords(sit, MIND_KEYS);
  if (mind.length) lines.push(`心里：${mind.join('、')}`);

  // 档位和数字分开写。原来两段各带一个括号，拼出来是「视野里有几只（3–5 只）（视野里 4 只）」。
  lines.push(sit.visible !== null
    ? `视野：${BAND_ZH[sit.threatBand]}，现在 ${sit.visible} 只`
    : `视野：${BAND_ZH[sit.threatBand]}`);

  // 「身边」和「视野」是两件事：视野是看得见的，身边是三格内真的站着的。
  // 只写「身边」，只在真有人时才写 —— 每回合都来一句「身边空着」会把要紧的行压下去。
  if (sit.threatCount !== null && sit.threatCount > 0) {
    const near = sit.threatNear !== null ? `，最近 ${sit.threatNear.toFixed(1)} 格` : '';
    const reach = sit.threatNear !== null && sit.threatNear <= 1.8 ? '（**已经够得着**）' : '';
    lines.push(`身边：三格内 ${sit.threatCount} 只${near}${reach}`);
  }

  // 手上这把「好不好使」比耐久更常被问到 —— 但只在读得到数值时才评，
  // 读不到就只报名字（武器脚本的三项在有些构建里拿不全）。
  const rating = describeWeaponRating(sit.weaponStat);
  const hand = sit.weapon
    ? `手上 ${sit.weapon}${sit.weaponCondText ? `（${sit.weaponCondText}）` : ''}${rating ? ` —— ${rating}` : ''}`
    : '手上空着';
  lines.push(hand);

  if (sit.gear) {
    const g = sit.gear;
    const bag = [
      `绷带 ${g.bandage}`,
      `吃的 ${g.food}`,
      `水 ${g.water}`,
      `光源 ${g.light}`,
    ].join(' · ');
    lines.push(`背包：${bag}`);
  } else {
    lines.push('背包：没读到');
  }

  /**
   * 他正打开的那个容器。
   *
   * **两种「没有」必须分开说**，否则她会把「我翻过了，没什么」说成「我看不见」——
   * 真机就是这么翻车的：他明明开着柜台，里面只有漫画书和叉子，`hits` 是空的，
   * 于是那句「柜子我看不见」让他以为功能坏了。
   *
   * - `sit.loot === null` → 他真的没开容器；
   * - `hits` 空但 `loot` 有值 → 开着，我看了，里面没有值得停的。
   */
  // 她自己能动之后，坐标就是必需品 —— 没有它，`walk` 这个动作等于没有参数。
  if (sit.x !== null && sit.y !== null) {
    lines.push(`位置 x=${Math.round(sit.x * 10) / 10} y=${Math.round(sit.y * 10) / 10}`
      + `（朝向由游戏自己管，不用报）`);
  }

  if (sit.loot) {
    const total = typeof sit.loot.total === 'number' ? `一共 ${sit.loot.total} 样` : '东西不多';

    // ⚠️ 坐标和序号必须写出来，否则 `take` 这条指令**根本拼不出来**。
    // 真机翻车：她嘴上说「拿不了东西」，其实是从头到尾没发过一条 take ——
    // 因为 `pz_state` 只给了物品名字，没给 x / y / objIdx / itemIdx。
    // 她不是不肯动，是手里没有参数。
    const where: string[] = [];
    if (typeof sit.loot.x === 'number' && typeof sit.loot.y === 'number') {
      where.push(`x=${Math.round(sit.loot.x * 10) / 10}`, `y=${Math.round(sit.loot.y * 10) / 10}`);
    }
    if (typeof sit.loot.oi === 'number') where.push(`objIdx=${sit.loot.oi}`);
    const at = where.length ? ` · 位置 ${where.join(' ')}` : '';

    const listed = sit.loot.hits
      .map((h) => {
        const n = String(h.n ?? '').trim();
        if (!n) return '';
        return typeof h.i === 'number' ? `${n}（itemIdx=${h.i}）` : n;
      })
      .filter(Boolean)
      // 去重按整串（名字 + 序号），否则两本同名书会被并成一个序号。
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 4);

    // 全部清单。`hits` 只挑值得提醒的，`all` 是「里面到底有什么」——
    // 少了这一份，她只知道「有 3 件」却看不见是什么，只能请人帮忙开柜子。
    const allListed = (Array.isArray(sit.loot.all) ? sit.loot.all : [])
      .map((a) => {
        const n = String(a?.n ?? '').trim();
        if (!n) return '';
        return typeof a.i === 'number' ? `${n}（itemIdx=${a.i}）` : n;
      })
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 8);

    const takeHint = where.length > 1
      ? `要拿就说 take，参数照上面抄：x=${Math.round((sit.loot.x ?? 0) * 10) / 10}`
        + ` y=${Math.round((sit.loot.y ?? 0) * 10) / 10} objIdx=${sit.loot.oi ?? 0} itemIdx=<那一件>`
      : '';

    lines.push(`正开着：${sit.loot.type ?? '容器'}（${total}）${at}`);
    if (listed.length) {
      lines.push(`可拿：${listed.join('、')}`);
      if (takeHint) lines.push(takeHint);
    } else if (allListed.length) {
      // 「没有值得拿的」和「看不见」是两件事。这里必须说清是哪一件。
      lines.push(`里面：${allListed.join('、')}`);
      lines.push('**没有特别值得拿的东西**，但都在手边 —— 想要哪件就说 take。');
      if (takeHint) lines.push(takeHint);
    } else if (sit.loot.total > 0) {
      // 读到了件数、读不到名字：容器可能没解锁，或者这一格还没加载完。
      lines.push('里面有几样东西，但名字读不出来（容器还没加载完，或者上锁了）。');
    } else {
      lines.push('里面是空的');
    }
  }

  // 她自己「看过」的那一格。和 `loot`（他正开着的）是两条路 ——
  // 这条不需要任何人帮她点开柜子。
  if (sit.peek && Array.isArray(sit.peek.boxes) && sit.peek.boxes.length) {
    const px = typeof sit.peek.x === 'number' ? Math.round(sit.peek.x) : null;
    const py = typeof sit.peek.y === 'number' ? Math.round(sit.peek.y) : null;
    const at = px !== null && py !== null ? ` (x=${px} y=${py})` : '';
    lines.push(`看过这一格${at}：`);
    const boxes = sit.peek.boxes.slice(0, 3);
    for (const b of boxes) {
      const oi = typeof b.oi === 'number' ? `#${b.oi}` : '#?';
      const total = typeof b.total === 'number' ? `${b.total} 件` : '数量不明';
      const items = (Array.isArray(b.items) ? b.items : [])
        .map((it) => {
          const n = String(it?.n ?? '').trim();
          if (!n) return '';
          const mark = it.w ? '，能当武器' : '';
          return typeof it.i === 'number' ? `${n}（itemIdx=${it.i}${mark}）` : n;
        })
        .filter(Boolean)
        .slice(0, 8);
      lines.push(`· ${oi} ${b.n ?? '容器'}（${total}）：${items.length ? items.join('、') : '空的'}`);
    }
    if (px !== null && py !== null) {
      const oi0 = typeof boxes[0]?.oi === 'number' ? boxes[0].oi : 0;
      lines.push(`拿法：take(x=${px}, y=${py}, objIdx=${oi0}, itemIdx=<上面某件的 itemIdx>)`);
    }
  }

  // 游戏自己给的「这儿能做什么」。名字原样保留 —— 她挑的时候要照抄，
  // 我们翻译一遍就等于让她拿着一份对不上的清单去点菜。
  if (sit.menu && Array.isArray(sit.menu.list) && sit.menu.list.length) {
    const list = sit.menu.list.slice(0, 12);
    lines.push(`这儿能做的（游戏自己列出来的，共 ${sit.menu.list.length} 项）：`);
    for (const m of list) {
      const nm = String(m?.n ?? '').trim();
      if (!nm) continue;
      lines.push(`· [${m.i}] ${nm}`);
    }
    if (sit.menu.list.length > list.length) {
      lines.push(`（还有 ${sit.menu.list.length - list.length} 项没列出来 —— 上面这些是最靠前的。）`);
    }
    lines.push('要哪一项就说 pick(index=方括号里那个数)。**别自己数**，抄。'
      + '做完一件之后清单会作废，要做下一件得重新 menu。');
  }

  // Rimboid 的小队。这些人由那个 mod 自己的 AI 驱动 —— 她只能说要「干什么」，
  // 说不了「往哪走」。所以这里给的是工作名，不是坐标。
  if (sit.squad && Array.isArray(sit.squad.list) && sit.squad.list.length) {
    lines.push(`小队名册（${sit.squad.list.length} 人）：`);
    for (const m of sit.squad.list.slice(0, 6)) {
      const nm = String(m?.n ?? '?');
      const job = String(m?.job ?? '').trim();
      const state = m.r ? '已入队' : '还没招募';
      const at = typeof m.x === 'number' && typeof m.y === 'number'
        ? ` @${Math.round(m.x)},${Math.round(m.y)}` : '';
      lines.push(`· ${nm}（${state}${job ? ` · 现在在做 ${job}` : ''}${at}）`);
    }
    const first = sit.squad.list[0];
    if (first?.id) {
      lines.push(`给她派活：order(id="${first.id}", job="follow")。`
        + '十六种：follow / hold / guard / patrol / explore / farm / relax / sort / corpses / auto / fish / clean / cook / chop / dismantle / medic');
    }
  } else if (sit.squad && Array.isArray(sit.squad.list)) {
    lines.push('小队名册是空的 —— 附近没有招募到的幸存者。');
  }

  // 她的另一具身体。
  //
  // 这里写的是「那具身体在干什么」，不是「她该干什么」—— 判断留给模型。
  // 关键信息只有三个：在不在、离多远、钉住没有。
  if (sit.dog) {
    if (!sit.dog.mod) {
      // 不写。没装 mod 的路由外面已经报过了，每回合重复一句是噪音。
    } else if (!sit.dog.have) {
      lines.push('狗：还没有（说 dog 生成一只，会出现在你脚边）');
    } else {
      const d = sit.dog;
      const at = typeof d.x === 'number' && typeof d.y === 'number'
        ? `${Math.round(d.x)},${Math.round(d.y)}` : '?';
      const dist = typeof d.d === 'number' ? `${d.d.toFixed(1)} 格` : '距离不明';
      const modeZh = d.mode === 'goto' ? '正在走过去'
        : d.mode === 'wait' ? '停着'
          : d.mode === 'free' ? '自己活动' : '待命';
      const tgt = d.mode === 'goto' && d.tx >= 0 && d.ty >= 0 ? `（目标 ${d.tx},${d.ty}）` : '';
      lines.push(`${d.n || '狗'}：${at} · 离你 ${dist} · ${modeZh}${tgt}`
        + `${d.mv ? ' · 在动' : ''}${d.blk ? ' · 钉住' : ''}`);
    }
  }

  return lines.join('\n');
}

export interface TipLine {
  key: string;
  text: string;
}

/**
 * 代码算得出来的检查项。
 *
 * 这些不进「事件」——事件是**该打断他的时刻**，而这些是**他想问的时候才有用的清单**。
 * 混在一起她就会每两秒念一遍「你没有绷带」。
 */
export interface TipExtra {
  /**
   * 游戏走全屏路径（独占全屏或无边框满屏）。
   *
   * 这条不是生存建议，是「为什么看不见她」：Windows 会绕开桌面合成器，
   * 桌宠那种置顶窗口物理上画不上去，重新置顶也没用。放在同一个清单里，
   * 是因为他问的时候一定是这句话 ——「怎么没反应 / 你在哪」。
   */
  exclusiveFullscreen?: boolean;
}

export function tipsOf(sit: Situation, extra: TipExtra = {}): TipLine[] {
  const tips: TipLine[] = [];

  if (extra.exclusiveFullscreen) {
    tips.push({
      key: 'fullscreen',
      text: '游戏现在是**全屏路径**（独占全屏，或者无边框铺满屏幕），Windows 绕开了桌面合成，'
        + '我这种置顶窗口物理上就画不上去 —— 不是我卡住了，重新置顶也没用。'
        + '选项 → 视频 → **「全屏」和「无边框」两个勾都要取消**，用带标题栏的窗口模式，我就能待在旁边了。'
        + '只关无边框会变成独占全屏，反而更糟。',
    });
  }

  if (!sit.inGame) return tips;

  if (sit.infected === true) {
    tips.push({ key: 'infected', text: '已经感染了。没有药能治，只有抗生素能压一压、退烧药能扛过发烧；真正决定的是别再被抓第二下。' });
  }
  if (sit.hp !== null && sit.hp < 50) {
    tips.push({ key: 'hp', text: `血量 ${sit.hp}%。先脱离接触再包扎——边打边上绷带的时间不够。` });
  }
  // 极度疲劳是真会昏过去的 —— 昏在大街上基本等于死。所以排在补给清单前面：
  // 提示词里的 `pz.tips` 只取前四条，排后面等于永远不出现。
  const fatigueSpec = NEED_SPECS.find((s) => s.key === 'fatigue');
  if (fatigueSpec && needBandOf(sit.fatigue, fatigueSpec) === 'critical') {
    tips.push({
      key: 'exhausted',
      text: '困到这个程度会直接昏倒，而僵毁里昏在外面就是死。现在该找床，不是再搜一间屋。',
    });
  }
  if (sit.gear) {
    if (sit.gear.bandage <= 0) tips.push({ key: 'bandage', text: '背包里没有绷带。撕件衣服当临时绷带也比空手强，但会脏。' });
    if (sit.gear.water <= 0) tips.push({ key: 'water', text: '没有能喝的水。水龙头停水之后这是第一个要命的东西。' });
    if (sit.gear.light <= 0 && (sit.night || sit.duskSoon)) {
      tips.push({
        key: 'light',
        text: sit.night
          ? '没有光源，天已经黑了。手电 / 打火机 / 蜡烛，随便找一样。'
          : '没有光源，天在暗了。手电 / 打火机 / 蜡烛，随便找一样。',
      });
    }
  }
  if (sit.night && sit.indoors === false) {
    tips.push({ key: 'night-out', text: '夜里还在外面。这个点上街的僵尸比白天难缠得多，能进屋就进屋。' });
  }
  if (sit.weaponPct !== null && sit.weaponPct <= 20) {
    const band = weaponBandOf(sit.weaponPct);
    tips.push({
      key: 'weapon',
      text: band === 'critical'
        ? `${sit.weapon} 就剩 ${sit.weaponCondText?.replace(/\D/g, '')}% 了，再打两下就断。`
          + '断在半路上比一开始就没带更糟 —— 换一把，或者修（胶带 / 木胶）。'
        : `${sit.weapon} 快断了（${sit.weaponCondText}）。背包里最好再放一把备用的。`,
    });
  }
  if (sit.weapon === null) {
    tips.push({ key: 'no-weapon', text: '手上没武器。空手打僵尸基本等于送。' });
  }
  if (sit.endurance !== null && sit.endurance <= 0.25) {
    tips.push({ key: 'endurance', text: '体力见底。这个状态下跑不掉，先找个能关门的地方坐一会儿。' });
  }
  return tips;
}
