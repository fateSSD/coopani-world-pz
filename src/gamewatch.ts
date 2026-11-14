/**
 * 看游戏本体：它开没开、有没有档、模组列表里有没有我们。
 *
 * 为什么需要这一层：`state.json` 读不到时，原因至少有四种，而处理方式完全不同 ——
 * 「游戏没开」「mod 没勾」「还没建过档」「在主菜单没读档」。只说一句
 * 「还没写出数据」，他只能猜，而猜错的方向是「这扩展坏了」，然后卸掉。
 *
 * 三个判据都来自游戏自己写的文件，不猜进程、不猜窗口：
 *
 * - **在不在跑**：`console.txt` 还在被写。PZ 启动时会重写这个文件，运行中持续追加。
 * - **有没有档**：`Saves/<mode>/<档名>` 的层数。空的 = 他连角色都还没建。
 * - **mod 勾没勾**：`mods/default.txt` 里有没有我们的 id。那是游戏自己的模组预设。
 *
 * ⚠️ `[CoopaniBridge]` 那句 print 只有在**读档进世界**之后才会出现在 console 里 ——
 * 客户端 Lua 是随存档加载的，主菜单看不到。所以**不能**用「console 里没有这句」
 * 推出「mod 没启用」，那会把「还没读档」误诊成「没装好」。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Paths } from './paths.ts';
import { BRIDGE_DIR_NAME } from './paths.ts';

/** console.txt 超过这么久没更新，就当游戏已经关了。 */
const RUNNING_WINDOW_MS = 90_000;

export interface GameWatch {
  /** 游戏在跑（console.txt 还在被写）。 */
  running: boolean;
  /** console.txt 最后更新距今多少毫秒；文件不存在为 null。 */
  consoleAgeMs: number | null;
  /** console.txt 当前大小。变小 = 游戏重开过一次。 */
  consoleSize: number;
  /** Saves 下有几个档。 */
  saveCount: number;
  /** 模组预设里有没有 CoopaniBridge。null = 读不到预设文件。 */
  presetHasBridge: boolean | null;
  /**
   * **存档**的模组清单里有我们的 mod。
   *
   * `mods/default.txt` 只决定主菜单加载什么；读档时游戏按
   * `Saves/<模式>/<档名>/mods.txt` **重新加载一遍 Lua**。那份名单缺了我们，
   * 进世界那一刻 mod 就被卸掉：回调全消失、一句错不报、游戏照常跑满几万帧，
   * 状态文件停在上一次写入。真机就是这么耗掉好几轮的。
   * null = 没有存档或读不到。
   */
  saveHasBridge: boolean | null;
  /** console.txt 里出现过我们的加载横幅（只有读档后才会）。 */
  bridgeLoaded: boolean;
  /**
   * 游戏走「全屏路径」：**独占全屏**（`fullScreen=true`）**或者无边框满屏**（`borderless=true`）。
   *
   * 这一条和「看不看得见数据」无关，和「看不看得见她」有关。Windows 11 对这两种窗口
   * 都会启用全屏优化 / 独立翻转，绕开 DWM 合成 —— 桌宠那种置顶窗口在物理上就画不上去，
   * 不是她卡住了，也不是 Z 序输了。真机验证过：她当时是 TOPMOST、可见、Z 序最顶，
   * 屏幕截图里依然一个像素都没有。
   *
   * 唯一可靠的解法是**带标题栏的普通窗口模式**：`fullScreen=false` **且** `borderless=false`，
   * 两个勾都要取消。只关 `borderless` 会落进独占全屏，比原来更糟 —— 实测他就是这样。
   * 0.1.1 让人「勾上无边框」更是把方向给反了。
   */
  exclusiveFullscreen: boolean;
  /**
   * 加载我们时的那一行报错。null = 没看到报错。
   *
   * 这一条是给「Lua 写错了」准备的：它能区分「还没读档」和「读档了但脚本炸了」。
   * 后者如果被误诊成前者，他会一直等一个永远不会来的数据。
   */
  bridgeError: string | null;
}

const run = promisify(execFile);

/**
 * 游戏进程在不在。
 *
 * 光看 `console.txt` 的修改时间**不够**：PZ 在主菜单上可以好几分钟不写一行，
 * 那段时间会被误判成「已经关了」，然后她跟他说「把游戏开起来」——
 * 而他明明开着，只是站在菜单上。实测就是这么误诊的。
 *
 * 代价是一次 tasklist（约 30ms），所以调用方要缓存，别每拍都问。
 */
export async function isGameProcessRunning(): Promise<boolean> {
  try {
    const { stdout } = await run(
      'tasklist',
      ['/FI', 'IMAGENAME eq ProjectZomboid64.exe', '/NH'],
      { windowsHide: true, timeout: 4000 },
    );
    return /ProjectZomboid64\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

export function watchGame(paths: Paths, nowMs: number, processRunning?: boolean): GameWatch {
  let consoleAgeMs: number | null = null;
  let consoleSize = 0;
  let bridgeLoaded = false;
  let bridgeError: string | null = null;

  try {
    const st = statSync(paths.consoleFile);
    consoleSize = st.size;
    consoleAgeMs = nowMs - st.mtimeMs;
  } catch {
    consoleAgeMs = null;
  }

  if (consoleAgeMs !== null && consoleSize > 0 && consoleSize < 4_000_000) {
    try {
      const text = readFileSync(paths.consoleFile, 'utf8');
      bridgeLoaded = text.includes('[CoopaniBridge]');
      // 只认「同一行里既提到我们、又像报错」的。PZ 启动时会把 mod 名念一遍，
      // 光看见名字就判成报错，反而制造新的误诊。
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes('CoopaniBridge')) continue;
        // 只认「这一行本身就是一条错误日志」。桥接自己打的诊断行是
        // `LOG  : Lua ... [CoopaniBridge] ...`，里面可能带 failed / nil 等字样，
        // 光用关键词会把诊断误判成「脚本炸了」。
        if (/^\s*(ERROR|WARN)\s*:|Exception|attempt to call|stack traceback/i.test(line)) {
          bridgeError = line.trim().slice(0, 240);
          break;
        }
      }
    } catch {
      bridgeLoaded = false;
    }
  }

  const writingRecently = consoleAgeMs !== null && consoleAgeMs < RUNNING_WINDOW_MS;

  const display = readDisplayMode(paths.root);

  return {
    // 进程说在跑就是在跑（主菜单不写日志也是开着）；进程查不到时退回看文件。
    running: processRunning ?? writingRecently,
    consoleAgeMs,
    consoleSize,
    saveCount: countSaves(paths.root),
    presetHasBridge: readPreset(paths.root),
    saveHasBridge: readNewestSaveMods(paths.root),
    exclusiveFullscreen: display.exclusiveFullscreen,
    bridgeLoaded,
    bridgeError,
  };
}

/** `Saves/<模式>/<档名>` —— 数第二层目录。 */
function countSaves(root: string): number {
  const base = join(root, 'Saves');
  try {
    if (!existsSync(base)) return 0;
    let n = 0;
    for (const mode of readdirSync(base, { withFileTypes: true })) {
      if (!mode.isDirectory()) continue;
      for (const save of readdirSync(join(base, mode.name), { withFileTypes: true })) {
        if (save.isDirectory()) n += 1;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 模组预设。PZ 把它写成：
 *
 * ```
 * VERSION = 1,
 * mods
 * {
 * }
 * ```
 *
 * 勾上的 mod 会出现在 `mods { }` 里。这里只做包含匹配 ——
 * 去解析那个近乎 Lisp 的格式不值得，而我们要回答的只是「有没有我们」。
 */
function readPreset(root: string): boolean | null {
  const file = join(root, 'mods', 'default.txt');
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8').includes(BRIDGE_DIR_NAME);
  } catch {
    return null;
  }
}

/**
 * 最新那个存档的模组清单里有没有我们。
 *
 * 只查最新的一个存档就够了：用户点「继续」进的就是它。多个存档各自不同，
 * 但诊断只需要回答「他这次进去的那个档，认不认我们」。
 */
function readNewestSaveMods(root: string): boolean | null {
  try {
    const savesRoot = join(root, 'Saves');
    let newest: { file: string; mtime: number } | null = null;
    for (const mode of readdirSync(savesRoot, { withFileTypes: true })) {
      if (!mode.isDirectory()) continue;
      const modeDir = join(savesRoot, mode.name);
      for (const save of readdirSync(modeDir, { withFileTypes: true })) {
        if (!save.isDirectory()) continue;
        const file = join(modeDir, save.name, 'mods.txt');
        if (!existsSync(file)) continue;
        const mtime = statSync(file).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file, mtime };
      }
    }
    if (!newest) return null;
    return /^\s*mod\s*=\s*CoopaniBridge\s*,?\s*$/im.test(readFileSync(newest.file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 显示模式。PZ 把视频设置写在自己那份 `options.ini` 里，键名是这两个。
 *
 * 读不到就当「不是全屏路径」—— 宁可少说一句，不要在他窗口化的时候念叨他改设置。
 */
function readDisplayMode(root: string): { exclusiveFullscreen: boolean; borderless: boolean | null } {
  try {
    const text = readFileSync(join(root, 'options.ini'), 'utf8');
    const full = /^\s*fullScreen\s*=\s*(true|false)/im.exec(text);
    const border = /^\s*borderless\s*=\s*(true|false)/im.exec(text);
    const isFull = full ? full[1].toLowerCase() === 'true' : null;
    const isBorderless = border ? border[1].toLowerCase() === 'true' : null;
    return {
      // 两条路径都会绕开 DWM：独占全屏，以及无边框满屏（PZ 的 borderless 默认铺满屏幕）。
      exclusiveFullscreen: isFull === true || isBorderless === true,
      borderless: isBorderless,
    };
  } catch {
    return { exclusiveFullscreen: false, borderless: null };
  }
}

export type NoDataReason = 'closed' | 'mod-off' | 'save-mod-off' | 'bridge-error' | 'no-save' | 'not-loaded' | 'unknown';

/**
 * 「读不到数据」到底是哪一步没成。
 *
 * 顺序就是修的顺序：先开游戏，再勾 mod，再建档，最后才是读档。
 */
export function diagnoseNoData(watch: GameWatch): { reason: NoDataReason; text: string } {
  if (!watch.running) {
    return {
      reason: 'closed',
      text: '游戏没在跑 —— 我这边什么都没收到。把它开起来（进到主菜单就够），我就能看见它的目录了。',
    };
  }
  if (watch.presetHasBridge === false) {
    return {
      reason: 'mod-off',
      text: '游戏开着，但**启用的模组列表里没有 Coopani Bridge**。主菜单 → Mods → 勾上 Coopani Bridge → 应用，再进游戏。',
    };
  }
  // 比「没勾 mod」更隐蔽的一种：主菜单勾了，但**存档自己的清单**里没有。
  // 读档时游戏按存档的清单重载 Lua，我们的回调就在这时被一起卸掉。
  if (watch.presetHasBridge === true && watch.saveHasBridge === false) {
    return {
      reason: 'save-mod-off',
      text: '`mods/default.txt` 里有我，但**这个存档自己的模组清单里没有** —— '
        + '读档时游戏会按存档那份清单重载一遍 Lua，于是我在进世界的那一刻被卸掉，'
        + '一条错都不报。扩展会趁游戏关着的时候把名字补进存档的 `mods.txt`；'
        + '补完要**完全退出游戏再重开、重新读档**。',
    };
  }
  if (watch.bridgeError) {
    return {
      reason: 'bridge-error',
      text: `桥接 mod 被游戏加载时**报错了**，所以它一次都没写出来：${watch.bridgeError}`
        + ' 这不是他操作的问题，是我这边脚本的锅 —— 让他把 console.txt 里提到 CoopaniBridge 的那几行发出来。',
    };
  }
  if (watch.saveCount === 0) {
    return {
      reason: 'no-save',
      text: '游戏开着、模组也勾上了，但这台机器上**还没有任何存档**。得「新游戏」建一个角色 —— 不是「继续」。',
    };
  }
  return {
    reason: 'not-loaded',
    text: '游戏开着、也有档，但**还没读到状态文件**。多数时候是**还没读档进世界** —— 主菜单不算，得点进那个存档站在地图上；'
      + '第一次（或者刚改过模组列表）还要**完全退出游戏再重开**，mod 只在启动时加载。'
      + ' 如果他确实已经站在地图上了，那就是桥接写文件失败：看 `console.txt` 里 `[CoopaniBridge]` 开头的那几行，'
      + '里面会写清是 writer 拿不到、JSON 构造失败、还是根本没触发 OnTick。',
  };
}
