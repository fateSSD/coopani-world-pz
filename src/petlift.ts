/**
 * 游戏在跑的时候，把桌宠窗口重新提到最顶。
 *
 * 为什么要做这一层：宿主给桌宠设的是 `alwaysOnTop('screen-saver')`，
 * 平时够用；但 PZ 从主菜单进世界时会重建 GLFW 窗口，Windows 的全屏优化
 * 会把那个无边框满屏窗口临时抬起来，桌宠就被压到画面底下去了。
 * 表现是「游戏一打开，肥鱼就不见了」，而宿主自己不会去抢回来。
 *
 * **边界（实测）**：这一招只对「别的普通窗口抢了 Z 序」有效。
 * 游戏走独占全屏 / 无边框满屏时 Windows 绕开 DWM 合成，置顶窗口物理上画不上去，
 * 这时 SetWindowPos 再多次也没用 —— 那种情况必须让游戏改成带标题栏的窗口模式。
 *
 * 只做一件事：`FindWindowW` 找桌宠窗口 → `SetWindowPos(HWND_TOPMOST)`。
 * 不带 SWP_ACTIVATE，不抢焦点、不打断操作，也不改窗口位置大小。
 * 找不到窗口或者 koffi 加载不了就安静地什么都不做 —— 这一层是锦上添花，
 * 绝不能因为它把陪玩的数据通道拖下水。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export type LiftState = 'ok' | 'not-found' | 'unavailable';

interface Win32 {
  find(title: string): number;
  lift(hwnd: number): boolean;
}

/** 标题会跟着宿主语言走，多认几个。找到第一个就够。 */
const TITLES = ['Cortico 桌宠', 'Cortico Pet', 'Cortico', '桌宠'];

/** SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW */
const FLAGS = 0x1 | 0x2 | 0x10 | 0x40;
/** HWND_TOPMOST */
const HWND_TOPMOST = -1;

let cached: { root: string; api: Win32 | null } | null = null;

function apiFor(hostRoot: string | null): Win32 | null {
  if (!hostRoot) return null;
  if (cached?.root === hostRoot) return cached.api;

  let api: Win32 | null = null;
  try {
    // koffi 是 N-API 模块，宿主自己也在用它读窗口，跨 Electron/Node 版本都能加载。
    const koffi = require(join(hostRoot, 'resources', 'app', 'node_modules', 'koffi')) as {
      load(name: string): {
        func(sig: string): (...args: unknown[]) => unknown;
      };
    };
    const user32 = koffi.load('user32.dll');
    const findWindow = user32.func('intptr_t __stdcall FindWindowW(str16, str16)') as (
      cls: null, title: string,
    ) => number;
    const setWindowPos = user32.func(
      'bool __stdcall SetWindowPos(intptr_t, intptr_t, int, int, int, int, uint32)',
    ) as (h: number, after: number, x: number, y: number, cx: number, cy: number, flags: number) => boolean;

    api = {
      find: (title) => {
        try { return Number(findWindow(null, title)) || 0; } catch { return 0; }
      },
      lift: (h) => {
        try { return Boolean(setWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, FLAGS)); } catch { return false; }
      },
    };
  } catch {
    api = null;
  }

  cached = { root: hostRoot, api };
  return api;
}

export function liftPet(hostRoot: string | null): LiftState {
  const api = apiFor(hostRoot);
  if (!api) return 'unavailable';
  for (const title of TITLES) {
    const hwnd = api.find(title);
    if (!hwnd) continue;
    return api.lift(hwnd) ? 'ok' : 'unavailable';
  }
  return 'not-found';
}
