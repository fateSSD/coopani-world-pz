/**
 * 找僵尸毁灭工程的存档根目录，以及它下面那几个我们真正要用的路径。
 *
 * 定位这块有个必须写清的取舍：**找不到时要说清找过哪些地方**。
 * 只写一句「找不到」等于让人去猜 —— 以前踩过，用户只能看到一个红点。
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_DIR_NAME = 'CoopaniBridge';
export const BRIDGE_MOD_VERSION = '1.4.7';
export const DATA_SUBDIR = 'coopani-pz';

export interface RootProbe {
  root: string | null;
  /** 依次试过的路径，按顺序写给人看。 */
  tried: string[];
  /** 人话原因；null = 找到了。 */
  problem: string | null;
  /** 找到了，但不是我们熟悉的样子（没有 mods / Lua）。 */
  warning: string | null;
}

function looksLikeZomboidRoot(p: string): boolean {
  try {
    if (!statSync(p).isDirectory()) return false;
  } catch {
    return false;
  }
  return [
    'Lua',
    'mods',
    'Saves',
    'Workshop',
    'console.txt',
  ].some((name) => existsSync(join(p, name)));
}

/**
 * 候选路径。`-cachedir` 改过位置的情况靠配置覆盖，不在这里猜。
 */
export function rootCandidates(configured: string): string[] {
  const custom = configured.trim();
  // 他手填了路径就**只认那一处**，不偷偷回落到默认位置。
  // 回落的后果是：填错一个路径，扩展照常在别处工作 —— 他改了半天配置，
  // 却看不出改的到底是什么，这种「配了等于没配」最难查。
  if (custom) return [custom];

  const list: string[] = [];
  const home = process.env.USERPROFILE || homedir();
  if (home) list.push(join(home, 'Zomboid'));

  // 有人把整个用户目录搬到了别的盘。四个盘符的成本可以忽略，
  // 换掉的是一句「找不到」。
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
    list.push(`${drive}\\Zomboid`);
  }
  return [...new Set(list)];
}

export function resolveRoot(configured: string): RootProbe {
  const tried = rootCandidates(configured);
  const custom = configured.trim();

  for (const p of tried) {
    if (!existsSync(p)) continue;
    if (!looksLikeZomboidRoot(p)) {
      // 目录在但结构不对：可能是空壳，也可能是用户填错了一层。
      return {
        root: p,
        tried,
        problem: null,
        warning: `目录在，但里面没有 Lua / mods / Saves —— 多半填错了一层（要的是 Zomboid 那一层）。`,
      };
    }
    return { root: p, tried, problem: null, warning: null };
  }

  return {
    root: null,
    tried,
    problem: custom
      ? `你填的「${custom}」不存在。`
      : '还没找到存档目录 —— 这台机器上游戏很可能一次都没启动过。',
  };
}

export interface Paths {
  root: string;
  luaDir: string;
  dataDir: string;
  stateFile: string;
  /** 写指令给游戏用的那一个文件。 */
  cmdFile: string;
  modsDir: string;
  bridgeDir: string;
  consoleFile: string;
}

export function pathsOf(root: string): Paths {
  const luaDir = join(root, 'Lua');
  const dataDir = join(luaDir, DATA_SUBDIR);
  const modsDir = join(root, 'mods');
  return {
    root,
    luaDir,
    dataDir,
    // 跟 Lua 侧 B.OUT_FILE 一致：单文件名，落在 Zomboid/Lua/ 根。
    // 两边各写各的会静默失联，所以 test/lua-contract.test.mjs 会盯住这一点。
    stateFile: join(luaDir, 'coopani-pz-state.txt'),
    // 往游戏里下指令的那条线。文件名单一，与 Lua 侧 B.CMD_FILE 必须逐字一致 ——
    // 两边各写各的会静默失联，test/lua-contract.test.mjs 盯着这一点。
    cmdFile: join(luaDir, 'coopani-pz-cmd.txt'),
    modsDir,
    bridgeDir: join(modsDir, BRIDGE_DIR_NAME),
    consoleFile: join(root, 'console.txt'),
  };
}

/** 给「找不到游戏」那句话用的路径清单，最多列六个，别刷屏。 */
export function describeTried(tried: string[]): string {
  const head = tried.slice(0, 6).join('、');
  return tried.length > 6 ? `${head} 等 ${tried.length} 处` : head;
}
