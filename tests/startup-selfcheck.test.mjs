// 启动期安装完整性自检的单测（不依赖 electron，纯 node 跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStartupSelfCheck } from '../electron/startup-selfcheck.js';

const CRITICAL = [
  'electron/main.js',
  'electron/boot-state.js',
  'electron/render-policy.js',
  'electron/dialog-safe.js',
  'src/self-update.js',
  'src/profile.js',
];

function makeAppDir(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-'));
  setup(dir);
  return dir;
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writePkg(dir, deps = { 'js-yaml': '^5.4.1' }) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.4.9.3', dependencies: deps }));
}
function writeNodeModule(dir, name) {
  const p = path.join(dir, 'node_modules', name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}
function writeFile(dir, rel, content = '// ok\n') {
  const fp = path.join(dir, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

test('全部正常 → ok 且无问题', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    writeNodeModule(d, 'js-yaml');
    for (const f of CRITICAL) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  cleanup(dir);
});

test('缺一个依赖 → 报告该依赖', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    // 故意不写 js-yaml
    for (const f of CRITICAL) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'dep' && p.detail.includes('js-yaml')));
  cleanup(dir);
});

test('version.json 不存在 → 跳过不误报', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    writeNodeModule(d, 'js-yaml');
    for (const f of CRITICAL) writeFile(d, f);
    // 不写 version.json
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, true);
  cleanup(dir);
});

test('version.json 与 package.json 不一致 → 报告', () => {
  const dir = makeAppDir((d) => {
    writePkg(d, { 'js-yaml': '^5.4.1' });
    writeNodeModule(d, 'js-yaml');
    for (const f of CRITICAL) writeFile(d, f);
    fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ version: '9.9.9' }));
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'version'));
  cleanup(dir);
});

test('关键本地文件缺失 → 报告', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    writeNodeModule(d, 'js-yaml');
    // 故意漏掉 boot-state.js
    for (const f of CRITICAL.filter((f) => f !== 'electron/boot-state.js')) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'file' && p.detail.includes('boot-state.js')));
  cleanup(dir);
});

test('关键文件为空（被截断）→ 报告', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    writeNodeModule(d, 'js-yaml');
    for (const f of CRITICAL) writeFile(d, f, ''); // 0 字节
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'file' && p.detail.includes('为空')));
  cleanup(dir);
});

test('package.json 坏 → 报告 pkg', () => {
  const dir = makeAppDir((d) => {
    fs.writeFileSync(path.join(d, 'package.json'), '{坏');
    for (const f of CRITICAL) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'pkg'));
  cleanup(dir);
});

// 0.4.9.4 事故回归：js-yaml/package.json 在，但 exports 指向的 dist/js-yaml.mjs
// 被 --exclude=dist 排掉了。旧判据只看 package.json，全绿放过，装完双击即崩。
test('依赖声明了入口但入口文件缺失 → 报告 dep-entry', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    const dep = path.join(d, 'node_modules', 'js-yaml');
    fs.mkdirSync(path.join(dep, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
      name: 'js-yaml',
      version: '5.4.1',
      main: './dist/js-yaml.cjs.js',
      exports: { '.': { import: './dist/js-yaml.mjs', require: './dist/js-yaml.cjs.js' } },
    }));
    fs.writeFileSync(path.join(dep, 'dist', 'js-yaml.cjs.js'), '// ok\n');
    // 故意不写 dist/js-yaml.mjs
    for (const f of CRITICAL) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'dep-entry' && p.detail.includes('js-yaml.mjs')));
  cleanup(dir);
});

test('依赖入口齐全、类型声明缺失 → 不误报', () => {
  const dir = makeAppDir((d) => {
    writePkg(d);
    const dep = path.join(d, 'node_modules', 'js-yaml');
    fs.mkdirSync(path.join(dep, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
      name: 'js-yaml',
      version: '5.4.1',
      main: './dist/js-yaml.cjs.js',
      exports: {
        '.': { types: './dist/js-yaml.d.ts', import: './dist/js-yaml.mjs', require: './dist/js-yaml.cjs.js' },
      },
    }));
    for (const f of ['dist/js-yaml.cjs.js', 'dist/js-yaml.mjs']) {
      fs.writeFileSync(path.join(dep, f), '// ok\n');
    }
    // 故意不写 .d.ts —— 类型声明运行时不加载，不应被检查
    for (const f of CRITICAL) writeFile(d, f);
  });
  const r = runStartupSelfCheck(dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  cleanup(dir);
});
