#!/usr/bin/env node
/**
 * 重算内置模块的指纹基线 —— 改过 skills/ 或 plugins/ 里的内置模块后必须跑。
 *
 * 为什么需要：`builtin-modules.json` 里存着每个内置模块的逐文件哈希，启动时核对。
 * 文件名在清单内、但内容与基线不一致的，安全闸会当成"被替换过的插件"拦下 ——
 * 而它给出的报错是「触碰了高危能力：index.js（导入了高危 Node 模块）」，
 * 与真实原因完全对不上，极难排查（2026-11-04 一天内踩了两次）。
 *
 * 用法：
 *   node scripts/refresh-builtin-baseline.mjs help-board          # 只刷这一个
 *   node scripts/refresh-builtin-baseline.mjs help-board sticker  # 刷多个
 *   node scripts/refresh-builtin-baseline.mjs --list              # 看全部模块名
 *   node scripts/refresh-builtin-baseline.mjs --check             # 只报告哪些模块已失配
 *
 * 刻意**不提供**"一键刷新全部"：那会把被篡改的模块一起洗白。
 * 每次只刷你确实改过的那几个。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { refreshBuiltinEntry } from '../src/plugin-loader.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(APP_ROOT, 'builtin-modules.json');

function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const list = Array.isArray(raw.modules) ? raw.modules : [];
  return { raw, list };
}

const args = process.argv.slice(2).filter(Boolean);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`用法：
  node scripts/refresh-builtin-baseline.mjs <模块目录名...>   重算指定模块的基线
  node scripts/refresh-builtin-baseline.mjs --list            列出所有内置模块
  node scripts/refresh-builtin-baseline.mjs --check           只检查，不写入

提示：改完 skills/<x>/ 或 plugins/<x>/ 里的任何文件（哪怕只改注释）都要重算，
      否则下次启动会被安全闸拦下，报错还会错写成"触碰了高危能力"。`);
  process.exit(args.length ? 0 : 1);
}

const { list } = loadManifest();
const known = list.map((m) => m.dir).filter(Boolean);

if (args.includes('--list')) {
  console.log(`内置模块 ${known.length} 个：`);
  for (const k of known) console.log('  ' + k);
  process.exit(0);
}

// 只读自检。文档里一直写着 --check，但旧实现没这个分支，直接被下面的
// 「不是内置模块目录名」拦掉 —— 结果是「改了内置模块源码没重算基线」这类
// 历史事故（/help 重启后报"触碰了高危能力"）没有被自检入口拦住。
// 只读、不写文件，绝不把被篡改的模块洗白。
if (args.includes('--check')) {
  let checked = 0;
  let mismatched = 0;
  for (const m of list) {
    for (const [rel, expected] of Object.entries(m.files || {})) {
      for (const root of ['plugins', 'skills']) {
        const p = path.join(APP_ROOT, root, m.dir, rel);
        if (!fs.existsSync(p)) continue;
        const actual = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
        checked += 1;
        if (actual !== expected) {
          console.error(`❌ ${m.id}/${rel}：基线 ${expected}，实际 ${actual}`);
          mismatched += 1;
        }
      }
    }
  }
  console.log(mismatched
    ? `\n失配 ${mismatched} 处（共核对 ${checked} 个文件）。只刷新你确实改过的模块。`
    : `✅ ${list.length} 个内置模块 / ${checked} 个文件全部一致`);
  process.exit(mismatched ? 1 : 0);
}

const bad = args.filter((a) => !known.includes(a));
if (bad.length) {
  console.error(`❌ 不是内置模块目录名：${bad.join(', ')}`);
  console.error(`   可用 --list 查看全部 ${known.length} 个。`);
  process.exit(1);
}

let ok = 0;
for (const id of args) {
  const r = refreshBuiltinEntry(id);
  if (r?.ok) {
    console.log(`✅ ${id}${r.updated ? ' 基线已更新' : ' 无变化'}（${r.files ?? '?'} 个文件）`);
    ok += 1;
  } else {
    console.error(`❌ ${id} 失败：${r?.error || '未知原因'}`);
  }
}
console.log(`\n完成 ${ok}/${args.length}。基线文件：${path.relative(APP_ROOT, MANIFEST)}`);
process.exit(ok === args.length ? 0 : 1);
