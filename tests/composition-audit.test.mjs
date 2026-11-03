// 层能力审计测试（0.4.9.3）
//
// 验证「层不能悄悄 import 危险模块」这一层确实生效：
// 源码扫描能认出敏感模块，未声明的层被拒绝加载，声明过的正常放行。
//
// 注意定位：这是防误用与显式声明，不是防蓄意攻击（字符串拼接、process.binding 挡不住）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanCapabilities, loadComposition } from '../src/composition/loader.js';

test('识别 child_process（静态 import）', () => {
  const caps = scanCapabilities("import { spawn } from 'node:child_process';");
  assert.ok(caps.has('proc.spawn'));
});

test('识别动态 import', () => {
  const caps = scanCapabilities("const cp = await import('child_process');");
  assert.ok(caps.has('proc.spawn'));
});

test('识别 export ... from', () => {
  const caps = scanCapabilities("export { spawn } from 'node:child_process';");
  assert.ok(caps.has('proc.spawn'));
});

test('fs 只读不算写', () => {
  const caps = scanCapabilities("import fs from 'node:fs';\nconst s = fs.readFileSync('/x');");
  assert.ok(caps.has('fs.read'));
  assert.ok(!caps.has('fs.write'), '只读不该被算成写');
});

test('fs 有写操作时额外要求 fs.write', () => {
  const caps = scanCapabilities("import fs from 'node:fs';\nfs.writeFileSync('/x', 'y');");
  assert.ok(caps.has('fs.read'));
  assert.ok(caps.has('fs.write'));
});

test('识别 vm / net / http', () => {
  assert.ok(scanCapabilities("import vm from 'node:vm';").has('code.vm'));
  assert.ok(scanCapabilities("import net from 'net';").has('net.socket'));
  assert.ok(scanCapabilities("import https from 'node:https';").has('net.http'));
});

test('识别 eval 与 new Function', () => {
  assert.ok(scanCapabilities('const f = new Function("return 1");').has('code.eval'));
  assert.ok(scanCapabilities('eval("1+1");').has('code.eval'));
});

test('识别 process.binding', () => {
  assert.ok(scanCapabilities('const b = process.binding("fs");').has('proc.binding'));
});

test('干净源码不产生任何能力需求', () => {
  const caps = scanCapabilities("import { x } from '../../src/prompt.js';\nexport default () => x;");
  assert.equal(caps.size, 0);
});

// ── 端到端：真的建一个层，看是否被拒 ────────────────────────────────
function makeTempLayer({ manifest, source }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-audit-'));
  const layerDir = path.join(root, 'overrides', '99-test');
  fs.mkdirSync(layerDir, { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'composition.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(layerDir, 'impl.mjs'), source);
  return root;
}

const MANIFEST = {
  version: 1,
  id: 'audit-test',
  order: 10,
  enabled: true,
  components: { 'core.text.plain': { module: './impl.mjs', export: 'default' } },
};

test('未声明 proc.spawn 的层被拒绝加载', async () => {
  const root = makeTempLayer({
    manifest: { ...MANIFEST, permissions: [] },
    source: "import { spawn } from 'node:child_process';\nexport default () => spawn;\n",
  });
  try {
    const report = await loadComposition({ appRoot: root, log() {} });
    assert.equal(report.components['core.text.plain'], undefined, '不应被加载');
    assert.ok(report.errors.some((e) => e.error.includes('未声明能力') && e.error.includes('proc.spawn')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('声明了 proc.spawn 的层正常加载', async () => {
  const root = makeTempLayer({
    manifest: { ...MANIFEST, permissions: ['proc.spawn'] },
    source: "import { spawn } from 'node:child_process';\nexport default () => typeof spawn;\n",
  });
  try {
    const report = await loadComposition({ appRoot: root, log() {} });
    assert.equal(typeof report.components['core.text.plain'], 'function');
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('不碰敏感模块的层无需任何声明', async () => {
  const root = makeTempLayer({
    manifest: { ...MANIFEST, permissions: [] },
    source: 'export default () => "ok";\n',
  });
  try {
    const report = await loadComposition({ appRoot: root, log() {} });
    assert.equal(typeof report.components['core.text.plain'], 'function');
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
