/**
 * 端到端：假装这台机器上有个僵尸毁灭工程的目录，把整个 World 从头走一遍。
 *
 * 单测能证明「函数算得对」，证明不了「挂上去会不会炸」。这一份盯的是后者：
 * 找不到目录时说什么、装 mod 装到哪、读到数据之后事件真的推出去没有。
 *
 * 不用真游戏、不用真宿主 —— 真机验证要等他第一次进游戏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PZ_DEFAULTS } from '../src/config.ts';
import { PzWorld } from '../src/world.ts';

const NOW = new Date('2026-11-07T12:00:00+08:00');

/** 会走的钟。`start()` 之后世界头几秒故意不推环境提醒，测试得把时间推过去。 */
function clock() {
  let t = NOW.getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => { t += ms; },
  };
}

function fakeHost() {
  const events = [];
  const logs = [];
  return {
    events,
    logs,
    host: {
      log: {
        trace: () => {},
        debug: () => {},
        info: (m) => logs.push(['info', m]),
        warn: (m) => logs.push(['warn', m]),
        error: (m) => logs.push(['error', m]),
      },
      pushEvent: async (e, opts) => {
        events.push({ ...e, trigger: opts?.trigger });
        return { id: String(events.length) };
      },
    },
  };
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pzroot-'));
  mkdirSync(join(root, 'Lua'), { recursive: true });
  mkdirSync(join(root, 'mods'), { recursive: true });
  return root;
}

function state(over = {}) {
  return JSON.stringify({
    v: 1,
    seq: 1,
    ts: Math.floor(NOW.getTime() / 1000),
    alive: true,
    kills: 0,
    session: 'run-1',
    clock: { hour: 20, minute: 10, day: 4, night: true },
    player: {
      x: 10, y: 20, z: 0, outside: false, room: '客厅', building: '民居',
      health: 0.75, hunger: 0.4, thirst: 0.3, fatigue: 0.5, endurance: 0.6, stress: 0.2,
      visible: 8, infected: false, infection: 0, bodyHealth: 80,
      weapon: '消防斧', weaponCond: 3, weaponMax: 10, offhand: null,
    },
    gear: { bandage: 0, food: 2, water: 0, light: 0 },
    events: [],
    ...over,
  });
}

test('找不到游戏目录时，说的是「先去启动一次」而不是「坏了」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pzdata-'));
  try {
    const { host, events } = fakeHost();
    const c = clock();
    const world = new PzWorld({
      cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'nope'), autoInstallMod: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: c.now,
    });
    await world.start(host);
    c.advance(10_000);
    await world.tick();
    await world.stop();

    const setup = events.find((e) => e.type === 'pz.setup');
    assert.ok(setup, '该推一条 pz.setup');
    assert.match(setup.text, /先进一次游戏|找不到/);
    assert.ok(!/坏(了|掉)/.test(setup.text), '别说成「坏了」');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('游戏刚启动、state 里连 gear 都没有：不许抛成「切换失败」', async () => {
  // 真机原文，一个字没改。游戏开着但没读档时，桥接写的就是这一行 —— 连 gear 键都没有。
  // 原来 start() 里的第一句 tick() 会在 guideOf 里读 undefined.water 抛掉，
  // 宿主把它报成「切换失败: Cannot read properties of undefined」，
  // 用户看到的是「这个扩展开不起来」，而不是「某个功能坏了」。
  const root = makeRoot();
  const dir = mkdtempSync(join(tmpdir(), 'pzdata-'));
  try {
    writeFileSync(
      join(root, 'Lua', 'coopani-pz-state.txt'),
      '{"v":1,"seq":0,"ts":1794129159,"alive":false,"boot":true,"load":2,"events":[]}',
      'utf8',
    );

    const { host, events, logs } = fakeHost();
    const c = clock();
    const world = new PzWorld({
      cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: root, autoInstallMod: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: c.now,
    });

    // 宿主就是在这个调用上判断「切换失败」的。
    await assert.doesNotReject(() => world.start(host), 'start() 不许抛');
    c.advance(10_000);
    await assert.doesNotReject(() => world.tick(), '后续每一拍也不许抛');

    const errs = logs.filter(([lvl]) => lvl === 'error');
    assert.deepEqual(errs, [], `不该有 error 日志：${JSON.stringify(errs)}`);

    // 而且不能因为读不到背包就胡说 —— 这时候根本还没进游戏。
    for (const e of events) {
      assert.ok(!/undefined|NaN/.test(e.text ?? ''), `正文里漏了原始错误：${e.text}`);
    }

    await world.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('找到目录之后：自动装 mod、建数据目录、读档后按事实开口', async () => {
  const root = makeRoot();
  const dir = mkdtempSync(join(tmpdir(), 'pzdata-'));
  try {
    const { host, events, logs } = fakeHost();
    const c = clock();
    const world = new PzWorld({
      cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: root, autoInstallMod: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: c.now,
    });
    await world.start(host);
    c.advance(10_000);
    await world.tick();

    // 1. mod 装进去了（换台机器也能自己补上，不靠人手动拷）
    assert.ok(existsSync(join(root, 'mods', 'CoopaniBridge', 'mod.info')), 'mod.info 没拷进去');
    assert.ok(
      existsSync(join(root, 'mods', 'CoopaniBridge', 'media', 'lua', 'client', 'CoopaniBridge.lua')),
      'Lua 没拷进去',
    );
    // 2. 数据目录建出来了（游戏那边写不出来的话，一切都白搭）
    assert.ok(existsSync(join(root, 'Lua', 'coopani-pz')), 'Lua/coopani-pz 没建');

    const firstSetup = events.filter((e) => e.type === 'pz.setup').length;
    assert.equal(firstSetup, 1, '第一次没数据时该提醒一次');

    // 3. 游戏写出数据 → 危险档位跨上去该开口
    writeFileSync(join(root, 'Lua', 'coopani-pz-state.txt'), state(), 'utf8');
    await world.tick();

    const danger = events.find((e) => e.type === 'pz.danger');
    assert.ok(danger, '8 只僵尸该报一条 pz.danger');
    assert.match(danger.text, /8 只/);
    assert.match(danger.text, /<[a-z]+>/, '要带可直接照抄的标记');

    // 4. 同一档位再 tick 一次不该重复报
    const before = events.length;
    await world.tick();
    assert.equal(events.length, before, '同一档位重复 tick 不该再推');

    // 5. 死了要有交代
    writeFileSync(
      join(root, 'Lua', 'coopani-pz-state.txt'),
      state({ seq: 2, events: [{ n: 900, t: 'death', a: {} }] }),
      'utf8',
    );
    await world.tick();
    const death = events.find((e) => e.type === 'pz.death');
    assert.ok(death, '死了该开口');
    assert.match(death.text, /sad/);

    await world.stop();
    assert.ok(logs.some(([, m]) => m.includes('僵毁陪玩已启动')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('数据通道断了要说出来，不许拿旧数字当现在', async () => {
  const root = makeRoot();
  const dir = mkdtempSync(join(tmpdir(), 'pzdata-'));
  try {
    const { host } = fakeHost();
    const c = clock();
    const world = new PzWorld({
      cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: root, autoInstallMod: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: c.now,
    });
    await world.start(host);
    c.advance(10_000);

    // 五分钟前写的
    writeFileSync(
      join(root, 'Lua', 'coopani-pz-state.txt'),
      state({ ts: Math.floor(NOW.getTime() / 1000) - 300 }),
      'utf8',
    );
    await world.tick();

    const snap = world.webUi().lamps ?? [];
    const gameLamp = snap.find((l) => l.label === '游戏');
    assert.ok(gameLamp, '该有「游戏」这盏灯');
    assert.equal(gameLamp.state, 'error', '停更了该是红的，不是灰的');

    await world.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设置页的键真的接到了 cfg 上（改了口吻，提示词跟着变）', async () => {
  const root = makeRoot();
  const dir = mkdtempSync(join(tmpdir(), 'pzdata-'));
  try {
    const { host } = fakeHost();
    const cfg = { ...PZ_DEFAULTS(), enabled: true, zomboidDir: root, autoInstallMod: false };
    const c = clock();
    const world = new PzWorld({ cfg, dataDir: dir, botName: '大肥鱼', now: c.now });
    await world.start(host);

    const before = world.envPromptVars()['pz.persona'];
    // ctx.cfg 是活引用：热改就该立刻反映
    cfg.persona = 'jumpy';
    const after = world.envPromptVars()['pz.persona'];
    assert.notEqual(before, after, '改了口吻提示词没变 —— 配置没接线');
    assert.match(after, /慌/);

    await world.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
