/**
 * 配置段与设置页声明。
 *
 * `cfg` 是 `worlds.pz` 的**活引用**：热改的键下一次轮询就生效，不用重启。
 * 所以每一处都从 `this.cfg` 现读，不在构造时抄一份。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';

export const PZ_ID = 'pz';

/** 四种口吻。默认是毒舌队友 —— 换一种只差一个下拉框。 */
export type Persona = 'sharp' | 'steady' | 'jumpy' | 'adaptive';
export type Chattiness = 'quiet' | 'normal' | 'chatty';

/**
 * 设置页的下拉框直接拿 `enum` 的值当选项文字（宿主没有 label 映射），
 * 所以枚举值必须写成**中文**，否则界面上就是 `sharp / steady / jumpy / adaptive`。
 * 内部逻辑仍然用英文标识，靠下面两个函数在边界上换算。
 */
export const PERSONA_LABELS = ['毒舌队友', '稳当搭档', '慌里慌张的学妹', '按局面切换'] as const;
export const CHATTINESS_LABELS = ['安静', '正常', '话多'] as const;

const PERSONA_OF: Record<string, Persona> = {
  毒舌队友: 'sharp',
  稳当搭档: 'steady',
  慌里慌张的学妹: 'jumpy',
  按局面切换: 'adaptive',
};
const CHATTINESS_OF: Record<string, Chattiness> = {
  安静: 'quiet',
  正常: 'normal',
  话多: 'chatty',
};

/** 把设置页里存的值（中文标签，或旧版存下的英文标识）换成内部标识。 */
export function personaOf(v: unknown): Persona {
  const s = String(v ?? '');
  if (PERSONA_OF[s]) return PERSONA_OF[s];
  if (s === 'sharp' || s === 'steady' || s === 'jumpy' || s === 'adaptive') return s;
  return 'sharp';
}

export function chattinessOf(v: unknown): Chattiness {
  const s = String(v ?? '');
  if (CHATTINESS_OF[s]) return CHATTINESS_OF[s];
  if (s === 'quiet' || s === 'normal' || s === 'chatty') return s;
  return 'normal';
}

export interface PzConfigSection extends WorldSection {
  /** 覆盖存档根目录。留空 = 自动找 `%USERPROFILE%\Zomboid`。 */
  zomboidDir: string;
  /** 启动时把桥接 mod 拷进 `Zomboid/mods/`。 */
  autoInstallMod: boolean;
  /** 游戏在跑时，周期性把桌宠窗口提到最顶。 */
  liftPetWhenGaming: boolean;
  /**
   * 游戏在跑时，摘掉游戏窗口的输入法上下文。
   *
   * 不摘的话，窗口化跑 PZ 时中文输入法会挂在游戏窗口上：按 WASD 弹候选框、
   * 状态条压在画面上、每次切回来又变回中文。摘掉只影响这一个窗口。
   */
  imeGuard: boolean;
  /** 她的口吻。存的是设置页里的中文标签，用 `personaOf()` 换算。 */
  persona: Persona | string;
  /** 主动开口的密度。同上。 */
  chattiness: Chattiness | string;
  /**
   * 隔多少分钟把「该注意的」再提一次。0 = 不提。
   *
   * 清单里的东西（没水、没绷带、武器快断）不会自己变成事件，
   * 但一直不说等于没说 —— 所以要按期念一遍，并且换说法。
   */
  nudgeMinutes: number;
  /** 视野里僵尸跨档时开口。 */
  speakDanger: boolean;
  /** 天要黑了 / 入夜时开口。 */
  speakDusk: boolean;
  /** 掉血时开口。 */
  speakHurt: boolean;
  /**
   * 他翻柜子翻到好东西时说一句。
   *
   * 只看**他已经打开的那一个容器**，不预告没去过的地方 —— 但这条仍然最接近
   * 「替你搜刮」，所以要能关。关掉之后 `pz.loot` 完全不产生。
   */
  speakLoot: boolean;
  /**
   * 让她自己动手（走路 / 转向 / 打 / 拿 / 停）。
   *
   * 默认**关**。这是唯一一个会真的改变游戏进程的开关，不能默认开 ——
   * 装扩展的人多半只是想有个伴在旁边说话，不是想让角色被别人操作。
   * 打开之后她才能下指令，而指令是通过 mod 的指令文件交给游戏的，
   * 不模拟键鼠、不动他的鼠标。
   */
  allowPlay: boolean;
  /**
   * 自动驾驶的节拍：授权之后，每隔多少秒她觉得没事做就推一次「轮到你了」。
   *
   * 0 = 不推，她只在他开口时才动。默认 12 秒 —— 比一次走路短，比一轮对话长。
   */
  playEverySec: number;
  /** 轮询间隔（毫秒）。游戏侧两秒写一次，这里不必更快。 */
  pollMs: number;
  /** 数据超过这么多秒没更新，就当她看不见了。 */
  staleSeconds: number;
  /** 允许她往陪玩日记里写字。 */
  journalWritable: boolean;
}

export const PZ_DEFAULTS = (): PzConfigSection => ({
  enabled: false, // 由 WorldSection 提供，装上不等于开
  zomboidDir: '',
  autoInstallMod: true,
  liftPetWhenGaming: false,
  imeGuard: true,
  persona: '毒舌队友',
  chattiness: '正常',
  nudgeMinutes: 8,
  speakDanger: true,
  speakDusk: true,
  speakHurt: true,
  speakLoot: true,
  allowPlay: false,
  playEverySec: 3,
  pollMs: 1500,
  staleSeconds: 25,
  journalWritable: true,
});

export function pzConfigGroups(): ConfigGroup[] {
  return [
    {
      id: 'pz.main',
      owner: `world:${PZ_ID}`,
      schema: {
        type: 'object',
        title: '僵毁陪玩',
        description: '她在旁边看着你活下来。这里只有两件必须你决定的事：她怎么说话，和多久说一次。',
        properties: {
          // ⚠ 键必须是从 config.json 根开始的完整点分路径。
          // 写成裸名（`persona`）会落到 config.json 顶部，World 读 `worlds.pz.persona`
          // 读到 undefined —— 配了等于没配，而且不报错。有测试守着这一条。
          'worlds.pz.persona': {
            type: 'string',
            title: '她的口吻',
            description:
              '毒舌队友：看你犯蠢会直接说，平常损你，关键时刻靠谱。'
              + '稳当搭档：话少、只在真该说的时候开口，像个老手在旁边不出声地看。'
              + '慌里慌张的学妹：她比你还紧张，天黑了先叫、被围了先慌——紧张感本身就是提醒。'
              + '按局面切换：平时损你，真到要命的地方收起来。'
              + '**换的是怎么说和先想哪件事，换不掉「该提醒的必须提醒」。**',
            enum: [...PERSONA_LABELS],
            'x-hot': true,
          },
          'worlds.pz.chattiness': {
            type: 'string',
            title: '开口密度',
            description:
              '安静＝只在她觉得真会害死你的时候说（危险、感染、入夜还在外面）。'
              + '正常＝上面那些加击杀和收获。'
              + '话多＝连「今晚睡哪」「背包快满了」都会提一嘴。',
            enum: [...CHATTINESS_LABELS],
            'x-hot': true,
          },
          'worlds.pz.nudgeMinutes': {
            type: 'integer',
            title: '隔多久提一次「该注意的」',
            description:
              '清单里还没解决的事（没水、没绷带、武器快断），每隔这么多分钟提一句。'
              + '她会轮着说、换着说法，不会一直念同一条。0 = 不提。'
              + '「安静」档会放宽一倍，「话多」档会缩短一半。',
            minimum: 0,
            maximum: 60,
            'x-suffix': '分钟',
            'x-hot': true,
          },
          'worlds.pz.zomboidDir': {
            type: 'string',
            title: '存档根目录',
            description:
              '留空就自动找 `%USERPROFILE%\\Zomboid`。游戏装在别的盘、或者用 `-cachedir` 改过位置时才需要填。'
              + '填错的表现是「她一直说没看到游戏」——上面那盏「游戏」灯会写出她找过哪些地方。',
            'x-path': { kind: 'directory' },
          },
        },
      },
    },
    {
      id: 'pz.advanced',
      owner: `world:${PZ_ID}`,
      schema: {
        type: 'object',
        title: '高级（一般不用动）',
        description: '阈值和数据通道。没遇到具体问题就别改这里。',
        properties: {
          'worlds.pz.autoInstallMod': {
            type: 'boolean',
            title: '自动装桥接 mod',
            description:
              '启动时把 `CoopaniBridge` 拷进 `Zomboid/mods/`。游戏里**要手动启用一次**（主菜单 → Mods），之后不用管。'
              + '关掉之后她读不到任何数据——除非你自己放了一份进去。',
            'x-hot': true,
          },
          'worlds.pz.imeGuard': {
            type: 'boolean',
            title: '玩的时候关掉中文输入法',
            description:
              '把《僵尸毁灭工程》那个窗口的输入法挂载摘掉 —— 按 WASD 不会弹候选框、'
              + '状态条不再压在画面上，切回来也不用再按一次 Shift。'
              + '只影响这一个窗口，聊天照常是中文。关掉就回到系统默认。',
            'x-hot': true,
          },
          'worlds.pz.liftPetWhenGaming': {
            type: 'boolean',
            title: '游戏运行时把她抬到最上层',
            description:
              'PZ 进世界时会重建窗口，Windows 的全屏优化偶尔把桌宠压到画面底下。'
              + '开着时，游戏在跑的每 5 秒借宿主的 koffi 调一次 SetWindowPos(HWND_TOPMOST)，把她重新置顶（不抢焦点、不改位置）。'
              + '**默认关** —— 这是持续改写别的窗口的层级，会跟独占全屏、录屏、防作弊类程序打架；需要时再开。'
              + '关掉不影响她说的话，只影响你看不看得见她。',
            'x-hot': true,
          },
          'worlds.pz.speakDanger': {
            type: 'boolean',
            title: '僵尸围上来时开口',
            description: '视野里的僵尸数跨档时提醒一次。档位是 3 / 6 / 12，跨过去才算。',
            'x-hot': true,
          },
          'worlds.pz.speakDusk': {
            type: 'boolean',
            title: '天黑时开口',
            description: '天要黑了你还在外面，和刚入夜那一刻。僵毁的夜里死人是常态，这条建议别关。',
            'x-hot': true,
          },
          'worlds.pz.speakHurt': {
            type: 'boolean',
            title: '掉血时开口',
            description: '单次掉血超过 4% 就说一句。被咬单独算，不受这个开关管。',
            'x-hot': true,
          },
          'worlds.pz.speakLoot': {
            type: 'boolean',
            title: '翻柜子翻到好东西时说一句',
            description:
              '他打开一个柜子、里面有值得停一下的东西（大锤、发电机、好武器、工具、背包、光源、车钥匙）时，'
              + '她提一句「别顺手划过去」。'
              + '**只看他已经打开的那一个容器** —— 不预告没去过的房间、不扫地图、不告诉你哪里有东西。'
              + '同一个柜子五分钟内只说一次。'
              + '觉得这条太像替你搜刮就关掉，别的都不受影响。',
            'x-hot': true,
          },
          // 「让她自己动手玩」和「多久主动想一次」这两项**暂时不放到界面上**。
          //
          // 那套东西（反射层、指令队列、右键菜单当动作库）还在验，验完再开。
          // 字段本身留着 —— 配置文件里手写 `allowPlay: true` 仍然生效，
          // 只是没有按钮，装的人不会误开一个半成品。
          'worlds.pz.pollMs': {
            type: 'integer',
            title: '轮询间隔',
            description: '毫秒。游戏那边两秒写一次，这里比它快也没用。默认 1500。',
            minimum: 500,
            maximum: 10000,
            'x-suffix': 'ms',
            'x-hot': true,
          },
          'worlds.pz.staleSeconds': {
            type: 'integer',
            title: '多久算「看不见了」',
            description:
              '数据超过这么多秒没更新，就当游戏关了或者桥接 mod 没生效。'
              + '默认 25 秒（游戏侧两秒写一次，等于连丢十几拍）。',
            minimum: 5,
            maximum: 600,
            'x-suffix': '秒',
            'x-hot': true,
          },
          'worlds.pz.journalWritable': {
            type: 'boolean',
            title: '允许她自己写陪玩日记',
            description:
              '存在 `pz-journal.md`，第一人称。写的是「这局怎么活的、死在哪一步、下回注意什么」。'
              + '关掉之后她只能读不能写——已有的照旧生效，只是不新增。',
            'x-hot': true,
          },
        },
      },
    },
  ];
}
