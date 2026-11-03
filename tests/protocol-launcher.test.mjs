/**
 * 协议端进程托管单测（2026-10-27，R125）
 *
 * 这块代码的价值全在"别把用户那份 SnowLuma 弄坏"，所以测的不是"能启动"，
 * 而是几个边界：
 *   · 目录不像 SnowLuma（没有 index.mjs）→ 必须拒绝，不能瞎 spawn；
 *   · 启动参数必须带 windowsHide（否则等于没解决"黑窗口"这个原始诉求）；
 *   · stdout 分片要按行重组（Node 的 data 事件不保证一行一块，直接推会切碎日志）；
 *   · stop/dispose 只动自己拉起的那个，且走 taskkill /t（否则留孤儿占端口）。
 *
 * 运行：node --test tests/protocol-launcher.test.mjs   （在 resources/app 目录下）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtocolLauncher, probeLaunchDir, resolveNodeRuntime } from '../src/protocol-launcher.js';

/** 造一个 SnowLuma 目录（只需 index.mjs，node.exe 可选）。 */
function makeDir({ withNode = true, entry = 'index.mjs', nested = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
  const target = nested ? path.join(dir, nested) : dir;
  if (nested) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, entry), '// fake\n', 'utf8');
  if (withNode) fs.writeFileSync(path.join(target, 'node.exe'), 'MZ', 'utf8');
  return dir;
}

/** 假 spawn：记录调用，返回可控的 ChildProcess 形状。 */
function fakeSpawn() {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('exit', 0, 'SIGTERM'); };
    calls.push({ cmd, args, opts, child });
    // taskkill 是 fire-and-forget：立刻回报退出，否则 stop() 会一直等
    if (/taskkill/i.test(String(cmd))) setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  impl.calls = calls;
  return impl;
}

function makeLauncher(over = {}) {
  const spawnImpl = over.spawnImpl || fakeSpawn();
  const events = [];
  const launcher = createProtocolLauncher({
    getConfig: () => ({ protocol: { launcher: { dir: '', autoLaunch: false } } }),
    updateConfig: () => ({}),
    emit: (type, payload) => events.push({ type, payload }),
    log: () => {},
    detectDir: async () => '',
    spawnImpl,
    ...over
  });
  return { launcher, spawnImpl, events };
}

test('目录不对就拒绝启动（没有 index.mjs）', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-empty-'));
  assert.equal(probeLaunchDir(empty).ok, false);
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir: empty });
  assert.equal(r.ok, false);
  assert.match(r.error, /index\.mjs/);
  assert.equal(spawnImpl.calls.length, 0, '拒绝时不能 spawn 任何进程');
});

test('启动参数：windowsHide + pipe + cwd 指向用户目录', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir });
  assert.equal(r.ok, true);
  const call = spawnImpl.calls[0];
  assert.equal(call.opts.windowsHide, true, '没有 windowsHide 就等于没解决黑窗口');
  assert.equal(call.opts.cwd, dir);
  assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(call.opts.detached, false, '要跟随应用退出，否则日志断了没人收');
  assert.ok(call.args[0].endsWith('index.mjs'));
  assert.equal(launcher.status().running, true);
});

test('目录里没有 node.exe 时用当前进程的 node 兜底', async () => {
  const dir = makeDir({ withNode: false });
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir });
  assert.equal(r.ok, true);
  assert.equal(spawnImpl.calls[0].cmd, process.execPath);
});

test('stdout 按行重组，分片不会把一行切成两截', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  await launcher.launch({ dir });
  const out = spawnImpl.calls[0].child.stdout;
  out.write('第一行\n第二');
  out.write('行\n\n第三行');
  out.write('\n');
  const texts = launcher.logs(50).map((l) => l.text);
  assert.deepEqual(texts.slice(-3), ['第一行', '第二行', '第三行']);
});

test('stderr 单独标级，且 ANSI 色码被剥掉', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  await launcher.launch({ dir });
  spawnImpl.calls[0].child.stderr.write('\u001b[31m[错误] 端口被占用\u001b[0m\n');
  const last = launcher.logs(5).at(-1);
  assert.equal(last.level, 'stderr');
  assert.equal(last.text, '[错误] 端口被占用');
});

test('超长行被截断，不会把整块面板撑爆', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  await launcher.launch({ dir });
  spawnImpl.calls[0].child.stdout.write(`${'x'.repeat(5000)}\n`);
  const last = launcher.logs(5).at(-1);
  assert.equal(last.text.length, 2001);   // 2000 + 省略号
  assert.ok(last.text.endsWith('…'));
});

test('stop 走 taskkill /t /f，并只针对自己拉起的 pid', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir });
  const pid = r.pid;
  await launcher.stop();
  const kill = spawnImpl.calls.find((c) => /taskkill/i.test(String(c.cmd)));
  assert.ok(kill, '没有调用 taskkill');
  assert.deepEqual(kill.args, ['/pid', String(pid), '/t', '/f']);
});

test('没启动过就 stop：不报错，也不误杀别人', async () => {
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.stop();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false);
  assert.equal(spawnImpl.calls.length, 0);
});

test('进程退出后状态回到未运行，并广播 protocol-status', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl, events } = makeLauncher();
  await launcher.launch({ dir });
  spawnImpl.calls[0].child.emit('exit', 1, null);
  const st = launcher.status();
  assert.equal(st.running, false);
  assert.equal(st.exit.code, 1);
  assert.ok(events.some((e) => e.type === 'protocol-status' && e.payload.running === false));
});

test('dispose 在应用退出时回收子进程（避免孤儿占 3001）', async () => {
  const dir = makeDir();
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir });
  launcher.dispose();
  const kill = spawnImpl.calls.find((c) => /taskkill/i.test(String(c.cmd)));
  assert.ok(kill);
  assert.equal(kill.args[1], String(r.pid));
});

// ── 以下是"别的用户自己下载 SnowLuma"这条路上的坑（2026-10-27 补）─────────

test('Electron 里没有 node.exe 也没有系统 node：拒绝启动，绝不拿 QQ Agent.exe 顶替', async () => {
  const dir = makeDir({ withNode: false });
  const { launcher, spawnImpl } = makeLauncher({
    isElectron: true,
    findNodeOverride: () => ''
  });
  const r = await launcher.launch({ dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /node\.exe/);
  assert.equal(spawnImpl.calls.length, 0, '必须一个进程都不起 —— 拿 exe 顶替会弹出第二个 QQ Agent');
});

test('Electron 里没有 node.exe 但有系统 Node.js：用系统那个', async () => {
  const dir = makeDir({ withNode: false });
  const sysNode = path.join(dir, 'fake-system-node.exe');
  fs.writeFileSync(sysNode, 'MZ', 'utf8');
  const { launcher, spawnImpl } = makeLauncher({
    isElectron: true,
    findNodeOverride: () => sysNode
  });
  const r = await launcher.launch({ dir });
  assert.equal(r.ok, true);
  assert.equal(spawnImpl.calls[0].cmd, sysNode);
});

test('resolveNodeRuntime：Electron 下永远不会返回 process.execPath', () => {
  const probe = { ok: true, hasOwnNode: false, nodeExe: '' };
  assert.equal(resolveNodeRuntime(probe, { isElectron: true, findNode: () => '' }), null);
  // 非 Electron（headless）才允许用当前进程的 node
  const headless = resolveNodeRuntime(probe, { isElectron: false, findNode: () => '' });
  assert.equal(headless.cmd, process.execPath);
});

test('解压多出一层目录时自动下钻（SnowLuma-x64\\SnowLuma-x64\\index.mjs）', async () => {
  // 真实场景：用户把 zip 解到 Desktop，得到 Desktop\SnowLuma-v2.1.1-win-x64\SnowLuma-v2.1.1-win-x64
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-nested-'));
  const outer = path.join(root, 'SnowLuma-v2.1.1-win-x64');
  const inner = path.join(outer, 'SnowLuma-v2.1.1-win-x64');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'index.mjs'), '// fake\n', 'utf8');
  fs.writeFileSync(path.join(inner, 'node.exe'), 'MZ', 'utf8');

  const probe = probeLaunchDir(outer);
  assert.equal(probe.ok, true);
  assert.equal(probe.dir, inner);
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir: outer });
  assert.equal(r.ok, true);
  assert.equal(spawnImpl.calls[0].opts.cwd, inner, 'cwd 要跟着下钻后的真实目录走');
});

test('目录名不像 SnowLuma 时不下钻（防止误填桌面也"猜对"）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-desktop-'));
  const inner = path.join(root, 'SnowLuma-v2.1.1-win-x64');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'index.mjs'), '// fake\n', 'utf8');
  const probe = probeLaunchDir(root);
  assert.equal(probe.ok, false, '外层不叫 snowluma 时应该老实报错，让用户把路径指准');
});

test('老发行包只有 index.js 也能启动', async () => {
  const dir = makeDir({ entry: 'index.js' });
  const probe = probeLaunchDir(dir);
  assert.equal(probe.ok, true);
  assert.equal(probe.entryName, 'index.js');
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir });
  assert.equal(r.ok, true);
  assert.ok(String(spawnImpl.calls[0].args[0]).endsWith('index.js'));
});

test('路径带空格与中文：spawn 用数组参数，不做 shell 拼接', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sl space 中文-'));
  fs.writeFileSync(path.join(base, 'index.mjs'), '// fake\n', 'utf8');
  fs.writeFileSync(path.join(base, 'node.exe'), 'MZ', 'utf8');
  const { launcher, spawnImpl } = makeLauncher();
  const r = await launcher.launch({ dir: base });
  assert.equal(r.ok, true);
  const call = spawnImpl.calls[0];
  assert.equal(call.opts.shell, undefined, '不能开 shell，否则空格/引号会炸');
  assert.equal(call.opts.cwd, base);
  assert.ok(call.args[0].includes('index.mjs'));
});
