// 桌宠两张卡片的「来回」必须对称 —— 2026-10-25 回归。
//
// 实测翻车：桌宠双击开「对话」→ 点「开发工单」，工单窗起来时把对话窗 hide 掉了，
// 而工单窗里只有「新工单」和「×」，没有任何回程入口 —— 用户点进去就回不到聊天，
// 只能关掉桌宠重开。两张窗都是 frameless + alwaysOnTop 的卡片，关了也不会露出别的界面。
//
// 这条测试钉住的是"回程链路"四层都在：
//   html（按钮） → js（绑事件） → preload（桥） → 主进程（IPC 处理器 + 真的把对话窗叫起来）。
// 纯文本检查，不启动 Electron（这些文件是渲染侧/主进程代码，没有可导入的纯函数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = 'ui/desktop-pet/dev-chat.html';
const PAGE = 'ui/desktop-pet/dev-chat.js';
const PRELOAD = 'electron/pet-devchat-preload.cjs';
const MAIN = 'electron/desktop-pet.js';

test('工单窗头上有「返回聊天」按钮（不是只能关窗）', () => {
  const html = read(HTML);
  assert.match(html, /id="back"/, '缺少返回按钮 #back');
  assert.match(html, /id="back"[^>]*>返回聊天</, '按钮文案要写清"返回聊天"，图标/× 不算');
  // 关窗键还在：回程不能是唯一出路
  assert.match(html, /id="close"/);
});

test('页面把 #back 接到桥的 openChat 上', () => {
  const page = read(PAGE);
  assert.match(page, /\$\('back'\)\.addEventListener\('click'/, '#back 没有绑点击');
  assert.match(page, /api\?\.openChat\?\.\(\)/, '#back 没调 api.openChat()');
});

test('preload 暴露 openChat，指向 qqa-dev:open-chat', () => {
  const preload = read(PRELOAD);
  assert.match(preload, /openChat:\s*\(\)\s*=>\s*ipcRenderer\.send\('qqa-dev:open-chat'\)/);
});

test('主进程接到 qqa-dev:open-chat 后藏工单窗、叫起对话窗', () => {
  const main = read(MAIN);
  const line = main.split('\n').find((l) => l.includes("listenDev('qqa-dev:open-chat'"));
  assert.ok(line, '主进程没有 qqa-dev:open-chat 的处理器（点了没反应）');
  assert.match(line, /devWindow\.hide\(\)/, '要先把工单窗收起来，否则两张卡片叠在一起');
  assert.match(line, /openChat\(\)/, '要真的把对话窗叫起来（openChat 会 show + focus）');
});

test('对称性：对话窗也留着进工单的入口', () => {
  assert.match(read('ui/desktop-pet/pet-chat.html'), /id="dev"/);
  assert.match(read('electron/pet-chat-preload.cjs'), /openDev:\s*\(\)\s*=>\s*ipcRenderer\.send\('qqa-chat:open-dev'\)/);
  assert.match(read(MAIN), /listenChat\('qqa-chat:open-dev'/);
});
