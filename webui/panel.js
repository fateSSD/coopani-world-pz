/**
 * 僵毁陪玩 · 面板（手写，无构建步骤）。
 *
 * 契约：默认导出 `{ panels: { <id>: { mount(ctx) } } }`。`ctx.root` 是唯一挂载点，
 * `ctx.invoke(method, args)` 打到 `webUi().invoke`。
 *
 * 只有一件事要做：**让他一眼看出她现在看不看得见，以及看见了什么。**
 * 设置项不往这里放 —— 设置页已经有口吻和密度那两个下拉框了。
 */

const TEXT = {
  zh: {
    helpTitle: '扩展名旁边那三盏灯怎么看？',
    helpOn: '绿',
    helpOnDesc: '上一次是好的，正常。',
    helpOff: '灰',
    helpOffDesc: '没启用，不是坏了。不用管。',
    helpErr: '红',
    helpErrDesc: '能读到但不对，要去处理。原因和怎么办，鼠标停在灯上能看到。',
    helpWhich: '三盏灯分别是：游戏（连得上存档吗）、桥接（模组装好没有）、日记（写得进去吗）。',
    title: '她此刻',
    linkOk: '在跟',
    linkMenu: '游戏在跑，没读档',
    linkStale: '数据停了',
    linkNoRoot: '没找到游戏',
    linkNoData: '还没有数据',
    hp: '血',
    zombie: '僵尸',
    place: '位置',
    hand: '手上',
    bag: '背包',
    bandage: '绷带',
    food: '吃的',
    water: '水',
    light: '光源',
    tips: '该注意的',
    noTips: '按现在的状态，没有必须马上处理的事。',
    loot: '正开着',
    need: '状态',
    needOk: '都还行',
    needUnknown: '读不到',
    needName: {
      hunger: '饿', thirst: '渴', fatigue: '累', endurance: '体力',
      pain: '疼', panic: '惊恐', stress: '压力', unhappy: '心情', boredom: '无聊',
    },
    none: '空着',
    cond: (n) => `耐久 ${n}%`,
    infected: '已感染',
    clean: '没感染',
    unknown: '不知道',
    bridge: '桥接',
    root: '目录',
    journal: '日记',
    persona: '口吻',
    personaName: {
      sharp: '毒舌队友',
      steady: '稳当搭档',
      jumpy: '慌里慌张的学妹',
      adaptive: '按局面切换',
    },
    fail: '面板连不上服务端',
    qqGroup: 'QQ 群 284525159',
    emptyGame: '进游戏读档之后，这里会显示她看到的东西。',
    day: (n, clock) => `第 ${n} 天 ${clock}`,
  },
  en: {
    helpTitle: 'What do the three dots next to the extension name mean?',
    helpOn: 'Green',
    helpOnDesc: 'last time worked. Normal.',
    helpOff: 'Grey',
    helpOffDesc: 'not enabled — that is not a fault. Nothing to do.',
    helpErr: 'Red',
    helpErrDesc: 'readable but wrong. Hover the dot for the reason and the fix.',
    helpWhich: 'The three are: game (can it reach the save), bridge (is the mod installed), journal (can it write).',
    title: 'What she sees',
    linkOk: 'Following',
    linkMenu: 'Game running, no save',
    linkStale: 'Data stopped',
    linkNoRoot: 'Game not found',
    linkNoData: 'No data yet',
    hp: 'HP',
    zombie: 'Zeds',
    place: 'Place',
    hand: 'Hands',
    bag: 'Bag',
    bandage: 'bandage',
    food: 'food',
    water: 'water',
    light: 'light',
    tips: 'Watch out for',
    noTips: 'Nothing needs handling right now.',
    loot: 'Open',
    need: 'Condition',
    needOk: 'All fine',
    needUnknown: 'unreadable',
    needName: {
      hunger: 'hungry', thirst: 'thirsty', fatigue: 'tired', endurance: 'stamina',
      pain: 'pain', panic: 'panic', stress: 'stress', unhappy: 'mood', boredom: 'bored',
    },
    none: 'empty',
    cond: (n) => `${n}% left`,
    infected: 'Infected',
    clean: 'Not infected',
    unknown: 'unknown',
    bridge: 'Bridge',
    root: 'Dir',
    journal: 'Notes',
    persona: 'Voice',
    personaName: {
      sharp: 'Sharp teammate',
      steady: 'Steady partner',
      jumpy: 'Jumpy junior',
      adaptive: 'Switches by situation',
    },
    fail: 'Panel cannot reach the server',
    qqGroup: 'QQ group 284525159',
    emptyGame: 'Load a save and this fills in with what she sees.',
    day: (n, clock) => `Day ${n} ${clock}`,
  },
};

const el = (doc, tag, cls, text) => {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * 「灯怎么看」。默认折叠。
 *
 * 灯是宿主画在扩展名旁边的，不在这个面板里 —— 而 hint 只在悬停时出现，
 * **没人知道要悬停**。所以面板里得有一块能查。
 *
 * 颜色走宿主的变量（pz 的样式一律用 `--ink / --ink-soft / --line` + 兜底），
 * 只有红是硬编码的 —— 宿主没提供 error 色，而 #c0392b 在深浅两种主题下都能读。
 */
function lampsHelp(doc, t) {
  const box = el(doc, 'details', 'pz-help');
  box.append(el(doc, 'summary', null, t.helpTitle));

  const ul = el(doc, 'ul');
  for (const [color, k, d] of [
    ['#5f7d5a', 'helpOn', 'helpOnDesc'],
    ['#9ca3af', 'helpOff', 'helpOffDesc'],
    ['#c0392b', 'helpErr', 'helpErrDesc'],
  ]) {
    const li = el(doc, 'li');
    const dot = el(doc, 'span', 'pz-help-dot');
    dot.style.background = color;
    li.append(dot, el(doc, 'b', null, t[k]), doc.createTextNode('　' + t[d]));
    ul.append(li);
  }
  box.append(ul, el(doc, 'p', 'pz-help-which', t.helpWhich));
  return box;
}

function mount(ctx) {
  const doc = ctx.root.ownerDocument ?? document;
  const t = TEXT[String(ctx.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'];

  const wrap = el(doc, 'div', 'pz-panel');
  const head = el(doc, 'div', 'pz-head');
  const dot = el(doc, 'span', 'pz-dot');
  const headText = el(doc, 'div', 'pz-head-text');
  const clock = el(doc, 'div', 'pz-clock');
  head.append(dot, headText, clock);

  const vitals = el(doc, 'div', 'pz-vitals');
  const hpLabel = el(doc, 'span', 'pz-hp-label');
  const hpTrack = el(doc, 'div', 'pz-hp-track');
  const hpFill = el(doc, 'div', 'pz-hp-fill');
  hpTrack.append(hpFill);
  const infTag = el(doc, 'span', 'pz-tag');
  vitals.append(hpLabel, hpTrack, infTag);

  const chips = el(doc, 'div', 'pz-chips');

  const needRow = el(doc, 'div', 'pz-row');
  const bagRow = el(doc, 'div', 'pz-row');
  const lootRow = el(doc, 'div', 'pz-row');
  const tipsBox = el(doc, 'div', 'pz-tips');
  const foot = el(doc, 'div', 'pz-foot');

  /* 灯说明放在最底下 —— 用户是「看到灰点、滚下来找答案」才需要它。 */
  const helpBox = lampsHelp(doc, t);

  wrap.append(head, vitals, chips, needRow, bagRow, lootRow, tipsBox, helpBox, foot);
  ctx.root.append(wrap);

  const setChip = (label, value, tone) => {
    const item = el(doc, 'div', 'pz-chip');
    item.append(el(doc, 'span', 'pz-chip-k', label), el(doc, 'span', 'pz-chip-v', value));
    if (tone) item.dataset.tone = tone;
    return item;
  };

  const render = (s) => {
    const link = s.link;
    dot.dataset.state = link === 'ok' ? 'online'
      : link === 'menu' ? 'offline'
        : link === 'no-root' ? 'error'
          : link === 'stale' ? 'error'
            : 'offline';

    const headLine = {
      ok: t.linkOk,
      menu: t.linkMenu,
      stale: t.linkStale,
      'no-root': t.linkNoRoot,
      'no-data': t.linkNoData,
    }[link] ?? link;
    // 正常在跟的时候服务端也会给一句 linkNote（「在跟。」），和标题重复，
    // 拼起来就是「在跟。在跟」。一切正常时只显示标题，异常时才补原因。
    const note = s.link === 'ok' ? '' : (s.linkNote ?? '');
    headText.textContent = note ? `${headLine} · ${note}` : headLine;

    clock.textContent = s.day !== null && s.day !== undefined
      ? t.day(s.day, s.clock ?? '')
      : '—';

    const hp = typeof s.hp === 'number' ? s.hp : null;
    hpLabel.textContent = hp === null ? `${t.hp} ${t.unknown}` : `${t.hp} ${hp}%`;
    hpFill.style.width = `${hp === null ? 0 : Math.max(0, Math.min(100, hp))}%`;
    hpFill.dataset.band = hp === null ? 'unknown' : hp >= 75 ? 'ok' : hp >= 50 ? 'hurt' : hp >= 25 ? 'bad' : 'critical';

    infTag.textContent = s.infected === true ? t.infected : s.infected === false ? t.clean : `${t.infected === 'Infected' ? 'Infection' : '感染'} ${t.unknown}`;
    infTag.dataset.on = s.infected === true ? 'yes' : 'no';

    chips.replaceChildren(
      setChip(t.zombie, typeof s.visible === 'number' ? String(s.visible) : t.unknown, s.visible >= 12 ? 'danger' : s.visible >= 6 ? 'warn' : undefined),
      setChip(t.place, s.place || t.unknown),
      setChip(t.hand, s.weapon ? `${s.weapon}${s.weaponCond ? ` · ${s.weaponCond}` : ''}` : t.none),
    );

    // ---- 状态那一行 ----
    //
    // 只写「值得一看的那几项」：都 ok 时说「都还行」，省得一行全是没信息的字。
    // 读不到（band 为 null）不算 ok —— 那是「我不知道他饿不饿」，不是「他不饿」。
    needRow.replaceChildren();
    const needs = Array.isArray(s.needs) ? s.needs : [];
    if (needs.length) {
      needRow.append(el(doc, 'span', 'pz-row-k', t.need));
      const flagged = needs.filter((n) => n.band && n.band !== 'ok');
      const known = needs.filter((n) => n.band);
      if (flagged.length) {
        const box = el(doc, 'span', 'pz-row-v');
        flagged.forEach((n, i) => {
          if (i) box.append(doc.createTextNode(' · '));
          const tag = el(doc, 'span', 'pz-need', t.needName[n.key] ?? n.name);
          tag.dataset.band = n.band;
          box.append(tag);
        });
        needRow.append(box);
      } else {
        needRow.append(el(doc, 'span', 'pz-row-v', known.length ? t.needOk : t.needUnknown));
      }
    }

    bagRow.replaceChildren();
    if (s.gear) {
      bagRow.append(el(doc, 'span', 'pz-row-k', t.bag));
      const g = s.gear;
      const parts = [
        `${t.bandage} ${g.bandage}`,
        `${t.food} ${g.food}`,
        `${t.water} ${g.water}`,
        `${t.light} ${g.light}`,
      ];
      bagRow.append(el(doc, 'span', 'pz-row-v', parts.join(' · ')));
    }

    // ---- 正打开的那个容器 ----
    lootRow.replaceChildren();
    const loot = s.loot;
    if (loot && Array.isArray(loot.hits) && loot.hits.length) {
      lootRow.append(el(doc, 'span', 'pz-row-k', t.loot));
      const total = typeof loot.total === 'number' ? `　共 ${loot.total}` : '';
      lootRow.append(el(doc, 'span', 'pz-row-v pz-loot', `${loot.hits.join(' · ')}${total}`));
    }

    tipsBox.replaceChildren();
    const tips = Array.isArray(s.tips) ? s.tips : [];
    if (tips.length) {
      tipsBox.append(el(doc, 'div', 'pz-tips-k', t.tips));
      const ul = el(doc, 'ul', 'pz-tips-list');
      for (const tip of tips) ul.append(el(doc, 'li', '', tip));
      tipsBox.append(ul);
    } else if (s.link === 'ok') {
      tipsBox.append(el(doc, 'div', 'pz-tips-none', t.noTips));
    } else {
      tipsBox.append(el(doc, 'div', 'pz-tips-none', t.emptyGame));
    }

    const voice = t.personaName[s.persona] ?? s.persona ?? '';
    // 页脚只放几个短东西。原来把 install 的完整说明和整条存档路径都塞进来，
    // 那条说明是「从 1.2.1 升到 1.2.2：覆盖 8 个文件，清掉 1 个旧文件。模组列表已替你勾上…」，
    // 加上 `C://Users//...//Zomboid` 整条路径，页脚会被撑成好几行 —— 看起来就像布局坏了。
    // 完整内容挪到 title，鼠标停上去能看全。反馈入口就靠这行群号：这个面板没有别的出口。
    foot.textContent = [
      `${t.persona}：${voice}`,
      `${t.bridge}：${s.installShort ?? '—'}`,
      `v${s.version}`,
      t.qqGroup,
    ].filter(Boolean).join('　·　');
    const detail = [s.install, s.root].filter(Boolean).join('\n');
    if (detail) foot.title = detail;
    else foot.removeAttribute('title');
  };

  const fail = (err) => {
    headText.textContent = `${t.fail}:${err instanceof Error ? err.message : String(err)}`;
    dot.dataset.state = 'error';
  };

  const refresh = async () => {
    try {
      render(await ctx.invoke('snapshot'));
    } catch (err) {
      fail(err);
    }
  };

  void refresh();
  // 2 秒一轮：游戏那边两秒写一次，面板比它快也没用。
  ctx.interval(() => { void refresh(); }, 2000);
}

export default {
  panels: {
    main: { mount },
  },
};
