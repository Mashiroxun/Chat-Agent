// Electron 启动引导：先做一次安装完整性自检，再加载真正的 main.js。
//
// 为什么单独作为 package.json 的 main：
//   任何静态 import 失败（依赖缺失、导出名不存在）都会让 main.js 整个模块加载
//   失败 → 主进程起不来 → 双击 exe 毫无反应（即「exe 打不开」的体感）。
//   把自检放在 main.js 之前、且只用 node 内建 + electron 两个不可能缺失的模块，
//   就能在「静默崩溃」之前给用户一个明确的原生消息框。
import { app, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStartupSelfCheck } from './startup-selfcheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..'); // resources/app

function failBox(title, detail) {
  try {
    dialog.showErrorBox(title, detail);
  } catch {
    // 极端情况下对话框也起不来，直接退出
  }
  if (typeof app.exit === 'function') app.exit(1);
  else process.exit(1);
}

function main() {
  const result = runStartupSelfCheck(appDir);
  if (!result.ok) {
    const list = result.problems.map((p) => '• ' + p.detail).join('\n');
    failBox(
      'QQ Agent 安装不完整',
      '检测到程序文件缺失或被覆盖安装破坏，无法启动。\n\n' +
        '建议按以下步骤重试：\n' +
        '1. 彻底退出 QQ Agent（托盘右键退出，并在任务管理器确认没有 QQ Agent.exe 进程）\n' +
        '2. 重新覆盖安装，解压时保留 data 目录（不要覆盖本机配置）\n' +
        '3. 更稳妥：改用软件内「检查更新」自动更新\n\n' +
        '检测到的问题：\n' +
        list
    );
    return;
  }

  // 自检通过：加载真正的入口。任何加载期异常都兜底成可读的消息框，
  // 而不是把用户丢进「闪一下就没了」的黑洞。
  import('./main.js').catch((err) => {
    failBox('QQ Agent 启动失败', '主程序加载异常：\n' + (err && err.stack ? err.stack : String(err)));
  });
}

try {
  main();
} catch (err) {
  failBox('QQ Agent 启动引导失败', '自检过程异常：\n' + (err && err.stack ? err.stack : String(err)));
}
