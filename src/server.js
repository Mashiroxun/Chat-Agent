// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadComposition } from './composition/loader.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

// 启动组合（0.4.9.2）：先解析 overrides/ 下的追加层，再交给 createApp。
// 层清单非法时明确失败，不静默降级到出厂实现。
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let components = {};
let compositionReport = null;
try {
  const composition = await loadComposition({ appRoot: APP_ROOT });
  components = composition.components;
  compositionReport = composition;
  if (composition.errors.length) {
    console.error(`[启动组合] ${composition.errors.length} 个层/组件加载失败，已跳过：`);
    for (const item of composition.errors) {
      console.error(`  - ${item.dir}${item.key ? ` / ${item.key}` : ''}：${item.error}`);
    }
  }
} catch (error) {
  console.error('[启动组合] 加载失败：', error?.message ?? error);
  process.exit(1);
}

const app = createApp({ components, composition: compositionReport });
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
