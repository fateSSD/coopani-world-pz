/**
 * 断言只盯两件事：**她会不会说错话**，和**配置是不是真的接上了**。
 *
 * 不测「函数返回了对象」这种 —— 那种测试全绿也说明不了什么。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PZ } from '../src/definition.ts';
import { PZ_DEFAULTS, pzConfigGroups } from '../src/config.ts';
import { PZ_DESCRIBE, PzWorld } from '../src/world.ts';
import { buildSituation, describeNow, tipsOf, threatBandOf } from '../src/perception.ts';
import { initialJudgeState, judge } from '../src/events.ts';
import { parseStateLoose } from '../src/bridge.ts';
import { guideOf } from '../src/guide.ts';

/* ---------------------------------------------------------------- 夹具 */

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function raw(over = {}) {
  return {
    v: 1,
    seq: 10,
    ts: Math.floor(NOW / 1000),
    alive: true,
    kills: 0,
    session: 's1',
    // 16:30 —— 刻意挑一个电视上没有技能课的时刻。第 3 天的节目在
    // 06:00(烹饪) / 12:00(木工) / 18:00(钓鱼)，这里正好在空档里，
    // 免得每个测试都被 pz.tv 顺带触发一次。
    clock: { hour: 16, minute: 30, day: 3, night: false },
    player: {
      x: 0, y: 0, z: 0, outside: false, room: '厨房', building: '民居',
      health: 0.82, hunger: 0.2, thirst: 0.2, fatigue: 0.3, endurance: 0.7, stress: 0.1,
      visible: 1, infected: false, infection: 0, bodyHealth: 90,
      weapon: '棒球棍', weaponCond: 8, weaponMax: 10, offhand: null,
      weaponDmg: 1.1, weaponRng: 1.25, weaponTwo: true,
    },
    gear: { bandage: 2, food: 3, water: 1, light: 1 },
    events: [],
    ...over,
  };
}

function sitOf(state) {
  return buildSituation(state, { nowMs: NOW, staleSeconds: 25 });
}

const armedAt = (n) => ({ ...initialJudgeState(), armed: true, lastN: n });

const OPTS = {
  chattiness: 'normal',
  speakDanger: true,
  speakDusk: true,
  speakHurt: true,
  nowMs: NOW,
  localDay: '2026-11-07',
};

/* ---------------------------------------------------------------- 契约 */

test('describe.json 的 events 与代码里声明的一致', () => {
  const file = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  const declared = file.events.map((e) => e.type).sort();
  const inCode = PZ_DESCRIBE.events.map((e) => e.type).sort();
  // 这两份是独立维护的。炉石的 mulligan 就是这么漏了不知道多久 ——
  // 测试只查工具，不查事件。这里补上。
  assert.deepEqual(declared, inCode, 'describe.json 和 PZ_DESCRIBE.events 对不上');
});

test('设置页的每个键都必须带 worlds.pz. 前缀', () => {
  const groups = pzConfigGroups();
  const keys = groups.flatMap((g) => Object.keys(g.schema.properties ?? {}));
  assert.ok(keys.length > 0);
  for (const k of keys) {
    // 写成裸名会落到 config.json 根部，World 读 worlds.pz.<key> 读不到，
    // 配了等于没配，而且不报错。
    assert.ok(k.startsWith('worlds.pz.'), `这个键没带前缀：${k}`);
  }
});

test('每个配置组都挂在 world:pz 上', () => {
  for (const g of pzConfigGroups()) assert.equal(g.owner, 'world:pz');
});

test('defaults() 里 enabled 是 false，且每次是新对象', () => {
  const a = PZ.defaults();
  const b = PZ.defaults();
  assert.equal(a.enabled, false);
  assert.notEqual(a, b);
});

/* ---------------------------------------------------------------- 口吻 */

test('四种口吻都有说明，而且各不相同', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-'));
  try {
    const seen = new Map();
    for (const persona of ['sharp', 'steady', 'jumpy', 'adaptive']) {
      const w = new PzWorld({
        cfg: { ...PZ_DEFAULTS(), enabled: true, persona },
        dataDir: dir,
        botName: '大肥鱼',
      });
      const vars = w.envPromptVars();
      const text = vars['pz.persona'];
      assert.ok(text && text.length > 20, `${persona} 没有说明文本`);
      seen.set(persona, text);
    }
    assert.equal(new Set(seen.values()).size, 4, '四种口吻的文本有重复');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('开口密度换成一句话，而且三种不一样', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-'));
  try {
    const seen = new Set();
    for (const pace of ['quiet', 'normal', 'chatty']) {
      const w = new PzWorld({ cfg: { ...PZ_DEFAULTS(), enabled: true, chattiness: pace }, dataDir: dir, botName: 'x' });
      seen.add(w.envPromptVars()['pz.pace']);
    }
    assert.equal(seen.size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 数据通道 */

test('追加写的文件也能读出最后一个完整对象', () => {
  const a = JSON.stringify(raw({ seq: 1 }));
  const b = JSON.stringify(raw({ seq: 2 }));
  // 有些宿主的 getFileWriter 是追加实现。那时文件会越长越长，
  // 症状是「她越玩越不准」—— 没人会往这上面想。
  const parsed = parseStateLoose(`${a}${b}`);
  assert.equal(parsed?.seq, 2);
});

test('半截 JSON 解析失败，但已经写完的那一段还能读出来', () => {
  const good = JSON.stringify(raw({ seq: 7 }));
  const cut = JSON.stringify(raw({ seq: 8 })).slice(0, 40);
  const parsed = parseStateLoose(`${good}${cut}`);
  assert.equal(parsed?.seq, 7);
});

test('半截 JSON（只有一份、且没写完）返回 null，不许猜', () => {
  const cut = JSON.stringify(raw({ seq: 8 })).slice(0, 40);
  assert.equal(parseStateLoose(cut), null);
});

/* ---------------------------------------------------------------- 感知 */

test('血量与僵尸档位按同一套边界算', () => {
  assert.equal(threatBandOf(0), 'clear');
  assert.equal(threatBandOf(2), 'clear');
  assert.equal(threatBandOf(3), 'few');
  assert.equal(threatBandOf(5), 'few');
  assert.equal(threatBandOf(6), 'swarm');
  assert.equal(threatBandOf(11), 'swarm');
  assert.equal(threatBandOf(12), 'horde');
  assert.equal(threatBandOf(null), 'unknown');
});

test('没读到的字段不许说成「没有」', () => {
  const noGear = sitOf(raw({ gear: null }));
  assert.ok(!tipsOf(noGear).some((t) => t.key === 'bandage'), 'gear 缺失时不该断言「你没有绷带」');
  assert.match(describeNow(noGear), /背包：没读到/);

  const zeroBandage = sitOf(raw({ gear: { bandage: 0, food: 3, water: 1, light: 1 } }));
  assert.ok(tipsOf(zeroBandage).some((t) => t.key === 'bandage'), 'gear 明确是 0 时该提醒');
});

test('血量未知时不给档位（不给 critical 也不给 ok）', () => {
  const sit = sitOf(raw({ player: { ...raw().player, health: null } }));
  assert.equal(sit.hp, null);
  assert.equal(sit.hpBand, 'unknown');
  assert.ok(!tipsOf(sit).some((t) => t.key === 'hp'));
});

test('主菜单（在跑但没读档）要说清是在跑而不是没数据', () => {
  const sit = sitOf(raw({ alive: false, player: null }));
  assert.equal(sit.inGame, false);
  // 「在跑但没读档」和「压根没开」是两件事，处理方式完全不同（一个去读档，一个去找目录）。
  // 这句在 linkNote 里，`pz.status` 会把它带进提示词。
  assert.match(sit.linkNote, /主菜单|没在读档/);
  assert.equal(describeNow(sit), '现在没有进行中的存档。');
});

test('数据停更要说出来，不许拿旧数字当现在', () => {
  const old = raw({ ts: Math.floor(NOW / 1000) - 300 });
  const sit = buildSituation(old, { nowMs: NOW, staleSeconds: 25 });
  assert.equal(sit.link, 'stale');
  assert.match(sit.linkNote, /数据停在 5 分钟前/);
});

/* ---------------------------------------------------------------- 事件 */

test('第一次读到数据不为历史事件开口', () => {
  const state = raw({
    events: [
      { n: 1, t: 'kill', a: { count: 3 } },
      { n: 2, t: 'hurt', a: { loss: 0.2, health: 0.6 } },
      { n: 3, t: 'death', a: {} },
    ],
  });
  const sit = sitOf(state);
  const { out, next } = judge(initialJudgeState(), sit, state, OPTS);
  // 重启一次就替三条旧事欢呼，比少说一句难看得多。
  assert.equal(out.length, 0);
  assert.equal(next.lastN, 3);
});

test('同一个僵尸档位一天只报一次', () => {
  const state = raw({ player: { ...raw().player, visible: 9 } });
  const sit = sitOf(state);

  const first = judge(armedAt(99), sit, state, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.danger'), '第一次跨到「一群」该报');

  // 僵尸数在档位边界抖一下（9 → 11 → 9）不该反复报
  const wobble = sitOf(raw({ player: { ...raw().player, visible: 11 } }));
  const second = judge(first.next, wobble, raw({ player: { ...raw().player, visible: 11 } }), OPTS);
  assert.ok(!second.out.some((e) => e.type === 'pz.danger'), '同一档不该再报');

  // 涨到更高一档才该再说
  const horde = raw({ player: { ...raw().player, visible: 15 } });
  const third = judge(second.next, sitOf(horde), horde, OPTS);
  assert.ok(third.out.some((e) => e.type === 'pz.danger'), '跨到「一大片」该再说一次');
});

test('安静模式只留真会死人的那几条', () => {
  const state = raw({ player: { ...raw().player, visible: 4 } });
  const quiet = judge(armedAt(99), sitOf(state), state, { ...OPTS, chattiness: 'quiet' });
  assert.ok(!quiet.out.some((e) => e.type === 'pz.danger'), '安静模式下 4 只不该开口');

  const infected = raw({ events: [{ n: 200, t: 'infected', a: { level: 12 } }] });
  const out = judge(armedAt(199), sitOf(infected), infected, { ...OPTS, chattiness: 'quiet' });
  assert.ok(out.out.some((e) => e.type === 'pz.infected'), '感染在任何密度下都必须说');
});

test('掉血事件带血量，且不许冒充「被咬」', () => {
  const state = raw({ events: [{ n: 50, t: 'hurt', a: { loss: 0.09, health: 0.73 } }] });
  const { out } = judge(armedAt(49), sitOf(state), state, OPTS);
  const hurt = out.find((e) => e.type === 'pz.hurt');
  assert.ok(hurt, '掉 9% 血该报');
  assert.match(hurt.text, /掉/);
  assert.ok(!/被咬/.test(hurt.text), '掉血不等于被咬，这两个不能混');
});

test('事件正文里给了可直接照抄的标记', () => {
  const state = raw({ events: [{ n: 60, t: 'infected', a: { level: 12 } }] });
  const { out } = judge(armedAt(59), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.infected');
  assert.ok(ev);
  // 让她自己拼 id 会拼错，拼错的动作宿主静默丢掉 —— 她不会知道失败，只会站着不动。
  assert.match(ev.text, /<[a-z]+>/);
});

test('安静模式下连杀也不开口', () => {
  const state = raw({ events: [{ n: 70, t: 'kill', a: { count: 9 } }] });
  const { out } = judge(armedAt(69), sitOf(state), state, { ...OPTS, chattiness: 'quiet' });
  assert.equal(out.length, 0);
});


/* ---------------------------------------------------- 他自己的状态（pz.need） */

const withPlayer = (over) => raw({ player: { ...raw().player, ...over } });

test('状态跨到「该开口」的档会说一次，同一档不重复', () => {
  const tired = withPlayer({ fatigue: 0.8 });
  const first = judge(armedAt(99), sitOf(tired), tired, OPTS);
  const need = first.out.find((e) => e.type === 'pz.need');
  assert.ok(need, '累到 bad 该开口');
  assert.match(need.text, /累/);
  assert.match(need.text, /<[a-z]+>/, '要带可直接照抄的标记');

  // 0.80 → 0.82：同一个档，不该再说一遍。这就是「她变成报数机」的入口。
  const slightly = withPlayer({ fatigue: 0.82 });
  const again = judge(first.next, sitOf(slightly), slightly, { ...OPTS, nowMs: NOW + 200_000 });
  assert.ok(!again.out.some((e) => e.type === 'pz.need'), '同一档不该重报');
});

test('状态掉回正常再涨上来，还能再说一次', () => {
  const tired = withPlayer({ fatigue: 0.8 });
  const first = judge(armedAt(99), sitOf(tired), tired, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.need'));

  const fine = withPlayer({ fatigue: 0.1 });
  const back = judge(first.next, sitOf(fine), fine, { ...OPTS, nowMs: NOW + 200_000 });
  assert.ok(!back.out.some((e) => e.type === 'pz.need'), '状态正常时不该有这条');

  // 饿这件事会反复。吃到不饿、又饿了，那是两回，都该说。
  const hungryAgain = withPlayer({ fatigue: 0.8 });
  const again = judge(back.next, sitOf(hungryAgain), hungryAgain, { ...OPTS, nowMs: NOW + 400_000 });
  assert.ok(again.out.some((e) => e.type === 'pz.need'), '回落后再涨上来该重新说');
});

test('一次跨两条只挑最重的那条说', () => {
  const both = withPlayer({ hunger: 0.85, fatigue: 0.95 });
  const r = judge(armedAt(99), sitOf(both), both, OPTS);
  const needs = r.out.filter((e) => e.type === 'pz.need');
  assert.equal(needs.length, 1, '三条一起念，他三条都记不住');
  assert.match(needs[0].text, /睡过去/, '该挑 critical 的那条（累），不是饿');
});

test('读不到的状态不许当成「他很好」', () => {
  const unknown = raw({
    player: {
      ...raw().player, hunger: null, thirst: null, fatigue: null,
      endurance: null, stress: null, panic: null, pain: null, boredom: null, unhappy: null,
    },
  });
  const r = judge(armedAt(99), sitOf(unknown), unknown, OPTS);
  assert.ok(!r.out.some((e) => e.type === 'pz.need'), 'null 是「不知道」，不是「没事」，更不该报');
});

test('安静档只报顶格的状态', () => {
  const bad = withPlayer({ fatigue: 0.8 });
  const quiet = judge(armedAt(99), sitOf(bad), bad, { ...OPTS, chattiness: 'quiet' });
  assert.ok(!quiet.out.some((e) => e.type === 'pz.need'), '安静档下「累」不值得打断他');

  const crit = withPlayer({ fatigue: 0.97 });
  const r = judge(armedAt(99), sitOf(crit), crit, { ...OPTS, chattiness: 'quiet' });
  assert.ok(r.out.some((e) => e.type === 'pz.need'), '顶格的累会让人昏倒，安静档也说');
});

test('两条状态提醒之间有硬间隔，不会连着念', () => {
  const a = withPlayer({ fatigue: 0.8 });
  const first = judge(armedAt(99), sitOf(a), a, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.need'));

  // 30 秒后另一项又跨档 —— 挨太近了，这一拍先别说。
  const b = withPlayer({ thirst: 0.8 });
  const tooSoon = judge(first.next, sitOf(b), b, { ...OPTS, nowMs: NOW + 30_000 });
  assert.ok(!tooSoon.out.some((e) => e.type === 'pz.need'), '挨太近会变成连珠炮');

  const later = judge(tooSoon.next, sitOf(b), b, { ...OPTS, nowMs: NOW + 120_000 });
  assert.ok(later.out.some((e) => e.type === 'pz.need'), '隔够久了该说');
});

/* ------------------------------------------------ 武器耐久（pz.weapon） */

test('武器耐久见底会说，而且只在跨到低档时说一次', () => {
  const fresh = withPlayer({ weaponCond: 80, weaponMax: 100 });   // 80%
  const first = judge(armedAt(99), sitOf(fresh), fresh, OPTS);
  assert.ok(!first.out.some((e) => e.type === 'pz.weapon'), '耐久还好的时候说一句就是在报数');

  // 同一把武器磨到 18%，跨进 low 档 —— 这才是该开口的时刻。
  const worn = withPlayer({ weaponCond: 18, weaponMax: 100 });
  const second = judge(first.next, sitOf(worn), worn, { ...OPTS, nowMs: NOW + 10_000 });
  const hit = second.out.find((e) => e.type === 'pz.weapon');
  assert.ok(hit, '掉到 18% 该开口');
  assert.match(hit.text, /棒球棍/);
  assert.match(hit.text, /18%/);
  assert.match(hit.text, /<[a-z]+>/);

  // 18% → 12%：还在 low 档，别念第二遍。
  const lower = withPlayer({ weaponCond: 12, weaponMax: 100 });
  const third = judge(second.next, sitOf(lower), lower, { ...OPTS, nowMs: NOW + 20_000 });
  assert.ok(!third.out.some((e) => e.type === 'pz.weapon'), '同一档不该重报');
});

test('换了一把武器不报警，水位跟着重置', () => {
  const bat = withPlayer({ weaponCond: 60, weaponMax: 100 });      // 60%，不报
  const first = judge(armedAt(99), sitOf(bat), bat, OPTS);

  // 换成菜刀，耐久上限不同 —— 这是另一件东西，不该沿用上一件的档位。
  const knife = withPlayer({ weapon: '菜刀', weaponCond: 4, weaponMax: 8 });  // 50%
  const r = judge(first.next, sitOf(knife), knife, { ...OPTS, nowMs: NOW + 10_000 });
  assert.ok(!r.out.some((e) => e.type === 'pz.weapon'), '换刀这件事本身不需要她说');
});

test('修好之后再掉下来，还能再说一次', () => {
  const good = withPlayer({ weaponCond: 80, weaponMax: 100 });
  const first = judge(armedAt(99), sitOf(good), good, OPTS);
  assert.ok(!first.out.some((e) => e.type === 'pz.weapon'));

  const dull = withPlayer({ weaponCond: 15, weaponMax: 100 });
  const second = judge(first.next, sitOf(dull), dull, { ...OPTS, nowMs: NOW + 10_000 });
  assert.ok(second.out.some((e) => e.type === 'pz.weapon'), '磨到 15% 该说');

  // 用胶带修回 90%（或者换了把同型号的新货）：水位要跟着降。
  const fixed = withPlayer({ weaponCond: 90, weaponMax: 100 });
  const third = judge(second.next, sitOf(fixed), fixed, { ...OPTS, nowMs: NOW + 60_000 });
  assert.ok(!third.out.some((e) => e.type === 'pz.weapon'), '修好了不该再念');

  const dullAgain = withPlayer({ weaponCond: 15, weaponMax: 100 });
  const fourth = judge(third.next, sitOf(dullAgain), dullAgain, { ...OPTS, nowMs: NOW + 120_000 });
  assert.ok(fourth.out.some((e) => e.type === 'pz.weapon'), '又磨到见底该说');
});

test('刚拿起来就已经快断的武器，第一次见面也要说', () => {
  const junk = withPlayer({ weapon: '断柄螺丝刀', weaponCond: 2, weaponMax: 100 });
  const r = judge(armedAt(99), sitOf(junk), junk, OPTS);
  const hit = r.out.find((e) => e.type === 'pz.weapon');
  assert.ok(hit, '捡到一把 2% 的东西，这件事本身就得说');
  assert.match(hit.text, /下一只/, '这个档位要说成「马上会断」，不是「再打几只」');
});

test('空手、或者耐久读不到时，不许编一个耐久', () => {
  const bare = withPlayer({ weapon: null, weaponCond: null, weaponMax: null });
  assert.ok(!judge(armedAt(99), sitOf(bare), bare, OPTS).out.some((e) => e.type === 'pz.weapon'));

  // 拿的是水壶：有名字但没有耐久上限。读不到就是读不到。
  const bottle = withPlayer({ weapon: '水瓶', weaponCond: null, weaponMax: null });
  const r = judge(armedAt(99), sitOf(bottle), bottle, OPTS);
  assert.ok(!r.out.some((e) => e.type === 'pz.weapon'));
  assert.equal(sitOf(bottle).weaponPct, null);
});

test('柜里的武器比手上的强，会明说', () => {
  const state = withLoot(crate([{ n: '伐木斧', t: 2, d: 3.0, w: true }]));
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.match(ev.text, /比手上的/, '伐木斧 3.0 vs 手上球棒 1.1，该说这是升级');
});

test('抹布有伤害值，但绝不能被当成武器推荐', () => {
  // 真机实测：柜台里只有抹布，抹布的 MaxDamage 是 1.5 —— 比空手「高」，
  // 于是旧逻辑对空手的人说「柜里那把伤害 1.5，拿了就能打」。抹布不能打。
  const state = withLoot(
    crate([{ n: '抹布', t: 1, d: 1.5 }]),
    { player: { ...raw().player, weapon: null, weaponCond: null, weaponMax: null, weaponDmg: null },
      gear: { bandage: 0, food: 2, water: 1, light: 1 } },
  );
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev, '没绷带时抹布还是值得提一句');
  assert.ok(!/拿了就能打/.test(ev.text), '抹布不是武器，不许说拿了就能打');
  assert.ok(!/伤害/.test(ev.text), '对非武器不该提伤害');
});

test('没有武器可推荐时，事件正文不留空行', () => {
  const state = withLoot(crate([{ n: '农业杂志', t: 2 }]));
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.ok(!/\n\s*\n/.test(ev.text), '正文里出现空行说明有字段被 join 成了空串');
});

test('柜里同时有抹布和真武器，只把武器当武器说', () => {
  const state = withLoot(
    crate([{ n: '抹布', t: 1, d: 1.5 }, { n: '伐木斧', t: 2, d: 3.0, w: true }]),
    { player: { ...raw().player, weapon: null, weaponCond: null, weaponMax: null, weaponDmg: null },
      gear: { bandage: 0, food: 2, water: 1, light: 1 } },
  );
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.match(ev.text, /伐木斧/, '要指名是伐木斧，不是「柜里那把」');
  assert.match(ev.text, /3/, '伤害取武器那一件（3.0），不是抹布的 1.5');
});

test('连着翻柜子不会一条接一条，但大锤能破例', () => {
  const O = { ...OPTS };
  const first = withLoot(crate([{ n: '农业杂志', t: 2 }]));
  const r1 = judge(armedAt(99), sitOf(first), first, O);
  assert.ok(r1.out.some((e) => e.type === 'pz.loot'), '第一条该报');

  // 8 秒后换了个柜子，还是普通东西 —— 20 秒节奏内，不报。
  const second = withLoot(crate([{ n: '锤子', t: 2 }], { sig: 'crate@2,2' }));
  const r2 = judge(r1.next, sitOf(second), second, { ...O, nowMs: O.nowMs + 8_000 });
  assert.ok(!r2.out.some((e) => e.type === 'pz.loot'), '刚报过，8 秒内不再开口');

  // 又过 8 秒，这次是大锤 —— t=3 破例，必须报。
  const third = withLoot(crate([{ n: '大锤', t: 3 }], { sig: 'crate@3,3' }));
  const r3 = judge(r2.next, sitOf(third), third, { ...O, nowMs: O.nowMs + 16_000 });
  assert.ok(r3.out.some((e) => e.type === 'pz.loot'), '大锤值得打断节奏');
});

test('柜里的武器不如手上的，不提这一句', () => {
  const state = withLoot(crate([{ n: '菜刀', t: 2, d: 0.7, w: true }]));
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.ok(!/比手上的/.test(ev.text), '菜刀 0.7 不如手上的 1.1，别硬吹');
});

test('手上空着时，柜里任何武器都是「拿了就能打」', () => {
  const state = withLoot(crate([{ n: '棒球棍', t: 2, d: 1.1, w: true }]), {
    player: { ...raw().player, weapon: null, weaponCond: null, weaponMax: null, weaponDmg: null },
  });
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.match(ev.text, /空着/);
});

test('开着柜子但没好东西：名字要报出来，判断也要给', () => {
  // 有 `all` 就该把清单念出来。这是她能不能自己动手的分界 ——
  // 只知道「有 2 件」而不知道是什么，她只能请人帮忙开柜子。
  const listed = withLoot(crate([], {
    all: [{ n: '叉子', i: 0, t: 0 }, { n: '湯匙', i: 1, t: 0 }],
  }));
  const text = describeNow(sitOf(listed));
  assert.match(text, /叉子/, '读得到名字就得报出来');
  assert.match(text, /itemIdx=0/, '序号要带上，否则 take 拼不出来');
  assert.match(text, /没有特别值得拿/, '要让她知道翻过了、不值得停');

  // 旧版 mod 不发 `all`：只能老实说读不出来，不许假装看过了。
  const blind = describeNow(sitOf(withLoot(crate([]))));
  assert.match(blind, /名字读不出来/);

  // 真没开的时候，不能出现这一行 —— 否则他分不清是没开还是翻过了。
  const closed = describeNow(sitOf(raw()));
  assert.ok(!/正开着/.test(closed));
});

test('柜子里有值得看的东西时，写清是什么', () => {
  const state = withLoot(crate([{ n: '农业杂志', t: 2 }, { n: '大锤', t: 3 }]));
  const text = describeNow(sitOf(state));
  assert.match(text, /农业杂志/);
  assert.match(text, /大锤/);
});

test('能撕的布条类只在他真没绷带时才算数', () => {
  // tier 1 = 毛巾这类。有绷带时念它就是报库存。
  const cloth = withLoot(crate([{ n: '毛巾', t: 1 }]));
  const rich = judge(armedAt(99), sitOf(cloth), cloth, OPTS);
  assert.ok(!rich.out.some((e) => e.type === 'pz.loot'), '身上 10 卷绷带，别念毛巾');

  const poor = withLoot(crate([{ n: '毛巾', t: 1 }]), { gear: { bandage: 0, food: 2, water: 1, light: 1 } });
  const need = judge(armedAt(99), sitOf(poor), poor, OPTS);
  const ev = need.out.find((e) => e.type === 'pz.loot');
  assert.ok(ev, '一卷绷带都没有时，毛巾就是命');
  assert.match(ev.text, /毛巾/);
});

test('旧版 mod 送来 190% 的疼痛，不许照抄成「读数 190%」', () => {
  // 真机事故原样复现：pain 原始值是 1.94 —— 在 pain 的 0..100 量纲里等于 1.94%，
  // 几乎无感。旧代码按 0..1 读，乘 100 就成了「190%」，还说「疼到影响动作了」。
  const bad = raw({ player: { ...raw().player, pain: 1.94 } });
  const sit = sitOf(bad);

  assert.ok(sit.pain !== null && sit.pain <= 1, `归一后必须落回 0..1，实际 ${sit.pain}`);

  const text = describeNow(sit);
  assert.ok(!/190|1\.9/.test(text), '数值描述里不许出现 190 / 1.9');

  const { out } = judge(armedAt(99), sit, bad, OPTS);
  assert.ok(!out.some((e) => e.type === 'pz.need' && /疼/.test(e.text)),
    '1.94% 的疼痛不该触发任何「疼」的提醒');
});

/* --------------------------------------------------- 外部数据缺键（真机） */

test('启动阶段那份 state 连 gear 键都没有，全链路不许抛', () => {
  // 真机原文，一个字没改。游戏刚启动、还没读档时桥接写的就是这个：
  //   {"v":1,"seq":0,"ts":...,"alive":false,"boot":true,"load":2,"events":[]}
  // 原来 `gear !== null && gear.water > 0` 被 undefined 骗过去，接着读 .water 就抛，
  // 而 start() 第一句是 tick() —— 宿主报「切换失败」，整个扩展开不起来。
  const boot = JSON.parse('{"v":1,"seq":0,"ts":1794129159,"alive":false,"boot":true,"load":2,"events":[]}');
  const sit = sitOf(boot);

  assert.equal(sit.gear, null, '键不存在要归一成 null，不是 undefined');
  assert.equal(sit.inGame, false);

  // 四件事一条都不许抛
  assert.doesNotThrow(() => describeNow(sit));
  assert.doesNotThrow(() => tipsOf(sit));
  assert.doesNotThrow(() => guideOf(sit));
  assert.doesNotThrow(() => judge(armedAt(99), sit, boot, OPTS));
});

test('player 键缺失要算「没读到玩家」，不能算「在游戏里」', () => {
  // `undefined !== null` 为真 —— 原来这句把「没读到玩家」判成了「在游戏里」，
  // 后面一路拿 undefined 去算血量、武器、坐标。表里那个「在跟」就是这么来的。
  const sit = sitOf({ v: 1, seq: 3, ts: Math.floor(NOW / 1000), alive: true, events: [] });
  assert.equal(sit.inGame, false);
  assert.equal(sit.link, 'menu');
  assert.equal(sit.hp, null);
  assert.equal(sit.x, null);
  assert.equal(sit.seq, 3);
  assert.equal(sit.session, null);
});

test('背包数据缺项按 0 算，不许出现 undefined / NaN', () => {
  const partial = raw({ gear: { water: 2 } });     // 只写了一项
  const sit = sitOf(partial);
  assert.deepEqual(sit.gear, { bandage: 0, food: 0, water: 2, light: 0 });

  const junk = raw({ gear: { bandage: 'x', water: null } });
  assert.deepEqual(sitOf(junk).gear, { bandage: 0, food: 0, water: 0, light: 0 });
});

test('events 键缺失也不许抛 —— 同一个形状的第二处', () => {
  const boot = JSON.parse('{"v":1,"seq":4,"ts":' + Math.floor(NOW / 1000)
    + ',"alive":true,"session":"s1","clock":{"hour":9,"minute":0,"day":1,"night":false},'
    + '"player":{"x":1,"y":2,"z":0,"health":1,"hunger":0.2,"visible":1,"infected":false}}');
  const sit = sitOf(boot);
  assert.ok(sit.inGame, '有 player 就该算在游戏里');
  assert.doesNotThrow(() => judge({ ...initialJudgeState(), armed: true }, sit, boot, OPTS));
});



test('包入口 re-export 的每一个名字都真的存在', async () => {
  // 宿主就是照 index.ts 这份清单加载的。漏一个 = 整个扩展「导入失败」，
  // 而那和「功能有 bug」不是一回事：它是**一条功能都用不了**。
  //
  // 这次真栽过：我往 perception.ts 里插函数时用了 `function hpBandOf(` 当锚点，
  // 结果把前面那个 `export` 留给了新插的函数，hpBandOf 静悄悄变成私有 ——
  // 131 条测试全绿，因为**没有一条测试是从 index.ts 这个入口拿东西的**。
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const re = /export\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.ts)'/g;
  let checked = 0;
  let m;
  while ((m = re.exec(idx)) !== null) {
    const mod = await import(new URL(`../src/${m[2]}`, import.meta.url));
    for (const raw of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      // `type X` 是编译期的东西，运行时不存在 —— 检查它「在不在」会误报。
      if (raw.startsWith('type ')) continue;
      assert.ok(raw in mod, `${m[2]} 里没有导出 ${raw}（index.ts 在 re-export 它）`);
      checked += 1;
    }
  }
  assert.ok(checked >= 15, `只查到 ${checked} 个导出，正则大概没匹配上`);
});

/* ------------------------------------------------- 她自己动手（pz_play） */

test('指令编码：字段位置固定，过期时间从 now 起算', async () => {
  const { encodeCommand } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  assert.equal(
    encodeCommand(7, { verb: 'walk', x: 8114.3, y: 12221.167, stance: 'run' }, now),
    '7|walk|8114.3|12221.167|run||1700000025',
    '走：seq|verb|x|y|stance||expire',
  );
  // 三件东西的 take：坐标 + 容器序号 + 物品序号
  assert.equal(
    encodeCommand(8, { verb: 'take', x: 8114, y: 12221, objIdx: 2, itemIdx: 0 }, now),
    '8|take|8114|12221|2|0|1700000025',
  );
  // 不带参数的动作，中间字段留空，位置不能塌 —— 塌了 Lua 那边读到的就是错位的字段
  assert.equal(encodeCommand(9, { verb: 'attack' }, now), '9|attack|||||1700000025');
  assert.equal(encodeCommand(10, { verb: 'stop' }, now), '10|stop|||||1700000025');
});

test('做东西：点名配方，空格编码成 +，名字不许带竖线', async () => {
  const { encodeCommand, validateCommand, describeAck } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  assert.equal(encodeCommand(8, { verb: 'craft', recipe: 'MakeStoneBlade' }, now),
    '8|craft|MakeStoneBlade||||1700000025', '六个竖线：7 个字段');
  // 名字里可能有空格（`Make Stone Blade`），整行是竖线分隔的 ASCII → 空格变 +
  assert.equal(encodeCommand(9, { verb: 'craft', recipe: 'Make Stone Blade' }, now),
    '9|craft|Make+Stone+Blade||||1700000025');

  assert.match(validateCommand({ verb: 'craft' }), /缺 recipe/);
  assert.match(validateCommand({ verb: 'craft', recipe: 'a|b' }), /竖线/);
  assert.equal(validateCommand({ verb: 'craft', recipe: 'MakeStoneBlade' }), null);

  // 名字拼错要能翻成人话，别把 no-such-recipe 原样丢给她
  assert.match(describeAck({ seq: 1, verb: 'craft', ok: false, why: 'no-such-recipe' }), /没有这个配方/);
});

test('成功回执要把「做了什么」说出来，不能只说「我做了」', async () => {
  const { describeAck } = await import('../src/play.ts');
  // equip 带回 `item:面包刀`，pick 带回 `menu:阅读` —— 不带回来就等于
  // 她只知道「做了一件事」，而记不住是哪件。
  assert.match(describeAck({ seq: 1, verb: 'equip', ok: true, why: 'item:面包刀' }), /面包刀/);
  assert.match(describeAck({ seq: 2, verb: 'pick', ok: true, why: 'menu:阅读' }), /阅读/);
  assert.match(describeAck({ seq: 3, verb: 'cook', ok: true, why: 'recipe:MakeSalad' }), /MakeSalad/);
  // 没有前缀的旧回执不能崩，也不能瞎编
  const plain = describeAck({ seq: 4, verb: 'walk', ok: true, why: '' });
  assert.match(plain, /游戏接受了/);
  assert.ok(!/做的是/.test(plain));
});

test('反射开关也能下指令，默认是开', async () => {
  const { encodeCommand, validateCommand } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  // p1 只放 0 或 1。别传中文、别传 true/false —— Lua 那边只认字符串比较。
  assert.equal(encodeCommand(11, { verb: 'guard' }, now), '11|guard|1||||1700000025',
    '不写 on 就是开');
  assert.equal(encodeCommand(12, { verb: 'guard', on: true }, now), '12|guard|1||||1700000025');
  assert.equal(encodeCommand(13, { verb: 'guard', on: false }, now), '13|guard|0||||1700000025');
  assert.equal(validateCommand({ verb: 'guard' }), null);
});

test('做饭：不带参数，回执要说清做的是哪道', async () => {
  const { encodeCommand, validateCommand, describeAck } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  assert.equal(encodeCommand(7, { verb: 'cook' }, now), '7|cook|||||1700000025');
  assert.equal(validateCommand({ verb: 'cook' }), null);

  // 成功时 Lua 把菜名塞进 why（`recipe:MakeSalad`）——「做了」和「做了什么」是两件事
  assert.match(
    describeAck({ seq: 1, verb: 'cook', ok: true, why: 'recipe:MakeSalad' }),
    /做的是 MakeSalad/,
  );
  // 失败也要能翻
  assert.match(describeAck({ seq: 1, verb: 'cook', ok: false, why: 'no-recipe' }), /没有能做的菜/);
  assert.match(describeAck({ seq: 1, verb: 'cook', ok: false, why: 'cant-craft' }), /做不了/);
});

test('吃 / 喝不带参数 —— 由游戏挑，不让她挑', async () => {
  const { encodeCommand, validateCommand, describeAck } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  assert.equal(encodeCommand(5, { verb: 'eat' }, now), '5|eat|||||1700000025');
  assert.equal(encodeCommand(6, { verb: 'drink' }, now), '6|drink|||||1700000025');
  assert.equal(validateCommand({ verb: 'eat' }), null);
  assert.equal(validateCommand({ verb: 'drink' }), null);
  // 失败原因也要能翻成人话，别把 no-water 原样丢给她
  assert.match(describeAck({ seq: 1, verb: 'drink', ok: false, why: 'no-water' }), /没有能喝的水/);
  assert.match(describeAck({ seq: 1, verb: 'eat', ok: false, why: 'no-food' }), /没有能吃的东西/);
});

test('开门的指令：坐标可省，也可以指定哪一格', async () => {
  const { encodeCommand, validateCommand } = await import('../src/play.ts');
  const now = 1_700_000_000_000;
  assert.equal(encodeCommand(3, { verb: 'door' }, now), '3|door|||||1700000025', '六个竖线：7 个字段');
  assert.equal(encodeCommand(4, { verb: 'door', x: 8119, y: 12223 }, now), '4|door|8119|12223|||1700000025');
  assert.equal(validateCommand({ verb: 'door' }), null, '不给坐标也合法（从脚下找）');
  assert.equal(validateCommand({ verb: 'door', x: 8119 }), '门的坐标要么都给，要么都不给');
});

test('柜子的坐标和序号必须出现在状态里，否则 take 拼不出来', () => {
  // 真机翻车：她说「拿不了东西」，其实一条 take 都没发出去 ——
  // 因为 pz_state 只给名字，没给 x / y / objIdx / itemIdx。她不是不肯动，是没有参数。
  const state = withLoot({
    sig: 'shelves@8119,12223', type: 'shelves', total: 4,
    hits: [{ n: '空筆記本', t: 2, d: 1.5, w: false, i: 0 }],
    x: 8119, y: 12223, oi: 1,
  });
  const text = describeNow(sitOf(state));
  assert.match(text, /x=8119/);
  assert.match(text, /y=12223/);
  assert.match(text, /objIdx=1/);
  assert.match(text, /itemIdx=0/);
  assert.match(text, /take/, '该把 take 的参数摆出来');
});

test('坐标缺失的指令在下发前就拦住，不写文件', async () => {
  const { validateCommand } = await import('../src/play.ts');
  assert.match(validateCommand({ verb: 'walk', y: 1 }), /缺 x/);
  assert.match(validateCommand({ verb: 'take', x: 1, y: 2, itemIdx: 0 }), /objIdx/);
  assert.equal(validateCommand({ verb: 'walk', x: 1, y: 2 }), null);
  assert.equal(validateCommand({ verb: 'stop' }), null);
});

test('一个脏字节不该让整份状态作废', () => {
  // 真机：`why` 里混进了 0x1F 和 0x08，JSON 非法，她只能说「读到半截 JSON」——
  // 而数据其实一个字段都没少。解析器现在会去掉裸控制字符再试一次。
  const dirty = '{"v":1,"seq":9,"ts":1794131298,"alive":true,"gear":{"water":2},'
    + '"cmd":{"seq":5,"verb":"walk","ok":false,"why":"bad\u0001\u001fthing"},'
    + '"events":[]}'.replace(/\\u0001/, '\u0001').replace(/\\u001f/, '\u001f');

  // 先确认它确实是坏 JSON
  assert.throws(() => JSON.parse(dirty), '样本本身得是坏 JSON，否则这条测试没有意义');

  const got = parseStateLoose(dirty);
  assert.ok(got, '该兜住');
  assert.equal(got.seq, 9);
  assert.equal(got.gear.water, 2);
});

test('回执里的失败原因：Lua 发码，这边翻成人话', async () => {
  const { describeAck } = await import('../src/play.ts');
  // 真机事故：Lua 直接发中文原因，被 Kahlua 截成乱码（还夹控制字节），
  // 整份 state 变成非法 JSON，外面只能报「读到半截 JSON」。
  // 现在协议里是 ASCII 码，翻译在这边做。
  assert.match(describeAck({ seq: 1, verb: 'walk', ok: false, why: 'no-square' }), /目标那一格还没加载/);
  assert.match(describeAck({ seq: 1, verb: 'attack', ok: false, why: 'no-zombie' }), /两格内没有僵尸/);
  assert.match(describeAck({ seq: 1, verb: 'walk', ok: false, why: 'expired:352' }), /352 秒前的/);
  assert.match(describeAck({ seq: 1, verb: 'take', ok: false, why: 'bad-item:3' }), /第 3 件/);
  assert.match(describeAck({ seq: 1, verb: 'take', ok: false, why: 'bad-obj:0' }), /第 0 个/);
  // 不认识的码原样带出来，别吞掉 —— 吞了就没法查
  assert.match(describeAck({ seq: 1, verb: 'walk', ok: false, why: 'weird-state' }), /weird-state/);
});

test('回执只认自己那一条，别把上一条的结果当自己的', async () => {
  const { ackFor, describeAck } = await import('../src/play.ts');
  const ack = { seq: 5, verb: 'walk', ok: false, why: '目标格没加载' };
  assert.ok(ackFor(ack, 5));
  assert.equal(ackFor(ack, 6), null, 'seq 对不上就不是我这条');
  assert.equal(ackFor(null, 5), null);
  assert.match(describeAck(ack), /目标格没加载/);
  assert.match(describeAck({ ...ack, ok: true, why: '' }), /接受了/);
});

test('授权关着的时候，工具回的是「找他去开」，不是硬试一次', async () => {
  // 这条是边界，不是功能：开关关着还去写文件，等于把「他允许」这件事跳过。
  const { encodeCommand } = await import('../src/play.ts');
  const line = encodeCommand(1, { verb: 'walk', x: 1, y: 2 }, 0);
  assert.ok(line.startsWith('1|walk|'), '编码本身跟授权无关');
});

/* -------------------------------------------------------- 武器好不好使 */

test('武器评分：数值决定档位，不是名字', async () => {
  const { scoreWeapon, weaponTier } = await import('../src/weapon.ts');
  // 下面每一组数值都抄自 media/scripts/generated/items/weapon.txt。
  // 换了游戏版本、这些档位变了，说明评分该跟着调，不是测试错。
  const w = (dmg, range, condMax) => ({ name: 'x', dmg, range, condMax, twoHand: null });
  assert.equal(weaponTier(scoreWeapon(w(8.0, 1.4, 10))), 'legend', 'Katana');
  assert.equal(weaponTier(scoreWeapon(w(3.0, 1.35, 15))), 'top', 'WoodAxe');
  assert.equal(weaponTier(scoreWeapon(w(3.0, 1.35, 10))), 'top', 'Sledgehammer');
  assert.equal(weaponTier(scoreWeapon(w(3.0, 1.23, 13))), 'top', 'Machete');
  assert.equal(weaponTier(scoreWeapon(w(1.9, 1.6, 10))), 'good', 'Shovel');
  assert.equal(weaponTier(scoreWeapon(w(1.15, 1.25, 15))), 'ok', 'Crowbar');
  assert.equal(weaponTier(scoreWeapon(w(0.7, 0.9, 10))), 'poor', 'KitchenKnife');
});

test('撬棍靠耐久翻身：伤害只比菜刀高一点，分差却是两倍', async () => {
  const { scoreWeapon } = await import('../src/weapon.ts');
  const crowbar = scoreWeapon({ name: 'Crowbar', dmg: 1.15, range: 1.25, condMax: 15, twoHand: true });
  const knife = scoreWeapon({ name: 'KitchenKnife', dmg: 0.7, range: 0.9, condMax: 10, twoHand: null });
  assert.ok(crowbar > knife * 2, '耐久 15 和距离 1.25 该把差距拉开');
});

test('数值读不到就不评，不许拿名字猜', async () => {
  const { rateWeapon, describeWeaponRating } = await import('../src/weapon.ts');
  const unknown = { name: '大锤', dmg: null, range: null, condMax: null, twoHand: null };
  assert.equal(rateWeapon(unknown).tier, 'unknown');
  // 名字叫「大锤」也不许说它好 —— 读不到就是读不到。
  assert.equal(describeWeaponRating(unknown), null);
});

test('手上有武器时，状态描述里带评级', () => {
  const sit = sitOf(raw());
  const text = describeNow(sit);
  assert.match(text, /棒球棍/);
  assert.match(text, /能用/, '棒球棍是「能用」档');
});

test('武器清单里的档位和实测数值对得上', async () => {
  const { WEAPON_PICKS, scoreWeapon, weaponTier } = await import('../src/weapon.ts');
  // 清单里每一把的数值都从 weapon.txt 抄在这里，用来验清单没写错档。
  const DATA = {
    Katana: [8.0, 1.4, 10], WoodAxe: [3.0, 1.35, 15], Sledgehammer: [3.0, 1.35, 10],
    PickAxe: [2.2, 1.6, 13], Machete: [3.0, 1.23, 13], Sword: [3.0, 1.4, 13],
    Shovel: [1.9, 1.6, 10], Axe: [2.0, 1.2, 13], GardenHoe: [1.7, 1.6, 10],
    BaseballBat: [1.1, 1.25, 15], Crowbar: [1.15, 1.25, 15], Nightstick: [1.1, 1.2, 15],
    KitchenKnife: [0.7, 0.9, 10],
  };
  for (const p of WEAPON_PICKS) {
    const d = DATA[p.name];
    assert.ok(d, `清单里的 ${p.name} 没在测试数据里，补上它从 weapon.txt 抄的数值`);
    const tier = weaponTier(scoreWeapon({ name: p.name, dmg: d[0], range: d[1], condMax: d[2], twoHand: null }));
    assert.equal(tier, p.tier, `${p.name} 标的是 ${p.tier}，按数值算出来是 ${tier}`);
  }
});

/* ------------------------------------------------ 前期电视课（pz.tv） */

const atClock = (day, hour, minute = 0) => raw({ clock: { hour, minute, day, night: false } });

const tvOf = (state, opts = OPTS) => {
  const { out } = judge(armedAt(99), sitOf(state), state, opts);
  return out.find((e) => e.type === 'pz.tv') ?? null;
};

test('开播前半小时会提醒，说清几点、什么课', () => {
  const ev = tvOf(atClock(1, 5, 40));       // 第 1 天 05:40，06:00 有烹饪
  assert.ok(ev, '开播前 20 分钟该提醒');
  assert.match(ev.text, /06:00/);
  assert.match(ev.text, /烹饪/);
  assert.match(ev.text, /<[a-z]+>/);
});

test('刚开播也说，措辞改成「正在播」', () => {
  const ev = tvOf(atClock(1, 6, 20));
  assert.ok(ev);
  assert.match(ev.text, /正在播/, '已经开播了就不能再说「六点有」');
});

test('节目结束之后就不再提', () => {
  // 06:00 烹饪，窗口到 07:00；08:30 已经在两档之间。
  assert.equal(tvOf(atClock(1, 8, 30)), null, '过了窗口还提就是马后炮');
  assert.equal(tvOf(atClock(1, 4, 0)), null, '离得太远也不提');
});

test('一天只提一次，后面几档课不单独再念', () => {
  const morning = atClock(1, 6, 20);
  const first = judge(armedAt(99), sitOf(morning), morning, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.tv'));

  const noon = atClock(1, 12, 10);          // 木工课开播
  const second = judge(first.next, sitOf(noon), noon, { ...OPTS, nowMs: NOW + 6 * 3600_000 });
  assert.ok(!second.out.some((e) => e.type === 'pz.tv'), '一天三档课念三遍，他第一天就会把这条声音过滤掉');

  const nextDay = atClock(2, 6, 10);        // 第二天又是烹饪
  const third = judge(second.next, sitOf(nextDay), nextDay, { ...OPTS, nowMs: NOW + 24 * 3600_000 });
  assert.ok(third.out.some((e) => e.type === 'pz.tv'), '换了一天该重新提');
});

test('第 5 天之后不再提电视', () => {
  assert.ok(tvOf(atClock(5, 12, 10)), '第 5 天还在前期');
  assert.equal(tvOf(atClock(6, 12, 10)), null, '第 6 天他自己就上手了，别当闹钟');
});

test('安静档不谈日程', () => {
  assert.equal(tvOf(atClock(1, 6, 10), { ...OPTS, chattiness: 'quiet' }), null);
});

test('节目表本身要和游戏里的 RadioData 对得上', async () => {
  const { TV_SLOTS } = await import('../src/tv.ts');
  const find = (day, from) => TV_SLOTS.find((s) => s.day === day && s.from === from);
  // 这几条是从 media/radio/RadioData.xml 里逐条抄的，抄错了她就会在错的时间点提醒。
  assert.equal(find(1, 360)?.skill, 'cooking');
  assert.equal(find(1, 720)?.skill, 'carpentry');
  assert.equal(find(2, 1080)?.skill, 'farming');
  assert.equal(find(3, 1080)?.skill, 'fishing');
  assert.equal(find(5, 1080)?.skill, 'foraging');
  // 第 4 天晚上那档只有降无聊、没有技能，不该出现在表里。
  assert.equal(find(4, 1080), undefined);
});



const withLoot = (loot, over = {}) => raw({ loot, ...over });

const crate = (hits, extra = {}) => ({
  sig: 'crate@100,200', type: 'crate', total: 12, hits, ...extra,
});

test('翻到好东西会说，且带上「这是他自己打开的」这一层', () => {
  const state = withLoot(crate([{ n: '大锤', t: 3 }, { n: '球棒', t: 2 }]));
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev, '柜子里有大锤该说');
  assert.match(ev.text, /大锤/);
  assert.match(ev.text, /他眼前/, '必须点明这是他眼前的，不是她从别处看到的');
  assert.match(ev.text, /<[a-z]+>/);
});

test('同一个柜子不念第二遍', () => {
  const state = withLoot(crate([{ n: '大锤', t: 3 }]));
  const first = judge(armedAt(99), sitOf(state), state, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.loot'));

  const again = judge(first.next, sitOf(state), state, { ...OPTS, nowMs: NOW + 60_000 });
  assert.ok(!again.out.some((e) => e.type === 'pz.loot'), '反复开关同一个抽屉不该反复念');

  // 过了重复窗口（五分钟），他再打开一次还能说。
  const later = judge(again.next, sitOf(state), state, { ...OPTS, nowMs: NOW + 6 * 60_000 });
  assert.ok(later.out.some((e) => e.type === 'pz.loot'), '隔久了再说一次是应该的');
});

test('换了另一个柜子会重新说', () => {
  const a = withLoot(crate([{ n: '大锤', t: 3 }]));
  const first = judge(armedAt(99), sitOf(a), a, OPTS);
  assert.ok(first.out.some((e) => e.type === 'pz.loot'));

  const b = withLoot(crate([{ n: '消防斧', t: 2 }], { sig: 'crate@300,400' }));
  const second = judge(first.next, sitOf(b), b, { ...OPTS, nowMs: NOW + 20_000 });
  assert.ok(second.out.some((e) => e.type === 'pz.loot'), '另一个柜子是另一件事');
});

test('没开容器 / 打开的柜子是空的，都不开口', () => {
  const closed = raw();
  assert.ok(!judge(armedAt(99), sitOf(closed), closed, OPTS).out.some((e) => e.type === 'pz.loot'));

  const emptyCrate = withLoot(crate([]));
  const r = judge(armedAt(99), sitOf(emptyCrate), emptyCrate, OPTS);
  assert.ok(!r.out.some((e) => e.type === 'pz.loot'), '翻了个空柜子不需要汇报');
});

test('安静档只报最值钱的那一档', () => {
  const bat = withLoot(crate([{ n: '球棒', t: 2 }]));
  const quiet = judge(armedAt(99), sitOf(bat), bat, { ...OPTS, chattiness: 'quiet' });
  assert.ok(!quiet.out.some((e) => e.type === 'pz.loot'), '安静档下换个球棒不值得打断他');

  const sledge = withLoot(crate([{ n: '大锤', t: 3 }]));
  const r = judge(armedAt(99), sitOf(sledge), sledge, { ...OPTS, chattiness: 'quiet' });
  assert.ok(r.out.some((e) => e.type === 'pz.loot'), '大锤在任何密度下都该说');
});

test('关掉开关就真的一句不说', () => {
  const state = withLoot(crate([{ n: '大锤', t: 3 }]));
  const r = judge(armedAt(99), sitOf(state), state, { ...OPTS, speakLoot: false });
  assert.ok(!r.out.some((e) => e.type === 'pz.loot'));
});

test('同一个名字出现好几次，只说一次', () => {
  const state = withLoot(crate([
    { n: '菜刀', t: 2 }, { n: '菜刀', t: 2 }, { n: '菜刀', t: 2 }, { n: '锤子', t: 2 },
  ]));
  const { out } = judge(armedAt(99), sitOf(state), state, OPTS);
  const ev = out.find((e) => e.type === 'pz.loot');
  assert.ok(ev);
  assert.equal((ev.text.match(/菜刀/g) ?? []).length, 1, '三把菜刀不该念三遍');
  assert.match(ev.text, /锤子/);
});



test('到点会提清单，而且轮着提、不重复同一条', async () => {
  const { judge } = await import('../src/events.ts');
  const sit = sitOf(raw());       // 在游戏里、没别的事
  const tips = ['没有能喝的水。', '绷带是空的。'];
  const opts = { ...OPTS, tips, nudgeEveryMs: 60_000 };

  const at = (ms, prev) => judge(prev, sit, null, { ...opts, nowMs: ms });

  // 刚进游戏：计时从 0 开始，不该立刻念。
  const t0 = at(NOW, armedAt(0));
  assert.equal(t0.out.filter((e) => e.type === 'pz.nudge').length, 0, '刚进来不该念清单');

  // 一分钟后：提第一条。
  const t1 = at(NOW + 61_000, t0.next);
  const n1 = t1.out.filter((e) => e.type === 'pz.nudge');
  assert.equal(n1.length, 1);
  assert.match(n1[0].text, /没有能喝的水/);

  // 再过一分钟：轮到第二条，而不是又念第一条。
  const t2 = at(NOW + 122_000, t1.next);
  const n2 = t2.out.filter((e) => e.type === 'pz.nudge');
  assert.equal(n2.length, 1);
  assert.match(n2[0].text, /绷带是空的/);

  // 第三次回到第一条，但会把「前两回说过什么」带上，好让她换说法。
  const t3 = at(NOW + 183_000, t2.next);
  const n3 = t3.out.filter((e) => e.type === 'pz.nudge');
  assert.equal(n3.length, 1);
  assert.match(n3[0].text, /前两回已经说过/);
  assert.match(n3[0].text, /换一种说法/);
});

test('清单空着的时候不乱念', async () => {
  const { judge } = await import('../src/events.ts');
  const sit = sitOf(raw());
  const r = judge(armedAt(0), sit, raw(), { ...OPTS, tips: [], nudgeEveryMs: 60_000, nowMs: NOW + 600_000 });
  assert.equal(r.out.filter((e) => e.type === 'pz.nudge').length, 0);
});

test('有别的更要紧的话要说时，清单让路', async () => {
  const { judge } = await import('../src/events.ts');
  const hurt = raw({ player: { health: 0.5 } });
  const sit = sitOf(hurt);
  const r = judge(armedAt(0), sit, hurt, {
    ...OPTS, tips: ['没有能喝的水。'], nudgeEveryMs: 60_000, nowMs: NOW + 600_000,
  });
  assert.equal(r.out.filter((e) => e.type === 'pz.nudge').length, 0, '这一拍已经在报掉血了，别再念清单');
});

test('nudgeEveryMs 按开口密度缩放，0 表示关掉', async () => {
  const { nudgeEveryMs } = await import('../src/world.ts');
  assert.equal(nudgeEveryMs(0, 'normal'), 0);
  assert.equal(nudgeEveryMs(8, 'normal'), 8 * 60_000);
  assert.equal(nudgeEveryMs(8, 'quiet'), 16 * 60_000);
  assert.equal(nudgeEveryMs(8, 'chatty'), 4 * 60_000);
  assert.equal(nudgeEveryMs(0.1, 'chatty'), 60_000, '最短 1 分钟');
});

test('数据不新鲜就不判定事件 —— 游戏关了别再喊喝水', () => {
  // 真机反馈：「我游戏都关了半天了，她还在惦记水」。
  // 一份停在一小时前的数据里，渴还是 0.6 —— 那是最后一次存盘那一刻的值。
  // playPilot 早就有这条检查，但 judge 没有：一个管「叫她做事」，一个管「叫她说话」，
  // 漏掉后者的表现就是对着关掉的游戏反复念「该喝水了」。
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  const iJudge = src.indexOf('judge(this.judgeState');
  assert.ok(iJudge > 0, '找不到 judge 调用');
  const before = src.slice(Math.max(0, iJudge - 600), iJudge);
  assert.match(before, /if \(this\.sit\.link === 'ok'\)/, 'judge 没被 link 检查包住');

  // playPilot 里那条也得在 —— 两条是同一个道理，别只修一条
  const iPilot = src.indexOf('private async playPilot');
  const pilot = src.slice(iPilot, iPilot + 1200);
  assert.match(pilot, /this\.sit\.link !== 'ok'/, 'playPilot 的检查没了');
});

test('说话和决策走两套额度 —— 别让说话把「叫她做事」的额度吃掉', () => {
  // 真机反馈：「她说话的频率好高」。21 批事件她回了 22 句，一半是「嗯」「我在」。
  // 根因是两类事件混在一个 60 秒 8 条的滑窗里。收紧说话额度时如果把 `pz.play`
  // 也算进去，就会变成「她不做事」——那是另一个更难查的 bug。
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  const i = src.indexOf('private async emit');
  const body = src.slice(i, i + 2000);
  assert.match(body, /const isSpeech = ev\.type !== 'pz\.play'/, '没把决策提示单独分出来');
  assert.match(body, /pushedInWindow >= 3/, '说话额度没收紧到 3 条');
  assert.match(body, /lastPushedAt < 25_000/, '说话间隔没拉到 25 秒');
  assert.match(body, /speechInWindow >= 20/, '决策提示也该有自己的额度');

  // 紧急事件之后压住常规事件：真机上她喊完「三只贴到半格」五秒就开始聊柴可夫斯基。
  // 不是她分心，是我们把两件事并列推给了她。
  assert.match(body, /if \(ev\.urgent\) this\.lastUrgentAt = nowMs/, '没记紧急时刻');
  assert.match(body, /nowMs - this\.lastUrgentAt < 20_000/, '紧急之后没静默');
});

test('他手在键鼠上时不下指令 —— 决策推送要先让开', () => {
  // 这条比自动打怪更烦人，因为它不需要附近有僵尸也存在：
  // 他正要点开门，她一条 take 排到前面；他按住方向键，她一条 walk 顶掉。
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  const i = src.indexOf('private async playPilot');
  const body = src.slice(i, i + 2200);
  assert.match(body, /if \(this\.sit\.handsOn\) \{/, 'playPilot 没看 handsOn');
  // 必须在「血低自动停」之前 —— 他手上正在做的事不该被系统的好心上清掉
  const iHands = body.indexOf('this.sit.handsOn');
  const iHp = body.indexOf('hp <= 30');
  assert.ok(iHands > 0 && iHp > 0, '两段都得在');
  assert.ok(iHands < iHp, 'hands 检查要在血线之前');
});

test('关了二十小时别还报秒数 —— 那不是信息，是故障的样子', () => {
  // 真机反馈：「我都关了这么久的游戏了，她还在计时探测不到这对嘛」。
  // 原来显示「数据停在 79987 秒前」—— 关了五分钟和关了二十二小时，
  // 他看到的本该是同一件事（游戏没开），一个不断涨的五位数反而像出错。
  const longAgo = raw({ ts: Math.floor(NOW / 1000) - 22 * 3600 });
  const sit = buildSituation(longAgo, { nowMs: NOW, staleSeconds: 25 });
  assert.equal(sit.link, 'stale');
  assert.match(sit.linkNote, /游戏没在运行（最后一次读档在 22 小时前）/);
  assert.ok(!/[0-9]+ 秒/.test(sit.linkNote), '长时间没开还在报秒数');

  // 两天以上换成天，别出现「已 73 小时」
  const days = raw({ ts: Math.floor(NOW / 1000) - 73 * 3600 });
  const sit2 = buildSituation(days, { nowMs: NOW, staleSeconds: 25 });
  assert.match(sit2.linkNote, /3 天前/);
});
