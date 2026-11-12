// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../../src/config.js';
import { safeFetchBinary } from '../../../src/safe-fetch.js';
import { detectImageExt } from '../../../src/image-type.js';
import { withinWindow, expiredSinceFile } from '../../../src/elapsed.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary, isStickerFetchComplete,
  findSticker, findStickerExact, formatStickerList, applyStickerNote, markStickerUsed,
  loadHiddenSet, saveHiddenSet, visibleEntries, isHidden, mergeDiskStickerStore,
  describeStickerPayload
} from './stickers.js';

/**
 * 同步收藏时向协议端请求的条数。
 *
 * ⚠️ 这个数**不该**跟 `promptMaxStickers` 挂钩（R129 修）。`promptMaxStickers` 是
 * 「每次往提示词里列几个表情」——一个**提示词预算**设置，默认 10；旧实现用
 * `promptMaxStickers * 10` 当拉取量（默认 100），等于让"提示词里想列几个"
 * 顺手决定了"本地库最多存几个"：收藏超过 100 张的用户每次同步都会把多出来的
 * 永久删掉。两件事没有关系，所以这里用独立的常量。
 *
 * 500 是协议端的上限（旧代码里也是 `Math.min(500, …)`）。请求上限值还有个额外好处：
 * 「拿到的条数 < 请求的条数」就成了"服务端已经把收藏给完了"的可靠证据
 * （见 stickers.js 的 isStickerFetchComplete）—— 剪枝只在这条证据成立时才做。
 */
const SYNC_FETCH_COUNT = 500;

// ── 同步异常降频（2026-11-11，反馈第 10 条）──────────────────────────────
// 病灶：`fetch_custom_face_detail` 如果在该协议端不生效，会稳定返回空数组。
// 那时 sync 仍算"成功"，定时器每 60 秒照打一次，日志里堆出上千行
// `本次拿到 0 条（请求 500）` —— 既没信息量，又把真正的诊断信息（返回形状）
// 漏掉了。所以：连续异常先降频，第一次异常必须把**返回形状**记下来。
const SYNC_PROBLEM_LOG_EVERY_MS = 30 * 60 * 1000;   // 同类异常日志 30 分钟最多一行
const SYNC_EMPTY_STREAK_BEFORE_BACKOFF = 3;         // 连续 3 次异常才开始降频
const SYNC_BACKOFF_BASE_MS = 60000;                 // 正常间隔
const SYNC_BACKOFF_MAX_MS = 30 * 60000;             // 封顶 30 分钟

// ── 面板素材（缩略图 / 网络图缓存）─────────────────────────────────────────
//
// 2026-10-28：查看器崩溃排查的产物。两条素材管线：
//   · 本地 GIF → <id>.thumb.jpg   （多帧 GIF 直接把渲染进程打崩，网格只加载首帧）
//   · 网络图   → net_<id>.jpg     （25 张 CDN 图要 3 个跨网 RTT，落地后秒开）
// 生成器用随包的 ffmpeg（src/image-compress.js 也是这么做的，项目没有 sharp/jimp）。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// ⚠️ Windows 上是 runtime/ffmpeg.exe（带扩展名），spawn 一个无扩展名的路径会 ENOENT ——
//    2026-10-28 踩过：hydrate 静默返回 0，一张素材都没生成。
const FFMPEG_BIN = path.join(APP_ROOT, 'runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/** 统一命名：id → 文件名安全片段（与 materializeThumbs 原逻辑保持一致）。 */
function safeStickerId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'sticker';
}

/**
 * 原子写一个文件：先写同目录临时名，再 rename 覆盖。
 *
 * 为什么必须原子（2026-10-28 审计）：`fs.writeFileSync(dest, buf)` 直写目标文件名，
 * 进程被杀 / 断电 / 磁盘满都会留下**半张图**。而"缓存是否可用"的判据是
 * `existsSync` —— 残片会被当成可用图片：面板上是一个破图，发送时发出去的是
 * 一个坏文件，而且因为"文件存在"永远不会重下，只能手工删。
 * rename 在同分区上是原子的，所以读者要么看到旧文件、要么看到完整新文件。
 */
function writeFileAtomic(dest, buf) {
  const tmp = `${dest}.${process.pid}.${Date.now().toString(36)}.part`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能根本没建出来 */ }
    throw error;
  }
}

/** 文件"存在且非空"才算可用素材（残片一律当作没有，交给下次重新生成）。 */
function isUsableFile(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

/** 调一次 ffmpeg，成功返回 true。失败/超时都不抛，调用方按"没生成"处理。 */
function runFfmpeg(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: 'ignore' });
    } catch { resolve(false); return; }
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
    child.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * 让 ffmpeg 把结果**原子地**落到 dest。
 *
 * 为什么要绕这一层（2026-10-28 审计）：ffmpeg 直接输出到目标文件名时，
 * 中途失败/超时会留下一个非空但不完整的文件 —— 而"素材是否就绪"的判据是
 * `existsSync`，于是坏文件永远不会被重建：面板上是破图、详情页是黑屏。
 *
 * ⚠️ 临时名必须**保留原扩展名**（`.tmp_xxx.mp4` 而不是 `xxx.mp4.part`）：
 *    ffmpeg 靠扩展名选容器格式，改成 `.part` 会直接报 "Unable to find a
 *    suitable output format"，连转都转不出来。
 */
async function ffmpegInto(dest, src, extraArgs = [], timeoutMs = 15000) {
  const tmpOut = path.join(path.dirname(dest), `.tmp_${path.basename(dest)}`);
  try { fs.unlinkSync(tmpOut); } catch { /* 上一轮的残留，不存在也无所谓 */ }
  const ok = await runFfmpeg(
    ['-y', '-loglevel', 'error', '-i', src, ...extraArgs, tmpOut], timeoutMs
  );
  if (ok && isUsableFile(tmpOut)) {
    try { fs.renameSync(tmpOut, dest); return true; } catch { /* 落到下面清理 */ }
  }
  try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  return false;
}

export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    // ⚠️ 必须校验**非空**（R130 修）：写入被中断会留下 0 字节的残骸，
    //   它"存在且是文件"，于是会被当成可用的本地转存 —— 表情从此永久发不出去
    //   （D2 每次同步都把它粘回来，也换不回远端直链）。
    if (fs.statSync(full).size <= 0) return null;
  } catch { return null; }
  return full;
}

export class StickerManager {
  constructor(api) {
    this.api = api;
    // entries 始终是**完整库**（含已隐藏条目）。隐藏只是把 id 记进 this.hidden，
    // 由 visible() 在消费点摘出去 —— 详见 lib/stickers.js 的隐藏名单注释。
    this.entries = loadStickerStore();
    this.hidden = loadHiddenSet();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
    // 同步异常状态（见文件头 SYNC_* 常量注释）：
    //   emptyStreak  连续"拿到 0 条 / 调用失败"的次数，拿到非空即清零
    //   backoffUntil 降频截止时间；force=true 时忽略（用户主动刷新要立刻试）
    //   backoffLogged 本轮降频是否已提示过，避免每次延长都刷一行
    //   lastProblemLogAt 异常日志节流时间戳
    //   backoffAt/backoffMs 降频起点与时长（时钟回拨安全，见 src/elapsed.js）
    this.emptyStreak = 0;
    this.backoffUntil = 0;   // 保留供恢复提示判断；实际窗口判定用 backoffAt/backoffMs
    this.backoffAt = 0;
    this.backoffMs = 0;
    this.backoffLogged = false;
    this.lastProblemLogAt = 0;
  }

  /**
   * 记一次同步异常（空结果或调用失败），必要时降频。
   *
   * 为什么要节流 + 降频：反馈里那台机器 1015 行日志里没有一行能看出"协议端
   * 返回了什么"，噪音盖住了信号。这里把"第一次异常"和"降频动作"各记一行，
   * 其余同类异常静默 —— 信息量不降，行数从上千降到个位。
   * @param {string} text 已经写好的诊断文案
   */
  #noteSyncProblem(text) {
    this.emptyStreak = Math.min((this.emptyStreak || 0) + 1, 20);
    const now = Date.now();
    if (!this.lastProblemLogAt || !withinWindow(this.lastProblemLogAt, SYNC_PROBLEM_LOG_EVERY_MS, now)) {
      this.lastProblemLogAt = now;
      try { this.api?.log?.(text); } catch { /* 日志失败不影响同步 */ }
    }
    if (this.emptyStreak >= SYNC_EMPTY_STREAK_BEFORE_BACKOFF) {
      const ms = Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_BASE_MS * 2 ** (this.emptyStreak - 2));
      this.backoffUntil = now + ms;
      this.backoffAt = now;
      this.backoffMs = ms;
      if (!this.backoffLogged) {
        this.backoffLogged = true;
        try {
          this.api?.log?.(`收藏同步连续 ${this.emptyStreak} 次异常，已自动降频到每 ${Math.max(1, Math.round(ms / 60000))} 分钟一次（拿到数据后自动撤销）`);
        } catch { /* ignore */ }
      }
    }
  }

  /** 同步恢复正常：清空异常状态与降频。 */
  #noteSyncRecovered(count) {
    if (this.emptyStreak >= SYNC_EMPTY_STREAK_BEFORE_BACKOFF || this.backoffUntil) {
      try { this.api?.log?.(`收藏同步已恢复（拿到 ${count} 条），降频撤销`); } catch { /* ignore */ }
    }
    this.emptyStreak = 0;
    this.backoffUntil = 0;   // 保留供恢复提示判断；实际窗口判定用 backoffAt/backoffMs
    this.backoffAt = 0;
    this.backoffMs = 0;
    this.backoffLogged = false;
    this.lastProblemLogAt = 0;
  }

  /** 可见（未被隐藏）的那部分库。提示词 / list / 快照 / 发送一律用它。 */
  get visible() {
    return visibleEntries(this.entries, this.hidden);
  }

  /**
   * 隐藏（软删除）一个表情。
   * @returns {{ok: boolean, id: string|null, alreadyHidden?: boolean}}
   */
  hide(ref) {
    // ⚠️ 用**精确**匹配（`findStickerExact`），不用 findSticker 的 url 子串兜底 ——
    //    删除是破坏性操作，模糊匹配会删错对象（详见 stickers.js 的 findStickerExact 注释）。
    const target = findStickerExact(this.entries, String(ref ?? ''));
    if (!target) return { ok: false, id: null };
    const alreadyHidden = isHidden(target, this.hidden);
    // 只记 id，不记 resId：A 的 resId 有可能恰好等于 B 的 id，记了就会误伤 B。
    this.hidden.add(target.id);
    saveHiddenSet(this.hidden);
    return { ok: true, id: target.id, alreadyHidden };
  }

  /**
   * 取消隐藏（恢复）。返回被恢复的条目，供调用方回话。
   * @returns {{ok: boolean, id: string|null}}
   */
  unhide(ref) {
    const target = findStickerExact(this.entries, String(ref ?? ''));
    if (!target) return { ok: false, id: null };
    this.hidden.delete(target.id);
    saveHiddenSet(this.hidden);
    return { ok: true, id: target.id };
  }

  /** 被隐藏的条目（查看器列出"已删除"用）。 */
  hiddenEntries() {
    return this.entries.filter((e) => isHidden(e, this.hidden));
  }

  /**
   * 把"本地转存"的表情图导出一份到**页面读得到的地方**（R130 修）。
   *
   * 病灶：查看器跑在 iframe 里，只有 `/plugin-panel/sticker/@data/`
   *   （= `<DATA_DIR>/plugin-data/sticker/`）这一条通道，而本地转存是
   *   `file:///`，浏览器读不了 —— 所以面板上一律画占位。
   *   这在 D2 之前影响不大（同步会把 url 覆盖回图床直链，能热链显示），
   *   D2 让 url 稳定指向本地文件之后，**凡是发出过的表情在面板上就都看不见了**。
   *   修发送健壮性反而弄坏了面板，所以这边必须补上。
   *
   * 做法：复制到 `plugin-data/sticker/img/`，由 buildViewSnapshot 换成
   *   `../@data/img/<name>`。该目录走的是既有通道，扩展名白名单里本来就有
   *   png/jpg/webp/gif —— 不用动宿主，也不需要 ffmpeg/缩略图库。
   *   ⚠️ 是**原样复制**不是压缩：表情本来就小（几十 KB），没必要引入图像依赖。
   *
   * @returns {Map<string,string>} id → 相对 URL（页面可直接拼到 src 上）
   */
  materializeThumbs() {
    const map = new Map();
    const dir = path.join(DATA_DIR, 'plugin-data', 'sticker', 'img');
    const wanted = new Set();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return map; }
    for (const e of this.entries || []) {
      const url = String(e?.url || '').trim();
      const safeId = safeStickerId(e.id);

      // ── 网络图：有本地缓存就优先用缓存 ──────────────────────────────────
      // 缓存由 hydrate() 后台生成；没有缓存时**不**往 map 里塞东西，
      // buildViewSnapshot 会自动退回 CDN 直链（功能不受影响，只是慢一点）。
      if (!url.toLowerCase().startsWith('file:///')) {
        if (/^https?:/i.test(url)) {
          // 缓存文件名带真实扩展名（GIF 会被转成 .jpg，见 hydrate）
          for (const ext of ['.jpg', '.png', '.webp', '.jpeg', '.bmp']) {
            const cachedName = `net_${safeId}${ext}`;
            const cachedPath = path.join(dir, cachedName);
            if (!isUsableFile(cachedPath)) continue;
            wanted.add(path.resolve(cachedPath).toLowerCase());
            // 网络 GIF 也有一份 mp4（hydrate 生成）：详情页用它播动图。
            // 没有就留空，页面退回静态首帧 —— 绝不会拿原始 GIF 去喂 <img>（会崩）。
            const netMp4 = `net_${safeId}.mp4`;
            const hasMp4 = isUsableFile(path.join(dir, netMp4));
            if (hasMp4) wanted.add(path.resolve(path.join(dir, netMp4)).toLowerCase());
            // 「这张不是动图 / 转码失败」的标记也要保下来，否则会被 pruneThumbs
            // 当成孤儿删掉，下次启动又白重下一遍。
            const nomp4Path = path.join(dir, `net_${safeId}.nomp4`);
            if (fs.existsSync(nomp4Path)) wanted.add(path.resolve(nomp4Path).toLowerCase());
            map.set(e.id, {
              thumb: `../@data/img/${cachedName}`,
              video: hasMp4 ? `../@data/img/${netMp4}` : ''
            });
            break;
          }
        }
        continue;
      }

      // ── 本地转存：原样复制 ──────────────────────────────────────────────
      const src = localStickerPath(url);   // 顺带做了路径逃逸 + 非空校验
      if (!src) continue;
      const ext = path.extname(src).toLowerCase() || '.png';
      const name = `${safeId}${ext}`;
      const dest = path.join(dir, name);
      wanted.add(path.resolve(dest).toLowerCase());
      try {
        const srcSize = fs.statSync(src).size;
        // 只在"不存在"或"大小对不上"时复制，避免每次同步都重拷一遍
        let need = true;
        try { need = !isUsableFile(dest) || fs.statSync(dest).size !== srcSize; } catch { /* 读不到目标文件就按"需要复制"处理 */ }
        if (need) {
          // 同样走临时名 + rename：面板读到的要么是上一份完整副本、要么是新副本，
          // 不会是"复到一半的图"（残片会被当成可用缩略图，而且体量对不上就会每次重拷）。
          const part = `${dest}.${process.pid}.${Date.now().toString(36)}.part`;
          try { fs.copyFileSync(src, part); fs.renameSync(part, dest); }
          catch (error) { try { fs.unlinkSync(part); } catch { /* ignore */ } throw error; }
        }
        // GIF 的静态首帧 + 视频版（hydrate 生成）也要纳入 wanted，
        // 否则会被 #pruneThumbs 当成孤儿删掉 —— 删了面板就又得回退到加载动图。
        const mp4Name = `${safeId}.mp4`;
        const hasMp4 = ext === '.gif' && isUsableFile(path.join(dir, mp4Name));
        if (ext === '.gif') {
          wanted.add(path.resolve(path.join(dir, `${safeId}.thumb.jpg`)).toLowerCase());
          if (hasMp4) wanted.add(path.resolve(path.join(dir, mp4Name)).toLowerCase());
        }
        map.set(e.id, { thumb: `../@data/img/${name}`, video: hasMp4 ? `../@data/img/${mp4Name}` : '' });
      } catch { /* 复制失败就让它退回占位，不能影响表情功能本身 */ }
    }
    this.#pruneThumbs(dir, wanted);
    return map;
  }

  /**
   * 后台补齐面板素材（2026-10-28）。
   *
   * 为什么要有它：网格里直接加载多帧 GIF 会把渲染进程打崩（实测 169 帧那张，
   * 0xC000001D），所以页面只加载首帧缩略图；网络图走 CDN 要 3 个跨网 RTT，
   * 落地一份本地缓存后打开面板几乎瞬间出图、断网也能看。
   *
   * 约束：**全异步、失败即跳过**。这只是"界面更好看"，绝不能影响表情同步本身，
   * 所以每一步都单独 try，最后返回生成了几张，由调用方决定要不要刷快照。
   *
   * @returns {Promise<number>} 本次新生成的素材数量
   */
  async hydrate() {
    let made = 0;
    const dir = path.join(DATA_DIR, 'plugin-data', 'sticker', 'img');
    try {
      if (!fs.existsSync(FFMPEG_BIN)) return 0;
      fs.mkdirSync(dir, { recursive: true });
    } catch { return 0; }
    const entries = Array.isArray(this.entries) ? this.entries : [];

    // 单次启动的工作量上限（分发场景必须有的闸）。
    // 别人的收藏可能是几百张：一次性全下会占满带宽、拖住后台十几分钟。
    // 这里每次启动只补一小批，剩下的下次启动接着做 —— 用户无感，网络也不炸。
    const MAX_NET_PER_RUN = 60;
    const MAX_GIF_PER_RUN = 40;   // 首次启动就能把常见规模的库补齐（31 张 GIF ≈ 30 秒后台）

    // ① 网络图 → 本地缓存
    let netTried = 0;
    for (const e of entries) {
      if (netTried >= MAX_NET_PER_RUN) break;
      const url = String(e?.url || '').trim();
      if (!/^https?:/i.test(url)) continue;
      const sid = safeStickerId(e.id);
      const tmp = path.join(dir, `.dl_${sid}`);
      try {
        // 已有任意扩展名的图片缓存（GIF 会被转成 .jpg，见下）
        const imgPath = ['.jpg', '.png', '.webp', '.jpeg', '.bmp']
          .map((ext) => path.join(dir, `net_${sid}${ext}`))
          .find((p) => isUsableFile(p)) || '';
        // 动图还要一份 mp4（详情页播动图用）。两种"不必再动"的状态：
        //   · mp4 已生成；
        //   · 上次尝试过但不是动图 / 转码失败 —— 用 .nomp4 标记记住，避免每次启动都重下。
        // 只有"图片在但 mp4 结论未知"的老缓存会再下一次：那是今天之前的版本留下的，
        // 原始字节没保存，判不出它原本是不是 GIF，只能重取一次。取完立刻留标记，只发生一次。
        const mp4Path = path.join(dir, `net_${sid}.mp4`);
        const mp4Settled = isUsableFile(mp4Path) || fs.existsSync(path.join(dir, `net_${sid}.nomp4`));
        if (imgPath && mp4Settled) continue;
        netTried += 1;
        const res = await safeFetchBinary(url, 12 * 1024 * 1024, { timeoutMs: 10000 });
        const buf = res?.buffer;
        if (!buf || !buf.length) continue;
        const ext = (detectImageExt(buf) || '.jpg').toLowerCase();
        const isGif = ext === '.gif';
        // GIF 必须转首帧（网格里加载动图会崩）；其余格式**原样落地**，
        // 别再走一遍 ffmpeg —— 300×250 的 JPEG 重编码后反而更大（实测 6.7KB→7.3KB）。
        const destName = `net_${sid}${isGif ? '.jpg' : ext}`;
        const dest = path.join(dir, destName);
        if (isGif) {
          writeFileAtomic(tmp, buf);
          if (!imgPath) {
            await ffmpegInto(dest, tmp,
              ['-vframes', '1', '-vf', 'scale=320:-1:force_original_aspect_ratio=decrease']);
          }
          // 详情页的动图：与本地 GIF 同一套做法，用视频解码绕开 GIF 解码器。
          if (!isUsableFile(mp4Path)) {
            await ffmpegInto(mp4Path, tmp,
              ['-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=320:-2', '-an'], 30000);
          }
          // 转不出 mp4（ffmpeg 不支持 / 损坏）就留标记，省得每次启动都白试一遍
          if (!isUsableFile(mp4Path)) {
            try { fs.writeFileSync(path.join(dir, `net_${sid}.nomp4`), ''); } catch { /* ignore */ }
          }
        } else {
          if (!imgPath) writeFileAtomic(dest, buf);
          try { fs.writeFileSync(path.join(dir, `net_${sid}.nomp4`), ''); } catch { /* ignore */ }
        }
        if (isUsableFile(dest)) made += 1;
      } catch { /* 单张失败跳过，下次启动还会再试 */ }
      finally { try { fs.unlinkSync(tmp); } catch { /* 不存在就算了 */ } }
    }

    // ② 本地 GIF → 首帧缩略图 + 视频版
    //
    // 为什么要 mp4（2026-10-28）：本机的 Chromium 解码多帧 GIF 会直接把渲染进程打崩
    // （连单张都崩），但视频解码走的是另一条路径，实测把 169 帧的 GIF 转成 320px H.264
    // 只要 0.66 秒、体积 1.4MB → 131KB。详情弹窗因此用 <video> 播动图，不再碰 GIF 解码器。
    let gifTried = 0;
    for (const e of entries) {
      if (gifTried >= MAX_GIF_PER_RUN) break;
      const url = String(e?.url || '').trim();
      if (!url.toLowerCase().startsWith('file:///')) continue;
      const src = localStickerPath(url);
      if (!src || !/\.gif$/i.test(src)) continue;
      const safeId = safeStickerId(e.id);
      const thumbPath = path.join(dir, `${safeId}.thumb.jpg`);
      const mp4Path = path.join(dir, `${safeId}.mp4`);
      // 判"就绪"要用"存在且非空"：原来只看 existsSync，半张缩略图/0 字节 mp4
      // 会让这里永远跳过，详情页也就永远是一片黑。
      if (isUsableFile(thumbPath) && isUsableFile(mp4Path)) continue;
      gifTried += 1;
      try {
        if (!isUsableFile(thumbPath)) {
          await ffmpegInto(thumbPath, src,
            ['-vframes', '1', '-vf', 'scale=320:-1:force_original_aspect_ratio=decrease']);
        }
        if (!isUsableFile(mp4Path)) {
          await ffmpegInto(mp4Path, src,
            ['-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=320:-2', '-an'], 30000);
        }
        if (isUsableFile(thumbPath) || isUsableFile(mp4Path)) made += 1;
      } catch { /* ignore */ }
    }
    if (made > 0) {
      try { this.api?.log?.(`面板素材已补齐：${made} 张（GIF 首帧 / 网络图缓存）`); } catch { /* ignore */ }
    }
    return made;
  }

  /**
   * 清掉没人引用的缩略图。
   * ⚠️ 两道保险：库为空时**完全不动**（否则一次加载时序问题就会把缩略图全删光）；
   *     以及 10 分钟宽限（跟 pruneOrphanImages 一致），避免同步中途误删。
   */
  #pruneThumbs(dir, wanted) {
    if (!(this.entries || []).length) return 0;
    const GRACE_MS = 10 * 60 * 1000;
    const now = Date.now();
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (wanted.has(path.resolve(fp).toLowerCase())) continue;
          if (!expiredSinceFile(st.mtimeMs, GRACE_MS, now)) continue;
          fs.unlinkSync(fp);
          removed += 1;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return removed;
  }

  get config() {
    return this.api.config();
  }

  get enabled() {
    return this.config?.enabled !== false;
  }

  get promptMaxStickers() {
    return Math.max(1, Math.min(60, Number(this.config?.promptMaxStickers) || 10));
  }

  get encourageLevel() {
    return Math.min(3, Math.max(0, Number(this.config?.encourage) || 1));
  }

  get rotatePeriodMin() {
    const v = this.config?.rotatePeriodMin;
    return v === undefined ? 60 : Math.max(0, Number(v) || 0);
  }

  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && withinWindow(this.syncedAt, ttl, now)) {
      return { entries: this.entries, fromCache: true };
    }
    // 降频窗口内直接返回内存快照。force=true 不拦：用户在查看器里点"刷新"
    // 或刚收藏完新表情时，必须能立刻真同步。
    if (!force && this.backoffUntil && withinWindow(this.backoffAt, this.backoffMs, now)) {
      return { entries: this.entries, fromCache: true, backoff: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = SYNC_FETCH_COUNT;
        const data = await this.api.qqCall('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) {
          // 把"返回了什么形状"带进错误 —— 原来只有一句"data 不是数组"，
          // 既不知道是 null、对象还是字符串，也不知道键名对不对。
          throw new Error(`fetch_custom_face_detail 返回的形状不对（${describeStickerPayload(data)}）`);
        }
        // 只有"这次拉取是完整的一份"才允许剪枝。拿满 count 条 = 后面还有，
        // 此时不在列表里的表情只是"没翻到"，删掉就是永久丢数据（含备注/标签/使用次数）。
        const complete = isStickerFetchComplete(fetched.length, count);
        const before = this.entries.length;
        const merged = mergeStickerLibrary(this.entries, fetched, { prune: complete });
        this.entries = merged;
        // D2：把被远端 url 覆盖掉的本地转存路径换回来（详见 #restoreLocalUrls 注释）
        const restored = this.#restoreLocalUrls();
        this.syncedAt = Date.now();
        // E1（收包人报告 2026-10-27）：写盘前把磁盘上的外部改动并回来，
        // 否则"启动时快照 + 远端合并"的内存库会把外部脚本改过的 stickers.json
        // 整份盖回旧值（外部改动静默丢失）。详见 mergeDiskStickerStore。
        try {
          const back = mergeDiskStickerStore(this.entries);
          this.entries = back.entries;
          if (back.added || back.updated) {
            this.api.log(`表情库：并入磁盘外部改动（新增 ${back.added}、更新 ${back.updated} 条）`);
          }
        } catch { /* 并入失败不阻塞正常同步 */ }
        saveStickerStore(this.entries);
        this.pruneOrphanImages();
        if (fetched.length > 0) this.#noteSyncRecovered(fetched.length);
        if (merged.length < before) {
          this.api.log(`收藏同步：QQ 侧已移除 ${before - merged.length} 个表情，本地库同步删除`);
        } else if (!complete && fetched.length > 0) {
          // 不剪枝时说明一句，免得用户看到"本地有 200 张、QQ 只有 150 张"时以为是 bug。
          // 空结果不走这里：它归 #noteSyncProblem 管，否则一次同步会打两行。
          this.api.log(`收藏同步：本次拿到 ${fetched.length} 条（请求 ${count}），已按"不完整"处理 —— 只增不删`);
        } else if (!fetched.length) {
          // 0 条不是"成功同步了个空库"，而是最值得诊断的状态：把协议端返回的
          // **形状**记下来（只记键名与长度），下一次有人看日志就能判断是
          // 「收藏真的空」还是「接口没实现 / 参数不匹配」。
          this.#noteSyncProblem(
            `收藏同步：本次拿到 0 条（请求 ${count}）。协议端返回：${describeStickerPayload(data)}。`
            + '若长期为 0，多半是该协议端未实现 fetch_custom_face_detail，或 QQ 侧收藏为空'
          );
        }
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 原来这里完全静默：调用方虽然会写一条"最近一次收藏同步失败"到查看器，
        // 但 data/logs 里一个字都没有 —— 用户报"表情不同步"时无从查起。
        this.#noteSyncProblem(`收藏同步失败（连续 ${this.emptyStreak + 1} 次）：${msg.slice(0, 240)}`);
        return { entries: this.entries, fromCache: true, error: msg };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * D2：把"同步时被远端 url 覆盖回去"的本地转存路径换回来。
   *
   * 病灶：`mergeStickerLibrary` 里是 `url: item.url || old.url` —— 远端有 url 就
   *   无脑覆盖。而 QQ 图床直链带 rkey，大约 1 小时过期，过期后表情就发不出去。
   *   `ensureSendable` 本来会在**发送前**重新落地一份，但那要等到真要发的时候，
   *   而且落地失败的兜底链（get_image / 重新下载）在直链过期时也救不回来。
   *   更糟的是 `localFile` 以前没进 `normalizeStickerEntry`，存一轮就没了。
   *
   * 改法：同步后逐个回填 —— 只要本地文件还在受控目录里，就用它，不信任远端直链。
   * `localStickerPath` 顺带保证了路径没跑出 sticker-images/，免得回填成任意文件。
   *
   * @returns {number} 回填的条数
   */
  #restoreLocalUrls() {
    let restored = 0;
    for (const e of this.entries || []) {
      const local = String(e?.localFile || '').trim();
      if (!local.toLowerCase().startsWith('file:///')) continue;
      if (String(e?.url || '').trim().toLowerCase().startsWith('file:///')) continue;
      // 文件没了 / 不在受控目录内 → 不回填，留着远端 url 让 ensureSendable 重新落地
      if (!localStickerPath(local)) continue;
      e.url = local;
      restored += 1;
    }
    return restored;
  }

  async ensureSendable(sticker) {
    if (!sticker?.id || !sticker?.url) return sticker;
    const url = String(sticker.url);
    if (url.toLowerCase().startsWith('file:///')) return sticker;
    if (sticker._persistTried) return sticker;
    sticker._persistTried = true;
    try {
      const local = await this.#persistImage(`st_${sticker.id}`, { url });
      if (local) {
        sticker.url = local;
        sticker.localFile = local;
        // E1：这条写盘同样要先并入磁盘外部改动（同 sync() 口径）
        try { saveStickerStore(mergeDiskStickerStore(this.entries).entries); } catch { /* 落盘失败不致命：下次同步会重写 */ }
      }
    } catch {
      try {
        const fresh = await this.sync(true);
        const updated = findSticker(fresh.entries, sticker.id);
        const freshUrl = updated?.url ? String(updated.url).trim() : '';
        if (freshUrl && !freshUrl.toLowerCase().startsWith('file:///') && freshUrl !== url) {
          const local = await this.#persistImage(`st_${sticker.id}`, { url: freshUrl });
          if (local) {
            sticker.url = local;
            sticker.localFile = local;
            try { saveStickerStore(mergeDiskStickerStore(this.entries).entries); } catch { /* 落盘失败不致命：下次同步会重写 */ }
          }
        }
      } catch { /* 重同步也失败：就用手上这份原始 URL，不影响发表情 */ }
    }
    return sticker;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit, { hidden: this.hidden });
  }

  /**
   * 找一个**可用**的表情 —— 已隐藏的算找不到，这样发送/看图/备注都会被挡住，
   * 不会出现"删了还能发"的漏网之鱼。
   */
  async find(ref) {
    const synced = await this.sync(false);
    const hit = findSticker(synced.entries, ref);
    if (!hit) return null;
    return isHidden(hit, this.hidden) ? null : hit;
  }

  /**
   * 落盘统一入口：**先并入磁盘外部改动，再写**。
   *
   * 为什么（2026-10-28 审计）：E1（外部改了 stickers.json，被内存快照整份盖回去）
   * 此前只修了两条路径 ——「同步」和「发送前转存」。备注、记使用次数、收藏这三条
   * **写**路径仍是整份覆盖，而「收藏」恰恰最容易撞上：一边有脚本/运维在改库，
   * 一边让机器人收藏一张表情，脚本改的那批就被内存快照抹掉了。
   * 合并规则见 mergeDiskStickerStore（外部新增必留、编辑字段按 updatedAt 取新）。
   */
  #saveMerged() {
    try {
      const back = mergeDiskStickerStore(this.entries);
      this.entries = back.entries;
      if (back.added || back.updated) {
        this.api.log(`表情库：并入磁盘外部改动（新增 ${back.added}、更新 ${back.updated} 条）`);
      }
    } catch { /* 并入失败就退化为直接落盘 —— 不能因为合并逻辑坏了反而不保存 */ }
    saveStickerStore(this.entries);
  }

  note(id, patch) {
    // 已删除的表情不能再备注 —— 否则"删了还能改"，而且改 updatedAt 会让它
    // 在「按最近更新」排序里往前冒，等于删了个寂寞。
    const target = findStickerExact(this.entries, String(id ?? ''));
    if (target && isHidden(target, this.hidden)) return null;
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) this.#saveMerged();
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) this.#saveMerged();
    return result.entry;
  }

  async collect(messageId, { url, note = '', file = '', tags = [], usage = '' } = {}) {
    if (!this.config?.collectEnabled) throw new Error('收藏表情功能未开启');
    const now = Date.now();
    // 标签归一化：模型可能给数组、也可能给"无语,翻白眼"这种串 —— 两种都收。
    // 上限 20 个（与 applyStickerNote 同口径），空串丢掉。
    const normTags = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、;；\s]+/))
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .slice(0, 20);
    const normUsage = String(usage ?? '').trim().slice(0, 60);
    this.collectTimes = this.collectTimes.filter((t) => withinWindow(t, 3600000, now));
    if (this.collectTimes.length >= Math.max(1, Number(this.config?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url && !file) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      // 重新收藏一条"删掉过的"= 用户想要它回来，顺手取消隐藏。
      // 不这么做的话：note() 会因为我们刚加的隐藏拦截返回 null，
      // 表现为"说了一句收藏，机器人回你『找不到』"，很莫名。
      if (isHidden(existing, this.hidden)) this.unhide(id);
      return this.note(id, { note: String(note || ''), tags: normTags, usage: normUsage });
    }

    let localFile = '';
    try {
      localFile = await this.#persistImage(id, { url, file });
    } catch (error) {
      this.api.warn(`收藏图片转存失败，退回存 url（可能 1 小时后失效）: ${error?.message ?? error}`);
    }

    const entry = {
      id,
      resId: id,
      url: localFile || url,
      sourceUrl: url,
      localFile: localFile || '',
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: normTags,
      usage: normUsage,
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    this.#saveMerged();
    return entry;
  }

  async #persistImage(id, { url, file }) {
    const imgDir = stickerImagesDir();
    fs.mkdirSync(imgDir, { recursive: true });
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'sticker';
    if (file) {
      try {
        const ret = await this.api.qqCall('get_image', { file: String(file) });
        const srcPath = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (srcPath) {
          const buf = fs.readFileSync(srcPath);
          if (buf.length) {
            const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
            writeFileAtomic(dest, buf);
            return `file:///${dest.replace(/\\/g, '/')}`;
          }
        }
        if (ret?.url) {
          const buf = await this.#downloadBytes(String(ret.url));
          if (buf) {
            const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
            writeFileAtomic(dest, buf);
            return `file:///${dest.replace(/\\/g, '/')}`;
          }
        }
      } catch { /* 本地落盘失败：沿用原始 URL */ }
    }
    if (url) {
      const buf = await this.#downloadBytes(url);
      if (buf) {
        const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
        writeFileAtomic(dest, buf);
        return `file:///${dest.replace(/\\/g, '/')}`;
      }
    }
    throw new Error('图片转存失败（get_image 无缓存且 url 下载失败）');
  }

  async #downloadBytes(url, timeoutMs = 15000) {
    try {
      void timeoutMs;
      const { buffer } = await safeFetchBinary(String(url), 15 * 1024 * 1024);
      return buffer?.length ? buffer : null;
    } catch {
      return null;
    }
  }

  pruneOrphanImages() {
    const imgDir = stickerImagesDir();
    let removed = 0;
    try {
      if (!fs.existsSync(imgDir)) return 0;
      const referenced = new Set();
      for (const e of this.entries || []) {
        const m = /^file:\/\/\/?(.*)$/i.exec(String(e?.localFile || e?.url || ''));
        if (!m) continue;
        try { referenced.add(path.resolve(decodeURIComponent(m[1])).toLowerCase()); } catch { /* 坏路径跳过：只影响这一条 */ }
      }
      const now = Date.now();
      const GRACE_MS = 10 * 60 * 1000;
      for (const name of fs.readdirSync(imgDir)) {
        const fp = path.join(imgDir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (referenced.has(path.resolve(fp).toLowerCase())) continue;
          if (!expiredSinceFile(st.mtimeMs, GRACE_MS, now)) continue;
          fs.unlinkSync(fp);
          removed += 1;
        } catch { /* 单个文件删不掉（占用/权限）：跳过，不中断整轮清理 */ }
      }
    } catch { /* 清理失败不影响主流程：少删几张图，下次再来 */ }
    return removed;
  }
}
