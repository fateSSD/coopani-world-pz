--[[ ==========================================================================
     Coopani Bridge · 僵尸毁灭工程 → 桌面伴侣

     只做一件事：把「玩家此刻怎么样」写成一个 JSON 文件，
     放在 <存档根>/Lua/coopani-pz/state.json，等外面的桌面伴侣来读。

     它不改游戏规则、不生成物品、不加 UI —— 关掉它，游戏跟没装一样。

     四条硬规矩（每条都对应一个能让人查半天的坑）：

     1. 每个 API 都包 pcall。B42 动过一批签名，某个字段取不到不该让整份文件
        写不出来 —— 那样外面只能看到「数据停了」，查不出是哪个字段坏了。

     2. 取不到就是 -1，不是 0。0 是合法读数（「身上真没绷带」），
        -1 才表示「我不知道」。外面按这两种分开说话，混在一起就会
        把「没读到」说成「你没有」，然后她会催你去捡一个你其实有的东西。

     3. 写文件失败不许抛错。宁可这一拍不写，也不能把游戏的 tick 打断。

     4. 不做逐条事件推送。杀僵尸、掉血这类高频事实在 flush 里按增量合并成
        「一条 + 计数」，否则一场尸潮能写出几百条，外面读到的是刷屏。
   =========================================================================== ]]

CoopaniBridge = CoopaniBridge or {}

local B = CoopaniBridge

B.VERSION = 1
-- B42.20 起 getFileWriter 只允许 ini/cfg/txt/log 这几种扩展名（官方 changelog）。
-- 用 .json 属于踩线：现在能写，下次更新就可能静默失败。内容仍是 JSON。
B.OUT_FILE = "coopani-pz-state.txt"

-- 注意：这里**不要**在加载期抓 `CharacterStat` 的快照。
-- 枚举值的读取全部挪到 ensureEnums() 里做 —— 原因见那个函数上方的注释：
-- 访问一个不存在的静态字段会当场抛，而这会带崩整个 readPlayer。

local MAX_EVENTS = 40       -- 环形缓冲：外面掉线时只留最近这些
local GEAR_EVERY = 10       -- 每 10 次 flush 重扫一次背包（扫背包是这里最贵的一步）

local seq = 0
local events = {}
local session = nil
local kills = 0
local tickCount = 0
-- 每个事件各自的调用计数。声明在这里（不能放在心跳段），因为 buildJson 会读它。
local HB = {}
local flushCount = 0
local prev = { health = nil, infected = nil, night = nil }
local gearCache = nil
local lootCache = nil
local lootSig = ''      -- 上次扫的是哪个容器（类型@坐标）
local lootScanAt = 0    -- 上次完整扫描发生在第几拍

-- ---------------------------------------------------------------- 小工具

local function safe(fn, d)
    local ok, v = pcall(fn)
    if not ok then return d end
    if v == nil then return d end
    return v
end

local function num(v)
    if type(v) == "number" then return v end
    return nil
end

--- 取不到就是 nil，最后渲染成 null 或 -1，绝不兜成 0。
local function probe(fn)
    return num(safe(fn, nil))
end

--- 同一个取不到的东西，**这辈子只试一次**。
---
--- 为什么需要：`pcall` 能接住异常，但接不住日志 —— Kahlua 每抛一次就往 console
--- 打一整段堆栈。而 readPlayer 是每拍都跑的，于是一个在 42.20 里被删掉的方法
--- 就能把控制台刷到两千多条（`sq:getBuilding()` 就是这么干的）。
---
--- 所以：抛过一次就记进 `deadCalls`，以后直接返回 nil，一个字节的日志都不再产生。
--- 代价是如果某次是偶发失败，这个字段这一局就没了 —— 它本来就只是锦上添花的信息。
local deadCalls = {}
local function once(key, fn)
    if deadCalls[key] then return nil end
    local ok, v = pcall(fn)
    if not ok then
        deadCalls[key] = true
        -- 这里不能调 diag：它在下面才声明，此刻还是 nil，调用会抛第二个异常。
        pcall(function()
            print("[CoopaniBridge] getter unavailable, will not retry: " .. tostring(key))
        end)
        return nil
    end
    if v == nil then return nil end
    return v
end

-- 只打前几条，别把 console.txt 刷满。全用 ASCII —— 日志是 GBK，中文会变乱码。
local diagCount = 0
local function diag(msg)
    if diagCount >= 8 then return end
    diagCount = diagCount + 1
    pcall(function() print("[CoopaniBridge] " .. tostring(msg)) end)
end

local function n4(v)
    if type(v) ~= "number" then return "null" end
    if v ~= v then return "null" end
    if v == math.huge or v == -math.huge then return "null" end
    return string.format("%.4f", v)
end

local function ni(v)
    if type(v) ~= "number" or v ~= v then return "null" end
    return string.format("%d", v)
end

local function nbool(v)
    if v == true then return "true" end
    if v == false then return "false" end
    return "null"
end

--- JSON 字符串。这个环境里没有 cjson，手写转义是唯一可靠的路。
local function q(s)
    s = tostring(s)
    s = s:gsub("\\", "\\\\")
    s = s:gsub('"', '\\"')
    s = s:gsub("\n", "\\n")
    s = s:gsub("\r", "\\r")
    s = s:gsub("\t", "\\t")
    -- 其余控制字符（0x00–0x1F）全部转成 \u00XX。
    --
    -- 真机事故：`why` 里漏进了一个 0x1F 和一个 0x08，整份 state 变成**非法 JSON**，
    -- 外面解析失败，她只能说「读到半截 JSON」—— 而数据其实一个字段都没少。
    -- 这种字节从哪来：Kahlua 的词法器**把源码里的非 ASCII 字符截成单字节**，
    -- 于是中文原因字符串变成一串乱码，里面就夹着控制字节。
    -- 所以两道防线：这里兜住「JSON 必须合法」，原因字符串一律改用 ASCII 码（见 ack）。
    s = s:gsub("%c", function(c) return string.format("\\u%04x", string.byte(c)) end)
    return '"' .. s .. '"'
end

--- 毫秒时钟。getTimestamp 有就用，没有就按帧数估。
local function nowMs()
    local t = probe(getTimestamp)
    if t then return t end
    tickCount = tickCount + 1
    return tickCount * 16
end

-- ---------------------------------------------------------------- 事件队列

local function push(kind, extra)
    seq = seq + 1
    events[#events + 1] = { n = seq, t = kind, a = extra or {} }
    while #events > MAX_EVENTS do
        table.remove(events, 1)
    end
end

local function encodeEvents()
    local out = {}
    for i = 1, #events do
        local e = events[i]
        local parts = {}
        local keys = {}
        for k in pairs(e.a) do keys[#keys + 1] = k end
        table.sort(keys)                      -- 顺序固定，外面比对时不会每次都变
        for _, k in ipairs(keys) do
            local v = e.a[k]
            if type(v) == "string" then
                parts[#parts + 1] = q(k) .. ":" .. q(v)
            elseif type(v) == "number" then
                parts[#parts + 1] = q(k) .. ":" .. n4(v)
            end
        end
        out[#out + 1] = '{"n":' .. e.n .. ',"t":' .. q(e.t) .. ',"a":{' .. table.concat(parts, ",") .. "}}"
    end
    return "[" .. table.concat(out, ",") .. "]"
end

-- ---------------------------------------------------------------- 读游戏状态

local function getPlayerSafe()
    -- mod 沙箱里这几个取玩家的函数，签名不一定和 vanilla 里一样。
    -- `getPlayer()` 无参在 mod 环境返回 nil（真机实测 hasP 一直是 false），
    -- 所以带 index 的几种都试一遍，谁先给对象就用谁。
    local p = safe(function() return getPlayer(0) end, nil)
    if p then return p end
    p = safe(function() return getSpecificPlayer(0) end, nil)
    if p then return p end
    p = safe(function() return getPlayer() end, nil)
    if p then return p end
    -- Java 静态方法。vanilla 的 DebugContextMenu.lua 就是这么拿的。
    p = safe(function() return IsoPlayer.getInstance() end, nil)
    if p then return p end
    -- 再从世界里翻：如果世界对象拿得到、里面却没有人，说明脚本跑在服务端那一侧。
    local cell = safe(function() return getCell() end, nil)
    if cell then
        p = safe(function() return cell:getPlayerList():get(0) end, nil)
        if p then return p end
    end
    return nil
end

local function readClock()
    local gt = safe(function() return getGameTime() end, nil)
    if not gt then return nil end
    local hour = probe(function() return gt:getHour() end)
    local minute = probe(function() return gt:getMinutes() end)
    local hours = probe(function() return gt:getWorldAgeHours() end)
    if hour == nil and hours == nil then return nil end
    local day = nil
    if hours then day = math.floor(hours / 24) + 1 end
    local night = safe(function() return gt:isNight() end, nil)
    if type(night) ~= "boolean" then
        -- isNight 取不到时按钟点估。PZ 的日落随季节和纬度变，
        -- 所以这个兜底只用来「别把深夜说成白天」，不用来报准确日出。
        if hour then night = (hour >= 21 or hour < 6) end
    end
    return { hour = hour, minute = minute, day = day, night = night }
end

--- `sq:getRoom()` / `sq:getBuilding()` 这类取名字的调用，走 once ——
--- 删掉的方法只试一次，之后安静返回 nil，不再刷 console。
local function squareText(key, fn)
    local obj = once(key, fn)
    if not obj then return nil end
    local name = once(key .. ":name", function() return obj:getName() end)
    if name == nil or name == "" then return nil end
    return tostring(name)
end

--[[
    这三张表必须声明在 `stat` / `statOnce` / `normNeed` **前面**。

    真机事故（mod 1.2.15）：原来它们写在文件靠后的位置（第 301 行），
    而 `normNeed` 在第 262 行 —— Lua 只在**声明之后**的代码里把名字绑成 upvalue，
    写在后面的 `local` 对前面的函数根本不存在。于是 `normNeed` 里的 `ENUM_RANGE`
    变成了**全局变量**，运行时是 nil：

        attempted index: boredom of non-table: null

    后果不是「一项读不到」，是**每一项属性每拍都抛一次**（hunger / thirst / panic …全 null），
    而且 Kahlua 每抛一次打一整段堆栈 —— console 瞬间被刷满。
    外面看到的是「她好像瞎了」，日志里是成百上千行 ERROR。

    判据：**Lua 的 local 不是「文件级」，是「声明点之后」**。函数用到的表，
    声明必须在函数之前，否则它悄悄变成全局 nil，静态检查也看不出来。
-- ]]

local ENUM = {}
-- 每个 stat 自己的取值范围。**量纲不统一**：hunger / thirst 是 0..1，
-- 而 pain / panic 是 0..100（游戏调试面板给这两项写的滑条步长是 1，那是给整数用的）。
-- 所以不能拿同一套 0..1 的阈值去套所有项 —— 真机就是这么把 1.9 的疼痛
-- 说成「190%」「疼到影响动作了」的，而 1.9 在 0..100 里几乎无感。
local ENUM_RANGE = {}
local enumsReady = false

--- 读一个角色属性。新接口优先，失败再退回旧 getter。
--- 两代接口的差异不该让外面看到「未知」——它对「没读到」和「真的没有」是分开处理的。
local function stat(st, enumVal, legacyFn)
    if not st then return nil end
    if enumVal ~= nil then
        local v = probe(function() return st:get(enumVal) end)
        if v ~= nil then return v end
    end
    if legacyFn ~= nil then return probe(legacyFn) end
    return nil
end

--- 读一个**这份构建里不一定存在**的属性。
---
--- 和上面的 stat() 差别只在最后一步：stat 每拍都试，偶发失败下一拍还能恢复；
--- 而这里读的是 `CharacterStat.PANIC` 这种**可能整条枚举都缺**的键。
--- 真缺的时候 `st:get(nil)` 会抛异常，而 Kahlua 每抛一次就往 console 打一整段堆栈，
--- 一秒二十条 —— probe 只把结果吞成 nil，日志照打（`getInfectionLevel` 那次就是这么刷了 2680 行）。
--- 所以走 once：抛过一次就永久返回 nil，一个字节的日志都不再产生。
---
--- 代价是偶发失败会让这个字段这一局都没有。它只是锦上添花的心情读数，值得。
local function statOnce(st, enumVal, key)
    if not st or enumVal == nil then return nil end
    local v = once('stat.' .. key, function() return st:get(enumVal) end)
    if type(v) == 'number' then return v end
    return nil
end

--- 把一项 stat 归一到 0..1，**按它自己的量纲**。
---
--- 这一步不能省。原始 `get(CharacterStat.X)` 的量纲是混的：
--- hunger / thirst / fatigue / endurance 是 0..1，pain / panic 是 0..100。
--- 证据是游戏自己的调试菜单：`ISStatsAndBody.lua` 给 PAIN / PANIC 传的滑条步长是 1，
--- 给 HUNGER 用默认的 0.01 —— 步长要能走满整个区间，只能是 0..100 vs 0..1。
---
--- 不归一的后果是真机实测过的：疼痛 1.9（在 0..100 里几乎不痛）被外面按 0..1 读成 190%，
--- 于是她说「疼到影响动作了」。**同一个数字，量纲错了，话就反了。**
local function normNeed(key, v)
    if type(v) ~= 'number' then return nil end
    local r = ENUM_RANGE[key]
    if r and r.hi > r.lo then
        local x = (v - r.lo) / (r.hi - r.lo)
        if x < 0 then return 0 end
        if x > 1 then return 1 end
        return x
    end
    -- 拿不到范围（这个构建没有 getMaximumValue）：按数值大小兜底。
    -- 0..1 的比值不会超过 1.5；超过了就说明是 0..100 那一路。
    if v > 1.5 then return v / 100 end
    if v < 0 then return 0 end
    return v
end

-- ---------------------------------------------------------------- 枚举缓存

--[[
    `CharacterStat` 的所有枚举值，**一次性、包在 pcall 里**取出来，之后只查这张表。

    为什么非得这样 —— 别人的机器上就是这么挂的：

        CS.PANIC 在某个构建里不存在。Kahlua 遇到不存在的 Java 静态字段，
        不是返回 nil，而是**当场抛** `Object tried to call nil in readPlayer`。

    致命的地方在于**抛的时机**：`statOnce(st, CS and CS.PANIC, 'panic')` 里的
    `CS.PANIC` 是函数**参数求值**的一部分，那时 `statOnce` 还没进函数体，
    里面的 pcall 根本不存在。异常直接穿出 readPlayer → flush，
    整份 state 一个字节都写不出来，外面看到的是「桥接 mod 加载时报错了」。

    原来的 HUNGER/THIRST/… 没暴露，只是因为它们在所有构建里恰好都存在。
    只要加一个不认识的名字，整个桥接就哑了 —— 这个耦合必须拆掉。

    现在：第一次读玩家时才取（加载期 CharacterStat 可能还没初始化），
    每个字段访问各包一层 pcall，取不到就永远记住「没有」，
    readPlayer 从此不再碰 Java 类的静态字段。
-- ]]

local function ensureEnums()
    if enumsReady then return end
    enumsReady = true

    local cs = CharacterStat      -- 延迟到这里取，别用文件顶部那个加载期的快照
    if cs == nil then return end

    local function take(key, fn)
        local ok, v = pcall(fn)
        if ok and v ~= nil then ENUM[key] = v end
        -- 取不到不记日志：这是「这个构建没这个名字」，属于正常差异，不是故障。
    end

    take('hunger', function() return cs.HUNGER end)
    take('thirst', function() return cs.THIRST end)
    take('fatigue', function() return cs.FATIGUE end)
    take('endurance', function() return cs.ENDURANCE end)
    take('stress', function() return cs.STRESS end)
    take('infection', function() return cs.ZOMBIE_INFECTION end)
    take('panic', function() return cs.PANIC end)
    take('pain', function() return cs.PAIN end)
    take('boredom', function() return cs.BOREDOM end)
    take('unhappy', function() return cs.UNHAPPINESS end)

    -- 量纲也一次性取：枚举对象自己带 min/max，比自己猜靠谱。
    -- 取不到就不记 —— 下面归一时退回按数值大小兜底。
    local function range(key)
        local e = ENUM[key]
        if e == nil then return end
        local okLo, lo = pcall(function() return e:getMinimumValue() end)
        local okHi, hi = pcall(function() return e:getMaximumValue() end)
        if okLo and okHi and type(lo) == 'number' and type(hi) == 'number' and hi > lo then
            ENUM_RANGE[key] = { lo = lo, hi = hi }
        end
    end
    range('hunger')
    range('thirst')
    range('fatigue')
    range('endurance')
    range('stress')
    range('panic')
    range('pain')
    range('boredom')
    range('unhappy')
end

--[[
    `readPlayer` 里任何一处抛出，都会穿出 `flush` —— 整份 state 一个字节写不出来，
    外面看到的是「桥接 mod 报错了」，而真实原因可能只是「这个构建没有这个字段」。

    更阴的是：抛出**不在函数体里，而是在表达式求值时**，那里外面的 pcall 还没建立。

        statOnce(st, CS.PANIC, 'panic')     -- CS.PANIC 在参数阶段求值
        Perks and Perks[it.perk]            -- Java 类的字符串索引
        if next(sk) then                    -- next 在部分构建里是 nil

    这三处看着都「包了 pcall」，实际一层都没包住。0.4.7 / 0.4.8 连栽在这上面：
    别人机器上缺一个枚举，整份 state 就写不出来；本机又因为枚举齐全而完全看不见。

    所以不再赌「哪一句安全」——**按段隔离**。某一段抛了只丢那一段，
    并把段名打一次进 console：下次出问题日志里直接有答案，不用再靠猜和要日志。
-- ]]

local failSeen, failCount = {}, 0

local function step(name, fn)
    local ok, v = pcall(fn)
    if ok then return v end
    if not failSeen[name] and failCount < 8 then
        failSeen[name] = true
        failCount = failCount + 1
        pcall(function()
            print("[CoopaniBridge] readPlayer step failed: " .. tostring(name)
                .. " | " .. tostring(v))
        end)
    end
    return nil
end

local function readPlayer(p)
    ensureEnums()

    local out = {}
    local st = step('stats', function() return p:getStats() end)
    local bd = step('body', function() return p:getBodyDamage() end)
    local sq = step('square', function() return p:getCurrentSquare() end)

    step('pos', function()
        out.x = probe(function() return p:getX() end)
        out.y = probe(function() return p:getY() end)
        out.z = probe(function() return p:getZ() end)
        out.outside = safe(function() return p:isOutside() end, nil)
    end)

    if sq then
        -- 不读 building：`sq:getBuilding():getName()` 在 42.20 会抛异常，
        -- 而这条信息对陪玩几乎没用（房间名已经够了）。删掉它，控制台就彻底干净了。
        out.room = step('room', function()
            return squareText("sq.getRoom", function() return sq:getRoom() end)
        end)
    end

    -- B42 把角色属性搬到了 `getStats():get(CharacterStat.X)`。
    -- 旧的 `st:getHealth()` / `st:getHunger()` 在 42.20 上**直接抛异常**。
    -- 每项单独 step：某一项在这个构建里不存在，只丢这一项。
    if st then
        local function need(key, legacy)
            out[key] = step(key, function() return normNeed(key, stat(st, ENUM[key], legacy)) end)
        end
        -- 心情四项走 statOnce：它们的枚举在有些构建里存在、但 `st:get()` 不接受，
        -- 那种情况每拍都会抛一次（probe 只吞结果、不吞日志），一秒刷二十条。
        local function needOnce(key)
            out[key] = step(key, function() return normNeed(key, statOnce(st, ENUM[key], key)) end)
        end
        need('hunger', function() return st:getHunger() end)
        need('thirst', function() return st:getThirst() end)
        need('fatigue', function() return st:getFatigue() end)
        need('endurance', function() return st:getEndurance() end)
        need('stress', function() return st:getStress() end)
        needOnce('panic')
        needOnce('pain')
        needOnce('boredom')
        needOnce('unhappy')
        out.visible = step('visible', function() return st:getNumVisibleZombies() end)
    end

    if bd then
        out.infected = step('infected', function() return bd:isInfected() end)
        -- 别用 `bd:getInfectionLevel()`：42.20 里这个方法已经没了，调用会抛异常，
        -- 而 Kahlua 每抛一次就打一整段堆栈（真机刷了 2680 行 ERROR）。
        -- 感染度走 CharacterStat.ZOMBIE_INFECTION，拿不到就留空。
        out.infection = step('infection', function() return stat(st, ENUM.infection, nil) end)
        -- 血量在 B42 归 BodyDamage，是 0..100。外面按 0..1 用，这里换算好。
        local hp100 = step('health', function() return bd:getHealth() end)
        if type(hp100) == 'number' then out.health = hp100 / 100 end
        out.bodyHealth = step('bodyHealth', function() return bd:getOverallBodyHealth() end)
    end

    -- 技能等级。B42 的技能挂在 `Perks` 上，用 `getPerkLevel` 读。
    -- 只收「读到了」的项，读不到的干脆不写 —— 外面按「未知」处理，别当成 0 级。
    local PERK_KEYS = {
        { key = 'woodwork', perk = 'Woodwork' },
        { key = 'cooking', perk = 'Cooking' },
        { key = 'doctor', perk = 'Doctor' },
        { key = 'electricity', perk = 'Electricity' },
        { key = 'tailoring', perk = 'Tailoring' },
        { key = 'farming', perk = 'Farming' },
        { key = 'maintenance', perk = 'Maintenance' },
        { key = 'blunt', perk = 'Blunt' },
    }
    local sk = {}
    local skN = 0
    for _, it in ipairs(PERK_KEYS) do
        -- `Perks[it.perk]` 是 Java 类的字符串索引，自己也可能抛 —— 单独包。
        local enum = step('perk.' .. it.key, function()
            if Perks == nil then return nil end
            return Perks[it.perk]
        end)
        if enum then
            local lvl = once('perk.' .. it.key, function() return p:getPerkLevel(enum) end)
            if type(lvl) == 'number' then
                sk[it.key] = lvl
                skN = skN + 1
            end
        end
    end
    -- 不用 `next()`：Kahlua 的标准库不全，`next` 在部分构建里是 nil，
    -- 而 `if next(sk) then` 会当场抛 —— 又是「表达式求值逃出 pcall」那一类。
    if skN > 0 then out.skills = sk end

    step('hands', function()
        local prim = safe(function() return p:getPrimaryHandItem() end, nil)
        if prim then
            out.weapon = safe(function() return prim:getName() end, nil)
            out.weaponCond = probe(function() return prim:getCondition() end)
            out.weaponMax = probe(function() return prim:getConditionMax() end)
            -- 判断「这把好不好使」要的三项：伤害、攻击距离、是否双手。
            -- 走 once 而不是 probe：这几个方法在某个构建里没有的话，
            -- probe 会每拍抛一次（Kahlua 每抛一次打一整段堆栈），一秒刷二十条。
            local si = safe(function() return prim:getScriptItem() end, nil)
            if si then
                out.weaponDmg = once('si.dmg', function() return si:getMaxDamage() end)
                out.weaponRng = once('si.rng', function() return si:getMaxRange() end)
                -- ⚠️ `isTwoHandWeapon()` 在**物品**上（InventoryItem），不在脚本项上。
                -- 挂在 `si` 上调过一次，真机刷了 6 段空消息堆栈 —— 而且完全没用：
                -- 错的对象 + 错的方法名，两个都错，是一起错的那种。
                out.weaponTwo = once('it.two', function() return prim:isTwoHandWeapon() end)
            end
        end
        local sec = safe(function() return p:getSecondaryHandItem() end, nil)
        if sec then
            out.offhand = safe(function() return sec:getName() end, nil)
        end
    end)

    return out
end

--- 扫背包。三类东西够用：能包扎的、能吃的、能点的。
--- 扫不出来返回 nil，外面显示「不知道」，不显示 0。
local function readGear(p)
    local inv = safe(function() return p:getInventory() end, nil)
    if not inv then return nil end
    local items = safe(function() return inv:getItems() end, nil)
    if not items then return nil end
    local size = probe(function() return items:size() end)
    if not size then return nil end

    local bandage, food, water, light = 0, 0, 0, 0
    for i = 0, size - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local t = safe(function() return it:getType() end, "")
            if type(t) == "string" then
                if t:find("Bandage") or t:find("RippedSheets") or t:find("DirtyBandage") then
                    bandage = bandage + 1
                end
                if t:find("Torch") or t:find("Lighter") or t:find("Matches") or t:find("Candle") then
                    light = light + 1
                end
            end
            if safe(function() return it:isFood() end, false) == true then
                food = food + 1
            end
            local fd = safe(function() return it:getFluidContainer() end, nil)
            if fd then
                local amt = probe(function() return fd:getAmount() end)
                if amt and amt > 0 then water = water + 1 end
            end
        end
    end

    return { bandage = bandage, food = food, water = water, light = light }
end

-- ---------------------------------------------------------------- 正在翻的容器

--[[
    「他打开的那个柜子里有没有值得停一下的东西」。

    这一段的边界必须先说清楚，否则它就是外挂：

    * 只读**他已经打开的那一个容器**（`getPlayerLoot(0).inventory`）。
      没有打开任何容器时返回 nil —— 不预告没去过的房间，不扫地图。
    * 只报**装备和工具**，不报消耗品。绷带、吃的、水那些 `pz_tips` 已经在管了，
      翻个柜子就念一遍「这里有绷带」，会把真正值钱的那句盖掉。
    * 宁缺勿错。把一根椅子腿说成神器，比漏说十把斧头更丢人。

    为什么用物品内部名而不是分类：B42 的物品分类横跨两代接口
    （`getCategory()` 走 Item 定义的 Category，`isItemType(ItemType.X)` 是另一套枚举），
    而**内部名**（Sledgehammer / BaseballBat）十几年没变过。
-- ]]

--- 值得停一下的东西。tier 3 = 这一局最该先拿的，2 = 好东西，0 = 不提。
local WANTED = {
    { tier = 3, words = { 'Sledgehammer', 'Generator', 'HowToUseGenerators' } },
    { tier = 2, words = {
        -- 武器
        'Axe', 'Crowbar', 'Machete', 'Katana', 'BaseballBat', 'SpikedBat', 'PickAxe',
        'WoodAxe', 'HandAxe', 'FireAxe', 'Nightstick', 'PipeWrench', 'Shovel', 'Pitchfork',
        'MeatCleaver', 'KitchenKnife', 'HuntingKnife', 'FryingPan', 'Saucepan', 'RollingPin',
        -- 工具
        'Hammer', 'Saw', 'Screwdriver', 'Wrench', 'Pliers', 'DuctTape', 'WoodGlue',
        -- 光源
        'Torch', 'Lantern', 'Lighter', 'Matches', 'Candle',
        -- 车
        'CarKey', 'KeyRing',
    } },
}

--- 背包按后缀判，别用子串 —— 'Bag' 会把 Bagel（面包）和 BagOfChips（薯片）一起捞进来。
local function isBag(low)
    return low:sub(-3) == 'bag' or low:find('backpack', 1, true) ~= nil
end

--[[
    这件东西值不值得停一下。返回 3 / 2 / 1 / 0。

    真机第一版只按名字白名单判，结果翻到的柜台里躺着**农业杂志**（`Literature` /
    `RecipeResource`）也认不出来 —— 而那正是前期最该拿的东西：读书能涨技能，
    比一堆罐头值钱。所以现在**先看分类，再看名字**。

    分类来自 `getCategory()` / `getDisplayCategory()`，真机打出来的原文长这样：
        漫畫書: 規定者/Literature/Literature
        農業雜誌5: 美國農場/Literature/RecipeResource
        毛巾/Item/Household
        叉子/Weapon/CookingWeapon

    1 档是「材料/可撕」这类，报不报由外面按处境定（他没绷带时毛巾就是命）。
-- ]]
local function tierOf(name, typ, cat, disp)
    local lowName = tostring(name or ''):lower()
    local catLow = tostring(cat or ''):lower()
    local dispLow = tostring(disp or ''):lower()
    local low = lowName ~= '' and lowName or tostring(typ or ''):lower()

    -- 书和杂志：前期最值钱的一类，读书直接涨技能。放最前面，别被后面的规则吃掉。
    if catLow == 'literature' or dispLow == 'literature' or dispLow == 'reciperesource' then
        return 2
    end
    if dispLow == 'container' or catLow == 'container' then return 2 end
    -- 可撕的东西：没绷带时这几样就是命。
    if dispLow == 'household' or dispLow == 'materialweapon' then return 1 end
    if low:find('towel', 1, true) or low:find('curtain', 1, true) or low:find('sheet', 1, true) then
        return 1
    end

    if low == '' then return 0 end
    if isBag(low) then return 2 end
    for _, g in ipairs(WANTED) do
        for _, w in ipairs(g.words) do
            if low:find(w:lower(), 1, true) then return g.tier end
        end
    end
    return 0
end

--- 白名单是我猜的，得让他真机翻一个柜子来核对。
---
--- 第一次扫到容器时，把里面前几件东西的 `getName / getCategory / getDisplayCategory`
--- 和 tierOf 的判定一起打进 console.txt。只打一次，全 ASCII（日志是 GBK，中文会乱码）。
--- 拿到这一行就能看出白名单认没认对，不用再猜一轮。
local lootDiagDone = false
local function diagLoot(items, size)
    if lootDiagDone then return end
    lootDiagDone = true
    local shown = {}
    local n = math.min(size, 6)
    for i = 0, n - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local nm = safe(function() return it:getName() end, '?')
            local cat = safe(function() return it:getCategory() end, '?')
            local disp = safe(function() return it:getDisplayCategory() end, '?')
            shown[#shown + 1] = tostring(nm) .. '/' .. tostring(cat) .. '/' .. tostring(disp)
                .. '=t' .. tostring(tierOf(nm, nil, cat, disp))
        end
    end
    pcall(function()
        print("[CoopaniBridge] loot sample (n=" .. ni(size) .. "): " .. table.concat(shown, " | "))
    end)
end

--- 读他正打开着的那个容器。没开任何容器就返回 nil（不是空表 —— 两件事不一样）。
---
--- `getPlayerLoot` 是 UI 层函数（`client/ISUI/PlayerData/ISPlayerData.lua`），
--- 那个页面**一直存在**，没开容器时只是不可见。所以必须查 `isVisible()`：
--- 只判 `inventory ~= nil` 会在他走路时一直读到上次那个柜子。
--- 便宜的一半：只问「他此刻打开的是哪个容器」，**不碰里面的东西**。
---
--- 这一步只是两次 Java 取值，每拍都调得起。为什么要拆出来 ——
--- 原来整体每 3 拍才跑一次（约 6 秒），真机上就成了「他翻完柜子走了才报」：
--- 一个柜台他停留不了 6 秒。现在每拍问一次身份，换了才扫内容。
local function lootHandle()
    if type(getPlayerLoot) ~= 'function' then return nil end
    local page = safe(function() return getPlayerLoot(0) end, nil)
    if not page then return nil end
    -- 这个页面**一直存在**，没开容器时只是不可见。不查这一条会在走路时
    -- 一直读到上次那个柜子。
    if safe(function() return page:isVisible() end, false) ~= true then return nil end

    local cont = safe(function() return page.inventory end, nil)
    if not cont then return nil end
    local ctype = safe(function() return cont:getType() end, nil)
    -- 地上的东西不算「翻柜子」。而且 floor 容器的物品列表可能极大。
    if type(ctype) ~= 'string' or ctype == 'floor' then return nil end

    -- 容器身份：类型 + 所在格。**不要**把物品数量算进去 ——
    -- 他拿走一件 sig 就变，外面会当成「换了个柜子」再报一遍。
    local parent = safe(function() return cont:getParent() end, nil)
    local sig = ctype .. '@?'
    local px, py, oi = nil, nil, nil
    if parent then
        px = probe(function() return parent:getX() end)
        py = probe(function() return parent:getY() end)
        if px and py then sig = ctype .. '@' .. string.format("%d,%d", math.floor(px), math.floor(py)) end
        -- 容器是这一格上的第几个 object。外面下 take 指令时靠它定位 ——
        -- 光有坐标不够，一格上可能有三件能装东西的东西。
        local psq = safe(function() return parent:getSquare() end, nil)
        if psq then
            local objs = safe(function() return psq:getObjects() end, nil)
            local n = objs and probe(function() return objs:size() end)
            if n then
                for i = 0, n - 1 do
                    local o = nil
                    pcall(function() o = objs:get(i) end)
                    if o == parent then oi = i; break end
                end
            end
        end
    end
    return { cont = cont, ctype = ctype, sig = sig, x = px, y = py, oi = oi }
end

--- 贵的一半：遍历容器里的东西，认出值得停的。**只在换了容器时才跑。**
--- 这本书他读了还有没有用。
---
--- 判据**用游戏自己的**，不自己攒书名表：`ISInventoryPane:isLiteratureRead(player, item)`
--- 覆盖六种情况 ——
---   1. 页数读完了（`getAlreadyReadPages(fullType) >= getNumberOfPages()`）
---   2. 书里所有配方他都会了
---   3. 印刷媒体（报纸/传单）已经看过
---   4. **技能书的等级他早超过了**（`getMaxLevelTrained() < getPerkLevel(perk) + 1`）
---   5. modData 里记的 literatureTitle / printMedia 已读
---   6. 单条配方已学
---
--- 这几条自己判会漏（尤其第 4 条：等级超过的书，页数一条没读，但对他已经没用了）。
---
--- ⚠️ 这个函数来自 UI 模块（`client/ISUI/ISInventoryPane.lua`），而且内部会调一堆
--- 可能不存在的 Java 方法，所以：**第一次失败就永久退回只判页数**，不再每件物品抛一次
--- （Kahlua 每抛一次打一整段堆栈，一个柜子十几件就能刷满 console）。
local litCheckOk = nil    -- nil = 还没试过；false = 那个函数不能用，走兜底

local function literatureSpent(p, it)
    if not p then return false end

    if litCheckOk ~= false then
        local ok, v = pcall(function()
            if ISInventoryPane == nil then require "ISUI/ISInventoryPane" end
            if ISInventoryPane == nil or ISInventoryPane.isLiteratureRead == nil then
                return false
            end
            return ISInventoryPane.isLiteratureRead(p, it) == true
        end)
        if ok then
            litCheckOk = true
            if v == true then return true end
        else
            litCheckOk = false
            diag('isLiteratureRead unavailable, falling back to page count')
        end
    end

    -- 兜底：只判「读完页数」。少判几条，但不会误报。
    local n = select(2, pcall(function() return it:getNumberOfPages() end))
    if type(n) ~= 'number' or n <= 0 then return false end
    local read = select(2, pcall(function() return p:getAlreadyReadPages(it:getFullType()) end))
    if type(read) ~= 'number' then return false end
    return read >= n
end

local function scanLoot(h, p)
    local cont = h.cont
    local items = safe(function() return cont:getItems() end, nil)
    if not items then return nil end
    local size = probe(function() return items:size() end)
    if not size then return nil end

    diagLoot(items, size)

    -- 两份清单，缺一份她就没法自己动手：
    --   `hits` 是她**该提醒人**的（大锤、发电机这种）
    --   `all`  是这一格里**到底有什么**（前 10 件，不管好坏）
    --
    -- 只有 `hits` 的时候翻车过一次：柜台里躺着两样东西，`total = 2`、`hits = []`，
    -- 她从状态里只知道「柜里有 2 件、看不见是什么」，于是只能说
    -- 「柜子你帮我打开一个，我才能看到里头有什么」—— 而她自己本来就能拿。
    -- 挑食是给她判断用的，不是给她当眼睛用的。
    local hits, all = {}, {}
    local ALL_MAX = 10
    for i = 0, size - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local nm = safe(function() return it:getName() end, nil)
            local tp = safe(function() return it:getType() end, nil)
            -- 分类走 once：`getDisplayCategory` 在某个构建里没有的话，
            -- 每件物品都会抛一次，一个柜子就刷十几条堆栈。
            local cat = once('it.cat', function() return it:getCategory() end)
            local disp = once('it.disp', function() return it:getDisplayCategory() end)
            local tier = tierOf(nm, tp, cat, disp)
            -- 书和杂志：读过的（以及等级早超过的）就不要再提醒他拿了。
            -- 真机反馈：「读过的书还在提示」—— 那不是零食，是他已经消化的东西。
            local catLow = tostring(cat or ''):lower()
            local dispLow = tostring(disp or ''):lower()
            local isLit = catLow == 'literature' or dispLow == 'literature' or dispLow == 'reciperesource'
            if tier > 0 and isLit then
                -- 页数为 0 / 负数的「读物」不是书：空筆記本、記事本这种是拿来写的。
                -- 真机它把三本笔记本列成「值得停」，那不是她要提醒的东西。
                local pages = safe(function() return it:getNumberOfPages() end, nil)
                if type(pages) ~= 'number' or pages <= 0 then
                    tier = 0
                elseif literatureSpent(p, it) then
                    tier = 0
                end
            end
            -- 「是不是武器」必须看分类，**不能看伤害**。
            -- 真机翻车：抹布（Category=Item/Household）也有 MaxDamage = 1.5，
            -- 按伤害判的话，空手时它会被说成「拿了就能打」的武器。
            local isWeapon = tostring(cat or ''):lower() == 'weapon'
            -- 显示名走本地化，取不到就退回内部名。两份清单共用一次调用。
            local dn = nil
            if tier > 0 or #all < ALL_MAX then
                dn = safe(function() return it:getDisplayName() end, nil)
            end
            if #all < ALL_MAX then
                all[#all + 1] = { n = tostring(dn or nm or '?'), i = i, t = tier }
            end
            if tier > 0 then
                -- 顺手读一下伤害：外面要靠它判断「柜里这把是不是比手上的强」。
                -- 非武器返回 0，所以 >0 就是武器。once 只用来标「这个方法坏没坏」，
                -- 不缓存返回值，每件东西拿到的还是自己的数。
                local si = safe(function() return it:getScriptItem() end, nil)
                local dmg = nil
                if si then dmg = once('si.dmg', function() return si:getMaxDamage() end) end
                hits[#hits + 1] = {
                    n = tostring(dn or nm or '?'),
                    t = tier,
                    d = (type(dmg) == 'number' and dmg > 0) and dmg or nil,
                    w = isWeapon,
                    -- 在容器里的序号。外面下 take 指令要靠它指「第几件」。
                    i = i,
                }
            end
        end
    end
    table.sort(hits, function(a, b) return a.t > b.t end)
    while #hits > 6 do table.remove(hits) end

    return {
        sig = h.sig, type = h.ctype, total = size, hits = hits, all = all,
        x = h.x, y = h.y, oi = h.oi,
    }
end

-- ---------------------------------------------------------------- 让她自己动手

--[[
    这个桥原来只往外写。这一段让它也能收：外部写一行到 `coopani-pz-cmd.txt`，
    这里读出来，**用游戏自己的动作系统**执行。

    为什么不是模拟键鼠 —— 走路交给 `ISWalkToTimedAction`（引擎自己的寻路），
    拿东西交给 `ISInventoryTransferAction`（引擎自己的搬运）。寻路、碰撞、动画、
    体力消耗全由游戏负责，外面只管「去哪、拿什么」。社区里两个已经跑通的方案
    （PZBot 的 AISurvivorBridge、Kaplia 的语音队友）走的都是这条路，不是我们发明的。

    协议刻意不用 JSON：Kahlua 没有 cjson，手写个解析器等于多一处会崩的地方。
    一行一条，竖线分隔，**全 ASCII**：

        seq|verb|p1|p2|p3|p4|expire

        walk|x|y|stance          stance: walk / run / sneak
        face|x|y
        attack                   打身边最近的那只
        take|x|y|objIdx|itemIdx  容器所在格 + 它在格子里第几个 + 里面第几件
        stop

    seq 必须递增 —— 同一条指令读到第二次不再执行。
    expire 是 unix 秒 —— 她算出来的坐标可能是十秒前的世界，过期就丢，
    否则会出现「指令到了，人早就走开，角色还在往旧坐标跑」。
-- ]]

B.CMD_FILE = "coopani-pz-cmd.txt"

-- 已执行过的指令行。去重靠**行本身**，不靠 seq。
--
-- 只看 seq 会栽一次：桌面伴侣重启后 seq 从 1 重新开始，而游戏里记着的是上一轮的
-- 第 40 条 —— 于是新指令一条都「不大于已见」，全部被静默丢掉，表现是「她不动了」，
-- 而两边日志都干干净净。行内容变了就是一条新指令，这个判据不受重启影响。
--
-- 从「只记最后一行」换成「记一片」，是因为通道从单条变成了队列：
-- 她一个回合里会连下两三条，只记最后一条的话前面几条会被反复重读。
local cmdDone = {}
local cmdDoneOrder = {}
local CMD_DONE_MAX = 40
local cmdSeqSeen = 0

local function cmdMarkDone(line)
    if cmdDone[line] then return end
    cmdDone[line] = true
    cmdDoneOrder[#cmdDoneOrder + 1] = line
    while #cmdDoneOrder > CMD_DONE_MAX do
        local old = table.remove(cmdDoneOrder, 1)
        if old then cmdDone[old] = nil end
    end
end
B.CMD = nil            -- 最近一条指令的回执，buildJson 带出去
local attackArity = nil -- AttemptAttack 的实参个数，试一次记住（见下）

--- 读指令文件里的**所有**行。
---
--- 以前只读第一行。通道改成队列之后那样就只能看见最旧的一条 ——
--- 她连下的「开柜」「拿东西」永远读不到，表现是走一步就没了。
local function readCmdLines()
    local r = getFileReader(B.CMD_FILE, false)
    if not r then return nil end
    local out = {}
    pcall(function()
        local line = r:readLine()
        while line do
            if line ~= '' then out[#out + 1] = line end
            line = r:readLine()
        end
    end)
    pcall(function() r:close() end)
    return out
end

local function splitPipe(s)
    local out = {}
    local from = 1
    while true do
        local i = string.find(s, "|", from, true)
        if not i then
            out[#out + 1] = string.sub(s, from)
            break
        end
        out[#out + 1] = string.sub(s, from, i - 1)
        from = i + 1
    end
    return out
end

--- 攻击一下。
---
--- `AttemptAttack` 在 42.21 的方法表里是 `()Z`（无参），而社区里流传的写法是
--- `AttemptAttack(0.5)`。两种写法都可能撞上，所以**第一次试出来就记住**，
--- 之后不再反复抛 —— Kahlua 每抛一次都往 console 打一整段堆栈。
local function tryAttack(p)
    if attackArity == nil then
        if pcall(function() return p:AttemptAttack() end) then
            attackArity = 0
        elseif pcall(function() return p:AttemptAttack(0.5) end) then
            attackArity = 1
        else
            attackArity = -1
            diag('AttemptAttack arity probe failed for both forms')
        end
    end
    if attackArity == 0 then return pcall(function() return p:AttemptAttack() end) end
    if attackArity == 1 then return pcall(function() return p:AttemptAttack(0.5) end) end
    return false, 'attack-unavailable'
end

--- 身边最近的僵尸。半径用平方比，省开方。
local function nearestZombie(p, maxTiles)
    local list = nil
    if not pcall(function() list = getCell():getObjectListForLua() end) then return nil end
    if not list then return nil end
    local n = 0
    if not pcall(function() n = list:size() end) then return nil end
    local best, bestD = nil, maxTiles * maxTiles
    for i = 0, n - 1 do
        local z = nil
        pcall(function() z = list:get(i) end)
        if z and instanceof(z, "IsoZombie") then
            local dx = z:getX() - p:getX()
            local dy = z:getY() - p:getY()
            local d = dx * dx + dy * dy
            if d < bestD then best, bestD = z, d end
        end
    end
    return best
end

--- 站到容器旁边。柜子本身不能站，所以在一圈空格里挑一个。
---
--- ⚠️ 不能"取第一个能站的"：真机上她拿毛巾时被派到**院子里**去了 ——
--- 衣柜贴着外墙，按固定顺序扫到的第一个空格在墙外面。走过去就是绕出屋再绕回来。
---
--- 现在的判据按优先级排：
---   1. 和玩家同一侧（都在屋里 / 都在屋外）—— 这一条最要紧，跨墙就是绕远路
---   2. 离玩家近
--- 用平方距离，不开方。
local function adjacentSquare(sq, p)
    local dirs = { {0,-1}, {0,1}, {1,0}, {-1,0}, {1,-1}, {-1,-1}, {1,1}, {-1,1} }
    local wantInside = safe(function() return sq:isInside() end, nil)
    local px = p and safe(function() return p:getX() end, nil) or nil
    local py = p and safe(function() return p:getY() end, nil) or nil

    local best, bestScore = nil, nil
    for _, off in ipairs(dirs) do
        local nx, ny = sq:getX() + off[1], sq:getY() + off[2]
        local n = getCell():getGridSquare(nx, ny, sq:getZ())
        if n and n:isFree(false) then
            local inside = safe(function() return n:isInside() end, nil)
            local score = 0
            if wantInside ~= nil and inside ~= nil and inside ~= wantInside then score = score + 10000 end
            if px and py then
                local dx, dy = nx - math.floor(px), ny - math.floor(py)
                score = score + dx * dx + dy * dy
            end
            if bestScore == nil or score < bestScore then best, bestScore = n, score end
        end
    end
    return best
end

local function queueWalk(p, x, y, stance)
    if not ISWalkToTimedAction then require "TimedActions/ISWalkToTimedAction" end
    if not ISTimedActionQueue then require "TimedActions/ISTimedActionQueue" end
    if not ISWalkToTimedAction or not ISTimedActionQueue then return false, 'no-actions' end

    local sq = getCell():getGridSquare(math.floor(x), math.floor(y), math.floor(p:getZ()))
    if not sq then return false, 'no-square' end

    ISTimedActionQueue.clear(p)
    p:setRunning(stance == "run")
    p:setSneaking(stance == "sneak")
    p:setIsAiming(false)
    ISTimedActionQueue.add(ISWalkToTimedAction:new(p, sq))
    return true
end

local function queueTake(p, x, y, objIdx, itemIdx)
    if not ISInventoryTransferAction then require "TimedActions/ISInventoryTransferAction" end
    if not ISTimedActionQueue then require "TimedActions/ISTimedActionQueue" end
    if not ISInventoryTransferAction or not ISTimedActionQueue then return false, 'no-actions' end

    local sq = getCell():getGridSquare(math.floor(x), math.floor(y), math.floor(p:getZ()))
    if not sq then return false, 'no-square' end
    local objs = sq:getObjects()
    if not objs then return false, 'empty-square' end
    local obj = objs:get(objIdx)
    if not obj then return false, 'bad-obj:' .. tostring(objIdx) end
    local cont = obj:getContainer()
    if not cont then return false, 'no-container' end
    local items = cont:getItems()
    if not items then return false, 'no-items' end
    local item = items:get(itemIdx)
    if not item then return false, 'bad-item:' .. tostring(itemIdx) end

    ISTimedActionQueue.clear(p)
    -- 人在远处时不硬搬（引擎会直接失败），先走过去再拿 —— 用 addAfter 串起来。
    local dx, dy = sq:getX() - p:getX(), sq:getY() - p:getY()
    if (dx * dx + dy * dy) > 2.5 then
        local stand = adjacentSquare(sq, p)
        if not stand then return false, 'no-stand' end
        if not ISWalkToTimedAction then require "TimedActions/ISWalkToTimedAction" end
        if not ISWalkToTimedAction then return false, 'no-actions' end
        local walk = ISWalkToTimedAction:new(p, stand)
        ISTimedActionQueue.add(walk)
        ISTimedActionQueue.addAfter(walk,
            ISInventoryTransferAction:new(p, item, cont, p:getInventory(), 50))
        return true
    end
    ISTimedActionQueue.add(
        ISInventoryTransferAction:new(p, item, cont, p:getInventory(), 50))
    return true
end

--- 这一格上的门。没有就 nil。
local function doorAt(sq)
    if not sq then return nil end
    local objs = safe(function() return sq:getObjects() end, nil)
    if not objs then return nil end
    local n = probe(function() return objs:size() end)
    if not n then return nil end
    for i = 0, n - 1 do
        local o = nil
        pcall(function() o = objs:get(i) end)
        if o and instanceof(o, "IsoDoor") then return o end
    end
    return nil
end

--- 开门 / 关门。
---
--- 之前完全没有这个动作，她只能走过去 —— 而门是关着的时候走过去会被挡住，
--- 于是她自己总结出「我能走能打，就是开不了门」。这句是她观察到的**事实**，不是抱怨。
---
--- 用 `IsoDoor:ToggleDoor(character)`：它会处理锁、路障、双开门这些情况，
--- 比 `setOpen(true)` 稳（后者绕过游戏自己的判定，锁着的门也会被硬拉开）。
local function queueDoor(p, x, y)
    local cell = getCell()
    local dz = math.floor(p:getZ())
    local px, py = math.floor(p:getX()), math.floor(p:getY())

    -- 给了坐标就先看那一格；没给（或那格没门）就从脚下往外扩一圈。
    local sq = nil
    if x and y then
        sq = cell:getGridSquare(math.floor(x), math.floor(y), dz)
        local d = doorAt(sq)
        if d then
            pcall(function() d:ToggleDoor(p) end)
            return true, ''
        end
    end

    local dirs = { {0,0}, {0,-1}, {0,1}, {1,0}, {-1,0}, {1,-1}, {-1,-1}, {1,1}, {-1,1} }
    for _, off in ipairs(dirs) do
        local d = doorAt(cell:getGridSquare(px + off[1], py + off[2], dz))
        if d then
            pcall(function() d:ToggleDoor(p) end)
            return true, ''
        end
    end
    return false, 'no-door'
end

--- 背包里最该吃的那一样。
---
--- `getHungChange()` 是**负数**表示能填饱（-0.3 就是吃掉三成饥饿），所以取最负的那个。
--- 这个字段在食物上一定有；非食物是 0，正好被 `< 0` 挡掉。
local function bestFood(p)
    local inv = safe(function() return p:getInventory() end, nil)
    local items = inv and safe(function() return inv:getItems() end, nil)
    local n = items and probe(function() return items:size() end)
    if not n then return nil end

    local best, bestV = nil, 0
    for i = 0, n - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local v = safe(function() return it:getHungChange() end, 0) or 0
            if type(v) == 'number' and v < bestV then best, bestV = it, v end
        end
    end
    return best
end

--- 背包里最该喝的那一样。
---
--- 两条路都认：
---   1. `getThirstChange() < 0` —— 老式的「喝一口」物品
---   2. B42 的流体容器（水瓶、烧水壶）有 `getFluidContainer()`，里面的液量 > 0
--- 先按减渴量挑，挑不到再按「有液体的容器」挑。
local function bestDrink(p)
    local inv = safe(function() return p:getInventory() end, nil)
    local items = inv and safe(function() return inv:getItems() end, nil)
    local n = items and probe(function() return items:size() end)
    if not n then return nil end

    local best, bestV = nil, 0
    local withFluid = nil
    for i = 0, n - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local th = safe(function() return it:getThirstChange() end, 0) or 0
            if type(th) == 'number' and th < bestV then best, bestV = it, th end
            if withFluid == nil then
                local fc = safe(function() return it:getFluidContainer() end, nil)
                if fc then
                    local amount = safe(function() return fc:getAmount() end, 0) or 0
                    if type(amount) == 'number' and amount > 0 then withFluid = it end
                end
            end
        end
    end
    return best or withFluid
end

--- 吃 / 喝。都用游戏自己的动作，别自己改数值 ——
--- 饱食度、口渴度、食物中毒、喝水动作的时长，全归 `ISEatFoodAction` / `ISDrinkFluidAction` 管。
local function queueConsume(p, kind)
    local it = (kind == 'drink') and bestDrink(p) or bestFood(p)
    if not it then
        return false, (kind == 'drink') and 'no-water' or 'no-food'
    end
    if not ISTimedActionQueue then require "TimedActions/ISTimedActionQueue" end
    if not ISTimedActionQueue then return false, 'no-actions' end

    ISTimedActionQueue.clear(p)

    if kind == 'drink' then
        -- B42 的水瓶是流体容器，走 ISDrinkFluidAction；
        -- 老式的走 ISDrinkFromBottle。两个都试，第一个能排上就用。
        if not ISDrinkFluidAction then pcall(function() require "TimedActions/ISDrinkFluidAction" end) end
        local ok = false
        if ISDrinkFluidAction then
            ok = pcall(function()
                ISTimedActionQueue.add(ISDrinkFluidAction:new(p, it, 1.0))
            end)
        end
        if not ok then
            if not ISDrinkFromBottle then pcall(function() require "TimedActions/ISDrinkFromBottle" end) end
            if ISDrinkFromBottle then
                ok = pcall(function()
                    ISTimedActionQueue.add(ISDrinkFromBottle:new(p, it, 1.0))
                end)
            end
        end
        return ok, ok and '' or 'drink-failed'
    end

    if not ISEatFoodAction then pcall(function() require "TimedActions/ISEatFoodAction" end) end
    if not ISEatFoodAction then return false, 'no-actions' end
    local ok = pcall(function()
        ISTimedActionQueue.add(ISEatFoodAction:new(p, it, 1.0))
    end)
    return ok, ok and '' or 'eat-failed'
end

--[[
    做饭：**不自己重建一套合成**，直接借游戏自己的那套。

    这条路是照 `ISInventoryPaneContextMenu.OnNewCraft`（右键「制作」）抄的：
    `HandcraftLogic` 负责「这一份配方现在能不能做」（材料、技能、工作台、热源），
    `ISEntityUI.HandcraftStart` 负责把它排成动作，剩下的全归游戏。

    判据从哪来：`ScriptManager.instance:getAllCraftRecipes()`。
    烹饪配方的剧本里写着 `category = Cooking`，手边就能做的还带 `InHandCraft` 标签
    （见 `media/scripts/generated/recipes/recipes_cooking.txt`）。

    ⚠️ 这道菜做不了的时候，我们**说不出具体缺什么** —— `canPerformCurrentRecipe()`
    只回一个布尔。所以措辞是「现在做不了」，不要把猜测写成原因。
-- ]]

--- 合成时"看得见"的容器：身上的 + 脚下这一格和八个邻格里的。
---
--- ⚠️ 不能用 `ISInventoryPaneContextMenu.getContainers` —— 它去翻
--- `getPlayerInventory(num).inventoryPane.inventoryPage.backpacks`，
--- 也就是**物品栏面板**。她从不开那个面板，于是那条路要么报错要么给个空表，
--- 表现就是「永远 no-recipe」。这类"依赖 UI 状态的 API"，在无人操作的角色身上全都不可靠。
local function nearbyContainers(p)
    if ArrayList == nil then return nil end
    local list = ArrayList.new()

    local inv = safe(function() return p:getInventory() end, nil)
    if inv then pcall(function() list:add(inv) end) end

    local cell = getCell()
    local px, py = math.floor(p:getX()), math.floor(p:getY())
    local pz = math.floor(p:getZ())
    for dx = -1, 1 do
        for dy = -1, 1 do
            local sq = cell:getGridSquare(px + dx, py + dy, pz)
            if sq then
                local objs = safe(function() return sq:getObjects() end, nil)
                local n = objs and probe(function() return objs:size() end)
                if n then
                    for i = 0, n - 1 do
                        local o = safe(function() return objs:get(i) end, nil)
                        local c = o and safe(function() return o:getContainer() end, nil)
                        if c then pcall(function() list:add(c) end) end
                    end
                end
            end
        end
    end
    return list
end

--- 建一个 handcraft 上下文。返回 nil 表示这套系统没加载。
local function craftLogic(p)
    if HandcraftLogic == nil then
        pcall(function() require "Entity/components/crafting/recipe/HandcraftLogic" end)
    end
    if HandcraftLogic == nil then return nil end
    if ISEntityUI == nil then pcall(function() require "Entity/ISEntityUI" end) end
    if ISInventoryPaneContextMenu == nil then pcall(function() require "ISUI/ISInventoryPaneContextMenu" end) end
    if ISEntityUI == nil or ISInventoryPaneContextMenu == nil then return nil end

    local logic = safe(function() return HandcraftLogic.new(p, nil, nil) end, nil)
    if not logic then return nil end
    safe(function() return logic:setIsoObject(logic:findCraftSurface(p, 2)) end, nil)
    local containers = nearbyContainers(p)
    if containers then safe(function() return logic:setContainers(containers) end, nil) end
    return logic
end

--- 按名字找一份配方。名字里的空格在协议里编码成 `+`，这里换回来。
--- 大小写不敏感 —— 她抄名字的时候大小写最容易错。
local function findRecipeByName(name)
    local sm = ScriptManager and ScriptManager.instance or nil
    if not sm then return nil end
    local all = safe(function() return sm:getAllCraftRecipes() end, nil)
    local n = all and probe(function() return all:size() end)
    if not n then return nil end

    local want = tostring(name or '')
    want = want:gsub("%+", " ")
    local low = string.lower(want)
    for i = 0, n - 1 do
        local r = safe(function() return all:get(i) end, nil)
        if r then
            local rn = safe(function() return r:getName() end, nil)
            if type(rn) == 'string' and string.lower(rn) == low then return r end
        end
    end
    return nil
end

--- 挑一道现在能做的菜。
---
--- 只在 `cook` 被叫到时跑一次 —— 全量配方逐个 `canPerformCurrentRecipe()` 是有代价的，
--- 不能放进每拍的循环里。
local function findCookRecipe(p, logic)
    local sm = ScriptManager and ScriptManager.instance or nil
    if not sm then return nil end
    local all = safe(function() return sm:getAllCraftRecipes() end, nil)
    local n = all and probe(function() return all:size() end)
    if not n then return nil end

    local seen = 0
    for i = 0, n - 1 do
        if seen >= 400 then break end
        local r = safe(function() return all:get(i) end, nil)
        if r then
            local cat = safe(function() return r:getCategory() end, nil)
            if cat == 'Cooking' then
                seen = seen + 1
                safe(function() return logic:setRecipe(r) end, nil)
                if safe(function() return logic:canPerformCurrentRecipe() end, false) == true then
                    return r
                end
            end
        end
    end
    return nil
end

--- 真把一份配方排进动作队列。cook 和 craft 共用这一段。
local function performRecipe(p, logic, recipe)
    safe(function() return logic:setRecipe(recipe) end, nil)
    if safe(function() return logic:canPerformCurrentRecipe() end, false) ~= true then
        return false, 'cant-craft'
    end
    local action = safe(function()
        return ISEntityUI.HandcraftStart(p, logic, false, true, nil)
    end, nil)
    if not action then return false, 'cant-craft' end
    safe(function() return logic:startCraftAction(action) end, nil)
    return true, 'recipe:' .. tostring(recipe:getName())
end

local function queueCook(p)
    local logic = craftLogic(p)
    if not logic then return false, 'no-craft' end
    local recipe = findCookRecipe(p, logic)
    if not recipe then return false, 'no-recipe' end
    return performRecipe(p, logic, recipe)
end

--- 点名做一样东西。
local function queueCraft(p, name)
    local logic = craftLogic(p)
    if not logic then return false, 'no-craft' end
    local recipe = findRecipeByName(name)
    if not recipe then return false, 'no-such-recipe' end
    return performRecipe(p, logic, recipe)
end

--- 扫一遍：现在到底能做什么。
---
--- 这是**按需**动作，不放进每拍 —— 全量配方逐个问 `canPerformCurrentRecipe()`
--- 是有代价的（要翻每个容器的材料）。所以加了两道闸：最多收 12 条，
--- 单次最多花 2 秒；超了就标 partial，让她知道这份清单不全。
local function queueScan(p)
    local logic = craftLogic(p)
    if not logic then return false, 'no-craft' end

    local sm = ScriptManager and ScriptManager.instance or nil
    local all = sm and safe(function() return sm:getAllCraftRecipes() end, nil)
    local n = all and probe(function() return all:size() end)
    if not n then return false, 'no-craft' end

    local started = os.time()
    local list = {}
    local partial = false
    for i = 0, n - 1 do
        if i % 40 == 0 and os.time() - started >= 2 then
            partial = true
            break
        end
        local r = safe(function() return all:get(i) end, nil)
        if r then
            safe(function() return logic:setRecipe(r) end, nil)
            if safe(function() return logic:canPerformCurrentRecipe() end, false) == true then
                list[#list + 1] = {
                    n = tostring(safe(function() return r:getName() end, '?')),
                    c = tostring(safe(function() return r:getCategory() end, '?')),
                }
                if #list >= 12 then break end
            end
        end
    end

    B.SCAN = { at = os.time(), list = list, partial = partial }
    return true, 'count:' .. tostring(#list)
end

--- 读一条指令并执行。每 30 帧调一次（约半秒），不要每帧都读文件。
--- 前向声明。
---
--- `pollCommand` 要问「手上还有没有活」，而 `isBusy` 的定义在它后面几十行。
--- 不声明的话这里拿到的是 nil，调用一次就是一整段 Kahlua 堆栈 ——
--- 而且每半秒一次。这条是踩过的类型：**Lua 的 local 只对定义之后可见。**
local isBusy

--- 这两个也一样：定义在下面，pollCommand 先用到。
---
--- ⚠️ 漏了这两个声明的后果比 isBusy 更隐蔽：`pollCommand` 是裹在 pcall 里调起来的，
--- 调 nil 抛的错被外层接住，**`ack` 就没写成**，但 `cmdMarkDone` 已经执行了 ——
--- 表现是「指令发了、没回执、也不重试」，她只能从状态里看出「什么都没发生」。
--- 真机原话：「`look` 试了两格，`pz_state` 里没回出东西」。
local queueLook
local queueEquip
local menuList
local menuPick
local squadList
local squadOrder
local squadGuide
local dogGoto
local humanSpawn
local dogWait
local dogFree
local dogEnsure

local function pollCommand(p)
    local lines = readCmdLines()
    if not lines or #lines == 0 then return end

    -- 挑第一条还没执行过的。挑完先看它是不是 stop ——
    -- 只有「停」不用排队：它是叫停，不是动作。
    local line, left = nil, 0
    for _, l in ipairs(lines) do
        if not cmdDone[l] then
            if line == nil then line = l end
            left = left + 1
        end
    end
    B.CMD_LEFT = left
    if not line then return end

    local f = splitPipe(line)
    if #f < 2 then cmdMarkDone(line); return end
    local verb = f[2]

    -- **排队**：手上还有活就等下一拍。
    --
    -- 这是队列能成立的关键。连下的三条要是不排队，第二条的 queueWalk
    -- 会把第一条的走路清掉 —— 她看起来还是走一步停一步，只是现在连指令
    -- 都被吞了，比不排队更糟。
    --
    -- stop 例外：它自己就是「取消」，排在一条走路后面就失去意义了。
    if verb ~= "stop" and p and isBusy(p) then return end

    -- ⚠️ 这里**不能**先把这条标成已处理。
    -- 上一版就是那么写的：标记在前、执行在后，而执行抛的错被外层 pcall 接住 ——
    -- 于是「标记了、没回执、也不重试」，她只能从状态里看出「什么都没发生」。
    -- 副作用要么全部成功，要么完全不做。
    local seqN = tonumber(f[1])
    if not seqN then return end
    cmdSeqSeen = seqN
    -- 她最后一次下指令的时刻。反射层要问「她还在开车吗」——
    -- 一条 walk 走完之后队列是空的，但那二十秒里她仍然算在开。
    B.LAST_CMD_AT = os.time()

    local function ack(ok, why)
        -- 成功时 `why` 是 nil（queueWalk 只返回一个 true），
        -- 而 `q()` 会 tostring 成 **字符串 "nil"** 写进 JSON —— 外面读到的是一句假原因。
        B.CMD = { seq = seqN, verb = verb, ok = ok, why = why or '' }
    end

    local expire = tonumber(f[7])
    if expire and expire < os.time() then
        -- ⚠️ 过期的这一条**必须标记掉**。
        -- 上一版把「标记」挪到了执行之后，这两个 return 就成了漏口：
        -- 队头那条过期指令每次都被读到、每次都 return、永远不标记 ——
        -- 后面 19 条全堵在它后面出不去，表现是「指令全都不动了」。
        -- 真机就是这么卡住的：cmdLeft 19 一直不变，回执还是几十分钟前那条。
        cmdMarkDone(line)
        B.CMD_LEFT = left - 1
        ack(false, 'expired:' .. tostring(math.floor(os.time() - expire)))
        return
    end

    if not p then
        -- 玩家还没加载：**不标记**，等下一拍再来。这条不是坏指令，只是来得太早。
        ack(false, 'no-player')
        return
    end
    if p:isDead() then
        -- 死了就丢掉。等人的号已经在读档界面了，这条没有意义。
        cmdMarkDone(line)
        B.CMD_LEFT = left - 1
        ack(false, 'dead')
        return
    end

    -- **他会动身体的动词，在他自己操作时不执行。**
    --
    -- 桌面侧已经在 `hands.on` 时停止推决策了，但还有别的渠道能下指令：
    -- 他直接在对话里说「去把那个拿上」，或者她自己在别的触发点下的。
    -- 只要他的手还在键鼠上，一条 walk 就会顶掉他按住的方向 —— 那不是她想帮忙，
    -- 是抢方向盘。
    --
    -- 标记掉（不是留着重试）：留着重试就是堵队列，而且下一拍他手松了她会自己再下。
    -- 不动作类（stop / guard / look / scan / squad / menu）一律放行 —— 那些不动身体，
    -- 而且 stop 正是「停手」，他的手在键鼠上时更需要它。
    if B.HANDS and B.HANDS.on then
        local BODY_VERBS = {
            walk = true, face = true, attack = true, take = true, door = true,
            eat = true, drink = true, cook = true, craft = true, equip = true,
            pick = true, guide = true,
        }
        if BODY_VERBS[verb] then
            cmdMarkDone(line)
            B.CMD_LEFT = left - 1
            ack(false, 'hands-off')
            return
        end
    end

    -- 包一层 pcall：某个动作内部炸了也要留下回执。
    -- 「崩了但没人知道」和「成功但没人知道」在她那边长得一模一样。
    --
    -- `ok` / `why` 声明在**外面**：它们要活着走出这个闭包，`ack` 才用得上。
    local ok, why = false, ""
    local ran = pcall(function()
        if verb == "walk" then
            ok, why = queueWalk(p, tonumber(f[3]) or 0, tonumber(f[4]) or 0, f[5])
        elseif verb == "face" then
            local fx, fy = tonumber(f[3]), tonumber(f[4])
            if not fx or not fy then ok, why = false, 'need-xy'
            else
                ok = pcall(function() p:faceLocationF(fx, fy) end)
                why = ok and '' or 'face-failed'
            end
        elseif verb == "attack" then
            local z = nearestZombie(p, 2.0)
            if not z then ok, why = false, 'no-zombie'
            else
                pcall(function() p:faceThisObject(z) end)
                ok, why = tryAttack(p)
                why = ok and '' or 'attack-failed'
            end
        elseif verb == "cook" then
            ok, why = queueCook(p)
        elseif verb == "craft" then
            ok, why = queueCraft(p, f[3])
        elseif verb == "scan" then
            ok, why = queueScan(p)
        elseif verb == "eat" then
            ok, why = queueConsume(p, 'eat')
        elseif verb == "drink" then
            ok, why = queueConsume(p, 'drink')
        elseif verb == "door" then
            ok, why = queueDoor(p, tonumber(f[3]), tonumber(f[4]))
        elseif verb == "take" then
            ok, why = queueTake(p, tonumber(f[3]) or 0, tonumber(f[4]) or 0,
                tonumber(f[5]) or 0, tonumber(f[6]) or 0)
        elseif verb == "squad" then
        ok, why = squadList()
    elseif verb == "order" then
        ok, why = squadOrder(p, f[3], f[4])
    elseif verb == "human" then
        -- p1 = 贴图名，p2 = bodyModel，都可不填（用默认）
        ok, why = humanSpawn(p, f[3], f[4])
    elseif verb == "dog" then
        local a = dogEnsure(p)
        ok, why = a ~= nil, a and '' or 'no-dog'
    elseif verb == "dogo" then
        ok, why = dogGoto(p, f[3], f[4])
    elseif verb == "dogwait" then
        ok, why = dogWait(p)
    elseif verb == "dogfree" then
        ok, why = dogFree(p)
    elseif verb == "guide" then
        ok, why = squadGuide(p, f[3], f[4], f[5])
    elseif verb == "recruit" then
        ok, why = squadRecruit(p, f[3])
    elseif verb == "menu" then
        ok, why = menuList(p)
    elseif verb == "pick" then
        ok, why = menuPick(p, f[3])
    elseif verb == "look" then
            ok, why = queueLook(p, tonumber(f[3]) or 0, tonumber(f[4]) or 0)
        elseif verb == "equip" then
            ok, why = queueEquip(p)
        elseif verb == "guard" then
            -- 她可以自己决定「该不该自动还手」。默认开。
            -- 传 0 关掉，其它任何值都当开。
            B.REFLEX.on = not (f[3] == "0")
            ok = true
        elseif verb == "stop" then
            if ISTimedActionQueue then ISTimedActionQueue.clear(p) end
            pcall(function() p:setMoveDelta(0) end)
            pcall(function() p:setRunning(false) end)
            pcall(function() p:setSneaking(false) end)
            pcall(function() p:setIsAiming(false) end)
            ok = true
        else
            why = 'unknown-verb:' .. tostring(verb)
        end
    end)
    if not ran then ok, why = false, 'crash' end

    cmdMarkDone(line)
    B.CMD_LEFT = left - 1

    ack(ok, why)
    diag("cmd " .. tostring(verb) .. " seq=" .. tostring(seqN) .. " ok=" .. tostring(ok)
        .. (why ~= "" and (" why=" .. tostring(why)) or ""))
end

--- 动作队列空不空 —— 她要知道「上一件事做完了没有」。
function isBusy(p)
    if not ISTimedActionQueue or not p then return false end
    local q = nil
    if not pcall(function() q = ISTimedActionQueue.getTimedActionQueue(p) end) then return false end
    if not q or not q.queue then return false end
    -- ⚠️ 这里原来调 `q.queue:isEmpty()`。B42 那个队列对象上**没有 isEmpty**，
    -- 方法为 nil，于是 `isEmpty()` 变成「调用 nil」—— pcall 接得住，但 Kahlua
    -- 每接一次照样打一整段堆栈，而这个函数每 120 帧跑一次，日志直接被刷满。
    -- `size()` 是验证过能用的（容器、对象列表都是这么数的）。
    -- ⚠️ 这里连着错过两次：先 `q.queue:isEmpty()`，后 `q.queue:size()` ——
    -- 两个都不存在。`ISTimedActionQueue:new` 里写的是 `o.queue = {}`，**那是 Lua 表**，
    -- 不是 Java List。官方自己数它用的是 `#self.queue`（`addToQueue` 第 10 行）。
    -- 错一次就是每 120 帧一整段堆栈：console 从 6 千行涨到 6 万行。
    local n = nil
    local ok = pcall(function() n = #q.queue end)
    if not ok or type(n) ~= 'number' then return false end
    return n > 0
end

-- ---------------------------------------------------------------- 人形探针（实验）
--
-- ⚠️ 这一段是**试验**，不是功能。它会往 `AnimalDefinitions` 里注册一个物种，
-- 那个物种的模型是玩家的身体（`MaleBody`）、动画集是 `player`、贴图是 `BobZ2_Body`。
--
-- 为什么值得试：`IsoAnimal` 继承 `IsoPlayer`，所以它天生有玩家的动作系统。
-- 原版渲染人体模特走的就是「Bob 的骨骼 + Bob 的动画」（`anims_X/Bob/Bob_Mannequin01.x`），
-- 说明人形网格 + 人类动画是原生支持的组合 —— 只是没人把它挂在动物物种上试过。
--
-- 为什么可能失败（三种，都不是报错，是「看起来不对」）：
--   1. 玩家的外观是动态拼的（身体 + 头发 + 衣服按部件挂），`MaleBody` 只有身体
--      → 可能是个光头裸体，或者干脆透明
--   2. 动物状态机按节点名找动画，玩家那套是 `Bob_Walk` 这种带前缀的
--      → 对不上就是 T 字姿势，或者站桩滑行
--   3. 注册字段缺一个，Java 侧可能 NPE —— **这种 pcall 拦不住，直接闪退**
--
-- 所以：`B.HUMAN.on` 默认开（注册本身不生成、不占资源），但只有说 `human` 才真生成。
-- 出问题就把它改成 false，重进游戏即可，不脏存档。

-- 贴图和模型都可以被指令覆盖（`human|<texture>|<bodyModel>`）——
-- 这样试错不用每次改代码重启，一条指令一种组合。
--
-- 默认值换成了原版的身体贴图：`textures/Body/MaleBody01.png`。
-- 第一次用的是 `BobZ2_Body`（textures 根下），渲染出来是红白相间的条纹人 ——
-- 那是 UV 对不上，不是没贴图。玩家的身体贴图按肤色编号存在 Body/ 子目录里，
-- 根下那几个 BobZ*_Body 是另一套东西。
B.HUMAN = {
    on = true,
    atype = 'CoopaniHuman',
    breed = 'CoopaniHuman',
    tex = 'MaleBody01',
    body = 'MaleBody',
    ready = false,
    err = '',
}

local function humanRegister(tex, body)
    if not B.HUMAN.on then return false, 'off' end
    tex = (tex and tex ~= '') and tex or B.HUMAN.tex
    body = (body and body ~= '') and body or B.HUMAN.body
    if type(AnimalDefinitions) ~= 'table' then return false, 'no-ad' end
    local AD = AnimalDefinitions.animals
    if type(AD) ~= 'table' then return false, 'no-ad' end

    local t, bd = B.HUMAN.atype, B.HUMAN.breed

    -- 已经注册过，参数也没变：直接返回。
    local existing = nil
    pcall(function() existing = AD[t] end)
    if existing then
        local same = false
        pcall(function()
            local br = existing.breeds and existing.breeds[bd]
            same = (existing.bodyModel == body) and br ~= nil and (br.texture == tex)
        end)
        if same then
            B.HUMAN.ready = true
            B.HUMAN.err = ''
            return true
        end
        -- 参数变了：**删掉重建**，不要原地改字段。
        --
        -- 原地改没用 —— Java 侧的 def 对象在 loadAnimalDefinitions 时就把贴图名
        -- 读进内部字段了，改 Lua 表里的字符串它看不见。第一次踩的就是这个：
        -- 传了 `Body/MaleBody03`，回执说成功，屏幕上一点变化都没有。
        pcall(function() AD[t] = nil end)
    end

    local ok, err = pcall(function()
        local def = {
            bodyModel = body,
            animset = 'player',
            female = false, male = true,
            breeds = {},
            stages = {},
            minSize = 1, maxSize = 1, minWeight = 70, maxWeight = 70,
            minAge = 30 * 365, maxAgeGeriatric = 80 * 365,
            shadoww = 0.35, shadowfm = 0.35, shadowbm = 0.35,
            wanderMul = 600, hungerMultiplier = 0.008, thirstMultiplier = 0.016,
            hungerBoost = 20, thirstBoost = 25, baseEncumbrance = 20,
            trailerBaseSize = 50, minEnclosureSize = 40, needMom = false,
        }
        -- 贴图名**不带目录**。原版 cow 写的是 `Cow_Black`，文件在 textures/Body/ 下 ——
        -- 引擎自己去 Body/ 找。我们写 `Body/MaleBody01` 就找不到了，
        -- 找不到时的占位就是那个红白棋盘格。
        def.breeds[bd] = {
            name = bd,
            texture = tex, textureMale = tex, rottenTexture = tex,
            invIconMale = 'Item_Dog', invIconMaleDead = 'Item_DogDead',
        }
        def.stages[bd] = { ageToGrow = 1 }
        AD[t] = def
    end)
    if ok then
        -- 注册完立刻重建索引 —— 写表不等于进索引（这里是今晚最大的一课）。
        pcall(function() AnimalDefinitions.loadAnimalDefinitions() end)
        B.HUMAN.tex, B.HUMAN.body = tex, body
    end
    B.HUMAN.ready = ok
    B.HUMAN.err = ok and '' or tostring(err)
    return ok, B.HUMAN.err
end

--- 在她脚边生成一个人形探针。
---
--- ⚠️ 每一步都单独记账。第一次跑的时候只返回了 `crash` —— 外层 pcall 吞掉了
--- 全部信息，等于什么也没说。探针这种东西，**失败时不知道错在哪就等于没做**。
--- 现在 `step` 记走到哪一步，完整错误留在 `B.HUMAN.err`，一起进 state。
---
--- 第一次实测（mod 1.4.2）：回执 `ok=false, why=crash`，游戏没崩，
--- 大概率是 `AnimalDefinitions.getDef` 对我们新注册的类型抛异常，
--- 或者 `addAnimal` 的 breed 参数要的是 Java 对象而不是 Lua 表。
function humanSpawn(p, tex, body)
    local step = 'register'
    local ok, err = pcall(function()
        local r, why = humanRegister(tex, body)
        if not r then error('register-failed:' .. tostring(why)) end

        step = 'square'
        local x, y = p:getX() + 0.5, p:getY() + 0.5
        local sq = nil
        pcall(function() sq = adjacentSquare(p) end)
        if sq then x, y = sq:getX() + 0.5, sq:getY() + 0.5 end
        local z = math.floor(p:getZ())

        -- ⚠️ 退化测试。第一次跑到这里时 `getDef` 返回 nil —— 而 Lua 表里那一条
        -- 明明写进去了。两种可能，必须分开：
        --   a) `addAnimal` 这条链路本身不通（参数不对、需要更多前置）
        --   b) 只有我们新注册的类型不通（Java 侧的索引没认它）
        -- 用原版就有的 `chick` 走一遍同一段代码 —— 鸡出得来，(a) 排除。
        step = 'getDef'
        local def = AnimalDefinitions.getDef(B.HUMAN.atype)
        if not def then
            -- 自己救一次：写进 Lua 表之后，引擎的索引要重建才认。
            -- 成功的话下面那句 getDef 就能拿到。
            pcall(function() AnimalDefinitions.loadAnimalDefinitions() end)
            pcall(function() def = AnimalDefinitions.getDef(B.HUMAN.atype) end)
        end
        if not def then
            step = 'fallback-chick'
            local fb = AnimalDefinitions.getDef('chick')
            if not fb then error('chick-also-nil') end
            local fbBreed = nil
            pcall(function() fbBreed = fb:getRandomBreed() end)
            if not fbBreed then error('chick-has-no-breed') end
            local ch = addAnimal(getCell(), math.floor(x), math.floor(y), z, 'chick', fbBreed, false)
            if not ch then error('addAnimal-nil-for-chick') end
            pcall(function() ch:stopAllMovementNow() end)
            B.HUMAN.err = 'our-type-nil-but-chick-ok'
            return
        end

        step = 'getBreedByName'
        local breed = def:getBreedByName(B.HUMAN.breed)
        if not breed then error('getBreedByName-returned-nil') end

        step = 'addAnimal'
        local a = addAnimal(getCell(), math.floor(x), math.floor(y), z,
            B.HUMAN.atype, breed, false)
        if not a then error('addAnimal-returned-nil') end

        step = 'mark'
        pcall(function() a:setCustomName('Chloe') end)
        pcall(function() a:getModData().coopaniHuman = true end)
        pcall(function() a:stopAllMovementNow() end)
        B.DOG.id = nil   -- 人形探针和狗分开，别互相顶
    end)

    if not ok then
        B.HUMAN.err = tostring(err)
        return false, 'human@' .. step
    end
    B.HUMAN.err = ''
    return true, 'human:spawned'
end

-- 注册的**时机**比内容重要。
--
-- 引擎那边的索引是 `AnimalDefinitions.loadAnimalDefinitions()` 从 Lua 表重建出来的
-- （class 里有 `loadAnimalDefinitions / loadBreeds / loadStages / Reset`，没有 addDef）。
-- 也就是说：往 Lua 表里写一条**不会自动进索引** —— 必须在它重建之前写完，
-- 或者写完之后手动让它重建一次。
--
-- 第一次实测（mod 1.4.4）：`human.ready` 是 true，Lua 表写进去了，
-- 但 `AnimalDefinitions.getDef("CoopaniHuman")` 返回 nil —— 索引不认。
--
-- 现在两条都做：OnGameBoot 时注册（和 Dog Goblin 一样的时机），
-- 注册完立刻调一次重建。重建包在 pcall 里 —— 它要是清空了原版动物，
-- 坏的也只是这个探针，不是存档。
Events.OnGameBoot.Add(function()
    if not B.HUMAN or not B.HUMAN.on then return end
    local ok = humanRegister(B.HUMAN.tex, B.HUMAN.body)
    if not ok then return end
    pcall(function() AnimalDefinitions.loadAnimalDefinitions() end)
    local got = nil
    pcall(function() got = AnimalDefinitions.getDef(B.HUMAN.atype) end)
    B.HUMAN.err = got and 'registered-after-boot' or 'still-nil-after-reload'
end)

-- ---------------------------------------------------------------- 狗
--
-- 她的第二具身体。**不占他的方向盘** —— 那是玩家号，只有一个。
--
-- 为什么走的通，三条都翻过源码确认：
--
--   1. `IsoAnimal extends IsoPlayer`（读 projectzomboid.jar 的 class 文件得到）。
--      动物天生有完整的动作队列、寻路、动画状态机，还有背包接口 ——
--      Companion Dogs 的 Dog Goblin 能「背任何背包、戴大部分帽子」，用的就是继承来的那份。
--
--   2. Companion Dogs 把移动封装成了 `CD.moveTo(animal, running, speed, x, y, z, ...)`，
--      内部就是 `pathToLocation` + `forcePathfind`，还顺手处理了步态和封锁标志。
--      停住是 `CD.holdStill(animal)`，本质是 `animal:getBehavior():setBlockMovement(true)`。
--
--   3. 它自己的 AI 靠两个表驱动：`CD.followMaintainDogs` / `CD.combatMaintainDogs`，
--      key 是 `animal:getOnlineID()`。**从那两个表里摘掉，它就不再驱动这只狗** ——
--      mod 自己在「守护」模式下也是这么干的（companionGuards 里有一模一样的两行）。
--
-- 没装 Companion Dogs 就整个关掉：`dogReady()` 一票否决，所有入口报 `no-dog-mod`。
-- 不许假设它在 —— 桥接本身不该因为少一个第三方 mod 就崩。

-- 用牧羊犬：能打、听话、基因范围里战斗和抗性都高。
-- 换品种只改这一行 —— `CD.spawnDog` 第五个参数就是品种名。
B.DOG_BREED = 'germanshepherd'

B.DOG = {
    id = nil,        -- 狗在游戏里的 onlineID
    name = 'Chloe',
    mode = 'none',   -- none / goto / wait / free
    tx = nil, ty = nil,
}

local function dogCD()
    local CD = CompanionDogs
    if type(CD) ~= 'table' then return nil end
    if type(CD.moveTo) ~= 'function' or type(CD.holdStill) ~= 'function' then return nil end
    return CD
end
local function dogReady() return dogCD() ~= nil end

--- 按 onlineID 取回那只狗。死掉/没加载的情况一律返回 nil。
local function dogRef()
    local id = B.DOG and B.DOG.id
    if not id then return nil end
    local a = nil
    pcall(function() a = getAnimal(id) end)
    if not a then B.DOG.id = nil; return nil end
    local alive = false
    pcall(function() alive = not a:isDead() and a:isExistInTheWorld() end)
    if not alive then B.DOG.id = nil; return nil end
    return a
end

--- 把这只狗从 CD 的 AI 队列里摘出来。
---
--- 不摘会怎样：`maintainFollowers` 每隔几十毫秒调一次 `CD.followOwner`，
--- 我们 `moveTo` 刚设好的目标当场被覆盖 —— 表现是狗自己往主人身边跑，
--- 完全不听指令。
local function dogTakeOver(a)
    local id = nil
    pcall(function() id = a:getOnlineID() end)
    if not id or id < 0 then return end
    pcall(function()
        local CD = CompanionDogs
        if CD.followMaintainDogs then CD.followMaintainDogs[id] = nil end
        if CD.combatMaintainDogs then CD.combatMaintainDogs[id] = nil end
    end)
end

--- 在她脚边找一个能站的格子。优先室内 —— 狗在屋里生出来比在街上安全。
local function dogSpawnNear(p)
    local x, y = nil, nil
    pcall(function()
        local sq = adjacentSquare(p)
        if sq then x, y = sq:getX() + 0.5, sq:getY() + 0.5 end
    end)
    if not x then x, y = p:getX() + 0.5, p:getY() + 0.5 end
    local CD = dogCD()
    if not CD then return nil end
    local a = nil
    local ok = pcall(function()
        a = CD.spawnDog(x, y, math.floor(p:getZ()), nil, B.DOG_BREED)
    end)
    if not ok or not a then return nil end
    -- 标记是她的狗：以后 `dog` 动词按这个认，不靠名字（名字可能被玩家改）。
    pcall(function() a:getModData().coopaniDog = true end)
    pcall(function() a:setCustomName(B.DOG.name) end)
    -- 单行写法漏了 function 自己的 end —— 这一行让整个 mod 加载失败过一次。
    pcall(function()
        if CD.transmit then CD.transmit(a) end
    end)
    dogTakeOver(a)
    pcall(function() B.DOG.id = a:getOnlineID() end)
    B.DOG.mode = 'wait'
    -- 刚生出来就站住，否则它自己先走两步。
    pcall(function() a:stopAllMovementNow() end)
    pcall(function() CD.holdStill(a) end)
    return a
end

--- 找她那只狗；没有就生一只。
function dogEnsure(p)
    local a = dogRef()
    if a then return a end
    return dogSpawnNear(p)
end

--- 走到某一格。
---
--- 走 `CD.moveTo` 而不是直接 `pathToLocation`：它内部会先 `letMove`（解除封锁）、
--- 设步态、再 `forcePathfind`。少那一步 `forcePathfind`，狗会站在原地等下一次
--- 引擎自己想起来 —— 表现是「指令下去了它不动」。
function dogGoto(p, x, y)
    local CD = dogCD()
    if not CD then return false, 'no-dog-mod' end
    local a = dogEnsure(p)
    if not a then return false, 'no-dog' end
    local tx, ty = tonumber(x), tonumber(y)
    if not tx or not ty then return false, 'need-xy' end
    local z = nil
    pcall(function() z = math.floor(a:getZ()) end)
    z = z or math.floor(p:getZ())
    local sq = nil
    pcall(function() sq = getCell():getGridSquare(math.floor(tx), math.floor(ty), z) end)
    if not sq then return false, 'no-square' end

    -- 太远就不接。狗穿墙寻路会绕整个街区，而它只有几分钟的耐心。
    local d = nil
    pcall(function()
        local dx, dy = a:getX() - tx, a:getY() - ty
        d = math.sqrt(dx * dx + dy * dy)
    end)
    if d and d > 40 then return false, 'too-far:' .. string.format('%.0f', d) end

    dogTakeOver(a)
    local ok = pcall(function()
        CD.moveTo(a, false, CD.walkAnimSpeed(), math.floor(tx), math.floor(ty), z,
            'coopani', nil, 'coopani')
    end)
    if not ok then return false, 'dog-path-failed' end
    B.DOG.mode = 'goto'
    B.DOG.tx, B.DOG.ty = math.floor(tx), math.floor(ty)
    return true
end

--- 停住。已经在跑的路径也要停 —— 只设 blockMovement 的话，
--- 那一段路还在飞，狗会带着封锁标志继续挪到终点。
function dogWait(p)
    local CD = dogCD()
    if not CD then return false, 'no-dog-mod' end
    local a = dogRef()
    if not a then return false, 'no-dog' end
    pcall(function() a:stopAllMovementNow() end)
    pcall(function() CD.holdStill(a) end)
    dogTakeOver(a)
    B.DOG.mode = 'wait'
    B.DOG.tx, B.DOG.ty = nil, nil
    return true
end

--- 放开：解除封锁，交回它自己的判断（会跟着他走，遇敌会打）。
function dogFree(p)
    local CD = dogCD()
    if not CD then return false, 'no-dog-mod' end
    local a = dogRef()
    if not a then return false, 'no-dog' end
    pcall(function()
        local b = a:getBehavior()
        if b then b:setBlockMovement(false) end
    end)
    B.DOG.mode = 'free'
    B.DOG.tx, B.DOG.ty = nil, nil
    return true
end

--- 写进 state 的那一段。没狗就是 null。
local function dogSnap(p)
    if not dogReady() then return nil end
    local a = dogRef()
    if not a then
        if B.DOG and B.DOG.mode ~= 'none' then B.DOG.mode = 'none' end
        return { have = false, mod = true, name = B.DOG and B.DOG.name or 'Chloe' }
    end
    local x, y, z, md = nil, nil, nil, B.DOG.mode
    pcall(function() x, y, z = a:getX(), a:getY(), a:getZ() end)
    local d = nil
    pcall(function()
        local dx, dy = a:getX() - p:getX(), a:getY() - p:getY()
        d = math.sqrt(dx * dx + dy * dy)
    end)
    local moving, blocked = nil, nil
    pcall(function() moving = a:isAnimalMoving() == true end)
    -- `isBlockMovement` 在 IsoPlayer 上（动物继承了），不在 behavior 对象上。
    -- behavior 只有 setter：BaseAnimalBehavior 里有 setBlockMovement，没有 getter。
    pcall(function() blocked = a:isBlockMovement() == true end)
    return {
        have = true, mod = true, name = B.DOG.name,
        id = B.DOG.id, x = x, y = y, z = z, d = d,
        mode = md, moving = moving, blocked = blocked,
        tx = B.DOG.tx, ty = B.DOG.ty,
    }
end

-- ---------------------------------------------------------------- 小队（Rimboid / SurvivorSquad）
--
-- 跨 mod，所以要特别小心两件事：
--
-- 1. **它的幸存者不是 `IsoPlayer`，是伪装成僵尸的身体。** 我们那套
--    `ISWalkToTimedAction` / `ISInventoryTransferAction` 对它们无效，
--    而且它的 AI 每帧都在驱动那些身体 —— 抢控制权只会两边打架。
--    所以走它自己的指令系统：`SSQ.send(player, "SetJob", {id=..., job=...})`。
--    走路、开门、打架、保命全归它管，我们只管「让她干什么」。
--
-- 2. **它可能没装。** 所有入口都要先问 `squadReady()`，没装就老实报 `no-squad`，
--    不许假设它在、也不许因此让主流程挂掉。
--
-- 单人模式下 `SSQ.send` 直接调 server handler（同一个 Lua 状态），不用过网络。

-- 它接受的十六种工作。名字首字母大写，其余小写 —— 和 `SSQ.Jobs` 的键对齐。
-- 不校验就用它的 `SetJob`：拼错一个字母它会静默什么都不做。
local SQUAD_JOBS = {
    follow = true, hold = true, guard = true, patrol = true, explore = true,
    farm = true, relax = true, sort = true, corpses = true, auto = true,
    fish = true, clean = true, cook = true, chop = true, dismantle = true, medic = true,
}
local SQUAD_LIST_MAX = 8

local function squadReady()
    return type(SSQ) == 'table' and SSQ.Roster ~= nil and SSQ.send ~= nil
end

--- 名册。`members()` 给的是 id -> member 的 map，不是数组。
function squadList()
    if not squadReady() then return false, 'no-squad' end
    local members = nil
    if not pcall(function() members = SSQ.Roster.members() end) then return false, 'no-squad' end
    if type(members) ~= 'table' then return false, 'no-squad' end

    local out = {}
    for id, m in pairs(members) do
        if type(m) == 'table' and not m.dead and #out < SQUAD_LIST_MAX * 2 then
            local x, y = nil, nil
            pcall(function()
                local b = m.body
                if b then x = b:getX(); y = b:getY() end
            end)
            out[#out + 1] = {
                id = tostring(id),
                name = tostring(m.name or '?'),
                job = tostring(m.job or ''),
                r = (m.recruited == true),
                x = x, y = y,
            }
        end
    end
    table.sort(out, function(a, b) return a.name < b.name end)
    while #out > SQUAD_LIST_MAX do table.remove(out) end
    B.SQUAD = { at = os.time(), list = out }
    return true
end

--- 下一条工作指令。`id` 从 state 的 `squad.list[].id` 抄。
--- `job` 大小写不敏感（她会照着自己看到的写，大小写最容易错）。
function squadOrder(p, id, job)
    if not squadReady() then return false, 'no-squad' end
    local raw = tostring(id or ''):gsub("%+", " ")
    if raw == '' then return false, 'need-id' end
    local key = string.lower(tostring(job or ''))
    if not SQUAD_JOBS[key] then return false, 'bad-job:' .. tostring(job) end
    local name = string.upper(string.sub(key, 1, 1)) .. string.sub(key, 2)

    local ok = pcall(function() SSQ.send(p, "SetJob", { id = raw, job = name, params = {} }) end)
    if not ok then return false, 'squad-send-failed' end
    return true, 'squad:' .. name
end

--- 拿某个成员的尸体身体。
---
--- 两条路都试：`member.body` 是缓存的，`SSQ.NPC.findMemberBody` 是它自己的查找。
--- 前者可能为 nil（成员没加载），后者会去走角色表。
local function squadBody(m)
    if type(m) ~= 'table' then return nil end
    local b = m.body
    if b then return b end
    if type(SSQ.NPC) == 'table' and SSQ.NPC.findMemberBody then
        local got = nil
        if pcall(function() got = SSQ.NPC.findMemberBody(m) end) then return got end
    end
    return nil
end

--- 让名册里的某个人走到某一格。
---
--- **这是精确操作，不是派活。** 走的是我们自己的动作队列，不是它的 AI。
---
--- 能不能成，两件事都翻过源码确认过：
---
---   1. `ISWalkToTimedAction` 内部只用 `character:getPathFindBehavior2()` —— 那是
---      `IsoGameCharacter` 的方法，僵尸身体也有。它唯一认 `IsoPlayer` 的地方是
---      「键盘按了方向键就中断」，非玩家直接跳过那段。
---   2. `ISTimedActionQueue` 拿 character 当 key 建队列，只对 `IsoPlayer` 做特殊检查
---      （睡觉、拖尸体）。`IsoZombie` 继承 `IsoGameCharacter`，所以队列能建、动作能进。
---
--- 但它的 AI 每帧都在驱动那个身体 —— 必须先让它放手，否则两边打架，
--- 表现是那个人原地抽搐。所以先 `SetJob Hold`，再压动作。
function squadGuide(p, id, x, y)
    if not squadReady() then return false, 'no-squad' end
    if not ISWalkToTimedAction then require "TimedActions/WalkToTimedAction" end
    if not ISTimedActionQueue then require "TimedActions/ISTimedActionQueue" end
    if not ISWalkToTimedAction or not ISTimedActionQueue then return false, 'no-actions' end

    local raw = tostring(id or ''):gsub("%+", " ")
    if raw == '' then return false, 'need-id' end
    local tx, ty = tonumber(x), tonumber(y)
    if not tx or not ty then return false, 'need-xy' end

    local m = nil
    if not pcall(function() m = SSQ.Roster.member(raw) end) then return false, 'no-member' end
    if not m then return false, 'no-member' end
    local body = squadBody(m)
    if not body then return false, 'no-body' end

    local sq = getCell():getGridSquare(math.floor(tx), math.floor(ty), math.floor(body:getZ()))
    if not sq then return false, 'no-square' end

    -- 先让它自己的 AI 停手。失败也继续试 —— 有的版本 Hold 不需要参数。
    pcall(function() SSQ.send(p, "SetJob", { id = raw, job = "Hold", params = {} }) end)

    local ok = pcall(function()
        ISTimedActionQueue.clear(body)
        ISTimedActionQueue.add(ISWalkToTimedAction:new(body, sq))
    end)
    if not ok then return false, 'guide-failed' end
    return true, 'guide:' .. tostring(m.name or raw)
end

--- 招募名册里的某个人（她得站在对方附近）。
local function squadRecruit(p, id)
    if not squadReady() then return false, 'no-squad' end
    local raw = tostring(id or ''):gsub("%+", " ")
    if raw == '' then return false, 'need-id' end
    local ok = pcall(function() SSQ.send(p, "Recruit", { id = raw }) end)
    if not ok then return false, 'squad-send-failed' end
    return true
end

-- ---------------------------------------------------------------- 菜单：把游戏能做的全交出来
--
-- 为什么不再一个个补动词：僵尸毁灭工程的动作不是有限集合，是
-- 「物品 × 目标 × 技能 × 状态」的组合。右键菜单在某一刻几十项，换个房间换批东西又变。
-- 写死一张动词表，永远在追。
--
-- 但游戏自己知道「站在这里、手上拿着这个、技能几级，能做什么」——那套逻辑长在
-- 右键菜单里。所以：让它针对当前位置生成一遍菜单，把选项读出来，她按名字挑一个执行。
-- 菜单里出现什么，她就能做什么。这是**一次性**的通用解。
--
-- `createMenu(..., test = true)` 是游戏自己的「只生成、不显示」模式：
-- 内部会给 ISContextMenu 填选项，然后把菜单设成不可见。玩家看不到任何东西。

--- 她脚下一圈的对象。菜单要判断「右键点在什么上面」，所以得给它这批东西。
local MENU_RADIUS = 2
local function menuWorldObjects(p)
    local out = {}
    local cell = getCell()
    if not cell then return out end
    local bx = math.floor(p:getX())
    local by = math.floor(p:getY())
    local bz = math.floor(p:getZ())
    for dx = -MENU_RADIUS, MENU_RADIUS do
        for dy = -MENU_RADIUS, MENU_RADIUS do
            local sq = cell:getGridSquare(bx + dx, by + dy, bz)
            if sq then
                local objs = safe(function() return sq:getObjects() end, nil)
                if objs then
                    local n = probe(function() return objs:size() end) or 0
                    for i = 0, n - 1 do
                        local o = safe(function() return objs:get(i) end, nil)
                        if o then out[#out + 1] = o end
                    end
                end
            end
        end
    end
    return out
end

--- 生成一遍菜单，返回 context（不显示）。失败返回 nil, 原因。
---
--- 两个坑都在这几行里：
---
--- 1. **不能用 `ISContextMenu.get` 拿菜单。** 它内部第一件事是 `context:clear()` ——
---    刚被填好的选项会被当场清空，外面拿到的是一个空菜单。要用
---    `getPlayerContextMenu(num)`：同一个对象，不清。
---
--- 2. **要调 `createMenu`，不要自己 triggerEvent。**
---    B42 把主体挪进了 `ISWorldObjectContextMenuLogic.createMenuEntries`，
---    通用事件只在 `fetch.safehouseAllowInteract` 为真时才发 —— 自己 triggerEvent
---    会漏掉一大半由 createMenuEntries 加进去的选项。
---
--- 暂停的时候 `createMenu` 直接 return（它自己的守卫），拿到的菜单是空的 ——
--- 那种情况报 `paused`，别让她以为「这儿什么都不能做」。
local menuBusy = false
local menuLastAt = 0
local MENU_MIN_GAP = 1000   -- 一秒内不重复生成：生成一次要给几百个对象过一遍

local function menuBuild(p)
    if menuBusy then return nil, 'busy' end
    local now = getTimestampMs and getTimestampMs() or 0
    if now > 0 and menuLastAt > 0 and now - menuLastAt < MENU_MIN_GAP then
        return nil, 'busy'
    end
    menuBusy = true
    menuLastAt = now
    local ctx, why = nil, nil
    local ok = pcall(function()
        -- 内部可以用 `why` 记原因（比如 menu-in-use），下面统一返回
        if not ISContextMenu then require "ISUI/ISContextMenu" end
        if not ISWorldObjectContextMenu then require "ISWorldObjectContextMenu" end
        local num = 0
        pcall(function() num = p:getPlayerNum() end)

        -- ⚠️ 他可能正开着右键菜单。
        -- 生成菜单的第一步是 `ISContextMenu.get`，那里面第一件事就是 `context:clear()` ——
        -- 我们会把他正在看的菜单清空。他点了一半的「拆解」会凭空消失，
        -- 而原因在几分钟后的日志里，对不上。
        local live = getPlayerContextMenu(num)
        if live then
            local vis = nil
            if pcall(function() vis = live:isAnyVisible() end) and vis == true then
                why = 'menu-in-use'
                return
            end
        end

        local objs = menuWorldObjects(p)
        local sx, sy = 0, 0
        pcall(function() sx = getPlayerScreenLeft(num) end)
        pcall(function() sy = getPlayerScreenTop(num) end)
        -- **不传 `test = true`。**
        --
        -- 那个参数会被交给 `ISWorldObjectContextMenuLogic.createMenuEntries`（Java 侧），
        -- 而它在 test 模式下会不会真的往菜单里填选项，从 Lua 这边看不出来。
        -- 赌错的代价是清单永远为空 —— 她只能说「这儿什么都不能做」，而实际上是能做的。
        --
        -- 所以走正常生成（一定填），拿到之后**同一帧内立刻隐藏**。
        -- UI 还没渲染，玩家看不到任何东西。
        ctx = ISWorldObjectContextMenu.createMenu(num, objs, sx, sy)
        if ctx then
            ctx:setVisible(false)
            ctx.forceVisible = false
        end
    end)
    menuBusy = false
    if not ok then return nil, 'menu-error' end
    -- 内部记过原因（比如 menu-in-use）就用它，别统一盖成 no-menu ——
    -- 「他正开着菜单」和「这儿没菜单」是两件事，给她的提示也应该是两句。
    if not ctx then return nil, why or 'no-menu' end
    local opts = safe(function() return ctx.options end, nil)
    if not opts or #opts < 1 then return nil, 'paused' end
    return ctx, nil
end

-- 选项的 `name` 是游戏本地化过的字符串，可能带 `&` 之类的快捷键标记。
-- 统一清一遍：去首尾空白、把多余的空白压成一个空格。
local function menuLabel(raw)
    local t = tostring(raw or '')
    t = string.gsub(t, "&", "")
    t = string.gsub(t, "%s+", " ")
    return string.match(t, "^%s*(.-)%s*$") or t
end

--- 把菜单里的选项读成一张清单。
---
--- 只要「现在点了真会做事」的那些：有 onSelect、没禁用、不是纯子菜单入口。
--- 子菜单里的东西先不展开 —— 展开一层就把清单撑到几十条，她读不完；
--- 真需要那一项的时候，名字里通常会带着父级的词（「拆解 → 家具」）。
function menuList(p)
    local ctx, why = menuBuild(p)
    if not ctx then return false, why or 'no-menu' end
    local opts = safe(function() return ctx.options end, nil)
    if not opts then return false, 'no-menu' end

    local out = {}
    for i = 1, #opts do
        local o = opts[i]
        if o and o.onSelect and not o.isDisabled and not o.notAvailable then
            local label = menuLabel(o.name)
            if label ~= '' then
                out[#out + 1] = { n = label, i = i }
            end
        end
    end
    B.MENU = { at = os.time(), list = out }
    if #out == 0 then return false, 'empty-menu' end
    return true
end

--- 执行菜单里的第 n 项。
---
--- `onSelect` 的调用约定是游戏自己定的：`onSelect(target, param1..param10)`。
--- 照抄 `ISContextMenu` 内部的调法，别自己发明 —— 少传一个参数，
--- 一半的选项会静默什么都不做。
---
--- ⚠️ **按名字找，不按序号。** 菜单是重新生成的：`menu` 那一刻的第 5 项，
--- 到她 `pick` 的时候可能已经是另一个东西（世界在变，僵尸进来了，手里的东西换了）。
--- 序号是「上一次的样子」，名字才是意图。名字对不上就报 `stale-menu`，
--- 让她重新问一遍 —— 比执行一个错的动作安全得多。
local MENU_TTL = 120   -- 清单超过这么久就当过期：两分钟里世界变得够多了

function menuPick(p, idx)
    local n = tonumber(idx)
    if not n then return false, 'no-index' end

    local cached = B.MENU
    if not cached or not cached.list then return false, 'no-menu-list' end
    if os.time() - (cached.at or 0) > MENU_TTL then return false, 'stale-menu' end

    local want = nil
    for i = 1, #cached.list do
        if cached.list[i].i == n then want = cached.list[i].n; break end
    end
    if not want then return false, 'bad-index:' .. tostring(n) end

    local ctx, why = menuBuild(p)
    if not ctx then return false, why or 'no-menu' end
    local opts = safe(function() return ctx.options end, nil)
    if not opts then return false, 'no-menu' end

    local o, hit = nil, nil
    for i = 1, #opts do
        local cand = opts[i]
        if cand and cand.onSelect and not cand.isDisabled and not cand.notAvailable
            and menuLabel(cand.name) == want then
            o, hit = cand, i
            break
        end
    end
    if not o then
        -- 名字变了（状态变了、那个东西没了）—— 不猜，让她重新问
        B.MENU = nil
        return false, 'stale-menu'
    end

    local ok = pcall(function()
        ISContextMenu.globalPlayerContext = ctx.player
        o.onSelect(o.target, o.param1, o.param2, o.param3, o.param4,
            o.param5, o.param6, o.param7, o.param8, o.param9, o.param10)
    end)
    if not ok then return false, 'pick-failed:' .. tostring(hit) end

    -- 执行完就把清单作废。菜单是照着「刚才那一刻」生成的，这一项做下去之后
    -- 那句「拆解家具」可能已经变成别的了 —— 留着它等于留着一张过期的菜单。
    -- 她要多做一件事，重新 menu 一次就好。
    B.MENU = nil
    return true, 'menu:' .. want
end

-- ---------------------------------------------------------------- 看 + 拿在手上
--
-- 两件她自己指出来的缺口。都不是「她不肯做」，是**手里没有那个动作**。

--- 看一眼这一格上有什么容器、里面装了什么。
---
--- 为什么必须单独做：`loot` 走的是 UI 那条路 —— 它读「人**正开着**的那个容器」。
--- 她没有界面，所以没人点开过的柜子在她眼里等于不存在。
--- 真机原话（她自己的日志）：
---   「容器里的东西只有他手动点开才会进 pz_state——想让我拿东西，得他先开柜子。」
---
--- 而 `take` 本来就不需要界面：它直接对 container 下手。所以缺的只是「看」。
local LOOK_RANGE = 2.6      -- 太远就不看：看不见也够不着
local LOOK_MAX_ITEMS = 10   -- 一个容器最多列这么些，再多她读不完
local LOOK_MAX_BOXES = 4    -- 一格上最多记几个容器

function queueLook(p, x, y)
    local pz = math.floor(p:getZ())
    local sq = getCell():getGridSquare(math.floor(x), math.floor(y), pz)
    if not sq then return false, 'no-square' end

    local dx = sq:getX() + 0.5 - p:getX()
    local dy = sq:getY() + 0.5 - p:getY()
    local d = math.sqrt(dx * dx + dy * dy)
    if d > LOOK_RANGE then
        return false, 'too-far:' .. string.format('%.1f', d)
    end

    local objs = safe(function() return sq:getObjects() end, nil)
    if not objs then return false, 'empty-square' end
    local n = probe(function() return objs:size() end)
    if not n then return false, 'empty-square' end

    local boxes = {}
    for i = 0, n - 1 do
        local o = safe(function() return objs:get(i) end, nil)
        if o and #boxes < LOOK_MAX_BOXES then
            local cont = nil
            if pcall(function() cont = o:getContainer() end) and cont then
                local items = nil
                if pcall(function() items = cont:getItems() end) and items then
                    local size = probe(function() return items:size() end)
                    if size then
                        local list = {}
                        local upto = math.min(size, LOOK_MAX_ITEMS)
                        for k = 0, upto - 1 do
                            local it = safe(function() return items:get(k) end, nil)
                            if it then
                                local nm = safe(function() return it:getName() end, nil)
                                local dn = safe(function() return it:getDisplayName() end, nil)
                                local cat = tostring(safe(function() return it:getCategory() end, '') or '')
                                list[#list + 1] = {
                                    n = tostring(dn or nm or '?'),
                                    i = k,
                                    w = (string.lower(cat) == 'weapon'),
                                }
                            end
                        end
                        local onm = safe(function() return o:getName() end, nil)
                        boxes[#boxes + 1] = {
                            oi = i,
                            n = tostring(onm or 'container'),
                            total = size,
                            items = list,
                        }
                    end
                end
            end
        end
    end

    if #boxes == 0 then return false, 'no-container' end

    B.PEEK = { at = os.time(), x = sq:getX(), y = sq:getY(), boxes = boxes }
    return true
end

--- 把背包里最该拿在手上的那件，拿到手上。
---
--- 同样是她指出来的：「`pz_play` 没有『装备到手里』这个动作，刀要他自己右键拎手上。」
--- 走 `ISInventoryPaneContextMenu.equipWeapon` —— 右键菜单点「装备」就是这条路，
--- 重的先扔掉、不在身上的先转移进包，这些它自己处理。
function queueEquip(p)
    if not ISInventoryPaneContextMenu then require "ISUI/ISInventoryPaneContextMenu" end
    if not ISInventoryPaneContextMenu or not ISInventoryPaneContextMenu.equipWeapon then
        return false, 'no-equip'
    end

    local inv = safe(function() return p:getInventory() end, nil)
    if not inv then return false, 'no-actions' end
    local items = safe(function() return inv:getItems() end, nil)
    if not items then return false, 'no-actions' end
    local n = probe(function() return items:size() end)
    if not n or n == 0 then return false, 'no-weapon' end

    -- 挑一把：分类是 Weapon 的优先，同类里挑伤害高的。
    -- 不按名字猜 —— 真机翻过车（抹布的 MaxDamage 也有 1.5）。
    local best, bestScore = nil, -1
    for i = 0, n - 1 do
        local it = safe(function() return items:get(i) end, nil)
        if it then
            local cat = tostring(safe(function() return it:getCategory() end, '') or '')
            local isWeapon = string.lower(cat) == 'weapon'
            if isWeapon then
                local si = safe(function() return it:getScriptItem() end, nil)
                local dmg = 0
                if si then
                    local v = probe(function() return si:getMaxDamage() end)
                    if type(v) == 'number' then dmg = v end
                end
                if dmg > bestScore then best, bestScore = it, dmg end
            end
        end
    end
    if not best then return false, 'no-weapon' end

    local num = 0
    if pcall(function() num = p:getPlayerNum() end) then else num = 0 end
    local twoHands = false
    local ok2, v = pcall(function() return best:isTwoHandWeapon() end)
    if ok2 and v == true then twoHands = true end

    local ok3 = pcall(function()
        ISInventoryPaneContextMenu.equipWeapon(best, true, twoHands, num)
    end)
    if not ok3 then return false, 'equip-failed' end
    return true, 'item:' .. tostring(safe(function() return best:getName() end, '?'))
end

-- ---------------------------------------------------------------- 反射
--
-- 为什么要有这一层：一次「看到僵尸 → 模型收到 → 模型下指令 → 游戏执行」
-- 的往返是**秒级**的。状态写得再勤也没用 —— 模型那一轮就要两到五秒。
-- 而僵尸贴脸只需要一秒半。所以「挡不挡这一下」不能由模型决定，
-- 必须放回游戏里，按帧判断。
--
-- 分工：
--   模型管「去哪、做什么、拿什么」（战略，几秒一拍没问题）
--   这一层管「现在有没有东西要咬我」（反射，几十毫秒一拍）
--
-- 这一层只做两件事：转身面对最近的僵尸、挥一下。它不走路、不拿东西 ——
-- 那些是模型的事。它唯一会打断的，是手里那件**正在做但马上要命**的活。
--
-- 关掉它：指令 `guard|0`。默认开。

B.REFLEX = {
    on = true,
    n = 0,        -- 累计自主出手次数
    act = '',     -- 最近一次动作（ascii，别放中文 —— 见 q() 与 ACK 那段的说明）
    at = 0,       -- 最近一次出手时的帧号
    near = nil,   -- 最近僵尸的距离（格）
    cnt = 0,      -- 扫描半径内的僵尸数
}

-- 实测：`tickBody` 一秒被调约一千次（三个事件都挂在上头），
-- 所以这两个「每 N 次」其实约等于毫秒数。掉帧时它们会被拉长，
-- 那正好 —— 卡的时候本来就该少算一点。
local REFLEX_SCAN_EVERY = 50     -- 约 50ms 扫一次
local REFLEX_ATK_GAP = 350       -- 约 0.35 秒最多挥一次（近战一挥大约半秒）
local REFLEX_REACH = 1.8         -- 够得着的距离（格）。再远就是空挥，白费体力
local REFLEX_RADIUS = 3          -- 扫描半径（格）

local reflexNextAtk = 0
local reflexScanOk = nil         -- getMovingObjects 能不能用；nil = 还没试过

--- 扫脚下 r 格见方内的僵尸。返回 数量, 最近的那只, 距离。
---
--- 为什么按格扫、不用 `nearestZombie` 那个全对象列表：反射要跑几十毫秒一次，
--- 而 `getObjectListForLua()` 给的是整个世界对象（几千个）。按格问只碰 49 个格子，
--- 每个格子上挂的移动对象通常个位数 —— 差两个数量级。
---
--- `getMovingObjects` 万一在这个构建里不存在，就退回 `nearestZombie`（慢但能用），
--- 并且**记住**它不行，之后不再反复试 —— Kahlua 每抛一次打一整段堆栈。
local function threatScan(p, r)
    local cell = getCell()
    if not cell then return 0, nil, nil end

    local px, py = p:getX(), p:getY()
    local bx, by = math.floor(px), math.floor(py)
    local pz = math.floor(p:getZ())
    local cnt, best, bestD = 0, nil, nil

    if reflexScanOk ~= false then
        local okAll = true
        for dx = -r, r do
            for dy = -r, r do
                local sq = cell:getGridSquare(bx + dx, by + dy, pz)
                if sq then
                    local mo = nil
                    local got = pcall(function() mo = sq:getMovingObjects() end)
                    if not got or mo == nil then
                        okAll = false
                    else
                        local n = 0
                        if pcall(function() n = mo:size() end) then
                            for i = 0, n - 1 do
                                local o = nil
                                if pcall(function() o = mo:get(i) end) and o
                                    and instanceof(o, "IsoZombie") then
                                    cnt = cnt + 1
                                    local ddx, ddy = o:getX() - px, o:getY() - py
                                    local d = ddx * ddx + ddy * ddy
                                    if bestD == nil or d < bestD then best, bestD = o, d end
                                end
                            end
                        end
                    end
                end
            end
        end
        if reflexScanOk == nil then
            reflexScanOk = okAll
            if not okAll then diag('threatScan: getMovingObjects unavailable, falling back') end
        end
    end

    if reflexScanOk == false then
        local z = nearestZombie(p, r)
        if z then
            local ddx, ddy = z:getX() - px, z:getY() - py
            return 1, z, math.sqrt(ddx * ddx + ddy * ddy)
        end
        return 0, nil, nil
    end
    return cnt, best, bestD and math.sqrt(bestD) or nil
end

-- ---------------------------------------------------------------- 谁在开车
--
-- 反射层原本是为「她自己在玩」设计的：她下了指令，走路途中被僵尸贴上，
-- 不等模型往返就得自己挡一下。但**身体只有一个** —— 他握着鼠标的时候，
-- 这条反射就是在跟他抢同一个 Bob。
--
-- 真机反馈：「还有自动打怪，干扰操作啊」。具体长这样：
--
--   · 他举着枪在瞄，反射层按自己的判断把朝向转到最近那只 —— 他瞄好的目标跑了
--   · 他正按键走位，反射层一挥手把他按住的方向键顶掉
--   · 他正在拆东西/吃饭，僵尸靠近时 `ISTimedActionQueue.clear(p)` 把他手上的活清掉
--
-- 所以判据不是「附近有没有僵尸」，是**「现在是不是他在操作」**。三个来源：
--
--   1. 举枪 / 正在攻击 —— 最明确，没有歧义
--   2. 按着移动键 —— 手在键盘上
--   3. 位置在变但我们队列是空的 —— 他用鼠标点地走，不按 WASD 也要算
--
-- 三条都不成立才轮到反射。他松手（AFK）僵尸贴脸，反射接手保命 —— 那才是它该干的活。
--
-- 注意第 3 条为什么要求「队列空」：她自己的 walk 也在改变位置，
-- 不排除掉的话，她每走一步都会被判成「玩家在操作」，反射就永远不响了。

B.HANDS = { on = false, why = '', at = 0 }

local handsLastX, handsLastY = nil, nil
local handsLastMouseX, handsLastMouseY = nil, nil
--- 最近一次「检测到他在动」的 tick。
---
--- 真机上第一版给了 90 tick 的余量（约一百毫秒），结果**只要他停下来一秒就算他不在** ——
--- 而停下来点右键开门、翻背包、看一封信，正是僵尸最容易贴上来的时刻。
--- 那时反射层替他打，他的观感就是「我什么都没按，她在自己打」。
---
--- 现在拉到约九秒：他坐在电脑前、动过鼠标，就算他在。真走开了（倒水、上厕所），
--- 九秒后反射才接手。
local handsActiveAt = -1e9
local HANDS_IDLE_TICKS = 6000   -- tickBody 一秒被调约 680 次（含三个事件），约 9 秒

--- 键按着没有。
---
--- `isKeyDown` 是客户端全局函数。万一这个构建上没有，就**记住**它不行、
--- 之后不再试 —— 每帧抛一次 Kahlua 堆栈比少一条判据糟得多。
local keyOk = nil
local function keyDown(k)
    if keyOk == false or k == nil then return false end
    local ok, v = pcall(isKeyDown, k)
    if not ok then
        if keyOk == nil then
            keyOk = false
            diag('isKeyDown unavailable, hands detection degraded')
        end
        return false
    end
    keyOk = true
    return v == true
end

local function moveKeyDown()
    if type(Keyboard) ~= 'table' then return false end
    return keyDown(Keyboard.KEY_W) or keyDown(Keyboard.KEY_A)
        or keyDown(Keyboard.KEY_S) or keyDown(Keyboard.KEY_D)
        or keyDown(Keyboard.KEY_UP) or keyDown(Keyboard.KEY_DOWN)
        or keyDown(Keyboard.KEY_LEFT) or keyDown(Keyboard.KEY_RIGHT)
end

--- 他是不是正坐在电脑前。返回 `是/否, 依据`。
---
--- 「在」不等于「在按键」—— 坐下来点右键开门、翻背包、读一封信，这些都不产生按键，
--- 但手就在那儿。所以判据是「最近约九秒里有没有任何输入迹象」。
local function playerHandsOn(p, t)
    if not p then return false, '' end
    local why = ''

    -- 1. 举枪 / 攻击中。最明确的两个信号。
    local aiming = false
    if pcall(function() aiming = p:isAiming() == true end) and aiming then
        handsActiveAt = t
        return true, 'aiming'
    end
    local atk = false
    if pcall(function() atk = p:isAttacking() == true end) and atk then
        handsActiveAt = t
        return true, 'attacking'
    end

    -- 2. 按着移动键
    if moveKeyDown() then
        handsActiveAt = t
        return true, 'keys'
    end

    -- 3. 鼠标点地走：位置在变，而我们自己的队列是空的
    local x, y = p:getX(), p:getY()
    if handsLastX and handsLastY then
        local dx, dy = x - handsLastX, y - handsLastY
        if (dx * dx + dy * dy) > 0.0004 and not isBusy(p) then
            handsActiveAt = t
            why = 'moving'
        end
    end
    handsLastX, handsLastY = x, y

    -- 4. 鼠标在动。这条覆盖的是「他没在走，但手在鼠标上」——
    --    按右键开门、翻背包、指着一个方向看。这一条以前没有，
    --    所以他只要站住不动，反射层就当他不在。
    if type(getMouseX) == 'function' and type(getMouseY) == 'function' then
        local mx, my = nil, nil
        if pcall(function() mx = getMouseX(); my = getMouseY() end) and mx then
            if handsLastMouseX and handsLastMouseY then
                local mdx, mdy = mx - handsLastMouseX, my - handsLastMouseY
                if (mdx * mdx + mdy * mdy) > 4 then   -- 约 2 像素
                    handsActiveAt = t
                    why = 'mouse'
                end
            end
            handsLastMouseX, handsLastMouseY = mx, my
        end
    end

    if t - handsActiveAt < HANDS_IDLE_TICKS then
        return true, why ~= '' and why or 'recent'
    end
    return false, ''
end

--- 反射一拍。`t` 是 tickBody 的调用计数，只用来做节流。
local function reflexTick(p, t)
    local R = B.REFLEX
    if not R or not R.on or not p then return end
    if t % REFLEX_SCAN_EVERY ~= 0 then return end

    local cnt, z, d = threatScan(p, REFLEX_RADIUS)
    R.cnt = cnt
    R.near = d

    -- 扫描照做（`threat` 那对读数是她在判断「迎上去还是绕开」时要看的），
    -- 但**动手之前**要问一句「现在是不是他在操作」。
    --
    -- 他举枪、按着方向键、用鼠标点地走 —— 任一条成立就整段让开：
    -- 不转向、不挥、也不清他手上的活。他自己会打，用不着替他做决定。
    local hands, why = playerHandsOn(p, t)
    local H = B.HANDS
    if H then H.on = hands; H.why = why; H.at = t end
    if hands then return end

    -- **她没在开车，就不替任何人做决定。**
    --
    -- 第一版只问了「他在不在」。漏洞很具体：他坐下来点右键开门、翻背包、
    -- 读一封信 —— 没按键、没瞄准、人也没动，于是被判成「他不在」，
    -- 反射层就开始自己打。他的观感是「我什么都没按，她在替我打」。
    --
    -- 现在两个条件同时成立才动手：
    --   1. 他在（最近约九秒有任何输入迹象，见 playerHandsOn）
    --   2. 她在开车（队列里还有活 / 正在做 / 二十秒内下过指令）
    --
    -- 走到这里说明他不在（上面那条已经 return 过了）。
    -- 剩下唯一该问的是「她到底在不在开车」—— 不在就不动手，
    -- 否则就成了「两个人都没在管，她自己替他们做决定」。
    local sheDriving = isBusy(p) or (B.CMD_LEFT or 0) > 0
        or (os.time() - (B.LAST_CMD_AT or 0)) <= 20
    B.SHE_DRIVING = sheDriving
    if not sheDriving then return end

    if cnt == 0 or not z or not d then return end

    -- 够得着才动手。够不着就只把距离报上去 —— 让模型去决定「迎上去还是绕开」，
    -- 那是它的判断，不该由反射替它做。
    if d > REFLEX_REACH then return end
    if t < reflexNextAtk then return end
    reflexNextAtk = t + REFLEX_ATK_GAP

    -- 手里的活先停。拿着锅站在僵尸面前是最糟的状态，
    -- 所以这里允许打断 —— 但只在僵尸近到能咬人的时候打断。
    if isBusy(p) and ISTimedActionQueue then
        pcall(function() ISTimedActionQueue.clear(p) end)
        R.act = 'interrupt'
    end

    pcall(function() p:faceThisObject(z) end)
    local ok = tryAttack(p)
    R.n = R.n + 1
    R.at = t
    R.act = ok and 'attack' or 'attack-fail'
    if R.n == 1 or R.n % 10 == 0 then
        diag('reflex #' .. tostring(R.n) .. ' d=' .. string.format('%.1f', d) .. ' n=' .. tostring(cnt))
    end
end

-- ---------------------------------------------------------------- 顺手
--
-- 门是要关的。
--
-- 真机反馈：「进门也不关门」。这件事不该交给她判断 —— 她一次只能下一个动作，
-- 一条 `door` 指令要占掉一整轮，而关门这种事一分钟可能发生三次。
-- 「去哪、做什么」是判断，开关门是习惯。习惯放在这里。
--
-- 只做一件事：脚下和紧邻四格有开着的门，顺手带上。
-- 有僵尸在附近就不关 —— 关门要停一下，逃命的时候那是浪费。

-- **默认关。** 这是我自己加的「顺手」，他不要。
--
-- 加它的理由是「进门不关门」，但真跑起来才知道代价：她走过去门自动带上，
-- 转身又要开一次，看起来像在原地跟门较劲。而且这件事每分钟都会发生几回，
-- 存在感比收益大得多。要开就把它改成 true。
B.AUTODOOR = false

local doorIsOpenOk = nil
local function doorOpen(door)
    if doorIsOpenOk == false then return nil end
    local ok, v = pcall(function() return door:isOpen() end)
    if not ok then
        if doorIsOpenOk == nil then
            doorIsOpenOk = false
            diag('IsoDoor:isOpen unavailable, auto-close off')
        end
        return nil
    end
    doorIsOpenOk = true
    return v
end

local tidyDoorAt = 0
local function tidyDoor(p, t)
    if not B.AUTODOOR or not p then return end
    if t - tidyDoorAt < 150 then return end   -- 约 1.5 秒看一次
    tidyDoorAt = t

    -- 逃命时不关。反射层刚扫过，直接问它有没有人。
    local R = B.REFLEX
    if R and (R.cnt or 0) > 0 then return end

    -- 他在自己玩就别管门。这条和反射层同一个道理：身体只有一个。
    if B.HANDS and B.HANDS.on then return end

    local cell = getCell()
    if not cell then return end
    local bx = math.floor(p:getX())
    local by = math.floor(p:getY())
    local pz = math.floor(p:getZ())

    -- 脚下 + 四邻。门挂在墙格上，人从门口过去时未必站在门那一格，
    -- 所以要看一圈 —— 但只看一圈，别把走廊尽头别人家的门也带上。
    local offs = { {0,0}, {0,-1}, {0,1}, {-1,0}, {1,0} }
    for i = 1, #offs do
        local sq = cell:getGridSquare(bx + offs[i][1], by + offs[i][2], pz)
        if sq then
            local door = doorAt(sq)
            if door and doorOpen(door) == true then
                pcall(function() door:ToggleDoor(p) end)
                return
            end
        end
    end
end

-- ---------------------------------------------------------------- 写文件

--- 写整份文件。
---
--- 三个硬规矩，每条都是踩出来的：
---  1. `getFileWriter(path, true, false)` 必须给满三个参数。B42 的 vanilla 和所有 mod
---     都这么写；少一个参数时 Java 侧直接失败，而 pcall 会把这个错误吞得干干净净 ——
---     表现是「mod 加载了、横幅打了、一个字节都不写」，能查一整轮。
---  2. 不调 `w:flush()`，那个方法不一定存在。
---  3. 写单文件名，跟 `layout.ini` 一样落在 `Zomboid/Lua/` 根；不要子目录，
---     `create=true` 不保证会替你建中间目录。
---
--- 失败要说出来。只打前几条，不刷屏。
local wroteOnce = false
local function writeState(body)
    local didWrite = false
    local ok, err = pcall(function()
        local w = getFileWriter(B.OUT_FILE, true, false)
        if not w then diag("writer returned nil: " .. tostring(B.OUT_FILE)); return end
        w:write(body)
        w:close()
        didWrite = true
    end)
    if not ok then
        diag("write failed: " .. tostring(err))
    elseif didWrite and not wroteOnce then
        wroteOnce = true
        diag("first state written (" .. #body .. " bytes)")
    end
    return ok and didWrite
end

local function buildJson(p, clock, pl, gear, loot, alive)
    local parts = {}
    local function add(k, v) parts[#parts + 1] = q(k) .. ":" .. v end

    add("v", ni(B.VERSION))
    add("seq", ni(seq))
    add("ts", ni(os.time()))
    add("alive", nbool(alive))
    add("kills", ni(kills))
    add("session", session and q(session) or "null")

    if clock then
        add("clock", '{"hour":' .. n4(clock.hour) .. ',"minute":' .. n4(clock.minute)
            .. ',"day":' .. ni(clock.day) .. ',"night":' .. nbool(clock.night) .. "}")
    else
        add("clock", "null")
    end

    if pl then
        local f = {}
        local function p2(k, v) f[#f + 1] = q(k) .. ":" .. v end
        p2("x", n4(pl.x))
        p2("y", n4(pl.y))
        p2("z", n4(pl.z))
        p2("outside", nbool(pl.outside))
        p2("room", pl.room and q(pl.room) or "null")
        p2("building", pl.building and q(pl.building) or "null")
        p2("health", n4(pl.health))
        p2("hunger", n4(pl.hunger))
        p2("thirst", n4(pl.thirst))
        p2("fatigue", n4(pl.fatigue))
        p2("endurance", n4(pl.endurance))
        p2("stress", n4(pl.stress))
        p2("panic", n4(pl.panic))
        p2("pain", n4(pl.pain))
        p2("boredom", n4(pl.boredom))
        p2("unhappy", n4(pl.unhappy))
        p2("visible", n4(pl.visible))
        p2("infected", nbool(pl.infected))
        p2("infection", n4(pl.infection))
        p2("bodyHealth", n4(pl.bodyHealth))
        p2("weapon", pl.weapon and q(pl.weapon) or "null")
        p2("weaponCond", n4(pl.weaponCond))
        p2("weaponMax", n4(pl.weaponMax))
        p2("weaponDmg", n4(pl.weaponDmg))
        p2("weaponRng", n4(pl.weaponRng))
        p2("weaponTwo", nbool(pl.weaponTwo))
        p2("offhand", pl.offhand and q(pl.offhand) or "null")
        if pl.skills then
            local keys = {}
            for k in pairs(pl.skills) do keys[#keys + 1] = k end
            table.sort(keys)
            local sp = {}
            for _, k in ipairs(keys) do sp[#sp + 1] = q(k) .. ":" .. ni(pl.skills[k]) end
            p2("skills", "{" .. table.concat(sp, ",") .. "}")
        end
        add("player", "{" .. table.concat(f, ",") .. "}")
    else
        add("player", "null")
    end

    if gear then
        add("gear", '{"bandage":' .. ni(gear.bandage) .. ',"food":' .. ni(gear.food)
            .. ',"water":' .. ni(gear.water) .. ',"light":' .. ni(gear.light) .. "}")
    else
        add("gear", "null")
    end

    -- 他正打开的那个容器。`null` = 没开任何容器（或者那个页面读不到），
    -- 和 `hits:[]`（开了但是空的）是两件事，外面分开说话。
    if loot then
        local hs = {}
        for i = 1, #loot.hits do
            local h = loot.hits[i]
            hs[#hs + 1] = '{"n":' .. q(h.n) .. ',"t":' .. ni(h.t) .. ',"d":' .. n4(h.d)
                .. ',"w":' .. nbool(h.w) .. ',"i":' .. ni(h.i) .. "}"
        end
        -- 全部清单：前 10 件的名字 + 序号。`i` 是 `take` 要的 itemIdx。
        local as = {}
        for i = 1, #(loot.all or {}) do
            local a = loot.all[i]
            as[#as + 1] = '{"n":' .. q(a.n) .. ',"i":' .. ni(a.i) .. ',"t":' .. ni(a.t) .. "}"
        end
        add("loot", '{"sig":' .. q(loot.sig) .. ',"type":' .. q(loot.type)
            .. ',"total":' .. ni(loot.total) .. ',"hits":[' .. table.concat(hs, ",") .. "]"
            .. ',"all":[' .. table.concat(as, ",") .. "]"
            -- 容器在哪、它是那一格的第几个 object：下 take 指令全靠这三个数。
            .. ',"x":' .. n4(loot.x) .. ',"y":' .. n4(loot.y) .. ',"oi":' .. ni(loot.oi) .. "}")
    else
        add("loot", "null")
    end

    local d = B.DBG or {}
    add("dbg", '{"last":' .. q(d.last or "?") .. ',"lastP":' .. nbool(d.lastP)
        .. ',"n":' .. ni(d.n or 0)
        .. ',"pVia":' .. q(d.pVia or "") .. ',"pN":' .. ni(d.pN or 0)
        .. ',"err":' .. q(d.err or "")
        .. ',"hbt":' .. ni(HB.tick or 0) .. ',"hbp":' .. ni(HB.playerUpdate or 0)
        .. ',"hbr":' .. ni(HB.render or 0) .. ',"load":' .. ni(B.LOAD_N) .. "}")
    add("events", encodeEvents())

    -- 指令回执：她要知道「上一条动没动成」，而不是自己猜。
    if B.CMD then
        add("cmd", '{"seq":' .. ni(B.CMD.seq) .. ',"verb":' .. q(B.CMD.verb)
            .. ',"ok":' .. nbool(B.CMD.ok) .. ',"why":' .. q(B.CMD.why) .. "}")
    else
        add("cmd", "null")
    end
    add("busy", nbool(isBusy(p)))

    -- 她刚问过「这儿能做什么」。名字全是游戏自己给的（本地化过的），
    -- 所以外面不要翻译、不要改写，原样给她 —— 她挑的时候要照抄。
    if B.SQUAD and (os.time() - (B.SQUAD.at or 0)) <= 60 then
        local ss = {}
        for i = 1, #B.SQUAD.list do
            local m = B.SQUAD.list[i]
            ss[#ss + 1] = '{"id":' .. q(m.id) .. ',"n":' .. q(m.name) .. ',"job":' .. q(m.job)
                .. ',"r":' .. nbool(m.r) .. ',"x":' .. n4(m.x) .. ',"y":' .. n4(m.y) .. "}"
        end
        add("squad", '{"at":' .. ni(B.SQUAD.at) .. ',"list":[' .. table.concat(ss, ",") .. "]}")
    else
        add("squad", "null")
    end

    if B.MENU then
        local ms = {}
        for i = 1, #B.MENU.list do
            local m = B.MENU.list[i]
            ms[#ms + 1] = '{"n":' .. q(m.n) .. ',"i":' .. ni(m.i) .. "}"
        end
        add("menu", '{"at":' .. ni(B.MENU.at) .. ',"list":[' .. table.concat(ms, ",") .. "]}")
    else
        add("menu", "null")
    end

    -- 她看过的那一格。`look` 写进来的，带容器序号和每件东西的 index ——
    -- 有了这两组数，`take` 才拼得出来。
    -- 看过的那一格也会过期。走开之后它还在，她会对着一个已经不挨着的柜子
    -- 说「拿那个」—— 距离是 Lua 侧不检查的（take 那边会拒），但话已经说出去了。
    if B.PEEK and (os.time() - (B.PEEK.at or 0)) > 90 then B.PEEK = nil end
    if B.PEEK then
        local bx = {}
        for i = 1, #B.PEEK.boxes do
            local b = B.PEEK.boxes[i]
            local its = {}
            for k = 1, #b.items do
                local it = b.items[k]
                its[#its + 1] = '{"n":' .. q(it.n) .. ',"i":' .. ni(it.i) .. ',"w":' .. nbool(it.w) .. "}"
            end
            bx[#bx + 1] = '{"oi":' .. ni(b.oi) .. ',"n":' .. q(b.n) .. ',"total":' .. ni(b.total)
                .. ',"items":[' .. table.concat(its, ",") .. "]}"
        end
        add("peek", '{"at":' .. ni(B.PEEK.at) .. ',"x":' .. n4(B.PEEK.x) .. ',"y":' .. n4(B.PEEK.y)
            .. ',"boxes":[' .. table.concat(bx, ",") .. "]}")
    else
        add("peek", "null")
    end

    -- 队列里还有几条没执行。她连下三条之后要知道「后面还有两条排着」——
    -- 否则她会以为只下了一条，下一拍又补一条，越排越多。
    add("cmdLeft", ni(B.CMD_LEFT or 0))

    -- 他是不是正在自己操作（举枪 / 按着方向键 / 用鼠标点地走）。
    --
    -- 这个字段的唯一用途：**他在玩的时候，她别下指令**。同一个角色只有一个身体，
    -- 她一条 walk 压下去，他按着的方向键就被顶掉；她一条 take，他正要开的那扇门
    -- 就跑到后面排队。那不是帮忙，那是抢方向盘。
    -- 人形探针的自报：注册成没成、上次失败在哪一步。
    -- 探针没有「用户可见的界面」，state 是唯一能看到它的地方。
    local HU = B.HUMAN or {}
    add("human", '{"on":' .. nbool(HU.on == true) .. ',"ready":' .. nbool(HU.ready == true)
        .. ',"err":' .. q(HU.err or '') .. "}")

    -- 她的另一具身体。没装 Companion Dogs 就是 null（外面据此判断「这条路不可用」）。
    local dg = dogSnap(p)
    if dg then
        add("dog", '{"have":' .. nbool(dg.have) .. ',"mod":' .. nbool(dg.mod)
            .. ',"n":' .. q(dg.name or '') .. ',"mode":' .. q(dg.mode or 'none')
            .. ',"id":' .. ni(dg.id or -1)
            .. ',"x":' .. n4(dg.x) .. ',"y":' .. n4(dg.y)
            .. ',"d":' .. n4(dg.d)
            .. ',"mv":' .. nbool(dg.moving) .. ',"blk":' .. nbool(dg.blocked)
            .. ',"tx":' .. ni(dg.tx or -1) .. ',"ty":' .. ni(dg.ty or -1) .. "}")
    else
        add("dog", "null")
    end

    local hands = B.HANDS or {}
    -- `drv` 是「她到底在不在开车」—— 反射层现在两个条件都要满足才动手，
    -- 缺一个它就哑着。这两个字段放一起，下次有人说「它又不打了」，
    -- 一眼就能看出是「他在」还是「她没在开」。
    add("hands", '{"on":' .. nbool(hands.on) .. ',"why":' .. q(hands.why or '')
        .. ',"drv":' .. nbool(B.SHE_DRIVING == true) .. "}")

    -- 威胁读数。`d` 是她到最近那只的距离（格），`n` 是 3 格内的只数。
    -- 这两个数是**反射层自己量的**，比 `visible`（只有视线内）准 ——
    -- 模型要判断「迎上去还是绕开」就得看它们。
    local R = B.REFLEX or {}
    add("threat", '{"n":' .. ni(R.cnt or 0) .. ',"d":' .. n4(R.near) .. "}")

    -- 反射层自报：开没开、累计出手几次、最近那次做了什么。
    -- `act` 是 ascii（attack / attack-fail / interrupt），翻译在外面做。
    add("reflex", '{"on":' .. nbool(R.on ~= false) .. ',"n":' .. ni(R.n or 0)
        .. ',"act":' .. q(R.act or '') .. "}")

    -- 最近一次 `scan` 的结果。只在被问过之后才有，不带它就一直 null。
    if B.SCAN then
        local items = {}
        for i = 1, #B.SCAN.list do
            local it = B.SCAN.list[i]
            items[#items + 1] = '{"n":' .. q(it.n) .. ',"c":' .. q(it.c) .. "}"
        end
        add("craftables", '{"at":' .. ni(B.SCAN.at) .. ',"partial":' .. nbool(B.SCAN.partial)
            .. ',"list":[' .. table.concat(items, ",") .. "]}")
    else
        add("craftables", "null")
    end

    return "{" .. table.concat(parts, ",") .. "}"
end

-- ---------------------------------------------------------------- 一拍

local function flush(explicitPlayer)
    flushCount = flushCount + 1
    -- 优先用事件递进来的 player。OnPlayerUpdate / OnTick 都会给，
    -- 拿不到再退回 getPlayer()。两条路都空才算「不在游戏里」。
    local p = explicitPlayer or getPlayerSafe()
    local alive = p ~= nil

    local clock = alive and readClock() or nil
    local pl = nil
    local gear = nil
    local loot = nil

    if alive then
        pl = readPlayer(p)
        if gearCache == nil or flushCount % GEAR_EVERY == 1 then
            gearCache = readGear(p) or gearCache
        end
        gear = gearCache
        -- 容器：**每拍都问一次「打开的是哪个」**，换了容器才重新扫内容。
        -- 原来固定每 3 拍扫一次 —— 真机上就是「翻完走了才报」的来源（3 拍 ≈ 6 秒，
        -- 他一个柜台停留不了那么久）。身份查询只是两次 Java 取值，每拍查得起。
        -- 另外每 10 拍兜底重扫一次：内容变了（他拿走一件）sig 不变，靠这个跟上。
        local h = lootHandle()
        if h then
            if h.sig ~= lootSig or flushCount - lootScanAt >= 10 then
                lootCache = scanLoot(h, p)
                lootSig = h.sig
                lootScanAt = flushCount
            end
            loot = lootCache
        else
            lootCache = nil
            lootSig = ''
            loot = nil
        end
    else
        gearCache = nil
        lootCache = nil
    end

    -- 从上一拍推出来的事实：掉血、感染、入夜。
    -- 用增量推而不是挂 OnHit，是因为一次攻击会同时触发好几个回调，
    -- 逐个转发等于把同一件事说三遍。
    if pl then
        local hp = pl.health
        if prev.health and hp and hp < prev.health - 0.02 then
            push("hurt", { loss = prev.health - hp, health = hp })
        end
        if prev.health == nil or (hp and hp > prev.health) then
            -- 回血了不算事件，但水位要更新
        end
        if hp then prev.health = hp end

        if prev.infected == false and pl.infected == true then
            push("infected", { level = pl.infection or 0 })
        end
        if type(pl.infected) == "boolean" then prev.infected = pl.infected end
    else
        prev.health = nil
        prev.infected = nil
    end

    if clock and type(clock.night) == "boolean" then
        if prev.night == false and clock.night == true then
            push("night", { day = clock.day or 0 })
        end
        prev.night = clock.night
    end

    if kills > 0 then
        push("kill", { count = kills })
        kills = 0
    end

    local body = nil
    local okEnc, encoded = pcall(buildJson, p, clock, pl, gear, loot, alive)
    if okEnc then body = encoded else diag("json failed: " .. tostring(encoded)) end
    if not body then return end

    writeState(body)
end

-- ------------------------------------------------------------ 心跳（诊断）

-- 每个事件写自己一个文件。
--
-- 之前只有一个主文件，出问题时分不清两种完全不同的情况：
--   a) 回调根本没被调用（事件系统/环境的问题）
--   b) 回调在跑，但写文件失败了（IO/权限/路径的问题）
-- 两者的修法毫无交集，而主文件不刷新时看起来一模一样。真机已经在这上面耗了几轮。
--
-- 分开写之后一眼可判：
--   hb1-render 在刷、hb1-tick 不存在  -> OnTick 这个事件确实没触发
--   所有 hb 都停在同一秒              -> 写文件这条路断了，或者游戏退出
--
-- 文件名带 load 序号：shared 和 client 两份脚本都会跑，
-- 序号能看出是哪一个环境在真正收到事件。
local HB_EVERY = 60

--- 只写不抛。返回 ok, err。诊断文件不能把主流程带崩。
local function writeRaw(name, body)
    local ok, err = pcall(function()
        local w = getFileWriter(name, true, false)
        if not w then error("writer returned nil") end
        w:write(body)
        w:close()
    end)
    return ok, err
end

local function beat(name, p)
    local c = (HB[name] or 0) + 1
    HB[name] = c
    -- 前三次全记（能看出是不是只响一次就没了），之后每 60 次记一次
    if c > 3 and c % HB_EVERY ~= 0 then return end
    local body = '{"ev":"' .. name .. '","c":' .. ni(c) .. ',"ts":' .. ni(os.time())
        .. ',"hasP":' .. nbool(p ~= nil) .. ',"load":' .. ni(B.LOAD_N) .. '}'
    local ok, err = writeRaw("coopani-pz-hb" .. ni(B.LOAD_N) .. "-" .. name .. ".txt", body)
    if not ok then
        writeRaw("coopani-pz-hbfail" .. ni(B.LOAD_N) .. ".txt",
            '{"ev":"' .. name .. '","c":' .. ni(c) .. ',"err":' .. q(tostring(err)) .. '}')
    end
end

B.HB = HB

-- ---------------------------------------------------------------- 挂钩

--- 会话号。
---
--- 别用 `os.clock()`：Kahlua 里它可能是 **nil**，一调就抛
--- `Object tried to call nil`，把整个 onGameStart 打断 —— 于是
--- `session_start` 永远推不出去，她进世界时一句话不说。真机报错原话：
--- `Object tried to call nil in onGameStart at CoopaniBridge.lua:513`。
local function newSessionId()
    local t = os.time() or 0
    local ms = 0
    if type(os.clock) == "function" then
        local ok, c = pcall(os.clock)
        if ok and type(c) == "number" then ms = math.floor((c * 1000) % 100000) end
    end
    return tostring(t) .. "-" .. tostring(ms)
end

--- 开一局就把指令文件清空。
---
--- 不清的话，上一局剩下的行会一直在文件里：桌面侧只保留最近 20 行，而那 20 行
--- 里可能全是几十分钟前的。游戏这边 `cmdDone` 是内存里的表，重启就空 ——
--- 于是每次开局都要先把一堆陈年旧账逐条「过期掉」，队列才轮到新指令。
--- 真机就是这么卡的：cmdLeft 一直 19，回执是几十分钟前那条。
local function clearCmdFile()
    pcall(function()
        local w = getFileWriter(B.CMD_FILE, true, false)
        if not w then return end
        w:write("")
        w:close()
    end)
end

local function onGameStart()
    beat("gameStart")
    diag("OnGameStart fired")
    session = newSessionId()
    clearCmdFile()
    prev.health = nil
    prev.infected = nil
    prev.night = nil
    gearCache = nil
    lootCache = nil
    kills = 0
    push("session_start", { at = os.time() })
    flush()
end

local function onPlayerDeath(player)
    beat("death", player)
    local x, y = nil, nil
    if player then
        x = probe(function() return player:getX() end)
        y = probe(function() return player:getY() end)
    end
    push("death", { x = x or -1, y = y or -1, day = (readClock() or {}).day or -1 })
    flush()
end

local function onZombieDead(z)
    -- 这里只计数，不逐条上报：一场尸潮能杀出几百只，
    -- 逐条推会把外面的环缓冲冲干净，别的消息全被挤掉。
    kills = kills + 1
end

local tickSeen = false
local tickName = "?"
local frameCount = 0

--- 每拍要干的活。三个 tick 事件共用。
---
--- 闸门按**帧数**算，不按时间。
--- 原本是 `t - lastFlushMs < 2000`，而 `t` 来自 `probe(getTimestamp)` ——
--- B42 里那个返回值不是 Lua number，probe 直接给 nil，退回 `tickCount * 16`；
--- 可 tickCount 是全文件共享的计数器，三个事件一起加，增量跟真实时间对不上。
--- 结果：第一拍 `t - 0` 很大，写了一份；之后永远差不到 2000，**再也不写**。
--- 真机就是这么卡住的（state.json 停在第一份，mtime 不再变）。
local function tickBody(p)
    frameCount = frameCount + 1

    -- 诊断不能被覆盖：OnRenderTick 每帧都跑，如果只记「最后一跳」，
    -- OnPlayerUpdate 带着 player 进来也会被下一帧刷掉，看起来像从没拿到过玩家。
    local d = B.DBG or {}
    B.DBG = { last = tickName, lastP = (p ~= nil), n = frameCount, pVia = d.pVia, pN = d.pN, err = d.err }
    if p ~= nil then
        B.DBG.pVia = tickName
        B.DBG.pN = frameCount
    end

    -- 重绑不放在这里。原来用 `getGameTime() ~= nil` 当「世界已加载」，
    -- 而它在启动阶段就有值 —— 于是重绑发生在 f:0，等真正进世界时它早就跑过了，
    -- 再也不会重来一次。改挂 Events.OnGameTimeLoaded（引擎自己会打这行日志，最可靠）。

    if not tickSeen then tickSeen = true; diag("tick fired via " .. tickName) end

    -- 第一次拿到玩家的那一跳，立刻写，不等帧闸门。
    -- 帧闸门是给「每帧都跑」的 OnRenderTick 用的；带 player 的事件可能一次就过去了。
    if p ~= nil and not B._firstP then
        B._firstP = true
        diag("got player via " .. tickName)
        pcall(flush, p)
        return
    end

    -- 指令比状态急：每 30 帧问一次（约半秒）。她按下「去那儿」之后要等两秒
    -- 才动，体感就是「她没听见」。状态仍然 120 帧一写，没必要跟着加密。
    local pNow = p or getPlayerSafe()

    -- 反射先于指令。顺序是有意的：僵尸贴脸的时候，「这一下挡不挡」不该
    -- 排在一条几秒前算好的走路指令后面。
    pcall(reflexTick, pNow, frameCount)

    -- 顺手关门。放在反射后面：先保命，再讲体面。
    pcall(tidyDoor, pNow, frameCount)

    if frameCount % 30 == 0 then pcall(pollCommand, pNow) end

    if frameCount % 120 ~= 0 then return end
    if frameCount % 1200 == 0 then
        diag("tick alive #" .. frameCount .. " via " .. tickName .. " player=" .. tostring(p ~= nil))
    end
    local ok, err = pcall(flush, p)
    if not ok then
        B.DBG.err = tostring(err)
        diag("flush failed: " .. tostring(err))
    end
end

-- 三个都挂：真机上行只证明了「横幅会打、回调不响」，所以不能只赌 OnTick。
local function onTick() beat("tick"); tickName = "OnTick"; tickBody() end
local function onTickPaused() beat("tickPaused"); tickName = "OnTickEvenPaused"; tickBody() end
local function onRenderTick() beat("render"); tickName = "OnRenderTick"; tickBody() end
-- 最可靠的一个：玩家每帧更新都会调，而且直接把 player 递进来。
local function onPlayerUpdate(player) beat("playerUpdate", player); tickName = "OnPlayerUpdate"; tickBody(player) end
-- 这两个的回调也直接给 player。OnCreatePlayer 在进世界时至少响一次，
-- OnPlayerMove 在你走动/搜刮时持续响。
local function onCreatePlayer(index, player) beat("createPlayer", player); tickName = "OnCreatePlayer"; tickBody(player) end
local function onPlayerMove(player) beat("playerMove", player); tickName = "OnPlayerMove"; tickBody(player) end

--- 引擎在进世界时会打 `triggerEvent OnGameTimeLoaded`（console 里能看到），
--- 是「世界真的加载完了」的信号。这里只记一笔、立刻写一份真数据。
---
--- **绝对不要在这个回调里重挂回调。** 0.3.0 干过一次：`bindAll()` 会把
--- `onGameTimeLoaded` 自己也再挂一份，而派发过程中往同一个事件里添加处理器，
--- 会让派发器一直有新东西要调 —— 自增殖。实测 `timeloaded` 触发了一万次，
--- 控制台刷出两千多条 Kahlua 异常。数据本来就不需要重绑，删掉。
local function onGameTimeLoaded()
    beat("timeloaded")
    if not B._loadedOnce then
        B._loadedOnce = true
        diag("OnGameTimeLoaded -> first flush")
        pcall(flush)
    end
end

local function onStateEnter() beat("state") end
local function onPlayerDamage(player) beat("playerDamage", player) end

-- 每次加载都「先摘再挂」。
--
-- 0.1.2 用的是一个 `_registered` 布尔锁：第一次加载挂上回调并置 true，之后一律跳过。
-- PZ 会 reload Lua（console 里那行 `Reloading 1.0`），旧环境连同已注册的回调一起被丢掉，
-- 而重载时 `_registered` 还是 true —— 于是**一个回调都没挂上**。
-- 症状极具迷惑性：横幅打了、mod 是 loaded、进世界后却一个字节不写、一条诊断都没有。
--
-- 现在每次加载都先 Remove 旧引用再 Add。Remove 不存在时 pcall 吞掉，最多重复挂一次。
--
-- tick 挂三个事件：OnTick 是标准做法，但真机上证过它没响；OnTickEvenPaused 管暂停，
-- OnRenderTick 每帧必跑。只要有一个响，数据就能写出来，重复调用由帧计数闸门挡掉。

B.LOAD_N = (B.LOAD_N or 0) + 1

print("[CoopaniBridge] side isClient=" .. tostring(isClient and isClient())
    .. " isServer=" .. tostring(isServer and isServer())
    .. " isCoop=" .. tostring(isCoop and isCoop()))
print("[CoopaniBridge] globals getPlayer=" .. type(getPlayer)
    .. " getSpecificPlayer=" .. type(getSpecificPlayer)
    .. " getTimestamp=" .. type(getTimestamp)
    .. " getGameTime=" .. type(getGameTime))
print("[CoopaniBridge] events OnPlayerUpdate=" .. tostring(Events.OnPlayerUpdate ~= nil)
    .. " OnTick=" .. tostring(Events.OnTick ~= nil)
    .. " OnTickEvenPaused=" .. tostring(Events.OnTickEvenPaused ~= nil)
    .. " OnRenderTick=" .. tostring(Events.OnRenderTick ~= nil)
    .. " OnGameStart=" .. tostring(Events.OnGameStart ~= nil))

local bindings = {
    { ev = Events.OnGameStart, fn = onGameStart, key = "start" },
    { ev = Events.OnPlayerDeath, fn = onPlayerDeath, key = "death" },
    { ev = Events.OnZombieDead, fn = onZombieDead, key = "zombie" },
    { ev = Events.OnTick, fn = onTick, key = "tick" },
    { ev = Events.OnTickEvenPaused, fn = onTickPaused, key = "tickPaused" },
    { ev = Events.OnRenderTick, fn = onRenderTick, key = "renderTick" },
    { ev = Events.OnPlayerUpdate, fn = onPlayerUpdate, key = "playerUpdate" },
    { ev = Events.OnCreatePlayer, fn = onCreatePlayer, key = "createPlayer" },
    { ev = Events.OnPlayerMove, fn = onPlayerMove, key = "playerMove" },
    { ev = Events.OnGameTimeLoaded, fn = onGameTimeLoaded, key = "timeLoaded" },
    { ev = Events.OnGameStateEnter, fn = onStateEnter, key = "stateEnter" },
    { ev = Events.OnPlayerGetDamage, fn = onPlayerDamage, key = "playerDamage" },
}

local function bindAll()
    -- 不再先 Remove：Kahlua 里跨 chunk 的函数引用比较不可靠，
    -- 而且 Remove 一个正在派发中的事件可能把派发链打断。
    -- 重复注册的代价只是多跑几次 tick，主文件有帧闸门、心跳有计数，都不会写双份。
    B._hooks = {}
    for _, b in ipairs(bindings) do
        if b.ev then
            local ok = pcall(function() b.ev.Add(b.fn) end)
            if ok then B._hooks[b.key] = b.fn end
        end
    end
    local n = 0
    for _ in pairs(B._hooks) do n = n + 1 end
    return n
end

B.rebind = bindAll
local hooked = bindAll()

-- 把 B42 实际暴露的事件名打出来。之前一直靠猜「这个事件存不存在」，
-- 一行清单就能终结这件事。
do
    local names = {}
    for k in pairs(Events) do if type(k) == "string" then names[#names + 1] = k end end
    table.sort(names)
    local shown = {}
    for _, k in ipairs(names) do
        if k:find("Tick") or k:find("Player") or k:find("Game") or k:find("Load") then shown[#shown + 1] = k end
    end
    print("[CoopaniBridge] event total=" .. ni(#names) .. " relevant=" .. table.concat(shown, ","))
end

-- 加载即写一份探针，把两件事分开：
--   探针写不出来  -> writer / 路径的问题；
--   探针写得出来、进世界后却没有正式数据 -> 事件没挂上。
-- 变量别叫 probe：那会遮蔽上面那个 probe() 函数，后面 `probe(getTimestamp)`
-- 就变成「拿字符串当函数调用」，Kahlua 抛 `did not have __call metatable set`。
local probeBody = '{"v":' .. ni(B.VERSION) .. ',"seq":0,"ts":' .. ni(os.time())
    .. ',"alive":false,"boot":true,"load":' .. ni(B.LOAD_N) .. ',"events":[]}'
local probeOk = writeState(probeBody)
wroteOnce = false          -- 探针不算「第一份正式数据」
print("[CoopaniBridge] load #" .. ni(B.LOAD_N) .. " hooks=" .. ni(hooked) .. "/" .. ni(#bindings) .. " probe=" .. (probeOk and "OK" or "FAILED")
    .. " getTimestamp=" .. tostring(probe(getTimestamp)) .. " (" .. type(getTimestamp) .. ")")
