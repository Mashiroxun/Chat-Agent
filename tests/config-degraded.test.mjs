/**
 * 配置读取失败时的降级行为（2026-10-28 审计）。
 *
 * 要盯死的一件事：**读不出来 ≠ 文件坏了**。
 * 旧实现把两者走同一条路 —— 改名备份 + 回落默认值，随后 5 分钟一次的社区同步
 * 无条件 updateConfig 落盘，于是磁盘上那份完好的配置被出厂默认值覆盖，
 * 用户的 API Key / 群白名单 / 人设全没。触发条件只是"启动瞬间文件被占用"。
 *
 * 现在三档分开，本测试逐一钉住：
 *   ENOENT          → 正常（首次启动 / 刚重置数据），允许写盘
 *   JSON 语法错误   → 改名备份 + 默认值，允许写盘（原文件已保全）
 *   其它 IO 错误    → 默认值跑起来，但**禁止本次落盘**，原文件原样不动
 *
 * 每个用例都必须在**独立子进程**里跑：config.js 的 DATA_DIR 是模块加载时按
 * QQ_AGENT_DATA_DIR 算死的，同进程换目录不生效。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cfg-'));
  return dir;
}

/** 在独立子进程里跑一段脚本，数据目录指向 dir。 */
function runIn(dir, body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: APP,
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 30000
  });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

test('ENOENT（首次启动）：用默认值，不算降级，允许写盘', () => {
  const dir = makeDataDir();
  const r = runIn(dir, `
    import { loadConfig, getConfigWriteBlock, updateConfig } from ${JSON.stringify(CONFIG_URL)};
    const cfg = loadConfig();
    const block = getConfigWriteBlock();
    updateConfig({ persona: { name: '写入测试' } });
    console.log(JSON.stringify({ block, wrote: true }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.block, null, 'ENOENT 不该被当成降级');
  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'ENOENT 之后必须能正常写盘');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.persona.name, '写入测试');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON 语法损坏：备份改名 + 回落默认 + 仍允许写盘', () => {
  const dir = makeDataDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ "api": { 这不是合法 JSON ');
  const r = runIn(dir, `
    import { loadConfig, getConfigWriteBlock } from ${JSON.stringify(CONFIG_URL)};
    loadConfig();
    console.log(JSON.stringify({ block: getConfigWriteBlock() }));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).block, null, '语法错误属于"文件真的坏了"，不禁写');
  const files = fs.readdirSync(dir);
  assert.ok(
    files.some((f) => f.startsWith('config.json.corrupt-')),
    `原文件应被改名备份，实际目录：${files.join(', ')}`
  );
  assert.ok(!files.includes('config.json'), '坏文件已改名，不能留在原位被后续写盘覆盖前丢失');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IO 错误（config.json 变成一个目录，读会抛 EISDIR）：禁止写盘且不动原文件', () => {
  const dir = makeDataDir();
  // 这是最贴近真实故障的模拟：路径存在、但这次读不出来，文件内容其实"完好"
  fs.mkdirSync(path.join(dir, 'config.json'));
  const r = runIn(dir, `
    import { loadConfig, getConfigWriteBlock, updateConfig } from ${JSON.stringify(CONFIG_URL)};
    loadConfig();
    updateConfig({ persona: { name: '不该被写进去' } });
    console.log(JSON.stringify({ block: getConfigWriteBlock() }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const block = JSON.parse(r.stdout).block;
  assert.ok(block && block.code, 'IO 错误必须留下降级记录，且带上 errno 码');

  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.includes('.corrupt-')), 'IO 错误绝不能把"可能完好的文件"改名');
  assert.ok(fs.statSync(path.join(dir, 'config.json')).isDirectory(), '原路径必须原样保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IO 错误解除后（下一次 loadConfig 读成功）降级标记自动清除', () => {
  const dir = makeDataDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ persona: { name: '原有配置' } }));
  const r = runIn(dir, `
    import { loadConfig, getConfigWriteBlock } from ${JSON.stringify(CONFIG_URL)};
    // 第一次：把文件临时换成目录，制造 IO 错误
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json');
    const backup = file + '.keep';
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    loadConfig();
    const blocked = getConfigWriteBlock();
    // 恢复成正常文件，再读一次
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
    loadConfig();
    const cleared = getConfigWriteBlock();
    console.log(JSON.stringify({ blocked: !!blocked, cleared }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.blocked, true, '先要能进入降级');
  assert.equal(out.cleared, null, '重新读成功后必须清除降级标记，否则用户永远存不进配置');
  fs.rmSync(dir, { recursive: true, force: true });
});
