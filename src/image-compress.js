// 图片压缩：把过大的图片缩到模型可接受的尺寸/体积，降低 token 成本与传输开销。
//
// 背景：QQ 图床的原图可能几 MB 甚至十几 MB，直接 base64 给模型既贵又慢，
// 很多视觉模型对超大图还会拒收或报错。这里在下载后、给模型前做一道压缩。
//
// 实现：项目没有图像处理库（无 sharp/jimp），用 ffmpeg（video-reader 已探测）做缩放。
//   - 有 ffmpeg：按最长边缩到 maxDim，并重编码为 JPEG（质量可调）
//   - 无 ffmpeg：原样返回（不压缩，保持旧行为）
// 判断"是否过大"：优先按像素（需 ffprobe/ffmpeg 读尺寸），读不到尺寸时按字节数兜底。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectImageType, mimeToExt } from './image-type.js';
import { logger } from './logger.js';
import { spawn } from 'node:child_process';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? true : null); });
  });
}

/**
 * 自带 ffmpeg 的候选路径（2026-10-16）。
 *
 * 背景：这台机器上 PATH 里**没有** ffmpeg，导致 compressImage 恒定走
 * "无 ffmpeg → 原样返回"的分支：群友发一张 4.7MB 的原图，base64 后
 * 就是 6,536,979 字符的请求体（实测 22:38:20），三道防线全部失效 ——
 * capRequestBodyMedia 只处理"多个媒体"（这里只有一个，且是最新的），
 * 而 compressImage 的 maxBytes=4MB 门槛根本没被触发。
 *
 * 所以把 ffmpeg 随应用一起放在 resources/app/runtime/ 下，探测时优先
 * 试它，找不到再回退 PATH。这样图片压缩在任何机器上都能生效，
 * 不依赖用户是否装过 ffmpeg、也不依赖 PATH。
 */
function bundledFf(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const roots = [
    // 源码运行：src/ 的上一级就是 app/
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'runtime', exe),
    // 打包后：app.asar 里的 src/ → 同一层
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'runtime', exe),
  ];
  for (const p of roots) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

let _ffmpeg = null;
let _ffprobe = null;
let _checkedAt = 0;   // 上次探测完成的时间戳
const REPROBE_MS = 60_000;
async function ensureFf() {
  // 缓存策略：探测到的东西终身缓存（二进制不会中途消失）；但探测不到的不缓存
  // 终身 —— 首次探测时 ffmpeg 可能还没装（先启动 App、后装工具链是正常顺序），
  // 旧实现一旦探空就永远探空。缺失项最多每 60s 重探一次（探测本身要 spawn 子进程）。
  const needReprobe = (_ffmpeg == null || _ffprobe == null) && Date.now() - _checkedAt >= REPROBE_MS;
  if (_checkedAt && !needReprobe) return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
  _checkedAt = Date.now();
  // ① 先用自带的（保证任何机器都能压缩，不依赖用户环境）
  _ffmpeg = bundledFf('ffmpeg');
  _ffprobe = bundledFf('ffprobe');
  // ② 自带没有再找 PATH
  if (!_ffmpeg) {
    for (const name of ['ffmpeg', 'ffmpeg.exe']) {
      if (await run(name, ['-version'], 5000)) { _ffmpeg = name; break; }
    }
  }
  if (!_ffprobe) {
    for (const name of ['ffprobe', 'ffprobe.exe']) {
      if (await run(name, ['-version'], 5000)) { _ffprobe = name; break; }
    }
  }
  // ⚠️ 探不到 ffmpeg 时**必须告警**：静默原样返回会让"图片没被压缩"这件事
  // 完全不可见 —— 2026-10-16 那次 6.5MB 的请求体就是这么查了半天才找到。
  if (!_ffmpeg) {
    logger.warn('image-compress', '⚠️ 未找到 ffmpeg（大图将不压缩，请求体可能涨到数 MB）。把 ffmpeg 放到 resources/app/runtime/ 即可修复。');
  }
  return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
}

/** 用 ffprobe 读图片尺寸。 */
async function imageSize(ffprobe, filePath) {
  const out = await new Promise((resolve) => {
    let txt = '';
    let child;
    try {
      child = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10000);
    child.stdout.on('data', (d) => { txt += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(txt);
        const s = (j.streams || []).find((x) => x.codec_type === 'video' || x.width);
        resolve(s && s.width ? { width: Number(s.width), height: Number(s.height) } : null);
      } catch {
        resolve(null);
      }
    });
  });
  return out;
}

/**
 * ffprobe 缺席时的尺寸兜底（2026-10-28）。
 *
 * 背景：runtime/ 下**只随包发了 ffmpeg.exe，没有 ffprobe.exe**。而 compressImage
 * 判断"要不要缩放"的唯一依据是 `imageSize(ffprobe, …)` —— 那个分支因此**从未
 * 执行过**：所有图都退化成"字节 > 4MB 才压"。
 *
 * 实测后果（本机 data/image-cache 的真实图片）：
 *   · 2400×1080 / 1304KB  → 尺寸超 1568，本该缩放，却没压
 *   · 1920×1200 / 2444KB  → 同上
 *   · 这些图 base64 后是 177 万 ~ 333 万字符，直接进请求体
 *   · 日志实锤：09:09:56 一次请求 body 达 2,440,794 字符，耗时 9 秒
 *
 * 修法：ffprobe 不可用时，用 ffmpeg 自己打印的流信息读尺寸。
 * `ffmpeg -i <file>` 不产出文件时会以非 0 退出，但 stderr 里带
 * `Stream #0:0: Video: …, 1920x1200` 这样的尺寸串 —— 够用了。
 * 拿不到就返回 null，调用方继续按字节数判断（保持旧行为）。
 */
async function imageSizeViaFfmpeg(ffmpeg, filePath) {
  return new Promise((resolve) => {
    let txt = '';
    let child;
    try {
      child = spawn(ffmpeg, ['-hide_banner', '-i', filePath], {
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10000);
    child.stderr.on('data', (d) => { txt += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      // 只认 "Video:" 那一行里的尺寸，避免误取到帧率（如 30x 之类）或比特率
      const line = (txt.split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l)) || '');
      const m = line.match(/(\d{2,5})x(\d{2,5})(?![0-9])/);
      resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
    });
  });
}

/**
 * 压缩一张图片（如需要）。
 * @param {Buffer} buffer 原始图片字节
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1568] 最长边上限（像素），超过则等比缩小
 * @param {number} [opts.maxBytes=512*1024] 字节上限，超过则尝试压缩
 *
 *   为什么从 4MB 降到 512KB（2026-10-28）：请求体里图片是 base64，**字节 × 1.37
 *   才是真正发出去的字符数**。4MB 这个阈值让 1~4MB 的图整段跳过压缩 —— 实测
 *   image-cache 里 1304KB / 1456KB / 1579KB / 1944KB / 2444KB 五张图全部
 *   `compressed=false`，base64 后分别是 177万 / 198万 / 215万 / 265万 / 333万字符。
 *   日志里 09:09:56 那次 body 2,440,794 字符（9 秒）就是这么来的。
 *   512KB 与下面"小图直接过"的边界对齐：>512KB 必然走压缩，压缩后通常 200~300KB
 *   （base64 约 27~41 万字符），落回 512K 字符预算内。压缩失败/没变小仍保留原图。
 * @param {number} [opts.quality=4] JPEG 质量（ffmpeg -q:v，2 最好 31 最差，4 是不错的平衡）
 * @returns {Promise<{buffer: Buffer, mime: string, compressed: boolean}>}
 */
export async function compressImage(buffer, { maxDim = 1568, maxBytes = 512 * 1024, quality = 4 } = {}) {
  const mime = detectMime(buffer) || 'image/jpeg';
  // 小图直接过（字节数就很小，没必要压缩）
  if (buffer.length <= Math.min(maxBytes, 512 * 1024)) {
    return { buffer, mime, compressed: false };
  }
  const { ffmpeg, ffprobe } = await ensureFf();
  if (!ffmpeg) {
    // 无 ffmpeg：无法压缩，原样返回（保持旧行为）
    return { buffer, mime, compressed: false };
  }
  // 写到临时文件 → ffmpeg 缩放 → 读回
  const tmpIn = path.join(os.tmpdir(), `qqa_img_in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${extOf(mime)}`);
  const tmpOut = path.join(os.tmpdir(), `qqa_img_out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // 判断是否超过最长边（ffprobe 优先；缺席时用 ffmpeg 兜底，见 imageSizeViaFfmpeg）
    let needResize = buffer.length > maxBytes;
    let size = null;
    if (ffprobe) size = await imageSize(ffprobe, tmpIn);
    if (!size) size = await imageSizeViaFfmpeg(ffmpeg, tmpIn);
    if (size && (size.width > maxDim || size.height > maxDim)) needResize = true;
    if (!needResize) return { buffer, mime, compressed: false };
    // ffmpeg：等比缩放到最长边 maxDim，重编码 JPEG
    const okRun = await run(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(quality),
      tmpOut
    ], 25000);
    if (okRun && fs.existsSync(tmpOut)) {
      const compressed = fs.readFileSync(tmpOut);
      // 只有真的变小了才用压缩结果（否则保留原图）
      if (compressed.length && compressed.length < buffer.length) {
        return { buffer: compressed, mime: 'image/jpeg', compressed: true };
      }
    }
    return { buffer, mime, compressed: false };
  } catch {
    return { buffer, mime, compressed: false };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

// 类型嗅探与 MIME→扩展名统一放在 image-type.js（曾经这里/tools.js/sticker-manager.js
// 各有一份实现，容易各自演化出不一致的行为）。
function detectMime(buf) {
  return detectImageType(buf)?.mime ?? null;
}

function extOf(mime) {
  return mimeToExt(mime);
}
