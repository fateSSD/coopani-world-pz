/**
 * 游戏侧写出来的那一份 JSON 的形状。
 *
 * 全部字段都可能缺失：Lua 那边每个 API 都包了 pcall，取不到就是 null。
 * **缺席和 0 是两件事** —— 0 是「真没有」，null 是「不知道」。
 * 这一条贯穿到提示词里：她不许把「没读到」说成「你没有」。
 */

export interface RawEvent {
  n: number;
  t: string;
  a?: Record<string, number | string>;
}

export interface RawClock {
  hour: number | null;
  minute: number | null;
  day: number | null;
  night: boolean | null;
}

export interface RawPlayer {
  x: number | null;
  y: number | null;
  z: number | null;
  outside: boolean | null;
  room: string | null;
  building: string | null;
  health: number | null;
  hunger: number | null;
  thirst: number | null;
  fatigue: number | null;
  endurance: number | null;
  stress: number | null;
  /**
   * 心情四项：惊恐、疼痛、无聊、不开心。
   *
   * 全部 0..1、越高越糟。B42 的 `CharacterStat` 枚举在每一份构建里不保证齐全，
   * 所以这四个**可能整片缺失** —— 缺了就是「读不到」，不是「0」。
   */
  panic: number | null;
  pain: number | null;
  boredom: number | null;
  unhappy: number | null;
  visible: number | null;
  infected: boolean | null;
  infection: number | null;
  bodyHealth: number | null;
  weapon: string | null;
  weaponCond: number | null;
  weaponMax: number | null;
  /**
   * 武器脚本里的原始数值，判断「这把好不好使」要用。
   * 三项都可能读不到 —— 读不到就不评，不许拿名字硬猜。
   */
  weaponDmg: number | null;
  weaponRng: number | null;
  weaponTwo: boolean | null;
  offhand: string | null;
  /**
   * 技能等级（B42 的 `Perks`）。只收读到的项 —— 缺的键表示「读不到」，
   * 不是 0 级。外面必须区分这两件事，否则会催一个已经练过的人。
   */
  skills?: Record<string, number> | null;
}

export interface RawGear {
  bandage: number;
  food: number;
  water: number;
  light: number;
}

export interface LootHit {
  /** 显示名（游戏本地化过的）。 */
  n: string;
  /** 3 = 这一局最该先拿的（大锤、发电机、发电机手册），2 = 好东西。 */
  t: number;
  /**
   * 武器脚本的 `MaxDamage`。`null`/缺失 = 读不到。
   *
   * ⚠️ **有这个数不代表它是武器。** 抹布的 `MaxDamage` 是 1.5，和一堆日用品一样。
   * 判断「能不能当武器」只能看 `w`，不能看 `d`。
   */
  d?: number | null;
  /**
   * 这件东西是不是武器（`Category == "Weapon"`）。
   *
   * 为什么不按伤害判：真机翻车过一次 —— 柜台里只有抹布，`d` 比空手高，
   * 于是她对空手的人说「柜里那把伤害 1.5，拿了就能打」。
   * 分类是游戏自己给的，比数值可靠。
   */
  w?: boolean;
  /** 它在容器里的序号。下 `take` 指令要用。 */
  i?: number | null;
}

/**
 * 他**正打开着**的那个容器。`null` = 没开任何容器。
 *
 * 注意 `hits: []` 和 `null` 是两件事：前者是「打开了一个柜子，里面没有值得拿的」，
 * 后者是「他根本没在翻东西」。混在一起说，她就会在他走路时提醒他柜子是空的。
 */
export interface RawLoot {
  /** 容器身份：类型 + 所在格。用来判断「是不是同一个柜子」。 */
  sig: string;
  /** 容器类型，如 `crate` / `fridge` / `desk`。 */
  type: string;
  /** 容器里一共几样东西。 */
  total: number;
  hits: LootHit[];
  /**
   * 这一格里**到底有什么**（前 10 件），不管值不值得拿。
   *
   * `hits` 是给她提醒人用的（大锤、发电机那种），`all` 是给她自己动手用的。
   * 只有 `hits` 的时候她瞎过一次：柜台里两样东西，`total = 2`、`hits = []`，
   * 她只知道「有 2 件、看不见是什么」，于是请人帮她开柜子 —— 而她自己本来就能拿。
   */
  all?: { n: string; i: number; t: number }[] | null;
  /** 容器所在格的世界坐标。下 `take` 指令要用 —— 光说「这个柜子」游戏不知道在哪。 */
  x?: number | null;
  y?: number | null;
  /** 容器是那一格上的第几个 object。一格可能有三个能装东西的东西。 */
  oi?: number | null;
}

export interface RawState {
  v: number;
  seq: number;
  /** os.time() 秒。用来判「这份数据有多旧」。 */
  ts: number;
  alive: boolean;
  kills: number;
  session: string | null;
  clock: RawClock | null;
  player: RawPlayer | null;
  gear: RawGear | null;
  loot?: RawLoot | null;
  /** 最近一条指令的执行回执。`null` = 这一局还没下过指令。 */
  cmd?: PlayAckRaw | null;
  /** 动作队列里还有没有事在做。她靠这个判断「上一步完了没有」。 */
  busy?: boolean;
  /**
   * 她排的指令还剩几条没执行。
   *
   * 通道是队列：她一个回合里连下「走 → 开柜 → 拿」，游戏一条一条做。
   * `busy` 只说「手上有没有活」，这个是「后面还有几件事排着」——
   * 两个数一起看才知道该继续等还是该改主意。
   */
  cmdLeft?: number;
  /**
   * 身边的威胁读数，**反射层量的**：`n` = 三格内的只数，`d` = 到最近那只的距离（格）。
   *
   * 这个比 `player.visible` 准 —— `visible` 是「视线内」，僵尸从背后摸过来它不涨。
   * `d` 为 null 表示三格内没有。
   */
  threat?: RawThreat | null;
  /** 反射层自报：开没开、累计自主出手几次、最近那次干了什么。 */
  reflex?: RawReflex | null;
  /**
   * 他是不是正在自己操作（举枪 / 按着方向键 / 用鼠标点地走）。
   *
   * 这个字段存在的唯一理由：**同一个角色只有一个身体。** 他握着鼠标的时候，
   * 她一条 walk 压下去，他按住的方向键就被顶掉；她一条 take，他正要开的门
   * 就排到后面去了。那不是帮忙，是抢方向盘。
   */
  hands?: RawHands | null;
  /**
   * 她的第二具身体：一条狗（Companion Dogs）。
   *
   * `null` = 没装那个 mod，这条路不可用。`have: false` = 装了但还没生成。
   * 那具身体不占他的方向盘，两个可以同时在线。
   */
  dog?: RawDog | null;
  /**
   * 她刚「看过」的那一格：上面有哪些容器、每个容器里有什么。
   *
   * 和 `loot` 的区别是死穴级的：`loot` 读的是人**正开着**的那个容器（走界面），
   * 她没有界面，所以没人点开过的柜子在她眼里等于不存在。
   * 真机原话：「容器里的东西只有他手动点开才会进 pz_state——想让我拿东西，得他先开柜子。」
   * `peek` 不经过界面，直接问那一格上的容器。
   */
  peek?: RawPeek | null;
  /**
   * 她刚问过的「这儿能做什么」——游戏右键菜单里的选项。
   *
   * 名字是游戏自己给的（本地化过的），原样保留：她挑的时候要照抄。
   */
  menu?: RawMenu | null;
  /**
   * Rimboid 的小队名册。`null` = 没问过，或者没装那个 mod。
   *
   * 那些幸存者不是 `IsoPlayer`，是伪装成僵尸的身体 —— 他们由 Rimboid 自己的 AI 驱动，
   * 我们只能用它的 `SetJob` 说「干什么」，说不了「往哪走」。
   */
  squad?: RawSquad | null;
  /**
   * 最近一次 `scan` 的结果：现在能做哪些东西。
   * `null` = 还没问过。`partial` = 配方太多，2 秒没扫完就停了，这份清单不全。
   */
  craftables?: RawCraftables | null;
  events: RawEvent[];
}

export interface RawPeekBox {
  /** 容器是那一格上的第几个 object —— `take` 的 objIdx。 */
  oi: number;
  /** 容器自己的名字（counter / crate / fridge…）。 */
  n: string;
  /** 里面一共几件。 */
  total: number;
  /** 前 10 件。`i` 是 `take` 的 itemIdx。 */
  items: { n: string; i: number; w: boolean }[];
}

export interface RawPeek {
  /** unix 秒。用来判断这是不是刚看的那一眼。 */
  at: number;
  x: number;
  y: number;
  boxes: RawPeekBox[];
}

export interface RawMenuItem {
  n: string;
  /** 在菜单里的序号 —— `pick` 用它。 */
  i: number;
}

export interface RawSquadMember {
  id: string;
  n: string;
  job: string;
  /** 招募了没有。没招募的说「跟着我」它不会听。 */
  r: boolean;
  x: number | null;
  y: number | null;
}

export interface RawSquad {
  at: number;
  list: RawSquadMember[];
}

export interface RawMenu {
  at: number;
  list: RawMenuItem[];
}

export interface RawDog {
  have: boolean;
  mod: boolean;
  n: string;
  /** `none` / `goto` / `wait` / `free`。 */
  mode: string;
  id: number;
  x: number | null;
  y: number | null;
  /** 到她（玩家）的距离，格。 */
  d: number | null;
  /** 正在移动。 */
  mv: boolean;
  /** 被 `blockMovement` 钉住。 */
  blk: boolean;
  /** `goto` 的目标格。 */
  tx: number;
  ty: number;
}

export interface RawHands {
  on: boolean;
  /** `aiming` / `attacking` / `keys` / `moving`（游戏侧判的依据，只用来排查）。 */
  why: string;
}

export interface RawThreat {
  n: number;
  d: number | null;
}

/**
 * 游戏侧那层「不用问模型就挡一下」的反射。
 *
 * 为什么它得存在：一次模型往返是秒级的，僵尸贴脸只要一秒半。
 * 所以「这一下挡不挡」在游戏里判，模型只管「去哪、做什么」。
 */
export interface RawReflex {
  on: boolean;
  /** 累计自主出手次数。她要知道「刚才那几下不是我打的」。 */
  n: number;
  /** `''` / `attack` / `attack-fail` / `interrupt`（打断手里的活去挡）。 */
  act: string;
}

export interface RawCraftables {
  /** unix 秒。用来判断「这是不是刚扫的那一份」。 */
  at: number;
  partial: boolean;
  list: { n: string; c: string }[];
}

/** Lua 侧回给我们的执行结果。只表示「游戏接不接受」，不表示动作已完成。 */
export interface PlayAckRaw {
  seq: number;
  verb: string;
  ok: boolean;
  why: string;
}
