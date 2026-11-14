/**
 * Lua 侧和 Node 侧是两份代码、一条数据通道，最容易出的事就是「两边各写各的」。
 *
 * 0.1.2 真机翻过一次车：`getFileWriter(B.OUT_FILE, true)` 少传第三个参数，
 * B42 的 Java 侧直接失败，而两层 pcall 把错误吞得干干净净 ——
 * 日志里 mod 加载了、横幅也打了，文件却一个字节都没有。
 * 这一组测试就是钉住这三条，别再靠人去翻 console.txt。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const LUA = 'media/lua/client/CoopaniBridge.lua';
const rootLua = readFileSync(join(PKG, 'pzmod/CoopaniBridge', LUA), 'utf8');
const v42Lua = readFileSync(join(PKG, 'pzmod/CoopaniBridge/42.0', LUA), 'utf8');
const pathsTs = readFileSync(join(PKG, 'src/paths.ts'), 'utf8');

test('两份 Lua 都要在且完全一致', () => {
  // B42 有 42.0/ 版本目录时**只读那一份**，根 media 是给 B41 的。
  // 0.1.6 把 42.0/media 删掉「去重」，结果脚本彻底不被加载 —— 横幅都不打。
  assert.ok(existsSync(join(PKG, 'pzmod/CoopaniBridge/42.0/mod.info')), '42.0/mod.info 要在');
  assert.ok(existsSync(join(PKG, 'pzmod/CoopaniBridge/42.0', LUA)), '42.0 的 Lua 必须在');
  assert.equal(rootLua, v42Lua, '两份不一致会静默跑旧代码');
});

test('不用一次性锁：PZ 会 reload Lua，锁着就再也不会注册', () => {
  // 注释里会提到这个旧名字，只盯真正的代码行。
  const code = rootLua.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.ok(!code.includes('_registered'), '不能再用 _registered 布尔锁');
  assert.match(rootLua, /B\._hooks\s*=/);
  assert.match(rootLua, /local bindings = \{/);
});

test('加载时立刻写一份探针，把 writer 和事件触发分开定位', () => {
  assert.match(rootLua, /B\.LOAD_N\s*=/);
  assert.match(rootLua, /probe=/, '要打印探针结果');
});

test('getFileWriter 必须给满三个参数 (path, true, false)', () => {
  assert.match(rootLua, /getFileWriter\(B\.OUT_FILE,\s*true,\s*false\)/);
  assert.ok(!rootLua.includes('getFileWriter(B.OUT_FILE, true)'), '两参数版本会静默失败');
});

test('不调 w:flush()，那个方法在 B42 不一定存在', () => {
  // 注释里会提到这个方法，只盯真正的调用行。
  assert.ok(!/^\s*w:flush\(/m.test(rootLua));
});

test('写单文件名，不写子目录（create=true 不保证建中间目录）', () => {
  const m = /B\.OUT_FILE\s*=\s*"([^"]+)"/.exec(rootLua);
  assert.ok(m, '找不到 B.OUT_FILE');
  assert.ok(!m[1].includes('/') && !m[1].includes('\\'), `路径里不该有分隔符：${m[1]}`);
});

test('Lua 写的文件名和 Node 读的文件名是同一个', () => {
  const m = /B\.OUT_FILE\s*=\s*"([^"]+)"/.exec(rootLua);
  assert.ok(pathsTs.includes(`'${m[1]}'`), `paths.ts 里没有读 ${m[1]}`);
  assert.match(pathsTs, /stateFile:\s*join\(luaDir,\s*'coopani-pz-state\.txt'\)/);
});

test('失败要说出来：不能让 pcall 把写失败吞干净', () => {
  assert.match(rootLua, /diag\("writer returned nil/);
  assert.match(rootLua, /diag\("write failed: "/);
  assert.match(rootLua, /diag\("json failed: "/);
  assert.match(rootLua, /diag\("first state written/);
});

test('挂钩触发也留痕，好区分「没进世界」和「进了但写不出来」', () => {
  assert.match(rootLua, /diag\("OnGameStart fired"\)/);
  assert.match(rootLua, /diag\("tick fired via "/);
});

test('诊断里不出现 ERROR 这个词（会被 bridge-error 诊断误判成脚本炸了）', () => {
  const diags = rootLua.match(/diag\("[^"]*"/g) ?? [];
  for (const d of diags) assert.ok(!/ERROR/i.test(d), d);
});

test('加载横幅用 ASCII，GBK 日志不会变乱码', () => {
  assert.match(rootLua, /print\("\[CoopaniBridge\] load #"/);
});

test('挂钩日志里有 hooks=N/M，便于从 console.txt 判断实际挂上几个', () => {
  assert.match(rootLua, /hooks=" \.\. ni\(hooked\)/);
  assert.match(rootLua, /ni\(#bindings\)/);
});

test('四个 tick 事件都挂，含最可靠的 OnPlayerUpdate', () => {
  for (const name of ['OnTick', 'OnTickEvenPaused', 'OnRenderTick', 'OnPlayerUpdate', 'OnCreatePlayer', 'OnPlayerMove']) {
    assert.match(rootLua, new RegExp(`Events\\.${name}\\b`), name);
  }
});

test('每个事件写独立心跳文件，能把「回调没跑」和「写文件失败」分开', () => {
  assert.match(rootLua, /coopani-pz-hb" \.\. ni\(B\.LOAD_N\)/);
  assert.match(rootLua, /coopani-pz-hbfail/);
});

test('重绑挂在 OnGameTimeLoaded 上，不再用 getGameTime() 猜世界已加载', () => {
  assert.match(rootLua, /Events\.OnGameTimeLoaded/);
  const code = rootLua.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.ok(!/if gt ~= nil then/.test(code), '不能再用 getGameTime() 判世界加载');
});

test('加载时打印事件自检，能看出 B42 这份构建有哪些钩子', () => {
  assert.match(rootLua, /events OnPlayerUpdate=/);
});

/**
 * 0.4.8 真机翻车：别人的机器上整份 state 一个字节都写不出来，
 * console 里是 `flush failed: Object tried to call nil in readPlayer`。
 *
 * 根因不是「某个方法不存在」—— 那种早被 pcall 包住了。
 * 是 `statOnce(st, CS and CS.PANIC, 'panic')` 里 **`CS.PANIC` 的求值发生在
 * 参数阶段**，那时 statOnce 还没进函数体，里面的 pcall 根本不存在。
 * 访问一个这个构建没有的 Java 静态字段，Kahlua 当场抛，直接穿出 readPlayer。
 *
 * 所以这条测试盯的不是「有没有包 pcall」，是**枚举到底在哪一步取的**。
 */
test('CharacterStat 枚举只能在 ensureEnums 里取，且每个都包 pcall', () => {
  // 去掉注释再判 —— 说明这个坑的注释里会原样引用那段错误写法。
  const code = rootLua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');

  assert.ok(!/CS\s+and\s+CS\./.test(code), '不许再出现 `CS and CS.X`：参数求值处没有 pcall');
  assert.ok(!/\blocal\s+CS\s*=\s*CharacterStat/.test(code), '不许在加载期抓 CharacterStat 快照');
  assert.match(rootLua, /local function ensureEnums\(\)/);
  assert.match(rootLua, /ensureEnums\(\)/, 'readPlayer 里必须真的调用它');

  // 每个枚举单独 take，且 take 内部走 pcall
  const start = rootLua.indexOf('local function ensureEnums');
  const end = rootLua.indexOf('local function readPlayer');
  assert.ok(start > 0 && end > start, '找不到 ensureEnums');
  const body = rootLua.slice(start, end);
  const takes = body.match(/take\('[a-z]+', function\(\) return cs\.[A-Z_]+ end\)/g) ?? [];
  assert.ok(takes.length >= 10, `应该逐个取 10 个枚举，实际 ${takes.length}`);
  assert.match(body, /local ok, v = pcall\(fn\)/);
  // 取不到不许打日志：这是「这个构建没这个名字」，属于正常差异
  assert.ok(!/diag\(/.test(body), 'ensureEnums 里不该打诊断，缺枚举是正常情况');
});

test('属性读取一律走 ENUM，不再直接碰 Java 静态字段', () => {
  const code = rootLua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  assert.match(code, /ENUM\[key\]/, '属性读取要走 ENUM 表');
  for (const k of ['hunger', 'thirst', 'fatigue', 'endurance', 'stress', 'infection', 'panic', 'pain', 'boredom', 'unhappy']) {
    assert.match(code, new RegExp(`take\\('${k}'`), `ensureEnums 里漏了 ${k}`);
  }
});

/**
 * 第二条同类翻车：`if next(sk) then` —— Kahlua 的标准库不全，`next` 在某些构建里是 nil，
 * 而它同样是在**表达式求值**处调用，外面怎么包都没用。
 * 本机跑的是 42.21，`next` 有；别人那个构建没有 —— 又是一次「本机能跑不代表别人能跑」。
 */
test('不许用 next() —— Kahlua 里它可能是 nil', () => {
  const code = rootLua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  assert.ok(!/\bnext\s*\(/.test(code), '`next(...)` 在部分构建里是 nil，改计数器');
});

/**
 * 根治手段：readPlayer 按段隔离。
 *
 * 只要有一处抛出穿出 readPlayer，整份 state 就一个字节写不出来，
 * 外面只能看到「桥接报错了」—— 而真实原因可能只是「这个构建没这个字段」。
 * 所以每一段都得单独 pcall，并且失败的段名要打一次进 console。
 */
test('readPlayer 按段隔离，失败只丢那一段并留痕', () => {
  assert.match(rootLua, /local function step\(name, fn\)/);
  assert.match(rootLua, /readPlayer step failed: /);

  const start = rootLua.indexOf('local function readPlayer(p)');
  const end = rootLua.indexOf('--- 扫背包');
  assert.ok(start > 0 && end > start, '找不到 readPlayer');
  const body = rootLua.slice(start, end);
  const steps = body.match(/\bstep\('/g) ?? [];
  assert.ok(steps.length >= 8, `readPlayer 里的分段太少（${steps.length}），有裸调用没被包住`);
  // 每个属性读取都要经过 step 或 need/needOnce
  assert.match(body, /local function need\(key, legacy\)/);
  assert.match(body, /local function needOnce\(key\)/);
});

test('每项 stat 按它自己的量纲归一，不许拿一套阈值套所有项', () => {
  // 真机事故：疼痛 1.9 被外面的 0..1 阈值读成 190%，于是她说「疼到影响动作了」。
  // 而 pain / panic 是 0..100 量纲（游戏调试面板给它们写的滑条步长是 1）。
  assert.match(rootLua, /local function normNeed\(/, '缺 normNeed');
  assert.match(rootLua, /ENUM_RANGE/, '缺量纲表');
  assert.match(rootLua, /getMaximumValue/, '量纲要从枚举自己身上取，不许写死');

  // 所有 need / needOnce 都必须经过 normNeed，不许直接透传原始值
  const calls = rootLua.match(/normNeed\(key,/g) || [];
  assert.ok(calls.length >= 2, `need 与 needOnce 都要归一，实际只有 ${calls.length} 处`);
  assert.ok(!/out\[key\] = step\(key, function\(\) return stat\(st, ENUM\[key\], legacy\) end\)/.test(rootLua),
    '还有没归一的 stat 直传');

  // 拿不到范围时的兜底：0..1 的比值不会超过 1.5，超过就按 0..100 算
  assert.match(rootLua, /v > 1\.5/, '缺兜底');
});

test('容器每拍查身份、变了才扫内容 —— 不许再按固定拍数拖', () => {
  // 原来固定每 3 拍扫一次（约 6 秒），真机上就是「翻完柜子走了才报」。
  assert.match(rootLua, /local function lootHandle\(/, '缺便宜的容器身份查询');
  assert.match(rootLua, /local function scanLoot\(/, '缺完整扫描');
  assert.ok(!/flushCount % 3 == 1/.test(rootLua), '还在按 3 拍节流，改回去就又慢了');
  assert.match(rootLua, /h\.sig ~= lootSig/, '没按容器身份判断要不要重扫');
});

test('容器里的东西要带「是不是武器」标记，不能只给伤害', () => {
  // 抹布也有 MaxDamage = 1.5，只按伤害判会把抹布当武器推荐。
  assert.match(rootLua, /isWeapon/, '缺武器判定');
  assert.match(rootLua, /tostring\(cat or ''\):lower\(\) == 'weapon'/,
    '武器判定必须看 Category == Weapon，不许看伤害');
  assert.match(rootLua, /"w":/, 'w 没写进 state');
});

test('指令文件名两边逐字一致，且 Lua 侧有节流、序号与过期', async () => {
  const rootLuaTxt = rootLua;   // 四份里那份主副本
  assert.match(rootLuaTxt, /B\.CMD_FILE = "coopani-pz-cmd\.txt"/, 'Lua 侧文件名变了');

  // TS 侧必须同名 —— 两边各写各的会静默失联，这是这个项目踩过的老坑
  const { pathsOf } = await import('../src/paths.ts');
  const p = pathsOf('C:/x/Zomboid');
  assert.ok(p.cmdFile.endsWith('coopani-pz-cmd.txt'), `TS 侧文件名对不上：${p.cmdFile}`);

  // 四条硬要求，缺一条就会重复执行、执行过期命令，或者把连下的指令吃掉
  //
  // 去重判据必须是「行内容变没变」。只看 seq 的话，桌面伴侣重启（seq 从 1 重来）
  // 之后所有指令都会被当成「已见过」静默丢掉 —— 这是设计时差点栽进去的坑。
  //
  // 通道是**队列**：她一个回合里连下「走 → 开柜 → 拿」，所以要读全部行、
  // 记一片已执行的，而不是只记最后一行。
  assert.match(rootLuaTxt, /if not cmdDone\[l\] then/, '没有按行内容去重');
  assert.match(rootLuaTxt, /local function cmdMarkDone/, '缺 cmdMarkDone');
  assert.match(rootLuaTxt, /local function readCmdLines/, '还在只读第一行（队列会丢指令）');
  // 排队：手上还有活就等下一拍，否则第二条的 queueWalk 会清掉第一条的走路
  assert.match(rootLuaTxt, /if verb ~= "stop" and p and isBusy\(p\) then return end/, '没有排队');
  assert.match(rootLuaTxt, /expire < os\.time\(\)/, '没有过期判断');
  assert.match(rootLuaTxt, /frameCount % 30 == 0 then pcall\(pollCommand/, '轮询没挂进主循环');
});

test('函数用到的表，声明必须在函数之前 —— Lua 的 local 不是文件级的', () => {
  // 真机事故（mod 1.2.15）：`local ENUM_RANGE = {}` 写在 301 行，
  // 而用它的 `normNeed` 在 262 行。Lua 只把「声明之后」的同名 local 绑成 upvalue，
  // 于是函数里那个 ENUM_RANGE 是**全局**，运行时 nil：
  //     attempted index: boredom of non-table: null
  // 后果是每一项属性每拍抛一次，hunger/thirst/panic 全 null，console 被堆栈刷满。
  const iRange = rootLua.indexOf('local ENUM_RANGE');
  const iNorm = rootLua.indexOf('local function normNeed');
  const iEnum = rootLua.indexOf('local ENUM = {}');
  const iStat = rootLua.indexOf('local function stat(');
  assert.ok(iRange > 0 && iNorm > 0 && iEnum > 0 && iStat > 0, '锚点没找到');
  assert.ok(iRange < iNorm, `ENUM_RANGE(${iRange}) 必须声明在 normNeed(${iNorm}) 之前`);
  assert.ok(iEnum < iStat, `ENUM(${iEnum}) 必须声明在 stat(${iStat}) 之前`);
});

test('做东西：点名找配方，扫清单要有闸', () => {
  // 名字大小写不敏感 —— 她抄名字时大小写最容易错
  assert.match(rootLua, /string\.lower\(rn\) == low/, '没有忽略大小写');
  // 空格编码的还原
  assert.match(rootLua, /want:gsub\(\"%\+\", \" \"\)/, '没有把 + 换回空格');
  // scan 必须有两道闸，否则一次扫全部配方会卡住游戏
  assert.match(rootLua, /#list >= 12 then break/, '没限制条数');
  assert.match(rootLua, /os\.time\(\) - started >= 2/, '没有时间上限');
});

test('做饭借游戏自己的合成系统，不自己重建一套', () => {
  // 走 OnNewCraft 那条路：HandcraftLogic 判能不能做，ISEntityUI.HandcraftStart 排动作。
  assert.match(rootLua, /HandcraftLogic\.new\(p, nil, nil\)/, '没有用 HandcraftLogic');
  assert.match(rootLua, /canPerformCurrentRecipe\(\)/, '没用游戏的可做判定');
  assert.match(rootLua, /ISEntityUI\.HandcraftStart\(/, '没有走 HandcraftStart');
  assert.match(rootLua, /getAllCraftRecipes\(\)/, '配方从哪来？');
  assert.match(rootLua, /cat == 'Cooking'/, '没有限定烹饪类');
  // 容器列表不能依赖物品栏面板：她从不打开那个 UI，那类 API 在无人操作时是空的
  assert.match(rootLua, /local function nearbyContainers\(p\)/, '缺自己的容器列表');
  assert.ok(!/ISInventoryPaneContextMenu\.getContainers\(/.test(rootLua),
    '又去用依赖 UI 的 getContainers 了');
  // 不自己做材料判断（很容易和游戏不一致）
  assert.ok(!/getHungChange\(\) *< *0.*cook/i.test(rootLua), '别自己判材料');
});

test('吃 / 喝走游戏自己的动作类，别自己改数值', () => {
  // 饱食度、口渴度、食物中毒、动作时长全归游戏管；自己 setHunger 会漏掉一堆副作用。
  assert.match(rootLua, /ISEatFoodAction:new\(p, it, 1\.0\)/, '吃东西没用 ISEatFoodAction');
  assert.match(rootLua, /ISDrinkFluidAction:new\(p, it, 1\.0\)/, '喝水没用 ISDrinkFluidAction');
  assert.match(rootLua, /ISDrinkFromBottle:new\(p, it, 1\.0\)/, '老式瓶子的兜底没了');
  assert.match(rootLua, /getHungChange\(\)/, '挑食物要看 getHungChange');
  assert.ok(!/setHunger\(|setThirst\(/.test(rootLua), '不许自己改数值');
});

test('拿东西之前站的格子，不能选到墙外面', () => {
  // 真机：衣柜贴外墙，按固定顺序扫到的第一个空格在院子那边 —— 她被派出去绕一圈。
  assert.match(rootLua, /local function adjacentSquare\(sq, p\)/, 'adjacentSquare 没接玩家');
  assert.match(rootLua, /isInside\(\)/, '没按屋里/屋外分');
  assert.match(rootLua, /adjacentSquare\(sq, p\)/, '调用点没传玩家');
});

test('开门走 IsoDoor:ToggleDoor，别用 setOpen 硬拉', () => {
  // setOpen 绕过游戏自己的判定：锁着的门也会被"拉开"，而且不触发开门动作。
  assert.match(rootLua, /ToggleDoor\(p\)/, '没有用 ToggleDoor');
  assert.ok(!/:setOpen\(true\)/.test(rootLua), '别用 setOpen 硬拉');
  assert.match(rootLua, /instanceof\(o, "IsoDoor"\)/, '找门要看类型');
  assert.match(rootLua, /verb == "door"/, 'door 没接进分支');
});

test('双手武器的方法在物品上，不在脚本项上', () => {
  // 真机：`si:isTwoHandWeapon()` 刷了 6 段空消息堆栈 —— 对象和方法两个都错。
  assert.ok(!/si:isTwoHandWeapon/.test(rootLua), '还在脚本项上调');
  assert.match(rootLua, /prim:isTwoHandWeapon\(\)/, '该在 InventoryItem 上调');
});

test('动作队列的空判断不许用 isEmpty —— B42 那个对象上没有这个方法', () => {
  // 原来写 `q.queue:isEmpty()`，方法为 nil → 每次 flush 抛一次，
  // 而 isBusy 每 120 帧跑一次，日志直接被堆栈刷满。
  // 去掉注释再判 —— 说明文字里会引用旧写法，那是注释不是代码。
  const code = rootLua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  // 也不许用 size() —— `o.queue = {}` 是 Lua 表，没有 Java 那一套方法。
  // 官方自己数它用的是 `#self.queue`。
  assert.ok(!/:isEmpty\(/.test(code), '还在调 isEmpty');
  assert.ok(!/q\.queue:size\(/.test(code), '还在调 size —— 那是 Lua 表');
  assert.match(code, /#q\.queue/, '该用 # 取长度');
});

test('Lua 源码里进 JSON 的字符串必须是 ASCII —— 中文会被 Kahlua 截成乱码', () => {
  // 真机事故：`why` 里是「过期了（这条是 352 秒前下的）」，Kahlua 把非 ASCII
  // 截成单字节，于是 JSON 里出现 0x1F / 0x08 → **整份 state 非法**，
  // 外面报「读到半截 JSON」，而数据一个字段都没少。
  //
  // 判据：字符串字面量里不许有中文。注释随便写 —— 词法器会跳过注释。
  const code = rootLua.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  const bad = [];
  for (const m of code.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const t = m[1] ?? m[2] ?? '';
    if (/[\u4e00-\u9fff]/.test(t)) bad.push(t.slice(0, 30));
  }
  assert.deepEqual(bad, [], `这些字符串里有中文：${bad.join(' / ')}`);
});

test('JSON 字符串转义必须兜住控制字符', () => {
  // 只转 \n \r \t 不够：任何 0x00–0x1F 都能让 JSON 非法。
  assert.match(rootLua, /gsub\("%c"/, 'q() 没兜控制字符');
});

test('读过的书不再提示：判据用游戏自己的 isLiteratureRead', () => {
  // 自己攒书名表会漏 —— 尤其「等级已经超过的技能书」，页数一条没读，但对他没用了。
  assert.match(rootLua, /ISInventoryPane\.isLiteratureRead/, '没用游戏自己的判据');
  assert.match(rootLua, /local function literatureSpent/, '缺 literatureSpent');
  // 用到它的地方必须把玩家传进去（判已读要玩家身上的进度）
  assert.match(rootLua, /local function scanLoot\(h, p\)/, 'scanLoot 没接玩家');
  assert.match(rootLua, /scanLoot\(h, p\)/, '调用点没把玩家传进去');
  // 只对读物生效，别把别的分类一起吞掉
  assert.match(rootLua, /if tier > 0 and isLit then/, '没有只对读物判定');
  assert.match(rootLua, /literatureSpent\(p, it\)/, '没有调已读判定');
  // 页数为 0 的"读物"是笔记本，不是书
  assert.match(rootLua, /pages <= 0/, '笔记本（页数为 0）该被排除');
});

test('反射层：不等模型的反应必须在游戏里，且有自己的节流', () => {
  // 这一层存在的唯一理由：模型一轮往返是秒级，僵尸贴脸是一秒半。
  // 所以「挡不挡」不能排在一条几秒前的指令后面 —— 它得挂在 tickBody 上，先于 pollCommand。
  assert.match(rootLua, /local function reflexTick/, '缺 reflexTick');
  assert.match(rootLua, /local function threatScan/, '缺 threatScan');

  const body = rootLua.slice(rootLua.indexOf('local function tickBody'));
  const iReflex = body.indexOf('reflexTick');
  const iPoll = body.indexOf('pollCommand');
  assert.ok(iReflex > 0 && iPoll > 0, 'tickBody 里两个都要挂上');
  assert.ok(iReflex < iPoll, '反射必须排在指令前面，否则又是「先执行几秒前的命令」');

  // 按格扫而不是全对象列表：反射几十毫秒一次，全量扫会卡成幻灯片。
  assert.match(rootLua, /getGridSquare\(bx \+ dx, by \+ dy, pz\)/, '没用按格扫');
  assert.match(rootLua, /reflexScanOk == false/, '没有「这个方法不可用」的退化标记');
  // 每次都试一次失败的方法 = 每 50ms 打一段堆栈
  assert.match(rootLua, /if reflexScanOk ~= false then/, '每拍都在重试不可用的接口');

  // 出手必须节流。没有节流就是每 50ms 挥一下，把体力耗光还打不中。
  assert.match(rootLua, /REFLEX_ATK_GAP/, '没有出手间隔');
  assert.match(rootLua, /if t < reflexNextAtk then return end/, '没有真正拦住');

  // 够不着不许挥 —— 空挥是白掉体力
  assert.match(rootLua, /if d > REFLEX_REACH then return end/, '没有距离门槛');

  // 手里有活时打断要清队列，但只在这个距离内
  assert.match(rootLua, /ISTimedActionQueue\.clear\(p\)/, '打断没清队列');
});

test('反射读数要写进 state，且开关能远程关掉', () => {
  // 外面要判断「迎上去还是绕开」，靠的就是这两个数 —— 不能只留在 Lua 里。
  assert.match(rootLua, /add\("threat", /, 'state 里没有 threat');
  assert.match(rootLua, /add\("reflex", /, 'state 里没有 reflex');
  // 她得能自己把这个开关关掉（潜入时不想因为自动动手暴露）
  assert.match(rootLua, /elseif verb == "guard" then/, '没有 guard 动词');
  assert.match(rootLua, /B\.REFLEX\.on = not \(f\[3\] == "0"\)/, 'guard 没解析参数');
});

test('isBusy 必须先声明再用 —— 它在 pollCommand 后面几十行', () => {
  // Lua 的 local 只对定义之后可见。pollCommand 里直接调 isBusy，拿到的是 nil，
  // 一次调用就是一整段堆栈，而且每半秒一次。
  const iDecl = rootLua.search(/local isBusy\s*\r?\n/);
  const iPoll = rootLua.indexOf('local function pollCommand');
  const iDef = rootLua.indexOf('function isBusy(p)');
  assert.ok(iDecl > 0, '缺前向声明 local isBusy');
  assert.ok(iDecl < iPoll, '声明必须在 pollCommand 之前');
  assert.ok(iDef > iPoll, '定义本来就在后面，这个测试是在钉住「别把声明删了」');
});

test('look 和 equip：她自己指出的两个缺口，各要有对应实现', () => {
  // 她的原话（桌宠 workspace/log）：
  //   「容器里的东西只有他手动点开才会进 pz_state——想让我拿东西，得他先开柜子」
  //   「pz_play 没有『装备到手里』这个动作，刀要他自己右键拎手上」
  // 两条都不是她不肯做，是手里没有那个动作。
  assert.match(rootLua, /^function queueLook\(/m, '缺 look');
  assert.match(rootLua, /^function queueEquip\(/m, '缺 equip');
  // 两个都要在前向声明里 —— pollCommand 在它们前面就要用
  assert.match(rootLua, /^local queueLook$/m, 'look 没前向声明');
  assert.match(rootLua, /^local queueEquip$/m, 'equip 没前向声明');

  // look 不能走界面：`loot` 那条路要人先点开柜子，她没有界面。
  assert.match(rootLua, /getGridSquare\(math\.floor\(x\), math\.floor\(y\), pz\)/, 'look 没按坐标取格');
  assert.match(rootLua, /o:getContainer\(\)/, 'look 没直接问物体要容器');
  // 太远就不看 —— 看得见也够不着，白费一轮
  assert.match(rootLua, /if d > LOOK_RANGE then/, 'look 没有距离门槛');
  // 结果要带着 objIdx 和 itemIdx，否则 take 拼不出来
  assert.match(rootLua, /add\("peek", /, 'state 里没有 peek');

  // equip 走右键菜单那条路，不自己 setPrimaryHandItem 绕过判定
  assert.match(rootLua, /ISInventoryPaneContextMenu\.equipWeapon/, 'equip 没走游戏自己的入口');
  // 玩家索引要数字，不是对象 —— equipWeapon 内部是 getSpecificPlayer(player)
  assert.match(rootLua, /getPlayerNum\(\)/, 'equip 没传玩家索引');

  // 两个动词都要在 pollCommand 里有分支
  assert.match(rootLua, /elseif verb == "look" then/, 'pollCommand 没有 look 分支');
  assert.match(rootLua, /elseif verb == "equip" then/, 'pollCommand 没有 equip 分支');
});

test('pollCommand 里调到的每个 queue 函数，用到时必须已经可见', () => {
  // 真机事故（mod 1.3.3）：`queueLook` / `queueEquip` 定义在 pollCommand **后面**，
  // 而 pollCommand 是裹在 pcall 里调起来的 —— 调 nil 抛的错被外层接住，
  // **ack 没写成**，但 cmdMarkDone 已经执行了。
  // 表现是「指令发了、没回执、也不重试」，她只能从状态里看出「什么都没发生」。
  const iPoll = rootLua.indexOf('local function pollCommand');
  assert.ok(iPoll > 0, '找不到 pollCommand');
  const body = rootLua.slice(iPoll, iPoll + 6000);
  const calls = [...new Set([...body.matchAll(/\b(queue[A-Z]\w+)\(/g)].map((m) => m[1]))];
  assert.ok(calls.length > 0, '一个 queue 函数都没调？');
  for (const fn of calls) {
    const iDef = rootLua.search(new RegExp('^(?:local )?function ' + fn + '\\b', 'm'));
    const iDecl = rootLua.search(new RegExp('^local ' + fn + '$', 'm'));
    assert.ok(iDef > 0, fn + ' 没有定义');
    assert.ok(
      iDef < iPoll || (iDecl > 0 && iDecl < iPoll),
      fn + ' 在 pollCommand 里被调用时还是 nil —— 要提前定义，或者在 pollCommand 之前 local 声明',
    );
  }
});

test('队列里每一条都得能被消化掉 —— 任何 return 前要么标记、要么说明为什么留着', () => {
  // 真机事故（mod 1.3.4）：把「标记已处理」挪到执行之后，过期分支却提前 return 了。
  // 队头那条过期指令每次都被读到、每次都 return、永远不标记 ——
  // 后面 19 条全堵在它后面，`cmdLeft` 卡在 19 不动，回执还是几十分钟前那条。
  const iPoll = rootLua.indexOf('local function pollCommand');
  const body = rootLua.slice(iPoll, iPoll + 9000);
  const iExpire = body.indexOf('expire < os.time()');
  assert.ok(iExpire > 0, '找不到过期判断');
  const after = body.slice(iExpire, iExpire + 800);
  assert.match(after, /cmdMarkDone\(line\)/, '过期的那条没标记 —— 会永远堵在队头');

  // 开局清空：上一局的行不清掉，每次开局都要先还一堆陈年旧账
  assert.match(rootLua, /local function clearCmdFile/, '缺 clearCmdFile');
  assert.match(rootLua, /session = newSessionId\(\)\s*\n\s*clearCmdFile\(\)/, '开局没清空指令文件');
});

test('menu / pick：把游戏右键菜单当动作库，不再一个个补动词', () => {
  // 这条路的意义：PZ 的动作是「物品 × 目标 × 技能 × 状态」的组合，枚举不完。
  // 菜单是游戏自己算出来的，菜单里有什么她就能做什么。
  assert.match(rootLua, /local function menuBuild/, '缺 menuBuild');
  assert.match(rootLua, /^function menuList\b/m, '缺 menuList');
  assert.match(rootLua, /^function menuPick\b/m, '缺 menuPick');

  // 必须走 createMenu（别自己 triggerEvent：B42 把主体挪进了 createMenuEntries）。
  // **而且不能传 test = true** —— 那个参数交给 Java 侧，它在 test 模式下填不填选项
  // 从 Lua 这边看不出来；赌错的代价是清单永远为空。
  assert.match(rootLua, /ISWorldObjectContextMenu\.createMenu\(num, objs, sx, sy\)/,
    '没走 createMenu 正常生成');
  assert.ok(!/createMenu\(num, objs, sx, sy, true\)/.test(rootLua),
    '还在传 test = true —— 可能拿到空菜单');

  // 拿到之后必须立刻隐藏，否则会闪一下
  assert.match(rootLua, /ctx:setVisible\(false\)/, '生成完没藏起来');

  assert.match(rootLua, /ctx:setVisible\(false\)/, '生成完没藏起来');

  // onSelect 的调用约定是游戏定的：target + param1..param10
  assert.match(rootLua, /o\.onSelect\(o\.target, o\.param1, o\.param2, o\.param3, o\.param4,/,
    'onSelect 的参数没照抄 ISContextMenu 的调法');
  assert.match(rootLua, /ISContextMenu\.globalPlayerContext/, '没设 globalPlayerContext');

  // pick 必须按名字找，不按序号 —— 菜单是重新生成的，序号会错位
  assert.match(rootLua, /menuLabel\(cand\.name\) == want/, 'pick 还在按序号取，会执行错项');
  assert.match(rootLua, /'stale-menu'/, '名字对不上时没有明确的失败');

  assert.match(rootLua, /add\("menu", /, 'state 里没有 menu');
  assert.match(rootLua, /elseif verb == "menu" then/, 'pollCommand 没有 menu 分支');
  assert.match(rootLua, /elseif verb == "pick" then/, 'pollCommand 没有 pick 分支');
});

test('生成菜单不许清掉他正在用的那个，也不许一秒内反复生成', () => {
  // `createMenu` 第一步是 `ISContextMenu.get`，那里面第一件事是 `context:clear()`。
  // 他正开着右键菜单、点了一半「拆解」，她这边一问，菜单就没了 —— 而且原因
  // 在几分钟后的日志里，对不上。
  assert.match(rootLua, /isAnyVisible\(\)/, '没检查他是不是正开着菜单');
  assert.match(rootLua, /'menu-in-use'/, '没有这一种失败原因');

  // 生成一次要给半径两格内所有对象过一遍，不能让她连着问
  assert.match(rootLua, /MENU_MIN_GAP/, '缺节流间隔');
  assert.match(rootLua, /menuLastAt/, '没记上次生成时间');

  // 内部原因不能被统一盖成 no-menu
  assert.match(rootLua, /if not ctx then return nil, why or 'no-menu' end/, '原因被覆盖了');
});

test('小队指令：走 Rimboid 自己的 SetJob，不抢它的身体', () => {
  // 它的幸存者是伪装成僵尸的身体，我们那套 ISWalkToTimedAction 对它们无效，
  // 而且它的 AI 每帧都在驱动 —— 抢控制权只会两边打架。
  assert.match(rootLua, /SSQ\.send\(p, "SetJob"/, '没走它的 SetJob');
  assert.match(rootLua, /SSQ\.Roster\.members\(\)/, '没从它的名册取成员');
  // 没装那个 mod 时要老实报错，不能让主流程挂掉
  assert.match(rootLua, /local function squadReady/, '缺 squadReady');
  assert.ok((rootLua.match(/'no-squad'/g) || []).length >= 3, '各个入口都要能报 no-squad');
  // 十六种工作名要校验 —— 拼错一个字母它会静默什么都不做
  assert.match(rootLua, /local SQUAD_JOBS = \{/, '缺工作名校验表');
  assert.match(rootLua, /if not SQUAD_JOBS\[key\] then return false/, '没校验工作名');
  // 结果要进 state，否则她不知道有谁、id 是什么
  assert.match(rootLua, /add\("squad", /, 'state 里没有 squad');
});

test('guide：把走路动作压进 NPC 的队列 —— 这是精确操作，不是派活', () => {
  // 翻过源码才敢写这条路：
  //   ISWalkToTimedAction 内部只用 character:getPathFindBehavior2()，那是 IsoGameCharacter
  //   的方法，僵尸身体也有；它唯一认 IsoPlayer 的地方是「键盘按方向键就中断」，非玩家跳过。
  //   ISTimedActionQueue 拿 character 当 key，只对 IsoPlayer 做特殊检查（睡觉/拖尸体）。
  assert.match(rootLua, /function squadGuide/, '缺 squadGuide');
  assert.match(rootLua, /ISWalkToTimedAction:new\(body, sq\)/, '没把 NPC 的身体传给走路动作');
  // 动作要加进那个 body 的队列，不是玩家的
  assert.match(rootLua, /ISTimedActionQueue\.clear\(body\)/, '没清 NPC 自己的队列');
  // 压动作之前必须先让它自己的 AI 放手，否则两边打架，表现是原地抽搐
  const i = rootLua.indexOf('function squadGuide');
  const body = rootLua.slice(i, i + 2400);
  const iHold = body.indexOf('"Hold"');
  const iWalk = body.indexOf('ISWalkToTimedAction:new');
  assert.ok(iHold > 0, '没有先让它 Hold');
  assert.ok(iHold < iWalk, 'Hold 要在压动作之前');
  // 身体可能没加载：member.body 为 nil 时要走它自己的查找
  assert.match(rootLua, /SSQ\.NPC\.findMemberBody/, '只信 member.body，没加载时拿不到');
  // 没装 mod 时老规矩：报 no-squad，不许崩
  const guide = rootLua.slice(i, i + 200);
  assert.match(guide, /no-squad/, 'squadGuide 没检查 squadReady');
});

test('他在自己玩的时候，反射层和指令都要让开 —— 身体只有一个', () => {
  // 真机反馈：「还有自动打怪，干扰操作啊」。
  // 反射层原本是给「她自己在玩」设计的，但他握着鼠标的时候，它就是在抢同一个 Bob：
  //   · 举枪在瞄 → 反射把朝向转到最近那只，瞄好的目标跑了
  //   · 按着方向键走位 → 被一挥手顶掉
  //   · 正在拆东西 → ISTimedActionQueue.clear 把手上的活清掉
  assert.match(rootLua, /local function playerHandsOn/, '缺 playerHandsOn');
  assert.match(rootLua, /local function moveKeyDown/, '缺按键检测');

  // 三个来源一个都不能少
  assert.match(rootLua, /p:isAiming\(\)/, '没判举枪');
  assert.match(rootLua, /p:isAttacking\(\)/, '没判攻击中');
  assert.match(rootLua, /Keyboard\.KEY_W/, '没判方向键');

  // 第三条第 3 项：鼠标点地走。必须排除「她自己走」——
  // 不排除的话她每走一步都被判成玩家操作，反射永远不响。
  assert.match(rootLua, /not isBusy\(p\)/, '位置差分没排除自己的 walk');

  // 扫描要继续（threat 读数要用），只是动手前让开 —— 顺序在这里是语义
  const iScan = rootLua.indexOf('local cnt, z, d = threatScan(p, REFLEX_RADIUS)');
  const iHands = rootLua.indexOf('local hands, why = playerHandsOn(p, t)');
  const iReach = rootLua.indexOf('if d > REFLEX_REACH then return end');
  assert.ok(iScan > 0 && iHands > 0 && iReach > 0, '三段都得在');
  assert.ok(iScan < iHands, '先扫描（读数），再判人');
  assert.ok(iHands < iReach, '判人要在动手之前');

  // 他在操作时不许清他手上的活
  assert.match(rootLua, /if hands then return end/, '没真正拦住');

  // state 要带出去，否则她不知道身体被谁拿着
  assert.match(rootLua, /add\("hands", /, 'state 里没有 hands');

  // 指令侧也要拦：她可能在别的触发点自己下了指令
  assert.match(rootLua, /local BODY_VERBS = \{/, '缺会动身体的动词表');
  assert.match(rootLua, /ack\(false, 'hands-off'\)/, '没有 hands-off 回执');
});

test('反射层要两个条件同时满足：他在、且她在开车', () => {
  // 第一版只问了「他在不在」。漏洞很具体：他坐下来点右键开门、翻背包、读信 ——
  // 没按键、没瞄准、人也没动，被判成「他不在」，反射层就开始替他打。
  // 他的观感是「我什么都没按，她在替我打」。
  assert.match(rootLua, /local function playerHandsOn/, '缺 playerHandsOn');
  assert.match(rootLua, /HANDS_IDLE_TICKS/, '缺「多久算他走了」的门槛');

  // 鼠标判据：坐下来点右键、翻背包不产生按键，但手在鼠标上
  assert.match(rootLua, /getMouseX\(\)/, '没有鼠标判据');
  assert.match(rootLua, /type\(getMouseX\) == 'function'/, '没检查 getMouseX 存在');

  // 第二个条件：她在开车
  assert.match(rootLua, /local sheDriving = isBusy\(p\) or \(B\.CMD_LEFT or 0\) > 0/, '缺 sheDriving');
  assert.match(rootLua, /if not sheDriving then return end/, 'sheDriving 没真正拦住');
  assert.match(rootLua, /B\.LAST_CMD_AT = os\.time\(\)/, '没记最后一次指令时刻');

  // 两个 readout 要能分开看，否则「它又不打了」查不出是哪个条件没满足
  assert.match(rootLua, /"drv":/, 'state 里没有 drv');
  assert.match(rootLua, /B\.SHE_DRIVING = sheDriving/, '没存 sheDriving');
});

test('狗：驱动走 Companion Dogs 自己的入口，不从 AI 队列表外面硬推', () => {
  // 这条路的三条依据都翻过源码（class 文件 + mod 源码），不是猜的：
  //   1. IsoAnimal extends IsoPlayer —— 动物有玩家级动作系统
  //   2. CD.moveTo 内部是 pathToLocation + forcePathfind，还处理步态和封锁标志
  //   3. 它的 AI 靠 followMaintainDogs / combatMaintainDogs 两个表驱动，从表里摘掉就不再管
  const i = rootLua.indexOf('-- 她的第二具身体');
  assert.ok(i > 0, '缺狗的章节');

  assert.ok(rootLua.includes('local function dogReady()'), '缺 dogReady');
  // 没装 mod 必须一票否决，不许假设它在
  assert.ok(rootLua.includes("return false, 'no-dog-mod'"), '没装 mod 时没报错');

  // 走 CD.moveTo，不直接 pathToLocation —— 少 forcePathfind 就是「指令下去了它不动」
  assert.ok(rootLua.includes('CD.moveTo(a, false, CD.walkAnimSpeed()'), '没走 CD.moveTo');
  // 停住要两件事都做：断已经在跑的路径 + 封锁行为
  assert.ok(rootLua.includes('a:stopAllMovementNow()'), '停的时候没断路径');
  assert.ok(rootLua.includes('CD.holdStill(a)'), '停的时候没封锁行为');

  // 接管 = 从它的两个 AI 表里摘掉（mod 自己在守护模式下也这么干）
  assert.ok(rootLua.includes('CD.followMaintainDogs[id] = nil'), '没从跟随表摘掉');
  assert.ok(rootLua.includes('CD.combatMaintainDogs[id] = nil'), '没从战斗表摘掉');

  // 状态要能出去，否则外面看不见这具身体
  assert.ok(rootLua.includes('add("dog", '), 'state 里没有 dog');
  assert.ok(rootLua.includes('elseif verb == "dogo" then'), 'pollCommand 没有 dogo 分支');
  assert.ok(rootLua.includes('elseif verb == "dogwait" then'), 'pollCommand 没有 dogwait 分支');

  // ⚠️ isBlockMovement 在 IsoPlayer 上；behavior 只有 setter
  assert.ok(rootLua.includes('a:isBlockMovement'), '读封锁状态读错了对象');
  assert.ok(!rootLua.includes('b:isBlockMovement'), 'behavior 对象上没有这个 getter');
});

test('前向声明的函数，定义必须用 `function X`，不能用 `local function X`', () => {
  // 这是本项目最贵的一类 bug，踩了三次（isBusy、queueLook/queueEquip、和这一次九个）：
  //
  //   local foo                 -- 前向声明，pollCommand 能看到它
  //   ...
  //   local function foo() end  -- ❌ 又造了一个新的 local，前面的还是 nil
  //   function foo() end        -- ✅ 赋值给前面那个 local
  //
  // 症状是「指令发出去、回执 crash、游戏不崩」——
  // 因为 pollCommand 整个裹在 pcall 里，调 nil 抛的错被外层吞了。
  //
  // 2026-11-08 一次中了九个：squadList / squadOrder / menuList / menuPick /
  // humanSpawn / dogEnsure / dogGoto / dogWait / dogFree。
  // 也就是说 `squad` / `order` / `menu` / `pick` / `dog*` 五个动词从来没工作过。
  const declared = [...rootLua.matchAll(/^local ([A-Za-z_]\w*)$/gm)].map((m) => m[1]);
  assert.ok(declared.length > 0, '一个前向声明都没找到？检查正则');

  const broken = [];
  for (const name of declared) {
    const asLocalFn = new RegExp('^local function ' + name + '\\b', 'm');
    if (asLocalFn.test(rootLua)) broken.push(name);
  }
  assert.deepEqual(broken, [],
    '这些函数有前向声明却又用 local function 定义，pollCommand 里拿到的是 nil：' + broken.join(', '));

  // 反过来也要有：声明了就得真的定义（用 function X）
  const missing = [];
  for (const name of declared) {
    const asFn = new RegExp('^function ' + name + '\\b', 'm');
    if (!asFn.test(rootLua)) missing.push(name);
  }
  assert.deepEqual(missing, [], '这些前向声明没有对应的 function 定义：' + missing.join(', '));
});
