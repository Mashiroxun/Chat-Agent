// 自更新（方案 A+B，2026-11-12）的行为约束。
//
// 为什么这些用例必须存在：自更新是"在用户安装目录里动文件"的功能，
// 出错的形态都很隐蔽 ——
//   · manifest 路径校验漏一条（比如没挡 data/）→ 用户数据被补丁覆盖且不可恢复；
//   · 补丁 sha 校验失败不回滚 → 应用半新半旧，起不来；
//   · full 替换挪走旧文件后失败 → 用户只剩一个残缺安装目录；
//   · janitor 误删 → 下次启动带着上次的尸体跑。
// 全部用临时目录测，不碰真实安装布局。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  UPDATE_ARTIFACTS, pickUpdateAssets, parseRepoFromApi, resolveRootDir,
  walkCollect, findEscapePaths, sha256File, parseSha256Text, validatePatchManifest,
  createSelfUpdateService, verifyZip, isValidPending, parseDigestSha256,
  isPidAlive, readHelperPid, readHelperLock, writeHelperLock, refreshHelperLock,
  clearHelperLock, assertNoLiveHelper, helperLockPath,
  isHelperLive, HELPER_LOCK_STALE_MS, __setHelperImageProbeForTest
} from '../src/self-update.js';
import {
  readPending, writePendingForTest, applyPatchFromStaging, applyFullFromStaging,
  rollbackFull, runJanitor, waitForPidExit, isRolledBackPartial, runAsHelper
} from '../electron/self-update-apply.js';

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'su-test-'));
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * 造一个**结构合法**的 full 包 staging。
 * 2026-11-12 起 applyFullFromStaging 会先校验包结构（B8），所以 fixtures 必须带
 * QQ Agent.exe / resources/app/package.json（含 main）/ 该 main 指向的文件。
 */
function buildFullStaging(dir, { exe = 'new exe', appJs = 'new code', main = 'electron/main.js' } = {}) {
  write(path.join(dir, 'QQ Agent.exe'), exe);
  write(path.join(dir, 'resources', 'app', 'electron', 'main.js'), '// new main');
  write(path.join(dir, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'qq-agent', version: '0.4.9.4', main }, null, 2));
  if (appJs !== null) write(path.join(dir, 'resources', 'app', 'src', 'app.js'), appJs);
}

// ── 资产挑选 ────────────────────────────────────────────────────────────────
test('pickUpdateAssets：全量挑 zip、补丁挑 patch-*.zip，互不混淆', () => {
  const release = {
    tag_name: 'v0.4.9.4',
    assets: [
      { name: '0.4.9.4.zip', browser_download_url: 'https://example/0.4.9.4.zip', size: 10, digest: 'sha256:' + 'a'.repeat(64) },
      { name: 'patch-0.4.9.4.zip', browser_download_url: 'https://example/patch.zip', size: 2, digest: null },
      { name: 'patch-0.4.9.4.zip.sha256', browser_download_url: 'https://example/patch.zip.sha256', size: 1, digest: null }
    ]
  };
  const picked = pickUpdateAssets(release);
  assert.equal(picked.latest, '0.4.9.4');
  assert.equal(picked.patch.name, 'patch-0.4.9.4.zip');
  assert.equal(picked.full.name, '0.4.9.4.zip');
  assert.match(picked.full.digest, /^sha256:/);
  assert.ok(picked.shaSiblings.has('patch-0.4.9.4.zip.sha256'));
});

test('pickUpdateAssets：win-x64 命名的全量包优先；没有任何资产不炸', () => {
  const withWin64 = pickUpdateAssets({
    tag_name: 'v1.0.0',
    assets: [
      { name: 'source.zip', browser_download_url: 'u1', size: 1, digest: null },
      { name: 'qq-agent-win-x64.zip', browser_download_url: 'u2', size: 2, digest: null }
    ]
  });
  assert.equal(withWin64.full.name, 'qq-agent-win-x64.zip');
  const empty = pickUpdateAssets({ tag_name: 'v1.0.0', assets: [] });
  assert.equal(empty.full, null);
  assert.equal(empty.patch, null);
});

test('parseRepoFromApi：从 release API 地址解析 owner/repo；别的形态返回 null', () => {
  assert.deepEqual(parseRepoFromApi('https://api.github.com/repos/Mashiroxun/Chat-Agent/releases/latest'),
    { owner: 'Mashiroxun', repo: 'Chat-Agent' });
  assert.equal(parseRepoFromApi('https://example.com/whatever'), null);
});

// ── 布局探测 ────────────────────────────────────────────────────────────────
test('resolveRootDir：打包布局（root 有 QQ Agent.exe）返回安装根；开发布局返回 appDir 本身', () => {
  const tmp = mkTmp();
  const appDir = path.join(tmp, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  assert.equal(resolveRootDir(appDir), appDir);          // 没有 exe：开发检出
  write(path.join(tmp, 'QQ Agent.exe'), 'exe');
  assert.equal(resolveRootDir(appDir), tmp);             // 有 exe：打包安装
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── zip-slip 防线 ───────────────────────────────────────────────────────────
test('findEscapePaths：../ 与绝对路径被拦，正常相对路径放行', () => {
  const files = walkCollectSyncHelper([
    ['src/app.js', 'x'], ['../evil.txt', 'x'], ['ui/index.html', 'x']
  ]);
  const bad = findEscapePaths(files);
  assert.deepEqual(bad, ['../evil.txt']);
  function walkCollectSyncHelper(list) {
    return list.map(([rel, content]) => ({ rel, abs: '/tmp/' + rel, content }));
  }
});

// ── patch manifest 校验 ─────────────────────────────────────────────────────
function buildPatchStaging(dir, { base = '0.4.9.3', files = {}, deletions = [], wrongSha = false } = {}) {
  const entries = Object.entries(files);   // [rel, content]
  const manifest = {
    type: 'patch', version: '0.4.9.4', base, createdAt: '2026-11-12T00:00:00Z',
    files: entries.map(([rel, content]) => ({
      path: rel,
      sha256: wrongSha ? '0'.repeat(64) : sha256Buf(Buffer.from(content)),
      size: Buffer.byteLength(content)
    })),
    deletions
  };
  for (const [rel, content] of entries) write(path.join(dir, rel), content);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('validatePatchManifest：合法清单通过，文件与 sha256 一一对应', () => {
  const tmp = mkTmp();
  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  buildPatchStaging(staging, { files: { 'src/app.js': 'new code', 'ui/index.html': '<html>' } });
  const v = validatePatchManifest(staging, '0.4.9.3');
  assert.equal(v.files.length, 2);
  assert.equal(v.manifest.version, '0.4.9.4');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validatePatchManifest：基线不符 → 抛 fallbackToFull（客户端据此回退全量包）', () => {
  const tmp = mkTmp();
  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  buildPatchStaging(staging, { base: '0.4.9.1', files: { 'src/app.js': 'x' } });
  assert.throws(() => validatePatchManifest(staging, '0.4.9.3'), (e) => e.fallbackToFull === true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validatePatchManifest：绝不允许触碰 data/、plugin-data/、node_modules/', () => {
  const tmp = mkTmp();
  const staging = path.join(tmp, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  for (const evil of ['data/config.json', 'plugin-data/self-doctor/x.json', 'node_modules/ws/index.js', '../outside.js', '/abs/path.js']) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    buildPatchStaging(staging, { files: { 'src/app.js': 'ok', [evil]: 'evil' } });
    assert.throws(() => validatePatchManifest(staging, '0.4.9.3'), undefined, `应拒绝：${evil}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── patch 应用（含备份/回滚）────────────────────────────────────────────────
test('applyPatchFromStaging：覆盖旧文件前先备份，新文件直接落地', async () => {
  const tmp = mkTmp();
  const appDir = path.join(tmp, 'app');
  const staging = path.join(tmp, 'staging');
  const backup = path.join(tmp, 'backup');
  write(path.join(appDir, 'src', 'a.js'), 'old a');
  fs.mkdirSync(staging, { recursive: true });
  buildPatchStaging(staging, { files: { 'src/a.js': 'new a', 'src/b.js': 'new b' } });
  const summary = await applyPatchFromStaging({ staging, appDir, backupDir: backup });
  assert.equal(summary.files, 2);
  assert.equal(fs.readFileSync(path.join(appDir, 'src', 'a.js'), 'utf8'), 'new a');
  assert.equal(fs.readFileSync(path.join(appDir, 'src', 'b.js'), 'utf8'), 'new b');
  assert.equal(fs.readFileSync(path.join(backup, 'src', 'a.js'), 'utf8'), 'old a');   // 备份可回滚
  assert.ok(!fs.existsSync(path.join(backup, 'src', 'b.js')));                        // 新建文件没有备份
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyPatchFromStaging：sha 校验失败 → 回滚到原状态，一个字节都不留', async () => {
  const tmp = mkTmp();
  const appDir = path.join(tmp, 'app');
  const staging = path.join(tmp, 'staging');
  const backup = path.join(tmp, 'backup');
  write(path.join(appDir, 'src', 'a.js'), 'old a');
  fs.mkdirSync(staging, { recursive: true });
  buildPatchStaging(staging, { files: { 'src/a.js': 'new a', 'src/b.js': 'new b' }, wrongSha: true });
  await assert.rejects(() => applyPatchFromStaging({ staging, appDir, backupDir: backup }));
  assert.equal(fs.readFileSync(path.join(appDir, 'src', 'a.js'), 'utf8'), 'old a');
  assert.ok(!fs.existsSync(path.join(appDir, 'src', 'b.js')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyPatchFromStaging：deletions 里的文件被移进备份（等价删除）', async () => {
  const tmp = mkTmp();
  const appDir = path.join(tmp, 'app');
  const staging = path.join(tmp, 'staging');
  const backup = path.join(tmp, 'backup');
  write(path.join(appDir, 'plugins', 'old-plugin', 'index.js'), 'old');
  fs.mkdirSync(staging, { recursive: true });
  buildPatchStaging(staging, { files: { 'src/app.js': 'x' }, deletions: ['plugins/old-plugin/index.js'] });
  await applyPatchFromStaging({ staging, appDir, backupDir: backup });
  assert.ok(!fs.existsSync(path.join(appDir, 'plugins', 'old-plugin', 'index.js')));
  assert.equal(fs.readFileSync(path.join(backup, 'plugins', 'old-plugin', 'index.js'), 'utf8'), 'old');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── full 应用（挪走旧条目 + 用户数据兜底）───────────────────────────────────
test('applyFullFromStaging：旧条目挪进 .update-old，staging 条目就位，data/ 用户数据合并回来', () => {
  const tmp = mkTmp();
  const rootDir = tmp;
  const staging = path.join(tmp, '.update-staging');
  const backup = path.join(tmp, '.update-old');
  write(path.join(rootDir, 'QQ Agent.exe'), 'old exe');
  write(path.join(rootDir, 'resources', 'app', 'src', 'app.js'), 'old code');
  write(path.join(rootDir, 'resources', 'app', 'data', 'config.json'), '{"user":true}');
  buildFullStaging(staging);
  const summary = applyFullFromStaging({ staging, rootDir, backupDir: backup });
  assert.equal(summary.moved, 2);
  assert.equal(fs.readFileSync(path.join(rootDir, 'QQ Agent.exe'), 'utf8'), 'new exe');
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'src', 'app.js'), 'utf8'), 'new code');
  // 用户数据：旧安装里有 data/、新包没有 → 必须合并回来。
  // （数据真实位置是 resources/app/data，因为 config.ROOT=resources/app。）
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'data', 'config.json'), 'utf8'), '{"user":true}');
  // 旧版本进了 .update-old
  assert.equal(fs.readFileSync(path.join(backup, 'QQ Agent.exe'), 'utf8'), 'old exe');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyFullFromStaging：回归——新包自带 data/ 也绝不覆盖用户同名数据（2026-11-12 修复）', () => {
  // 复现真实打包场景：release 全量包里混进了 resources/app/data（release-preflight
  // 之前没排除它），里面是作者本机的默认/空数据。整包替换时若不做保护，
  // 用户自己的 config.json / 会话 / 记忆会被包里的同名文件整体覆盖掉。
  const tmp = mkTmp();
  const rootDir = tmp;
  const staging = path.join(tmp, '.update-staging');
  const backup = path.join(tmp, '.update-old');
  // 用户现有数据
  write(path.join(rootDir, 'resources', 'app', 'data', 'config.json'), '{"user":true,"k":"user-value"}');
  write(path.join(rootDir, 'resources', 'app', 'data', 'sessions', 'mine.json'), 'user session');
  // 新包（自带 data，且含一份"默认"）
  buildFullStaging(staging);
  write(path.join(staging, 'resources', 'app', 'data', 'config.json'), '{"pkg":true}');       // 应被剔除
  write(path.join(staging, 'resources', 'app', 'data', 'pkg-only.json'), 'pkg default');        // 应被剔除
  fs.mkdirSync(path.join(staging, 'resources', 'app', 'node_modules', 'ws'), { recursive: true }); // 凑个其它目录
  const summary = applyFullFromStaging({ staging, rootDir, backupDir: backup });
  assert.equal(summary.moved, 2);
  // 程序文件照常更新
  assert.equal(fs.readFileSync(path.join(rootDir, 'QQ Agent.exe'), 'utf8'), 'new exe');
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'src', 'app.js'), 'utf8'), 'new code');
  // 用户数据完整保留、不被包覆盖
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'data', 'config.json'), 'utf8'), '{"user":true,"k":"user-value"}');
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'data', 'sessions', 'mine.json'), 'utf8'), 'user session');
  // 包自带 data 被剔除（不污染用户数据）
  assert.ok(!fs.existsSync(path.join(rootDir, 'resources', 'app', 'data', 'pkg-only.json')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rollbackFull：把 .update-old 里的旧条目挪回安装根（替换失败时的保命路径）', () => {
  const tmp = mkTmp();
  const backup = path.join(tmp, '.update-old');
  write(path.join(backup, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, 'QQ Agent.exe'), 'broken new exe');
  // 返回形状在 2026-11-12 改成 { restored, removed, complete }（A2 需要区分完全/部分回滚）
  const rb = rollbackFull({ rootDir: tmp, backupDir: backup });
  assert.equal(rb.restored, 1);
  assert.equal(rb.removed, 0);
  assert.equal(rb.complete, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'QQ Agent.exe'), 'utf8'), 'old exe');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rollbackFull：新增条目（backedUp:false）必须被删掉，否则新旧混装（A2）', () => {
  const tmp = mkTmp();
  const backup = path.join(tmp, '.update-old');
  write(path.join(backup, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, 'QQ Agent.exe'), 'new exe');
  write(path.join(tmp, 'locales', 'zh-CN.pak'), '新版本独有的目录');
  const rb = rollbackFull({
    rootDir: tmp,
    backupDir: backup,
    moved: [{ name: 'QQ Agent.exe', backedUp: true }, { name: 'locales', backedUp: false }]
  });
  assert.equal(rb.restored, 1);
  assert.equal(rb.removed, 1);
  assert.equal(rb.complete, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'QQ Agent.exe'), 'utf8'), 'old exe');
  assert.ok(!fs.existsSync(path.join(tmp, 'locales')), '新版本独有的条目必须被回收');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rollbackFull：备份目录读不出来时 complete=false（不能当成功处理）', () => {
  const tmp = mkTmp();
  const rb = rollbackFull({ rootDir: tmp, backupDir: path.join(tmp, 'no-such-dir') });
  assert.equal(rb.restored, 0);
  assert.equal(rb.complete, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyFullFromStaging：包结构不完整 → 抛错且不动现有文件（B8）', () => {
  const tmp = mkTmp();
  const rootDir = tmp;
  const staging = path.join(tmp, '.update-staging');
  const backup = path.join(tmp, '.update-old');
  write(path.join(rootDir, 'QQ Agent.exe'), 'old exe');
  write(path.join(rootDir, 'resources', 'app', 'src', 'app.js'), 'old code');
  write(path.join(backup, 'QQ Agent.exe'), '上一次更新的备份');
  // 典型事故形态：压缩工具多套了一层目录 → 根下没有 exe
  write(path.join(staging, 'QQ Agent', 'QQ Agent.exe'), 'new exe');
  assert.throws(() => applyFullFromStaging({ staging, rootDir, backupDir: backup }), /结构不完整/);
  assert.equal(fs.readFileSync(path.join(rootDir, 'QQ Agent.exe'), 'utf8'), 'old exe');
  assert.equal(fs.readFileSync(path.join(rootDir, 'resources', 'app', 'src', 'app.js'), 'utf8'), 'old code');
  // 上一次的备份也不能被提前清掉（校验必须发生在 rmRf(backupDir) 之前）
  assert.equal(fs.readFileSync(path.join(backup, 'QQ Agent.exe'), 'utf8'), '上一次更新的备份');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyFullFromStaging：package.json 声明的 main 不在包里 → 抛错（B8）', () => {
  const tmp = mkTmp();
  const rootDir = tmp;
  const staging = path.join(tmp, '.update-staging');
  const backup = path.join(tmp, '.update-old');
  write(path.join(rootDir, 'QQ Agent.exe'), 'old exe');
  buildFullStaging(staging, { main: 'electron/not-there.js' });
  assert.throws(() => applyFullFromStaging({ staging, rootDir, backupDir: backup }), /入口/);
  assert.equal(fs.readFileSync(path.join(rootDir, 'QQ Agent.exe'), 'utf8'), 'old exe');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── pending 标记 ────────────────────────────────────────────────────────────
test('readPending：合法标记读回、坏 JSON / 缺字段返回 null', () => {
  const tmp = mkTmp();
  assert.equal(readPending(tmp), null);
  fs.writeFileSync(path.join(tmp, UPDATE_ARTIFACTS.pending), 'not json');
  assert.equal(readPending(tmp), null);
  writePendingForTest(tmp, { type: 'full', staging: path.join(tmp, '.update-staging'), rootDir: tmp, appDir: tmp });
  const pending = readPending(tmp);
  assert.equal(pending.type, 'full');
  fs.writeFileSync(path.join(tmp, UPDATE_ARTIFACTS.pending), JSON.stringify({ type: 'bogus', staging: 'x', rootDir: 'y', appDir: 'z' }));
  assert.equal(readPending(tmp), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── janitor ─────────────────────────────────────────────────────────────────
test('runJanitor：读掉结果文件、清理 .update-old；新鲜 pending 不动、超龄 pending 连 staging 一起清', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.result), JSON.stringify({ ok: true, type: 'patch', version: '0.4.9.4', message: '补丁已应用（2 个文件）' }));
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  const summary = runJanitor(tmp, () => {});
  assert.equal(summary.result.ok, true);
  assert.equal(summary.cleanedOld, true);
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.result)));
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.old)));

  // 新鲜 pending：留着（助手可能还在等应用退出）
  write(path.join(tmp, UPDATE_ARTIFACTS.pending), JSON.stringify({ type: 'full', staging: 'x', rootDir: tmp, appDir: tmp }));
  assert.ok(!runJanitor(tmp, () => {}).clearedStalePending);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)));

  // 超龄 pending：标记与 staging 一起清（助手挂了的残留，否则永远挡住新更新）
  const pendingFile = path.join(tmp, UPDATE_ARTIFACTS.pending);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(pendingFile, old, old);
  assert.ok(runJanitor(tmp, () => {}).clearedStalePending);
  assert.ok(!fs.existsSync(pendingFile));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runJanitor：上次更新失败（ok:false）→ **保留** .update-old，不许无条件删（A1）', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, UPDATE_ARTIFACTS.result), JSON.stringify({ ok: false, type: 'full', error: '替换失败', rolledBack: 1 }));
  const logs = [];
  const summary = runJanitor(tmp, (m) => logs.push(String(m)));
  assert.equal(summary.cleanedOld, false);
  assert.equal(summary.keptOld, true);
  assert.equal(fs.readFileSync(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'utf8'), 'old exe');
  assert.ok(logs.some((l) => l.includes('保留')), '必须明确写出"保留备份待人工处理"');
  // 结果文件仍要消费掉，否则每次启动都重复报警
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.result)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runJanitor：没有结果文件 / 坏结果文件时同样不删 .update-old（读不出 ≠ 成功）', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  assert.equal(runJanitor(tmp, () => {}).keptOld, true);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.old)));
  // 坏 JSON 也不能被当成"上次成功"
  write(path.join(tmp, UPDATE_ARTIFACTS.result), '{坏掉的结果文件');
  assert.equal(runJanitor(tmp, () => {}).keptOld, true);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.old)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runJanitor：rolledBackPartial 的结果按"未成功"处理，备份保留（A2+A1 联动）', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, UPDATE_ARTIFACTS.result), JSON.stringify({ ok: false, rolledBackPartial: true, error: '部分回滚' }));
  assert.equal(runJanitor(tmp, () => {}).keptOld, true);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.old)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 自更新服务：坏标记自愈 / 取消 / 校验和（2026-11-12 回归）────────────────
/** 造一个自更新服务实例；网络一律指向黑洞端口（127.0.0.1:9 → 立即 ECONNREFUSED）。 */
function makeService(dir) {
  return createSelfUpdateService({
    appDir: dir,                      // 无 QQ Agent.exe → 开发布局（rootDir = appDir）
    log: () => {},
    getConfig: () => ({
      update: { releaseApi: 'http://127.0.0.1:9/api', checkUrl: 'http://127.0.0.1:9/version.json' }
    }),
    localVersion: () => '0.4.9.3',
    compareSemver: () => 0
  });
}

test('apply：坏 pending 会被自愈清掉，不再永久挡住更新（B4）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  fs.writeFileSync(path.join(tmp, UPDATE_ARTIFACTS.pending), 'not json at all');
  const r = await svc.apply();
  assert.equal(r.ok, true, '坏标记不该让 apply 被拒绝');
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '残留标记必须被清掉');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('apply：合法 pending 仍然拒绝（防重复更新），且不会被清掉（B4）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  writePendingForTest(tmp, {
    type: 'patch', staging: path.join(tmp, UPDATE_ARTIFACTS.staging), rootDir: tmp, appDir: tmp
  });
  const r = await svc.apply();
  assert.equal(r.ok, false);
  assert.match(r.error, /已有待应用的更新/);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '合法标记不能被清');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('isValidPending 与 readPending 口径一致（两个进程对"坏标记"的判断必须相同）', () => {
  const tmp = mkTmp();
  const cases = [
    ['{}', false],
    [JSON.stringify({ type: 'bogus', staging: 'x', rootDir: 'y', appDir: 'z' }), false],
    [JSON.stringify({ type: 'full', staging: 'x', rootDir: 'y' }), false],
    [JSON.stringify({ type: 'full', staging: 'x', rootDir: 'y', appDir: 'z' }), true]
  ];
  for (const [raw, expected] of cases) {
    fs.writeFileSync(path.join(tmp, UPDATE_ARTIFACTS.pending), raw);
    const parsed = JSON.parse(raw);
    assert.equal(isValidPending(parsed), expected, `isValidPending(${raw})`);
    assert.equal(Boolean(readPending(tmp)), expected, `readPending(${raw}) 口径应与 isValidPending 一致`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cancel()：清掉 staging / 下载缓存 / pending 三样东西，job 回 idle（B7）', () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  write(path.join(tmp, UPDATE_ARTIFACTS.staging, 'manifest.json'), '{}');
  write(path.join(tmp, UPDATE_ARTIFACTS.download, 'patch.zip'), 'zip bytes');
  writePendingForTest(tmp, {
    type: 'patch', staging: path.join(tmp, UPDATE_ARTIFACTS.staging), rootDir: tmp, appDir: tmp
  });
  const r = svc.cancel();
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.staging)), '.update-staging 必须清掉');
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.download)), '.update-download 必须清掉');
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), 'pending 标记必须清掉');
  assert.equal(svc.status().state, 'idle');
  // 解构调用不能崩（E4：status() 里不能写 this.capability()）
  const { status, capability } = svc;
  assert.equal(status().ok, true);
  assert.equal(capability().available, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('verifyZip：digest 与 .sha256 都没有 → 抛错，不再"告警放行"（B5）', async () => {
  await assert.rejects(
    () => verifyZip({
      asset: { name: 'patch-0.4.9.4.zip', url: 'http://127.0.0.1:9/patch.zip', digest: null },
      localSha: 'a'.repeat(64),
      picked: { shaSiblings: new Set() }
    }),
    /未提供可用校验和/
  );
});

test('verifyZip：digest 一致放行，不一致抛错', async () => {
  const sha = sha256Buf(Buffer.from('zip content'));
  await verifyZip({
    asset: { name: 'a.zip', url: 'http://127.0.0.1:9/a.zip', digest: `sha256:${sha}` },
    localSha: sha,
    picked: { shaSiblings: new Set() }
  });
  await assert.rejects(
    () => verifyZip({
      asset: { name: 'a.zip', url: 'http://127.0.0.1:9/a.zip', digest: `sha256:${sha}` },
      localSha: 'b'.repeat(64),
      picked: { shaSiblings: new Set() }
    }),
    /校验和不匹配/
  );
});


// ── 双助手竞态（P2-1，2026-11-12 QA 回归）────────────────────────────────────
// 病灶：cancel() 删掉 pending 后 apply() 认为"没有待应用更新"，又拉起一个助手；
// 两个助手共用 .update-staging → patch 把已打补丁的文件当原件备份（原版永久丢失），
// full 把后一个的 ok:false 覆盖前一个的 ok:true（成功记成失败）。
// 治法：与 pending 独立的助手锁 .update-helper.lock（pid 活着才算锁）。
/** 起一个真子进程当"活着的助手"（伪造 isPidAlive 不可信，真进程才有说服力）。 */
async function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return { pid: child.pid, kill: () => { try { child.kill(); } catch { /* 已退出 */ } } };
}

test('isPidAlive：自己活着、不存在的 pid 为 false、非法输入不抛', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive('abc'), false);
  assert.equal(isPidAlive(null), false);
});

test('assertNoLiveHelper：存活助手 → 抛错；陈旧锁 → 返回 pid 不抛（P2-1）', async () => {
  const tmp = mkTmp();
  assert.equal(readHelperPid(tmp), null, '没有锁文件时当作无锁');
  assert.equal(assertNoLiveHelper(tmp), null);
  writeHelperLock(tmp, 999999999);                      // 陈旧锁：pid 早就不在了
  assert.equal(assertNoLiveHelper(tmp), 999999999, '陈旧锁不该拦住新更新');
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    assert.throws(() => assertNoLiveHelper(tmp), /已有更新助手在等待应用退出/);
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('apply：锁里助手存活 → 直接拒绝且不写 pending（P2-1 主诉求）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    const r = await svc.apply();
    assert.equal(r.ok, false, '有存活助手时绝不能启动第二次更新');
    assert.match(r.error, /已有更新助手在等待应用退出/);
    assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '被拒绝时绝不能留 pending');
    assert.equal(svc.status().state, 'idle', '被拒绝时状态不应进入 preparing');
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cancel()：助手存活 → 拒绝取消且不动残留；助手已死 → 清理并放锁（P2-1）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  write(path.join(tmp, UPDATE_ARTIFACTS.staging, 'manifest.json'), '{}');
  writePendingForTest(tmp, {
    type: 'patch', staging: path.join(tmp, UPDATE_ARTIFACTS.staging), rootDir: tmp, appDir: tmp
  });
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    const r = svc.cancel();
    assert.equal(r.ok, false, '助手活着时取消必须被拒绝（否则会放进第二个助手）');
    assert.match(r.error, /无法取消/);
    assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.staging)), '拒绝取消时不许删 staging');
    assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '拒绝取消时不许删 pending');
    assert.ok(fs.existsSync(helperLockPath(tmp)), '别人的锁不许删');
  } finally { live.kill(); }
  // 助手已死（陈旧锁）→ 允许取消，并把陈旧锁一起清掉
  writeHelperLock(tmp, 999999999);
  const r2 = svc.cancel();
  assert.equal(r2.ok, true);
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.staging)));
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)));
  assert.ok(!fs.existsSync(helperLockPath(tmp)), '陈旧锁必须被清掉，否则留个不存在的进程吓人');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runAsHelper：正常出口会放掉自己的锁（P2-1）', async () => {
  const tmp = mkTmp();
  writeHelperLock(tmp, process.pid);     // 锁里是"自己"（这条助手进程）
  const code = await runAsHelper(['--pid', '0', '--root', tmp], { pendingWaitMs: 60 });
  assert.equal(code, 1);                 // 没有 pending → 退出码 1
  assert.ok(!fs.existsSync(helperLockPath(tmp)), '退出时必须放锁，否则应用永远被判"助手还在"');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('runAsHelper：锁里是另一个存活助手 → 立刻退出且不删别人的锁（P2-1 纵深防御）', async () => {
  const tmp = mkTmp();
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    const code = await runAsHelper(['--pid', '0', '--root', tmp], { pendingWaitMs: 60 });
    assert.equal(code, 1, '发现已有助手时必须退出，不能重复替换');
    assert.ok(fs.existsSync(helperLockPath(tmp)), '不能动另一个助手的锁');
    assert.equal(readHelperPid(tmp), live.pid);
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('clearHelperLock：onlyPid 不匹配时不动别人的锁', () => {
  const tmp = mkTmp();
  writeHelperLock(tmp, process.pid);
  assert.equal(clearHelperLock(tmp, 12345), false);
  assert.ok(fs.existsSync(helperLockPath(tmp)));
  assert.equal(clearHelperLock(tmp, process.pid), true);
  assert.ok(!fs.existsSync(helperLockPath(tmp)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('janitor：陈旧助手锁会被清掉，活的助手锁绝不动（P2-1 配套）', async () => {
  const tmp = mkTmp();
  writeHelperLock(tmp, 999999999);
  assert.equal(runJanitor(tmp, () => {}).clearedHelperLock, true);
  assert.ok(!fs.existsSync(helperLockPath(tmp)));
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    assert.equal(runJanitor(tmp, () => {}).clearedHelperLock, false);
    assert.ok(fs.existsSync(helperLockPath(tmp)), '活着的助手锁不能被 janitor 删');
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P1：PID 复用导致更新永久锁死（2026-11-12 QA 第二轮实测）────────────────────
// 事故形态：助手被强杀 → 锁残留 → Windows 把那个 pid 复用给 explorer.exe 或任何
// 活着的进程 → 只看 kill(pid,0) 就永远"活着" → apply/cancel 双双永久拒绝，
// 报错还误导用户"请先退出应用"，而退出根本没用。
// 治法：pid 存活 + 心跳新鲜 + 镜像名一致，三条独立证据。
test('isHelperLive：无锁 / pid 死 / 心跳陈腐 / 镜像不符 / 探测不可用，五种情形逐条判（P1）', async () => {
  const tmp = mkTmp();
  assert.equal(isHelperLive(tmp), false, '没有锁 = 没有助手');

  // ① pid 死（正常陈旧锁）：false
  writeHelperLock(tmp, 999999999);
  assert.equal(isHelperLive(tmp), false);

  // ② pid 活着但心跳陈腐（QA 实测：mtime 改成 30 天前照样拒绝）→ 必须 false
  writeHelperLock(tmp, process.pid, { at: Date.now() - (HELPER_LOCK_STALE_MS + 60_000) });
  assert.equal(isHelperLive(tmp), false, `at 超过 ${HELPER_LOCK_STALE_MS}ms 必须判为不在`);

  // ③ at 新鲜 + pid 活 + 镜像不符 → false（PID 被无关程序复用）
  writeHelperLock(tmp, process.pid, { image: 'explorer.exe', at: Date.now() });
  const restoreMismatch = __setHelperImageProbeForTest(() => 'node.exe');
  try {
    assert.equal(isHelperLive(tmp), false, '查得到真实镜像且对不上 → 不是我们的助手');
  } finally { restoreMismatch(); }

  // ④ 镜像**查不到**（tasklist 失败/超时/非 Windows）→ 跳过这一条，不误判 stale
  writeHelperLock(tmp, process.pid, { image: 'explorer.exe', at: Date.now() });
  const restoreNull = __setHelperImageProbeForTest(() => null);
  try {
    assert.equal(isHelperLive(tmp), true, '探测不可用时只能靠 pid+心跳，不能因探测失败就判死');
  } finally { restoreNull(); }

  // ⑤ 全部匹配 → true（真起一个 node 子进程，镜像名与锁里的默认值一致）
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);
    assert.equal(isHelperLive(tmp), true);
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('PID 复用回归：镜像不符时 apply() 必须放行（这条是防呆线）（P1）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  // 锁里填一个**真实存活但不是助手**的 pid（用自己最省事），镜像名写成 explorer.exe
  writeHelperLock(tmp, process.pid, { image: 'explorer.exe', at: Date.now() });
  const restore = __setHelperImageProbeForTest(() => 'node.exe');   // 真实镜像是 node.exe
  try {
    const r = await svc.apply();
    assert.equal(r.ok, true, 'pid 被别的程序复用（镜像不符）时必须放行，否则更新永久点不动');
    assert.equal(readHelperPid(tmp), process.pid, '放行不等于删锁，陈旧锁交给 spawnHelper 覆盖');
  } finally { restore(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('PID 复用回归：心跳陈腐（30 天前）时 apply() 必须放行（P1）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  writeHelperLock(tmp, process.pid, { at: Date.now() - 30 * 24 * 60 * 60 * 1000 });
  const r = await svc.apply();
  assert.equal(r.ok, true, '心跳 30 天没更新 = 助手早不在了，必须放行');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('isHelperLive 三条真值时 cancel() 仍拒绝（不要把"能自愈"写成"永远放行"）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  const live = await liveChild();
  try {
    writeHelperLock(tmp, live.pid);          // pid 活 + at 新鲜 + 镜像匹配
    const r = svc.cancel();
    assert.equal(r.ok, false, '真助手在等退出时仍必须拒绝取消');
    assert.match(r.error, /无法取消/);
    assert.match(r.error, /请先退出应用/, '文案要给出下一步，不能只说"无法取消"');
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P2：pending 残骸（助手被强杀后 pending 残留，UI 又没有取消入口）─────────────
test('pending 残骸：helperPid 已死 → apply 清掉残骸并继续（P2）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  writePendingForTest(tmp, {
    type: 'patch',
    staging: path.join(tmp, UPDATE_ARTIFACTS.staging),
    rootDir: tmp,
    appDir: tmp,
    helperPid: 999999999                 // 助手早被 taskkill 了
  });
  writeHelperLock(tmp, 999999999);       // 锁也是死的
  const r = await svc.apply();
  assert.equal(r.ok, true, '助手已死的 pending 是残骸，不能挡住新更新');
  assert.ok(!fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '残骸必须被清掉');
  assert.ok(!fs.existsSync(helperLockPath(tmp)), '顺手再清一次陈旧锁');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pending 残骸：helperPid 指向活助手 → 仍然拒绝（不能把正常情况当残骸清掉）（P2）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  const live = await liveChild();
  try {
    writeBeforeApply(tmp, live.pid);
    const r = await svc.apply();
    assert.equal(r.ok, false, '助手活着时 pending 是有效标记，不能清');
    assert.match(r.error, /更新助手正在等待应用退出/);
    assert.match(r.error, /检查更新/, '文案要给出自救入口（UI 里没有取消按钮）');
    assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)), '有效标记绝不能被清');
  } finally { live.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });

  function writeBeforeApply(dir, pid) {
    writePendingForTest(dir, {
      type: 'patch',
      staging: path.join(dir, UPDATE_ARTIFACTS.staging),
      rootDir: dir,
      appDir: dir,
      helperPid: pid
    });
    writeHelperLock(dir, pid);           // 活助手 + 新心跳 + 镜像匹配
  }
});

test('pending 残骸：没有 helperPid 的老标记保持旧行为（拒绝，不当残骸清）（P2）', async () => {
  const tmp = mkTmp();
  const svc = makeService(tmp);
  writePendingForTest(tmp, {
    type: 'patch', staging: path.join(tmp, UPDATE_ARTIFACTS.staging), rootDir: tmp, appDir: tmp
  });
  const r = await svc.apply();
  assert.equal(r.ok, false, '老标记无法判定残骸 → 保守拒绝');
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.pending)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 心跳：锁的 at 必须真的被推进（否则 isHelperLive 又只剩 pid 一条腿）──────────
test('助手心跳：锁 at 会被定时推进，退出后停心跳并放锁（P1 配套）', async () => {
  const tmp = mkTmp();
  writeHelperLock(tmp, process.pid);
  const at0 = readHelperLock(tmp).at;
  const running = runAsHelper(['--pid', '0', '--root', tmp], { pendingWaitMs: 700, heartbeatMs: 60 });
  await new Promise((r) => setTimeout(r, 320));            // ≥2 个心跳周期
  const at1 = readHelperLock(tmp)?.at ?? 0;
  assert.ok(at1 > at0, `心跳必须推进锁里的 at（${at0} → ${at1}）`);
  await running;
  assert.ok(!fs.existsSync(helperLockPath(tmp)), '退出后必须放锁');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('refreshHelperLock：只刷自己的锁，pid 不符不动别人的（P1 配套）', () => {
  const tmp = mkTmp();
  writeHelperLock(tmp, process.pid + 1, { at: 1 });
  assert.equal(refreshHelperLock(tmp, process.pid), false, '锁不是自己的 → 不刷');
  assert.equal(readHelperLock(tmp).at, 1, '别人的 at 不能被推进');
  writeHelperLock(tmp, process.pid, { at: 1 });
  assert.equal(refreshHelperLock(tmp, process.pid), true);
  assert.ok(readHelperLock(tmp).at > 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── P3 收尾（2026-11-12 QA 回归）────────────────────────────────────────────
test('parseDigestSha256 / verifyZip：SHA256: 大写前缀与裸 hex 都能通过（P3-4）', async () => {
  const sha = sha256Buf(Buffer.from('zip payload'));
  // 解析层：三种合法形态 + 认不出的返回 null
  assert.equal(parseDigestSha256(`sha256:${sha}`), sha);
  assert.equal(parseDigestSha256(`SHA256:${sha.toUpperCase()}`), sha);
  assert.equal(parseDigestSha256(sha.toUpperCase()), sha);
  assert.equal(parseDigestSha256(''), null);
  assert.equal(parseDigestSha256('md5:abc'), null);
  assert.equal(parseDigestSha256(null), null);
  // 校验层：大写前缀的合法自建源不能被当成"没有校验和"永久拒绝
  await verifyZip({
    asset: { name: 'a.zip', url: 'http://127.0.0.1:9/a.zip', digest: `SHA256:${sha.toUpperCase()}` },
    localSha: sha,
    picked: { shaSiblings: new Set() }
  });
  // 裸 hex 也要认；localSha 大写同样不影响判定（比较前统一小写）
  await verifyZip({
    asset: { name: 'a.zip', url: 'http://127.0.0.1:9/a.zip', digest: sha.toUpperCase() },
    localSha: sha.toUpperCase(),
    picked: { shaSiblings: new Set() }
  });
  await assert.rejects(
    () => verifyZip({
      asset: { name: 'a.zip', url: 'http://127.0.0.1:9/a.zip', digest: `SHA256:${sha.toUpperCase()}` },
      localSha: 'b'.repeat(64),
      picked: { shaSiblings: new Set() }
    }),
    /校验和不匹配/
  );
});

test('isRolledBackPartial：true / "true" / 1 / "1" 都算部分回滚（P3-3）', () => {
  for (const v of [true, 'true', 'TRUE', ' true ', 1, '1']) {
    assert.equal(isRolledBackPartial(v), true, `${JSON.stringify(v)} 应判为部分回滚`);
  }
  for (const v of [false, 'false', 0, '0', '', null, undefined, {}, []]) {
    assert.equal(isRolledBackPartial(v), false, `${JSON.stringify(v)} 不应判为部分回滚`);
  }
});

test('janitor：rolledBackPartial 写成字符串 "true" 也按失败处理、不删备份（P3-3）', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, UPDATE_ARTIFACTS.result), JSON.stringify({ ok: true, type: 'full', rolledBackPartial: 'true' }));
  const summary = runJanitor(tmp, () => {});
  assert.equal(summary.keptOld, true, '字符串 "true" 绝不能当成功');
  assert.equal(summary.cleanedOld, false);
  assert.ok(fs.existsSync(path.join(tmp, UPDATE_ARTIFACTS.old)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('janitor 日志不自相矛盾：ok:true + rolledBackPartial 只打「保留备份」（P3-2）', () => {
  const tmp = mkTmp();
  write(path.join(tmp, UPDATE_ARTIFACTS.old, 'QQ Agent.exe'), 'old exe');
  write(path.join(tmp, UPDATE_ARTIFACTS.result), JSON.stringify({ ok: true, type: 'full', rolledBackPartial: true }));
  const logs = [];
  runJanitor(tmp, (m) => logs.push(String(m)));
  assert.ok(logs.some((l) => l.includes('保留')), '必须先打「保留 .update-old 待人工处理」');
  assert.ok(!logs.some((l) => l.includes('上次更新成功')), '不能同时说"上次更新成功"（自相矛盾）');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rollbackFull：本来就不存在的"新增条目"不计入 removed（P3-3 统计口径）', () => {
  const tmp = mkTmp();
  const backupDir = path.join(tmp, '.update-old');
  write(path.join(backupDir, 'QQ Agent.exe'), 'old exe');
  const rb = rollbackFull({
    rootDir: tmp,
    backupDir,
    moved: [{ name: 'QQ Agent.exe', backedUp: true }, { name: 'locales', backedUp: false }]
  });
  assert.equal(rb.restored, 1);
  assert.equal(rb.removed, 0, 'locales 本来就不存在 → 不该算"回收成功"');
  assert.equal(rb.complete, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});


// ── 等待进程退出 ────────────────────────────────────────────────────────────
test('waitForPidExit：已死进程立即返回 true；当前进程超时返回 false', async () => {
  assert.equal(await waitForPidExit(999999999, 300), true);          // 几乎不可能存在的 pid
  assert.equal(await waitForPidExit(process.pid, 300), false);       // 自己活着 → 超时
});

// ── 杂项 ────────────────────────────────────────────────────────────────────
test('sha256File 与 parseSha256Text：流式哈希一致；.sha256 文本两种格式都认', async () => {
  const tmp = mkTmp();
  const file = path.join(tmp, 'x.zip');
  fs.writeFileSync(file, 'hello patch');
  const hex = sha256Buf(Buffer.from('hello patch'));
  assert.equal(await sha256File(file), hex);
  assert.equal(parseSha256Text(`${hex}  patch.zip`), hex);
  assert.equal(parseSha256Text(hex.toUpperCase()), hex.toLowerCase());
  assert.equal(parseSha256Text('no hash here'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});
