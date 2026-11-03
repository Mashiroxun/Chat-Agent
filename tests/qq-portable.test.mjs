// 便携 QQ 进程管理测试（0.4.9.3）
//
// 这套代码刚从 app.js 外提出来，之前零覆盖。测试靠依赖注入（假 fs / 假 net / 假 spawn），
// 不碰真实进程、不碰真实磁盘、不真的连端口。
//
// 覆盖：路径推导、就绪判定、日志累积、端口探测、多实例状态隔离。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createQqPortable } from '../src/qq-portable.js';

const FAKE_ROOT = process.platform === 'win32' ? 'C:\\fake-root' : '/fake-root';

function makeFakeFs({ exists = false } = {}) {
  const calls = [];
  return {
    calls,
    existsSync(p) { calls.push(p); return exists; },
    mkdirSync() {},
    readdirSync() { return []; },
    statSync() { return { isDirectory: () => false, size: 0 }; },
    readFileSync() { return ''; },
    writeFileSync() {},
    createWriteStream() { return { write() {}, end() {}, on() {} }; },
    promises: {},
  };
}

function makeFakeNet({ reachable = false } = {}) {
  return {
    Socket: class {
      setTimeout() {}
      connect() {
        // 模拟异步结果
        queueMicrotask(() => {
          if (reachable) this._handlers?.connect?.();
          else this._handlers?.error?.(new Error('ECONNREFUSED'));
        });
      }
      on(ev, cb) { (this._handlers ??= {})[ev] = cb; return this; }
      once(ev, cb) { (this._handlers ??= {})[ev] = cb; return this; }
      destroy() {}
    },
  };
}

test('默认参数下能实例化，门面方法齐全', () => {
  const qq = createQqPortable({ log() {}, emit() {} });
  for (const k of ['isPortOpen', 'qqPortableStatus', 'launchPortableQQ', 'stopPortableQQ', 'showPortableQQ', 'setupPortableQQFromLocal']) {
    assert.equal(typeof qq[k], 'function', `${k} 应该是函数`);
  }
  assert.ok(Array.isArray(qq.qqPortableLogs));
});

test('qqPortableDir 基于注入的 ROOT 推导', () => {
  const qq = createQqPortable({ log() {}, emit() {}, ROOT: FAKE_ROOT });
  assert.equal(qq.__internals.qqPortableDir(), path.join(FAKE_ROOT, 'runtime', 'qq-portable'));
});

test('qqPortableExe 指向目录下的 QQ.exe', () => {
  const qq = createQqPortable({ log() {}, emit() {}, ROOT: FAKE_ROOT });
  const exe = qq.__internals.qqPortableExe();
  assert.ok(exe.endsWith('QQ.exe'), `实际 ${exe}`);
  assert.ok(exe.startsWith(qq.__internals.qqPortableDir()));
});

test('qqPortableReady 由 fs.existsSync 决定', () => {
  const qqMissing = createQqPortable({ log() {}, emit() {}, ROOT: FAKE_ROOT, fs: makeFakeFs({ exists: false }) });
  assert.equal(qqMissing.__internals.qqPortableReady(), false);

  const qqPresent = createQqPortable({ log() {}, emit() {}, ROOT: FAKE_ROOT, fs: makeFakeFs({ exists: true }) });
  assert.equal(qqPresent.__internals.qqPortableReady(), true);
});

test('pushQqLog 累积到 qqPortableLogs', () => {
  const qq = createQqPortable({ log() {}, emit() {} });
  const before = qq.qqPortableLogs.length;
  qq.__internals.pushQqLog('第一行');
  qq.__internals.pushQqLog('第二行', 'stderr');
  assert.ok(qq.qqPortableLogs.length >= before + 2, '日志应至少增加两条');
});

test('isPortOpen 在端口可达时返回 true', async () => {
  const qq = createQqPortable({ log() {}, emit() {}, net: makeFakeNet({ reachable: true }) });
  assert.equal(await qq.isPortOpen('127.0.0.1', 8080), true);
});

test('isPortOpen 在端口不可达时返回 false', async () => {
  const qq = createQqPortable({ log() {}, emit() {}, net: makeFakeNet({ reachable: false }) });
  assert.equal(await qq.isPortOpen('127.0.0.1', 8080), false);
});

test('isPortOpen 对非法端口直接返回 false（不发起连接）', async () => {
  const qq = createQqPortable({ log() {}, emit() {}, net: makeFakeNet({ reachable: true }) });
  assert.equal(await qq.isPortOpen('127.0.0.1', 0), false);
  assert.equal(await qq.isPortOpen('127.0.0.1', 70000), false);
  assert.equal(await qq.isPortOpen('', 8080), false);
});

test('两个实例的状态互不影响', () => {
  const a = createQqPortable({ log() {}, emit() {} });
  const b = createQqPortable({ log() {}, emit() {} });
  a.__internals.pushQqLog('只进 A');
  assert.ok(a.qqPortableLogs.length > 0);
  assert.equal(b.qqPortableLogs.length, 0, 'B 不应看到 A 的日志');
});
