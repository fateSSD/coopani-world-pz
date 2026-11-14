/**
 * 表情 / 动作名怎么用 —— **不再去宿主安装目录里读词表**。
 *
 * ## 为什么改（2026-11-14，市集作者要求）
 *
 * 原来这里现读宿主 `config.json` 的 `worlds["desktop-pet"].skin.figure`，再拼路径打开
 * `web/<figure>/figure.json`，拿真实词表。理由是「手抄会过期，过期的表现是她说句话、
 * 脸不变、身体不动，而且不报错」。
 *
 * 但这个做法本身越界：**扩展按路径去读宿主的安装目录**，和改宿主的文件是同一类事 ——
 * 都是在拿"我恰好知道宿主的目录布局"当契约用。宿主换一次布局就静默失效，
 * 而用户看到的是「她不动了」。作者在 cortico-extensions#659 里一并要求撤掉（journey / pz 都点了）。
 *
 * 撤掉不丢信息：桌宠 World 已经把当前形象的词表放进它自己的环境提示词，
 * 模型看得到。这里只负责说清**怎么用**。
 *
 * ## 空集 = 不校验
 *
 * `expressions` / `motions` 为空时，`pickExpression` / `pickMotion` **原样放行** ——
 * 不拿一份猜出来的清单去否掉她想说的话。猜错的代价比漏一个动作大得多。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Vocab {
  expressions: Set<string>;
  motions: Set<string>;
  /** 人话说明：为什么这份词表是空的。null = 有可靠来源（现在恒非 null）。 */
  note: string | null;
  figure: string | null;
}

/**
 * 从本扩展的数据目录往上爬，找带 `resources/app` 的那一层。
 *
 * **只用来判断「是不是 Coopani 环境」**（桥接文件要落到宿主的 dataDir 下），
 * 不再拿它去读宿主的词表或配置。
 */
export function findHostRoot(dataDir: string): string | null {
  let cur = resolve(dataDir);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(cur, 'resources', 'app'))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/**
 * 现在没有可靠来源，返回空集 + 一句说明。
 *
 * 参数保留是为了不改调用方签名（`world.ts` 两处），也让以后真有接口时只改这里。
 */
export function readVocab(_hostRoot: string | null, _companionDir: string): Vocab {
  return {
    expressions: new Set<string>(),
    motions: new Set<string>(),
    note: '不再读宿主安装目录里的词表（市集规则：扩展不改也不读宿主包）；名字以宿主给的那份词表为准',
    figure: null,
  };
}

/** 词表为空 = 不校验，原样放行。 */
export function pickExpression(v: Vocab, want: string): string {
  return v.expressions.size === 0 || v.expressions.has(want) ? want : 'neutral';
}

/** 同上：不知道有哪些动作时，不否掉她要做的那个。 */
export function pickMotion(v: Vocab, want: string): string | null {
  return v.motions.size === 0 || v.motions.has(want) ? want : null;
}

/**
 * 提示词里那段 —— **只讲怎么用，不列词表**。
 *
 * 原来这里会列出「表情=happy · 动作=nod · wave…」，那是从宿主 figure.json 抄来的。
 * 现在不读了，再列就只能是编的；而编错的词表比不列更糟：她照着抄，宿主静默丢掉。
 */
export function describeVocab(v: Vocab): string {
  const tail = v.note ? `\n（${v.note}）` : '';
  return [
    '表情和动作都写成中文名，放进【】里，跟台词一起：`【平静】这屋里有动静。` 只写表情不写动作，人不会动。',
    '**名字只用当前形象词表里真有的那些**（见上下文里「当前形象的词表」那段，由桌宠那边给）。写表外的会被静默丢掉 —— 她不解释，你也不会收到报错。',
    '查不到合适的词就只写表情。宁可少动一下，别赌一个可能不存在的名字。',
  ].join('\n') + tail;
}
