/**
 * 「读不到数据」的四种原因，一种都不能混。
 *
 * 混了会怎样：把「还没建档」说成「mod 没装」→ 他去重装 mod；
 * 把「没读档」说成「游戏没开」→ 他把游戏关了重开，还是没用。
 * 每次误诊他都得花几分钟，而且会开始不信这个扩展。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diagnoseNoData, watchGame } from '../src/gamewatch.ts';
import { pathsOf } from '../src/paths.ts';

/** 一个「在游戏里、什么都不缺」的处境，用来测「额外的提示会不会混进来」。 */
async function buildSit() {
  const { buildSituation } = await import('../src/perception.ts');
  return buildSituation({
    v: 1, seq: 1, ts: Math.floor(Date.now() / 1000), alive: true, kills: 0, session: 's',
    clock: { hour: 12, minute: 0, day: 1, night: false },
    player: {
      x: 0, y: 0, z: 0, outside: false, room: '客厅', building: '民居',
      health: 1, hunger: 0, thirst: 0, fatigue: 0, endurance: 1, stress: 0,
      visible: 0, infected: false, infection: 0, bodyHealth: 100,
      weapon: '斧头', weaponCond: 10, weaponMax: 10, offhand: null,
    },
    gear: { bandage: 3, food: 3, water: 3, light: 2 },
    events: [],
  }, { nowMs: Date.now(), staleSeconds: 25 });
}

/** @type {import('../src/gamewatch.ts').GameWatch} */
const base = {
  running: true,
  consoleAgeMs: 1000,
  consoleSize: 20000,
  saveCount: 1,
  presetHasBridge: true,
  exclusiveFullscreen: false,
  bridgeLoaded: false,
  bridgeError: null,
};

test('游戏没在跑：说的是「开起来」，不是「坏了」', () => {
  const d = diagnoseNoData({ ...base, running: false });
  assert.equal(d.reason, 'closed');
  assert.match(d.text, /游戏没在跑/);
  assert.ok(!/坏/.test(d.text));
});

test('游戏在跑但模组没勾：指向 Mods，而不是让人去重装', () => {
  const d = diagnoseNoData({ ...base, presetHasBridge: false, saveCount: 0 });
  assert.equal(d.reason, 'mod-off');
  assert.match(d.text, /Mods/);
  assert.match(d.text, /Coopani Bridge/);
});

test('还没建过档：说清是「新游戏」不是「继续」', () => {
  const d = diagnoseNoData({ ...base, saveCount: 0 });
  assert.equal(d.reason, 'no-save');
  assert.match(d.text, /新游戏/);
});

test('有档但没进世界：说清「主菜单不算」', () => {
  const d = diagnoseNoData(base);
  assert.equal(d.reason, 'not-loaded');
  assert.match(d.text, /主菜单/);
});

test('脚本报错时说「是我的锅」，不要说成他操作错了', () => {
  const d = diagnoseNoData({ ...base, bridgeError: 'ERROR: CoopaniBridge.lua:12 attempt to call a nil value' });
  assert.equal(d.reason, 'bridge-error');
  assert.match(d.text, /报错/);
  assert.match(d.text, /不是他操作的问题/);
});

test('顺序对：先看 mod 勾没勾，再看有没有档', () => {
  // 两样都缺时先说 mod —— 因为不勾 mod，建了档也白建。
  const d = diagnoseNoData({ ...base, presetHasBridge: false, saveCount: 0 });
  assert.equal(d.reason, 'mod-off');
});

test('console.txt 里没有我们的横幅，不能当成「mod 没启用」', () => {
  // 客户端 Lua 是随存档加载的，主菜单看不到那句 print。
  // 拿它当判据会把「还没读档」误诊成「没装好」。
  const d = diagnoseNoData({ ...base, bridgeLoaded: false, presetHasBridge: true });
  assert.equal(d.reason, 'not-loaded');
});

test('独占全屏能从 options.ini 里读出来', () => {
  const root = mkdtempSync(join(tmpdir(), 'pzwatch-'));
  try {
    writeFileSync(join(root, 'options.ini'), 'borderless=false\nfullScreen=true\n', 'utf8');
    assert.equal(watchGame(pathsOf(root), Date.now()).exclusiveFullscreen, true);

    writeFileSync(join(root, 'options.ini'), 'borderless=true\nfullScreen=true\n', 'utf8');
    assert.equal(watchGame(pathsOf(root), Date.now()).exclusiveFullscreen, true, '无边框全屏同样绕开 DWM');

    // 用户实际踩的那一档：无边框 + 非独占。上一版判成 false，所以一直没提醒他改回来。
    writeFileSync(join(root, 'options.ini'), 'borderless=true\nfullScreen=false\n', 'utf8');
    assert.equal(watchGame(pathsOf(root), Date.now()).exclusiveFullscreen, true, '无边框满屏算全屏路径');

    writeFileSync(join(root, 'options.ini'), 'borderless=false\nfullScreen=false\n', 'utf8');
    assert.equal(watchGame(pathsOf(root), Date.now()).exclusiveFullscreen, false, '窗口模式不算');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('独占全屏时，检查清单里会出现「为什么看不见她」那一条', async () => {
  const { tipsOf } = await import('../src/perception.ts');
  const sit = buildSit();
  const on = tipsOf(sit, { exclusiveFullscreen: true });
  const off = tipsOf(sit, { exclusiveFullscreen: false });
  assert.ok(on.some((t) => t.key === 'fullscreen'));
  assert.ok(!off.some((t) => t.key === 'fullscreen'));
});

test('watchGame 从文件里读出三个事实', () => {
  const root = mkdtempSync(join(tmpdir(), 'pzwatch-'));
  try {
    mkdirSync(join(root, 'Saves', 'Survivor', 'MySave'), { recursive: true });
    mkdirSync(join(root, 'mods'), { recursive: true });
    writeFileSync(join(root, 'mods', 'default.txt'), 'VERSION = 1,\n\nmods\n{\n    "CoopaniBridge",\n}\n', 'utf8');
    writeFileSync(join(root, 'console.txt'), '[CoopaniBridge] 已加载\n', 'utf8');

    const w = watchGame(pathsOf(root), Date.now());
    assert.equal(w.saveCount, 1);
    assert.equal(w.presetHasBridge, true);
    assert.equal(w.bridgeLoaded, true);
    assert.equal(w.running, true, '刚写过的 console.txt 该算「在跑」');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模组预设是空的时候读成 false（这是「没勾」的判据）', () => {
  const root = mkdtempSync(join(tmpdir(), 'pzwatch-'));
  try {
    mkdirSync(join(root, 'mods'), { recursive: true });
    writeFileSync(join(root, 'mods', 'default.txt'), 'VERSION = 1,\n\nmods\n{\n}\n', 'utf8');
    const w = watchGame(pathsOf(root), Date.now());
    assert.equal(w.presetHasBridge, false);
    assert.equal(w.saveCount, 0);
    // console.txt 不存在 = 游戏没在跑
    assert.equal(w.running, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
