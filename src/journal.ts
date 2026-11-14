/**
 * 她的陪玩日记。
 *
 * 为什么单独存一份而不是塞进提示词：这份东西的价值在**跨档**。僵毁最狠的地方是
 * 死了就重来，而人是会重复犯同一个错的 —— 「第三次死在同一个加油站」这种事，
 * 只有她记着才说得出来。
 *
 * 四条设计（照抄炉石那份打法档案踩出来的）：
 *
 * 1. **空着比填满好。** 别替她写第一版 —— 归纳得再准也是别人的判断。
 * 2. **骨架里不写示范句子。** 给了范例她就照抄，最后满篇都是提示词里的措辞。
 * 3. **只 add / drop，不给整篇覆写。** 这是全扩展唯一一个不可恢复的文件。
 * 4. **一节有上限。** 满了让她先删。否则三个月后是一篇散文。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Section = 'alive' | 'death' | 'next' | 'unsure';

const SECTION_TITLE: Record<Section, string> = {
  alive: '这局怎么活的',
  death: '死在哪一步',
  next: '下回注意',
  unsure: '还没想明白',
};

const SECTION_ORDER: Section[] = ['alive', 'death', 'next', 'unsure'];
const MAX_PER_SECTION = 8;

const SKELETON = `# 陪玩日记

> 我自己的本子。第一人称，写事实、写我判断错了哪一步。
> 不是攻略，也不是给他的建议清单 —— 那些在对话里说就够了。

## 这局怎么活的

## 死在哪一步

## 下回注意

## 还没想明白
`;

export interface JournalResult {
  ok: boolean;
  message: string;
  changed: boolean;
}

export class Journal {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'pz-journal.md');
  }

  path(): string {
    return this.file;
  }

  /** 读全文。文件不存在时给骨架，不落盘（第一次写才落）。 */
  read(): string {
    try {
      if (existsSync(this.file)) return readFileSync(this.file, 'utf8');
    } catch {
      // 读不出来就按空处理，但下面的写入会覆盖它 —— 所以 read 失败时 add 要拒绝。
    }
    return SKELETON;
  }

  hasFile(): boolean {
    try {
      return existsSync(this.file);
    } catch {
      return false;
    }
  }

  add(section: Section, text: string): JournalResult {
    const line = text.trim().replace(/\s+/g, ' ');
    if (!line) return { ok: false, message: '空的一行，没写。', changed: false };
    if (line.length > 120) return { ok: false, message: `太长了（${line.length} 字），压到 120 字以内再写。`, changed: false };

    const parsed = this.parse();
    const bucket = parsed[section];
    if (bucket.length >= MAX_PER_SECTION) {
      return {
        ok: false,
        message: `「${SECTION_TITLE[section]}」已经 ${MAX_PER_SECTION} 条了，先删一条再加。`,
        changed: false,
      };
    }
    // 去重按「包含」：写过「宁可留一手解牌」，再写「留一手解牌」不该多一条。
    if (bucket.some((x) => x.includes(line) || line.includes(x))) {
      return { ok: false, message: '这条已经写过了。', changed: false };
    }
    bucket.push(line);
    this.persist(parsed);
    return { ok: true, message: `记在「${SECTION_TITLE[section]}」了。`, changed: true };
  }

  drop(text: string): JournalResult {
    const needle = text.trim();
    if (!needle) return { ok: false, message: '要删哪一条？', changed: false };
    const parsed = this.parse();
    for (const section of SECTION_ORDER) {
      const idx = parsed[section].findIndex((x) => x.includes(needle));
      if (idx >= 0) {
        const [gone] = parsed[section].splice(idx, 1);
        this.persist(parsed);
        return { ok: true, message: `删掉了：${gone}`, changed: true };
      }
    }
    return { ok: false, message: '没找到包含这段文字的一条。', changed: false };
  }

  /** 给提示词用的紧凑版：只列有内容的节。 */
  digest(): string {
    const parsed = this.parse();
    const blocks: string[] = [];
    for (const section of SECTION_ORDER) {
      if (!parsed[section].length) continue;
      blocks.push(`**${SECTION_TITLE[section]}**\n${parsed[section].map((x) => `- ${x}`).join('\n')}`);
    }
    return blocks.length ? blocks.join('\n\n') : '';
  }

  /* -------------------------------------------------------------- 内部 */

  private parse(): Record<Section, string[]> {
    const out: Record<Section, string[]> = { alive: [], death: [], next: [], unsure: [] };
    const raw = this.read();
    let cur: Section | null = null;
    for (const line of raw.split(/\r?\n/)) {
      const head = /^##\s+(.+?)\s*$/.exec(line);
      if (head) {
        const title = head[1];
        cur = (SECTION_ORDER.find((s) => SECTION_TITLE[s] === title) ?? null);
        continue;
      }
      if (!cur) continue;
      const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (item) out[cur].push(item[1]);
    }
    return out;
  }

  private persist(parsed: Record<Section, string[]>): void {
    const blocks = [`# 陪玩日记`, '', '> 我自己的本子。第一人称，写事实、写我判断错了哪一步。', '> 不是攻略，也不是给他的建议清单 —— 那些在对话里说就够了。', ''];
    for (const section of SECTION_ORDER) {
      blocks.push(`## ${SECTION_TITLE[section]}`, '');
      for (const item of parsed[section]) blocks.push(`- ${item}`);
      blocks.push('');
    }
    const body = blocks.join('\n');
    mkdirSync(dirname(this.file), { recursive: true });
    // 原子写：临时文件 + 改名。这份文件不可恢复，写坏一次她的记忆就没了。
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, this.file);
  }
}

export const JOURNAL_SECTIONS = SECTION_ORDER;
export { SECTION_TITLE };
