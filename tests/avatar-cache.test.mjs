// QQ 头像本地缓存的回归测试（2026-11-05，R207）
//
// ⚠️ 必须零出网：config.js 的 DATA_DIR 在模块加载时就定死，所以先设
//    QQ_AGENT_DATA_DIR 到临时目录，再**动态 import** 业务模块。所有命中路径
//    都预先写好缓存文件；未命中会触发 safeFetchBinary 真去拉 CDN，测试里
//    绝不允许走到那一步（坏档清理用 __readAvatarCacheForTest 直接验）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-avatar-test-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const {
  getAvatar, sniffImageType, avatarCacheStats, AVATAR_SIZES,
  __readAvatarCacheForTest
} = await import('../src/avatar-cache.js');

const dir = path.join(tmp, 'avatar-cache');
fs.mkdirSync(dir, { recursive: true });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const GIF = Buffer.from('GIF89a-fake-but-magic-ok');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const BMP = Buffer.from([0x42, 0x4D, 0, 0, 0, 0]);
const HTML = Buffer.from('<!DOCTYPE html><html>CDN 502</html>');

const put = (qq, size, buf) => fs.writeFileSync(path.join(dir, `${qq}_${size}.jpg`), buf);
const QQ = '12345678';

test('魔数识别：常见图片格式与真实 MIME', () => {
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(BMP), 'image/bmp');
});

test('魔数识别：错误页 / 空 / 过短 / 非 Buffer 一律拒绝', () => {
  assert.equal(sniffImageType(HTML), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(Buffer.from([0xFF, 0xD8])), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType('FFD8FF'), null);
});

test('合法缓存命中：返回真实 MIME（不再硬编码 jpeg）', async () => {
  put(QQ, 100, JPEG);
  put('22345678', 140, PNG);
  assert.deepEqual((await getAvatar(QQ, 100)).contentType, 'image/jpeg');
  assert.deepEqual((await getAvatar('22345678', 140)).contentType, 'image/png');
});

test('四档尺寸白名单都能命中；不传尺寸默认 100', async () => {
  for (const s of [40, 100, 140, 640]) put(QQ, s, JPEG);
  for (const s of [40, 100, 140, 640]) {
    const r = await getAvatar(QQ, s);
    assert.ok(r && r.buffer.length, `s=${s} 应命中缓存`);
  }
  assert.ok(await getAvatar(QQ));                   // 不传 → 100 档
  assert.deepEqual([...AVATAR_SIZES].sort((a, b) => a - b), [40, 100, 140, 640]);
});

test('坏档：读缓存返回 null 且文件被删除（否则会破图 7 天）', () => {
  const bad = path.join(dir, '32345678_100.jpg');
  fs.writeFileSync(bad, HTML);
  assert.equal(__readAvatarCacheForTest('32345678', 100), null);
  assert.equal(fs.existsSync(bad), false, '坏档应被删掉，让后续请求按未命中重拉');
});

test('半截 / 空文件同样按坏档处理', () => {
  const p = path.join(dir, '42345678_100.jpg');
  fs.writeFileSync(p, Buffer.alloc(0));
  assert.equal(__readAvatarCacheForTest('42345678', 100), null);
  assert.equal(fs.existsSync(p), false);
});

test('非法 QQ 号直接拒绝，不拼路径也不出网', async () => {
  assert.equal(await getAvatar('1234', 100), null);              // 太短
  assert.equal(await getAvatar('1234567890123', 100), null);     // 13 位
  assert.equal(await getAvatar('12345678/../x', 100), null);     // 路径注入
  assert.equal(await getAvatar('12a45678', 100), null);
  assert.equal(await getAvatar('', 100), null);
});

test('非法尺寸一律 null，不静默回落到 100 档', async () => {
  // 100 档缓存刻意存在：旧实现 `Number(size)||100` 会把下面这些洗成 100 并命中，
  // 这个断言就是钉死「注释写的其它一律 404」。
  for (const s of [999, -1, 0, NaN, 'abc', '', 100.5]) {
    assert.equal(await getAvatar(QQ, s), null, `s=${String(s)} 应被拒绝`);
  }
});

test('缓存统计只数合法缓存文件', () => {
  const files = fs.readdirSync(dir).filter((f) => /^\d{5,12}_(40|100|140|640)\.jpg$/.test(f));
  const st = avatarCacheStats();
  assert.equal(st.count, files.length);
  assert.ok(st.bytes > 0);
});
