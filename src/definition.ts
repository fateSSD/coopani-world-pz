/**
 * 扩展入口：默认导出 `WorldDefinition`，装载器按 `cortico.kind === 'world'` 认它。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorldDefinition } from 'cortico/world.ts';
import { PZ_DEFAULTS, PZ_ID, type PzConfigSection } from './config.ts';
import { PZ_DESCRIBE, PzWorld } from './world.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

export const PZ: WorldDefinition<PzConfigSection> = {
  id: PZ_ID,
  label: '僵毁陪玩',
  defaults: () => structuredClone(PZ_DEFAULTS()),

  /**
   * 提示词文件读不到时**在这里就拦下来**。
   *
   * 不拦的后果不是「提示词没加载」，是：框架重建前缀时 `readFileSync` 抛错、
   * 挂载半途中断，World 留在挂载表里但 `slot.mounted` 没置上 —— 之后每次激活
   * 都报「工具撞名」，重启也清不掉。宁可现在报一句「文件缺失」。
   */
  preflight: () => {
    if (!existsSync(ENV_PROMPT_FILE)) {
      throw new Error(`提示词文件缺失：${ENV_PROMPT_FILE}`);
    }
    readFileSync(ENV_PROMPT_FILE, 'utf8');
  },

  create: (ctx) => new PzWorld({
    cfg: ctx.cfg, // 活引用：热改的键下一次轮询就生效，别展开成 {...ctx.cfg}
    dataDir: ctx.dataDir,
    botName: ctx.botName,
  }),

  describe: PZ_DESCRIBE,
};
