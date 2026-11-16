/**
 * 控制台令牌（P1，2026-11-16）。
 *
 * 旧行为 `if (!token) return true` 让安装后默认无 token 的实例对本机任意进程
 * 全开写接口。现在首次取用必须自动生成随机令牌并落盘，空 token 不再恒放行。
 * 每个用例都用独立子进程：config.js 的 DATA_DIR 在模块加载时按环境变量算死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_URL = pathToFileURL(path.join(APP, 'src', 'config.js')).href;

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-token-'));
}

function runIn(dir, body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: APP,
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 30000
  });
  if (r.status !== 0) throw new Error(r.stderr || `子进程退出码 ${r.status}`);
  return JSON.parse((r.stdout || '').trim());
}

test('首次取用自动生成随机令牌并落盘，后续调用稳定', () => {
  const dir = makeDataDir();
  try {
    const out = runIn(dir, `
      import { getConsoleToken } from ${JSON.stringify(CONFIG_URL)};
      const a = getConsoleToken();
      const b = getConsoleToken();
      console.log(JSON.stringify({ a, b }));
    `);
    assert.ok(out.a && out.a.length >= 32, '必须生成足够长的随机令牌');
    assert.equal(out.b, out.a, '同一进程内重复取用应返回同一令牌');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.server.token, out.a, '令牌必须写进 config.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重新生成后旧令牌立即失效，新令牌落盘', () => {
  const dir = makeDataDir();
  try {
    const out = runIn(dir, `
      import { getConsoleToken, rotateConsoleToken } from ${JSON.stringify(CONFIG_URL)};
      const before = getConsoleToken();
      const next = rotateConsoleToken();
      const after = getConsoleToken();
      console.log(JSON.stringify({ before, next, after }));
    `);
    assert.ok(out.next && out.next !== out.before, '轮换必须换一枚新令牌');
    assert.equal(out.after, out.next, '轮换后本进程立刻生效');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.server.token, out.next, '新令牌必须落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('用户已配置的 token 原样保留，不被自动生成覆盖', () => {
  const dir = makeDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { token: 'my-own-token' } }));
    const out = runIn(dir, `
      import { getConsoleToken } from ${JSON.stringify(CONFIG_URL)};
      console.log(JSON.stringify({ token: getConsoleToken() }));
    `);
    assert.equal(out.token, 'my-own-token');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.server.token, 'my-own-token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
