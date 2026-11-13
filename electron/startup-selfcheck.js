// 启动期安装完整性自检（纯 node，不依赖 electron，便于单测）。
//
// 这是「覆盖安装打不开」体验问题的治本项（根因①/④）：
//   - ④ 依赖缺失：node_modules 没进包 → 收包人 ERR_MODULE_NOT_FOUND 直接打不开；
//   - ① 半覆盖：旧 exe + 新 JS 混装 → 版本错配，启动即崩或白屏。
// 在加载真正的 main.js 之前先确认依赖与关键文件都在、版本一致，
// 缺了就给出明确提示，而不是闪一下白屏就退出。
//
// 注意：本模块刻意只用 node:fs / node:path，不 import electron、不 import 任何
// 业务模块 —— 否则自检本身就会因为「要查的缺失文件」而加载失败，失去意义。
import fs from 'node:fs';
import path from 'node:path';

// 半覆盖 / 截断最常出现在这批「被 main.js 直接 import」的核心模块上。
const CRITICAL_LOCAL_FILES = [
  'electron/main.js',
  'electron/boot-state.js',
  'electron/render-policy.js',
  'electron/dialog-safe.js',
  'src/self-update.js',
  'src/profile.js',
];

/**
 * 安装完整性自检。
 * @param {string} appDir resources/app 目录（bootstrap.js 传入）
 * @returns {{ ok: boolean, problems: Array<{ type: string, detail: string }> }}
 */
export function runStartupSelfCheck(appDir) {
  const problems = [];

  // 1) 第三方依赖完整性（根因④）
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  } catch {
    problems.push({ type: 'pkg', detail: 'package.json 读取失败' });
  }
  if (pkg && pkg.dependencies) {
    for (const dep of Object.keys(pkg.dependencies)) {
      const marker = path.join(appDir, 'node_modules', dep, 'package.json');
      if (!exists(marker)) {
        problems.push({ type: 'dep', detail: `依赖缺失：${dep}（node_modules/${dep} 不存在）` });
      }
    }
  }

  // 2) 版本一致性（根因①：覆盖安装把旧 exe 与新 JS 混在一起）
  //    version.json 不存在（纯开发态）时跳过，不误报。
  const vjson = path.join(appDir, 'version.json');
  if (exists(vjson)) {
    try {
      const v = JSON.parse(fs.readFileSync(vjson, 'utf8'));
      if (pkg && v.version && pkg.version && v.version !== pkg.version) {
        problems.push({
          type: 'version',
          detail: `版本不一致：package.json=${pkg.version} / version.json=${v.version}（可能是覆盖安装残留）`,
        });
      }
    } catch {
      // version.json 坏不影响启动，跳过
    }
  }

  // 3) 关键本地文件存在且非空（被覆盖截断成 0 字节的常见特征）
  for (const rel of CRITICAL_LOCAL_FILES) {
    const fp = path.join(appDir, rel);
    if (!exists(fp)) {
      problems.push({ type: 'file', detail: `关键文件缺失：${rel}` });
    } else if (fileSize(fp) === 0) {
      problems.push({ type: 'file', detail: `关键文件为空（可能被覆盖截断）：${rel}` });
    }
  }

  return { ok: problems.length === 0, problems };
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}
