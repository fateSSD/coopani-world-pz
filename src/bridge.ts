/**
 * 数据通道：装桥接 mod、读它写出来的那一份 state.json。
 *
 * 这里刻意只做**一个文件**。原本想的是「状态一个文件、事件一个追加文件」，
 * 但 PZ 的 `getFileWriter` 是追加还是截断在版本间并不一致 —— 追加就意味着一小时
 * 之后那份文件没法解析。干脆全塞进一份、每拍覆盖写：只有一个通道，
 * 只有一种「写不动」的失败，诊断和说人话都简单。
 *
 * 代价是文件稍大（几十条事件 + 状态，约 4KB），两秒一次完全可以接受。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RawState } from './types.ts';
import { BRIDGE_DIR_NAME, BRIDGE_MOD_VERSION, DATA_SUBDIR, type Paths } from './paths.ts';

/* ---------------------------------------------------------------- 装 mod */

export interface InstallResult {
  state: 'current' | 'installed' | 'skipped' | 'failed';
  detail: string;
}

function stampFile(dir: string): string {
  return join(dir, '.coopani-bridge.json');
}

function readStamp(dir: string): string | null {
  try {
    const raw = readFileSync(stampFile(dir), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 把包内目录同步到游戏目录：先删目标里多出来的，再逐个覆盖。
 *
 * 不整个 `rmDir` 再重建 —— 游戏运行时目录句柄还被它拿着，会 `ENOTEMPTY`，
 * 一次失败的安装等于什么都没装，而用户只会看到「文件在但没生效」。
 * 单个文件覆盖通常没问题（游戏读完 Lua 就不锁着）。
 */
function syncTree(src: string, dest: string): { copied: number; removed: number } {
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  let removed = 0;

  const wanted = new Set(readdirSync(src));
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    if (wanted.has(entry.name)) continue;
    try {
      rmSync(join(dest, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // 删不掉就留着；下一轮再试。别让它把整次安装判失败。
    }
  }

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      const r = syncTree(from, to);
      copied += r.copied;
      removed += r.removed;
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return { copied, removed };
}

/**
 * 把包内那份 `pzmod/CoopaniBridge` 拷进游戏的 mods 目录。
 *
 * 为什么要自己装：那份 Lua 住在扩展包里，**换台机器就是缺的**，而缺了不会报错，
 * 表现只是「她一声不响」。写一行 README 让人手动拷等于没做。
 *
 * 只写自己的目录（`mods/CoopaniBridge`），不碰别人的 mod。
 */
export function installBridge(pkgDir: string, paths: Paths, enabled: boolean): InstallResult {
  if (!enabled) return { state: 'skipped', detail: '配置里关了自动安装。' };

  const src = join(pkgDir, 'pzmod', BRIDGE_DIR_NAME);
  if (!existsSync(join(src, 'mod.info'))) {
    return { state: 'failed', detail: `扩展包里缺少桥接 mod（找不到 ${join(src, 'mod.info')}）。` };
  }

  const dest = paths.bridgeDir;
  const have = readStamp(dest);
  const modInfoThere = existsSync(join(dest, 'mod.info'));

  if (have === BRIDGE_MOD_VERSION && modInfoThere) {
    return { state: 'current', detail: `${BRIDGE_MOD_VERSION} 已就位。` };
  }

  try {
    const r = syncTree(src, dest);
    writeFileSync(stampFile(dest), JSON.stringify({ version: BRIDGE_MOD_VERSION, installedAt: new Date().toISOString() }), 'utf8');
    return {
      state: 'installed',
      detail: have
        ? `从 ${have} 升到 ${BRIDGE_MOD_VERSION}：覆盖 ${r.copied} 个文件${r.removed ? `，清掉 ${r.removed} 个旧文件` : ''}。`
        : `装好了（${r.copied} 个文件）。**游戏里要启用一次。**`,
    };
  } catch (err) {
    return { state: 'failed', detail: `写不进 mods 目录：${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------ 模组列表 */

export interface EnableResult {
  state: 'current' | 'enabled' | 'skipped' | 'failed';
  detail: string;
}

const OUR_MOD_LINE = /^\s*mod\s*=\s*CoopaniBridge\s*,?\s*$/im;

/**
 * 把 mod 写进 B42 的模组列表，免得他在 Mods 页面里翻。
 *
 * B42 的选择器只列「声明了 42.x 兼容」的 mod；没声明的本地 mod 明明文件在，
 * 列表里就是找不到。与其让他去找一个找不到的东西，不如替他勾上。
 *
 * 格式来自 PZ 官方脚本：`mods { mod = <ID>, }` —— 不是 `ID=ID`，写错了会静默失效。
 * 只加自己那一行，别人勾的 mod 原样不动。
 */
export function ensureModEnabled(paths: Paths, enabled: boolean): EnableResult {
  if (!enabled) return { state: 'skipped', detail: '设置里关了自动安装。' };
  const file = join(paths.modsDir, 'default.txt');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = 'VERSION = 1,\n\nmods\n{\n}\n\nmaps\n{\n}\n';
  }
  if (OUR_MOD_LINE.test(text)) return { state: 'current', detail: '模组列表里已经勾上了。' };

  const open = text.indexOf('{');
  const close = text.indexOf('}', open);
  if (open < 0 || close < 0) {
    return { state: 'failed', detail: 'default.txt 的格式认不出来，没敢动它。' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = text.slice(0, close) + `    mod = CoopaniBridge,${eol}` + text.slice(close);
  try {
    writeFileSync(file, next, 'utf8');
    return { state: 'enabled', detail: '已写进 mods/default.txt，重启游戏生效。' };
  } catch (err) {
    return { state: 'failed', detail: `写不进 mods/default.txt：${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------ 存档模组清单 */

export interface SaveModsResult {
  patched: number;
  detail: string;
}

/**
 * 把 mod 写进**每个存档**的 `mods.txt`。
 *
 * 这一条是整条链路上最后一个、也是最难发现的坑：
 * `mods/default.txt` 只决定**主菜单**加载哪些 mod。读档时游戏按
 * `Saves/<模式>/<档名>/mods.txt` 重新加载一遍 Lua —— 那份清单是空的，
 * 我们的 mod 就会在进世界的那一刻被卸掉：回调全部消失、一句错都不报、
 * 游戏照常跑满几万帧，而状态文件停在上一次写入。
 *
 * 实测对得上：存档是 15:03 建的时候没选 mod，`mods.txt` 里 `mods { }` 是空的，
 * 所以每次进世界都静默失联；`mods/default.txt` 里有我们的名字，所以启动时横幅照打。
 *
 * 游戏会在读档和退出时重写这个文件，所以扩展要定期补 —— 见 world.ts 的调用点。
 */
export function ensureSaveModsEnabled(paths: Paths, enabled: boolean): SaveModsResult {
  if (!enabled) return { patched: 0, detail: '设置里关了自动安装。' };
  const savesDir = join(paths.root, 'Saves');
  let modes: string[] = [];
  try {
    modes = readdirSync(savesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { patched: 0, detail: '还没有存档。' };
  }

  let patched = 0;
  const touched: string[] = [];
  for (const mode of modes) {
    const modeDir = join(savesDir, mode);
    let saves: string[] = [];
    try {
      saves = readdirSync(modeDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const save of saves) {
      const file = join(modeDir, save, 'mods.txt');
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (OUR_MOD_LINE.test(text)) continue;
      const open = text.indexOf('{');
      const close = text.indexOf('}', open);
      if (open < 0 || close < 0) continue;
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const next = text.slice(0, close) + `    mod = CoopaniBridge,${eol}` + text.slice(close);
      try {
        writeFileSync(file, next, 'utf8');
        patched += 1;
        touched.push(`${mode}/${save}`);
      } catch {
        // 写不进去就下一轮再试；不要让整次检查失败。
      }
    }
  }

  return {
    patched,
    detail: patched
      ? `给 ${touched.join('、')} 的存档模组清单补了 CoopaniBridge。`
      : '存档模组清单里已经有了。',
  };
}

/* ---------------------------------------------------------------- 读状态 */

export interface ReadResult {
  state: RawState | null;
  /** 读不出来的人话原因；null = 读到了。 */
  problem: string | null;
  kind: 'ok' | 'missing' | 'half-written' | 'unreadable';
  size: number;
  ageMs: number | null;
}

/** 简单解析；失败返回 null。 */
function tryParse(text: string): RawState | null {
  try {
    const v = JSON.parse(text) as RawState;
    return v && typeof v === 'object' && typeof v.seq === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** 从 `start` 处的 `{` 开始，找到与之配对的 `}`。字符串里的括号不算。 */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 兼容「追加写」的实现：取文件里**最后一个**完整对象。
 *
 * 正常情况第一句就返回了。这一层是给「宿主把 getFileWriter 实现成追加」那种
 * 版本准备的 —— 那种情况下每拍都会多一段，文件越长越难解析，
 * 而症状是「她越玩越不准」，没人会往这上面想。
 */
/**
 * 去掉裸控制字符。
 *
 * JSON 规范不允许字符串里出现 0x00–0x1F 的裸字节。真机上出过一次：
 * 失败原因里是中文，Kahlua 的词法器把非 ASCII 截成单字节，里面夹了 0x1F 和 0x08 ——
 * **数据一个字段都没少，却整份 parse 不了**，外面只能说「读到半截 JSON」。
 *
 * 根在 Lua 侧已经修了（原因改 ASCII 码 + 转义控制字符），这里只兜底：
 * 真遇到脏字节时，宁可丢掉那一个字段，也不要把整份数据判死。
 */
function stripCtrl(s: string): string {
  // 保留 \t \n \r（JSON 允许它们出现在空白处），去掉其余控制字符。
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function digForState(text: string): RawState | null {
  const direct = tryParse(text);
  if (direct) return direct;

  const marker = '{"v"';
  let at = text.lastIndexOf(marker);
  let guard = 0;
  while (at >= 0 && guard < 12) {
    const end = matchBrace(text, at);
    if (end > at) {
      const candidate = tryParse(text.slice(at, end + 1));
      if (candidate) return candidate;
    }
    at = at > 0 ? text.lastIndexOf(marker, at - 1) : -1;
    guard += 1;
  }
  return null;
}

export function parseStateLoose(text: string): RawState | null {
  const ok = digForState(text);
  if (ok) return ok;

  // 最后一次机会：把裸控制字符去掉再找。脏一个字节不该毁掉整份数据。
  const cleaned = stripCtrl(text);
  if (cleaned !== text) return digForState(cleaned);
  return null;
}

export function readState(paths: Paths, nowMs: number): ReadResult {
  if (!existsSync(paths.stateFile)) {
    return {
      state: null,
      problem: '游戏还没写出数据。可能是没在读档，也可能 mod 没启用。',
      kind: 'missing',
      size: 0,
      ageMs: null,
    };
  }

  let text: string;
  let size = 0;
  let ageMs: number | null = null;
  try {
    const st = statSync(paths.stateFile);
    size = st.size;
    ageMs = nowMs - st.mtimeMs;
    text = readFileSync(paths.stateFile, 'utf8');
  } catch (err) {
    return {
      state: null,
      problem: `读不出来：${(err as Error).message}`,
      kind: 'unreadable',
      size: 0,
      ageMs: null,
    };
  }

  const parsed = parseStateLoose(text);
  if (parsed) return { state: parsed, problem: null, kind: 'ok', size, ageMs };

  // 读到了半截：游戏正在写、或者文件被写坏了。
  // 不覆盖、不猜 —— 下一拍再读一次就好了。
  return {
    state: null,
    problem: '读到半截 JSON（游戏正好在写）。下一拍会再读一次，不用管。',
    kind: 'half-written',
    size,
    ageMs,
  };
}

/**
 * 兼容用的空目录。B42 的 `getFileWriter` 现在写的是 `Lua/` 根下的单文件，
 * 不再需要子目录；这里留着只是历史遗留，不创建也不会出问题。
 */
export function ensureDataDir(paths: Paths): { ok: boolean; problem: string | null } {
  try {
    mkdirSync(join(paths.luaDir, DATA_SUBDIR), { recursive: true });
    return { ok: true, problem: null };
  } catch (err) {
    return { ok: false, problem: `建不出 ${join(paths.luaDir, DATA_SUBDIR)}：${(err as Error).message}` };
  }
}
