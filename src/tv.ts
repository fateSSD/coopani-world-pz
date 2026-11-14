/**
 * 前期的电视技能节目表。
 *
 * ## 数据从哪来
 *
 * `media/radio/RadioData.xml` 里的 **Life and Living TV**（频道 203）。
 * 每个 `BroadcastEntry` 的 `timestamp` / `endstamp` 单位是**游戏内分钟**
 * （1440 = 一天），`LineEntry` 的 `codes` 写着这一段台词给什么：
 * `FIS+1` 钓鱼、`COO+1` 烹饪、`CRP+1` 木工、`FRM+1` 农业、`FOR+1` 采集、
 * `TRA+1` 陷阱、`BOR-1` 降无聊、`RCP=...` 学配方。
 *
 * ## 为什么手抄一份而不是运行时读
 *
 * 那个 XML 有一万五千行、七万多个字符。在 Kahlua 里解析 XML 要自带一个解析器，
 * 而 `readPlayer` 是每拍都跑的 —— 为了几条节目单把主循环拖慢不划算。
 * 手抄的代价是**游戏改了节目表才会失效**，而失效的表现只是「她说的时间点
 * 电视上没节目」，不会报错、不会崩。这个代价可以接受。
 *
 * 手抄自 B42（42.21）。核对方法：打开上面那个 XML，搜 `Life and Living TV`。
 *
 * ## 为什么只抄前五天
 *
 * 节目表其实排到第 9 天，但第 6 天以后他自己就上手了，
 * 而**前期有电**才是这条建议成立的前提（默认 0–30 天内随时停）。
 * 天天念「电视上有课」会变成闹钟 —— 见 `TV_DAYS_MAX`。
 */
import type { Situation } from './perception.ts';

export type TvSkill = 'fishing' | 'cooking' | 'carpentry' | 'farming' | 'foraging' | 'trapping';

export interface TvSlot {
  /** 第几天，1-based，和 `Situation.day` 同口径。 */
  day: number;
  /** 当天开始分钟（0–1439）。 */
  from: number;
  /** 当天结束分钟。 */
  to: number;
  skill: TvSkill;
}

export const TV_SKILL_ZH: Record<TvSkill, string> = {
  fishing: '钓鱼',
  cooking: '烹饪',
  carpentry: '木工',
  farming: '农业',
  foraging: '采集',
  trapping: '陷阱',
};

/**
 * 节目表。`from`/`to` 是当天分钟数。
 *
 * 第 1 天 00:00 那档钓鱼节目留着 —— 默认角色 9:00 出生赶不上，
 * 但沙盒里能改出生时间，写死反而会在改过设置的人那儿漏掉一次。
 */
export const TV_SLOTS: readonly TvSlot[] = [
  // ── 第 1 天 ──
  { day: 1, from: 0, to: 360, skill: 'fishing' },
  { day: 1, from: 360, to: 720, skill: 'cooking' },
  { day: 1, from: 720, to: 1080, skill: 'carpentry' },
  { day: 1, from: 1080, to: 1410, skill: 'fishing' },
  // ── 第 2 天 ──
  { day: 2, from: 360, to: 720, skill: 'cooking' },
  { day: 2, from: 720, to: 1080, skill: 'carpentry' },
  { day: 2, from: 1080, to: 1410, skill: 'farming' },
  // ── 第 3 天 ──
  { day: 3, from: 360, to: 720, skill: 'cooking' },
  { day: 3, from: 720, to: 1080, skill: 'carpentry' },
  { day: 3, from: 1080, to: 1410, skill: 'fishing' },
  // ── 第 4 天（晚上那档只有降无聊，没有技能，所以不抄） ──
  { day: 4, from: 360, to: 720, skill: 'cooking' },
  { day: 4, from: 720, to: 1080, skill: 'carpentry' },
  // ── 第 5 天 ──
  { day: 5, from: 360, to: 720, skill: 'cooking' },
  { day: 5, from: 720, to: 1080, skill: 'carpentry' },
  { day: 5, from: 1080, to: 1410, skill: 'foraging' },
];

/** 过了这几天就不再拿电视当话题。 */
export const TV_DAYS_MAX = 5;

/**
 * 频道名与频率。
 *
 * **名字就是游戏里显示的那串英文**，没有中文翻译 —— 查过
 * `media/lua/shared/Translate/CN/`，只有台词被翻了，`ChannelEntry` 的
 * `name` 是硬编码在 `RadioData.xml` 里的。所以不许意译成「生活与生活台」之类，
 * 那会让他照着在游戏里找不到。
 *
 * 频率 203 是同一个 `ChannelEntry` 上的 `freq` 属性 —— 收音机能直接调过去，
 * 电视只能从频道列表里点名字，两个都给。
 */
export const TV_CHANNEL = 'Life and Living TV';
export const TV_FREQ = 203;

/**
 * 提前多少分钟开始提醒，开播后多少分钟还算「刚开播」。
 *
 * 提前 30 分钟：够他从街上走回有电视的屋子。
 * 开播后 60 分钟：他刚进游戏/刚回到屋里时节目还在，这时说才有用 ——
 * 等他听完整场再说就是马后炮。
 */
const TV_LEAD_MIN = 30;
const TV_TAIL_MIN = 60;

/** `hh:mm`，给事件正文用。 */
export function hhmm(minute: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface TvHit {
  /** 正在播（或马上开播）的那档。 */
  slot: TvSlot;
  /** 还没开始就是 true。 */
  upcoming: boolean;
  /** 今天剩下的节目，按时间顺序，不含 `slot` 自己。 */
  later: TvSlot[];
}

/**
 * 现在电视上有没有值得看的课。
 *
 * 返回 null 的条件写死在这里，别在调用处再判一遍：不在游戏里、太晚（第 N 天以后）、
 * 时间读不到。**读不到就是 null** —— 「不知道几点」不能当成「正好在播」。
 */
export function tvNow(sit: Situation): TvHit | null {
  if (!sit.inGame) return null;
  const day = sit.day;
  const hour = sit.hour;
  if (day === null || hour === null) return null;
  if (day < 1 || day > TV_DAYS_MAX) return null;

  // 精确到分钟。只按整点算的话，「开播前 30 分钟」这个窗口会退化成
  // 「整点那一刻」—— 他 05:40 进游戏就永远等不到那句提醒。
  const nowMin = hour * 60 + (sit.minute ?? 0);

  const today = TV_SLOTS.filter((s) => s.day === day);
  const hit = today.find((s) => nowMin >= s.from - TV_LEAD_MIN && nowMin <= s.from + TV_TAIL_MIN);
  if (!hit) return null;

  return {
    slot: hit,
    upcoming: nowMin < hit.from,
    later: today.filter((s) => s.from > hit.from),
  };
}

/** 一行话，塞进 `pz_tips` / 阶段建议。没有节目时返回 null。 */
export function describeTv(sit: Situation): string | null {
  const hit = tvNow(sit);
  if (!hit) return null;
  const name = TV_SKILL_ZH[hit.slot.skill];
  const where = `频道 **${TV_CHANNEL}**（调频 ${TV_FREQ}）`;
  if (hit.upcoming) {
    return `电视 ${hhmm(hit.slot.from)} 有${name}课，${where}。前期这些课白给经验，有电就去看。`;
  }
  return `电视上正在播${name}课，${where}。前期这些课白给经验，有电就开着。`;
}
