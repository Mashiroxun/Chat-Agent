/**
 * 原子写契约（2026-10-28 审计）。
 *
 * 这个模块的返回值一直有个"说到做不到"的问题：文档和调用方注释都写
 * "失败返回 false、不抛"，实现里却是 `throw e`。于是 src/store.js 的
 * `if (!atomicWriteJson(...)) return false;` 是一条**永不成立**的分支，
 * 磁盘满 / 文件被锁时异常会直接穿透到没包 try 的调用点。
 *
 * 本测试固定住"失败 → false"这个契约，防止再被改回抛异常。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteText, atomicWriteJson } from '../src/atomic-write.js';

function tmpFile(name = 'a.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-atomic-'));
  return { dir, file: path.join(dir, name) };
}

/** 临时把某个 fs 方法换成"必定失败"，跑完恢复。 */
function withFailingFs(method, code, fn) {
  const orig = fs[method];
  fs[method] = () => {
    const e = new Error(`模拟失败（${code}）`);
    e.code = code;
    throw e;
  };
  try {
    return fn();
  } finally {
    fs[method] = orig;
  }
}

test('写入成功：返回 true 且内容完整', () => {
  const { dir, file } = tmpFile();
  assert.equal(atomicWriteText(file, '你好'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '你好');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rename 失败（磁盘满 / 文件被占）：返回 false，不抛，且不留临时文件', () => {
  const { dir, file } = tmpFile();
  const ok = withFailingFs('renameSync', 'ENOSPC', () => atomicWriteText(file, '内容'));
  assert.equal(ok, false, '按契约必须返回 false，而不是把异常扔给调用方');
  const left = fs.readdirSync(dir);
  assert.deepEqual(left, [], `失败后不该残留任何文件（含 .tmp），实际：${left.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('父目录建不出来（父级是个文件）：同样返回 false', () => {
  const { dir } = tmpFile();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const target = path.join(blocker, 'sub', 'x.json');
  assert.equal(atomicWriteText(target, '内容'), false);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'x', '原有的那个文件不能被破坏');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJson 透传同一契约（失败不抛）', () => {
  const { dir, file } = tmpFile();
  const ok = withFailingFs('writeFileSync', 'EACCES', () => atomicWriteJson(file, { a: 1 }));
  assert.equal(ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
