import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureModEnabled } from '../src/bridge.ts';
import { pathsOf } from '../src/paths.ts';
import { liftPet } from '../src/petlift.ts';

function fixture(defaultTxt = 'VERSION = 1,\r\n\r\nmods\r\n{\r\n}\r\n\r\nmaps\r\n{\r\n}\r\n') {
  const root = mkdtempSync(join(tmpdir(), 'pzmodlist-'));
  mkdirSync(join(root, 'mods'));
  if (defaultTxt !== null) writeFileSync(join(root, 'mods', 'default.txt'), defaultTxt, 'utf8');
  return {
    root,
    paths: pathsOf(root),
    text: () => readFileSync(join(root, 'mods', 'default.txt'), 'utf8'),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('空模组列表里替他勾上桥接 mod', () => {
  const f = fixture();
  try {
    const r = ensureModEnabled(f.paths, true);
    assert.equal(r.state, 'enabled');
    assert.match(f.text(), /^\s*mod = CoopaniBridge,\s*$/m);
  } finally { f.clean(); }
});

test('格式是 mod = ID，不是 ID=ID（写错会静默失效）', () => {
  const f = fixture();
  try {
    ensureModEnabled(f.paths, true);
    assert.ok(!f.text().includes('CoopaniBridge=CoopaniBridge'));
  } finally { f.clean(); }
});

test('已经勾上了就不重复写', () => {
  const f = fixture('VERSION = 1,\r\n\r\nmods\r\n{\r\n    mod = CoopaniBridge,\r\n}\r\n');
  try {
    assert.equal(ensureModEnabled(f.paths, true).state, 'current');
    assert.equal(f.text().match(/CoopaniBridge/g).length, 1);
  } finally { f.clean(); }
});

test('别人启用的 mod 原样保留，且只加在 mods 块里', () => {
  const f = fixture('VERSION = 1,\r\n\r\nmods\r\n{\r\n    mod = SomeOtherMod,\r\n}\r\n\r\nmaps\r\n{\r\n}\r\n');
  try {
    ensureModEnabled(f.paths, true);
    const t = f.text();
    assert.match(t, /mod = SomeOtherMod,/);
    assert.match(t, /mod = CoopaniBridge,/);
    const i = t.indexOf('maps');
    assert.ok(t.indexOf('CoopaniBridge') < i, '不能写进 maps 块');
  } finally { f.clean(); }
});

test('保持原文件的换行风格，不混 CRLF 和 LF', () => {
  const f = fixture();
  try {
    ensureModEnabled(f.paths, true);
    const raw = readFileSync(join(f.root, 'mods', 'default.txt'));
    const lf = raw.toString('latin1');
    assert.ok(!/(^|[^\r])\n/.test(lf), '不该出现裸 LF');
  } finally { f.clean(); }
});

test('关掉自动安装时不碰模组列表', () => {
  const f = fixture();
  try {
    assert.equal(ensureModEnabled(f.paths, false).state, 'skipped');
    assert.ok(!f.text().includes('CoopaniBridge'));
  } finally { f.clean(); }
});

test('default.txt 不存在时自己建一份', () => {
  const f = fixture(null);
  try {
    assert.equal(ensureModEnabled(f.paths, true).state, 'enabled');
    assert.match(f.text(), /VERSION = 1,/);
    assert.match(f.text(), /mod = CoopaniBridge,/);
  } finally { f.clean(); }
});

test('格式认不出来时不动文件，而不是把它写坏', () => {
  const f = fixture('这不是模组列表，是一段话。');
  try {
    assert.equal(ensureModEnabled(f.paths, true).state, 'failed');
    assert.equal(f.text(), '这不是模组列表，是一段话。');
  } finally { f.clean(); }
});

test('没有宿主根目录时，置顶安静地降级', () => {
  assert.equal(liftPet(null), 'unavailable');
});


/* ------------------------------------------------ 存档的 mods.txt（读档真正用的那份） */

function saveTree() {
  const root = mkdtempSync(join(tmpdir(), 'pzsaves-'));
  const save = join(root, 'Saves', 'Rising', '2026-11-07_15-03-03');
  mkdirSync(save, { recursive: true });
  writeFileSync(join(save, 'mods.txt'), 'VERSION = 1,\r\n\r\nmods\r\n{\r\n}\r\n\r\nmaps\r\n{\r\n}\r\n', 'utf8');
  return { root, save };
}

test('存档的 mods.txt 是读档时的真清单，缺了我们的名字要补进去', async () => {
  const { ensureSaveModsEnabled } = await import('../src/bridge.ts');
  const { root, save } = saveTree();
  try {
    const r = ensureSaveModsEnabled(pathsOf(root), true);
    assert.equal(r.patched, 1);
    const text = readFileSync(join(save, 'mods.txt'), 'utf8');
    assert.match(text, /mod\s*=\s*CoopaniBridge,/);
    assert.match(text, /\r\n/, '要沿用原来的 CRLF，别混行尾');
    assert.match(text, /VERSION = 1,/);
    assert.match(text, /maps/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已经有我们时不动它，也别重复插', async () => {
  const { ensureSaveModsEnabled } = await import('../src/bridge.ts');
  const { root, save } = saveTree();
  try {
    ensureSaveModsEnabled(pathsOf(root), true);
    const once = readFileSync(join(save, 'mods.txt'), 'utf8');
    const r = ensureSaveModsEnabled(pathsOf(root), true);
    assert.equal(r.patched, 0);
    assert.equal(readFileSync(join(save, 'mods.txt'), 'utf8'), once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有存档目录时不报错', async () => {
  const { ensureSaveModsEnabled } = await import('../src/bridge.ts');
  const root = mkdtempSync(join(tmpdir(), 'pznosave-'));
  try {
    const r = ensureSaveModsEnabled(pathsOf(root), true);
    assert.equal(r.patched, 0);
    assert.match(r.detail, /还没有存档/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
