/**
 * 新手引导：他该干什么，按游戏里的状态判断，不按天数硬念。
 *
 * 为什么要单独一层：攻略是**清单**，而教人是**下一步**。把七条一起念出来，
 * 新手记住的是零；一次只说一条，而且说清为什么，他才会做。
 *
 * 每一条都必须**能从数据里验证**（手上的武器、背包里的水/绷带/吃的/光源、在不在屋里）——
 * 不能验证的条目（比如「背包够大」「窗帘拉上了」）宁可不要，
 * 否则她会在他已经做到的时候还在催，那比不说更烦。
 *
 * 优先级顺序参考了 Build 42 的新手流程（第一天：武器 → 水 → 医疗 → 食物 → 光源 → 落脚点），
 * 但**看时间调整**：天快黑了还在外面，找落脚点排到最前面，别的都往后放。
 */
import type { Situation } from './perception.ts';

export type StepId = 'weapon' | 'water' | 'bandage' | 'food' | 'light' | 'shelter';

export interface GuideStep {
  id: StepId;
  /** 一句话说明「现在缺什么」。 */
  label: string;
  /** 具体怎么做。带一点理由，但别写成教程。 */
  how: string;
  done: boolean;
}

export interface Guide {
  steps: GuideStep[];
  doneCount: number;
  /** 下一步该干什么。全做完了是 null。 */
  next: GuideStep | null;
  /** 还在这局的头几天（新手期）。过了就不天天念这条线了。 */
  fresh: boolean;
}

/** 新手期：第 1–3 天。攻略里的「第一天清单」基本都在这几天内做。 */
const FRESH_DAYS = 3;

export function guideOf(sit: Situation): Guide {
  // ⚠️ 这里原来是 `gear !== null && gear.water > 0`。`gear` 可能是 `undefined`
  // （数据里没有这个键，见 perception.ts 的 normGear），而 `undefined !== null` 为真，
  // 于是下面读 `.water` 当场抛 —— 真机上表现为整个扩展开不起来。
  // 判空要用真值判断，不用 `!== null`。
  //
  // `gear` 为 null 时这几项一律算「没完成」：可能偏保守（他其实有水），
  // 但方向是安全的 —— 让他多囤点水不会害死人，说「你有水」而他真没水才会。
  const gear = sit.gear;
  const duskOrLate = (sit.hour !== null && sit.hour >= 17) || sit.duskSoon || sit.night;

  const steps: GuideStep[] = [
    {
      id: 'weapon',
      label: '手上还没有能打的',
      how: '厨房里先找平底锅、擀面杖、菜刀、棒球棍——空手出门是新手最常见的死法。'
        + '不用挑，能挡一下就行，以后再换好的。',
      done: sit.weapon !== null,
    },
    {
      id: 'water',
      label: '背包里没有能喝的水',
      how: '自来水不是一直都在（默认可能几天到一个月内停）。趁现在把瓶子、锅、水壶都灌满，'
        + '空的容器也算一样东西——有水了就自动算上。',
      done: gear != null && gear.water > 0,
    },
    {
      id: 'bandage',
      label: '身上没有绷带',
      how: '床单、窗帘、多余的衣服都能撕成布条。抓伤不处理会感染，这条比带武器还容易被忽略。',
      done: gear != null && gear.bandage > 0,
    },
    {
      id: 'food',
      label: '背包里没有吃的',
      how: '先吃冰箱里会坏的，罐头和干货留着。开罐器是个容易忘的小东西，看到就拿。',
      done: gear != null && gear.food > 0,
    },
    {
      id: 'light',
      label: '没有光源',
      how: '手电、打火机、蜡烛都行。晚上别开着灯招僵尸，但包里必须有一个。',
      done: gear != null && gear.light > 0,
    },
    {
      id: 'shelter',
      label: '还没进到屋里',
      how: '清一间房，关门，拉上窗帘。二楼比一楼好——楼梯口堵一下，僵尸就上不来。'
        + '今晚有地方睡，比多搜一间屋子重要。',
      done: sit.indoors === true,
    },
  ];

  // 天要黑了还在外面：落脚点插到最前面。这时候教他灌水是没眼力见。
  if (duskOrLate && sit.indoors === false) {
    const shelter = steps.find((s) => s.id === 'shelter');
    if (shelter && !shelter.done) {
      const rest = steps.filter((s) => s.id !== 'shelter');
      steps.splice(0, steps.length, shelter, ...rest);
    }
  }

  const doneCount = steps.filter((s) => s.done).length;
  return {
    steps,
    doneCount,
    next: steps.find((s) => !s.done) ?? null,
    fresh: sit.day !== null && sit.day <= FRESH_DAYS,
  };
}

/** 一行话，塞进工具回执里。 */
export function describeGuide(g: Guide): string {
  const marks = g.steps.map((s) => `${s.done ? '✓' : '✗'}${s.id === 'shelter' ? '屋里' : s.label.replace(/^.*?没有/, '')}`).join(' ');
  if (!g.next) {
    return `新手那几样都齐了（${marks}）。接下来是囤水和找更好的落脚点，不用再按清单走。`;
  }
  return [
    `新手进度 ${g.doneCount}/${g.steps.length}：${marks}`,
    `下一步：${g.next.label} —— ${g.next.how}`,
  ].join('\n');
}

/* ------------------------------------------------------ 该学什么、做什么 */

export type Stage = 'first' | 'settle' | 'long';

export interface Advice {
  stage: Stage;
  /** 这个阶段的主题，一句话。 */
  title: string;
  /** 该学/该做的东西，按顺序。 */
  items: string[];
}

/**
 * 阶段建议。
 *
 * 这里**不假装知道他技能几级**——数据里没有，编一个等级比不说更糟。
 * 所以给的是「这个阶段该往哪儿使劲」，具体到能做出来的东西。
 * 时间点按默认设置推算（水 0–30 天停、电 14–30 天），
 * 所以他要是改了沙盒设置，这话会偏早或偏晚——宁可偏早。
 */
const SKILL_NAMES: Record<string, string> = {
  woodwork: '木工', cooking: '烹饪', doctor: '急救', electricity: '电工',
  tailoring: '裁缝', farming: '农业', maintenance: '保养', blunt: '钝器',
};

/** 只列出读到的技能。一个都读不到就返回 null（别显示成「全是 0 级」）。 */
export function describeSkills(skills: Record<string, number> | null): string | null {
  if (!skills) return null;
  const parts = Object.entries(SKILL_NAMES)
    .filter(([k]) => typeof skills[k] === 'number')
    .map(([k, label]) => `${label} ${skills[k]}`);
  return parts.length ? parts.join(' · ') : null;
}

export function adviceOf(sit: Situation): Advice {
  const day = sit.day ?? 1;
  // 读到了就用真实等级说话；读不到就只给方向，绝不编一个数。
  const w = sit.skills?.woodwork;
  const el = sit.skills?.electricity;
  const ck = sit.skills?.cooking;
  if (day <= 3) {
    return {
      stage: 'first',
      title: '先活过今晚',
      items: [
        '能打的东西：平底锅、擀面杖、菜刀、棒球棍都行',
        '装水的容器：趁自来水还在，瓶子锅壶全灌满',
        '布条：床单、窗帘、多余衣服都能撕',
        '吃的：先吃冰箱，罐头干货留着，顺便找开罐器',
        '落脚点：二楼、堵楼梯、拉窗帘',
        '电视：前期 Life and Living TV 每天有技能课（烹饪/木工/钓鱼），有电就去看，白涨经验',
      ],
    };
  }
  if (day <= 14) {
    const woodwork = typeof w === 'number'
      ? (w >= 4
        ? `木工 ${w} 级够了——集雨桶能做，材料要木板和钉子（拆家具出木板）`
        : `木工 ${w} 级，还差 ${4 - w} 级到能做集雨桶：拆床、拆柜子升得快（要锤子和锯）`)
      : '木工练到 4 级：拆床拆柜子（要锤子+锯）。4 级能做集雨桶——水停之后就靠它';
    const electricity = typeof el === 'number'
      ? (el >= 1
        ? `电工 ${el} 级，发电机自己能接（但还是得有《How to Use Generators》那本杂志）`
        : '电工还是 0 级：先找《How to Use Generators》杂志，没这本，找到发电机也开不了')
      : '电工：先找《How to Use Generators》杂志，没这本，找到发电机也开不了';
    const cooking = typeof ck === 'number' && ck >= 1
      ? `烹饪 ${ck} 级，继续把快坏的食材做成菜，能多撑几天`
      : '烹饪：把快坏的食材做成菜，能多撑几天';
    return {
      stage: 'settle',
      title: '把日子过成 routine，顺手把水备好',
      items: [
        woodwork,
        cooking,
        electricity,
        '裁缝：补衣服。防护比看起来重要',
        '做东西的顺序：先收纳（木箱/架子），再加固门窗，木矛（长棍+刀）应急',
      ],
    };
  }
  const water = typeof w === 'number' && w < 4
    ? '木工还不到 4 级，集雨桶做不了——这是现在最该补的一件事'
    : '集雨桶接雨水，喝之前用锅烧开';
  return {
    stage: 'long',
    title: '水电都停了，靠自己的水源和电',
    items: [
      water,
      '发电机：油、杂志、别整夜开——声音招东西',
      '菜园和诱捕：新鲜食物比罐头可持续',
      '把落脚点搬到二楼，周边清干净，留一条退路',
    ],
  };
}

/** 一行「这一阶段该干什么」，塞进工具回执。 */
export function describeAdvice(a: Advice): string {
  return `阶段：${a.title}｜${a.items.map((x, i) => `${i + 1}. ${x}`).join('　')}`;
}
