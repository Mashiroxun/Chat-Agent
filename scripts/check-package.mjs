#!/usr/bin/env node
/**
 * check-package.mjs — Electron 发布包「启动完整性」检查器
 *
 * 用途：在发布前/上传前，静态验证一个 zip 发布包或已解包安装根目录，
 *       是否包含 Electron 主进程启动所必需的全部文件。
 *
 * 检查项：
 *   1. 定位 resources/app/package.json，读取 main 与 dependencies。
 *   2. 依赖入口断言：解析每个依赖 package.json 的 main / module /
 *      exports（字符串、对象、条件分支、子路径、数组、通配符）/ browser /
 *      bin，收集所有指向包内文件的相对路径，逐个断言「存在且非空」。
 *      —— 这是「bsdtar --exclude=dist 误删 node_modules/js-yaml/dist」事故的直接防线。
 *   3. 主进程本地 import 图：从 main 入口出发，正则扫描静态 import、
 *      export ... from、动态 import()、require()，只跟随相对路径，
 *      递归构建可达文件集合（visited 防环），断言每个可达文件存在且非空。
 *   4. 基础断言：QQ Agent.exe、version.json 与 package.json 版本一致、
 *      关键文件非 0 字节、总文件数 / 总字节数。
 *   5. 输出 report.json（结构化）+ 控制台中文摘要；退出码 0 = 全过，1 = 有问题。
 *
 * 仅依赖 Node 内建模块，零第三方依赖；zip 输入自行解析（含 GBK 中文名还原）。
 *
 * 用法：
 *   node check-package.mjs --zip <path> [--report <path>]
 *   node check-package.mjs --dir <path> [--report <path>]
 *   node check-package.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 默认报告落在仓库根的 dist/（.gitignore 已忽略），避免污染 scripts/ 目录。
const DEFAULT_REPORT = path.join(path.dirname(SCRIPT_DIR), 'dist', 'package-report.json');
const APP_PACKAGE_SUFFIX = 'resources/app/package.json';
const EXE_BASENAME = 'qq agent.exe';
const VERSION_BASENAME = 'version.json';

/** 相对 import / 包内入口解析时尝试的候选后缀（顺序即优先级）。 */
const RESOLVE_SUFFIXES = [
  '',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.node',
  '/index.js',
  '/index.mjs',
  '/index.cjs',
  '/index.json',
];

/** 仅用于类型系统的条件键 / 扩展名：缺失时记豁免，不影响启动判定。 */
const TYPE_ONLY_CONDITIONS = new Set(['types', 'typings']);
const TYPE_ONLY_EXT = /\.(?:d\.ts|d\.mts|d\.cts)$/i;

/** 只跟随相对路径 spec；其余（裸包名、node: 内建、别名、绝对 URL）记为外部模块。 */
const EXTERNAL_SPEC_RE = /^(?:\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/;

/**
 * 字节数格式化为千分位。既提升可读性，也避免脱敏器把连续长数字
 * （如 344472250）误判为疑似标识。
 * @param {number} n 字节数。
 * @return {string} 例如 "344,472,250"。
 */
function fmtBytes(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// 隐私脱敏：输出中绝不出现真实 QQ 号 / 群号 / 昵称 / API Key / 本机用户名
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /(?<![\d.])\d{6,12}(?![\d.])/,                       // 疑似 QQ 号 / 群号 / 长数字标识
  /\b(?:sk|pk_live|pk_test|rk_live|rk_test|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
];

/**
 * 对单个包内路径 / 文本做脱敏。命中任一敏感模式时返回固定提示语。
 * @param {string} value 原始字符串。
 * @return {string} 可安全写入报告的字符串。
 */
function redact(value) {
  const text = String(value ?? '');
  for (const re of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return '某文件含疑似真实标识';
  }
  return text;
}

/** 抹掉绝对路径里的本机用户目录名。 */
function redactUserPath(value) {
  return String(value ?? '')
    .replace(/([A-Za-z]:[\\/]|\/[a-z]\/|[\\/])Users[\\/][^\\/]+[\\/]/gi, '$1Users/[已脱敏]/')
    .replace(/[A-Za-z]:[\\/]Documents and Settings[\\/][^\\/]+[\\/]/gi, '[已脱敏]/');
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/**
 * 规范化 zip / 目录条目名：统一斜杠、去掉 ./ 前缀、消除 . 与 .. 段。
 * @param {string} rawName 原始条目名。
 * @return {{name: string, isDir: boolean}} 规范化后的名字与目录标记。
 */
function normalizeEntryName(rawName) {
  let n = String(rawName).replace(/\\/g, '/');
  const trailingSlash = n.endsWith('/');
  while (n.startsWith('./')) n = n.slice(2);
  if (n.startsWith('/')) n = n.slice(1);
  const parts = [];
  for (const seg of n.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return { name: parts.join('/'), isDir: trailingSlash || parts.length === 0 };
}

/** 拼接包内 POSIX 路径并规范化。 */
function joinPosix(base, rel) {
  return normalizeEntryName(path.posix.join(base, rel)).name;
}

/** 去掉 ESM specifier 上的 query / hash（如 `./lib/service.js?v=1.3.8`）。 */
function stripQuery(spec) {
  const q = spec.indexOf('?');
  const h = spec.indexOf('#');
  let end = spec.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return spec.slice(0, end);
}

/** 把 glob 风格（仅含 *）的包内模式转成正则。 */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// 数据源抽象：ZipSource 与 DirSource 提供完全一致的接口
//   entries: Map<normName, {name, isDir, size, ...}>
//   read(normName): Buffer
//   hasFile(normName): boolean
//   sizeOf(normName): number
//   listFiles(): string[]
// ---------------------------------------------------------------------------

/**
 * 自行解析 ZIP 中央目录；支持 store(0) / deflate(8) 与 GBK 中文名还原。
 * 文件名原始字节来自中央目录，不依赖任何第三方解压库。
 */
class ZipSource {
  /** @param {Buffer} buffer zip 文件全部字节。 */
  constructor(buffer) {
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.buffer = buffer;
    this.gbkNamesRecovered = 0;
    this.utf8FlagEntries = 0;
    this.totalCentralEntries = 0;
    this.warnings = [];
    this._parse();
  }

  /** 解析 EOCD 与中央目录，填充 this.entries。 */
  _parse() {
    const buf = this.buffer;
    if (buf.length < 22) throw new Error('zip 文件过小，不是合法 ZIP');

    // 1) 从尾部倒序查找 End Of Central Directory（0x06054b50）。
    let eocd = -1;
    const floor = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= floor; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('未找到 ZIP End Of Central Directory 记录');

    this.totalCentralEntries = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    // 2) 容忍 SFX / 前置数据导致的偏移：若签名不匹配，向前搜索真实 CD 起点。
    if (cdOffset + 4 > buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
      let found = -1;
      const searchEnd = Math.min(buf.length - 4, cdOffset + cdSize + 64);
      for (let i = Math.max(0, cdOffset - 64); i <= searchEnd; i += 1) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          found = i;
          break;
        }
      }
      if (found >= 0 && found !== cdOffset) {
        this.warnings.push(`中央目录偏移已修正：${cdOffset} -> ${found}`);
        cdOffset = found;
      } else {
        throw new Error('中央目录签名校验失败，ZIP 可能损坏或使用了不支持的 ZIP64');
      }
    }

    // 3) 逐条遍历 Central Directory File Header。
    let cursor = cdOffset;
    let count = 0;
    const cdEnd = Math.min(buf.length, cdOffset + cdSize);
    while (cursor + 46 <= buf.length && buf.readUInt32LE(cursor) === 0x02014b50) {
      const flags = buf.readUInt16LE(cursor + 8);
      const method = buf.readUInt16LE(cursor + 10);
      const compSize = buf.readUInt32LE(cursor + 20);
      const uncompSize = buf.readUInt32LE(cursor + 24);
      const nameLen = buf.readUInt16LE(cursor + 28);
      const extraLen = buf.readUInt16LE(cursor + 30);
      const commentLen = buf.readUInt16LE(cursor + 32);
      const localOffset = buf.readUInt32LE(cursor + 42);
      const nameBytes = buf.subarray(cursor + 46, cursor + 46 + nameLen);

      const isUtf8 = (flags & 0x0800) !== 0;
      if (isUtf8) this.utf8FlagEntries += 1;
      const rawName = this._decodeName(nameBytes, isUtf8);
      const { name, isDir } = normalizeEntryName(rawName);

      if (name !== '') {
        if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
          this.warnings.push(`条目使用 ZIP64 扩展字段，当前解析器不支持：${redact(name)}`);
        }
        if ((flags & 0x0001) !== 0) {
          this.warnings.push(`条目被标记为加密，无法读取内容：${redact(name)}`);
        }
        this.entries.set(name, {
          name,
          isDir,
          size: isDir ? 0 : uncompSize,
          compSize,
          method,
          localOffset,
          flags,
        });
      }

      cursor += 46 + nameLen + extraLen + commentLen;
      count += 1;
      if (cursor >= cdEnd && count >= this.totalCentralEntries) break;
    }
    if (count === 0) throw new Error('中央目录为空，无法解析 zip');
    if (count !== this.totalCentralEntries) {
      this.warnings.push(`中央目录条目数不一致：EOCD 声明 ${this.totalCentralEntries}，实际解析 ${count}`);
    }
  }

  /**
   * 还原条目名：有 UTF-8 flag 用 UTF-8；否则纯 ASCII 直出，含非 ASCII 字节按 GBK 解码。
   * （bsdtar 写出的中文名是 GBK 字节且未置 UTF-8 flag，等价于 Python 的
   *   name.encode('cp437').decode('gbk') 还原。）
   */
  _decodeName(bytes, isUtf8) {
    if (isUtf8) return bytes.toString('utf8');
    let hasNonAscii = false;
    for (const b of bytes) {
      if (b > 0x7f) {
        hasNonAscii = true;
        break;
      }
    }
    if (!hasNonAscii) return bytes.toString('ascii');
    try {
      const decoded = new TextDecoder('gbk', { fatal: true }).decode(bytes);
      if (!decoded.includes('\ufffd')) {
        this.gbkNamesRecovered += 1;
        return decoded;
      }
    } catch {
      // 交给下面的回退分支。
    }
    this.warnings.push('某条目名既非 UTF-8 也非合法 GBK，已按 latin1 保留原始字节');
    return bytes.toString('latin1');
  }

  /** @param {string} name 规范化条目名。 @return {boolean} */
  hasFile(name) {
    const e = this.entries.get(name);
    return !!e && !e.isDir;
  }

  /** @param {string} name 规范化条目名。 @return {number} 未压缩字节数，不存在返回 -1。 */
  sizeOf(name) {
    const e = this.entries.get(name);
    return e && !e.isDir ? e.size : -1;
  }

  /** @return {string[]} 所有非目录条目名（升序）。 */
  listFiles() {
    return [...this.entries.values()].filter((e) => !e.isDir).map((e) => e.name).sort();
  }

  /** @param {string} name 规范化条目名。 @return {Buffer} 解压后的内容。 */
  read(name) {
    const e = this.entries.get(name);
    if (!e || e.isDir) throw new Error(`zip 中不存在文件条目：${redact(name)}`);
    const buf = this.buffer;
    const off = e.localOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
      throw new Error(`本地文件头无效：${redact(name)}`);
    }
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方法 ${e.method}：${redact(name)}`);
  }
}

/** 已解包安装根目录的数据源。 */
class DirSource {
  /** @param {string} root 安装根目录绝对路径。 */
  constructor(root) {
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.root = root;
    this.warnings = [];
    this.gbkNamesRecovered = 0;
    this.utf8FlagEntries = 0;
    this.totalCentralEntries = 0;
    this._walk();
  }

  /** 迭代式递归遍历，跳过符号链接，防止目录逃逸。 */
  _walk() {
    const stack = [this.root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        this.warnings.push(`目录不可读：${redact(dir)} (${err.code || err.message})`);
        continue;
      }
      for (const item of items) {
        const abs = path.join(dir, item.name);
        const rel = normalizeEntryName(path.relative(this.root, abs)).name;
        if (rel === '') continue;
        if (item.isSymbolicLink()) {
          this.warnings.push(`跳过符号链接：${redact(rel)}`);
          continue;
        }
        if (item.isDirectory()) {
          this.entries.set(rel, { name: rel, isDir: true, size: 0, abs });
          stack.push(abs);
        } else if (item.isFile()) {
          let size = 0;
          try {
            size = fs.statSync(abs).size;
          } catch {
            size = 0;
          }
          this.entries.set(rel, { name: rel, isDir: false, size, abs });
        }
      }
    }
  }

  hasFile(name) {
    const e = this.entries.get(name);
    return !!e && !e.isDir;
  }

  sizeOf(name) {
    const e = this.entries.get(name);
    return e && !e.isDir ? e.size : -1;
  }

  listFiles() {
    return [...this.entries.values()].filter((e) => !e.isDir).map((e) => e.name).sort();
  }

  read(name) {
    const e = this.entries.get(name);
    if (!e || e.isDir) throw new Error(`目录中不存在文件：${redact(name)}`);
    return fs.readFileSync(e.abs);
  }
}

// ---------------------------------------------------------------------------
// JS 源码扫描：注释/字符串区间 + import specifier 正则
// ---------------------------------------------------------------------------

/**
 * 用状态机找出源码中「注释」与「字符串/模板/正则字面量」的区间。
 * 后续过滤掉起始位置落在这些区间内的 import 匹配，避免把注释里的示例
 * （例如 `// import('./lib/x.js')`）误判成真实依赖。
 *
 * @param {string} code JS 源码。
 * @return {Array<[number, number]>} 半开区间列表。
 */
function findNonCodeRanges(code) {
  const ranges = [];
  const n = code.length;
  let i = 0;
  let state = 'code';
  let quote = '';
  let start = 0;
  let prev = '';
  const regexStarters = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '']);

  while (i < n) {
    const c = code[i];
    const c2 = i + 1 < n ? code[i + 1] : '';

    if (state === 'code') {
      if (c === '/' && c2 === '/') { start = i; state = 'lineComment'; i += 2; continue; }
      if (c === '/' && c2 === '*') { start = i; state = 'blockComment'; i += 2; continue; }
      if (c === '/' && regexStarters.has(prev)) { start = i; state = 'regex'; i += 1; continue; }
      if (c === '"' || c === "'") { start = i; quote = c; state = 'string'; i += 1; continue; }
      if (c === '`') { start = i; state = 'template'; i += 1; continue; }
      if (!/\s/.test(c)) prev = c;
      i += 1;
      continue;
    }
    if (state === 'string') {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { ranges.push([start, i + 1]); state = 'code'; prev = c; i += 1; continue; }
      if (c === '\n') { ranges.push([start, i]); state = 'code'; i += 1; continue; }
      i += 1;
      continue;
    }
    if (state === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { ranges.push([start, i + 1]); state = 'code'; prev = c; i += 1; continue; }
      i += 1;
      continue;
    }
    if (state === 'lineComment') {
      if (c === '\n') { ranges.push([start, i]); state = 'code'; i += 1; continue; }
      i += 1;
      continue;
    }
    if (state === 'blockComment') {
      if (c === '*' && c2 === '/') { ranges.push([start, i + 2]); state = 'code'; prev = '/'; i += 2; continue; }
      i += 1;
      continue;
    }
    // state === 'regex'
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      i += 1;
      while (i < n && code[i] !== ']') {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '/') { ranges.push([start, i + 1]); state = 'code'; prev = '/'; i += 1; continue; }
    if (c === '\n') { ranges.push([start, i]); state = 'code'; i += 1; continue; }
    i += 1;
  }
  if (state !== 'code') ranges.push([start, n]);
  return ranges;
}

/** 判断 index 是否落在任一非代码区间内（区间有序，线性扫描足够）。 */
function isInRanges(index, ranges) {
  for (const [a, b] of ranges) {
    if (index < a) return false;
    if (index >= a && index < b) return true;
  }
  return false;
}

/** 各类 import / require / re-export 的提取正则（global，配 matchAll）。 */
const SPEC_PATTERNS = [
  /\bimport\s+(?:[\w*{}\s,$]*?\s*from\s*)?(['"])([^'"]+)\1/g,
  /\bexport\s+(?:[\w*{}\s,$]*?\s*from\s*)?(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
];

/**
 * 提取源码中所有静态可判定的模块说明符。
 * @param {string} code JS / MJS / CJS 源码文本。
 * @return {string[]} 去重后的说明符列表。
 */
function extractSpecifiers(code) {
  const nonCode = findNonCodeRanges(code);
  const found = new Set();
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      if (isInRanges(m.index, nonCode)) continue;
      found.add(m[2]);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// package.json 入口字段解析
// ---------------------------------------------------------------------------

/**
 * 递归遍历 exports 值，收集所有字符串目标及其条件键路径。
 * @param {unknown} value exports 片段。
 * @param {string} fieldPath 用于报告的字段名路径。
 * @param {string[]} conditions 经过的条件键（含子路径键）。
 * @param {Array<{spec: string, field: string, conditions: string[]}>} out 输出收集器。
 */
function walkExports(value, fieldPath, conditions, out) {
  if (typeof value === 'string') {
    out.push({ spec: value, field: fieldPath, conditions: conditions.slice() });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, idx) => walkExports(v, `${fieldPath}[${idx}]`, conditions, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walkExports(child, `${fieldPath}.${key}`, conditions.concat(key), out);
    }
  }
}

/**
 * 从依赖 package.json 收集所有指向包内文件的入口目标。
 * @param {object} pkg 已解析的 package.json 对象。
 * @return {Array<{spec: string, field: string, conditions: string[], typeOnly: boolean}>}
 */
function collectPackageTargets(pkg) {
  const out = [];
  const push = (spec, field, conditions = []) => {
    if (typeof spec !== 'string' || spec === '') return;
    const typeOnly = conditions.some((k) => TYPE_ONLY_CONDITIONS.has(k)) || TYPE_ONLY_EXT.test(stripQuery(spec));
    out.push({ spec, field, conditions, typeOnly });
  };

  push(pkg.main, 'main');
  push(pkg.module, 'module');

  // browser 可以是字符串（替换入口）或 { 源文件: 替换目标 | false } 映射。
  if (typeof pkg.browser === 'string') {
    push(pkg.browser, 'browser');
  } else if (pkg.browser && typeof pkg.browser === 'object') {
    for (const [key, value] of Object.entries(pkg.browser)) {
      if (typeof value === 'string') push(value, `browser[${key}]`);
    }
  }

  // bin 可以是字符串或 { 命令名: 相对路径 }。
  if (typeof pkg.bin === 'string') {
    push(pkg.bin, 'bin');
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [key, value] of Object.entries(pkg.bin)) {
      if (typeof value === 'string') push(value, `bin[${key}]`);
    }
  }

  // exports：字符串 / 条件对象 / 子路径映射 / 数组 fallback / 通配符。
  if (pkg.exports !== undefined && pkg.exports !== null) {
    const raw = [];
    walkExports(pkg.exports, 'exports', [], raw);
    for (const item of raw) {
      push(item.spec, item.field, item.conditions);
    }
  }
  return out;
}

/**
 * 把入口 spec 解析为包内实际文件路径。
 * @param {object} source 数据源。
 * @param {string} pkgDir 依赖包目录（规范化）。
 * @param {string} spec 原始 spec。
 * @return {{resolved?: string, expected: string, pattern?: RegExp, wildcard?: boolean, outOfPackage?: boolean}}
 */
function resolvePackageTarget(source, pkgDir, spec) {
  const clean = stripQuery(spec);
  if (clean === '') return { expected: '', outOfPackage: true };
  if (EXTERNAL_SPEC_RE.test(clean) || clean.startsWith('@')) return { expected: clean, outOfPackage: true };
  const joined = joinPosix(pkgDir, clean);
  if (!joined.startsWith(`${pkgDir}/`)) return { expected: joined, outOfPackage: true };

  if (clean.includes('*')) {
    return { expected: joined, wildcard: true, pattern: wildcardToRegExp(joined) };
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    if (source.hasFile(joined + suffix)) return { resolved: joined + suffix, expected: joined };
  }
  return { expected: joined };
}

/**
 * 解析本地相对 import spec 到实际文件。
 * @param {object} source 数据源。
 * @param {string} current 当前文件（规范化）。
 * @param {string} spec 相对说明符。
 * @return {{resolved?: string, expected: string}}
 */
function resolveLocalImport(source, current, spec) {
  const clean = stripQuery(spec);
  const base = path.posix.dirname(current);
  const joined = joinPosix(base === '.' ? '' : base, clean);
  for (const suffix of RESOLVE_SUFFIXES) {
    if (source.hasFile(joined + suffix)) return { resolved: joined + suffix, expected: joined };
  }
  return { expected: joined };
}

// ---------------------------------------------------------------------------
// 检查主体
// ---------------------------------------------------------------------------

/** 创建一个断言记录。 */
function check(name, pass, detail) {
  return { name, pass: !!pass, detail: String(detail ?? '') };
}

/**
 * 定位安装根 / app 根。
 * @param {object} source 数据源。
 * @return {{installRoot: string, appRoot: string, appPackage: string}}
 */
function locateRoots(source) {
  const candidates = [...source.entries.values()]
    .filter((e) => !e.isDir && e.name.endsWith(APP_PACKAGE_SUFFIX))
    .map((e) => e.name)
    .sort((a, b) => a.length - b.length);
  if (candidates.length === 0) {
    throw new Error(`未找到 ${APP_PACKAGE_SUFFIX}，这不像是 QQ Agent 发布包`);
  }
  const appPackage = candidates[0];
  const installRoot = appPackage.slice(0, -APP_PACKAGE_SUFFIX.length);
  const appRoot = appPackage.slice(0, -'package.json'.length);
  return { installRoot, appRoot, appPackage };
}

/** 安全读取并解析 JSON 文件。 */
function readJson(source, name) {
  const raw = source.read(name).toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/**
 * 执行全部检查。
 * @param {object} ctx 上下文 {source, mode, inputPath, inputBytes, sha256}。
 * @return {object} 完整报告对象。
 */
function runChecks(ctx) {
  const { source } = ctx;
  const failures = [];
  const missingFiles = new Set();
  const warnings = [...(source.warnings || [])];
  const noteFailure = (category, name, detail, file) => {
    failures.push({ category, name, detail: redact(detail) });
    if (file) missingFiles.add(redact(file));
  };

  const roots = locateRoots(source);
  const files = source.listFiles();
  const totalFiles = files.length;
  const totalBytes = files.reduce((sum, n) => sum + Math.max(0, source.sizeOf(n)), 0);

  // ---------------- 1. 基础断言 ----------------
  const basicChecks = [];
  let appPkg = null;
  let appVersion = '';
  try {
    appPkg = readJson(source, roots.appPackage);
    appVersion = String(appPkg.version ?? '');
    basicChecks.push(check('resources/app/package.json 可解析', true, `version=${appVersion}`));
  } catch (err) {
    basicChecks.push(check('resources/app/package.json 可解析', false, err.message));
    noteFailure('basic', 'resources/app/package.json 可解析', err.message, roots.appPackage);
  }

  const appPkgBytes = source.sizeOf(roots.appPackage);
  const appPkgNonEmpty = appPkgBytes > 0;
  basicChecks.push(check('package.json 非 0 字节', appPkgNonEmpty, `${fmtBytes(appPkgBytes)} B`));
  if (!appPkgNonEmpty) noteFailure('basic', 'package.json 非 0 字节', '文件为空', roots.appPackage);

  // QQ Agent.exe：优先 installRoot 下的标准位置，再宽松兜底搜索。
  const exeCandidate = `${roots.installRoot}${EXE_BASENAME === 'qq agent.exe' ? 'QQ Agent.exe' : EXE_BASENAME}`;
  let exePath = source.hasFile(exeCandidate) ? exeCandidate : '';
  if (!exePath) {
    exePath = files.find((n) => n.toLowerCase().endsWith(EXE_BASENAME)) || '';
  }
  const exeExists = exePath !== '' && source.hasFile(exePath);
  basicChecks.push(check('QQ Agent.exe 存在', exeExists, exeExists ? redact(exePath) : '未找到'));
  if (!exeExists) noteFailure('basic', 'QQ Agent.exe 存在', '发布包缺少主可执行文件', exeCandidate);
  else if (source.sizeOf(exePath) <= 0) {
    basicChecks.push(check('QQ Agent.exe 非 0 字节', false, '0 B'));
    noteFailure('basic', 'QQ Agent.exe 非 0 字节', '文件为空', exePath);
  } else {
    basicChecks.push(check('QQ Agent.exe 非 0 字节', true, `${fmtBytes(source.sizeOf(exePath))} B`));
  }

  // version.json 与 package.json 版本一致。
  const versionCandidates = files.filter(
    (n) => n.endsWith(VERSION_BASENAME) && !n.includes('/node_modules/'),
  );
  const preferredVersion = `${roots.appRoot}${VERSION_BASENAME}`;
  const versionPath = versionCandidates.includes(preferredVersion)
    ? preferredVersion
    : versionCandidates[0] || '';
  let versionOk = false;
  if (versionPath === '') {
    basicChecks.push(check('version.json 存在', false, '未找到'));
    noteFailure('basic', 'version.json 存在', '发布包缺少 version.json', preferredVersion);
  } else {
    basicChecks.push(check('version.json 存在', true, redact(versionPath)));
    const versionBytes = source.sizeOf(versionPath);
    basicChecks.push(check('version.json 非 0 字节', versionBytes > 0, `${fmtBytes(versionBytes)} B`));
    if (versionBytes <= 0) noteFailure('basic', 'version.json 非 0 字节', '文件为空', versionPath);
    try {
      const vj = readJson(source, versionPath);
      const declared = typeof vj === 'string' ? vj : String(vj.version ?? '');
      versionOk = declared !== '' && declared === appVersion;
      basicChecks.push(
        check('version.json 与 package.json 版本一致', versionOk,
          versionOk ? `${appVersion} == ${declared}` : `package=${appVersion} version.json=${declared || '(缺失)'}`),
      );
      if (!versionOk) noteFailure('basic', '版本一致', `package=${appVersion} / version.json=${declared || '(缺失)'}`);
    } catch (err) {
      basicChecks.push(check('version.json 可解析', false, err.message));
      noteFailure('basic', 'version.json 可解析', err.message, versionPath);
    }
  }

  // main 入口存在且非空。
  const mainSpec = typeof appPkg?.main === 'string' ? appPkg.main : '';
  const mainPath = mainSpec ? joinPosix(roots.appRoot, mainSpec) : '';
  let mainResolved = '';
  if (mainPath) {
    for (const suffix of RESOLVE_SUFFIXES) {
      if (source.hasFile(mainPath + suffix)) { mainResolved = mainPath + suffix; break; }
    }
  }
  const mainExists = mainResolved !== '';
  basicChecks.push(check('main 入口存在', mainExists && mainSpec !== '',
    mainResolved ? `${mainSpec} -> ${redact(mainResolved)}` : `main=${mainSpec || '(未声明)'}`));
  if (!mainExists) {
    noteFailure('basic', 'main 入口存在', `main=${mainSpec || '(未声明)'} 未解析到文件`, mainPath || 'main');
  } else {
    const mb = source.sizeOf(mainResolved);
    basicChecks.push(check('main 入口非 0 字节', mb > 0, `${fmtBytes(mb)} B`));
    if (mb <= 0) noteFailure('basic', 'main 入口非 0 字节', '文件为空', mainResolved);
  }

  basicChecks.push(check('包体统计', true, `${totalFiles} 文件 / ${fmtBytes(totalBytes)} B（未压缩）`));
  const basicPass = basicChecks.every((c) => c.pass);
  for (const c of basicChecks) {
    if (!c.pass && !failures.some((f) => f.name === c.name)) {
      noteFailure('basic', c.name, c.detail);
    }
  }

  // ---------------- 2. 依赖入口断言 ----------------
  const dependencies = typeof appPkg?.dependencies === 'object' && appPkg.dependencies !== null
    ? Object.keys(appPkg.dependencies)
    : [];
  const depResults = [];
  const exemptions = [];

  for (const depName of dependencies) {
    const pkgDir = joinPosix(roots.appRoot, `node_modules/${depName}`);
    const pkgJsonPath = `${pkgDir}/package.json`;
    const result = {
      name: depName,
      declaredRange: String(appPkg.dependencies[depName] ?? ''),
      packageJsonPath: redact(pkgJsonPath),
      version: '',
      pass: true,
      targets: [],
      runtimeTargetCount: 0,
      waivedTargetCount: 0,
    };

    let pkg = null;
    if (!source.hasFile(pkgJsonPath)) {
      result.pass = false;
      result.targets.push({ field: 'package.json', spec: pkgJsonPath, resolved: '', bytes: -1, runtimeRelevant: true, pass: false, error: '依赖 package.json 缺失' });
      noteFailure('dependencyEntries', `依赖 ${depName} 的 package.json`, '缺失', pkgJsonPath);
      depResults.push(result);
      continue;
    }
    try {
      pkg = readJson(source, pkgJsonPath);
      result.version = String(pkg.version ?? '');
      const pb = source.sizeOf(pkgJsonPath);
      if (pb <= 0) {
        result.pass = false;
        result.targets.push({ field: 'package.json(非空)', spec: pkgJsonPath, resolved: pkgJsonPath, bytes: pb, runtimeRelevant: true, pass: false, error: '文件为 0 字节' });
        noteFailure('dependencyEntries', `依赖 ${depName} 的 package.json 非空`, '0 字节', pkgJsonPath);
      }
    } catch (err) {
      result.pass = false;
      result.targets.push({ field: 'package.json(可解析)', spec: pkgJsonPath, resolved: '', bytes: -1, runtimeRelevant: true, pass: false, error: err.message });
      noteFailure('dependencyEntries', `依赖 ${depName} 的 package.json 可解析`, err.message, pkgJsonPath);
      depResults.push(result);
      continue;
    }

    const targets = collectPackageTargets(pkg);
    // 同一 spec 可能被多个字段重复声明，按 spec+field 去重以保留明细。
    const seenSpec = new Set();
    for (const t of targets) {
      const key = `${t.field}|${t.spec}`;
      if (seenSpec.has(key)) continue;
      seenSpec.add(key);

      const resolvedInfo = resolvePackageTarget(source, pkgDir, t.spec);
      if (resolvedInfo.outOfPackage) {
        // 指向包外或绝对 URL：不属于「包内文件」，记录但不判失败。
        result.targets.push({
          field: t.field, spec: redact(t.spec), resolved: '',
          bytes: -1, runtimeRelevant: !t.typeOnly, pass: true, skipped: '非包内相对路径',
        });
        continue;
      }

      let pass = false;
      let bytes = -1;
      let resolved = '';
      let error = '';
      if (resolvedInfo.wildcard) {
        const matches = files.filter((n) => resolvedInfo.pattern.test(n));
        pass = matches.length > 0;
        resolved = `${resolvedInfo.expected} (匹配 ${matches.length} 个文件)`;
        if (!pass) error = '通配符模式未匹配到任何包内文件';
      } else if (resolvedInfo.resolved) {
        resolved = resolvedInfo.resolved;
        bytes = source.sizeOf(resolved);
        pass = bytes > 0;
        if (!pass) error = bytes === 0 ? '文件为 0 字节' : '文件不存在';
      } else {
        resolved = resolvedInfo.expected;
        error = '入口文件缺失';
      }

      const runtimeRelevant = !t.typeOnly;
      const entry = {
        field: t.field,
        spec: redact(t.spec),
        resolved: redact(resolved),
        bytes,
        runtimeRelevant,
        typeOnly: t.typeOnly,
        pass: true,
      };

      if (!runtimeRelevant) {
        // 类型声明不参与 Electron 主进程运行，缺失只记豁免/告警。
        result.waivedTargetCount += 1;
        entry.waived = true;
        entry.pass = true;
        if (!pass) {
          exemptions.push({
            dependency: depName,
            field: t.field,
            spec: redact(t.spec),
            resolved: redact(resolvedInfo.expected),
            reason: '仅 TypeScript 类型声明，运行时不加载，缺失不影响启动',
          });
          warnings.push(`依赖 ${depName} 的 ${t.field} 目标（类型声明）未随包发布，已按运行时无关豁免`);
        }
      } else {
        result.runtimeTargetCount += 1;
        entry.pass = pass;
        if (!pass) {
          entry.error = error;
          result.pass = false;
          noteFailure('dependencyEntries', `依赖 ${depName} 入口 ${t.field}`,
            `${error}: ${t.spec} -> ${resolvedInfo.expected}`, resolvedInfo.expected);
        }
      }
      result.targets.push(entry);
    }
    depResults.push(result);
  }

  const depRuntimeTargets = depResults.reduce((s, d) => s + d.runtimeTargetCount, 0);
  const depRuntimePassed = depResults.reduce(
    (s, d) => s + d.targets.filter((t) => t.runtimeRelevant && !t.waived && t.pass).length, 0,
  );
  const dependencyEntriesPass = depResults.every((d) => d.pass);

  // ---------------- 3. 主进程本地 import 图 ----------------
  const importGraph = {
    pass: true,
    entry: redact(mainResolved),
    reachableFileCount: 0,
    externalSpecCount: 0,
    externals: [],
    reachableFiles: [],
    emptyFiles: [],
    unresolved: [],
    skippedNodeModules: [],
  };

  if (mainResolved) {
    const visited = new Set();
    const externals = new Set();
    const queue = [mainResolved];
    const unresolved = [];
    const emptyFiles = [];
    const skippedNodeModules = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);

      const bytes = source.sizeOf(current);
      if (bytes <= 0) {
        emptyFiles.push(redact(current));
        noteFailure('importGraph', '可达文件非空', `文件为 0 字节: ${current}`, current);
        continue;
      }

      let code = '';
      try {
        code = source.read(current).toString('utf8');
      } catch (err) {
        noteFailure('importGraph', '可达文件可读', `读取失败: ${current} (${err.message})`, current);
        continue;
      }

      for (const spec of extractSpecifiers(code)) {
        if (!spec.startsWith('.')) {
          externals.add(spec);
          continue;
        }
        const info = resolveLocalImport(source, current, spec);
        if (!info.resolved) {
          unresolved.push({ from: redact(current), spec: redact(spec), expected: redact(info.expected) });
          noteFailure('importGraph', '相对 import 可解析',
            `${current} -> ${spec} (期望 ${info.expected})`, info.expected);
          continue;
        }
        const target = info.resolved;
        // 不把 node_modules 内部当作本地相对路径继续展开（依赖内部由第 2 类断言覆盖）。
        if (target.includes('/node_modules/')) {
          if (!source.hasFile(target) || source.sizeOf(target) <= 0) {
            noteFailure('importGraph', 'node_modules 内相对目标', `缺失或为空: ${target}`, target);
          }
          skippedNodeModules.push(redact(target));
          continue;
        }
        if (!visited.has(target)) queue.push(target);
      }
    }

    importGraph.reachableFileCount = visited.size;
    importGraph.reachableFiles = [...visited].map((n) => redact(n)).sort();
    importGraph.externals = [...externals].map((s) => redact(s)).sort();
    importGraph.externalSpecCount = externals.size;
    importGraph.emptyFiles = emptyFiles;
    importGraph.unresolved = unresolved;
    importGraph.skippedNodeModules = [...new Set(skippedNodeModules)].sort();
    importGraph.pass = unresolved.length === 0 && emptyFiles.length === 0;
  } else {
    importGraph.pass = false;
  }

  // ---------------- 汇总 ----------------
  const ok = basicPass && dependencyEntriesPass && importGraph.pass;
  const report = {
    schemaVersion: 1,
    ok,
    generatedAt: new Date().toISOString(),
    tool: { name: 'check-package.mjs', runtime: `node ${process.version}` },
    input: {
      mode: ctx.mode,
      path: redactUserPath(ctx.inputPath),
      bytes: ctx.inputBytes,
      sha256: ctx.sha256,
      gbkNamesRecovered: source.gbkNamesRecovered || 0,
      utf8FlagEntries: source.utf8FlagEntries || 0,
    },
    roots: {
      installRoot: redact(roots.installRoot),
      appRoot: redact(roots.appRoot),
      appPackage: redact(roots.appPackage),
      main: redact(mainSpec),
      version: appVersion,
    },
    packageStats: {
      totalEntries: source.entries.size,
      totalFiles,
      totalBytes,
      totalDirectories: source.entries.size - totalFiles,
    },
    assertions: {
      basic: { pass: basicPass, checks: basicChecks.map((c) => ({ ...c, detail: redact(c.detail) })) },
      dependencyEntries: {
        pass: dependencyEntriesPass,
        dependencyCount: dependencies.length,
        runtimeTargetCount: depRuntimeTargets,
        runtimeTargetPassed: depRuntimePassed,
        dependencies: depResults,
        exemptions,
      },
      importGraph,
    },
    missingFiles: [...missingFiles].sort(),
    failures,
    warnings,
    exitCode: ok ? 0 : 1,
  };
  return report;
}

// ---------------------------------------------------------------------------
// 控制台摘要
// ---------------------------------------------------------------------------

/** @param {object} r 报告对象。 @param {string} reportPath 实际报告输出路径。 */
function printSummary(r, reportPath) {
  const line = '─'.repeat(66);
  console.log('');
  console.log('══════════════ 发布包启动完整性检查 ══════════════');
  console.log(`输入      : ${r.input.mode.toUpperCase()}  ${r.input.path}`);
  if (r.input.sha256) console.log(`SHA-256   : ${r.input.sha256}`);
  console.log(`定位      : installRoot="${r.roots.installRoot}"  appRoot="${r.roots.appRoot}"`);
  console.log(`包体      : ${r.packageStats.totalFiles} 文件 / ${fmtBytes(r.packageStats.totalBytes)} B（未压缩），${r.packageStats.totalDirectories} 目录条目`);
  if (r.input.mode === 'zip') {
    console.log(`中文名    : GBK 还原 ${r.input.gbkNamesRecovered} 条，UTF-8 flag 条目 ${r.input.utf8FlagEntries} 条`);
  }
  console.log(`版本      : ${r.roots.version}   main=${r.roots.main}`);
  console.log(line);

  const b = r.assertions.basic;
  console.log(`[1/3] 基础断言           ${b.pass ? '[PASS]' : '[FAIL]'}  ${b.checks.filter((c) => c.pass).length}/${b.checks.length}`);
  for (const c of b.checks) console.log(`       ${c.pass ? '[OK]  ' : '[FAIL]'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);

  const d = r.assertions.dependencyEntries;
  console.log(`[2/3] 依赖入口断言       ${d.pass ? '[PASS]' : '[FAIL]'}  ${d.runtimeTargetPassed}/${d.runtimeTargetCount} 运行时目标，${d.dependencyCount} 个依赖，豁免 ${d.exemptions.length} 项`);
  for (const dep of d.dependencies) {
    const bad = dep.targets.filter((t) => t.runtimeRelevant && !t.waived && !t.pass);
    console.log(`       ${dep.pass ? '[OK]  ' : '[FAIL]'} ${dep.name}@${dep.version || '?'}  运行时目标 ${dep.runtimeTargetCount}，豁免 ${dep.waivedTargetCount}`);
    for (const t of bad) console.log(`              -> 缺失 ${t.field} : ${t.spec} => ${t.resolved} (${t.error || ''})`);
  }
  if (d.exemptions.length > 0) {
    console.log('       豁免明细（仅类型声明，不影响启动）:');
    for (const e of d.exemptions) console.log(`              - ${e.dependency} ${e.field} -> ${e.resolved}`);
  }

  const g = r.assertions.importGraph;
  console.log(`[3/3] 主进程 import 图   ${g.pass ? '[PASS]' : '[FAIL]'}  可达 ${g.reachableFileCount} 文件 / 外部 ${g.externalSpecCount} 模块 / 未解析 ${g.unresolved.length} / 空文件 ${g.emptyFiles.length}`);
  for (const u of g.unresolved) console.log(`              -> 未解析 ${u.from} : ${u.spec} => ${u.expected}`);
  for (const e of g.emptyFiles) console.log(`              -> 空文件 ${e}`);
  console.log(line);

  if (r.missingFiles.length > 0) {
    console.log(`缺失 / 异常文件清单 (${r.missingFiles.length}):`);
    for (const f of r.missingFiles) console.log(`       - ${f}`);
  }
  if (r.warnings.length > 0) {
    console.log(`提示 (${r.warnings.length}):`);
    for (const w of [...new Set(r.warnings)].slice(0, 10)) console.log(`       ! ${redact(w)}`);
  }
  console.log(line);
  console.log(`结论      : ${r.ok ? 'PASS  发布包启动完整性检查通过' : 'FAIL  发布包存在启动完整性缺陷'}`);
  console.log(`报告      : ${redactUserPath(reportPath)}`);
  console.log(`退出码    : ${r.exitCode}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    '用法:',
    '  node check-package.mjs --zip <path> [--report <path>]',
    '  node check-package.mjs --dir <path> [--report <path>]',
    '  node check-package.mjs --help',
    '',
    '  --zip   指向发布 zip（自动还原 GBK 中文条目名）',
    '  --dir   指向已解包的安装根目录',
    '  --report  报告输出路径，默认 <仓库根>/dist/package-report.json',
    '',
    '退出码: 0 = 全部通过；1 = 存在缺陷或输入错误',
  ].join('\n');
}

/** 解析 argv，支持 --key value 与 --key=value。 */
function parseArgs(argv) {
  const opts = { zip: '', dir: '', report: DEFAULT_REPORT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    const eq = arg.indexOf('=');
    let key = arg;
    let value = '';
    if (arg.startsWith('--') && eq > 2) {
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (arg.startsWith('--')) {
      value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
      if (value) i += 1;
    }
    if (key === '--zip') opts.zip = value;
    else if (key === '--dir') opts.dir = value;
    else if (key === '--report') opts.report = value || DEFAULT_REPORT;
    else throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

/** 写出报告（父目录不存在则创建），失败时给出明确提示。 */
function writeReport(reportPath, report) {
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.error(`[错误] 报告写入失败: ${redactUserPath(reportPath)} (${err.message})`);
    return false;
  }
}

/** 构造输入错误时的最小报告。 */
function errorReport(message, mode, inputPath) {
  return {
    schemaVersion: 1,
    ok: false,
    generatedAt: new Date().toISOString(),
    input: { mode: mode || 'unknown', path: redactUserPath(inputPath) },
    error: redact(message),
    missingFiles: [],
    failures: [{ category: 'input', name: '输入与参数', detail: redact(message) }],
    exitCode: 1,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[错误] ${err.message}\n\n${usage()}`);
    writeReport(DEFAULT_REPORT, errorReport(err.message, 'unknown', ''));
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  const hasZip = !!opts.zip;
  const hasDir = !!opts.dir;
  if (hasZip === hasDir) {
    const msg = '必须且只能指定 --zip 或 --dir 其中之一';
    console.error(`[错误] ${msg}\n\n${usage()}`);
    writeReport(opts.report, errorReport(msg, 'unknown', opts.zip || opts.dir));
    process.exitCode = 1;
    return;
  }

  const mode = hasZip ? 'zip' : 'dir';
  const inputPath = hasZip ? opts.zip : opts.dir;
  let source = null;
  let inputBytes = 0;
  let sha256 = '';

  try {
    const resolved = path.resolve(inputPath);
    if (mode === 'zip') {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`zip 文件不存在或不是普通文件: ${redactUserPath(inputPath)}`);
      }
      const buf = fs.readFileSync(resolved);
      inputBytes = buf.length;
      sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      source = new ZipSource(buf);
    } else {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`目录不存在: ${redactUserPath(inputPath)}`);
      }
      source = new DirSource(resolved);
      inputBytes = [...source.entries.values()]
        .filter((e) => !e.isDir)
        .reduce((s, e) => s + e.size, 0);
    }
  } catch (err) {
    console.error(`[错误] ${redact(err.message)}`);
    writeReport(opts.report, errorReport(err.message, mode, inputPath));
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = runChecks({ source, mode, inputPath, inputBytes, sha256 });
  } catch (err) {
    console.error(`[错误] 检查过程中止: ${redact(err.message)}`);
    report = errorReport(err.message, mode, inputPath);
  }

  printSummary(report, opts.report);
  writeReport(opts.report, report);
  process.exitCode = report.exitCode;
}

main();
