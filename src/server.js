// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ app.js / composition 必须**动态 import**：src/config.js 在模块求值的瞬间
//    就把 DATA_DIR 固化了（process.env.QQ_AGENT_DATA_DIR || ROOT/data）。
//    静态 import 会让下面的 env 设置晚一步，等于没设 —— electron/main.js
//    里为同一件事也留了同样的注释。
import { resolveHeadlessDataDir } from './data-dir.js';

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

// 与桌面版共用同一份数据目录，并把结果打在启动首行 —— 以后再遇到
// 「插件没了 / 记忆空了」，一眼就能看出进程到底读的是哪套 data。
const resolvedDataDir = resolveHeadlessDataDir(APP_ROOT);
if (!process.env.QQ_AGENT_DATA_DIR) process.env.QQ_AGENT_DATA_DIR = resolvedDataDir.dir;
console.log(`[启动] DATA_DIR = ${resolvedDataDir.dir}（${resolvedDataDir.source}）`);
if (resolvedDataDir.warning) console.warn(`[启动] ${resolvedDataDir.warning}`);

// env 定型之后才允许加载业务模块（否则 config.js 读到的是旧目录）
const [{ createApp }, { loadComposition }] = await Promise.all([
  import('./app.js'),
  import('./composition/loader.js')
]);

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
