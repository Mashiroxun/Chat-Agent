// 「分发包开箱后桌宠能不能显示」的判定单测（2026-10-28）。
//
// 为什么单独写这一组：桌宠能不能显示，取决于 main.js 启动最早期的一个判定 ——
// 「这台机器只能软件渲染 + 用户开着桌宠 ⇒ 自动关渲染沙箱」。它没有界面，
// 出错的表现是"收包人桌面上没有桌宠，且毫无提示"，是最典型的开箱即坏。
// 所以判定逻辑被抽成 electron/render-policy.js（纯函数）并在这里钉死。
//
// 运行：node --test tests/auto-compat.test.mjs   （在 resources/app 目录下）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPetVisible, shouldAutoCompatibleForPet, shouldRevokeAutoCompat } from '../electron/render-policy.js';

/** 造一个临时 data 目录，可选写入 desktop-pet/state.json 的原始内容。 */
function makeDataDir(stateRaw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pet-'));
  if (stateRaw !== undefined) {
    fs.mkdirSync(path.join(dir, 'desktop-pet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'desktop-pet', 'state.json'), stateRaw);
  }
  return dir;
}

test('readPetVisible：没有 state.json（收包人首次启动）按"要显示"处理', () => {
  const dir = makeDataDir();
  assert.equal(readPetVisible(dir), true);
});

test('readPetVisible：dataDir 缺失也不抛，按"要显示"处理', () => {
  assert.equal(readPetVisible(''), true);
  assert.equal(readPetVisible(undefined), true);
});

test('readPetVisible：settings.visible=true 为真', () => {
  const dir = makeDataDir(JSON.stringify({ settings: { visible: true } }));
  assert.equal(readPetVisible(dir), true);
});

test('readPetVisible：只有显式 false 才算用户关了桌宠', () => {
  const dir = makeDataDir(JSON.stringify({ settings: { visible: false } }));
  assert.equal(readPetVisible(dir), false);
});

test('readPetVisible：字段缺失 / 类型不对 / 文件损坏一律按"要显示"处理', () => {
  assert.equal(readPetVisible(makeDataDir(JSON.stringify({ settings: {} }))), true);
  assert.equal(readPetVisible(makeDataDir(JSON.stringify({}))), true);
  assert.equal(readPetVisible(makeDataDir(JSON.stringify({ settings: { visible: 'false' } }))), true);
  assert.equal(readPetVisible(makeDataDir('{ 这不是 JSON')), true);
  assert.equal(readPetVisible(makeDataDir('')), true);
});

test('shouldAutoCompatibleForPet：真值表（四个条件缺一不可）', () => {
  const base = { renderGpuOff: true, sandboxOffByConfig: false, keepSandbox: false, petVisible: true };

  // GPU 正常：不动沙箱（硬件加速下透明窗口本来就能上屏，没必要牺牲安全纵深）
  assert.equal(shouldAutoCompatibleForPet({ ...base, renderGpuOff: false }), false);
  // 已经关过沙箱：不重复写盘
  assert.equal(shouldAutoCompatibleForPet({ ...base, sandboxOffByConfig: true }), false);
  // 用户明确要求保留沙箱
  assert.equal(shouldAutoCompatibleForPet({ ...base, keepSandbox: true }), false);
  // 用户把桌宠关了：没有理由降级
  assert.equal(shouldAutoCompatibleForPet({ ...base, petVisible: false }), false);
  // 收包人机器：软件渲染 + 桌宠开着 + 无配置 ⇒ 必须自动兼容
  assert.equal(shouldAutoCompatibleForPet(base), true);
  // 参数整体缺省：不许抛
  assert.equal(shouldAutoCompatibleForPet(), false);
});

test('分发包场景：全新 data + 软件渲染标记 → 判定为自动兼容（桌宠能出来）', () => {
  // 收包人机器：data 里只有桌宠默认状态（visible:true），没有 render-config.json、
  // 没有 render-gpu-off.flag（main.js 里 renderGpuOff 由 flag 决定，测试直接传 true）
  const dir = makeDataDir(JSON.stringify({ settings: { visible: true } }));
  const decided = shouldAutoCompatibleForPet({
    renderGpuOff: true,
    sandboxOffByConfig: false,
    keepSandbox: process.env.QQ_AGENT_KEEP_SANDBOX === '1',
    petVisible: readPetVisible(dir)
  });
  assert.equal(decided, true);
});

test('分发包场景：用户关了桌宠 → 不自动关沙箱（保住安全纵深）', () => {
  const dir = makeDataDir(JSON.stringify({ settings: { visible: false } }));
  assert.equal(
    shouldAutoCompatibleForPet({ renderGpuOff: true, sandboxOffByConfig: false, keepSandbox: false, petVisible: readPetVisible(dir) }),
    false
  );
});

// ── 反向：自动兼容写下的 sandbox:false 必须能被撤销 ───────────────────────
//
// 这组是 2026-10-28 自查补的。第一版只写了"自动关"，没写"怎么开回来" ——
// 而更新说明里已经向用户承诺"关掉桌宠就会恢复沙箱"。没有这些用例，
// 那句承诺就是一句空话，且没人会发现（用户看不到沙箱状态）。

test('撤销：自动兼容写入的配置 + 用户关掉桌宠 → 恢复沙箱', () => {
  const dir = makeDataDir(JSON.stringify({ settings: { visible: false } }));
  assert.equal(
    shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: false, petVisible: readPetVisible(dir) }),
    true
  );
});

test('撤销：只有应用自己写的 auto-pet 才撤销，用户手动开启的兼容模式保留', () => {
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: false, petVisible: false }), true);
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: '', keepSandbox: false, petVisible: false }), false);
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: undefined, keepSandbox: false, petVisible: false }), false);
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'manual', keepSandbox: false, petVisible: false }), false);
});

test('撤销：桌宠还开着 / 读不出状态 / 强制保沙箱 → 都不动配置', () => {
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: false, petVisible: true }), false);
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: false, petVisible: undefined }), false);
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: true, petVisible: false }), false);
  assert.equal(shouldRevokeAutoCompat(), false);
});

test('完整循环：软件渲染机器上「开桌宠 → 自动关沙箱 → 关桌宠 → 恢复沙箱」', () => {
  const on = makeDataDir(JSON.stringify({ settings: { visible: true } }));
  const off = makeDataDir(JSON.stringify({ settings: { visible: false } }));

  // 第 1 次启动：桌宠开着、还没有配置 → 自动关沙箱
  assert.equal(shouldAutoCompatibleForPet({ renderGpuOff: true, sandboxOffByConfig: false, keepSandbox: false, petVisible: readPetVisible(on) }), true);
  // 第 2 次启动：配置已是 sandbox:false（auto-pet），不能重复写
  assert.equal(shouldAutoCompatibleForPet({ renderGpuOff: true, sandboxOffByConfig: true, keepSandbox: false, petVisible: readPetVisible(on) }), false);
  // 用户关掉桌宠后的下一次启动：撤销
  assert.equal(shouldRevokeAutoCompat({ sandboxOffBy: 'auto-pet', keepSandbox: false, petVisible: readPetVisible(off) }), true);
  // 撤销后同一轮里不能再反过来又自动关（顺序必须是先撤销、再判定）
  assert.equal(shouldAutoCompatibleForPet({ renderGpuOff: true, sandboxOffByConfig: false, keepSandbox: false, petVisible: readPetVisible(off) }), false);
});
