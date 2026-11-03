// 桌宠浮窗的「能不能拖动」—— 2026-10-25 定稿。
//
// 实测：对话窗能拖，开发工单窗拖不动。三张浮窗都是 frameless + alwaysOnTop +
// skipTaskbar 的无边框卡片，没有系统标题栏，不给拖动区就等于钉死在
// anchorNearPet() 算出来的位置上。
//
// 但**只有窗口**要能拖：
//   - 对话窗 / 工单窗 → CSS 拖动区（.hd 上 -webkit-app-region: drag，按钮 no-drag）；
//   - 单击弹出的用量卡片 → **不拖**，跟着桌宠走。它是"看一眼就走"的卡片，
//     drag 区域会吞掉 pointerdown，连"点一下收起来"都会一起废掉；
//     曾试过"渲染判 4px 阈值 + 主进程跟光标"的自定义拖动，已按用户要求撤掉。
//     这一条专门防止它被后人"顺手也加上"。
// 纯文本检查，不启动 Electron。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DEV_CSS = 'ui/desktop-pet/dev-chat.css';
const CHAT_CSS = 'ui/desktop-pet/pet-chat.css';
const CARD_CSS = 'ui/desktop-pet/usage-card.css';
const CARD_HTML = 'ui/desktop-pet/usage-card.html';
const CARD_JS = 'ui/desktop-pet/usage-card.js';
const CARD_PRELOAD = 'electron/pet-usage-preload.cjs';
const MAIN = 'electron/desktop-pet.js';

test('工单窗：标题栏是拖动区，按钮不是', () => {
  const css = read(DEV_CSS);
  assert.match(css, /\.hd\s*\{[^}]*-webkit-app-region:\s*drag/, '工单窗 .hd 没有 drag 区（拖不动）');
  assert.match(css, /\.hd button\s*\{[^}]*no-drag/, '按钮必须 no-drag，否则「返回聊天」「新工单」「×」点不动');
});

test('对话窗仍保有同一套拖动写法（基线，别被改回去）', () => {
  const css = read(CHAT_CSS);
  assert.match(css, /\.hd\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.hd button\s*\{[^}]*no-drag/);
});

test('用量卡片不设拖动区（加了会连"点一下就收"一起废掉）', () => {
  assert.doesNotMatch(read(CARD_CSS), /app-region/, '用量卡不要加 CSS drag 区');
  assert.doesNotMatch(read(CARD_HTML), /app-region/);
  assert.doesNotMatch(read(CARD_CSS), /cursor:\s*(grab|grabbing|move)/, '光标别暗示可拖 —— 它不可拖');
});

test('用量卡片保持"点一下就收"', () => {
  assert.match(read(CARD_JS), /document\.addEventListener\('pointerdown',\s*close\)/);
});

test('用量卡片没有拖动口子：preload 只给 ready/close/onData，主进程也没有 drag 通道', () => {
  const preload = read(CARD_PRELOAD);
  assert.doesNotMatch(preload, /drag/i, 'preload 不该暴露任何拖动信号');
  assert.doesNotMatch(preload, /setBounds|getCursorScreenPoint/);
  assert.doesNotMatch(read(MAIN), /qqa-pet-usage:drag/, '主进程不该有用量卡的拖动 IPC 处理器');
});

test('用量卡片的位置只由 anchorNearPet 决定（跟着桌宠走）', () => {
  const main = read(MAIN);
  const present = main.slice(main.indexOf('async function presentUsage'), main.indexOf('function openDevChat'));
  assert.match(present, /anchorNearPet\(win, USAGE_CARD_SIZE, 'above'\)/, '每次单击都贴回桌宠上方');
  assert.match(present, /hideUsageWindow\(\); \}, 16000\)/, '16 秒后自动收');
});
