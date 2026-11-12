// 时钟回拨安全：所有「窗口内」判定在时间戳跑到未来时必须判为「已过期」。
//
// 背景：项目里二十多处 `Date.now() - at < TTL`，回拨后差值为负 → 恒 true →
// 缓存/冷却/去重永久卡死，且日志里看不出异常。这里锁死新工具的契约，
// 也让后续把剩余调用点迁过来时有统一口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { elapsedSince, withinWindow, expiredSince, expiredSinceFile } from '../src/elapsed.js';

const NOW = 1_800_000_000_000;   // 固定时钟，避免依赖真实时间
const MIN = 60_000;

test('正常时间：窗口内 / 窗口外与减法判定完全一致', () => {
  assert.equal(withinWindow(NOW - 10_000, MIN, NOW), true);
  assert.equal(withinWindow(NOW - MIN, MIN, NOW), false);       // 恰好到点
  assert.equal(withinWindow(NOW - MIN - 1, MIN, NOW), false);
  assert.equal(withinWindow(0, MIN, NOW), false);               // 从没记录过
  assert.equal(elapsedSince(NOW - 10_000, NOW), 10_000);
});

test('时钟回拨：at 在未来 → 立即视为过期，不再卡在「冷却中」', () => {
  // 回拨 5 分钟、1 小时、甚至掉到 1970 之前，结论都一样
  for (const future of [NOW + 1, NOW + 5 * MIN, NOW + 365 * 86400_000]) {
    assert.equal(elapsedSince(future, NOW), Infinity, `at=${future}`);
    assert.equal(withinWindow(future, MIN, NOW), false, `at=${future} 不能判成窗口内`);
    assert.equal(expiredSince(future, MIN, NOW), true);
  }
  // 旧写法的反例（写在这里当文档）：负差值 < 正数，恒为 true
  assert.equal((NOW - (NOW + 5 * MIN)) < MIN, true, '旧写法确实会误判');
});

test('文件 mtime 超前（ZIP / 备份恢复）时缓存必须判为过期', () => {
  const mtime = NOW + 2 * 86400_000;   // 打包机比本机快两天
  assert.equal(expiredSince(mtime, 7 * 86400_000, NOW), true);
  assert.equal(withinWindow(mtime, 7 * 86400_000, NOW), false);
});

test('脏时间戳（NaN / Infinity / undefined / null / 字符串）不炸、不误判为有效', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'abc', {}, Symbol('x')]) {
    assert.equal(withinWindow(bad, MIN, NOW), false, `at=${String(bad)}`);
    assert.equal(expiredSince(bad, MIN, NOW), true);
  }
});

test('窗口长度非法 / 关闭（0 或负数 / NaN）一律不在窗口内', () => {
  for (const w of [0, -1, NaN, Infinity, undefined, 'abc']) {
    assert.equal(withinWindow(NOW - 10, w, NOW), false, `windowMs=${String(w)}`);
  }
});

test('文件 mtime：轻微超前按「刚写入」，明显超前才判过期', () => {
  const TTL = 7 * 86400_000;
  // Windows 上 writeFileSync 后 mtimeMs 常比 Date.now() 超前几毫秒到几秒。
  // 严格版会把刚下载好的缓存判成过期，并让 readCache 提前 return 跳过坏档清理
  // —— 2026-11-11 全量回归真的抓到了这两条，所以文件时间戳必须走带容差的版本。
  for (const skew of [1, 50, 5000, 59_000]) {
    assert.equal(expiredSinceFile(NOW + skew, TTL, NOW), false, `超前 ${skew}ms 应视作刚写入`);
  }
  assert.equal(expiredSinceFile(NOW + 2 * 86400_000, TTL, NOW), true, '打包机时间超前两天');
  assert.equal(expiredSinceFile(NOW - TTL - 1, TTL, NOW), true, '真的超过 7 天');
  assert.equal(expiredSinceFile(NOW - 1000, TTL, NOW), false, '刚写入的正常文件');
  assert.equal(expiredSinceFile(0, TTL, NOW), true, '从未记录 / 无效时间戳');
  assert.equal(expiredSinceFile(Symbol('x'), TTL, NOW), true, '不因脏值抛异常');
});

test('时钟恢复正常后，同一条记录重新按正常语义判定', () => {
  const at = NOW;
  assert.equal(withinWindow(at, MIN, NOW - MIN), false);   // 回拨期间：过期、允许重试
  assert.equal(withinWindow(at, MIN, at + 10_000), true); // 时间追上来：仍在新一轮窗口内
  assert.equal(withinWindow(at, MIN, at + MIN), false);   // 到点：可再次执行
});
