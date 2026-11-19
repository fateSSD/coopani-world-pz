import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { PzWorld, PZ_DESCRIBE } = await import('../src/world.ts');
const { PZ_DEFAULTS } = await import('../src/config.ts');
const { encodeCommand, validateCommand } = await import('../src/play.ts');
const { judge, initialJudgeState } = await import('../src/events.ts');

test('describe.json 与源码 PZ_DESCRIBE / tools() 单源完全同步且补齐 parameters、tags 与 events', async () => {
  const onDisk = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'pz-sync-'));
  try {
    const world = new PzWorld({
      cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'fake-zomboid'), autoInstallMod: false },
      dataDir: dir,
      botName: '大肥鱼',
    });
    const runtimeTools = world.tools();

    assert.deepEqual(onDisk, PZ_DESCRIBE);
    assert.deepEqual(
      onDisk.tools.map((t) => t.name).sort(),
      runtimeTools.map((t) => t.name).sort(),
    );
    for (const rt of runtimeTools) {
      const disk = onDisk.tools.find((t) => t.name === rt.name);
      assert.ok(disk, `describe.json 缺少 ${rt.name}`);
      assert.equal(disk.description, rt.description);
      assert.deepEqual(disk.parameters, rt.parameters);
      assert.deepEqual(disk.tags, [...rt.tags]);
    }
    const stateTool = onDisk.tools.find((t) => t.name === 'pz_state');
    assert.ok(stateTool?.tags.includes('snapshot'));

    // P7：关键快照事件全部带 snapshot 标签
    for (const evType of ['pz.session.start', 'pz.tv', 'pz.nudge', 'pz.handoff']) {
      const ev = onDisk.events.find((e) => e.type === evType);
      assert.ok(ev?.tags?.includes('snapshot'), `${evType} 缺少 snapshot 标签`);
    }

    // P10：pz_play schema 含 index 参数供 verb='pick' 使用，且通过 validate/encode
    const playTool = onDisk.tools.find((t) => t.name === 'pz_play');
    assert.ok(playTool?.parameters?.properties?.index, 'pz_play schema 必须包含 index 属性');
    assert.equal(playTool.parameters.properties.index.type, 'integer');
    assert.doesNotMatch(playTool.parameters.properties.id.description, /pick|menu index/);
    assert.equal(validateCommand({ verb: 'pick', index: 2 }), null);
    assert.match(encodeCommand(1, { verb: 'pick', index: 2 }, 10_000), /^1\|pick\|2\|/);

    // P12/P14/P15：hold/resume 参数、storage key 改为 pz-journal/pz-judge、vocab 去【平静】、ENV_PROMPT 口头撤权
    assert.equal(playTool.parameters.properties.hold?.type, 'boolean');
    assert.equal(playTool.parameters.properties.resume?.type, 'boolean');
    const storageKeys = world.webUi().storage?.map((s) => s.key).sort();
    assert.deepEqual(storageKeys, ['pz-journal', 'pz-judge']);
    const { readVocab, describeVocab } = await import('../src/vocab.ts');
    const vocabTxt = describeVocab(readVocab(null, dir));
    assert.doesNotMatch(vocabTxt, /【平静】|【/);
    assert.match(vocabTxt, /<\.\.\.>/);
    const tpl = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
    assert.match(tpl, /pet_say:\s*<worried>/);
    assert.match(tpl, /hold=true/);
    assert.match(tpl, /resume=true/);
    assert.match(tpl, /没反对/);
    const vars = world.envPromptVars();
    assert.match(vars['pz.marks'], /pet_say.*<worried>/);
    assert.doesNotMatch(vars['pz.marks'], /【】/);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const description of [
      pkg.description,
      pkg.cortico.locales.zh.description,
      pkg.cortico.locales.en.description,
    ]) {
      assert.match(description, /^Coopani 0\.2\.17\+ · /, '三处市场简介必须统一前置 Coopani 0.2.17+');
    }
    assert.match(pkg.description, /worlds\.pz\.allowPlay/);
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /worlds\.pz\.allowPlay/);
    const denyRes = await runtimeTools.find((t) => t.name === 'pz_play').handler({ verb: 'stop' });
    assert.doesNotMatch(denyRes.text, /去设置里把这一项打开/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describe.json 与 ENV_PROMPT.md 不含第三人称且前缀保持精简', () => {
  const descRaw = readFileSync(new URL('../describe.json', import.meta.url), 'utf8');
  assert.doesNotMatch(descRaw, /\b(she|her|hers)\b/i);
  assert.doesNotMatch(descRaw, /她/);

  const tpl = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.doesNotMatch(tpl, /她/);
  assert.ok([...tpl].length <= 2800, `ENV_PROMPT 超过 2800 字：${[...tpl].length}`);
});

test('Harness 原语（P1-P6）：沙箱隔离、pz.kill 即时投递、pz.nudge 延迟刷新与断供取消、onHandoffEnded 区分 ok 与 stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-harness-'));
  const pushed = [];
  const deferred = [];
  let clockMs = Date.parse('2026-11-19T06:00:00Z');
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'fake-zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    await world.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e, opts) => {
        const env = { ...e, cursor: pushed.length + 1, opts };
        pushed.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => {
        deferred.push({ spec, opts });
      },
      store: {},
      drainPendingEvents: async () => [],
    });

    pushed.length = 0;
    deferred.length = 0;
    world.lastPushedAt = 0;
    world.pushedInWindow = 0;
    world.sit = {
      ...world.sit,
      link: 'ok',
      inGame: true,
      session: 'sess-1',
      day: 3,
      clockText: '14:20',
      placeText: '罗斯伍德消防局',
      hp: 92,
      visible: 2,
    };

    // P2：一次性历史事件 pz.kill 与 pz.day.start 必须走即时 pushEvent，不进 pushDeferred
    await world.emit({
      type: 'pz.kill',
      key: 'pz.kill:1',
      trigger: 'debounce',
      urgent: false,
      text: '刚连杀 4 只僵尸。',
    });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].type, 'pz.kill');
    assert.equal(deferred.length, 0);

    // P2/P3/P6：使用真实 judge() 生成含旧时间/旧地点/旧血量的 pz.nudge 与 pz.tv，验证延迟重算彻底刷新正文（无新头旧身）且失效取消
    clockMs += 30_000;
    const oldSit = {
      ...world.sit,
      link: 'ok',
      inGame: true,
      session: 'sess-1',
      day: 3,
      hour: 12,
      minute: 10,
      clockText: '12:10',
      placeText: '罗斯伍德消防局',
      hp: 92,
      weapon: '棒球棍',
      weaponPct: 90,
      gear: { water: 0, bandages: 2, light: 1 },
    };
    world.sit = oldSit;
    const realTips = world.currentTips().filter((t) => t.includes('水'));
    assert.ok(realTips.length > 0, '未带水时 currentTips 应含带水提示');
    const jInit = judge(initialJudgeState(), oldSit, null, {
      chattiness: 'normal',
      nowMs: 100_000,
      localDay: '2026-11-19',
      tips: realTips,
      nudgeEveryMs: 60_000,
    });
    const jRes = judge(jInit.next, oldSit, null, {
      chattiness: 'normal',
      nowMs: 200_000,
      localDay: '2026-11-19',
      tips: realTips,
      nudgeEveryMs: 60_000,
    });
    const tvEv = jInit.out.find((e) => e.type === 'pz.tv');
    const nudgeEv = jRes.out.find((e) => e.type === 'pz.nudge');
    assert.ok(tvEv, '第 3 天 12:10 应触发 pz.tv');
    assert.ok(nudgeEv, '达到间隔应触发 pz.nudge');

    await world.emit(tvEv);
    clockMs += 30_000;
    await world.emit(nudgeEv);
    const tvDefer = deferred.find((d) => d.spec.type === 'pz.tv');
    const nudgeDefer = deferred.find((d) => d.spec.type === 'pz.nudge');
    assert.ok(tvDefer && nudgeDefer);
    assert.deepEqual(tvDefer.spec.tags, ['snapshot']);
    assert.deepEqual(nudgeDefer.spec.tags, ['snapshot']);

    // 推进局面到新时间/新地点/新血量，仍在同一档且无水：重算必须使用最新信息且绝不保留旧时刻/旧地点/旧血量
    world.sit = {
      ...world.sit,
      hour: 12,
      minute: 40,
      clockText: '12:40',
      placeText: '马格德劳超市',
      hp: 78,
      gear: { water: 0, bandages: 2, light: 1 },
    };
    const nudgeRendered = nudgeDefer.spec.render()?.text ?? '';
    assert.match(nudgeRendered, /12:40.*马格德劳超市.*血量 78%/);
    assert.doesNotMatch(nudgeRendered, /12:10|罗斯伍德消防局|92%/, 'P2: 不应出现新头旧身，旧时刻/旧地点/旧血量必须全部替换');

    const tvRendered = tvDefer.spec.render()?.text ?? '';
    assert.match(tvRendered, /12:40.*马格德劳超市/);
    assert.doesNotMatch(tvRendered, /12:10|罗斯伍德消防局/, 'P2: pz.tv 正文不能保留入队时旧时间地点');

    // 当已经带水（检查项已解决）时，pz.nudge 取消返回 null
    world.sit = { ...world.sit, gear: { water: 1, bandages: 2, light: 1 } };
    assert.equal(nudgeDefer.spec.render(), null, '问题解决后过时的 pz.nudge 应取消返回 null');

    // P6：当时间离开节目窗口（如第 3 天 15:00 无课）时，pz.tv 必须取消返回 null
    world.sit = { ...world.sit, hour: 15, minute: 0, clockText: '15:00' };
    assert.equal(tvDefer.spec.render(), null, '离开节目窗口后 pz.tv 应取消返回 null');

    world.sit = { ...world.sit, link: 'stale' };
    assert.equal(nudgeDefer.spec.render(), null, '连接变 stale 时未投递的 pz.nudge 应取消');

    // P4：onHandoffEnded 同步入队 pz.handoff，render() 严格区分 link === 'ok' 与 'stale'
    deferred.length = 0;
    world.onHandoffEnded();
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0].spec.type, 'pz.handoff');
    assert.equal(deferred[0].opts.trigger, 'piggyback');
    assert.deepEqual(deferred[0].spec.tags, ['snapshot']);
    assert.match(deferred[0].spec.render()?.text ?? '', /数据已停更/, 'stale 状态下不应把旧快照伪装成实时在玩');
    world.sit = { ...world.sit, link: 'ok', clockText: '16:00', hp: 85 };
    assert.match(deferred[0].spec.render()?.text ?? '', /交接恢复局内快照.*16:00.*血量 85%/);

    const ui = world.webUi();
    assert.ok(Array.isArray(ui.storage) && ui.storage.length === 2);
    for (const part of ui.storage) {
      assert.equal(typeof part.stat(), 'string');
    }
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 tick() / judge()（P6 & P13）：跨天 pz.day.start、pz.tv 取消不耗 tvDay/额度且 18:00 新窗重推、pz.nudge 与 urgent 取消全额退回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p13-'));
  const zomboidDir = join(dir, 'zomboid');
  const luaDir = join(zomboidDir, 'Lua');
  mkdirSync(luaDir, { recursive: true });
  mkdirSync(join(zomboidDir, 'mods'), { recursive: true });
  const stateFile = join(luaDir, 'coopani-pz-state.txt');

  let clockMs = Date.UTC(2026, 10, 19, 6, 0, 0);
  const writeRaw = (over = {}) => {
    const base = {
      v: 1,
      seq: 1,
      ts: Math.floor(clockMs / 1000),
      alive: true,
      kills: 0,
      session: 'real-s1',
      clock: { hour: 15, minute: 0, day: 2, night: false },
      player: {
        x: 10, y: 20, z: 0, outside: false, room: '客厅', building: '民居',
        health: 0.9, hunger: 0.1, thirst: 0.1, fatigue: 0.1, endurance: 0.9, stress: 0.1,
        visible: 0, infected: false, infection: 0, bodyHealth: 90,
        weapon: '棒球棍', weaponCond: 9, weaponMax: 10,
      },
      gear: { bandage: 2, food: 3, water: 0, light: 1 },
      events: [],
    };
    writeFileSync(stateFile, JSON.stringify({ ...base, ...over }), 'utf8');
  };

  writeRaw({ clock: { hour: 15, minute: 0, day: 2, night: false } });
  const pushed = [];
  const deferred = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir, autoInstallMod: false, nudgeMinutes: 1 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    await world.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e, opts) => {
        const env = { ...e, cursor: pushed.length + 1, opts };
        pushed.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => {
        deferred.push({ spec, opts });
      },
      store: {},
      drainPendingEvents: async () => [],
    });

    // P6：真实 judge() 跨到第 3 天，触发即时 pz.day.start；12:10 同时入队 pz.tv
    clockMs += 30_000;
    writeRaw({ seq: 2, clock: { hour: 12, minute: 10, day: 3, night: false } });
    await world.tick();
    assert.ok(pushed.some((e) => e.type === 'pz.day.start'), '真实 judge() 跨天应即时 push pz.day.start');
    const dayStartEnv = pushed.find((e) => e.type === 'pz.day.start');
    world.onEventsSettled([dayStartEnv], 'delivered');
    const deliveredPushedAt = world.lastPushedAt;

    // 先推进到可发 pz.tv 的窗口（25s 后且第 3 天 12:15）
    clockMs += 30_000;
    writeRaw({ seq: 3, clock: { hour: 12, minute: 15, day: 3, night: false } });
    await world.tick();
    const firstTvDefer = deferred.find((d) => d.spec.type === 'pz.tv');
    assert.ok(firstTvDefer, '第 3 天 12:15 应入队 pz.tv');
    assert.equal(world.judgeState.tvDay, 0, 'P13: pz.tv 尚未 delivered，tvDay 绝不能提前推进到 3');
    assert.equal(world.pushedInWindow, 1, 'P13: 入队占位不消费真实额度，仍只有已 delivered 的 pz.day.start 计 1');
    assert.equal(world.lastPushedAt, deliveredPushedAt, 'P13: 入队不得提前消费最小间隔时间戳');

    // 玩家离开 12:00 电视窗到 15:00 -> render() 返回 null 并取消
    clockMs += 5000;
    writeRaw({ seq: 4, clock: { hour: 15, minute: 0, day: 3, night: false } });
    await world.tick();
    assert.equal(firstTvDefer.spec.render(), null, '离开节目窗 render() 返回 null');
    world.onEventsSettled([{ ...firstTvDefer.spec, cursor: 99 }], 'discarded');
    assert.equal(world.judgeState.tvDay, 0, 'P13: 取消后 tvDay 保持 0');
    assert.equal(world.pushedInWindow, 1, 'P13: 取消后必须退回 pz.tv 占用的 1 个频控额度');

    // 第 3 天 18:00 下一档节目窗口 -> 同一天仍可再次触发 pz.tv 并最终 delivered 落盘
    deferred.length = 0;
    clockMs += 30_000;
    writeRaw({ seq: 5, clock: { hour: 18, minute: 10, day: 3, night: false } });
    await world.tick();
    const eveningTvDefer = deferred.find((d) => d.spec.type === 'pz.tv');
    assert.ok(eveningTvDefer, 'P13: 12:15 取消后同日 18:10 新节目窗口必须再次入队 pz.tv');
    const eveningText = eveningTvDefer.spec.render()?.text ?? '';
    assert.match(eveningText, /第 3 天 18:10/);
    world.onEventsSettled([{ ...eveningTvDefer.spec, cursor: 100 }], 'delivered');
    const savedJudge = JSON.parse(readFileSync(join(dir, 'pz-judge.json'), 'utf8'));
    assert.equal(savedJudge.tvDay, 3, 'delivered 后应将 tvDay=3 持久化落盘');

    // P13：pz.nudge 取消时不得推进 nudgeIndex / nudgeRecent，delivered 后才提交
    deferred.length = 0;
    clockMs += 70_000;
    writeRaw({ seq: 6, clock: { hour: 18, minute: 12, day: 3, night: false }, gear: { bandage: 2, food: 3, water: 0, light: 1 } });
    await world.tick();
    const nudgeDefer = deferred.find((d) => d.spec.type === 'pz.nudge');
    assert.ok(nudgeDefer, '超过 1 分钟应入队 pz.nudge');
    const idxBefore = world.judgeState.nudgeIndex;
    const recentBefore = [...world.judgeState.nudgeRecent];
    // 问题解决 -> 取消
    clockMs += 5000;
    writeRaw({ seq: 7, clock: { hour: 18, minute: 13, day: 3, night: false }, gear: { bandage: 2, food: 3, water: 1, light: 1 } });
    await world.tick();
    assert.equal(nudgeDefer.spec.render(), null);
    assert.equal(world.judgeState.nudgeIndex, idxBefore, 'P13: pz.nudge 取消后 nudgeIndex 不得推进');
    assert.deepEqual(world.judgeState.nudgeRecent, recentBefore, 'P13: pz.nudge 取消后 nudgeRecent 不得污染');

    // 突发事件 discarded 后不得留存 lastUrgentAt 抑制后续常规事件
    world.windowStart = clockMs;
    world.pushedInWindow = 0;
    world.lastPushedAt = 0;
    world.lastUrgentAt = 0;
    await world.emit({
      type: 'pz.danger',
      key: 'pz.danger:discard-test',
      trigger: 'flush',
      urgent: true,
      text: '尸潮告警测试',
    });
    const urgentEnv = pushed.find((e) => e.senderKey === 'pz.danger:discard-test');
    assert.ok(urgentEnv);
    world.onEventsSettled([urgentEnv], 'discarded');
    assert.equal(world.lastUrgentAt, 0, 'P13: 突发事件 discarded 后 lastUrgentAt 必须回滚');
    await world.emit({
      type: 'pz.kill',
      key: 'pz.kill:after-discard',
      trigger: 'debounce',
      urgent: false,
      text: '常规击杀播报',
    });
    assert.ok(pushed.some((e) => e.senderKey === 'pz.kill:after-discard'), 'lastUrgentAt 回滚后常规事件应立即发出不被 20s 静默误杀');

    // 多条并发 urgent：先 U1 再 U2，仅取消 U2 应回退到 U1 时刻；再取消 U1 应全回退到 0
    world.windowStart = clockMs;
    world.pushedInWindow = 0;
    world.lastPushedAt = 0;
    world.lastUrgentAt = 0;
    await world.emit({ type: 'pz.danger', key: 'pz.danger:u1', trigger: 'flush', urgent: true, text: '急警1' });
    clockMs += 5000;
    await world.emit({ type: 'pz.danger', key: 'pz.danger:u2', trigger: 'flush', urgent: true, text: '急警2' });
    const u1 = pushed.find((e) => e.senderKey === 'pz.danger:u1');
    const u2 = pushed.find((e) => e.senderKey === 'pz.danger:u2');
    assert.ok(u1 && u2);
    assert.equal(world.lastUrgentAt, 0, '两条 urgent 仅入队时不得提前消费 lastUrgentAt');
    world.onEventsSettled([u2], 'discarded');
    assert.equal(world.lastUrgentAt, 0, 'U2 discarded 不回写；U1 尚未 delivered 也不能贡献真实时间戳');
    world.onEventsSettled([u1], 'discarded');
    assert.equal(world.lastUrgentAt, 0, '两条全取消后 lastUrgentAt 保持 0');
    assert.equal([...world.pendingQuota.values()].filter((q) => q.urgent).length, 0, 'discarded 后两条 urgent 占位都要释放');
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P12 口头撤权硬门禁：hold=true 恰 1 次 stop，重新授权前拒动且 playPilot 沉默，resume=true 恢复且不脏 Lua 协议', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p12-'));
  const zomboidDir = join(dir, 'zomboid');
  const luaDir = join(zomboidDir, 'Lua');
  mkdirSync(luaDir, { recursive: true });
  mkdirSync(join(zomboidDir, 'mods'), { recursive: true });
  const stateFile = join(luaDir, 'coopani-pz-state.txt');
  const cmdFile = join(luaDir, 'coopani-pz-cmd.txt');

  let clockMs = Date.UTC(2026, 10, 19, 8, 0, 0);
  const writeOnlineState = (over = {}) => {
    writeFileSync(stateFile, JSON.stringify({
      v: 1,
      seq: 1,
      ts: Math.floor(clockMs / 1000),
      alive: true,
      busy: false,
      hands: false,
      kills: 0,
      session: 'p12-s1',
      clock: { hour: 8, minute: 0, day: 1, night: false },
      player: {
        x: 100, y: 200, z: 0, outside: false, room: '走廊', building: '安全屋',
        health: 0.8, hunger: 0.1, thirst: 0.1, fatigue: 0.1, endurance: 0.9, stress: 0.1,
        visible: 0, infected: false, infection: 0, bodyHealth: 20,
        weapon: '棒球棍', weaponCond: 9, weaponMax: 10,
      },
      gear: { bandage: 2, food: 3, water: 2, light: 1 },
      events: [],
      ...over,
    }), 'utf8');
  };

  writeOnlineState();
  const pushed = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir, autoInstallMod: false, allowPlay: true, playEverySec: 1 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    await world.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e, opts) => {
        const env = { ...e, cursor: pushed.length + 1, opts };
        pushed.push(env);
        return env;
      },
      pushDeferred: () => {},
      store: {},
      drainPendingEvents: async () => [],
    });

    const playTool = world.tools().find((t) => t.name === 'pz_play');
    const stateTool = world.tools().find((t) => t.name === 'pz_state');
    assert.ok(playTool && stateTool);

    // 1. 口头撤权：hold=true -> 仅写 1 次 stop
    const holdRes = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(holdRes.text, /口头撤权已锁定/);
    const linesAfterHold = readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(linesAfterHold.length, 1, 'hold=true 必须恰好写入 1 条 stop');
    assert.match(linesAfterHold[0], /^\d+\|stop\|/);

    // 2. 撤权期间后续所有动作（含 walk / 再次 stop / 再次 hold）一律拒绝不落盘
    const denyWalk = await playTool.handler({ verb: 'walk', x: 101, y: 202 });
    const denyStop = await playTool.handler({ verb: 'stop' });
    const denyHold2 = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(denyWalk.text, /口头暂停/);
    assert.match(denyStop.text, /口头暂停/);
    assert.match(denyHold2.text, /口头暂停/);
    assert.equal(readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean).length, 1, '暂停期绝不写第 2 条指令');

    // 3. 即使危血+空闲且推进时钟 tick()，playPilot 也完全沉默，pz_state 标明口头暂停中
    pushed.length = 0;
    clockMs += 10_000;
    writeOnlineState({ busy: true });
    await world.tick();
    assert.equal(pushed.filter((e) => e.type === 'pz.play').length, 0, 'hold 期间 playPilot 不得发 pz.play 或自动停');
    assert.equal(readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean).length, 1);
    const stText = (await stateTool.handler({})).text;
    assert.match(stText, /口头暂停中/);

    // 4. 明确重新授权后传 resume=true 恢复执行，且 cmdFile 协议线干净不含 hold/resume
    const resumeRes = await playTool.handler({ verb: 'walk', x: 105, y: 205, resume: true });
    assert.match(resumeRes.text, /已下达 seq=/);
    const linesAfterResume = readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(linesAfterResume.length, 2);
    assert.match(linesAfterResume[1], /^\d+\|walk\|105\|205\|/);
    assert.doesNotMatch(linesAfterResume[1], /hold|resume/);
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P16/P17/P18：撤权跨重建保持，stop 写失败可重复补试，recipes scan 与动作统一被闩锁拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p16-p18-'));
  const zomboidDir = join(dir, 'zomboid');
  const luaDir = join(zomboidDir, 'Lua');
  mkdirSync(luaDir, { recursive: true });
  mkdirSync(join(zomboidDir, 'mods'), { recursive: true });
  const stateFile = join(luaDir, 'coopani-pz-state.txt');
  const cmdFile = join(luaDir, 'coopani-pz-cmd.txt');
  let clockMs = Date.UTC(2026, 10, 19, 8, 0, 0);
  const writeOnlineState = () => {
    writeFileSync(stateFile, JSON.stringify({
      v: 1,
      seq: 1,
      ts: Math.floor(clockMs / 1000),
      alive: true,
      busy: false,
      hands: false,
      kills: 0,
      session: 'p16-s1',
      clock: { hour: 8, minute: 0, day: 1, night: false },
      player: {
        x: 100, y: 200, z: 0, outside: false, room: '走廊', building: '安全屋',
        health: 0.8, hunger: 0.1, thirst: 0.1, fatigue: 0.1, endurance: 0.9, stress: 0.1,
        visible: 0, infected: false, infection: 0, bodyHealth: 20,
        weapon: '棒球棍', weaponCond: 9, weaponMax: 10,
      },
      gear: { bandage: 2, food: 3, water: 2, light: 1 },
      events: [],
    }), 'utf8');
  };
  writeOnlineState();
  const host = {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => e,
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
  const options = {
    cfg: {
      ...PZ_DEFAULTS(), enabled: true, zomboidDir, autoInstallMod: false,
      allowPlay: true, playEverySec: 0, imeGuard: false, liftPetWhenGaming: false,
    },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  };
  let world = new PzWorld(options);
  let rebuilt = null;
  try {
    await world.start(host);
    const playTool = world.tools().find((t) => t.name === 'pz_play');
    const recipesTool = world.tools().find((t) => t.name === 'pz_recipes');

    // 用目录占据 cmdFile，制造真实 writeFileSync 失败；闩锁必须先落盘且不能假报交权。
    mkdirSync(cmdFile);
    const failedHold = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(failedHold.text, /写指令文件失败/);
    assert.match(failedHold.text, /stop 未成功写入/);
    assert.match(failedHold.text, /不能宣称已交出控制权/);
    assert.equal(world.playHeld, true);
    assert.equal(world.playStopWritten, false);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pz-play-held.json'), 'utf8')), { held: true });

    // 移除故障后重复 hold 必须真的补试，而不是被「已经 held」提前挡掉。
    rmSync(cmdFile, { recursive: true, force: true });
    const retriedHold = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(retriedHold.text, /stop 已写入桥接文件，尚待游戏执行/);
    assert.match(retriedHold.text, /不宣称游戏已经执行 stop 或控制权已经交还/);
    assert.equal(world.playStopWritten, true);
    const stopLines = readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(stopLines.length, 1);
    assert.match(stopLines[0], /^\d+\|stop\|/);

    // pz_recipes 虽不制作物品，但 scan 也是桥接写指令，必须在统一门禁处失败且不能等待扫描。
    const scanDenied = await recipesTool.handler({});
    assert.match(scanDenied.text, /口头暂停闩锁.*包括 scan/);
    assert.equal(readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean).length, 1);

    await world.stop();
    world = null;
    rebuilt = new PzWorld(options);
    assert.equal(rebuilt.playHeld, true, '重建实例必须从 pz-play-held.json 恢复闩锁');
    assert.equal(rebuilt.playStopWritten, false, '重建不能把上次写文件记成游戏已执行 stop');
    await rebuilt.start(host);
    const rebuiltPlay = rebuilt.tools().find((t) => t.name === 'pz_play');
    const deniedWalk = await rebuiltPlay.handler({ verb: 'walk', x: 101, y: 202 });
    assert.match(deniedWalk.text, /口头暂停/);
    assert.equal(readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean).length, 1);

    // 只有显式 resume 才解除；解除后动作恢复且持久文件同步为 false。
    const resumed = await rebuiltPlay.handler({ verb: 'walk', x: 105, y: 205, resume: true });
    assert.match(resumed.text, /已下达 seq=/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pz-play-held.json'), 'utf8')), { held: false });
    const afterResume = new PzWorld(options);
    assert.equal(afterResume.playHeld, false);
    const lines = readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines[1], /hold|resume/);
  } finally {
    if (world) await world.stop();
    if (rebuilt) await rebuilt.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P13：旧宿主无现代 deferred/settled 时 pushEvent 成功即降级 delivered，重复回执幂等且不永久占位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p13-fallback-'));
  let clockMs = Date.UTC(2026, 10, 19, 6, 0, 0);
  const pushed = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    world.host = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e, opts) => {
        const env = { ...e, cursor: pushed.length + 1, opts };
        pushed.push(env);
        return env;
      },
    };
    world.judgeState = { ...initialJudgeState(), armed: true, session: 'fallback-s1' };
    world.sit = {
      ...world.sit,
      link: 'ok', inGame: true, session: 'fallback-s1', day: 3,
      hour: 12, minute: 10, clockText: '12:10', placeText: '罗斯伍德消防局', hp: 90,
    };
    const makeTv = (key) => ({
      type: 'pz.tv', key, trigger: 'flush', urgent: false, text: '入队前的旧电视正文',
    });

    await world.emit(makeTv('fallback-tv-1'), { session: 'fallback-s1', tvDay: 3 });
    assert.equal(pushed.length, 1, '无 pushDeferred 的旧宿主应同步 render 后走 pushEvent');
    assert.match(pushed[0].text, /第 3 天 12:10/);
    assert.equal(typeof pushed[0].meta.pzAttempt, 'number');
    assert.equal(world.judgeState.tvDay, 3, '旧宿主明确降级为 pushEvent 成功即 delivered');
    assert.equal(world.pushedInWindow, 1);
    assert.equal(world.lastPushedAt, clockMs);
    assert.equal(world.pendingQuota.size, 0, '降级交付后不得留下永久占位');
    assert.equal(world.inflightTv, null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pz-judge.json'), 'utf8')).tvDay, 3);

    world.onEventsSettled([pushed[0]], 'delivered');
    world.onEventsSettled([pushed[0]], 'discarded');
    assert.equal(world.pushedInWindow, 1, '重复或矛盾迟到回执不得重复计额或回滚已交付账');
    assert.equal(world.judgeState.tvDay, 3);

    clockMs += 40_000;
    world.sit = { ...world.sit, hour: 12, minute: 40, clockText: '12:40' };
    await world.emit(makeTv('fallback-tv-2'), { session: 'fallback-s1', tvDay: 3 });
    assert.equal(pushed.length, 2);
    assert.notEqual(pushed[1].meta.pzAttempt, pushed[0].meta.pzAttempt, '每次入队都必须分配新 attempt');
    assert.equal(world.pushedInWindow, 2);
    assert.equal(world.lastPushedAt, clockMs);
    assert.equal(world.pendingQuota.size, 0);
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P19：clear pz-judge 先切断代次并清在途，旧 settled 与旧 commit 都不能写回 tvDay/nudge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p19-'));
  let clockMs = Date.UTC(2026, 10, 19, 6, 0, 0);
  const deferred = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    world.host = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => e,
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
    };
    world.judgeState = { ...initialJudgeState(), armed: true, session: 'clear-s1' };
    world.sit = {
      ...world.sit,
      link: 'ok', inGame: true, session: 'clear-s1', day: 3,
      hour: 12, minute: 10, clockText: '12:10', placeText: '安全屋', hp: 90,
    };
    await world.emit(
      { type: 'pz.tv', key: 'clear-tv', trigger: 'flush', urgent: false, text: '电视' },
      { session: 'clear-s1', tvDay: 3 },
    );
    clockMs += 30_000;
    world.sit = { ...world.sit, minute: 40, clockText: '12:40' };
    await world.emit(
      { type: 'pz.nudge', key: 'clear-nudge', trigger: 'flush', urgent: false, text: '旧提醒' },
      { session: 'clear-s1', nudge: { atMs: clockMs, index: 2, recent: ['旧提醒'] } },
    );
    const staleCommit = world.pendingDeferredCommits.get('clear-tv');
    const oldTvSpec = deferred.find((d) => d.spec.senderKey === 'clear-tv').spec;
    assert.ok(staleCommit);
    assert.equal(world.pendingDeferredCommits.size, 2);
    const generation = world.judgeGeneration;

    const judgePart = world.webUi().storage.find((s) => s.key === 'pz-judge');
    judgePart.clear();
    assert.equal(world.judgeGeneration, generation + 1, 'clear 必须先递增代次');
    assert.equal(world.pendingDeferredCommits.size, 0);
    assert.equal(world.pendingQuota.size, 0);
    assert.equal(world.inflightTv, null);
    assert.equal(world.inflightNudge, null);

    // 故意恢复成相同 session，排除 session  guard 的掩护，单独验证代次和 pending 清理。
    world.judgeState = { ...initialJudgeState(), armed: true, session: 'clear-s1' };
    world.applyJudgeCommit(staleCommit);
    world.onEventsSettled([{ senderKey: 'clear-tv' }, { senderKey: 'clear-nudge' }], 'delivered');
    assert.equal(world.judgeState.tvDay, 0, 'clear 前旧回执不得复活 tvDay');
    assert.equal(world.judgeState.nudgeIndex, 0, 'clear 前旧回执不得复活 nudgeIndex');
    assert.deepEqual(world.judgeState.nudgeRecent, []);
    assert.equal(world.judgeState.nudgeAtMs, 0);
    assert.equal(existsSync(join(dir, 'pz-judge.json')), false, '旧回执不得重新落盘 pz-judge.json');

    // 同 senderKey 在 clear 后重新入队时，旧 envelope 的代次仍不能提交新占位。
    world.sit = { ...world.sit, session: 'clear-s1' };
    await world.emit(
      { type: 'pz.tv', key: 'clear-tv', trigger: 'flush', urgent: false, text: 'clear 后的新电视提醒' },
      { session: 'clear-s1', tvDay: 3 },
    );
    const newTvSpec = deferred.filter((d) => d.spec.senderKey === 'clear-tv').at(-1).spec;
    world.onEventsSettled([oldTvSpec], 'delivered');
    assert.equal(world.judgeState.tvDay, 0, '同键旧 envelope 不得越过代次提交新占位');
    assert.ok(world.pendingDeferredCommits.has('clear-tv'));
    world.onEventsSettled([newTvSpec], 'delivered');
    assert.equal(world.judgeState.tvDay, 3, 'clear 后的新 envelope 仍可正常 delivered 提交');
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P20：0.2.21 render 后慢 onDelivery 不被两秒误清，长租约释放后迟到 delivered 按原 attempt 幂等补账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p20-'));
  let clockMs = Date.UTC(2026, 10, 19, 6, 0, 0);
  const deferred = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    world.host = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => e,
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
    };
    world.judgeState = { ...initialJudgeState(), armed: true, session: 'defer-s1' };
    world.sit = {
      ...world.sit,
      link: 'ok', inGame: true, session: 'defer-s1', day: 3,
      hour: 12, minute: 10, clockText: '12:10', placeText: '安全屋', hp: 90,
    };
    await world.emit(
      { type: 'pz.tv', key: 'defer-tv', trigger: 'flush', urgent: false, text: '电视' },
      { session: 'defer-s1', tvDay: 3 },
    );
    clockMs += 30_000;
    world.sit = { ...world.sit, minute: 40, clockText: '12:40' };
    await world.emit(
      { type: 'pz.nudge', key: 'defer-nudge', trigger: 'flush', urgent: false, text: '正常排队提醒' },
      { session: 'defer-s1', nudge: { atMs: clockMs, index: 1, recent: ['正常排队提醒'] } },
    );
    const tvDefer = deferred.find((d) => d.spec.senderKey === 'defer-tv');
    const nudgeDefer = deferred.find((d) => d.spec.senderKey === 'defer-nudge');
    assert.ok(tvDefer && nudgeDefer);

    clockMs += 10_000;
    world.recoverRenderedDeferred(clockMs);
    assert.equal(world.pendingQuota.size, 2);
    assert.match(tvDefer.spec.render()?.text ?? '', /第 3 天 12:40/);
    clockMs += 2000;
    world.recoverRenderedDeferred(clockMs);
    assert.ok(world.pendingQuota.has('defer-tv'), 'render 后等待 onDelivery 两秒仍是正常慢投递');
    assert.equal(world.judgeState.tvDay, 0);

    world.onEventsSettled([{ ...nudgeDefer.spec, cursor: 100 }], 'discarded');
    assert.equal(world.pendingQuota.has('defer-nudge'), false);
    clockMs += 15 * 60_000 - 2001;
    world.recoverRenderedDeferred(clockMs);
    assert.ok(world.pendingQuota.has('defer-tv'), '渲染后长租约尚未到期');
    clockMs += 1;
    world.recoverRenderedDeferred(clockMs);
    assert.equal(world.pendingQuota.has('defer-tv'), false, '宿主彻底失联时由有界渲染租约释放闩锁');
    assert.equal(world.inflightTv, null);
    assert.equal(world.judgeState.tvDay, 0, '租约释放本身不是 delivered');
    assert.equal(world.attemptTombstones.get(tvDefer.spec.meta.pzAttempt).outcome, 'released');

    world.onEventsSettled([{ ...tvDefer.spec, cursor: 101 }], 'delivered');
    assert.equal(world.judgeState.tvDay, 3, '迟到 delivered 必须补记原 attempt，避免已投递却不提交而反复提醒');
    assert.equal(world.pushedInWindow, 1);
    assert.equal(world.pendingQuota.size, 0);
    world.onEventsSettled([{ ...tvDefer.spec, cursor: 101 }], 'delivered');
    world.onEventsSettled([{ ...tvDefer.spec, cursor: 101 }], 'discarded');
    assert.equal(world.pushedInWindow, 1, '重复及矛盾回执都不得二次结算');
    assert.equal(world.judgeState.tvDay, 3);
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withDeferredHarness(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const clock = { ms: Date.UTC(2026, 10, 19, 6, 0, 0) };
  const deferred = [];
  const pushed = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clock.ms),
  });
  world.host = {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e, opts) => {
      const env = { ...e, cursor: pushed.length + 1, opts };
      pushed.push(env);
      return env;
    },
    pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
  };
  world.judgeState = { ...initialJudgeState(), armed: true, session: `${prefix}-session` };
  world.sit = {
    ...world.sit,
    link: 'ok', inGame: true, session: `${prefix}-session`, day: 3,
    hour: 12, minute: 10, clockText: '12:10', placeText: '安全屋', hp: 90,
    gear: { water: 0, bandages: 2, light: 1 },
  };
  try {
    await run({ world, deferred, pushed, clock, dir });
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P21：现代宿主隐藏/静默 pushDeferred 的未 render 项有界释放，迟到 delivered 不丢账', async () => {
  await withDeferredHarness('pz-p21-', async ({ world, deferred, clock }) => {
    await world.emit(
      { type: 'pz.nudge', key: 'hidden-nudge', trigger: 'flush', urgent: false, text: '带水', nudgeMeta: { tip: '带水', before: [] } },
      { session: world.judgeState.session, nudge: { atMs: clock.ms, index: 1, recent: ['带水'] } },
    );
    const spec = deferred[0].spec;
    assert.equal(world.pendingQuota.get('hidden-nudge').renderedAt, null);
    clock.ms += 5 * 60_000 - 1;
    world.recoverRenderedDeferred(clock.ms);
    assert.ok(world.pendingQuota.has('hidden-nudge'));
    clock.ms += 1;
    world.recoverRenderedDeferred(clock.ms);
    assert.equal(world.pendingQuota.size, 0, '未 render 的静默项满排队租约必须释放');
    assert.equal(world.judgeState.nudgeIndex, 0);
    assert.equal(world.attemptTombstones.get(spec.meta.pzAttempt).outcome, 'released');

    world.onEventsSettled([{ ...spec, cursor: 201 }], 'delivered');
    assert.equal(world.judgeState.nudgeIndex, 1);
    assert.deepEqual(world.judgeState.nudgeRecent, ['带水']);
    assert.equal(world.pushedInWindow, 1);
    world.onEventsSettled([{ ...spec, cursor: 201 }], 'delivered');
    assert.equal(world.pushedInWindow, 1);
  });
});

test('P22：同 generation 同 senderKey 的 A/B 反序 delivered/discarded 不串 attempt，旧 nudge 快照不覆盖新快照', async () => {
  await withDeferredHarness('pz-p22-', async ({ world, deferred, clock }) => {
    const key = 'same-nudge';
    const emitNudge = async (index, label) => {
      await world.emit(
        { type: 'pz.nudge', key, trigger: 'flush', urgent: false, text: label, nudgeMeta: { tip: label, before: [] } },
        { session: world.judgeState.session, nudge: { atMs: clock.ms, index, recent: [label] } },
      );
      return deferred.at(-1).spec;
    };
    const a = await emitNudge(1, 'A');
    clock.ms += 30_000;
    const b = await emitNudge(2, 'B');
    assert.notEqual(a.meta.pzAttempt, b.meta.pzAttempt);
    assert.equal(world.attemptTombstones.get(a.meta.pzAttempt).outcome, 'released');

    // B 先交付，A 后交付：两条真实投递都可计额，但 A 不得结算或覆盖 B。
    world.onEventsSettled([{ ...b, cursor: 202 }], 'delivered');
    assert.equal(world.judgeState.nudgeIndex, 2);
    world.onEventsSettled([{ ...a, cursor: 201 }], 'delivered');
    assert.equal(world.judgeState.nudgeIndex, 2);
    assert.deepEqual(world.judgeState.nudgeRecent, ['B']);
    assert.equal(world.pushedInWindow, 2);
    assert.equal(world.pendingQuota.size, 0);

    // C 被同键 D 取代后，旧 C discarded 不得释放 D；随后迟到 delivered 也不能翻案。
    clock.ms += 181_000; // 进入新频控窗口，避免前两条的额度干扰 A/B 身份断言。
    const c = await emitNudge(3, 'C');
    clock.ms += 30_000;
    const d = await emitNudge(4, 'D');
    world.onEventsSettled([{ ...c, cursor: 203 }], 'discarded');
    assert.equal(world.pendingQuota.get(key).attempt, d.meta.pzAttempt);
    assert.equal(world.inflightNudge.attempt, d.meta.pzAttempt);
    world.onEventsSettled([{ ...d, cursor: 204 }], 'delivered');
    assert.equal(world.judgeState.nudgeIndex, 4);
    world.onEventsSettled([{ ...c, cursor: 203 }], 'delivered');
    assert.equal(world.judgeState.nudgeIndex, 4);
    assert.equal(world.pushedInWindow, 1);
  });
});

test('P23：即时事件登记并核验 cursor，错误 cursor 与重复回执均不能结算', async () => {
  await withDeferredHarness('pz-p23-', async ({ world, pushed }) => {
    await world.emit({ type: 'pz.danger', key: 'cursor-danger', trigger: 'flush', urgent: true, text: '危险' });
    const env = pushed[0];
    const expectedUrgentAt = world.pendingQuota.get('cursor-danger').atMs;
    assert.equal(world.pendingQuota.get('cursor-danger').cursor, env.cursor);
    world.onEventsSettled([{ ...env, cursor: env.cursor + 100 }], 'delivered');
    assert.ok(world.pendingQuota.has('cursor-danger'), '错误 cursor 不得结算即时事件');
    assert.equal(world.lastUrgentAt, 0);
    world.onEventsSettled([env], 'delivered');
    assert.equal(world.pendingQuota.size, 0);
    assert.equal(world.lastUrgentAt, expectedUrgentAt);
    const urgentAt = world.lastUrgentAt;
    world.onEventsSettled([env], 'delivered');
    world.onEventsSettled([env], 'discarded');
    assert.equal(world.lastUrgentAt, urgentAt);
  });
});

test('P24：clear(pz-judge) unlink 故障全或无，成功与缺失文件路径语义明确', async () => {
  await withDeferredHarness('pz-p24-', async ({ world, deferred, dir }) => {
    await world.emit(
      { type: 'pz.tv', key: 'clear-atomic', trigger: 'flush', urgent: false, text: '电视' },
      { session: world.judgeState.session, tvDay: 3 },
    );
    const spec = deferred[0].spec;
    const part = world.webUi().storage.find((s) => s.key === 'pz-judge');
    const generation = world.judgeGeneration;
    const quotaBefore = JSON.stringify([...world.pendingQuota]);
    const commitsBefore = JSON.stringify([...world.pendingDeferredCommits]);
    const judgeBefore = JSON.stringify(world.judgeState);
    mkdirSync(world.judgeFile);
    assert.throws(() => part.clear(), /EISDIR|EPERM|permission/i);
    assert.equal(world.judgeGeneration, generation, 'unlink 失败不得先切代次');
    assert.equal(JSON.stringify([...world.pendingQuota]), quotaBefore);
    assert.equal(JSON.stringify([...world.pendingDeferredCommits]), commitsBefore);
    assert.equal(JSON.stringify(world.judgeState), judgeBefore);
    assert.equal(world.inflightTv.senderKey, 'clear-atomic');

    rmSync(world.judgeFile, { recursive: true, force: true });
    writeFileSync(world.judgeFile, judgeBefore, 'utf8');
    assert.match(part.clear(), /已清除/);
    assert.equal(world.judgeGeneration, generation + 1);
    assert.equal(world.pendingQuota.size, 0);
    assert.equal(world.pendingDeferredCommits.size, 0);
    assert.equal(existsSync(join(dir, 'pz-judge.json')), false);
    world.onEventsSettled([{ ...spec, cursor: 301 }], 'delivered');
    assert.equal(world.judgeState.tvDay, 0);
    assert.doesNotThrow(() => part.clear(), '文件本就不存在也应按明确的全量重置成功处理');
    assert.equal(world.judgeGeneration, generation + 2);
  });
});

async function withPlayHarness(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const zomboidDir = join(dir, 'zomboid');
  const luaDir = join(zomboidDir, 'Lua');
  mkdirSync(luaDir, { recursive: true });
  mkdirSync(join(zomboidDir, 'mods'), { recursive: true });
  const stateFile = join(luaDir, 'coopani-pz-state.txt');
  const cmdFile = join(luaDir, 'coopani-pz-cmd.txt');
  const clock = { ms: Date.UTC(2026, 10, 19, 8, 0, 0) };
  const writeOnlineState = () => {
    writeFileSync(stateFile, JSON.stringify({
      v: 1, seq: 1, ts: Math.floor(clock.ms / 1000), alive: true, busy: false, hands: false,
      kills: 0, session: `${prefix}-session`,
      clock: { hour: 8, minute: 0, day: 1, night: false },
      player: {
        x: 100, y: 200, z: 0, outside: false, room: '走廊', building: '安全屋',
        health: 0.8, hunger: 0.1, thirst: 0.1, fatigue: 0.1, endurance: 0.9, stress: 0.1,
        visible: 0, infected: false, infection: 0, bodyHealth: 20,
        weapon: '棒球棍', weaponCond: 9, weaponMax: 10,
      },
      gear: { bandage: 2, food: 3, water: 2, light: 1 }, events: [],
    }), 'utf8');
  };
  writeOnlineState();
  const options = {
    cfg: {
      ...PZ_DEFAULTS(), enabled: true, zomboidDir, autoInstallMod: false,
      allowPlay: true, playEverySec: 0, imeGuard: false, liftPetWhenGaming: false,
    },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clock.ms),
  };
  const world = new PzWorld(options);
  const host = {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, cursor: 1 }),
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
  try {
    await world.start(host);
    const playTool = world.tools().find((t) => t.name === 'pz_play');
    await run({ world, playTool, options, clock, cmdFile, dir });
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P25：hold 原子双写可从单副本恢复并 dirty 补写，双写全败明确不保证重启仍锁定', async () => {
  await withPlayHarness('pz-p25-', async ({ world, playTool, options, dir }) => {
    mkdirSync(world.playHeldFile);
    const degraded = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(degraded.text, /至少已写入一份恢复记录/);
    assert.match(degraded.text, /dirty/);
    assert.deepEqual(JSON.parse(readFileSync(world.playHeldBackupFile, 'utf8')), { held: true });
    const recovered = new PzWorld(options);
    assert.equal(recovered.playHeld, true, '主文件不可读时仍须从恢复副本保持闩锁');

    rmSync(world.playHeldFile, { recursive: true, force: true });
    assert.equal(world.savePlayHeld(), 'clean');
    assert.deepEqual(JSON.parse(readFileSync(world.playHeldFile, 'utf8')), { held: true });
    assert.equal(world.playHeldDirty, false);

    // 极端：两份目标都不可写且之前没有任何有效记录，只能保证当前进程，文案必须承认重启边界。
    rmSync(world.playHeldFile, { force: true });
    rmSync(world.playHeldBackupFile, { force: true });
    world.playHeldFile = join(dir, 'missing', 'held.json');
    world.playHeldBackupFile = join(dir, 'missing', 'held.backup.json');
    world.playStopWritten = false;
    const failed = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(failed.text, /两份落盘均失败/);
    assert.match(failed.text, /重启后可能解锁/);
    assert.doesNotMatch(failed.text, /重启后的持久恢复.*已保证/);
    const withoutRecord = new PzWorld(options);
    assert.equal(withoutRecord.playHeld, false, '测试明确覆盖无有效副本时无法凭空保证重启闩锁');
  });
});

test('P26：重复 hold 按 stop 失败 ack / TTL 补写，成功 ack 与未过期窗口保持门禁且不重复写', async () => {
  await withPlayHarness('pz-p26-', async ({ world, playTool, clock, cmdFile }) => {
    const lines = () => readFileSync(cmdFile, 'utf8').trim().split('\n').filter(Boolean);
    await playTool.handler({ verb: 'stop', hold: true });
    assert.equal(lines().length, 1);
    const firstSeq = world.playStopSeq;
    await playTool.handler({ verb: 'stop', hold: true });
    assert.equal(lines().length, 1, '未过期且无新回执时不重复写');

    world.raw = { ...world.raw, cmd: { seq: firstSeq, verb: 'stop', ok: false, why: 'crash' } };
    await playTool.handler({ verb: 'stop', hold: true });
    assert.equal(lines().length, 2, '失败 ack 允许立即补写');
    assert.notEqual(world.playStopSeq, firstSeq);

    const secondSeq = world.playStopSeq;
    world.raw = { ...world.raw, cmd: null };
    clock.ms += 25_000;
    const renewed = await playTool.handler({ verb: 'stop', hold: true });
    assert.equal(lines().length, 3, '无成功 ack 且 TTL 到期必须补写新 stop');
    assert.notEqual(world.playStopSeq, secondSeq);
    assert.match(renewed.text, /尚待游戏执行/);
    await playTool.handler({ verb: 'stop', hold: true });
    assert.equal(lines().length, 3, '补写后的新 TTL 内仍不重复');

    world.raw = { ...world.raw, cmd: { seq: world.playStopSeq, verb: 'stop', ok: true, why: '' } };
    const acked = await playTool.handler({ verb: 'stop', hold: true });
    assert.match(acked.text, /游戏已回执 stop/);
    assert.equal(lines().length, 3, '成功 ack 后无需再补 stop');
    const denied = await playTool.handler({ verb: 'walk', x: 101, y: 202 });
    assert.match(denied.text, /口头暂停/);
    assert.equal(lines().length, 3, '补写与回执逻辑不得绕过拒动门禁');
  });
});

test('P27：旧宿主 pushEvent 不回 cursor 时也必须降级 delivered，不能永久占位或重复计额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pz-p27-'));
  let clockMs = Date.UTC(2026, 10, 19, 6, 0, 0);
  const pushed = [];
  const world = new PzWorld({
    cfg: { ...PZ_DEFAULTS(), enabled: true, zomboidDir: join(dir, 'zomboid'), autoInstallMod: false },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  try {
    // 旧宿主：只有 pushEvent，不回 cursor，也没有 pushDeferred / settled 流水线。
    world.host = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => {
        const saved = { ...e };
        pushed.push(saved);
        return saved;
      },
    };
    world.judgeState = { ...initialJudgeState(), armed: true, session: 'legacy-s1' };
    world.sit = {
      ...world.sit,
      link: 'ok', inGame: true, session: 'legacy-s1', day: 3,
      hour: 12, minute: 10, clockText: '12:10', placeText: '安全屋', hp: 90,
    };
    await world.emit(
      { type: 'pz.tv', key: 'legacy-tv', trigger: 'flush', urgent: false, text: '电视' },
      { session: 'legacy-s1', tvDay: 3 },
    );
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].cursor, undefined, '夹具必须模拟没有 cursor 的旧宿主');
    assert.equal(world.judgeState.tvDay, 3, '成功保存即视为 delivered，即使宿主不回 cursor');
    assert.equal(world.pushedInWindow, 1);
    assert.equal(world.pendingQuota.size, 0, '旧宿主降级不得留下永久占位');
    assert.equal(world.inflightTv, null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pz-judge.json'), 'utf8')).tvDay, 3);

    // 没有 settled 回执的旧宿主也不能让同一笔账被重复结算。
    world.onEventsSettled([pushed[0]], 'delivered');
    world.onEventsSettled([pushed[0]], 'discarded');
    assert.equal(world.pushedInWindow, 1);
    assert.equal(world.judgeState.tvDay, 3);

    clockMs += 40_000;
    world.sit = { ...world.sit, minute: 50, clockText: '12:50' };
    await world.emit(
      { type: 'pz.tv', key: 'legacy-tv-2', trigger: 'flush', urgent: false, text: '电视二' },
      { session: 'legacy-s1', tvDay: 3 },
    );
    assert.equal(pushed.length, 2);
    assert.equal(world.pushedInWindow, 2);
    assert.equal(world.pendingQuota.size, 0);
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
