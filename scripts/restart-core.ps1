#Requires -Version 5.1
<#
.SYNOPSIS
    重启 Coopani 的 Core 进程，让扩展的代码改动生效。

.DESCRIPTION
    改 World 扩展的 .ts 之后必须重启 Core 进程；/api/worlds/restart 走 ESM 模块缓存，拿不到新代码。

    流程：
      1. 往 <dataDir>\.restart-request 写标记 —— core-host.cjs 见到它就把这次退出当"计划内重启"，
         立刻重新拉起；没有标记的话会被记成崩溃，进崩溃统计（5 分钟内超 5 次就不再重启）。
      2. 结束 core\boot.ts 那个进程，并**确认旧 PID 真的消失**。
      3. 等**新 PID** 出现且 /api/status 通。

    为什么第 2、3 步要比原来严：
      2026-10-29 踩过一次 —— 老版本用 `-ErrorAction SilentlyContinue` 杀进程（失败被吞掉），
      又用「/api/status 返回 200」判断重启成功（旧进程还在也返回 200）。结果是**每次报"就绪"，
      其实一次都没重启**，改了 body.js 却以为生效了，排查了一小时。
      现在：杀不掉就抛错；等新 PID，不等接口。

.PARAMETER Root
    Coopani 安装目录。默认 %USERPROFILE%\Coopanion

.PARAMETER DataDir
    运行数据目录（config.json 与扩展 dataDir 的上级）。默认 <Root>\data\home\companion\data

.PARAMETER TimeoutSeconds
    等 Core 回来的上限。默认 60

.EXAMPLE
    powershell -File restart-core.ps1

.EXAMPLE
    powershell -File restart-core.ps1 -Root 'D:\Apps\Coopanion' -TimeoutSeconds 90
#>
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:USERPROFILE 'Coopanion'),
    [string]$DataDir,
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

if (-not $DataDir) { $DataDir = Join-Path $Root 'data\home\companion\data' }
if (-not (Test-Path $Root)) { throw "找不到 Coopani 安装目录: $Root（用 -Root 指定）" }
if (-not (Test-Path $DataDir)) { throw "找不到数据目录: $DataDir（用 -DataDir 指定）" }

$logFile = Join-Path $Root 'data\logs\core.log'
$statusUrl = 'http://127.0.0.1:17788/api/status'

function Get-CoreProcesses {
    Get-CimInstance Win32_Process -Filter "Name='Coopanion.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*core\boot.ts*' }
}

# --- 1. 标记"这次是我要重启" -------------------------------------------------
$flag = Join-Path $DataDir '.restart-request'
Set-Content -Path $flag -Value (Get-Date -Format o) -Encoding utf8
Write-Host "已写重启标记: $flag" -ForegroundColor DarkGray

# --- 2. 结束 core 进程（并确认真的死透了）---------------------------------------
$cores = @(Get-CoreProcesses)

if ($cores.Count -eq 0) {
    Write-Host "没找到正在运行的 Core。直接启动就行。" -ForegroundColor Yellow
    # 标记留着：下次启动时 consumeBootFlags 会把它删掉，不会误触发
    exit 0
}

$oldPids = @($cores | ForEach-Object { [int]$_.ProcessId })
Write-Host "旧 Core PID: $($oldPids -join ', ')" -ForegroundColor DarkGray

foreach ($c in $cores) {
    Write-Host "结束 Core 进程 PID $($c.ProcessId) ..." -ForegroundColor DarkGray
    try {
        Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop
    } catch {
        throw "结束 PID $($c.ProcessId) 失败：$($_.Exception.Message)（权限不足？Coopani 是管理员启动的？）"
    }
}

# 杀完必须复验。Windows 上 Stop-Process 偶尔返回成功但进程还在。
$deadlineKill = (Get-Date).AddSeconds(8)
$alive = @()
while ((Get-Date) -lt $deadlineKill) {
    $alive = @($oldPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 400
}
if ($alive.Count -gt 0) {
    throw "旧 Core 进程仍在运行：$($alive -join ', ')。重启没发生，别当它已经生效。"
}
Write-Host "旧 Core 已确认退出。" -ForegroundColor DarkGray

# --- 3. 等**新的** PID 起来 ----------------------------------------------------
# Invoke-WebRequest 默认画进度条，会把中文输出搅成一团
$ProgressPreference = 'SilentlyContinue'

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$newPid = $null
$lastErr = $null

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1200
    $now = @(Get-CoreProcesses)
    $fresh = @($now | Where-Object { [int]$_.ProcessId -notin $oldPids })
    if ($fresh.Count -eq 0) { continue }
    # 新进程在了，再等接口能应答（模型/World 加载完才算真就绪）
    try {
        $resp = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $newPid = [int]$fresh[0].ProcessId; break }
    } catch {
        $lastErr = $_.Exception.Message
    }
}

if ($newPid) {
    Write-Host "Core 已重启就绪。新 PID $newPid（旧 $($oldPids -join ',')）。$statusUrl" -ForegroundColor Green
} else {
    Write-Warning "等了 $TimeoutSeconds 秒没等到新的 Core 进程。最后一次错误: $lastErr"
    Write-Host "去日志看看: $logFile" -ForegroundColor Yellow
    Write-Host "注意：这次的改动**没有**生效，别当它已经生效。" -ForegroundColor Yellow
}

# --- 4. 顺便把尾日志打出来 ----------------------------------------------------
# core.log 是 UTF-8 无 BOM：不显式指定编码，PowerShell 5.1 会按系统 ANSI 解，中文全成乱码
if (Test-Path $logFile) {
    Write-Host "`n--- core.log 尾部 ---" -ForegroundColor DarkGray
    Get-Content -Path $logFile -Tail 15 -Encoding UTF8 | ForEach-Object {
        # 日志行可能很长，截断到 160 字符便于扫读
        if ($_.Length -gt 160) { $_.Substring(0, 160) } else { $_ }
    }
}
