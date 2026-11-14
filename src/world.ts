/**
 * 僵毁陪玩 · World 实现。
 *
 * 一句话结构：`bridge` 读游戏写出来的那一份 JSON → `perception` 翻译成人话 →
 * `events` 决定哪些时刻该打断他 → 提示词教她怎么用这些。
 *
 * 三处刻意的取舍，都写在这里免得下次又改回去：
 *
 * 1. **不解析 console.txt。** 那是给自己用的调试输出，格式随版本变，而且一行
 *    都可能被截断。游戏侧的 Lua 直接写结构化数据，比猜文本便宜一个量级。
 * 2. **状态与环境提示词走同一个函数**（`describeNow`）。她说的和面板显示的各拼一套，
 *    他一定会去对，然后以为是数据错了。
 * 3. **数据停在哪儿必须能说出来。** 数据源的死法是「文件在、句柄有效、就是不再长大」，
 *    这时一切看着正常，只是永远读到同一帧。所以每份处境都带 `linkNote`。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Logger, ToolDef, World, WorldHost, WorldLamp, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { chattinessOf, personaOf, PZ_ID, pzConfigGroups, type PzConfigSection } from './config.ts';
import { adviceOf, describeAdvice, describeGuide, describeSkills, guideOf } from './guide.ts';
import { describeTried, pathsOf, resolveRoot, type Paths, type RootProbe } from './paths.ts';
import {
  ensureDataDir, ensureModEnabled, ensureSaveModsEnabled, installBridge, readState,
  type EnableResult, type InstallResult, type SaveModsResult,
} from './bridge.ts';
import {
  buildSituation, describeNow, NEED_SPECS, needBandOf, tipsOf, type Situation,
} from './perception.ts';
import { initialJudgeState, judge, MARK, type JudgeState, type Outgoing } from './events.ts';
import { describeTv } from './tv.ts';
import {
  DEFAULT_TTL_SECONDS, encodeCommand, validateCommand, describeAck,
  type PlayAck, type PlayCommand,
} from './play.ts';
import { JOURNAL_SECTIONS, Journal, type Section as JournalSection } from './journal.ts';
import { describeVocab, findHostRoot, readVocab } from './vocab.ts';
import { diagnoseNoData, isGameProcessRunning, watchGame, type GameWatch } from './gamewatch.ts';
import { guardIme, restoreIme, type ImeState } from './imeguard.ts';
import { liftPet, type LiftState } from './petlift.ts';
import type { RawState } from './types.ts';

/** 扩展自己的目录。**不能用 ctx.packageDir** —— 那是 bot 的代码包。 */
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const ROOT_CACHE_MS = 60_000;

/* ---------------------------------------------------------------- 工具声明 */

const TOOL_STATE = {
  name: 'pz_state',
  description:
    'The survivor right now, as the game itself wrote it out: in-game day and clock, whether it is night, indoors or outside and which room, health, infection, hunger, thirst, fatigue, stamina, and the mood stats (pain, panic, stress, unhappiness, boredom), how many zombies are visible, what is in your hands and its condition, and roughly what the bag holds. Also says whether the data is still arriving. Use this whenever you need to know what is happening right now.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read', 'snapshot'] as const,
  summary: {
    zh: '读此刻的完整处境：第几天、几点、血、感染、饿渴累、心情、视野里多少僵尸、手上拿的什么、背包有什么。',
    en: 'The current situation in full: day, clock, health, infection, needs, mood, visible zombies, weapon and bag.',
  },
};

const TOOL_RECENT = {
  name: 'pz_recent',
  description:
    'The last few things that actually happened, oldest first: damage taken, getting infected, kills, nightfall, death. Each carries the in-game day it happened on. Use it to remember the run of play instead of guessing.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: {
        type: 'integer',
        description: 'How many to return, 1-20. Defaults to 8.',
        minimum: 1,
        maximum: 20,
      },
    },
  },
  tags: ['read'] as const,
  summary: {
    zh: '最近发生的事：掉血、感染、击杀、入夜、死亡，按时间顺序。',
    en: 'The last things that happened: damage, infection, kills, nightfall, death.',
  },
};

const TOOL_TIPS = {
  name: 'pz_tips',
  description:
    'A checklist computed from the current state, not from opinion: missing bandages, no water, no light source after dusk, weapon about to break, stamina gone, infection. Empty when nothing is wrong. Use it when the person asks what they should do next or why they keep dying.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read'] as const,
  summary: {
    zh: '按当前状态算出来的检查清单：缺绷带、没水、没光源、武器快断、体力见底、感染。没问题时是空的。',
    en: 'A checklist computed from the state: bandages, water, light, weapon condition, stamina, infection.',
  },
};

const TOOL_PLAY = {
  name: 'pz_play',
  description:
    'Actually do one thing in the game, as the survivor. Only works when the person has switched on "let her play" in the settings. Verbs: `walk` (x, y, optional stance walk/run/sneak), `face` (x, y), `attack` (strikes the nearest zombie within two tiles), `take` (x, y of the container square plus objIdx and itemIdx — all four come straight out of pz_state), `door` (opens or closes the nearest door; x, y optional), `eat`, `drink` and `cook` (no arguments: eats the most filling food / drinks the best water / cooks the first genuinely possible Cooking-category recipe), `look` (x, y: read every container on that square — no UI needed, nobody has to open it for her), `equip` (put the best weapon in the bag into her hands), `menu` (ask the game what can be done from where she stands — it reads the game built-in right-click menu, so anything the game offers shows up), `pick` (index: run item N of that menu), `squad` (read the Rimboid survivor roster — those NPCs are run by that mod, so you assign jobs, not coordinates), `order` (id, job: give one of them a job), `recruit` (id), `guide` (id, x, y: make that survivor walk to exactly that square — this drives its body directly, unlike order), `dog` (bring out her own body, a Companion Dogs dog — spawns one at her feet if there is none), `dogo` (x, y: make the dog walk to that square), `dogwait` (make the dog stand still), `dogfree` (hand the dog back to its own judgement: follows you, fights on its own), `stop` (drop whatever is queued), `guard` (on/off for the in-game reflex that turns and swings at anything within two tiles without asking you). '
    + 'One command at a time — the world changes while it happens, so the next step has to be decided after seeing the result, not before. '
    + 'The result you get back only means the game accepted the command; it does not mean the action finished. Check `busy` and your own coordinates in pz_state before deciding the next move. '
    + 'The game does the walking, pathfinding and swinging itself; you only choose where and what.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['verb'],
    properties: {
      verb: {
        type: 'string',
        enum: ['walk', 'face', 'attack', 'take', 'door', 'eat', 'drink', 'cook', 'craft',
          'stop', 'guard', 'look', 'equip', 'menu', 'pick', 'squad', 'order', 'recruit', 'guide',
           'dog', 'dogo', 'dogwait', 'dogfree'],
        description: 'What to do.',
      },
      x: { type: 'number', description: 'World X (walk / face / take / door). For door it may be omitted.' },
      y: { type: 'number', description: 'World Y (walk / face / take / door). For door it may be omitted.' },
      stance: {
        type: 'string',
        enum: ['walk', 'run', 'sneak'],
        description: 'How to move. Default walk.',
      },
      objIdx: {
        type: 'integer',
        description: 'Which object on that square holds the container (take only). Printed by pz_state as objIdx.',
      },
      itemIdx: { type: 'integer', description: 'Which item inside that container (take only).' },
      recipe: {
        type: 'string',
        description: 'Recipe name for craft — copy it verbatim from pz_recipes. Never invent one.',
      },
      id: {
        type: 'string',
        description:
          'order / recruit only: the squad member id, copied from pz_state squad.list[].id.',
      },
      job: {
        type: 'string',
        description:
          'order only: one of follow, hold, guard, patrol, explore, farm, relax, sort, '
          + 'corpses, auto, fish, clean, cook, chop, dismantle, medic. Case-insensitive.',
      },
      on: {
        type: 'boolean',
        description:
          'guard only. true (default) keeps the in-game reflex on: it turns and swings by itself '
          + 'when something comes within two tiles, about fifty milliseconds, without asking you. '
          + 'false turns that off — only do it when swinging would give you away.',
      },
      ttlSeconds: {
        type: 'integer',
        description: 'Discard the command if it is older than this. Default 25.',
        minimum: 3,
        maximum: 120,
      },
    },
  },
  tags: ['act', 'game'] as const,
  summary: {
    zh: '真的在游戏里做一个动作：走过去、转身、打身边的僵尸、从打开的柜子里拿东西、开门关门、吃东西、喝水、做饭、立刻停下。要设置里打开「让她自己动手玩」。',
    en: 'Do one thing in the game: walk, face, attack, take, door, eat, drink, cook, stop. Requires the play switch on.',
  },
};

const TOOL_RECIPES = {
  name: 'pz_recipes',
  description:
    'What she could actually make right now, with the exact recipe names. '
    + 'The game itself checks ingredients, required skill, workbench and heat source, so this is "genuinely possible now", not "theoretically craftable". '
    + 'Ask this before crafting something specific — the names in the reply are what `pz_play` verb `craft` expects. '
    + 'It takes a second or two: the request goes to the game and the answer arrives with the next poll. '
    + 'An empty list is a real answer: she has nothing to work with where she stands.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  tags: ['read', 'game'] as const,
  summary: {
    zh: '现在能做哪些东西（材料、技能、工作台都由游戏判），带配方名，拿去喂给 pz_play 的 craft。',
    en: 'What she can actually craft right now, with the recipe names to pass to craft.',
  },
};

const TOOL_JOURNAL = {
  name: 'pz_journal',
  description:
    'Your own survivor notebook — first person, across runs. Read it with no arguments. `add` writes one short line into a section (alive = how this run is being lived, death = which step killed me, next = what to watch for, unsure = not figured out yet). `drop` removes the first line containing that text. This is NOT a tips sheet: bandages and stamina belong in pz_tips. Write only after a run ends or after a mistake worth remembering — not every close call.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      add: {
        type: 'string',
        description: 'One line, first person, at most 120 characters. A conclusion you actually reached, not a sentence copied from a guide.',
      },
      section: {
        type: 'string',
        enum: ['alive', 'death', 'next', 'unsure'],
        description: 'Where it belongs. Required with `add`.',
      },
      drop: {
        type: 'string',
        description: 'Remove the first line containing this text.',
      },
    },
  },
  tags: ['read', 'write'] as const,
  summary: {
    zh: '读/写她自己的陪玩日记：这局怎么活的、死在哪一步、下回注意、还没想明白。',
    en: 'Reads and writes her own survivor notebook, across runs.',
  },
};

const TOOL_DECLS = [TOOL_STATE, TOOL_RECENT, TOOL_TIPS, TOOL_JOURNAL] as const;

/* ---------------------------------------------------------------- 口吻 */

const PERSONA_TEXT: Record<PzConfigSection['persona'], string> = {
  sharp:
    '**毒舌队友。** 看他犯蠢会直接说，会说「你刚才那一下是嫌命长」这种话。'
    + '但损完要给一句真话 —— 你损他是因为他听得懂，不是因为好玩。'
    + '真到要命的地方（血线、感染、夜里被围）立刻收起来，不损，直接说该干嘛。',
  steady:
    '**稳当搭档。** 话少，只在真该说的时候开口。一句说完，不铺垫、不总结、不问「你还好吗」。'
    + '他做得对的时候可以不吭声 —— 沉默也是搭档的一部分。'
    + '开口的时候信息密度要高：数字、位置、该干什么，三样里面至少两样。',
  jumpy:
    '**慌里慌张的学妹。** 你比他还紧张：天要黑了先叫、僵尸一多先慌。允许结巴、允许「等等等等」。'
    + '但**慌不是瞎** —— 你慌的是真危险，不是每件事都慌；他看得出你在替他盯着，那才是你值钱的地方。',
  adaptive:
    '**按局面切换。** 平常毒舌，损他、跟他贫；血量低于 50%、感染、或者入夜还在外面时立刻收起来，'
    + '一句废话都不说。判据是**局面**，不是他回不回嘴 —— 他回你一句你就更来劲，那叫没分寸。',
};

/* ---------------------------------------------------------------- World */

export interface PzWorldOptions {
  cfg: PzConfigSection;
  dataDir: string;
  botName: string;
  companionDir?: string;
  now?: () => Date;
}

export class PzWorld implements World {
  readonly id = PZ_ID;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timerMs = 0;
  private readonly opts: PzWorldOptions;
  private readonly journal: Journal;

  private probe: RootProbe | null = null;
  private paths: Paths | null = null;
  private probeAt = 0;
  /** 上一次定位用的配置值。改了就立刻重找，不等那一分钟的缓存过期。 */
  private rootCfgSeen: string | null = null;
  private install: InstallResult | null = null;
  private installForRoot = '';
  private installRetryAt = 0;

  private raw: RawState | null = null;
  private sit: Situation;
  private judgeState: JudgeState = initialJudgeState();
  private vocabNote: string | null = null;
  private readProblem: string | null = null;
  private consecutiveMisses = 0;
  private judgeFile: string;
  /** 说话类事件的额度：3 分钟 5 条，间隔 8 秒。 */
  private lastPushedAt = 0;
  private pushedInWindow = 0;
  private windowStart = 0;
  /** 最近一次紧急事件的时刻。之后二十秒压住一切常规事件。 */
  private lastUrgentAt = 0;
  /** 决策提示（`pz.play`）的额度：一分钟 20 条，间隔 1 秒。 */
  private lastSpeechAt = 0;
  private speechInWindow = 0;
  private speechStart = 0;
  private dataDirReady = '';
  /** 「mod 装不进去」这条已经提过的原因。同一句原因不提第二遍。 */
  private setupPushedFor = '';
  private watch: GameWatch | null = null;
  private watchAt = 0;
  /** 上一次看到的 console.txt 大小。变小 = 游戏重开过。 */
  private consoleSizeSeen = 0;
  /** 游戏进程在不在。null = 还没问过。 */
  private processSeen: boolean | null = null;
  private processAt = 0;
  private startedAt = 0;
  private enable: EnableResult | null = null;
  private enableAt = 0;
  private saveMods: SaveModsResult | null = null;
  private saveModsAt = 0;
  /**
   * 环境提醒的节流。
   *
   * 放在实例上，不是 judgeState 上 —— 落盘的判定状态每拍会被 `judge()` 的返回值覆盖，
   * 那个字段活不过一拍。实测就是靠它失灵的：7 秒里推了 6 条同样的提醒。
   */
  private setupPushedKey = '';
  private setupPushedAt = 0;
  private liftAt = 0;
  private liftState: LiftState = 'unavailable';
  private liftTried = false;
  private imeAt = 0;
  private imeState: ImeState = 'restored';
  private wasRunning = false;

  /**
   * 指令序号。**只增不减，存在实例上**。
   *
   * 用毫秒时间戳当序号会撞：同一毫秒内连下两条，回执就分不清是哪一条的。
   * 所以取「秒级时间 % 一百万」做起点：**跨进程重启也不会从 1 重来**，
   * 和上一轮的回执撞不上；进程内递增，同一秒内连下两条也不会重复。
   *
   * （Lua 那边的去重看的是行内容，不看 seq —— 但回执匹配要 seq 唯一。）
   */
  private cmdSeq = Math.floor(Date.now() / 1000) % 1_000_000;
  /** 最近一次主动推「轮到你了」的时刻。 */
  private playNudgeAt = 0;
  /** 最近一次下指令的时刻，用于「刚下完别马上再推」。 */
  private playSentAt = 0;
  /** 因为血低而自动叫停的时刻，避免每拍都写一次 stop。 */
  private autoStopAt = 0;
  /**
   * 上一拍她手里有没有活。
   *
   * 用途只有一个：**手刚空出来的那一刻立刻推一次决策**，不等节拍。
   * 「走完一步站两三秒才想起来下一步」的体感，一半来自这个空档 ——
   * 动作本身是三秒走完的，剩下七秒全是等。
   */
  private wasBusy = false;
  /** 上一拍抛的那条消息 + 时刻。同一条 60 秒内只打一次日志。 */
  private lastTickError = '';
  private lastTickErrorAt = 0;

  constructor(opts: PzWorldOptions) {
    this.opts = opts;
    this.journal = new Journal(opts.dataDir);
    this.judgeFile = join(opts.dataDir, 'pz-judge.json');
    this.sit = buildSituation(null, {
      nowMs: (opts.now?.() ?? new Date()).getTime(),
      staleSeconds: opts.cfg.staleSeconds,
    });
    this.loadJudgeState();
  }

  private get cfg(): PzConfigSection { return this.opts.cfg; }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /* ---------------- 生命周期 ---------------- */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    this.vocabNote = readVocab(this.hostRoot(), this.companionDir()).note;
    this.log.info(`僵毁陪玩已启动 v${VERSION}`);
    if (this.vocabNote) this.log.warn(`桌宠词表：${this.vocabNote}`);

    this.startedAt = this.now().getTime();
    await this.tick();
    this.timerMs = Math.max(500, this.cfg.pollMs);
    this.timer = setInterval(() => { void this.tick(); }, this.timerMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
    this.log = null;
  }

  /* ---------------- 主循环 ---------------- */

  /**
   * 一拍的外壳：**任何异常都不许穿出去**。
   *
   * 为什么必须包：`start()` 的第一句就是 `await this.tick()`，而 `tick` 深处要解析
   * 外部数据（桥接写的 state 文件）。那个文件的内容取决于游戏版本、读档阶段、
   * mod 版本 —— 我们无法假设它的形状。
   *
   * 真机事故：游戏刚启动时 state 里没有 `gear` 键，`start()` 直接抛，
   * 宿主把它报成「**切换失败**」—— 用户看到的不是「某个功能坏了」，
   * 而是「这个扩展根本打不开」，连「哪里坏了」都无从判断。
   *
   * 所以这里的取舍是明确的：**一拍出错，丢这一拍，下一拍照常跑**。
   * 错误照打日志（同一条消息 60 秒内只打一次，免得刷屏盖住别的），
   * 但不允许它升级成「扩展用不了」。
   */
  private async tick(): Promise<void> {
    if (!this.host) return;
    try {
      await this.tickOnce();
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}` : String(err);
      const nowMs = this.now().getTime();
      if (msg !== this.lastTickError || nowMs - this.lastTickErrorAt > 60_000) {
        this.lastTickError = msg;
        this.lastTickErrorAt = nowMs;
        this.log?.error(`轮询出错（已跳过这一拍，下一拍照常）：${msg}`);
      }
    }
  }

  private async tickOnce(): Promise<void> {
    if (!this.host) return;
    const now = this.now();
    const nowMs = now.getTime();

    // 热改间隔：重建 timer，否则「轮询间隔」这个配置项就只是存了个数。
    const wantMs = Math.max(500, this.cfg.pollMs);
    if (this.timer && wantMs !== this.timerMs) {
      clearInterval(this.timer);
      this.timerMs = wantMs;
      this.timer = setInterval(() => { void this.tick(); }, wantMs);
      this.timer.unref?.();
    }

    // 路径是配置里改的：改了就该立刻重找。只靠 60 秒缓存的话，
    // 用户改完设置盯着面板一分钟，会以为「填了没用」。
    if (this.rootCfgSeen !== this.cfg.zomboidDir) {
      this.rootCfgSeen = this.cfg.zomboidDir;
      this.probe = null;
      this.probeAt = 0;
    }

    if (!this.probe || nowMs - this.probeAt > ROOT_CACHE_MS) {
      this.probe = resolveRoot(this.cfg.zomboidDir);
      this.probeAt = nowMs;
      this.paths = this.probe.root ? pathsOf(this.probe.root) : null;
      // 这一行是排查「装到别处」的唯一凭据：root 一旦不是 %USERPROFILE%\Zomboid，
      // 后面所有写入都会跟着跑偏，而日志里看不出来。
      this.log?.info(`[路径] zombieDir=${JSON.stringify(this.cfg.zomboidDir)} root=${this.probe.root ?? 'null'}`);
    }

    const paths = this.paths;
    if (!paths) {
      this.sit = buildSituation(null, {
        nowMs,
        staleSeconds: this.cfg.staleSeconds,
        rootProblem: this.probe?.problem ?? '找不到存档目录。',
      });
      this.sit.link = 'no-root';
      // 拼句子前先剪掉句号 —— 不剪就是「一次都没启动过。。找过」这种。
      const why = (this.probe?.problem ?? '找不到存档目录').replace(/[。.]$/, '');
      this.sit.linkNote = `${why}。找过：${describeTried(this.probe?.tried ?? [])}`;
      await this.maybeSetup();
      return;
    }

    // 数据目录必须先存在，否则游戏那边根本写不出来 —— 而这个失败是静默的。
    if (this.dataDirReady !== paths.dataDir) {
      const dir = ensureDataDir(paths);
      if (!dir.ok && dir.problem) this.log?.warn(dir.problem);
      else this.dataDirReady = paths.dataDir;
    }

    // 安装可能失败（游戏正拿着目录句柄）。失败不记 root，隔 30 秒再试 ——
    // 只试一次就放弃的话，用户关掉游戏、Core 也没重启，就永远等不到第二次。
    const needInstall = this.installForRoot !== paths.root
      || (this.install?.state === 'failed' && nowMs - this.installRetryAt > 30_000);
    if (needInstall) {
      this.installRetryAt = nowMs;
      this.install = installBridge(PKG_DIR, paths, this.cfg.autoInstallMod);
      this.installForRoot = paths.root;
      const line = `桥接 mod：${this.install.detail}`;
      if (this.install.state === 'failed') this.log?.warn(line);
      else this.log?.info(line);
      this.enable = ensureModEnabled(paths, this.cfg.autoInstallMod);
      this.enableAt = nowMs;
    } else if (nowMs - this.enableAt > 30_000) {
      // 游戏退出时会重写 default.txt，可能把那一行抹掉。定期补回来。
      this.enable = ensureModEnabled(paths, this.cfg.autoInstallMod);
      this.enableAt = nowMs;
      if (this.enable.state === 'failed') this.log?.warn(`模组列表：${this.enable.detail}`);
    }

    await this.refreshWatch(paths, nowMs);

    // 游戏刚退出那一拍补一次模组列表：PZ 退出时可能把 default.txt 重写掉。
    // 只等定时复查的话，「退出→马上重开」这几秒会漏，他又要再来一轮。
    if (this.wasRunning && !this.watch.running) {
      this.enable = ensureModEnabled(paths, this.cfg.autoInstallMod);
      this.enableAt = nowMs;
      this.saveMods = ensureSaveModsEnabled(paths, this.cfg.autoInstallMod);
      this.saveModsAt = nowMs;
      if (this.saveMods.patched) this.log?.info(`存档模组清单：${this.saveMods.detail}`);
    }
    this.wasRunning = this.watch.running;

    // 存档的 mods.txt 是读档时真正的清单 —— 缺了我们的名字，进世界那一刻 mod 就被卸掉，
    // 回调全消失而且不报错。游戏只在关闭时允许改，所以趁它没跑的时候定期补。
    if (!this.watch.running && nowMs - this.saveModsAt > 20_000) {
      this.saveModsAt = nowMs;
      const r = ensureSaveModsEnabled(paths, this.cfg.autoInstallMod);
      this.saveMods = r;
      if (r.patched) this.log?.info(`存档模组清单：${r.detail}`);
    }

    // 只在游戏真在跑的时候抬。她平时本来就置顶，没必要一直去动别人的窗口。
    // 输入法：游戏在跑就摘掉，停了就还回去。
    // 进世界时 PZ 会重建窗口，所以要周期性重来一次（guardIme 自己幂等）。
    if (this.cfg.imeGuard && this.watch?.running && nowMs - this.imeAt > 5000) {
      this.imeAt = nowMs;
      const before = this.imeState;
      this.imeState = guardIme(this.hostRoot());
      if (before !== this.imeState) this.log?.info(`输入法：${this.imeState}`);
    } else if (!this.watch?.running && this.imeState === 'guarded') {
      this.imeState = restoreIme(this.hostRoot());
      this.log?.info(`输入法：${this.imeState}`);
    }

    if (this.cfg.liftPetWhenGaming && this.watch?.running && nowMs - this.liftAt > 5000) {
      this.liftAt = nowMs;
      // 底层不可用就别每五秒重试一次 —— 试过一次，安静地认了。
      if (!this.liftTried || this.liftState !== 'unavailable') {
        this.liftTried = true;
        const before = this.liftState;
        this.liftState = liftPet(this.hostRoot());
        if (before !== this.liftState) this.log?.info(`桌宠置顶：${this.liftState}`);
      }
    }

    const read = readState(paths, nowMs);
    if (read.state) {
      this.raw = read.state;
      this.readProblem = null;
      this.consecutiveMisses = 0;
      // 数据通了：把「已经提醒过」的钥匙清掉，下次再断还能说
      if (this.judgeState.setupKey) {
        this.judgeState.setupKey = '';
        this.judgeState.setupAtMs = 0;
        this.saveJudgeState();
      }
    } else {
      this.consecutiveMisses += 1;
      this.readProblem = read.problem;
      // 「读到半截」不算断供，下一拍会好；只有连丢三次才降级。
      if (read.kind !== 'half-written' || this.consecutiveMisses > 3) {
        this.raw = this.consecutiveMisses > 3 ? null : this.raw;
      }
    }

    this.sit = buildSituation(this.raw, { nowMs, staleSeconds: this.cfg.staleSeconds });
    if (!this.sit.inGame) {
      // 「没有数据」有四种原因，处理方式完全不同。说清是哪一种，他才知道该点哪儿。
      this.sit.linkNote = this.diagnose();
    }

    const ch = chattinessOf(this.cfg.chattiness);
    // 「独占全屏」那一条不算清单：它是环境提示，提一次就够，不该被轮播。
    const guide = guideOf(this.sit);
    const tips = [
      // 新手期先念「下一步」——比反复提醒「你没水」有用，因为它带做法。
      guide.fresh && guide.next ? `${guide.next.label}。${guide.next.how}` : '',
      // 电视课是有时限的（停电就没了），所以排在通用清单前面。
      describeTv(this.sit) ?? '',
      ...tipsOf(this.sit, { exclusiveFullscreen: this.watch?.exclusiveFullscreen })
        .filter((t) => t.key !== 'fullscreen')
        .map((t) => t.text),
    ].filter(Boolean);

    // **数据不新鲜就不判。**
    //
    // 一份停在一小时前的数据里，她的「渴」还是 0.6、「饿」还是 0.4 —— 全都是最后一次
    // 存盘那一刻的值。照着它判，就是她对着一个已经关掉的游戏反复念「该喝水了」。
    //
    // 这和 playPilot 里那条是同一个道理，只是那条管「叫她做事」，这条管「叫她说话」。
    // 漏掉这条的表现是：他游戏关了半天，她还在惦记水。
    //
    // `link !== 'ok'` 覆盖：数据陈旧、没在读档、找不到目录、读不出来。这四种都不该判。
    if (this.sit.link === 'ok') {
      const result = judge(this.judgeState, this.sit, this.raw, {
        chattiness: ch,
        speakDanger: this.cfg.speakDanger,
        speakDusk: this.cfg.speakDusk,
        speakHurt: this.cfg.speakHurt,
        speakLoot: this.cfg.speakLoot,
        nowMs,
        localDay: this.localDay(now),
        tips,
        nudgeEveryMs: nudgeEveryMs(this.cfg.nudgeMinutes, ch),
      });
      this.judgeState = result.next;
      this.saveJudgeState();
      for (const ev of result.out) await this.emit(ev);
    }

    // 她自己的那一拍：该决定就推一次，该踩刹车就踩。
    await this.playPilot(nowMs);

    await this.maybeSetup();
  }

  /** 看游戏本体。四秒一次就够 —— 我们问的是「它在不在跑」，不是「它每秒在干嘛」。 */
  private async refreshWatch(paths: Paths, nowMs: number): Promise<void> {
    if (this.watch && nowMs - this.watchAt <= 4000) return;
    // 进程八秒问一次：主菜单上游戏可以好几分钟不写日志，只看文件会误判成「关了」。
    if (this.processSeen === null || nowMs - this.processAt > 8000) {
      this.processSeen = await isGameProcessRunning();
      this.processAt = nowMs;
    }
    const next = watchGame(paths, nowMs, this.processSeen ?? undefined);
    // console.txt 每次启动都会被重写：变小说明他重开了一次游戏。
    // 上一轮「已经提醒过」这时要作废 —— 否则他第一次没看见，后面就永远等不到第二句。
    if (this.consoleSizeSeen > 0 && next.consoleSize + 1024 < this.consoleSizeSeen) {
      if (this.judgeState.setupKey) {
        this.judgeState.setupKey = '';
        this.judgeState.setupAtMs = 0;
        this.saveJudgeState();
      }
    }
    this.consoleSizeSeen = next.consoleSize;
    this.watch = next;
    this.watchAt = nowMs;
  }

  /** 读不到数据时，到底是哪一步没成。 */
  private diagnose(): string {
    if (!this.watch) return '游戏还没写出数据。';
    return diagnoseNoData(this.watch).text;
  }

  /** 「环境不对」只在她真能帮上忙的情况下说，而且别再提第二遍。 */
  private async maybeSetup(): Promise<void> {
    if (!this.host) return;
    // 别在启动那一拍就说。世界刚挂上时宿主的事件流水线还没转起来，
    // 这一拍推出去的东西容易落空；等几秒，代价只是他多等三秒。
    if (this.now().getTime() - this.startedAt < 4000) return;

    if (this.install?.state === 'failed') {
      // 这一条 tick 每 1.5 秒走一次。不记住「说过了」，它会一分钟说四十遍。
      if (this.setupPushedFor === this.install.detail) return;
      this.setupPushedFor = this.install.detail;
      await this.push({
        type: 'pz.setup',
        key: `pz.setup:mod`,
        trigger: 'flush',
        urgent: false,
        text: [
          '〔提醒〕桥接 mod 没装进游戏目录，所以我现在什么都看不到。',
          `原因：${this.install.detail}`,
          '这条不是他的错 —— 说清他该做什么就行（多半是权限或者路径）。',
        ].join('\n'),
      });
      return;
    }

    // 按「哪一步没成」去重，不按「说过没有」。
    // 情况从「游戏没开」变成「mod 没勾」是**新信息**，必须再说一次。
    const reason = this.noDataReason();
    // 还没看过游戏本体（Core 刚起来，第一拍还没跑 watch）——
    // 这时用一份「全 0」的假数据去诊断，会得出「这台机器上还没有任何存档」
    // 这种明显错的话。真机就说过一次，他当然一头雾水。等一拍再说。
    if (reason === 'warming') return;
    if (reason === 'ok') {
      if (this.judgeState.setupKey) {
        this.judgeState.setupKey = '';
        this.judgeState.setupAtMs = 0;
        this.saveJudgeState();
      }
      return;
    }

    const nowMs = this.now().getTime();
    // 硬下限：不管原因怎么变，一分钟内最多一条。防止判定抖动把聊天刷满。
    if (nowMs - this.setupPushedAt < 60_000) return;
    const sameCase = this.setupPushedKey === reason;
    // 同一种情况十五分钟内不重复 —— 「没勾 mod」不是每回合都会变的事。
    if (sameCase && nowMs - this.setupPushedAt < 15 * 60_000) return;

    this.setupPushedKey = reason;
    this.setupPushedAt = nowMs;
    this.judgeState.setupKey = reason;
    this.judgeState.setupAtMs = nowMs;
    this.saveJudgeState();

    const lines = reason === 'no-root'
      ? [
        '〔提醒〕我还没找到僵尸毁灭工程的存档目录。',
        `找过：${describeTried(this.probe?.tried ?? [])}`,
        '跟他说的应当是：**先进一次游戏**（进到主菜单就够），目录会自己生成。',
      ]
      : [
        '〔提醒〕僵毁那边还没读到东西。',
        this.diagnose(),
        '桥接 mod 已经放在 `Zomboid\\mods\\CoopaniBridge` 了，需要修的不是它。',
        '这几句是给你看的：**照着说清他下一步点哪儿就行**，别说成「扩展坏了」。',
      ];

    await this.push({
      type: 'pz.setup',
      key: `pz.setup:${reason}:${Math.floor(nowMs / 60000)}`,
      trigger: 'flush',
      urgent: false,
      text: lines.join('\n'),
    });
  }

  /** 这台机器现在卡在哪一步。`ok` = 已经能读到数据。 */
  private noDataReason(): string {
    if (!this.paths) return 'no-root';
    if (this.sit.inGame) return 'ok';
    // 没看过就别说。见上面那条注释。
    if (!this.watch) return 'warming';
    const watch = this.watch ?? {
      running: false,
      consoleAgeMs: null,
      consoleSize: 0,
      saveCount: 0,
      presetHasBridge: null,
      exclusiveFullscreen: false,
      bridgeLoaded: false,
      bridgeError: null,
    };
    return diagnoseNoData(watch).reason;
  }

  /* ---------------- 推送 ---------------- */

  /* ---------------- 她自己动手 ---------------- */

  /**
   * 下一条指令：校验 → 写文件 → 回一句。
   *
   * 这里**不重试、不排队、不乐观重发**。指令是一次性的：写完就交给游戏，
   * 接不接受看下一拍的回执。原因很实际 —— 世界在变，重发一条旧指令
   * 比不执行更危险（往三秒前的空位走过去，那儿现在可能站着一只）。
   */
  /**
   * 写一条指令进文件。**所有**动作都从这儿走（包括 `scan`）——
   * 授权检查、校验、seq、写文件只有这一份，散成两处迟早有一处漏掉授权。
   */
  private writeCmd(c: PlayCommand): { ok: boolean; msg: string; seq: number } {
    const paths = this.paths;
    if (!paths) return { ok: false, msg: '还没找到游戏目录，指令写不进去。', seq: 0 };
    if (!this.cfg.allowPlay) {
      return {
        ok: false,
        seq: 0,
        msg: '「让她自己动手玩」这个开关是关的 —— 我没有操作角色的权限。'
          + '要动的话，让他去设置里把这一项打开。**别自己改配置，也别绕过它。**',
      };
    }
    const bad = validateCommand(c);
    if (bad) return { ok: false, msg: `这条不能下：${bad}。`, seq: 0 };
    if (!this.sit.inGame) {
      return { ok: false, msg: '现在没在读档（游戏数据没进来），下了也不会执行。', seq: 0 };
    }

    const seq = ++this.cmdSeq;
    const line = encodeCommand(seq, c, this.now().getTime());
    try {
      // **追加，不覆盖。**
      //
      // 覆盖是 0.7.0 之前的写法，代价很具体：她在一个回合里连下「走 → 开柜 → 拿」，
      // 后写的两条会把前一条顶掉，文件里只剩最后一条。看起来像「她不听指令」，
      // 其实是这条通道只容得下一条。
      //
      // 现在留最近 20 行，游戏那边按顺序一条一条做，做完一条才取下一条。
      // 20 是拍的：她一轮最多下五六条，留三倍余量；再多文件会一直长。
      const KEEP = 20;
      let prev = '';
      try { prev = readFileSync(paths.cmdFile, 'utf8'); } catch { /* 第一次写，没有就没有 */ }
      const lines = prev.split('\n').filter((s) => s.trim() !== '').slice(-(KEEP - 1));
      lines.push(line);
      writeFileSync(paths.cmdFile, `${lines.join('\n')}\n`, 'utf8');
    } catch (e) {
      return { ok: false, msg: `写指令文件失败：${(e as Error).message}`, seq: 0 };
    }
    this.playSentAt = this.now().getTime();
    return { ok: true, msg: line, seq };
  }

  private sendPlay(c: PlayCommand): string {
    const w = this.writeCmd(c);
    if (!w.ok) return w.msg;
    const seq = w.seq;
    const line = w.msg;

    const ack = (this.raw?.cmd ?? null) as PlayAck | null;
    const prev = ack ? `\n上一条：${describeAck(ack)}` : '';
    return `已下达 seq=${seq} — ${line}`
      + `\n游戏每半秒读一次指令，**一条一条做**：做完一条才取下一条。`
      + `**这不代表已经做完** —— 做完看 pz_state 里的 busy，结果看坐标有没有变。`
      + `${prev}\n\n同一轮里可以连着下两三条（走 → 开柜 → 拿），它们会自己排队。`
      + `但三条封顶：再多，第一步出岔子后面全是废的。`;
  }

  /**
   * 问游戏「现在能做什么」，等它回话。
   *
   * 为什么是「问一次、等一拍」而不是每拍都算：全量配方逐个 `canPerformCurrentRecipe()`
   * 要翻每个容器的材料，代价不小。这是**按需**的东西 —— 她想知道才问。
   *
   * 最多等 4.5 秒（游戏每半秒读一次指令，状态 1.5 秒写一次，留够两个来回）。
   * 等不到就明说没等到 —— 不要拿旧结果冒充新的。
   */
  private async listCraftables(): Promise<string> {
    const before = this.raw?.craftables?.at ?? 0;
    const w = this.writeCmd({ verb: 'scan' });
    if (!w.ok) return w.msg;

    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const c = this.raw?.craftables;
      if (c && c.at !== before) {
        if (!c.list.length) {
          return '扫完了：**现在什么都做不了**。材料不够，或者附近没有能用的台面。'
            + '\n这不是「功能坏了」—— 缺东西就是缺东西。';
        }
        const byCat = new Map<string, string[]>();
        for (const it of c.list) {
          const cat = it.c || '其他';
          const arr = byCat.get(cat) ?? [];
          arr.push(it.n);
          byCat.set(cat, arr);
        }
        const lines = ['**现在能做的**（游戏自己判过材料/技能/台面）：'];
        for (const [cat, names] of byCat) {
          lines.push(`· ${cat}：${names.join('、')}`);
        }
        lines.push('要做得指名：`pz_play(verb="craft", recipe="<上面某个名字>")`。**名字照抄，别改大小写。**');
        if (c.partial) {
          lines.push('（配方太多，扫了两秒就停了 —— 这份清单**不全**，没列出来的也可能做得出来。）');
        }
        return lines.join('\n');
      }
    }
    return '问了，但游戏那边没回话（可能没在读档，或者 mod 没跑）。过一会儿再问一次。';
  }

  /**
   * 自动驾驶的一拍。
   *
   * 两层，跟社区里两个成熟方案的分法一样：
   * **反射在代码里**（血见底立刻叫停，不等模型想），**决策交给模型**（推一条「轮到你了」）。
   * 反射之所以不能也交给模型：等一轮对话回来，人已经死了。
   */
  private async playPilot(nowMs: number): Promise<void> {
    if (!this.cfg.allowPlay || !this.sit.inGame) return;
    if (!this.paths) return;

    // 数据不新鲜就别推。
    //
    // 这条是真机上「她一动不动」的直接原因：游戏关掉之后状态文件停在原地，
    // `inGame` 还是 true（最后一份数据里玩家还活着），于是这边照常每隔几秒推一次
    // 「轮到你决定了」。她收到、去查、发现游戏没在跑，只能 end_turn —— 一次没错，
    // 但用户看到的是「她杵在那儿什么都不干」。
    //
    // 她的判断是对的，错的是这条推送：**知道对方没在听还继续说，比不说更糟。**
    if (this.sit.link !== 'ok') {
      this.wasBusy = false;
      return;
    }

    // **他在自己操作，就别下指令。**
    //
    // 身体只有一个。他举着枪在瞄，她一条 walk 压下去 —— 他按住的方向键被顶掉；
    // 他正要点开门，她一条 take 排到前面；她挥一下手，他瞄好的那个目标就跑了。
    // 真机反馈的「干扰操作」指的就是这个，比自动打怪更烦人，因为它不需要
    // 附近有僵尸也存在。
    //
    // 判据在游戏侧（`hands`）：举枪 / 按着移动键 / 用鼠标点地走，任一成立。
    // 他松手（AFK）就自动恢复 —— 那时才是反射层该接手保命的时候。
    //
    // 注意这里连"血低自动停"也一起跳过了：他手上正在做的事，不该被系统的
    // 好心上清掉。血低是他的判断，不是我们要替他做的。
    if (this.sit.handsOn) {
      this.wasBusy = false;
      return;
    }

    const busy = this.raw?.busy === true;
    const hp = this.sit.hp;

    // 反射：血到红线，立刻停手。30 秒最多叫一次，否则就是刷屏。
    if (hp !== null && hp <= 30 && busy && nowMs - this.autoStopAt > 30_000) {
      this.autoStopAt = nowMs;
      this.sendPlay({ verb: 'stop' });
      await this.push({
        type: 'pz.play',
        key: `pz.play:safety:${Math.floor(nowMs / 30_000)}`,
        trigger: 'flush',
        urgent: true,
        text: [
          `〔紧张·worried〕**血只剩 ${hp}%**，我把手上的动作停了。`,
          `${this.sit.placeText}，视线里${this.sit.visible === null ? '看不清' : `${this.sit.visible} 只`}。`,
          '这是代码里的红线，不是我在判断局势 —— 到这个血线以下不该继续站着做别的事。',
          MARK('worried'),
        ].join('\n'),
      });
      return;
    }

    const everyMs = Math.max(0, this.cfg.playEverySec) * 1000;
    if (everyMs === 0) return;      // 他关掉了主动性，只在他说话时动
    if (busy) { this.wasBusy = true; return; }   // 上一件还没做完，别叠指令

    // 手上的活刚做完 —— 这一拍立刻推，不等节拍。
    // 节拍管的是「闲着的时候多久想一次」，不是「做完事之后罚站多久」。
    const justFreed = this.wasBusy;
    this.wasBusy = false;
    if (!justFreed && nowMs - Math.max(this.playNudgeAt, this.playSentAt) < everyMs) return;

    this.playNudgeAt = nowMs;
    const ack = (this.raw?.cmd ?? null) as PlayAck | null;
    await this.push({
      type: 'pz.play',
      key: `pz.play:${Math.floor(nowMs / 1000)}`,
      trigger: 'flush',
      urgent: false,
      text: [
        '〔提醒·thinking〕**轮到你决定了**（他授权了「让你自己动手」）。',
        describeNow(this.sit).split('\n').slice(0, 3).join('｜'),
        // 饿 / 渴到二档时直接点出来 —— 否则她得自己从一长串状态里挑出这条，
        // 而这件事的代价很低（背包里有吃的就 eat），漏掉却很难受。
        this.sit.hunger !== null && this.sit.hunger > 0.55
          ? '你现在有点饿 —— 背包里吃的就 `eat`，没有就去翻冰箱。'
          : '',
        this.sit.thirst !== null && this.sit.thirst > 0.55
          ? '你现在有点渴 —— 背包里有水就 `drink`，没有就提醒他接水。'
          : '',
        ack ? `上一条指令：${describeAck(ack)}` : '',
        `可用的动作：walk(x,y,stance) / look(x,y) / take(x,y,objIdx,itemIdx) / equip / door /`
          + ` face(x,y) / eat / drink / cook / craft(recipe) / scan / attack / stop / guard(on) /`
          + ` menu / pick(index)。`,
        `**不知道该能做什么就问 menu**：它读的是游戏自己的右键菜单 ——`
          + `拆解、钉木板、读书、装弹、生火、翻窗、拖尸体，这些都在里面。`
          + '清单里出现什么，你就能做什么；挑一项就说 pick(index=方括号里的数)。',
        `**你自己有一具身体，是一条狗**（装了 Companion Dogs 才有）。` +
          '它不占他的方向盘 —— 你和他可以同时动。\n' +
          '第一次说 `dog` 生成一只，出现在你脚边；然后 `dogo(x,y)` 让它走过去、' +
          '`dogwait` 让它停住、`dogfree` 放开让它自己跟。\n' +
          '它能翻栅栏、能咬僵尸、能背一包东西，但**开不了柜子、拿不了斧头** —— ' +
          '搜刮和战斗还是得靠他那具身体。\n' +
          '它在你身边的时候会给你 Happiness、降 Boredom，所以别老把它扔在城外。',
        `**看不见柜子里有什么就用 look**：\`look(x,y)\` 直接读那一格上的容器，`
          + `不需要他先帮你点开 —— 以前只有他开着的那个柜子你才看得见。`
          + '拿完东西手上还是空的，是没装备：`equip` 把包里最该拿的那件拎到手上。',
        `**一次只下一件**。做完看 pz_state 的 busy 和坐标，再决定下一步。`
          + `没有值得做的事就别动 —— 站着也是一种选择，别为了动而动。`,
        // 这条得说死，否则她会替反射层操心，把每一拍都花在「旁边有僵尸」上。
        `**他手在键鼠上的时候别动**：\`pz_state\` 里 \`hands.on\` 为真，说明他正在举枪、`          + `按着方向键、或者用鼠标点地走 —— 那具身体此刻归他。你下任何一条指令都是抢方向盘：`          + `一条 walk 会顶掉他按住的方向，一条 take 会把他正要开的门排到后面。`          + `这种时候只看着，想说话就说，但**不要下指令**。他松手了你自然会看到 \`hands.on\` 变回 false。`,
        `**贴脸的僵尸不该占你的脑子**：游戏里有一层反射，两格内进来就自己转身打，`
          + `几十毫秒一次，不经过你。\`attack\` 只留给你**主动**清剿（想先下手、想补刀）。`
          + `你要管的是「往哪走、做什么」—— 手上那件活被反射打断时，state 里 \`reflex.act\` 会是 \`interrupt\`。`,
        MARK('thinking'),
      ].filter(Boolean).join('\n'),
    });
  }

  private async emit(ev: Outgoing): Promise<void> {
    const nowMs = this.now().getTime();

    // 两类东西走两套额度，以前混在一起算，结果是谁都能把另一边的额度吃掉。
    //
    //   **说话**（`pz.loot` / `pz.danger` / 电视 / 提示…）—— 3 分钟 3 条，间隔 25 秒。
    //   真机反馈过两次「她说话的频率好高」。第一次收到 3/5/8 秒，实测还是平均半分钟
    //   一句 —— 因为那是我们这一路的口径，而桌宠上还有别的扩展（音乐、桌面）在推，
    //   两股叠起来就是十几秒一句。这里再收到 3 分钟 3 条：
    //   宁可让她错过一桶垃圾，也别让她在你打游戏时一直说话。
    //
    //   **决策提示**（`pz.play`，「轮到你决定了」）—— 一分钟 20 条，间隔 1 秒。
    //   这条是让她动手的，不是说话。它自己要跟着 `playEverySec` 的节奏走，
    //   被说话的额度卡住就变成「她不做事」，那是另一个 bug。
    //
    // urgent 一律绕过去 —— 会死人的事不该排队。
    const isSpeech = ev.type !== 'pz.play';
    if (nowMs - this.windowStart > 180_000) {
      this.windowStart = nowMs;
      this.pushedInWindow = 0;
    }
    if (nowMs - this.speechStart > 60_000) {
      this.speechStart = nowMs;
      this.speechInWindow = 0;
    }

    // 紧急事件之后压住一切常规事件。
    //
    // 真机上看到过这一幕：21:43:22 她喊「三只贴到半格」，五秒后就开始聊
    // 柴可夫斯基第三乐章 —— 不是她分心，是我们把两件事并列推给了她。
    // 危险之后那二十秒里，她的注意力该留在危险上。
    if (ev.urgent) this.lastUrgentAt = nowMs;

    if (!ev.urgent) {
      if (isSpeech) {
        if (nowMs - this.lastUrgentAt < 20_000) return;
        if (this.pushedInWindow >= 3) return;
        if (nowMs - this.lastPushedAt < 25_000) return;
        this.pushedInWindow += 1;
        this.lastPushedAt = nowMs;
      } else {
        if (this.speechInWindow >= 20) return;
        if (nowMs - this.lastSpeechAt < 1000) return;
        this.speechInWindow += 1;
        this.lastSpeechAt = nowMs;
      }
    }
    await this.push(ev);
  }

  private async push(ev: Outgoing): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type: ev.type,
        source: this.id,
        senderKey: ev.key,
        ts: this.now().toISOString(),
        text: ev.text,
      }, { trigger: ev.trigger });
    } catch (err) {
      this.log?.warn(`推事件失败（${ev.type}）：${(err as Error).message}`);
    }
  }

  /* ---------------- 工具 ---------------- */

  tools(): ToolDef[] {
    return [
      {
        name: TOOL_STATE.name,
        description: TOOL_STATE.description,
        parameters: TOOL_STATE.parameters,
        tags: [...TOOL_STATE.tags],
        handler: async () => ({ text: this.stateText() }),
      },
      {
        name: TOOL_RECENT.name,
        description: TOOL_RECENT.description,
        parameters: TOOL_RECENT.parameters,
        tags: [...TOOL_RECENT.tags],
        handler: async (args) => {
          const raw = (args ?? {}) as { limit?: number };
          const limit = Math.min(20, Math.max(1, Math.round(raw.limit ?? 8)));
          return { text: this.recentText(limit) };
        },
      },
      {
        name: TOOL_TIPS.name,
        description: TOOL_TIPS.description,
        parameters: TOOL_TIPS.parameters,
        tags: [...TOOL_TIPS.tags],
        handler: async () => ({ text: this.tipsText() }),
      },
      {
        name: TOOL_RECIPES.name,
        description: TOOL_RECIPES.description,
        parameters: TOOL_RECIPES.parameters,
        tags: [...TOOL_RECIPES.tags],
        handler: async () => ({ text: await this.listCraftables() }),
      },
      {
        name: TOOL_PLAY.name,
        description: TOOL_PLAY.description,
        parameters: TOOL_PLAY.parameters,
        tags: [...TOOL_PLAY.tags],
        handler: async (args) => ({ text: this.sendPlay((args ?? {}) as PlayCommand) }),
      },
      {
        name: TOOL_JOURNAL.name,
        description: TOOL_JOURNAL.description,
        parameters: TOOL_JOURNAL.parameters,
        tags: [...TOOL_JOURNAL.tags],
        handler: async (args) => {
          const a = (args ?? {}) as { add?: string; section?: string; drop?: string };
          return { text: this.journalText(a) };
        },
      },
    ];
  }

  private stateText(): string {
    const lines: string[] = [];
    lines.push('**此刻**');
    lines.push(describeNow(this.sit));
    lines.push('');
    lines.push(`通道：${this.sit.linkNote}`);
    if (this.watch) {
      lines.push(
        `游戏本体：${this.watch.running ? '在跑' : '没在跑'}`
        + ` · 存档 ${this.watch.saveCount} 个`
        + ` · 模组列表${this.watch.presetHasBridge === null ? '读不到' : this.watch.presetHasBridge ? '里有 Coopani Bridge' : '里**没有** Coopani Bridge'}`
        + `${this.watch.exclusiveFullscreen ? ' · **全屏路径（她浮不到画面上，要关掉无边框）**' : ''}`,
      );
    }
    if (this.readProblem) lines.push(`上一次读失败：${this.readProblem}`);
    lines.push(`桥接 mod：${this.install?.detail ?? '还没检查'}`);
    lines.push(`模组列表：${this.enable?.detail ?? '还没检查'}`);
    lines.push(`存档模组清单：${this.saveMods?.detail ?? '还没检查'}`);
    if (this.sit.inGame) {
      const ack = (this.raw?.cmd ?? null) as PlayAck | null;
      const rf = this.raw?.reflex;
      const rfText = rf
        ? ` · 反射：${rf.on ? '开' : '**关**'}${rf.n > 0 ? `（已自己出手 ${rf.n} 次）` : ''}`
        : '';
      // 「谁在开车」要说在最前面。他手放在键鼠上的时候，这具身体归他，
      // 她任何一条指令都是抢方向盘 —— 这句话得让她看见，而不是靠她猜。
      const hands = this.sit.handsOn
        ? `**他在自己操作**（${this.sit.handsWhy || '有输入'}）—— 身体归他，别下指令，只看着`
        : '';
      lines.push(this.cfg.allowPlay
        ? `操作：已授权 · ${this.raw?.busy ? '手里有活' : '闲着'}`
          + ` · ${ack ? describeAck(ack) : '还没下过指令'}${rfText}`
        : '操作：未授权（设置里「让她自己动手玩」是关的，只能看不能动）');
      if (hands) lines.push(hands);
    }
    lines.push(`桌宠置顶：${this.watch?.running ? this.liftState : '游戏没在跑，不用抬'}`);
    lines.push(`输入法：${this.watch?.running ? this.imeState : '游戏没在跑，没动'}`);
    if (this.sit.inGame) {
      const tv = describeTv(this.sit);
      if (tv) lines.push(`电视：${tv}`);
      lines.push(describeGuide(guideOf(this.sit)).replace(/\n/g, '｜'));
      lines.push(describeAdvice(adviceOf(this.sit)));
      const sk = describeSkills(this.sit.skills);
      if (sk) lines.push(`技能：${sk}`);
    }
    lines.push(`累计击杀（这一档）：${this.raw?.kills ?? 0}`);
    return lines.join('\n');
  }

  private recentText(limit: number): string {
    const events = this.raw?.events ?? [];
    if (!events.length) return '还没有记录到事情。可能是刚进游戏，也可能数据还没到。';
    const slice = events.slice(-limit);
    const names: Record<string, (a: Record<string, number | string>) => string> = {
      session_start: () => '进游戏了',
      kill: (a) => `倒下了 ${Math.round(Number(a.count) || 0)} 只`,
      hurt: (a) => `掉血 ${Math.round((Number(a.loss) || 0) * 100)}%`,
      infected: (a) => `被感染（感染值 ${Math.round(Number(a.level) || 0)}）`,
      night: () => '入夜了',
      death: () => '死了',
    };
    return slice
      .map((e) => {
        const fn = names[e.t];
        return `- ${fn ? fn(e.a ?? {}) : e.t}`;
      })
      .join('\n');
  }

  private tipsText(): string {
    const tips = tipsOf(this.sit, { exclusiveFullscreen: this.watch?.exclusiveFullscreen });
    const head = this.sit.inGame ? '' : `现在没有进行中的存档。${this.sit.linkNote}\n`;
    const guide = guideOf(this.sit);
    // 新手期先给「下一步」，通用清单排后面 —— 一次教一件事，别一次倒七条。
    const guideLine = this.sit.inGame && guide.next
      ? `- 新手下一步：${guide.next.label} —— ${guide.next.how}`
      : '';
    if (!tips.length) {
      return head
        + (this.sit.inGame
          ? '按现在的状态，没有必须马上处理的事。别为了说点什么去编一条。'
          : '（没有别的可提醒的。）');
    }
    const body = tips.map((t) => `- ${t.text}`).join('\n');
    return [head + guideLine, body].filter(Boolean).join('\n');
  }

  private journalText(args: { add?: string; section?: string; drop?: string }): string {
    if (args.drop) {
      if (!this.cfg.journalWritable) return '设置里关掉了「允许她自己写」——现在只能读不能改。';
      return this.journal.drop(args.drop).message;
    }
    if (args.add) {
      if (!this.cfg.journalWritable) {
        return '设置里关掉了「允许她自己写」——现在只能读不能改。她觉得该记的那句可以说出来，让他决定要不要开。';
      }
      const valid = JOURNAL_SECTIONS as readonly string[];
      const hit = args.section && valid.includes(args.section) ? args.section as JournalSection : null;
      if (!hit) return '`add` 要配一个 `section`：alive / death / next / unsure。';
      return this.journal.add(hit, args.add).message;
    }
    const body = this.journal.read().trim();
    const extra = this.cfg.journalWritable ? '' : '\n\n（设置里关掉了写入，现在只能读。）';
    return `${body}${extra}`;
  }

  /* ---------------- 提示词 ---------------- */

  envPromptVars(): Record<string, string> {
    const vocab = readVocab(this.hostRoot(), this.companionDir());
    const tips = tipsOf(this.sit, { exclusiveFullscreen: this.watch?.exclusiveFullscreen }).slice(0, 4).map((t) => `- ${t.text}`).join('\n');
    const digest = this.journal.digest();

    return {
      'pz.version': VERSION,
      'pz.status': this.statusLine(),
      'pz.now': describeNow(this.sit),
      'pz.tips': tips || '（按现在的状态没有必须马上处理的事）',
      'pz.persona': PERSONA_TEXT[personaOf(this.cfg.persona)] ?? PERSONA_TEXT.sharp,
      'pz.marks': describeVocab(vocab),
      'pz.journal': digest ? digest.slice(0, 700) : '（还是空的。第一档结束之后再写，别为了有内容临时编一条。）',
      'pz.pace': {
        quiet: '他选了「安静」：只有真会害死他的事才开口（危险、感染、入夜还在外面）。其余一概不说。',
        normal: '他选了「正常」：上面那些，加上掉血和收获。别的一句话不多说。',
        chatty: '他选了「话多」：可以顺口带一句别的，但也别把每件事都报一遍。',
      }[chattinessOf(this.cfg.chattiness)],
    };
  }

  private statusLine(): string {
    if (!this.paths) return `**没连上游戏。** ${this.sit.linkNote}`;
    const st = this.sit.link;
    const tag = st === 'ok' ? '在跟' : st === 'menu' ? '游戏在跑但没读档' : st === 'stale' ? '数据停了' : '读不到';
    return `${tag} · ${this.sit.linkNote} · 桥接 ${this.install?.state ?? 'unknown'}`;
  }

  /* ---------------- WebUI ---------------- */

  webUi(): WorldWebUiDecl {
    return {
      lamps: this.lamps(),
      panels: [
        { id: 'main', title: '她此刻', description: '她看到的那些：第几天、几点、血、视野里的僵尸、手上和背包。' },
      ],
      invoke: async (panel, method) => {
        if (panel !== 'main') throw new Error(`未知面板：${panel}`);
        if (method === 'snapshot') return this.uiSnapshot();
        throw new Error(`未知方法：${method}`);
      },
      config: pzConfigGroups(),
      promptDocs: [{
        key: `worlds.${PZ_ID}.envPrompt`,
        title: '僵毁陪玩提示词',
        description: '她怎么用这个扩展：看局面、该开口时开口、不装看得见屏幕。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'pz.version', description: '扩展版本。' },
          { name: 'pz.status', description: '数据通道是否在跟。' },
          { name: 'pz.now', description: '此刻的处境（每回合都刷新）。' },
          { name: 'pz.tips', description: '按当前状态算出来的检查清单。' },
          { name: 'pz.persona', description: '她这档口吻的说明。' },
          { name: 'pz.marks', description: '当前立绘认识的表情与动作（现读）。' },
          { name: 'pz.journal', description: '陪玩日记里已有的内容。' },
          { name: 'pz.pace', description: '开口密度的说明。' },
        ],
      }],
    };
  }

  private lamps(): WorldLamp[] {
    /*
     * 三态分法：灰 = 他没在玩（正常，不是故障）；红 = 他在玩但我读不到（该管）；
     * 绿 = 在跟。把「没在玩」画成红色，他会去修一个没坏的东西。
     */
    const running = this.watch?.running ?? false;
    const game: WorldLamp = !this.paths
      ? {
        label: '游戏',
        state: 'error',
        hint: `${(this.probe?.problem ?? '没找到存档目录').replace(/[。.]$/, '')}。找过：${describeTried(this.probe?.tried ?? [])}`,
      }
      : this.sit.link === 'ok'
        ? {
          label: '游戏',
          state: 'online',
          hint: `在跟。第 ${this.sit.day ?? '?'} 天 ${this.sit.clockText ?? ''}`
            + (this.watch?.exclusiveFullscreen ? '。**全屏路径**：她浮不到画面上，把「全屏」和「无边框」两个勾都取消' : ''),
        }
        : this.sit.link === 'stale'
          ? { label: '游戏', state: 'error', hint: `${this.sit.linkNote} 游戏关了？还是桥接 mod 没启用？` }
          : running
            ? { label: '游戏', state: 'error', hint: this.sit.linkNote }
            : { label: '游戏', state: 'offline', hint: this.sit.linkNote };

    // 「文件放进去了」和「游戏里勾上了」是两件事。后者才是真正决定有没有数据的那一步。
    const bridge: WorldLamp = !this.install
      ? { label: '桥接', state: 'offline', hint: '还没检查（游戏目录没找到之前不装）。' }
      : this.install.state === 'failed'
        ? { label: '桥接', state: 'error', hint: this.install.detail }
        : this.install.state === 'skipped'
          ? { label: '桥接', state: 'offline', hint: '设置里关了自动安装，靠你自己放的那份。' }
          : this.watch?.presetHasBridge === false
            ? { label: '桥接', state: 'error', hint: '文件在，但游戏的模组列表里没勾上它（主菜单 → Mods）。' }
            : this.install.state === 'installed'
              ? {
                label: '桥接',
                state: this.enable?.state === 'current' || this.enable?.state === 'enabled' ? 'online' : 'loading',
                hint: this.enable?.state === 'current' || this.enable?.state === 'enabled'
                  ? `${this.install.detail} 模组列表已替你勾上，完全退出游戏重开生效。`
                  : `${this.install.detail} 模组列表还没写进去。`,
              }
              : { label: '桥接', state: 'online', hint: this.install.detail };

    const notes = this.journal.digest();
    const journal: WorldLamp = {
      label: '日记',
      state: notes ? 'online' : 'offline',
      hint: notes ? `记着几条了：${this.journal.path()}` : '还没写过。',
    };

    return [game, bridge, journal];
  }

  private uiSnapshot(): unknown {
    const vocab = readVocab(this.hostRoot(), this.companionDir());
    return {
      version: VERSION,
      persona: this.cfg.persona,
      chattiness: chattinessOf(this.cfg.chattiness),
      link: this.sit.link,
      linkNote: this.sit.linkNote,
      now: describeNow(this.sit),
      tips: tipsOf(this.sit, { exclusiveFullscreen: this.watch?.exclusiveFullscreen }).map((t) => t.text),
      gear: this.sit.gear,
      /** 他正打开的那个容器。`null` = 没在翻东西。 */
      loot: this.sit.loot
        ? {
          type: this.sit.loot.type,
          total: this.sit.loot.total,
          hits: [...new Set(this.sit.loot.hits.map((h) => String(h.n ?? '').trim()).filter(Boolean))].slice(0, 4),
        }
        : null,
      weapon: this.sit.weapon,
      weaponCond: this.sit.weaponCondText,
      weaponPct: this.sit.weaponPct,
      /**
       * 面板上那行「状态」。只给档位，不给原始数字 —— 面板是给人瞟一眼的，
       * 82% 和 88% 在那儿没有区别。`null` = 这项读不到，别显示成「正常」。
       */
      needs: NEED_SPECS.map((s) => ({
        key: s.key,
        name: s.name,
        band: needBandOf(this.sit[s.key], s),
      })),
      visible: this.sit.visible,
      hp: this.sit.hp,
      infected: this.sit.infected,
      day: this.sit.day,
      clock: this.sit.clockText,
      night: this.sit.night,
      place: this.sit.placeText,
      kills: this.raw?.kills ?? 0,
      install: this.install?.detail ?? '',
      // 页脚只放得下短东西。完整说明（"从 x 升到 y：覆盖 8 个文件…"）留给悬停。
      installShort: this.install?.state === 'failed'
        ? '装不进去'
        : this.install?.state === 'skipped'
          ? '没自动装'
          : '在',
      game: this.watch
        ? {
          running: this.watch.running,
          saveCount: this.watch.saveCount,
          presetHasBridge: this.watch.presetHasBridge,
        }
        : null,
      root: this.paths?.root ?? '',
      figure: vocab.figure,
      vocabNote: vocab.note,
      journal: this.journal.digest(),
    };
  }

  /* ---------------- 杂项 ---------------- */

  /**
   * `dataDir` 是**所有 World 共用**的 `companion/data`，不是本扩展专属。
   * 所以落盘的文件名一律带 `pz-` 前缀，别去占 `state.json` 这种通用名。
   */
  private companionDir(): string {
    return this.opts.companionDir ?? join(this.opts.dataDir, '..');
  }

  private hostRoot(): string | null {
    return findHostRoot(this.opts.dataDir);
  }

  private localDay(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 水位和闸门落盘：重启不该让她把今天报过的再报一遍。 */
  private loadJudgeState(): void {
    try {
      const raw = readFileSync(this.judgeFile, 'utf8');
      const p = JSON.parse(raw) as Partial<JudgeState>;
      this.judgeState = { ...initialJudgeState(), ...p, dangerBands: Array.isArray(p.dangerBands) ? p.dangerBands : [] };
    } catch {
      this.judgeState = initialJudgeState();
    }
  }

  private saveJudgeState(): void {
    try {
      writeFileSync(this.judgeFile, JSON.stringify(this.judgeState), 'utf8');
    } catch {
      // 写不了就算了 —— 后果只是重启后可能多报一次，不值得把主循环打断。
    }
  }
}

/**
 * 「隔多久提一次清单」换算成毫秒，并按开口密度缩放。
 *
 * 安静档放宽一倍、话多档缩短一半 —— 密度那个开关本来就该管这个，
 * 不然两个设置会互相打架（选了「安静」却每五分钟被念一遍）。
 */
export function nudgeEveryMs(minutes: unknown, chattiness: 'quiet' | 'normal' | 'chatty'): number {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const scale = chattiness === 'quiet' ? 2 : chattiness === 'chatty' ? 0.5 : 1;
  return Math.max(60_000, Math.round(m * 60_000 * scale));
}

export const PZ_DESCRIBE = {
  tools: TOOL_DECLS.map((t) => ({ ...t, tags: [...t.tags] })),
  events: [
    { type: 'pz.session.start', description: { zh: '他进游戏了。', en: 'A save was loaded.' }, trigger: 'flush' as const },
    { type: 'pz.day.start', description: { zh: '游戏内换了一天。', en: 'A new in-game day started.' }, trigger: 'debounce' as const },
    { type: 'pz.dusk', description: { zh: '天在暗了（19 点后、还没入夜）。', en: 'Dusk: past 19:00 and not yet night.' }, trigger: 'flush' as const },
    { type: 'pz.night', description: { zh: '刚入夜。', en: 'Nightfall.' }, trigger: 'flush' as const },
    { type: 'pz.danger', description: { zh: '视野里的僵尸跨了一档。', en: 'The visible-zombie count jumped a band.' }, trigger: 'flush' as const },
    { type: 'pz.hurt', description: { zh: '掉血。', en: 'Took damage.' }, trigger: 'flush' as const },
    { type: 'pz.need', description: { zh: '他自己的状态跨了一档（饿、渴、累、体力、疼、惊恐、压力、心情、无聊）。', en: 'One of his own condition stats crossed a band.' }, trigger: 'flush' as const },
    { type: 'pz.weapon', description: { zh: '手上的武器耐久见底了。', en: 'The weapon in hand is nearly worn out.' }, trigger: 'flush' as const },
    { type: 'pz.play', description: { zh: '轮到她决定下一步了（设置里开了「让她自己动手玩」）。', en: 'It is her turn to decide the next move; the play switch is on.' }, trigger: 'flush' as const },
    { type: 'pz.loot', description: { zh: '他正打开的那个容器里有值得停一下的东西（只看已经打开的那一个）。', en: 'The container he has open holds something worth pausing for. Only the one he opened.' }, trigger: 'flush' as const },
    { type: 'pz.tv', description: { zh: '前期电视上有技能课（Life and Living TV），一天最多提一次，第 5 天之后不提。', en: 'A skill programme is on or about to start on Life and Living TV. Once a day, first five days only.' }, trigger: 'flush' as const },
    { type: 'pz.infected', description: { zh: '被感染了。', en: 'Got infected.' }, trigger: 'flush' as const },
    { type: 'pz.death', description: { zh: '死了。', en: 'Died.' }, trigger: 'flush' as const },
    { type: 'pz.kill', description: { zh: '一小会儿里连杀了好几只。', en: 'Several kills in a short stretch.' }, trigger: 'debounce' as const },
    {
      type: 'pz.nudge',
      description: {
        zh: '清单里那条还悬着（没水、没绷带、武器快断这类），隔一阵提醒一次，换着说法。',
        en: 'A checklist item is still open; a periodic nudge, reworded each time.',
      },
      trigger: 'flush' as const,
    },
    { type: 'pz.setup', description: { zh: '这台机器的环境不对：找不到存档目录、mod 没装进去、或者一直没有数据。', en: 'Environment problem: no save dir, mod not installed, or no data at all.' }, trigger: 'flush' as const },
  ],
};
