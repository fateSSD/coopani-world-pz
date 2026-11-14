/**
 * 让她自己动手 · 指令编码。
 *
 * 这一段只做一件事：把「走 / 转向 / 打 / 拿 / 停」编码成 Lua 侧认得的**一行 ASCII**，
 * 写进 `<Zomboid>/Lua/coopani-pz-cmd.txt`。执行的活全在游戏里（Lua 侧 `pollCommand`），
 * 这里不解释结果、不重试、不排队 —— 只有一个例外，见 `writtenAtMs`。
 *
 * 协议为什么长这样，三条都是被现实逼出来的：
 *
 * 1. **不用 JSON。** Kahlua 没有 cjson，游戏里手写一个 JSON 解析器，
 *    等于多一处会在深夜崩掉的东西。竖线分隔、定长字段、全 ASCII，够用且不会坏。
 *
 * 2. **seq 必须严格递增。** Lua 侧读到同一条不会再执行一次；这也顺带解决
 *    「指令文件没被改写、但 tick 又读到它」的重复执行。所以 seq 存在扩展实例上，
 *    不用时间戳 —— 同一毫秒下两条指令会撞号。
 *
 * 3. **带 expire。** 她算出来的坐标是基于几秒前的世界。指令压到队尾再执行时，
 *    那个位置可能已经站着一只僵尸。过期就丢，比「忠诚地执行一条过时的命令」安全。
 *
 * 指令是**一次性**的：没有队列、不累积。她要走三个点，就下三次指令。
 * 这不是偷懒 —— 世界在变，第二步该不该走取决于第一步之后看到了什么。
 */

/** 一条指令能做的事。刻意只有五个，多了模型会挑错（社区实测 34 个工具就开始漏调用）。 */
export type PlayVerb =
  | 'walk' | 'face' | 'attack' | 'take' | 'door' | 'eat' | 'drink'
  | 'cook' | 'craft' | 'scan' | 'stop' | 'guard'
  /** 看一眼那一格上有什么容器、里面装了什么。不需要界面，也不需要谁帮她点开。 */
  | 'look'
  /** 把背包里最该拿在手上的那件拿到手上。 */
  | 'equip'
  /** 问游戏「站在这里能做什么」——读的是右键菜单，不是我们猜到的那几个动词。 */
  | 'menu'
  /** 执行 `menu` 清单里的第几项。 */
  | 'pick'
  /** 看 Rimboid 的小队名册（没装那个 mod 就报 no-squad）。 */
  | 'squad'
  /** 给名册里的某个人下工作指令（follow / guard / explore / cook…）。 */
  | 'order'
  /** 招募名册里的某个人。 */
  | 'recruit'
  /**
   * 让名册里的某个人**走到某一格**。
   *
   * 和 `order` 的区别是粒度：`order` 是派活（让它自己的 AI 决定怎么走），
   * `guide` 是我们直接压一条走路动作进它的队列 —— 精确到格。
   */
  | 'guide'
  /** 让她的狗出现（没有就生成一只）。 */
  | 'dog'
  /** 让狗走到某一格。 */
  | 'dogo'
  /** 让狗停在原地。 */
  | 'dogwait'
  /** 放开狗，交回它自己的判断（会跟着你走、遇敌会打）。 */
  | 'dogfree';

export interface PlayCommand {
  verb: PlayVerb;
  /** walk / face / take 用。游戏内世界坐标，不是屏幕像素。 */
  x?: number;
  /**
   * `craft` 用：配方名（游戏里的英文 ID，如 `MakeStoneBlade`）。
   *
   * 名字从 `pz_recipes` 里抄 —— 不许自己拼，也不许猜。协议里空格编码成 `+`，
   * 因为整行是竖线分隔的 ASCII。
   */
  recipe?: string;
  y?: number;
  /** walk 用：走 / 跑 / 潜行。默认走。 */
  stance?: 'walk' | 'run' | 'sneak';
  /** take 用：容器所在格上，它是第几个 object。 */
  objIdx?: number;
  /** take 用：容器里第几件东西。 */
  itemIdx?: number;
  /**
   * `guard` 用：自动还手开不开。
   *
   * 这是**她自己的**开关 —— 游戏侧有一层不等模型决定的反射，僵尸贴脸就转身打。
   * 关掉它等于把命完全交给模型的反应速度（一轮对话 2–5 秒），
   * 一般只在「不想因为自动动手而暴露位置」时才关。
   */
  on?: boolean;
  /**
   * `pick` 用：执行 `menu` 清单里的第几项。
   *
   * 序号从 `pz_state` 的 `menu.list[].i` 抄，不要自己数。
   */
  index?: number;
  /** `order` / `recruit` 用：成员的 id，从 `pz_state` 的 `squad.list[].id` 抄。 */
  id?: string;
  /** `order` 用：十六种工作之一（大小写不敏感）。 */
  job?: string;
  /** 多少秒后作废。默认 25 —— 比一次动作的耗时留出余量，又不至于太久。 */
  ttlSeconds?: number;
}

export const DEFAULT_TTL_SECONDS = 25;

const STANCES = new Set(['walk', 'run', 'sneak']);

/** 定长看过去有点笨，但少一次「字段错位」就少一次查半天。 */
export function encodeCommand(seq: number, c: PlayCommand, nowMs: number): string {
  const ttl = Math.max(3, Math.min(120, Math.round(c.ttlSeconds ?? DEFAULT_TTL_SECONDS)));
  const expire = Math.floor(nowMs / 1000) + ttl;
  const num = (v: number | undefined): string =>
    (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');

  let p1 = '';
  let p2 = '';
  let p3 = '';
  let p4 = '';

  switch (c.verb) {
    case 'walk':
      p1 = num(c.x);
      p2 = num(c.y);
      p3 = STANCES.has(c.stance ?? '') ? (c.stance as string) : 'walk';
      break;
    case 'look':
      p1 = num(c.x);
      p2 = num(c.y);
      break;
    case 'dogo':
      p1 = num(c.x);
      p2 = num(c.y);
      break;
    case 'pick':
      p1 = num(c.index);
      break;
    case 'order':
      // id 可能带 `:`（`ssq:builtin:xxx`），但没有竖线，直接放。
      // 空格还是换成 `+` —— 整行是竖线分隔的 ASCII。
      p1 = (c.id ?? '').trim().replace(/ /g, '+');
      p2 = (c.job ?? '').trim().replace(/ /g, '+');
      break;
    case 'recruit':
      p1 = (c.id ?? '').trim().replace(/ /g, '+');
      break;
    case 'guide':
      p1 = (c.id ?? '').trim().replace(/ /g, '+');
      p2 = num(c.x);
      p3 = num(c.y);
      break;
    case 'face':
      p1 = num(c.x);
      p2 = num(c.y);
      break;
    case 'take':
      p1 = num(c.x);
      p2 = num(c.y);
      p3 = num(c.objIdx);
      p4 = num(c.itemIdx);
      break;
    case 'door':
      // 坐标可以留空 —— Lua 侧会从脚下往外找一圈门，找到最近的推开。
      p1 = num(c.x);
      p2 = num(c.y);
      break;
    case 'craft': {
      // 空格编码成 `+`：整行是竖线分隔的 ASCII，空格在名字里很常见
      // （`Make Stone Blade` 这种）。Lua 侧原样换回来。
      const name = (c.recipe ?? '').trim().replace(/\s+/g, ' ');
      p1 = name.replace(/ /g, '+');
      break;
    }
    case 'guard':
      p1 = c.on === false ? '0' : '1';
      break;
    case 'scan':
    case 'eat':
    case 'drink':
    case 'cook':
      // 都不带参数。吃/喝由 Lua 从背包里挑最该动的那样；做饭由它从 `category = Cooking`
      // 的配方里挑第一道现在**真能做**的（材料、技能、灶台都由游戏自己判）。
      // 让她报菜名会多一层「名字记错」的失败面，而收益只有一个「做指定的那道」。
      break;
    case 'attack':
    case 'stop':
    default:
      break;
  }

  return [seq, c.verb, p1, p2, p3, p4, expire].join('|');
}

/** 这条指令缺不缺必要参数。缺了就别写文件 —— 让 Lua 那边报错不如这边先说清楚。 */
export function validateCommand(c: PlayCommand): string | null {
  const needXy = c.verb === 'walk' || c.verb === 'face' || c.verb === 'take' || c.verb === 'look';
  if (needXy) {
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) return '缺 x 坐标';
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) return '缺 y 坐标';
  }
  if (c.verb === 'take') {
    if (typeof c.objIdx !== 'number') return '缺 objIdx（容器是那一格的第几个 object）';
    if (typeof c.itemIdx !== 'number') return '缺 itemIdx（容器里的第几件）';
  }
  // 门：坐标可省（省了就从脚下往外找一圈）。给了就必须两个都给。
  if (c.verb === 'door') {
    const hasX = c.x !== undefined;
    const hasY = c.y !== undefined;
    if (hasX !== hasY) return '门的坐标要么都给，要么都不给';
    if (hasX && (typeof c.x !== 'number' || typeof c.y !== 'number')) return '门的坐标不是数字';
  }
  if (c.verb === 'pick' && (typeof c.index !== 'number' || !Number.isFinite(c.index))) {
    return '缺 index（要执行 menu 清单里的第几项）';
  }
  if (c.verb === 'order') {
    if (!c.id?.trim()) return '缺 id（从 pz_state 的 squad.list[].id 抄）';
    if (!c.job?.trim()) return '缺 job（follow / hold / guard / patrol / explore / farm / relax / sort / corpses / auto / fish / clean / cook / chop / dismantle / medic）';
  }
  if (c.verb === 'dogo') {
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) return '缺 x 坐标';
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) return '缺 y 坐标';
  }
  if (c.verb === 'guide') {
    if (!c.id?.trim()) return '缺 id（从 pz_state 的 squad.list[].id 抄）';
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) return '缺 x 坐标';
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) return '缺 y 坐标';
  }
  if (c.verb === 'recruit' && !c.id?.trim()) {
    return '缺 id（从 pz_state 的 squad.list[].id 抄）';
  }
  if (c.verb === 'craft') {
    const name = (c.recipe ?? '').trim();
    if (!name) return '缺 recipe（配方名，从 pz_recipes 里抄）';
    if (name.includes('|')) return '配方名里不能有竖线';
  }
  if (c.verb !== 'walk' && c.verb !== 'face' && c.verb !== 'take'
    && c.verb !== 'attack' && c.verb !== 'door' && c.verb !== 'stop'
    && c.verb !== 'eat' && c.verb !== 'drink' && c.verb !== 'cook'
    && c.verb !== 'craft' && c.verb !== 'scan' && c.verb !== 'guard'
    && c.verb !== 'look' && c.verb !== 'equip'
    && c.verb !== 'menu' && c.verb !== 'pick'
    && c.verb !== 'squad' && c.verb !== 'order' && c.verb !== 'recruit'
    && c.verb !== 'guide'
    && c.verb !== 'dog' && c.verb !== 'dogo' && c.verb !== 'dogwait' && c.verb !== 'dogfree') {
    return `不认识的指令：${String(c.verb)}`;
  }
  return null;
}

/**
 * Lua 侧的执行回执，从状态文件里读回来。
 *
 * `ok` 只代表「游戏接受了这条指令」，**不代表动作已经做完**。
 * 走路的完成状态看 `busy`，结果看她自己的坐标有没有变。
 */
export interface PlayAck {
  seq: number;
  verb: string;
  ok: boolean;
  why: string;
}

/** 回执是不是「我这条」。Lua 回的是它最近执行的那条。 */
export function ackFor(ack: PlayAck | null | undefined, seq: number): PlayAck | null {
  if (!ack || typeof ack.seq !== 'number') return null;
  return ack.seq === seq ? ack : null;
}

/**
 * 失败原因的码 → 人话。
 *
 * **为什么 Lua 侧不直接发中文**：Kahlua 的词法器会把源码里的非 ASCII 字符截成单字节，
 * 中文原因字符串进去就变成一串乱码，里面还夹着 0x1F / 0x08 这种控制字节 ——
 * 整份 state 因此变成**非法 JSON**，外面只能报「读到半截 JSON」。
 * 真机就这么翻过一次：数据一个字段都没少，坏在一条「过期了」的说明上。
 *
 * 所以协议里这一格是 **ASCII 码**（`no-square` / `expired:352`），翻译在这边做。
 * 这也顺带让指令通道保持纯 ASCII —— 本来就是为了不被编码问题坑才这么设计的。
 */
const ACK_ZH: Record<string, string> = {
  'no-player': '玩家还没加载',
  dead: '角色已经死了',
  'need-xy': '缺坐标',
  'face-failed': '转向接口报错',
  'no-zombie': '两格内没有僵尸',
  'attack-unavailable': '攻击接口在这个版本上用不了',
  'attack-failed': '这一下没打出去',
  'no-weapon': '包里没有能当武器的东西',
  'no-equip': '这个版本上不能从脚本里装备武器',
  'equip-failed': '装备那一步被游戏拒了',
  'no-menu': '这一格生成不出菜单（游戏没在跑，或者此刻不该有菜单）',
  paused: '游戏是暂停的 —— 暂停时游戏自己不出菜单。先让时间走起来',
  busy: '上一份菜单还在生成，等一拍',
  'menu-error': '生成菜单时出错了',
  'empty-menu': '这一格现在没有任何可做的事',
  'menu-in-use': '他正开着右键菜单 —— 现在去生成会把他的菜单清掉，等一会儿',
  'no-menu-list': '还没问过这儿能做什么 —— 先 menu',
  'stale-menu': '清单过期了（世界变了，或那个东西没了）—— 重新 menu 一次',
  'no-index': '缺序号 —— 要说第几项',
  'bad-index': '清单里没有这一项',
  'not-actionable': '这一项是个子菜单，不是动作',
  'disabled': '这一项此刻是灰的（条件不满足）',
  'pick-failed': '菜单项执行时出错了',
  'no-squad': '没有装 Rimboid（SurvivorSquad）—— 小队这套用不了',
  'need-id': '缺成员 id —— 从 pz_state 的 squad.list[].id 抄',
  'bad-job': '没有这个工作名。十六种：follow / hold / guard / patrol / explore / farm / relax / sort / corpses / auto / fish / clean / cook / chop / dismantle / medic',
  'squad-send-failed': '指令没送进去（那个成员可能已经不在了）',
  'no-member': '名册里没有这个 id',
  'no-body': '这个人现在不在世界里（存着记录，但身体没加载）',
  'guide-failed': '走路动作没压进去（可能它的 AI 正在驱动那个身体）',
  'hands-off': '他正自己操作 —— 这条指令没执行。等他松手再下',
  'no-dog-mod': '没装 Companion Dogs —— 狗这条路不可用',
  'no-dog': '她还没有狗（先说 dog 生成一只）',
  'dog-path-failed': '寻路被拒了（那个格子它去不了）',
  'no-actions': '动作系统还没加载',
  'no-square': '目标那一格还没加载',
  'empty-square': '那一格上没有东西',
  'no-container': '那件东西没有容器',
  'no-items': '容器读不出来',
  'no-stand': '容器周围没有能站的地方',
  'no-door': '身边一圈没有门',
  'door-failed': '这扇门推不开（锁了，或者被家具挡死）',
  'no-craft': '合成系统没加载',
  'no-recipe': '眼下没有能做的菜（材料不够，或者附近没有灶台）',
  'no-such-recipe': '没有这个配方 —— 名字拼错了吧，从 pz_recipes 里抄',
  'cant-craft': '这道现在做不了',
  'no-food': '背包里没有能吃的东西',
  'no-water': '背包里没有能喝的水',
  'eat-failed': '吃东西的动作没排上',
  'drink-failed': '喝水的动作没排上',
};

function whyZh(why: string): string {
  const raw = (why ?? '').trim();
  if (raw === '') return '没给原因';
  const [code, arg] = raw.split(':');
  if (code === 'item') return '';   // 成功，名字在 describeAck 里单独说
  if (code === 'expired') return `这条下得太久了（${arg} 秒前的），已经作废`;
  if (code === 'bad-obj') return `格子里第 ${arg} 个不是容器`;
  if (code === 'bad-item') return `容器里没有第 ${arg} 件`;
  if (code === 'unknown-verb') return `不认识的指令：${arg}`;
  return ACK_ZH[code] ?? raw;
}

/** 给提示词/回执用的一句话。 */
export function describeAck(ack: PlayAck | null): string {
  if (!ack) return '还没有回执 —— 指令可能刚写下去，游戏那一拍还没读到。';
  if (ack.ok) {
    // Lua 成功时会把「具体做了什么」塞进 why。三种前缀：
    //   recipe:MakeSalad  → 做饭做的是哪道
    //   item:面包刀       → 装备的是哪件
    //   menu:阅读         → 从菜单里挑中的是哪一个
    //
    // 不带回来就等于只说「我做了」，而「做了什么」才是她要记住的。
    const why = ack.why ?? '';
    const tip = why.startsWith('recipe:') ? `做的是 ${why.slice(7)}`
      : why.startsWith('item:') ? `拿在手上的是 ${why.slice(5)}`
        : why.startsWith('menu:') ? `做的是「${why.slice(5)}」`
          : '';
    return tip
      ? `游戏接受了（${ack.verb}）：${tip}。做没做完看 busy。`
      : `游戏接受了（${ack.verb}）。做没做完看 busy，结果看坐标有没有变。`;
  }
  return `游戏拒绝了（${ack.verb}）：${whyZh(ack.why ?? '')}`;
}
