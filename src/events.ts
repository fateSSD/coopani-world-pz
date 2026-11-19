/**
 * 事件判定：什么算「该打断他的时刻」。
 *
 * 两条来源，别混：
 *
 * 1. **游戏侧报上来的事实**（`raw.events`）—— 掉血、感染、死亡、连杀。有一次算一次，
 *    按序号 `n` 去重。
 * 2. **这一拍的处境和上一拍比**（`Situation` 的增量）—— 换天、天黑、僵尸数跨档。
 *
 * 为什么要有第 2 条：僵尸数从 3 只涨到 9 只这件事，游戏那边没有「事件」可挂，
 * 只有每一拍的快照。跨档判定只能在快照上做，而且必须**记住今天已经报过哪几档**，
 * 不然僵尸数在档位边界上抖一下就报一次——那是最容易把她变成报站机的写法。
 *
 * 还有一条：**重启不重放。** 第一次读到数据时把 `lastN` 直接置成当前最大序号，
 * 不为历史事件开口。重启一次就替三条旧事欢呼，比少说一句难看得多。
 */
import type { RawEvent, RawState } from './types.ts';
import {
  NEED_SPECS, WEAPON_ORDER, needBandIndex, needBandOf, threatBandIndex, weaponBandOf,
  type NeedBand, type Situation, type ThreatBand, type WeaponBand,
} from './perception.ts';
import { hhmm, TV_CHANNEL, TV_FREQ, TV_SKILL_ZH, tvNow } from './tv.ts';

export type Trigger = 'flush' | 'debounce';

export interface Outgoing {
  type: string;
  key: string;
  text: string;
  trigger: Trigger;
  /** 跳过「同一类型最短间隔」的节流。真正会死人的那几种才配。 */
  urgent: boolean;
  /** 供延迟重算（如 pz.nudge）读取的结构化载荷，避免从已拼装文本反解。 */
  nudgeMeta?: {
    tip: string;
    before: string[];
  };
}

export interface JudgeState {
  /** 已经处理到游戏侧的第几条事件。 */
  lastN: number;
  /**
   * 上一次看到的游戏会话号。
   *
   * 游戏重启后，Lua 那边的事件序号 `seq` 从 0 重来，而 `lastN` 是**跨会话落盘**的。
   * 不比会话号的话，新会话的事件编号全都 ≤ 旧游标，会被当成「已经看过」静默丢掉 ——
   * 症状就是「重启游戏之后她一句话不说」，而且不报错、日志里什么都看不出来。
   */
  session: string;
  /**
   * 已经读过至少一份数据。
   *
   * 不能拿 `lastN === 0` 当这个判据 —— 一份**从来没有过事件**的数据会让 lastN 一直是 0，
   * 于是第一次真出事（掉血、死亡）时又被当成「刚启动」，那一条就被吞掉。
   * 实测就是这么漏了第一次死亡。
   */
  armed: boolean;
  /** 上一次看到的游戏内天数。 */
  lastDay: number;
  /** 「天在暗了」已经为哪一天报过。 */
  duskDay: number;
  /** 「入夜」已经为哪一天报过。 */
  nightDay: number;
  /** 威胁档位已经为哪一天报过哪几档。 */
  dangerDay: number;
  dangerBands: ThreatBand[];
  /** 上一次掉血事件的时刻（毫秒），用来做最短间隔。 */
  lastHurtAt: number;
  /**
   * 上一次「提一嘴检查清单」的时刻（毫秒）。
   *
   * 这一条和别的不同：它对应的不是「发生了新事」，而是「这事还悬着」。
   * 清单里的东西（没水、没绷带、武器快断）不会自己变成事件，
   * 但一直不说等于没说 —— 所以要按时间轮着提，而且要换说法，
   * 同一句话念三遍她就成闹钟了。
   */
  nudgeAtMs: number;
  /** 下次该提清单里的第几条（轮着来，不要每次都说最急的那条）。 */
  nudgeIndex: number;
  /** 最近提过的几条原文，用来叫她换说法、别重复。 */
  nudgeRecent: string[];
  /** 上一次「环境不对」的日期（本地日），一天最多一次。 */
  setupDay: string;
  /**
   * 上一次说过的「环境不对」是哪一种，以及是什么时候说的。
   *
   * 原来这里是一个布尔值，结果实测翻车：14:28 说过「去找游戏」，之后一直为 true；
   * 14:45 他真的开了游戏，情况变成了「mod 没勾」—— **这是新情况**，
   * 但布尔值只知道「说过了」，于是她一句不再说，他只能自己猜。
   *
   * 现在按「哪一种」去重：原因变了就重新说，原因没变就别念。
   */
  setupKey: string;
  setupAtMs: number;
  /**
   * 各条身体/情绪状态已经报到哪一档。
   *
   * 为什么要记档位而不是布尔：饿这件事**会反复**。吃到不饿、又饿了，
   * 那是两回，都该说。所以档位掉回 `ok` 时把记录删掉，下次再涨上来还能说一次。
   * 记成「说过了」就再也不会说了 —— 而这一局才刚开始。
   */
  needSeen: Partial<Record<string, NeedBand>>;
  /** 两条状态提醒之间的硬间隔。一次跨三条时别一口气念三句。 */
  needAtMs: number;
  /**
   * 手上这把武器的签名（名字 + 耐久上限）。
   *
   * 换武器必须重置水位：从「快断的刀」换成「新球棍」，如果沿用上一把的档位，
   * 5% → 100% 是「回升」，下一次真掉下来就永远不报了。
   */
  weaponSig: string;
  /** 手上这把武器报到哪一档。 */
  weaponBand: WeaponBand;
  /** 上一个报过的容器身份。翻过的柜子不再念第二遍。 */
  lootSig: string;
  /** 上一次报容器内容的时刻。和 `lootSig` 一起做重复窗口。 */
  lootAtMs: number;
  /**
   * 已经为了哪一天报过电视节目。
   *
   * 一天一次，不按节目去重：一天有 2–3 档课，每档都念一遍，
   * 他在第一天就会把这条声音过滤掉。一次把当天剩下的也告诉他就够了。
   */
  tvDay: number;
}

export function initialJudgeState(): JudgeState {
  return {
    lastN: 0,
    session: '',
    armed: false,
    lastDay: 0,
    duskDay: 0,
    nightDay: 0,
    dangerDay: 0,
    dangerBands: [],
    lastHurtAt: 0,
    nudgeAtMs: 0,
    nudgeIndex: 0,
    nudgeRecent: [],
    setupDay: '',
    setupKey: '',
    setupAtMs: 0,
    needSeen: {},
    needAtMs: 0,
    weaponSig: '',
    weaponBand: 'unknown',
    lootSig: '',
    lootAtMs: 0,
    tvDay: 0,
  };
}

export interface JudgeOptions {
  chattiness: 'quiet' | 'normal' | 'chatty';
  speakDanger: boolean;
  speakDusk: boolean;
  speakHurt: boolean;
  /** 翻柜子翻到好东西时说一句。false = `pz.loot` 完全不产生。 */
  speakLoot?: boolean;
  nowMs: number;
  /** 本地日期 `YYYY-MM-DD`，只用来给「环境不对」做一天一次的闸。 */
  localDay: string;
  /** 每秒最多放几条主动事件。防一次尸潮把上下文刷满。 */
  budgetPerMinute?: number;
  /** 检查清单里还没解决的事。空数组 = 没得可提。 */
  tips?: string[];
  /** 多久提一次清单。0 = 不提。 */
  nudgeEveryMs?: number;
}

const HURT_MIN_GAP_MS = 30_000;
export const MARK = (expr: string): string => `标记（照抄这个，后面必须跟话）：<${expr}>`;

function bandWord(band: ThreatBand): string {
  return { clear: '空旷', few: '几只', swarm: '一群', horde: '一大片', unknown: '看不清' }[band];
}

/** 两条状态提醒之间的硬间隔。一次跨三条指标时，别一口气念三句。 */
const NEED_MIN_GAP_MS = 90_000;

/** 情绪走哪个脸。身体上的事一律 worried，恐慌 scared，低落 sad。 */
const NEED_EXPR: Record<string, string> = {
  hunger: 'worried', thirst: 'worried', fatigue: 'worried', endurance: 'worried',
  pain: 'worried', panic: 'scared', stress: 'worried', unhappy: 'sad', boredom: 'sad',
};

/**
 * 他自己的状态跨档了。
 *
 * 三条规矩，每条都对应一种会让人烦到卸载的写法：
 *
 * 1. **只报 bad 以上。** 「有点饿」是常态，说出来就是报数。
 * 2. **按档位去重，回落到 ok 时清记录。** 饿这件事会反复：吃到不饿、又饿了，
 *    那是两回，都该说；但同一次饥饿从 82% 飘到 83% 不该再说一遍。
 * 3. **一次只说一条。** 三条一起念，他三条都记不住 —— 挑最重的那条。
 */
function judgeNeeds(
  sit: Situation,
  next: JudgeState,
  opts: JudgeOptions,
  take: () => boolean,
): Outgoing | null {
  // 先清水位：掉回 ok 的指标，下次再涨上来还能再说一次。
  // 这一步跟「说不说」无关，所以放在预算判断之前。
  for (const spec of NEED_SPECS) {
    if (needBandOf(sit[spec.key], spec) === 'ok') delete next.needSeen[spec.key];
  }

  const hits: { spec: (typeof NEED_SPECS)[number]; band: NeedBand; v: number }[] = [];
  for (const spec of NEED_SPECS) {
    const v = sit[spec.key];
    const band = needBandOf(v, spec);
    // null = 读不到。**不能当成 ok** —— 那样这条指标就永远静音了，
    // 而读不到和「他很好」是两件事。
    if (v === null || band === null) continue;
    if (band === 'ok' || band === 'mild') continue;
    const seen = next.needSeen[spec.key];
    if (seen && needBandIndex(seen) >= needBandIndex(band)) continue;
    hits.push({ spec, band, v });
  }
  if (!hits.length) return null;

  // 最重的先说。同档就按 NEED_SPECS 的顺序（越靠前越要紧）。
  hits.sort((a, b) => needBandIndex(b.band) - needBandIndex(a.band));
  const top = hits[0];

  // 安静档只报顶格。这条不是「会害死他」，是「他这会儿不舒服」。
  if (opts.chattiness === 'quiet' && top.band !== 'critical') return null;
  if (opts.nowMs - next.needAtMs < NEED_MIN_GAP_MS) return null;
  if (!take()) return null;

  // 跨档的都记上，不只记说的那条 —— 否则下一拍它又「刚跨档」，
  // 连着一分钟里把三条轮流说一遍。
  next.needAtMs = opts.nowMs;
  for (const h of hits) next.needSeen[h.spec.key] = h.band;

  const tag = top.band === 'critical' ? '紧张' : '提醒';
  const expr = NEED_EXPR[top.spec.key] ?? 'worried';
  const pct = Math.round(top.v * 100);
  const other = hits.slice(1)
    .map((h) => (h.band === 'critical' ? h.spec.crit : h.spec.bad))
    .filter(Boolean);

  return {
    type: 'pz.need',
    // key 必须带上这一次的时刻。这类事件**同一档位可以再来一次**（吃完了又饿），
    // 而 `pz.danger` 那种「一天一档只报一次」的 key 天然唯一 —— 这里不行，
    // 用 `session:指标:档位` 做 key 的话第二次会被宿主当成重复静默丢掉。
    key: `pz.need:${sit.session ?? ''}:${top.spec.key}:${top.band}:${opts.nowMs}`,
    trigger: 'flush',
    urgent: false,
    text: [
      `〔${tag}·${expr}〕**他自己的状态**：${top.band === 'critical' ? top.spec.crit : top.spec.bad}`
        + `（${top.spec.name}的读数 ${pct}%）。`,
      `第 ${sit.day ?? '?'} 天 ${sit.clockText ?? ''}，${sit.placeText}，血 ${sit.hp ?? '?'}%。`
        + `视野${bandWord(sit.threatBand)}。`,
      other.length ? `同时还有：${other.join('、')}。` : '',
      '这是他自己在耗，不是外面出事了 —— 一句话就够，别演成警报。',
      `能做的：${top.spec.fix}`,
      MARK(expr),
    ].filter(Boolean).join('\n'),
  };
}

/** 同一个柜子的重复提醒窗口。翻过的柜子别再念第二遍。 */
const LOOT_REPEAT_MS = 5 * 60_000;

/**
 * 两条 `pz.loot` 之间的最小间隔。
 *
 * 真机反馈：「这一把测试下来事件触发了好多」。原因是她每换一个容器就报一条 ——
 * 他一口气翻五个柜台，就是五条。这个数字管的是**节奏**，不是判据：
 * 真的好东西（`t >= 3`，大锤 / 发电机那一档）不受它限制，该打断还是打断。
 */
const LOOT_MIN_GAP_MS = 20_000;

/** 容器类型 → 说法。认不出来就说「柜子」，别硬猜。 */
const CONTAINER_ZH: Record<string, string> = {
  crate: '箱子', crate_big: '大箱子', fridge: '冰箱', freezer: '冷柜',
  desk: '书桌', counter: '柜台', wardrobe: '衣柜', shelves: '架子',
  dresser: '五斗柜', medicine: '药柜', locker: '储物柜', bin: '垃圾桶',
  nightstand: '床头柜', sideboard: '餐边柜',
};

/**
 * 他打开的那个柜子里有没有值得停一下的东西。
 *
 * 这一条的边界比别的都重要，因为它最容易变成外挂：
 *
 * - **只读他已经打开的那一个容器。** 数据来自 `getPlayerLoot`，即界面上那个
 *   「正在翻的柜子」。没打开任何容器时 `sit.loot` 是 null，这条就不存在。
 *   它**不会**预告下一个房间、不会扫地图、不会在他路过时说「这屋里有斧头」。
 * - **重复的柜子不念。** 同一个 `sig` 五分钟内只说一次 —— 否则他反复开关
 *   同一个抽屉，她就反复念同一句。
 * - **不评价他该不该拿。** 说清有什么、他手上是什么，判断留给她。
 */
function judgeLoot(
  sit: Situation,
  next: JudgeState,
  opts: JudgeOptions,
  take: () => boolean,
): Outgoing | null {
  if (opts.speakLoot === false) return null;
  const loot = sit.loot;
  if (!loot) return null;
  if (!Array.isArray(loot.hits) || loot.hits.length === 0) return null;

  // tier 1 是「能撕成布条」这类材料 —— 只有他身上真没绷带时才算值得停。
  // 平时念「有块毛巾」，他只会觉得你在报库存。
  // 真值判断，不用 `!== null` —— `undefined !== null` 为真，接着读 `.bandage` 就抛。
  const needCloth = sit.gear != null && sit.gear.bandage <= 0;
  const worth = loot.hits.filter((h) => (h.t >= 2 ? true : h.t === 1 && needCloth));
  // 安静档只报 tier 3（大锤、发电机那一档）。
  const want = opts.chattiness === 'quiet' ? worth.filter((h) => h.t >= 3) : worth;
  if (!want.length) return null;

  if (loot.sig === next.lootSig && opts.nowMs - next.lootAtMs < LOOT_REPEAT_MS) return null;

  // 连着翻一排柜子时别一条接一条。真正的好东西（t=3）破例 ——
  // 大锤和发电机值得打断，毛巾和杂志不值得。
  const hasBig = want.some((h) => h.t >= 3);
  if (!hasBig && opts.nowMs - next.lootAtMs < LOOT_MIN_GAP_MS) return null;

  if (!take()) return null;

  next.lootSig = loot.sig;
  next.lootAtMs = opts.nowMs;

  // 去重：同一个名字可能在容器里出现好几次（三把菜刀），只说一次。
  const seen = new Set<string>();
  const names: string[] = [];
  for (const h of want) {
    const n = String(h.n ?? '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
    if (names.length >= 3) break;
  }
  if (!names.length) return null;

  const where = CONTAINER_ZH[loot.type] ?? '柜子';
  const top = want[0];
  const rest = names.slice(1);
  const expr = top.t >= 3 ? 'surprised' : 'thinking';

  // 柜里有武器、而且比手上的强 —— 「好东西」里最该说的一句。
  //
  // ⚠️ 只认 `w === true`（游戏分类是 Weapon），**不许按伤害判武器**。
  // 真机翻车过：柜台里只有抹布，抹布的 MaxDamage 也是 1.5，
  // 于是她对空手的人说「柜里那把伤害 1.5 —— 拿了就能打」。抹布不能打。
  const weapons = want.filter((h) => h.w === true && typeof h.d === 'number');
  const best = weapons.length
    ? weapons.reduce((a, b) => ((b.d ?? 0) > (a.d ?? 0) ? b : a))
    : null;
  const theirDmg = best ? (best.d as number) : 0;
  const mineDmg = typeof sit.weaponStat.dmg === 'number' ? sit.weaponStat.dmg : 0;
  const upgrade = best !== null && (sit.weapon === null || theirDmg > mineDmg);
  const upgradeLine = !upgrade ? '' : sit.weapon === null
    ? `柜里的 ${best!.n}（伤害 ${theirDmg}）—— 你手上还空着，拿了就能打。`
    : `柜里的 ${best!.n}（伤害 ${theirDmg}）比手上的 ${sit.weapon}（${mineDmg || '读不到数值'}）强。`;

  return {
    type: 'pz.loot',
    key: `pz.loot:${sit.session ?? ''}:${loot.sig}:${opts.nowMs}`,
    trigger: 'flush',
    urgent: false,
    text: [
      `〔提醒·${expr}〕他正打开的这个${where}里有 **${names[0]}**`
        + `（一共 ${loot.total ?? '?'} 样东西${rest.length ? `，值得看的还有：${rest.join('、')}` : ''}）。`,
      `第 ${sit.day ?? '?'} 天 ${sit.clockText ?? ''}，${sit.placeText}。`
        + `手上${sit.weapon ? `是 ${sit.weapon}${sit.weaponCondText ? `（${sit.weaponCondText}）` : ''}` : '空着'}。`,
      upgradeLine,
      '这些就在他眼前 —— 不是你看别处看到的。提醒一句「别顺手划过去」就够，'
        + '别替他决定拿不拿，也别把整个清单念一遍。',
      MARK(expr),
      // filter 之后空串不会落成空行 —— 没武器时 upgradeLine 是 ''，
      // 直接 join 会在事件正文里留一条空行，她读到的是断开的句子。
    ].filter(Boolean).join('\n'),
  };
}

/**
 * 前期电视上的技能课。
 *
 * 这条不是「攻略」，是**日程**：节目开始前 30 分钟到开播后 60 分钟之间说一句，
 * 一天只说一次，第 5 天之后不再提。
 *
 * 为什么不按节目去重：一天有 2–3 档课（早烹饪、午木工、傍晚采集），
 * 每档都念一遍，他第一天就会把这条声音过滤掉 —— 而过滤掉之后，
 * 别的声音也一起被过滤。一次把当天剩下的也告诉他，够了。
 *
 * 前提是**还有电**（默认 0–30 天内随时停）。数据里读不到电，
 * 所以措辞必须留余地，不能断言「现在就能看」。
 */
export function formatTvText(sit: Situation): string | null {
  const day = sit.day;
  if (day === null) return null;
  const hit = tvNow(sit);
  if (!hit) return null;
  const name = TV_SKILL_ZH[hit.slot.skill];
  const rest = hit.later.map((s) => `${hhmm(s.from)} ${TV_SKILL_ZH[s.skill]}`);
  return [
    hit.upcoming
      ? `〔提醒·happy〕电视上 ${hhmm(hit.slot.from)} 有**${name}课** —— 频道是 **${TV_CHANNEL}**（调频 ${TV_FREQ}）。`
      : `〔提醒·happy〕电视上**正在播${name}课** —— 频道是 **${TV_CHANNEL}**（调频 ${TV_FREQ}）。`,
    `第 ${day} 天 ${sit.clockText ?? ''}，${sit.placeText}。`
      + (rest.length ? `今天后面还有：${rest.join('、')}。` : ''),
    // 中文版里这个频道名**没翻译**，照抄原文就行。他要是问「哪个台」，
    // 答案必须是这串英文 + 频率，意译了他照着找不到。
    `频道名就照抄 \`${TV_CHANNEL}\`，别翻译成中文 —— 游戏里显示的就是这串英文。`
      + '他翻电视的频道列表时，按这串字找。',
    '这是前期最划算的一笔：坐在电视前看，技能白涨，不用出门冒风险。'
      + '前提是还没停电 —— 所以只能说「有电就去看」，别断言他现在就能看。',
    '一件事就够，别顺带把整个节目表倒出来，也别把它说成任务。',
    MARK('happy'),
  ].filter(Boolean).join('\n');
}

export function formatNudgeText(sit: Situation, tip: string, before: readonly string[] = []): string {
  const day = sit.day ?? 0;
  return [
    `〔提醒·随口〕这条还悬着：${tip}`,
    `现在：第 ${day} 天 ${sit.clockText ?? ''}，${sit.placeText}，血量 ${sit.hp ?? '?'}%。`,
    before.length ? `前两回已经说过：${before.join(' / ')}` : '',
    '换一种说法 —— 别用上次的句式，也别把清单原文整句念出来。一句话就够，'
      + '说完该干嘛干嘛，不要追问，也别把它说成新发现的危险。',
  ].filter(Boolean).join('\n');
}

function judgeTv(
  sit: Situation,
  next: JudgeState,
  opts: JudgeOptions,
  take: () => boolean,
): Outgoing | null {
  if (opts.chattiness === 'quiet') return null;   // 安静档不谈日程
  const day = sit.day;
  if (day === null || next.tvDay === day) return null;

  const text = formatTvText(sit);
  if (!text) return null;
  if (!take()) return null;

  next.tvDay = day;
  return {
    type: 'pz.tv',
    key: `pz.tv:${sit.session ?? ''}:${day}`,
    trigger: 'flush',
    urgent: false,
    text,
  };
}

/**
 * 手上的武器快断了。
 *
 * 判定比 need 麻烦一档：耐久**不只会掉**。打完一场修一下、换一把更好的，
 * 数值就回升了。所以水位绑在「这一把武器」上（名字 + 耐久上限），
 * 换武器直接重来，不报 —— 换刀这件事本身不需要她说。
 *
 * 只在 low / critical 报。一把刀从 80% 掉到 60% 说一句就是在报数。
 */
function judgeWeapon(
  sit: Situation,
  next: JudgeState,
  opts: JudgeOptions,
  take: () => boolean,
): Outgoing | null {
  const pct = sit.weaponPct;
  // 空手、或者这件东西根本没有耐久（水壶、手电电池那种读不到 max）。
  if (sit.weapon === null || pct === null) {
    next.weaponSig = '';
    next.weaponBand = 'unknown';
    return null;
  }

  const sig = `${sit.weapon}|${sit.weaponMax ?? 0}`;
  const band = weaponBandOf(pct);
  const idx = WEAPON_ORDER.indexOf(band);

  if (sig !== next.weaponSig) {
    // 第一次见到这一把（或者刚换过）。只记水位，不为它开口 ——
    // 例外是刚拿起来就已经快断了：那这件事本身就得说。
    const first = next.weaponSig === '';
    next.weaponSig = sig;
    next.weaponBand = band;
    if (!first || band !== 'critical') return null;
  } else {
    const prevIdx = WEAPON_ORDER.indexOf(next.weaponBand);
    next.weaponBand = band;
    // 修好了、或者换了件同型号的新货：水位跟着降，下次再掉还能说。
    if (idx <= prevIdx) return null;
    if (band !== 'low' && band !== 'critical') return null;
  }

  if (!take()) return null;

  const expr = band === 'critical' ? 'scared' : 'worried';
  const left = Math.max(0, Math.round(pct));
  return {
    type: 'pz.weapon',
    key: `pz.weapon:${sit.session ?? ''}:${sig}:${band}:${opts.nowMs}`,
    trigger: 'flush',
    urgent: band === 'critical',
    text: [
      `〔${band === 'critical' ? '紧张' : '提醒'}·${expr}〕手上的 **${sit.weapon}** 耐久只剩 ${left}%`
        + `${band === 'critical' ? ' —— 下一只就可能断在手里' : ' —— 再打几只就断了'}。`,
      `第 ${sit.day ?? '?'} 天 ${sit.clockText ?? ''}，${sit.placeText}，视野${bandWord(sit.threatBand)}。`,
      '断在半路上比一开始就没带更糟。这句话该在他还打得动的时候说，不是等它断了再说。',
      MARK(expr),
    ].filter(Boolean).join('\n'),
  };
}

/**
 * 事件正文的写法有一条硬线：**数字和事实在这里说死，态度留给提示词**。
 *
 * 这里不写「你快跑」，写「9 只，血 62%」。她怎么反应由她定 ——
 * 写死了就成了命令，而且换个人设就整段作废。
 */
export function judge(
  prevState: JudgeState,
  sit: Situation,
  raw: RawState | null,
  opts: JudgeOptions,
): { out: Outgoing[]; next: JudgeState } {
  const next: JudgeState = {
    ...prevState,
    dangerBands: [...prevState.dangerBands],
    // 必须深拷一层：浅拷时 next.needSeen 和 prevState 是**同一个对象**，
    // 改它等于改上一拍 —— 落盘的状态会跟着变，而这一拍可能因为预算不够没说话。
    needSeen: { ...prevState.needSeen },
  };
  const out: Outgoing[] = [];
  const budget = opts.budgetPerMinute ?? 8;
  let spent = 0;
  const take = (): boolean => {
    if (spent >= budget) return false;
    spent += 1;
    return true;
  };

  const quiet = opts.chattiness === 'quiet';
  const chatty = opts.chattiness === 'chatty';
  const day = sit.day ?? 0;
  const nowMs = opts.nowMs;

  if (raw && sit.inGame) {
    // `events` 也可能整个键都不存在（精简过的 / 旧版的 state 文件），
    // 直接 `.reduce` 就是「读档那一下崩」。跟 gear 那次是同一个形状。
    const events: RawEvent[] = Array.isArray(raw.events) ? raw.events : [];

    // 换了一个游戏会话：事件编号从头开始，水位必须跟着归零。
    const session = typeof raw.session === 'string' ? raw.session : '';
    if (session && session !== next.session) {
      next.session = session;
      // 只在「之前已经处理过事件」时归零；第一次读数据的判断交给下面那段，
      // 否则会把启动时就堆在缓冲里的历史事件当成新消息全说一遍。
      if (next.armed) next.lastN = 0;
      // 新一局：从现在开始计时，进来那一刻先别念清单。
      next.nudgeAtMs = opts.nowMs;
      next.nudgeIndex = 0;
      next.nudgeRecent = [];
      // 上一局的状态水位全部作废。不清的话，新角色一上来就饿到 90%，
      // 而水位里记着「上一局已经报过」，她会一直不说 —— 换个人她就不认识了。
      next.needSeen = {};
      next.needAtMs = 0;
      next.weaponSig = '';
      next.weaponBand = 'unknown';
      next.lootSig = '';
      next.lootAtMs = 0;
      next.tvDay = 0;
    }

    // 第一次读到数据：只记水位，不为历史事件开口。
    if (!next.armed) {
      next.armed = true;
      next.lastN = events.reduce((m, e) => Math.max(m, e.n), 0);
    } else if (events.length > 0) {
      const fresh = events.filter((e) => e.n > next.lastN).sort((a, b) => a.n - b.n);
      for (const ev of fresh) {
        next.lastN = Math.max(next.lastN, ev.n);
        const made = fromRawEvent(ev, sit, next, opts, { quiet, chatty });
        if (made && take()) out.push(made);
      }
    }
  }

  if (sit.inGame) {
    // 换天
    if (day > 0 && next.lastDay > 0 && day !== next.lastDay) {
      if (take()) {
        out.push({
          type: 'pz.day.start',
          key: `pz.day:${sit.session ?? ''}:${day}`,
          trigger: 'debounce',
          urgent: false,
          text: `〔提醒〕新的一天：第 ${day} 天，${sit.clockText ?? '天刚亮'}。${sit.placeText}，血量 ${sit.hp ?? '?'}%。`,
        });
      }
    }
    if (day > 0) next.lastDay = day;

    // 天在暗了：一天一次，19 点之后。
    const hour = sit.hour;
    if (opts.speakDusk && !sit.night && hour !== null && hour >= 19 && next.duskDay !== day) {
      next.duskDay = day;
      if (take()) {
        out.push({
          type: 'pz.dusk',
          key: `pz.dusk:${sit.session ?? ''}:${day}`,
          trigger: 'flush',
          urgent: true,
          text: [
            `〔提醒·worried〕天在暗了，第 ${day} 天 ${sit.clockText}。现在${sit.placeText}，血量 ${sit.hp ?? '?'}%。`,
            sit.indoors === false ? '你还在外面。' : '你在屋里。',
            sit.gear && sit.gear.light <= 0 ? '背包里没有光源。' : '',
            MARK('worried'),
          ].filter(Boolean).join('\n'),
        });
      }
    }

    // 危险：跨档上升才报，同一天同一档只报一次。
    if (opts.speakDanger && next.dangerDay !== day) {
      next.dangerDay = day;
      next.dangerBands = [];
    }
    const band = sit.threatBand;
    const bandIdx = threatBandIndex(band);
    if (opts.speakDanger && bandIdx >= 1) {
      const worst = next.dangerBands.reduce((m, b) => Math.max(m, threatBandIndex(b)), -1);
      if (bandIdx > worst) {
        next.dangerBands.push(band);
        const minBand = quiet ? 2 : 1;
        if (bandIdx >= minBand && take()) {
          const expr = band === 'horde' ? 'scared' : 'worried';
          out.push({
            type: 'pz.danger',
            key: `pz.danger:${sit.session ?? ''}:${day}:${band}`,
            trigger: 'flush',
            urgent: band === 'horde',
            text: [
              `〔${band === 'horde' ? '危险' : '紧张'}·${expr}〕视野里的僵尸多起来了：${sit.visible ?? '?'} 只（${bandWord(band)}）。`,
              `你 ${sit.hp ?? '?'}% 血，${sit.placeText}，手上${sit.weapon ? `是 ${sit.weapon}` : '没武器'}。`,
              sit.endurance !== null && sit.endurance <= 0.3 ? '体力也快没了。' : '',
              MARK(expr),
            ].filter(Boolean).join('\n'),
          });
        }
      }
    }
    // ── 他自己什么样 ──
    //
    // 这一条和危险那几条不是一个性质：僵尸多了是「外面出事了」，饿了是「他自己在耗」。
    // 前者她必须说；后者如果永远不说，她就只是在看场面，没在看他这个人。
    const need = judgeNeeds(sit, next, opts, take);
    if (need) out.push(need);

    // ── 手上的东西还能不能打 ──
    //
    // 单独一条，不并进 need：武器耐久不是「他的状态」，是「他的装备」，
    // 触发条件也不同（同一把武器往下跨档 vs 指标涨上去）。
    const weapon = judgeWeapon(sit, next, opts, take);
    if (weapon) out.push(weapon);

    // ── 他打开的那个柜子里有什么 ──
    const loot = judgeLoot(sit, next, opts, take);
    if (loot) out.push(loot);

    // ── 前期电视上的技能课 ──
    const tv = judgeTv(sit, next, opts, take);
    if (tv) out.push(tv);

    // ── 定时提一句清单 ──
    //
    // 只在「这一拍没有别的话要说」时提（out.length === 0），
    // 免得和危险/掉血/入夜抢同一句话。轮着来，不总是挑最急那条 ——
    // 老说同一条，她听着就像报站机。最近说过的三条会一起给她，
    // 让她自己换说法。
    const tips = opts.tips ?? [];
    const everyMs = opts.nudgeEveryMs ?? 0;
    if (everyMs > 0 && tips.length > 0 && next.nudgeAtMs === 0) {
      // 第一次见到（刚进游戏，或判定状态是新的）：从现在开始计时。
      // 不能把 0 当成「上一次是 1970 年」—— 那样一进游戏就先念一条清单，
      // 而这恰恰是最不该开口的时刻。
      next.nudgeAtMs = nowMs;
    } else if (everyMs > 0 && out.length === 0 && tips.length > 0
      && nowMs - next.nudgeAtMs >= everyMs && take()) {
      const tip = tips[next.nudgeIndex % tips.length];
      next.nudgeIndex = (next.nudgeIndex + 1) % tips.length;
      next.nudgeAtMs = nowMs;
      const before = next.nudgeRecent.slice(-2);
      next.nudgeRecent = [...next.nudgeRecent, tip].slice(-4);

      out.push({
        type: 'pz.nudge',
        key: `pz.nudge:${sit.session ?? ''}:${Math.floor(nowMs / 60000)}`,
        trigger: 'flush',
        urgent: false,
        text: formatNudgeText(sit, tip, before),
        nudgeMeta: { tip, before },
      });
    }

  }

  return { out, next };
}

function fromRawEvent(
  ev: RawEvent,
  sit: Situation,
  state: JudgeState,
  opts: JudgeOptions,
  flags: { quiet: boolean; chatty: boolean },
): Outgoing | null {
  const a = ev.a ?? {};
  const num = (k: string): number | null => (typeof a[k] === 'number' ? a[k] as number : null);

  if (ev.t === 'session_start') {
    return {
      type: 'pz.session.start',
      key: `pz.session:${sit.session ?? String(ev.n)}`,
      trigger: 'flush',
      urgent: false,
      text: [
        `〔提醒〕他进游戏了。第 ${sit.day ?? '?'} 天 ${sit.clockText ?? ''}，${sit.placeText}。`,
        sit.hp !== null ? `血量 ${sit.hp}%。` : '',
        MARK('happy'),
      ].filter(Boolean).join('\n'),
    };
  }

  if (ev.t === 'death') {
    return {
      type: 'pz.death',
      key: `pz.death:${sit.session ?? ''}:${ev.n}`,
      trigger: 'flush',
      urgent: true,
      text: [
        `〔危险·sad〕他死了。第 ${sit.day ?? '?'} 天，${sit.placeText}。`,
        '这是这一档的结束——下一档是新角色，别把这局的血量和装备带过去说。',
        MARK('sad'),
      ].join('\n'),
    };
  }

  if (ev.t === 'infected') {
    return {
      type: 'pz.infected',
      key: `pz.infected:${sit.session ?? ''}:${ev.n}`,
      trigger: 'flush',
      urgent: true,
      text: [
        `〔危险·scared〕他被咬了 —— **已经感染**。感染值 ${num('level') ?? '?'}。`,
        '僵毁里感染没有解药。能做的只有压症状、别再被抓第二下。',
        MARK('scared'),
      ].join('\n'),
    };
  }

  if (ev.t === 'hurt') {
    if (!opts.speakHurt) return null;
    const loss = num('loss') ?? 0;
    if (loss < 0.04) return null;
    if (opts.nowMs - state.lastHurtAt < HURT_MIN_GAP_MS) return null;
    state.lastHurtAt = opts.nowMs;
    const pct = Math.round(loss * 100);
    const hp = num('health');
    return {
      type: 'pz.hurt',
      key: `pz.hurt:${sit.session ?? ''}:${ev.n}`,
      trigger: 'flush',
      urgent: pct >= 15,
      text: [
        `〔${pct >= 20 ? '危险' : '紧张'}·${pct >= 20 ? 'scared' : 'worried'}〕他刚挨了一下，掉了 ${pct}% 血。`,
        hp !== null ? `现在 ${Math.round(hp * 100)}%。` : '',
        sit.gear && sit.gear.bandage <= 0 ? '背包里没有绷带。' : '',
        MARK(pct >= 20 ? 'scared' : 'worried'),
      ].filter(Boolean).join('\n'),
    };
  }

  if (ev.t === 'night') {
    return {
      type: 'pz.night',
      key: `pz.night:${sit.session ?? ''}:${ev.n}`,
      trigger: 'flush',
      urgent: false,
      text: [
        `〔提醒〕入夜了。${sit.placeText}，血量 ${sit.hp ?? '?'}%。`,
        sit.indoors === false ? '人还在外面。' : '',
        MARK('worried'),
      ].filter(Boolean).join('\n'),
    };
  }

  if (ev.t === 'kill') {
    const count = num('count') ?? 0;
    if (count < 5 || flags.quiet) return null;
    return {
      type: 'pz.kill',
      key: `pz.kill:${sit.session ?? ''}:${ev.n}`,
      trigger: 'debounce',
      urgent: false,
      text: `〔提醒·determined〕刚才一小会儿里倒下了 ${count} 只。`,
    };
  }

  return null;
}
