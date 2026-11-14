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

    local hits = {}
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
            if tier > 0 then
                -- 显示名走本地化，取不到就退回内部名。只在命中时才调，省开销。
                local dn = safe(function() return it:getDisplayName() end, nil)
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
        sig = h.sig, type = h.ctype, total = size, hits = hits,
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

-- 上一行读到的内容。去重靠**行本身**，不靠 seq。
--
-- 只看 seq 会栽一次：桌面伴侣重启后 seq 从 1 重新开始，而游戏里记着的是上一轮的
-- 第 40 条 —— 于是新指令一条都「不大于已见」，全部被静默丢掉，表现是「她不动了」，
-- 而两边日志都干干净净。行内容变了就是一条新指令，这个判据不受重启影响。
local cmdLineSeen = ''
local cmdSeqSeen = 0
B.CMD = nil            -- 最近一条指令的回执，buildJson 带出去
local attackArity = nil -- AttemptAttack 的实参个数，试一次记住（见下）

local function readCmdLine()
    local r = getFileReader(B.CMD_FILE, false)
    if not r then return nil end
    local line = nil
    local ok = pcall(function() line = r:readLine() end)
    pcall(function() r:close() end)
    if not ok or type(line) ~= 'string' or line == '' then return nil end
    return line
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
local function pollCommand(p)
    local line = readCmdLine()
    if not line then return end
    local f = splitPipe(line)
    if #f < 2 then return end

    -- 同一行读到第二次就不再执行。判据是「这行内容有没有变」，
    -- 不是「seq 有没有变大」—— 理由见 cmdLineSeen 上面那段。
    if line == cmdLineSeen then return end
    cmdLineSeen = line

    local seqN = tonumber(f[1])
    local verb = f[2]
    if not seqN then return end
    cmdSeqSeen = seqN

    local function ack(ok, why)
        -- 成功时 `why` 是 nil（queueWalk 只返回一个 true），
        -- 而 `q()` 会 tostring 成 **字符串 "nil"** 写进 JSON —— 外面读到的是一句假原因。
        B.CMD = { seq = seqN, verb = verb, ok = ok, why = why or '' }
    end

    local expire = tonumber(f[7])
    if expire and expire < os.time() then
        ack(false, 'expired:' .. tostring(math.floor(os.time() - expire)))
        return
    end

    if not p then
        ack(false, 'no-player')
        return
    end
    if p:isDead() then
        ack(false, 'dead')
        return
    end

    local ok, why = false, ""
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

    ack(ok, why)
    diag("cmd " .. tostring(verb) .. " seq=" .. tostring(seqN) .. " ok=" .. tostring(ok)
        .. (why ~= "" and (" why=" .. tostring(why)) or ""))
end

--- 动作队列空不空 —— 她要知道「上一件事做完了没有」。
local function isBusy(p)
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
        add("loot", '{"sig":' .. q(loot.sig) .. ',"type":' .. q(loot.type)
            .. ',"total":' .. ni(loot.total) .. ',"hits":[' .. table.concat(hs, ",") .. "]"
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

local function onGameStart()
    beat("gameStart")
    diag("OnGameStart fired")
    session = newSessionId()
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
    if frameCount % 30 == 0 then pcall(pollCommand, p or getPlayerSafe()) end

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
