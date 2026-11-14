import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSituation } from '../src/perception.ts';
import { adviceOf, describeSkills, guideOf } from '../src/guide.ts';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

/** 造一份处境：默认是「第 1 天中午、在外面、空手、什么都没带」的新角色。 */
function sit({
  day = 1, hour = 12, night = false, indoors = false, room = null, weapon = null, gear,
} = {}) {
  return buildSituation({
    v: 1,
    seq: 1,
    ts: Math.floor(NOW / 1000),
    alive: true,
    kills: 0,
    session: 's',
    clock: { hour, minute: 0, day, night },
    player: {
      x: 0, y: 0, z: 0, outside: !indoors, room, building: null,
      health: 1, hunger: 0.1, thirst: 0.1, fatigue: 0.1, endurance: 1, stress: 0,
      visible: 0, infected: false, infection: 0, bodyHealth: 100,
      weapon, weaponCond: weapon ? 9 : null, weaponMax: weapon ? 10 : null, offhand: null,
    },
    gear: gear ?? { bandage: 0, food: 0, water: 0, light: 0 },
    events: [],
  }, { nowMs: NOW, staleSeconds: 25 });
}

test('空手开局，第一件事是找武器', () => {
  const g = guideOf(sit());
  assert.equal(g.next?.id, 'weapon');
  assert.equal(g.doneCount, 0);
  assert.ok(g.fresh, '第 1 天算新手期');
});

test('有武器之后接着让他装水', () => {
  const g = guideOf(sit({ weapon: '平底锅' }));
  assert.equal(g.next?.id, 'water');
  assert.equal(g.doneCount, 1);
});

test('天快黑了还在外面，落脚点插到最前面', () => {
  const g = guideOf(sit({ hour: 19, night: false }));
  assert.equal(g.next?.id, 'shelter', '这时候教他灌水是没眼力见');
});

test('已经在屋里，落脚点算完成，不会插队', () => {
  const g = guideOf(sit({ hour: 19, indoors: true, room: '厨房' }));
  assert.equal(g.next?.id, 'weapon');
  assert.equal(g.steps.find((s) => s.id === 'shelter')?.done, true);
});

test('六样齐了就没有下一步', () => {
  const g = guideOf(sit({
    indoors: true,
    room: '厨房',
    weapon: '棒球棍',
    gear: { bandage: 2, food: 3, water: 2, light: 1 },
  }));
  assert.equal(g.next, null);
  assert.equal(g.doneCount, 6);
});

test('过了头几天就不再算新手期', () => {
  assert.equal(guideOf(sit({ day: 6 })).fresh, false);
  assert.equal(guideOf(sit({ day: 3 })).fresh, true);
});

test('阶段建议按天数推进：先活命 → 练木工 → 靠自己', () => {
  assert.equal(adviceOf(sit({ day: 1 })).stage, 'first');
  assert.equal(adviceOf(sit({ day: 5 })).stage, 'settle');
  assert.equal(adviceOf(sit({ day: 20 })).stage, 'long');

  const settle = adviceOf(sit({ day: 5 })).items.join(' ');
  assert.match(settle, /木工/, '中期最要紧的是木工');
  assert.match(settle, /集雨桶/, '要说出练到 4 级是为了什么');
  assert.match(settle, /How to Use Generators/, '发电机杂志是个具体的卡点');

  const long = adviceOf(sit({ day: 20 })).items.join(' ');
  assert.match(long, /烧开/, '接的雨水要烧开');
});

test('读到技能等级就按真实等级说话，读不到就不编', () => {
  const mid = sit({ day: 5 });
  // 没有 skills 字段：只能说方向
  assert.match(adviceOf(mid).items[0], /练到 4 级/);
  assert.doesNotMatch(adviceOf(mid).items[0], /还差/);
});

test('木工 2 级 → 说清还差几级；4 级 → 说够了', () => {
  const base = sit({ day: 5 });
  const w2 = adviceOf({ ...base, skills: { woodwork: 2 } });
  assert.match(w2.items[0], /木工 2 级/);
  assert.match(w2.items[0], /还差 2 级/);

  const w4 = adviceOf({ ...base, skills: { woodwork: 4 } });
  assert.match(w4.items[0], /够了/);
  assert.doesNotMatch(w4.items[0], /还差/);
});

test('后期木工不到 4 级，先把集雨桶这件事点出来', () => {
  const late = sit({ day: 20 });
  assert.match(adviceOf({ ...late, skills: { woodwork: 2 } }).items[0], /做不了/);
  assert.match(adviceOf({ ...late, skills: { woodwork: 5 } }).items[0], /烧开/);
});

test('describeSkills 只列读到的，一个都没有就返回 null', () => {
  assert.equal(describeSkills(null), null);
  assert.equal(describeSkills({}), null);
  const line = describeSkills({ woodwork: 3, cooking: 1 });
  assert.match(line, /木工 3/);
  assert.match(line, /烹饪 1/);
});
