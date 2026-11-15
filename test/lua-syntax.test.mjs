// Lua 语法检查。
//
// 为什么单独一个文件：其余的 Lua 测试全是**正则匹配**，它们能确认「某个函数在」，
// 但确认不了「这个文件能被解析」。2026-11-08 就是这么栽的 ——
//
//   pcall(function() if CD.transmit then CD.transmit(a) end)
//
// 单行写法漏了 function 自己的 `end`。173 条测试全过、Lua 审计 0 处、
// 四份文件 md5 一致，然后整个 mod 在游戏里加载失败：
//
//   CoopaniBridge.lua:1817: unexpected symbol near ')'
//
// 表现是「她什么都不做」，而外面一切正常。正则测试永远抓不到这种错。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * 路径按**本文件位置**算，不按 CWD。
 *
 * 原来写的是相对路径，在包根跑没事，从别处跑（比如 `node --test <绝对路径>`）
 * 就 ENOENT —— 2026-11-15 审核里那次「1 个 CWD 相对路径失败」就是它。
 * 测试的结果不该取决于你在哪个目录敲命令。
 */
const ROOT = new URL('..', import.meta.url);
const FILES = [
  'pzmod/CoopaniBridge/media/lua/client/CoopaniBridge.lua',
  'pzmod/CoopaniBridge/media/lua/shared/CoopaniBridge.lua',
  'pzmod/CoopaniBridge/42.0/media/lua/client/CoopaniBridge.lua',
  'pzmod/CoopaniBridge/42.0/media/lua/shared/CoopaniBridge.lua',
].map((p) => fileURLToPath(new URL(p, ROOT)));

let luaparse = null;
try {
  luaparse = await import('luaparse');
} catch {
  // 没装就跳过，不制造假失败 —— 但会打印一行，别让人以为检查过了。
  console.log('[lua-syntax] 没有 luaparse，跳过语法检查（npm i -D luaparse）');
}

test('四份 Lua 都能被解析 —— 语法错会让整个 mod 静默不加载', { skip: !luaparse }, () => {
  const parse = luaparse.default?.parse ?? luaparse.parse;
  for (const f of FILES) {
    assert.ok(existsSync(f), `缺文件：${f}`);
    const src = readFileSync(f, 'utf8');
    try {
      parse(src, { luaVersion: '5.1' });
    } catch (e) {
      assert.fail(`${f} 第 ${e.line} 行解析失败：${e.message}`);
    }
  }
});
