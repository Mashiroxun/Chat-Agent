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
      const depDir = path.join(appDir, 'node_modules', dep);
      const marker = path.join(depDir, 'package.json');
      if (!exists(marker)) {
        problems.push({ type: 'dep', detail: `依赖缺失：${dep}（node_modules/${dep} 不存在）` });
        continue;
      }
      // 只看 package.json 在不在是不够的：0.4.9.4 的包 js-yaml/package.json 在，
      // 但 exports 指向的 dist/js-yaml.mjs 没进包，旧判据全绿、装完双击即崩。
      // 所以依赖自己声明的运行时入口也要逐个确认存在。
      for (const target of missingEntryTargets(depDir, marker)) {
        problems.push({ type: 'dep-entry', detail: `依赖入口缺失：${dep} → ${target}` });
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

/**
 * 依赖 package.json 里声明的运行时入口目标。
 * 只取 main / module / exports 的字符串值：browser 字段是给打包器做条件替换的，
 * 类型声明（.d.ts）运行时不加载，都跳过，避免误报。
 */
function declaredEntryTargets(depPkg) {
  const out = [];
  const add = (v) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(s)) return;   // URL / 绝对路径不归这里管
    if (/\.d\.(?:ts|mts|cts)$/i.test(s)) return;         // 类型声明运行时不加载
    // 含 * 的是 exports 通配符模式（check-package.mjs 按 pattern 匹配包内文件，
    // 不当字面路径）。这里没有包内文件清单做匹配，只能一律跳过 —— 若当字面路径
    // 去 exists() 判断必然"缺失"，会把装好的依赖误报成安装不完整，Bootstrap
    // 直接 app.exit(1)（2026-11-16 审查）。
    if (s.includes('*')) return;
    if (!out.includes(s)) out.push(s);
  };
  add(depPkg.main);
  add(depPkg.module);
  const walk = (v) => {
    if (typeof v === 'string') add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(depPkg.exports);
  return out;
}

/** 依赖声明的入口里实际缺失的那些（读不到 package.json 就跳过，交给别的判据）。 */
function missingEntryTargets(depDir, markerPath) {
  let depPkg;
  try {
    depPkg = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return [];
  }
  const missing = [];
  for (const target of declaredEntryTargets(depPkg)) {
    if (target.includes('*')) continue;   // 通配符不是字面路径（与 check-package 同口径，skip）
    const rel = target.replace(/^\.\//, '');
    if (rel.split('/').includes('..')) continue;   // 指向依赖外部，不归本次检查
    if (!exists(path.join(depDir, rel))) missing.push(target);
  }
  return missing;
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
