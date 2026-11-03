// 控制台插话的附件链路单测 —— 2026-10-24。
//
// 两条路必须分开钉住，因为它们的安全/可用性判据完全不同：
//   · 图片 → 必须进 image-cache 的受控目录。看图工具对 media.file 走白名单
//     （media-path.js 的 resolveCachedMediaPath），只认我们自己写下的缓存文件；
//     直接塞用户路径会被判"不在本地缓存目录内"，模型永远看不到图。
//   · 文本 → 内联进消息正文，且超长要截断（不能把 10MB 日志整个塞进提示词）。
//   · 其它类型 → 明确说"没发送"，不静默丢弃。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-attach-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { buildOwnerAttachments } = await import('../src/orchestrator.js');
const { cacheLocalImage, lookupCachedImage } = await import('../src/image-cache.js');

// 一张真的 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const pngPath = path.join(TMP, 'pic.png');
fs.writeFileSync(pngPath, PNG);
const txtPath = path.join(TMP, 'notes.txt');
fs.writeFileSync(txtPath, '第一行\n第二行\n');
const bigPath = path.join(TMP, 'big.log');
fs.writeFileSync(bigPath, 'x'.repeat(200 * 1024));
const exePath = path.join(TMP, 'tool.exe');
fs.writeFileSync(exePath, 'MZ fake');

test('图片：收进 image-cache，media.file 指向缓存副本', () => {
  const out = buildOwnerAttachments([{ path: pngPath, name: 'pic.png' }], { chatKey: 'private:1', mid: 'm1' });
  assert.equal(out.images, 1);
  assert.equal(out.media.length, 1);
  assert.equal(out.media[0].kind, 'image');
  assert.equal(out.media[0].name, 'pic.png');
  // file 必须在 image-cache 目录内，否则过不了 media-path 的白名单
  assert.match(out.media[0].file, /image-cache[\\/]/);
  assert.equal(out.notes.length, 0, '成功的图不该再往正文里塞失败说明');
  // 缓存索引按 (chatKey, mid, 下标) 记账，看图工具立刻能读到
  const hit = lookupCachedImage('private:1', 'm1', 0);
  assert.ok(hit, '刚收下的图应当立刻能查到');
  assert.equal(hit.buffer.equals(PNG), true);
});

test('图片：读不到 / 不是图 → 正文里说明，不静默', () => {
  const missing = buildOwnerAttachments([{ path: path.join(TMP, 'nope.png'), name: 'nope.png' }], { chatKey: 'private:1', mid: 'm2' });
  assert.equal(missing.images, 0);
  assert.equal(missing.media.length, 0);
  assert.match(missing.notes[0], /【附件失败】nope\.png/);

  const notImage = buildOwnerAttachments([{ path: txtPath, name: 'notes.txt' }], { chatKey: 'private:1', mid: 'm3' });
  assert.equal(notImage.media.length, 0, '文本不该被当成图片塞进 media');
  assert.match(notImage.notes[0], /【附件：notes\.txt】/);
});

test('文本：内联进正文（带文件名），不占工具调用', () => {
  const out = buildOwnerAttachments([{ path: txtPath, name: 'notes.txt' }], { chatKey: 'private:1', mid: 'm4' });
  assert.equal(out.media.length, 0);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /^【附件：notes\.txt】\n第一行\n第二行\n$/);
});

test('文本：超长截断，并说明截了多少', () => {
  const out = buildOwnerAttachments([{ path: bigPath, name: 'big.log' }], { chatKey: 'private:1', mid: 'm5' });
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /big\.log（全文 200KB，只取前 64KB）/);
  assert.ok(out.notes[0].length < 70 * 1024, '正文里不能留下超过上限的字符');
});

test('其它类型：明确告知没发送', () => {
  const out = buildOwnerAttachments([{ path: exePath, name: 'tool.exe' }], { chatKey: 'private:1', mid: 'm6' });
  assert.equal(out.media.length, 0);
  assert.match(out.notes[0], /【附件未发送】tool\.exe：只支持图片和文本文件/);
});

test('多个附件：图片按 media 下标记账，文本按顺序进正文', () => {
  const out = buildOwnerAttachments(
    [{ path: txtPath, name: 'a.txt' }, { path: pngPath, name: 'b.png' }, { path: txtPath, name: 'c.txt' }],
    { chatKey: 'private:9', mid: 'm7' }
  );
  assert.equal(out.images, 1);
  assert.equal(out.media.length, 1);
  assert.equal(out.notes.length, 2);
  assert.match(out.notes[0], /a\.txt/);
  assert.match(out.notes[1], /c\.txt/);
  // 图片用的是第 0 个下标（它是这条消息 media 里的第一张）
  assert.ok(lookupCachedImage('private:9', 'm7', 0), '下标必须和入库侧一致，否则看图工具查不到');
});

test('cacheLocalImage：非图片 / 空文件 / 超限都被拒', () => {
  assert.equal(cacheLocalImage('private:1', 'x', 0, txtPath).ok, false, '文本不能当图片收');
  const empty = path.join(TMP, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.equal(cacheLocalImage('private:1', 'x', 0, empty).ok, false);
  const huge = path.join(TMP, 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(13 * 1024 * 1024, 1));
  assert.match(cacheLocalImage('private:1', 'x', 0, huge).error, /超过/);
  assert.equal(cacheLocalImage('private:1', 'x', 0, path.join(TMP, 'ghost.png')).ok, false);
});
