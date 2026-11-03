// 收包人 bug 清单（2026-10-27）核心修复的回归测试：
//   A3  volatile 片段通道（prompt.js isVolatileSection 认 volatile: true）
//   E1  stickers.json 外部改动不再被内存快照盖回（mergeDiskStickerStore）
//
// 测试口径：
//   · E1 用临时 DATA_DIR + 动态 import（与其它 sticker 测试同款），
//     钉住三件事：磁盘新增要并回来 / 磁盘较新的编辑字段要采纳（运行时统计保留）/
//     内存较新时磁盘旧值不许回写覆盖。
//   · A3 钉住 isVolatileSection 的显式声明优先 —— 插件 promptSections 返回
//     volatile: true 时必须走用户提示词尾部通道，不再进系统提示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── E1：临时数据目录 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-sticker-e1-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { mergeDiskStickerStore } = await import('../plugins/sticker/lib/stickers.js');
const { isVolatileSection } = await import('../src/prompt.js');

const STICKER_FILE = path.join(TMP, 'stickers.json');
const writeDisk = (arr) => fs.writeFileSync(STICKER_FILE, JSON.stringify(arr, null, 2), 'utf8');
const baseEntry = (over = {}) => ({
  id: 'st1', resId: 'st1', url: 'https://example/x', md5: 'AAAABBBB',
  desc: '', localNote: '', tags: [], usage: '', source: 'qq',
  useCount: 0, lastUsedAt: 0, lastContext: '',
  createdAt: '2026-10-27T08:00:00.000Z', updatedAt: '2026-10-27T08:00:00.000Z',
  ...over
});

test('E1：磁盘上有、内存没有的条目 → 原样并回（外部新增不丢）', () => {
  writeDisk([
    baseEntry({ id: 'st1' }),
    baseEntry({ id: 'st-ext', desc: '外部脚本刚加的', updatedAt: '2026-10-27T09:00:00.000Z' })
  ]);
  const mem = [baseEntry({ id: 'st1', useCount: 3 })];
  const r = mergeDiskStickerStore(mem);
  assert.equal(r.added, 1);
  assert.ok(r.entries.find((e) => e.id === 'st-ext'), '外部新增条目必须并回');
  assert.equal(r.entries.find((e) => e.id === 'st1').useCount, 3, '原有条目的运行时统计不受影响');
});

test('E1：磁盘版本较新 → 采纳可编辑字段，运行时统计仍以内存为准', () => {
  writeDisk([
    baseEntry({ id: 'st1', desc: '外部改过的备注', tags: ['新标签'],
      updatedAt: '2026-10-27T10:00:00.000Z' })
  ]);
  const mem = [baseEntry({ id: 'st1', desc: '旧备注', useCount: 7, lastUsedAt: 12345 })];
  const r = mergeDiskStickerStore(mem);
  assert.equal(r.updated, 1);
  const e = r.entries[0];
  assert.equal(e.desc, '外部改过的备注', '磁盘较新的备注要采纳');
  assert.deepEqual(e.tags, ['新标签']);
  assert.equal(e.useCount, 7, '使用次数是运行时字段，不许被磁盘旧值抹掉');
  assert.equal(e.lastUsedAt, 12345);
});

test('E1：内存版本较新 → 磁盘旧值不许回写覆盖（本地刚编辑过的赢）', () => {
  writeDisk([
    baseEntry({ id: 'st1', desc: '磁盘上的旧备注', updatedAt: '2026-10-27T08:00:00.000Z' })
  ]);
  const mem = [baseEntry({ id: 'st1', desc: '内存里刚改的新备注', updatedAt: '2026-10-27T11:00:00.000Z' })];
  const r = mergeDiskStickerStore(mem);
  assert.equal(r.updated, 0);
  assert.equal(r.entries[0].desc, '内存里刚改的新备注');
});

test('E1：磁盘为空/损坏 → 原样返回，不抛错', () => {
  fs.writeFileSync(STICKER_FILE, 'not json', 'utf8');
  const mem = [baseEntry({ id: 'st1' })];
  const r = mergeDiskStickerStore(mem);
  assert.equal(r.added, 0);
  assert.equal(r.entries.length, 1);
});

test('A3：isVolatileSection 认显式 volatile: true（插件声明优先于 id 白名单）', () => {
  assert.equal(isVolatileSection({ id: 'forge-pending', volatile: true }), true);
  // 没声明时白名单/前缀兜底照旧
  assert.equal(isVolatileSection({ id: 'thinking-note' }), true);
  assert.equal(isVolatileSection({ id: 'video-frames-note' }), false);
  assert.equal(isVolatileSection(null), false);
});
