// 表情插件新增的两条只读能力（sticker.catalog / sticker.image）—— 2026-10-24。
//
// 这两条能力是桌宠「直接对话」能发表情的前提：核心只拿元数据与 data URL，
// 不 import 插件内部实现。测试要钉住三件事：
//   1. catalog 只返回**可见**条目（软删除的不许再被翻出来）；
//   2. catalog 的搜索词能命中备注/标签/场景；
//   3. image 把本地转存读成 data URL，且不越出 sticker-images 目录。
//
// ⚠️ 与其它插件测试一样：DATA_DIR 必须先指到临时目录，再动态 import 插件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-sticker-cap-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const imagesDir = path.join(TMP, 'sticker-images');
fs.mkdirSync(imagesDir, { recursive: true });
const pngPath = path.join(imagesDir, 'st-1.png');
fs.writeFileSync(pngPath, PNG);

const fileUrl = (p) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;

fs.writeFileSync(path.join(TMP, 'stickers.json'), JSON.stringify([
  { id: 'st-1', url: fileUrl(pngPath), desc: '震惊', tags: ['震惊', '瞪眼'], usage: '听到离谱的事', useCount: 3 },
  { id: 'st-2', url: 'https://example.com/2.png', desc: '笑了', tags: ['开心'], usage: '被逗笑' },
  { id: 'st-3', url: 'https://example.com/3.png', desc: '已删掉的那张', tags: [] }
], null, 2), 'utf8');
// 软删除名单走 data/stickers-hidden.json（不是 plugin-data：它和 stickers.json 是一对）
fs.writeFileSync(
  path.join(TMP, 'stickers-hidden.json'),
  JSON.stringify({ v: 1, hidden: ['st-3'] }, null, 2),
  'utf8'
);

const sticker = await import('../plugins/sticker/index.js');
const noop = () => {};
sticker.setup({
  config: () => ({ enabled: true }),
  log: noop,
  warn: noop,
  storage: { get: () => null, set: noop },
  registerTool: (def) => def.id,
  panel: { url: () => '' }
});

test('catalog：只列可见条目，屏蔽已删除的', () => {
  const out = sticker.providers['sticker.catalog']({});
  assert.equal(out.ok, true);
  assert.deepEqual(out.items.map((i) => i.id), ['st-1', 'st-2'], 'st-3 已被软删除，不能出现');
  assert.deepEqual(out.items[0].tags, ['震惊', '瞪眼']);
  assert.equal(out.items[0].usage, '听到离谱的事');
});

test('catalog：搜索词命中备注 / 标签 / 场景', () => {
  const byTag = sticker.providers['sticker.catalog']({ query: '瞪眼' });
  assert.deepEqual(byTag.items.map((i) => i.id), ['st-1']);
  const byUsage = sticker.providers['sticker.catalog']({ query: '逗笑' });
  assert.deepEqual(byUsage.items.map((i) => i.id), ['st-2']);
  const none = sticker.providers['sticker.catalog']({ query: '不存在的词' });
  assert.equal(none.items.length, 0);
  assert.equal(none.ok, true, '搜不到不是错误');
});

test('catalog：limit 被夹在 1~60', () => {
  assert.equal(sticker.providers['sticker.catalog']({ limit: 1 }).items.length, 1);
  assert.equal(sticker.providers['sticker.catalog']({ limit: 999 }).items.length, 2);
});

test('image：本地转存 → data URL', async () => {
  const out = await sticker.providers['sticker.image']({ id: 'st-1' });
  assert.equal(out.ok, true, out.error);
  assert.match(out.dataUrl, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(out.dataUrl.split(',')[1], 'base64').equals(PNG), true, '字节要原样读出');
});

test('image：不存在的 id / 已删除的 id 都拒绝', async () => {
  assert.equal((await sticker.providers['sticker.image']({ id: 'nope' })).ok, false);
  assert.equal((await sticker.providers['sticker.image']({ id: 'st-3' })).ok, false);
  assert.equal((await sticker.providers['sticker.image']({})).ok, false);
});

test('plugin.json 声明的能力 == 实现的能力（防漂移）', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'sticker', 'plugin.json'), 'utf8')
  );
  const implemented = Object.keys(sticker.providers).sort();
  for (const cap of manifest.capabilities) {
    assert.ok(implemented.includes(cap), `manifest 声明了 ${cap}，但代码里没有实现`);
  }
  assert.deepEqual(implemented, manifest.capabilities.slice().sort(), '两侧清单必须一致');
});
