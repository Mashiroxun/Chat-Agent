// headless 与桌面版必须共用同一套数据目录（0.4.9.3）
//
// 实锤证据：现场机器上同时存在两套目录
//   <安装根>\data                      （桌面版，config 49KB、日志当天还在写）
//   <安装根>\resources\app\data        （headless，config 21KB、停在 11-05）
// 用 headless 排查时「插件没了、记忆空了」= 读错目录，不是数据丢了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveHeadlessDataDir } from '../src/data-dir.js';

const APP_ROOT = path.join('D:', 'QQ Agent', 'resources', 'app');
const PORTABLE = path.join('D:', 'QQ Agent', 'data');
const LEGACY = path.join(APP_ROOT, 'data');

const fakeExists = (...present) => (p) => present.map(path.normalize).includes(path.normalize(p));

test('显式 QQ_AGENT_DATA_DIR 永远优先', () => {
  const r = resolveHeadlessDataDir(APP_ROOT, {
    env: { QQ_AGENT_DATA_DIR: 'X:\\custom\\data' },
    exists: () => true
  });
  assert.equal(r.dir, 'X:\\custom\\data');
  assert.equal(r.source, 'env');
  assert.equal(r.warning, '');
});

test('开发态（项目根直起）仍用项目内 data', () => {
  const r = resolveHeadlessDataDir(path.join('D:', 'src', 'qq-agent'), {
    env: {}, exists: () => false
  });
  assert.equal(r.dir, path.join('D:', 'src', 'qq-agent', 'data'));
  assert.equal(r.source, 'dev');
});

test('打包态：桌面版目录已存在 → 与桌面版对齐', () => {
  const r = resolveHeadlessDataDir(APP_ROOT, { env: {}, exists: fakeExists(PORTABLE, LEGACY) });
  assert.equal(r.dir, PORTABLE);
  assert.equal(r.source, 'portable');
});

test('打包态：两边都还没建 → 也建到桌面版那处，别再造第三套', () => {
  const r = resolveHeadlessDataDir(APP_ROOT, { env: {}, exists: () => false });
  assert.equal(r.dir, PORTABLE);
  assert.equal(r.source, 'portable');
});

test('打包态：只有旧 headless 数据 → 沿用旧目录并给明确提示，不让数据突然消失', () => {
  const r = resolveHeadlessDataDir(APP_ROOT, { env: {}, exists: fakeExists(LEGACY) });
  assert.equal(r.dir, LEGACY);
  assert.equal(r.source, 'legacy-headless');
  assert.match(r.warning, /合并|QQ_AGENT_DATA_DIR/);
});
