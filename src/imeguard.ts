/**
 * 让《僵尸毁灭工程》的窗口不接收中文输入法。
 *
 * 为什么要做：PZ 是窗口化跑的，Windows 会照着「当前窗口」的输入法设置把
 * 中文输入法挂上去。表现是——
 *   - 按 W/A/S/D 会弹出候选框，人站住不动；
 *   - 输入法状态条浮在游戏画面上（正好压在桌宠旁边）；
 *   - 每次切出去回消息，切回来又变回中文，得再按一次 Shift。
 *
 * 两句一起做：
 *
 *  1. `ImmAssociateContext(hwnd, NULL)` —— 摘掉 IMM 层上下文。对老式 IME 有用。
 *  2. `WM_INPUTLANGCHANGEREQUEST` + 英文键盘布局 —— **这一句才是真正管用的**。
 *     微软拼音是 TSF 输入法，压根不走 IMM，所以光摘上下文它照样弹候选框
 *     （真机验证过：上下文确实摘掉了，输入法还在）。
 *     把游戏窗口所在线程的键盘布局切成 en-US 之后，那个窗口就不再接收中文组字。
 *
 * **只影响这一个窗口**，别的程序（包括聊天窗口）照常是中文。
 *
 * 游戏进世界时会重建窗口，所以运行期间要周期性重挂；退出时把原来的上下文
 * 还回去，不留痕迹。
 *
 * 边界：找不到窗口、加载不了 koffi、系统调用失败，一律安静降级。
 * 这一层是给人省事的，绝不能因为它把数据通道拖下水。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export type ImeState = 'guarded' | 'restored' | 'not-found' | 'unavailable';

interface Win32 {
  /** 摘掉窗口的输入法上下文，返回它原来的上下文（0 = 本来就没有）。 */
  detach(hwnd: number): number;
  /** 把上下文还回去。 */
  attach(hwnd: number, ctx: number): number;
  /** 按标题找窗口。 */
  find(title: string): number;
  /** 该窗口所在线程当前的键盘布局。 */
  layoutOf(hwnd: number): number;
  /** 把窗口切到指定键盘布局（异步，不阻塞）。 */
  switchTo(hwnd: number, hkl: number): boolean;
  /** 加载英文键盘布局，返回它的句柄。 */
  loadEnUs(): number;
}

/** 游戏主窗口标题。B42 是 "Project Zomboid"。 */
const TITLES = ['Project Zomboid', 'Zomboid'];

let cached: { root: string; api: Win32 | null } | null = null;

/** hwnd → 它原来的输入法上下文。退出时按这个还原。 */
const saved = new Map<number, number>();
/** hwnd → 它原来的键盘布局。 */
const savedLayout = new Map<number, number>();

/** WM_INPUTLANGCHANGEREQUEST */
const WM_INPUTLANGCHANGE = 0x0050;
/** KLF_ACTIVATE */
const KLF_ACTIVATE = 0x0001;

function apiFor(hostRoot: string | null): Win32 | null {
  if (!hostRoot) return null;
  if (cached?.root === hostRoot) return cached.api;

  let api: Win32 | null = null;
  try {
    const koffi = require(join(hostRoot, 'resources', 'app', 'node_modules', 'koffi')) as {
      load(name: string): { func(sig: string): (...args: unknown[]) => unknown };
    };
    const user32 = koffi.load('user32.dll');
    const imm32 = koffi.load('imm32.dll');

    const findWindow = user32.func('intptr_t __stdcall FindWindowW(str16, str16)') as (
      cls: null, title: string,
    ) => number;
    const associate = imm32.func(
      'intptr_t __stdcall ImmAssociateContext(intptr_t, intptr_t)',
    ) as (hwnd: number, ctx: number) => number;

    const getThread = user32.func(
      'uint32 __stdcall GetWindowThreadProcessId(intptr_t, intptr_t)',
    ) as (hwnd: number, pidOut: number) => number;
    const getLayout = user32.func('intptr_t __stdcall GetKeyboardLayout(uint32)') as (
      tid: number,
    ) => number;
    const loadLayout = user32.func('intptr_t __stdcall LoadKeyboardLayoutW(str16, uint32)') as (
      id: string, flags: number,
    ) => number;
    const post = user32.func(
      'bool __stdcall PostMessageW(intptr_t, uint32, intptr_t, intptr_t)',
    ) as (hwnd: number, msg: number, w: number, l: number) => boolean;

    api = {
      find: (title) => findWindow(null, title),
      detach: (hwnd) => associate(hwnd, 0),
      attach: (hwnd, ctx) => associate(hwnd, ctx),
      layoutOf: (hwnd) => {
        const tid = getThread(hwnd, 0);
        return tid ? getLayout(tid) : 0;
      },
      loadEnUs: () => loadLayout('00000409', KLF_ACTIVATE) || 0,
      switchTo: (hwnd, hkl) => post(hwnd, WM_INPUTLANGCHANGE, 0, hkl),
    };
  } catch {
    api = null;
  }

  cached = { root: hostRoot, api };
  return api;
}

/**
 * 摘掉游戏窗口的输入法。游戏运行期间周期性调用（进世界会重建窗口）。
 *
 * 幂等：同一个窗口只记一次原始上下文，重复调用不会把「已摘掉」记成原值。
 */
export function guardIme(hostRoot: string | null): ImeState {
  const api = apiFor(hostRoot);
  if (!api) return 'unavailable';

  for (const title of TITLES) {
    let hwnd = 0;
    try {
      hwnd = api.find(title);
    } catch {
      continue;
    }
    if (!hwnd) continue;

    // 已经摘过的窗口不要再摘 —— 第二次的返回值是 0，会把原上下文覆盖成 0，
    // 退出时就还原不回去了。
    if (saved.has(hwnd)) return 'guarded';
    try {
      const prev = api.detach(hwnd);
      saved.set(hwnd, prev);

      // 真正管用的是这一句：把线程的键盘布局换成 en-US。
      // 记下原来的布局，退出时换回去。
      const before = api.layoutOf(hwnd);
      const en = api.loadEnUs();
      if (en && before && before !== en) {
        savedLayout.set(hwnd, before);
        api.switchTo(hwnd, en);
      }
      return 'guarded';
    } catch {
      return 'unavailable';
    }
  }
  return 'not-found';
}

/** 游戏退出时把输入法上下文还回去。窗口已经没了就跳过。 */
export function restoreIme(hostRoot: string | null): ImeState {
  if (saved.size === 0) return 'restored';
  const api = apiFor(hostRoot);
  if (!api) return 'unavailable';

  for (const [hwnd, ctx] of saved) {
    try {
      if (ctx) api.attach(hwnd, ctx);
    } catch {
      // 窗口销毁了就算了，系统会自己收拾。
    }
    const back = savedLayout.get(hwnd);
    if (back) {
      try {
        api.switchTo(hwnd, back);
      } catch {
        // 同上。
      }
    }
  }
  saved.clear();
  savedLayout.clear();
  return 'restored';
}

/** 当前是否已经摘掉（给面板看）。 */
export function imeGuardedCount(): number {
  return saved.size;
}
