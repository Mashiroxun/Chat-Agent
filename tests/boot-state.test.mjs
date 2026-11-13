// 启动状态纯函数回归护栏（启动链重写第一步「收编」，2026-11-13）。
//
// 这些行为原先只存在于 electron/main.js 的本地闭包里，改判据时最容易被动到：
//   · 交接标记的 15 秒新鲜度、isRelaunchChild 通行证语义、坏 JSON 兜底；
//   · patchRenderConfig 的「浅合并 + mkdir + 失败返回 false 不抛」；
//   · releaseOwnLock 的「不是自己的锁绝不碰」；
//   · boot-diag / gpu-off-flag 的行内容格式（追加 vs 覆盖）。
// 全部用临时目录 + 注入的 now 测，不 sleep、不碰真实 data 目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RELAUNCH_HANDOVER_MS,
  handoverPath,
  writeHandover,
  readHandover,
  clearHandover,
  renderConfigPath,
  readRenderConfig,
  patchRenderConfig,
  renderHealthPath,
  readRenderHealth,
  patchRenderHealth,
  bootDiagPath,
  appendBootDiag,
  gpuOffFlagPath,
  writeGpuOffFlag,
  releaseOwnLock
} from '../electron/boot-state.js';

const NOW = 1_700_000_000_000;

/** 造临时数据目录，并在用例结束后强制清理。 */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-boot-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 临时把某个 fs 方法换成「必定抛错」，跑完恢复。 */
function withFailingFs(method, fn) {
  const orig = fs[method];
  fs[method] = () => {
    const error = new Error(`模拟写入失败（${method}）`);
    error.code = 'EACCES';
    throw error;
  };
  try {
    return fn();
  } finally {
    fs[method] = orig;
  }
}

/** 造一个「路径是普通文件」的不可写 dataDir。 */
function unwritableDataDir(t) {
  const dir = tmpDir(t);
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  return file;
}

// ── 常量与路径计算 ────────────────────────────────────────────────────────

test('RELAUNCH_HANDOVER_MS 保持 15_000（不改默认值）', () => {
  assert.equal(RELAUNCH_HANDOVER_MS, 15_000);
});

test('四个路径函数：文件名逐字一致，空 dataDir 返回空串', (t) => {
  const dir = tmpDir(t);
  assert.equal(handoverPath(dir), path.join(dir, '.relaunch-handover'));
  assert.equal(renderConfigPath(dir), path.join(dir, 'render-config.json'));
  assert.equal(bootDiagPath(dir), path.join(dir, 'boot-diag.log'));
  assert.equal(gpuOffFlagPath(dir), path.join(dir, 'render-gpu-off.flag'));
  assert.equal(handoverPath(''), '');
  assert.equal(renderConfigPath(''), '');
  assert.equal(bootDiagPath(''), '');
  assert.equal(gpuOffFlagPath(''), '');
  assert.equal(handoverPath(undefined), '');
});

// ── 交接标记 ──────────────────────────────────────────────────────────────

test('writeHandover + readHandover：写入后可读，字段与注入的 now/pid 一致', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, 'GPU 崩溃自愈', NOW, 4242);
  const file = handoverPath(dir);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    pid: 4242,
    at: NOW,
    reason: 'GPU 崩溃自愈'
  });
  // 字节级一致：deepEqual 不守键顺序，这里把紧凑 JSON 原文逐字钉死。
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    JSON.stringify({ pid: 4242, at: NOW, reason: 'GPU 崩溃自愈' })
  );
  const got = readHandover(dir, { isRelaunchChild: false, now: NOW, maxAgeMs: RELAUNCH_HANDOVER_MS });
  assert.deepEqual(got, { pid: 4242, at: NOW, reason: 'GPU 崩溃自愈' });
});

test('readHandover：恰好等于 15s 仍算新鲜（边界用注入 now，不依赖真实时钟）', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, '边界', NOW, 4242);
  const got = readHandover(dir, {
    isRelaunchChild: false,
    now: NOW + RELAUNCH_HANDOVER_MS,
    maxAgeMs: RELAUNCH_HANDOVER_MS
  });
  assert.ok(got, 'now - at === maxAgeMs 时原实现用 > 判断，应仍有效');
  assert.equal(got.reason, '边界');
});

test('readHandover：超过 RELAUNCH_HANDOVER_MS 判无效（注入 now）', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, '陈旧标记', NOW, 4242);
  assert.equal(
    readHandover(dir, {
      isRelaunchChild: false,
      now: NOW + RELAUNCH_HANDOVER_MS + 1,
      maxAgeMs: RELAUNCH_HANDOVER_MS
    }),
    null
  );
  // 超龄标记仍留在磁盘上，由后续 clear 或下次写入处理（原实现不主动删）。
  assert.ok(fs.existsSync(handoverPath(dir)));
});

test('readHandover：isRelaunchChild=true 一律返回 null（即使标记新鲜）', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, 'GPU 崩溃自愈', NOW, 4242);
  assert.equal(
    readHandover(dir, { isRelaunchChild: true, now: NOW, maxAgeMs: RELAUNCH_HANDOVER_MS }),
    null
  );
  assert.ok(fs.existsSync(handoverPath(dir)), '通行证分支不删文件');
});

test('readHandover：坏 JSON 返回 null 且不抛', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(handoverPath(dir), '{ 这不是 JSON');
  assert.equal(readHandover(dir, { now: NOW }), null);
});

test('readHandover：缺 at / at=0 / at 非数字的标记判无效', (t) => {
  const dir = tmpDir(t);
  const file = handoverPath(dir);
  for (const raw of ['{}', '{"at":0,"reason":"x"}', '{"at":"bad","reason":"x"}', 'null']) {
    fs.writeFileSync(file, raw);
    assert.equal(readHandover(dir, { now: NOW }), null, `raw=${raw}`);
  }
});

test('readHandover：文件不存在返回 null；空 dataDir 也返回 null', (t) => {
  const dir = tmpDir(t);
  assert.equal(readHandover(dir, { now: NOW }), null);
  assert.equal(readHandover('', { now: NOW }), null);
});

test('readHandover：maxAgeMs 可注入 —— 第二步「改判据」的可单测落脚点', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, '判据试验', NOW, 4242);
  assert.equal(readHandover(dir, { now: NOW + 2_000, maxAgeMs: 1_000 }), null);
  assert.ok(readHandover(dir, { now: NOW + 2_000, maxAgeMs: 3_000 }));
});

test('clearHandover：清除后无文件；重复清除不抛', (t) => {
  const dir = tmpDir(t);
  writeHandover(dir, 'GPU 崩溃自愈', NOW, 4242);
  assert.ok(fs.existsSync(handoverPath(dir)));
  clearHandover(dir);
  assert.equal(fs.existsSync(handoverPath(dir)), false);
  assert.doesNotThrow(() => clearHandover(dir));
});

test('clearHandover：空 dataDir 不抛', () => {
  assert.doesNotThrow(() => clearHandover(''));
});

test('writeHandover：dataDir 不可写（父路径是文件）时不抛、不产生标记', (t) => {
  const badDir = unwritableDataDir(t);
  assert.doesNotThrow(() => writeHandover(badDir, 'GPU 崩溃自愈', NOW, 4242));
  assert.equal(fs.existsSync(handoverPath(badDir)), false);
});

test('writeHandover：fs.writeFileSync 抛错时被吞掉、只 log、不抛', (t) => {
  const dir = tmpDir(t);
  assert.doesNotThrow(() => withFailingFs('writeFileSync', () => {
    writeHandover(dir, 'GPU 崩溃自愈', NOW, 4242);
  }));
  assert.equal(fs.existsSync(handoverPath(dir)), false);
});

test('writeHandover：空 dataDir 跳过（不抛、不写相对路径文件）', () => {
  assert.doesNotThrow(() => writeHandover('', 'GPU 崩溃自愈', NOW, 4242));
  assert.equal(fs.existsSync(path.join(process.cwd(), '.relaunch-handover')), false);
});

// ── render-config ─────────────────────────────────────────────────────────

test('readRenderConfig：文件不存在 / 坏 JSON / 非对象均返回 {}', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readRenderConfig(dir), {});
  fs.writeFileSync(renderConfigPath(dir), '{ 坏 JSON');
  assert.deepEqual(readRenderConfig(dir), {});
  fs.writeFileSync(renderConfigPath(dir), '42');
  assert.deepEqual(readRenderConfig(dir), {});
  fs.writeFileSync(renderConfigPath(dir), 'null');
  assert.deepEqual(readRenderConfig(dir), {});
  assert.deepEqual(readRenderConfig(''), {});
});

test('readRenderConfig：正常对象原样返回', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(renderConfigPath(dir), JSON.stringify({ sandbox: false, hwVideoDecode: true }));
  assert.deepEqual(readRenderConfig(dir), { sandbox: false, hwVideoDecode: true });
});

test('patchRenderConfig：读旧值 + 浅合并，格式化与现有一致（2 空格缩进）', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(renderConfigPath(dir), JSON.stringify({ a: 1, sandbox: true }, null, 2));
  assert.equal(patchRenderConfig(dir, { b: 2, sandbox: false }), true);
  const expected = JSON.stringify({ a: 1, sandbox: false, b: 2 }, null, 2);
  assert.equal(fs.readFileSync(renderConfigPath(dir), 'utf8'), expected);
});

test('patchRenderConfig：目录不存在时自动创建（mkdir recursive）', (t) => {
  const root = tmpDir(t);
  const nested = path.join(root, 'nested', 'data');
  assert.equal(fs.existsSync(nested), false);
  assert.equal(patchRenderConfig(nested, { sandbox: false }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(renderConfigPath(nested), 'utf8')), { sandbox: false });
});

test('patchRenderConfig：旧配置是坏 JSON 时当作 {} 合并', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(renderConfigPath(dir), '{ 坏 JSON');
  assert.equal(patchRenderConfig(dir, { sandbox: false, sandboxOffBy: 'auto-crash' }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(renderConfigPath(dir), 'utf8')), {
    sandbox: false,
    sandboxOffBy: 'auto-crash'
  });
});

test('patchRenderConfig：写失败返回 false 且不抛', (t) => {
  const dir = tmpDir(t);
  let result = null;
  assert.doesNotThrow(() => withFailingFs('writeFileSync', () => {
    result = patchRenderConfig(dir, { sandbox: false });
  }));
  assert.equal(result, false);
});

test('patchRenderConfig：父路径是文件时返回 false 且不抛', (t) => {
  const badDir = unwritableDataDir(t);
  assert.equal(patchRenderConfig(badDir, { sandbox: false }), false);
});

test('patchRenderConfig：空 dataDir 返回 false 且不写相对路径文件', () => {
  assert.equal(patchRenderConfig('', { sandbox: false }), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'render-config.json')), false);
});

// ── 实例锁 ────────────────────────────────────────────────────────────────

test('releaseOwnLock：pid 匹配才删，返回 true', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'qq-agent.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242 }));
  assert.equal(releaseOwnLock(dir, 4242, 'GPU 崩溃自愈'), true);
  assert.equal(fs.existsSync(lock), false);
});

test('releaseOwnLock：pid 不匹配绝不碰（文件与内容原样）', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'qq-agent.lock');
  const raw = JSON.stringify({ pid: 9999, token: 'keep-me' });
  fs.writeFileSync(lock, raw);
  assert.equal(releaseOwnLock(dir, 4242, 'GPU 崩溃自愈'), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), raw);
});

test('releaseOwnLock：锁内 pid 为数字字符串时按 Number 比对（与原实现一致）', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'qq-agent.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: '4242' }));
  assert.equal(releaseOwnLock(dir, 4242, '渲染崩溃自愈'), true);
  assert.equal(fs.existsSync(lock), false);
});

test('releaseOwnLock：坏 JSON / 文件不存在 / 空 dataDir 均返回 false 且不抛', (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'qq-agent.lock');
  fs.writeFileSync(lock, '{ 坏 JSON');
  assert.equal(releaseOwnLock(dir, 4242, 'x'), false);
  assert.ok(fs.existsSync(lock), '坏 JSON 时不能删别人的锁');
  fs.rmSync(lock);
  assert.equal(releaseOwnLock(dir, 4242, 'x'), false);
  assert.equal(releaseOwnLock('', 4242, 'x'), false);
});

// ── boot-diag / gpu-off-flag：内容格式与现有实现一致 ───────────────────────

test('appendBootDiag：行内容逐字一致，重复调用是追加', (t) => {
  const dir = tmpDir(t);
  const line1 = '2026-11-13T00:00:00.000Z 渲染相关进程崩溃 kind=gpu count=1\n';
  const line2 = '2026-11-13T00:00:01.000Z 渲染相关进程崩溃 kind=gpu count=2\n';
  assert.doesNotThrow(() => appendBootDiag(dir, line1));
  assert.doesNotThrow(() => appendBootDiag(dir, line2));
  assert.equal(fs.readFileSync(bootDiagPath(dir), 'utf8'), line1 + line2);
});

test('writeGpuOffFlag：行内容逐字一致，重复调用是覆盖（writeFileSync）', (t) => {
  const dir = tmpDir(t);
  const line1 = '2026-11-13T00:00:00.000Z kind=gpu\n';
  const line2 = '2026-11-13T00:00:01.000Z kind=renderer\n';
  assert.doesNotThrow(() => writeGpuOffFlag(dir, line1));
  assert.equal(fs.readFileSync(gpuOffFlagPath(dir), 'utf8'), line1);
  assert.doesNotThrow(() => writeGpuOffFlag(dir, line2));
  assert.equal(fs.readFileSync(gpuOffFlagPath(dir), 'utf8'), line2);
});

test('appendBootDiag / writeGpuOffFlag：空 dataDir 不抛、不产生杂散文件', () => {
  assert.doesNotThrow(() => appendBootDiag('', 'x\n'));
  assert.doesNotThrow(() => writeGpuOffFlag('', 'x\n'));
  assert.equal(fs.existsSync(path.join(process.cwd(), 'boot-diag.log')), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'render-gpu-off.flag')), false);
});

test('appendBootDiag / writeGpuOffFlag：裸调用写失败会抛（调用方必须包 try/catch）', (t) => {
  // 契约护栏：这两个函数不吞异常。旧实现是内联语句 + 调用点空 catch，
  // 所以「永不抛」是调用点的性质、不是函数的性质。第二步脱离 try/catch
  // 调用时若期望静默，必须先显式做出决定，而不是被这段注释骗过去。
  const badDir = unwritableDataDir(t);
  assert.throws(() => appendBootDiag(badDir, 'x\n'));
  assert.throws(() => writeGpuOffFlag(badDir, 'x\n'));
});

test('readHandover：不传 now 时判定使用 readFileSync 之后的 Date.now()（取样点护栏）', (t) => {
  const dir = tmpDir(t);
  const file = handoverPath(dir);
  // at 恰好在 15s 边界：I/O 前取样（NOW）判有效，I/O 后取样（NOW+5）判无效。
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: NOW - RELAUNCH_HANDOVER_MS, reason: '取样点' }));

  const realReadFileSync = fs.readFileSync;
  const realDateNow = Date.now;
  const clockCalls = [];
  let afterIo = false;
  fs.readFileSync = function patchedRead(p, ...args) {
    const out = realReadFileSync.call(this, p, ...args);
    if (String(p) === file) afterIo = true;   // 模拟 I/O 期间时钟前进 5ms
    return out;
  };
  Date.now = () => {
    const value = afterIo ? NOW + 5 : NOW;
    clockCalls.push(value);
    return value;
  };
  try {
    const got = readHandover(dir, { isRelaunchChild: false, maxAgeMs: RELAUNCH_HANDOVER_MS });
    assert.equal(got, null, 'I/O 之后取样 ⇒ 15005 > 15000 ⇒ 判无效；若把 now 挪回函数入口会返回 obj');
    assert.deepEqual(clockCalls, [NOW + 5], 'Date.now() 只应在 readFileSync 之后被调用一次');
  } finally {
    fs.readFileSync = realReadFileSync;
    Date.now = realDateNow;
  }
});

// ── render-health.json：连续健康启动计数的读写（2026-11-13 第二轮）──────────
//
// 这份文件是「自动撤销崩溃降级」的唯一证据源（判定见 render-policy.js 的
// shouldRevokeCrashCompat）。它坏掉的表现非常隐蔽：不报错、不崩，
// 只是那台机器的渲染沙箱**再也不会回来**。所以下面把「读脏值」和
// 「写脏值」两头的兜底都钉死。

/** render-health.json 的规范默认内容。 */
const HEALTH_DEFAULT = {
  version: 1,
  consecutiveHealthyBoots: 0,
  gpuCrashEver: false,
  lastHealthyAt: '',
  lastDowngradeAt: ''
};

/** 把字符串原样写进 dataDir 的 render-health.json。 */
function writeHealth(t, dir, raw) {
  fs.writeFileSync(renderHealthPath(dir), raw);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('renderHealthPath：文件名逐字一致，空 dataDir 返回空串', (t) => {
  const dir = tmpDir(t);
  assert.equal(renderHealthPath(dir), path.join(dir, 'render-health.json'));
  assert.equal(renderHealthPath(''), '');
  assert.equal(renderHealthPath(undefined), '');
});

test('readRenderHealth：文件不存在 → 默认对象（计数 0 ⇒ 一切撤销都 false，行为与今天一致）', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readRenderHealth(dir), HEALTH_DEFAULT);
  assert.deepEqual(readRenderHealth(''), HEALTH_DEFAULT);
  assert.deepEqual(readRenderHealth(undefined), HEALTH_DEFAULT);
});

test('readRenderHealth：坏 JSON / 非对象 → 默认对象，不抛', (t) => {
  for (const raw of ['{ 这不是 JSON', '', 'null', '"字符串"', '123', '[]', 'true']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-health-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeHealth(t, dir, raw);
    assert.deepEqual(readRenderHealth(dir), HEALTH_DEFAULT, `raw=${JSON.stringify(raw)} 应回落默认值`);
  }
});

test('readRenderHealth：脏字段逐个归一（字符串计数 / null / 非布尔 gpuCrashEver 都不许漏过）', (t) => {
  const dir = tmpDir(t);
  writeHealth(t, dir, JSON.stringify({
    version: '2',
    consecutiveHealthyBoots: '5',
    gpuCrashEver: 'true',
    lastHealthyAt: 12345,
    lastDowngradeAt: null
  }));
  assert.deepEqual(readRenderHealth(dir), HEALTH_DEFAULT, '全部字段非法 ⇒ 全部回落默认值');

  // 单个脏字段只影响自己
  writeHealth(t, dir, JSON.stringify({ consecutiveHealthyBoots: 7, gpuCrashEver: true, version: 1, lastHealthyAt: 'A', lastDowngradeAt: 'B' }));
  assert.deepEqual(readRenderHealth(dir), {
    version: 1, consecutiveHealthyBoots: 7, gpuCrashEver: true, lastHealthyAt: 'A', lastDowngradeAt: 'B'
  });
});

test('readRenderHealth：负数 / 小数计数被归一成非负整数（判定侧才不会看到 2.5 或 -1）', (t) => {
  const dir = tmpDir(t);
  writeHealth(t, dir, JSON.stringify({ consecutiveHealthyBoots: -3 }));
  assert.equal(readRenderHealth(dir).consecutiveHealthyBoots, 0);
  writeHealth(t, dir, JSON.stringify({ consecutiveHealthyBoots: 2.9 }));
  assert.equal(readRenderHealth(dir).consecutiveHealthyBoots, 2);
});

test('patchRenderHealth：文件不存在时创建，落盘的字节格式与字段顺序固定', (t) => {
  const dir = tmpDir(t);
  assert.equal(patchRenderHealth(dir, { consecutiveHealthyBoots: 1, lastHealthyAt: 'T1' }), true);
  const raw = fs.readFileSync(renderHealthPath(dir), 'utf8');
  assert.equal(raw, JSON.stringify({
    version: 1,
    consecutiveHealthyBoots: 1,
    gpuCrashEver: false,
    lastHealthyAt: 'T1',
    lastDowngradeAt: ''
  }, null, 2), '字段顺序/缩进必须稳定，否则每次读写都在抖动');
  assert.deepEqual(readRenderHealth(dir), {
    version: 1, consecutiveHealthyBoots: 1, gpuCrashEver: false, lastHealthyAt: 'T1', lastDowngradeAt: ''
  });
});

test('patchRenderHealth：浅合并不丢旧字段（先记 gpuCrashEver，再记健康计数）', (t) => {
  const dir = tmpDir(t);
  patchRenderHealth(dir, { gpuCrashEver: true, lastDowngradeAt: 'DOWN' });
  patchRenderHealth(dir, { consecutiveHealthyBoots: 2, lastHealthyAt: 'UP' });
  assert.deepEqual(readRenderHealth(dir), {
    version: 1, consecutiveHealthyBoots: 2, gpuCrashEver: true, lastHealthyAt: 'UP', lastDowngradeAt: 'DOWN'
  });
});

test('patchRenderHealth：gpuCrashEver 只增不减（patch 传 false 也改不回去）', (t) => {
  const dir = tmpDir(t);
  patchRenderHealth(dir, { gpuCrashEver: true });
  assert.equal(readRenderHealth(dir).gpuCrashEver, true);
  patchRenderHealth(dir, { gpuCrashEver: false });
  assert.equal(readRenderHealth(dir).gpuCrashEver, true, '历史事实不能被翻转');

  // 从 false 起手不能被伪造：只有明确的 true 才算
  const dir2 = tmpDir(t);
  patchRenderHealth(dir2, { gpuCrashEver: 'true' });
  assert.equal(readRenderHealth(dir2).gpuCrashEver, false);
});

test('patchRenderHealth：脏 patch 值归一（NaN / 字符串 / 负数都不会写进文件）', (t) => {
  const dir = tmpDir(t);
  patchRenderHealth(dir, { consecutiveHealthyBoots: 5 });
  patchRenderHealth(dir, { consecutiveHealthyBoots: '9' });
  assert.equal(readRenderHealth(dir).consecutiveHealthyBoots, 0, '字符串计数按非法处理 ⇒ 归零');

  patchRenderHealth(dir, { consecutiveHealthyBoots: 4 });
  patchRenderHealth(dir, { consecutiveHealthyBoots: -1 });
  assert.equal(readRenderHealth(dir).consecutiveHealthyBoots, 0, '负数归零');
});

test('patchRenderHealth：目录不可写 → 返回 false，不抛，也不改动已有文件', (t) => {
  const dir = tmpDir(t);
  patchRenderHealth(dir, { consecutiveHealthyBoots: 3 });
  const before = fs.readFileSync(renderHealthPath(dir), 'utf8');
  const ok = withFailingFs('writeFileSync', () => patchRenderHealth(dir, { consecutiveHealthyBoots: 0 }));
  assert.equal(ok, false);
  assert.equal(fs.readFileSync(renderHealthPath(dir), 'utf8'), before, '写失败不能把旧文件截断');

  // 父路径是普通文件（ENOTDIR）同样只返回 false
  assert.equal(patchRenderHealth(unwritableDataDir(t), { consecutiveHealthyBoots: 1 }), false);
  assert.equal(patchRenderHealth('', { consecutiveHealthyBoots: 1 }), false);
});
