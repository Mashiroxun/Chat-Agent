// QQ 头像本地缓存（2026-11-04；2026-11-05 修复坏档）
//
// 为什么需要：记忆卡片等处的头像原来直连 q1.qlogo.cn —— 每次渲染都走一遍
// DNS + TLS + CDN 往返（慢则一两秒），且 CDN 响应不带长期缓存头，Electron 的
// HTTP 缓存帮不上忙，表现为"头像半天不出来、先看见彩色圆/首字"。
//
// 做法：头像请求改走本进程的 /api/avatar/:qq 路由 → 这里先查本地磁盘缓存
// （data/avatar-cache/<qq>_<size>.jpg），命中直接回；未命中才用 safeFetchBinary
// 拉 q1.qlogo.cn，落盘后回。头像变化频率以天计，TTL 给 7 天。
//
// 失败处理：拉取失败（网络断/CDN 抽风/号码无效）做**负缓存**（内存里记 10 分钟），
// 期间同一头像不再出网，直接让路由回 404 —— UI 那边本来就有"首字兜底"，
// 404 触发 img 的 error 事件正好走兜底，不会白等。
//
// 2026-11-05 审查修复（P1）：旧实现只看 buffer.length，把 CDN 错误页（HTML）
// 或写到一半断电留下的半截 JPEG 当有效图片缓存 7 天，浏览器侧又有 max-age
// 7 天 —— 一旦坏档就一直破图，负缓存和重拉都管不到。现在：
//   · 下载与读缓存都按**魔数**验真，并据此给真实 Content-Type（不再硬编码 jpeg）；
//   · 坏档直接删除、按未命中重拉；
//   · 落盘走「临时文件 + rename」原子替换，进程被杀也不会留半截正式文件；
//   · prune 顺手清掉超过 1 小时的 .tmp 残留。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { safeFetchBinary } from './safe-fetch.js';
import { expiredSinceFile, withinWindow } from './elapsed.js';

const MAX_BYTES = 512 * 1024;                       // 头像最大 512KB（qlogo s=640 实测 <100KB，余量足够）
const TTL_MS = 7 * 24 * 60 * 60 * 1000;             // 缓存 7 天（头像改起来以天计）
const NEG_TTL_MS = 10 * 60 * 1000;                  // 拉取失败的负缓存：10 分钟内不重试
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;           // 过期清理节流
const TMP_MAX_AGE_MS = 60 * 60 * 1000;              // 原子写残留的临时文件，超过 1 小时清掉
// 负缓存 Map 的容量上限（E8，2026-11-12 审查）：`negative` 是纯内存 Map，
// 每个拉取失败的头像留一条，从来没有过期清理。大群/长跑场景下群成员数 × 尺寸档位
// 可以堆到几千条 —— 单条不大，但这是"只增不减"的结构，且没有任何上限兜底。
// 超过阈值时先清掉已过 NEG_TTL_MS 的条目；仍然超限就整体清空（负缓存只是省流量的
// 优化，丢了下次重试一次而已，绝不能为了它撑爆内存）。
const NEG_MAX_ENTRIES = 2000;

// 允许的尺寸白名单：只放全站实际用到的几档，不接受任意值拼 URL。
// 导出给 /api/avatar 路由做参数校验，避免两处各写一份慢慢漂移。
export const AVATAR_SIZES = new Set([40, 100, 140, 640]);
const CACHE_FILE_RE = /^\d{5,12}_(40|100|140|640)\.jpg$/;

const dir = () => path.join(DATA_DIR, 'avatar-cache');

// 并发去重：同一头像同时只有一个请求在出网，其余等同一个 Promise。
const inflight = new Map();       // `${qq}|${size}` → Promise<{buffer,contentType}|null>
const negative = new Map();       // `${qq}|${size}` → 失败时间戳
let lastPrune = 0;

function fileOf(qq, size) {
  // qq 已由路由白名单限定为 5~12 位纯数字，size 在白名单内 —— 无路径注入面。
  return path.join(dir(), `${qq}_${size}.jpg`);
}

/**
 * 按魔数判断真实图片类型。比 CDN 的 Content-Type 可信：错误页/限流页常带 200，
 * 头也可能写成 image/*，但字节不是图片。非图片返回 null。
 * 导出为纯函数供单测直接覆盖（不出网）。
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const b = buffer;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
    && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'; // GIF8
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF'
    && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return null;
}

function dropFile(p) { try { fs.unlinkSync(p); } catch { /* 已被删/不存在 */ } }

/**
 * 负缓存 Map 的容量控制（E8）。
 * 正常情况下只需要清过期条目；极端情况下（一次性遇到几千个失败头像）直接清空 ——
 * 负缓存的作用只是"别在 10 分钟内反复打同一个坏地址"，清空的代价是可以接受的。
 * @param {number} now
 */
export function pruneNegative(now = Date.now()) {
  if (negative.size <= NEG_MAX_ENTRIES) return;
  for (const [key, at] of negative) {
    if (!withinWindow(at, NEG_TTL_MS, now)) negative.delete(key);
  }
  if (negative.size > NEG_MAX_ENTRIES) negative.clear();
}

/** 测试用：重置并填充负缓存（`${qq}|${size}` → 失败时间戳）。 */
export function __seedNegativeForTest(entries) {
  negative.clear();
  for (const [key, at] of entries) negative.set(key, at);
}

/** 测试用：当前负缓存的键列表（断言"哪些被清掉了"）。 */
export function __negativeKeysForTest() {
  return [...negative.keys()];
}

function prune() {
  const now = Date.now();
  if (withinWindow(lastPrune, PRUNE_INTERVAL_MS, now)) return;
  lastPrune = now;
  pruneNegative(now);
  try {
    for (const f of fs.readdirSync(dir())) {
      const p = path.join(dir(), f);
      if (f.endsWith('.tmp')) {
        try { if (expiredSinceFile(fs.statSync(p).mtimeMs, TMP_MAX_AGE_MS, now)) fs.unlinkSync(p); } catch { /* 忽略 */ }
        continue;
      }
      if (!CACHE_FILE_RE.test(f)) continue;
      try { if (expiredSinceFile(fs.statSync(p).mtimeMs, TTL_MS, now)) fs.unlinkSync(p); } catch { /* 忽略 */ }
    }
  } catch { /* 目录还不存在等，忽略 */ }
}

/** 从本地缓存读头像。没有 / 过期 / 内容不是图片，都返回 null（坏档顺手删掉）。 */
function readCache(qq, size) {
  const p = fileOf(qq, size);
  let buffer;
  let expired = false;
  try {
    const st = fs.statSync(p);
    expired = expiredSinceFile(st.mtimeMs, TTL_MS);
    // ⚠️ 不在过期时提前 return：坏档校验与删除必须照常跑，否则一张错误页
    //    会永远留在盘上（每次读都返回 null、浏览器又按 max-age 缓着破图）。
    buffer = fs.readFileSync(p);
  } catch {
    return null;
  }
  const contentType = sniffImageType(buffer);
  if (!contentType) {
    // 关键：不删的话 7 天 TTL + 浏览器 max-age 会让这张头像一直破着，
    // 而且命中缓存直接 return，负缓存/重拉都没机会介入。
    dropFile(p);
    logger.warn('avatar-cache', `缓存内容不是图片，已丢弃并重拉 ${qq} s=${size}`);
    return null;
  }
  if (expired) return null;   // 内容没问题但过期了 → 走重拉（重拉成功会覆盖）
  return { buffer, contentType };
}

async function downloadOne(qq, size) {
  const url = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=${size}`;
  const dest = fileOf(qq, size);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    const { buffer } = await safeFetchBinary(url, MAX_BYTES, { timeoutMs: 8000 });
    const contentType = sniffImageType(buffer);
    if (!contentType) throw new Error('响应不是图片（CDN 错误页 / 半截数据）');
    fs.mkdirSync(dir(), { recursive: true });
    // 原子落盘：先写完整临时文件再 rename。直接 writeFileSync 到正式路径时，
    // 掉电或被杀会留下半截 .jpg，读缓存又只验长度就吃进去了。
    fs.writeFileSync(tmp, buffer);
    try {
      fs.renameSync(tmp, dest);
    } catch {
      // Windows 上目标已存在时偶发 EEXIST：删掉旧档再换一次，仍是完整文件换入。
      dropFile(dest);
      fs.renameSync(tmp, dest);
    }
    return { buffer, contentType };
  } catch (e) {
    dropFile(tmp);
    negative.set(`${qq}|${size}`, Date.now());
    logger.warn('avatar-cache', `拉取头像失败 ${qq} s=${size}：${String(e?.message || e).slice(0, 100)}`);
    return null;
  }
}

/**
 * 取头像（先本地缓存，未命中出网拉一次）。
 * @param {string} qq  5~12 位纯数字 QQ 号
 * @param {number} size 40/100/140/640；不传默认 100，非法值一律 null（不静默回落）
 * @returns {Promise<{buffer:Buffer,contentType:string}|null>} null = 拉不到（调用方回 404）
 */
export async function getAvatar(qq, size) {
  const id = String(qq ?? '').trim();
  // ⚠️ 不用 `Number(size) || 100`：那会把 0 / NaN / 'abc' / 空串洗成合法的 100 档，
  //    路由注释写的「非法尺寸一律 404」就成了假的。区分「没传」与「传了非法值」。
  // 只有「没传」才默认 100；空串属于「传了非法值」，Number('')=0 会被白名单挡掉，
  // 与路由层 `raw === null ? 100 : Number(raw)` 口径一致。
  const s = (size === undefined || size === null) ? 100 : Number(size);
  if (!/^\d{5,12}$/.test(id)) return null;
  if (!AVATAR_SIZES.has(s)) return null;
  const key = `${id}|${s}`;
  const hit = readCache(id, s);
  if (hit) return hit;
  // 负缓存期内不再出网（UI 有首字兜底，404 是可接受的答案）
  const negAt = negative.get(key);
  if (negAt && withinWindow(negAt, NEG_TTL_MS)) return null;
  // 并发去重：同头像共用同一次下载
  if (!inflight.has(key)) {
    const p = downloadOne(id, s)
      .then((r) => { if (r) negative.delete(key); return r; })   // 成功后清掉旧失败记录
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    prune();                                     // 内部有节流
  }
  return inflight.get(key);
}

/** 测试/运维用：当前缓存张数与占用字节。 */
export function avatarCacheStats() {
  let count = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir())) {
      if (!CACHE_FILE_RE.test(f)) continue;
      try {
        count += 1;
        bytes += fs.statSync(path.join(dir(), f)).size;
      } catch { /* 文件可能已被并发删除 */ }
    }
  } catch { /* 目录不存在 */ }
  return { count, bytes };
}

/** 测试用：只读磁盘缓存、不触发出网，用来验证坏档清理（getAvatar 未命中会下载）。 */
export function __readAvatarCacheForTest(qq, size) {
  return readCache(String(qq), Number(size));
}
