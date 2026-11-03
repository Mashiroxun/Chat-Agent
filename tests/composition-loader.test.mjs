// 启动组合加载器测试（0.4.9.2 新增代码的回归网）
//
// 覆盖：清单校验、路径安全、导出校验、enabled 开关、order 排序、覆盖优先级。
// 全部用临时目录合成，不碰真实 overrides/ 与 data/。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadComposition } from '../src/composition/loader.js';
import { createFactories, defaultFactories, listComponentKeys } from '../src/composition/factories.js';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-'));
  fs.mkdirSync(path.join(root, 'overrides'), { recursive: true });
  return root;
}

function layer(root, dir, manifest, files = {}) {
  const target = path.join(root, 'overrides', dir);
  fs.mkdirSync(target, { recursive: true });
  if (manifest) fs.writeFileSync(path.join(target, 'composition.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  return target;
}

const silent = { log: () => {}, warn: () => {} };
const stub = (name) => `export default function ${name}(deps) { return '${name}'; }\n`;

test('没有 overrides 目录时返回空表，不报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-empty-'));
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.deepEqual(Object.keys(result.components), []);
  assert.equal(result.errors.length, 0);
});

test('正常层能被加载，默认导出可用', async () => {
  const root = sandbox();
  layer(root, '20-ok', {
    version: 1, id: 'ok', order: 20, enabled: true,
    components: { 'core.prompt.system': './impl.mjs' },
  }, { 'impl.mjs': stub('systemPrompt') });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(typeof result.components['core.prompt.system'], 'function');
  assert.equal(result.errors.length, 0);
  assert.equal(result.layers.length, 1);
});

test('具名导出能按 export 字段取到', async () => {
  const root = sandbox();
  layer(root, '20-named', {
    version: 1, id: 'named', order: 20, enabled: true,
    components: { 'llm.complete': { module: './impl.mjs', export: 'complete' } },
  }, { 'impl.mjs': 'export function complete() { return "named"; }\n' });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['llm.complete'](), 'named');
});

test('enabled:false 的层被跳过，但仍出现在 layers 里', async () => {
  const root = sandbox();
  layer(root, '20-off', {
    version: 1, id: 'off', order: 20, enabled: false,
    components: { 'core.send': './impl.mjs' },
  }, { 'impl.mjs': stub('send') });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.deepEqual(Object.keys(result.components), []);
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0].enabled, false);
});

test('不支持的清单版本被拒绝', async () => {
  const root = sandbox();
  layer(root, '20-badver', { version: 2, id: 'badver', order: 20, components: {} });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /清单版本/);
});

test('非法 id 被拒绝', async () => {
  const root = sandbox();
  layer(root, '20-badid', { version: 1, id: '../escape', order: 20, components: {} });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /id 缺失或非法/);
});

test('重复 id 只生效第一个，第二个报错', async () => {
  const root = sandbox();
  layer(root, '20-a', { version: 1, id: 'dup', order: 20, components: { 'core.send': './a.mjs' } }, { 'a.mjs': stub('a') });
  layer(root, '30-b', { version: 1, id: 'dup', order: 30, components: { 'core.send': './b.mjs' } }, { 'b.mjs': stub('b') });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'](), 'a');
  assert.ok(result.errors.some((e) => /id 重复/.test(e.error)));
});

test('目录穿越路径被拒绝', async () => {
  const root = sandbox();
  layer(root, '20-trav', {
    version: 1, id: 'trav', order: 20, enabled: true,
    components: { 'core.send': '../../../etc/passwd.mjs' },
  });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'], undefined);
  assert.match(result.errors[0].error, /路径非法/);
});

test('绝对路径被拒绝', async () => {
  const root = sandbox();
  layer(root, '20-abs', {
    version: 1, id: 'abs', order: 20, enabled: true,
    components: { 'core.send': 'C:/windows/system32/x.mjs' },
  });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'], undefined);
  assert.match(result.errors[0].error, /路径非法/);
});

test('非 .js/.mjs/.cjs 扩展名被拒绝', async () => {
  const root = sandbox();
  layer(root, '20-ext', {
    version: 1, id: 'ext', order: 20, enabled: true,
    components: { 'core.send': './impl.txt' },
  }, { 'impl.txt': 'export default function () {}' });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'], undefined);
  assert.match(result.errors[0].error, /路径非法|\.js/);
});

test('导出不是函数时跳过并报错', async () => {
  const root = sandbox();
  layer(root, '20-notfn', {
    version: 1, id: 'notfn', order: 20, enabled: true,
    components: { 'core.send': './impl.mjs' },
  }, { 'impl.mjs': 'export default { not: "a function" };\n' });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'], undefined);
  assert.match(result.errors[0].error, /不是函数/);
});

test('order 小的先加载，同键后加载的覆盖先加载的', async () => {
  const root = sandbox();
  layer(root, '30-late', { version: 1, id: 'late', order: 30, components: { 'core.send': './l.mjs' } }, { 'l.mjs': stub('late') });
  layer(root, '10-early', { version: 1, id: 'early', order: 10, components: { 'core.send': './e.mjs' } }, { 'e.mjs': stub('early') });

  const result = await loadComposition({ appRoot: root, ...silent });
  // order 30 后加载 → 覆盖 order 10
  assert.equal(result.components['core.send'](), 'late');
  assert.equal(result.layers[0].id, 'early');
  assert.equal(result.layers[1].id, 'late');
});

test('不同键互不覆盖', async () => {
  const root = sandbox();
  layer(root, '20-x', { version: 1, id: 'x', order: 20, components: { 'core.send': './x.mjs' } }, { 'x.mjs': stub('x') });
  layer(root, '30-y', { version: 1, id: 'y', order: 30, components: { 'data.memory': './y.mjs' } }, { 'y.mjs': stub('y') });

  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.components['core.send'](), 'x');
  assert.equal(result.components['data.memory'](), 'y');
});

test('清单不是合法 JSON 时该层被跳过', async () => {
  const root = sandbox();
  layer(root, '20-broken', null, { 'composition.json': '{ not json' });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.layers.length, 0);
  assert.match(result.errors[0].error, /合法 JSON/);
});

test('没有 composition.json 的目录被忽略，不报错', async () => {
  const root = sandbox();
  layer(root, '20-empty', null, { 'readme.txt': 'hi' });
  const result = await loadComposition({ appRoot: root, ...silent });
  assert.equal(result.layers.length, 0);
  assert.equal(result.errors.length, 0);
});

// ── 工厂表 ────────────────────────────────────────────────────

test('默认工厂表包含 8 个组件且键名对齐 0.5', () => {
  const keys = listComponentKeys();
  assert.deepEqual(keys, [
    'core.media', 'core.orchestrator', 'core.send',
    'data.memory', 'data.messages', 'data.reminders', 'data.sessions',
    'transport',
  ]);
  for (const key of keys) assert.equal(typeof defaultFactories[key], 'function', `${key} 应是函数`);
});

test('createFactories 合并覆盖并保留其余默认项', () => {
  const custom = () => ({ custom: true });
  const table = createFactories({ 'core.send': custom });
  assert.equal(table['core.send'], custom);
  assert.equal(table['data.messages'], defaultFactories['data.messages']);
});

test('createFactories 拒绝非函数组件', () => {
  assert.throws(() => createFactories({ 'core.send': 123 }), /必须是函数/);
});

test('createFactories 拒绝非对象参数', () => {
  assert.throws(() => createFactories('nope'), /必须是对象/);
});

test('createFactories 不传参时等于默认表', () => {
  const table = createFactories();
  assert.deepEqual(Object.keys(table).sort(), Object.keys(defaultFactories).sort());
});
