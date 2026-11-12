/**
 * 时钟回拨安全的时间窗判定。
 *
 * ── 为什么需要它（2026-11-11 猎奇 bug 审查）────────────────────────────
 * 项目里散落着二十多处 `Date.now() - at < TTL` 形式的「还在窗口内」判定，
 * 它们都隐含一个假设：系统时钟单调不减。这个假设在以下场景会破：
 *   · 蓝屏 / 掉电重启后 CMOS 时间跳变、NTP 把时间往回校；
 *   · 缓存文件的 mtimeMs 来自磁盘，可能是「未来时间」（从备份恢复、
 *     打包机时间比本机快、ZIP 里带原始时间戳）；
 *   · 用户手动改系统时间。
 * 一旦 `at > now`，差值变成**负数**，`负数 < TTL` 恒为 true ——
 * 于是「冷却期 / 去重窗口 / 负缓存 / 失败降频」全部判定成「还没到重试时间」，
 * 轻则卡住回拨的时长，重则（CMOS 掉到几年前）永久不再重试，
 * 而且日志里毫无痕迹：它看起来就像「功能正常地安静着」。
 *
 * 口径：**时间戳在未来 = 这份记录不可信 = 视为已过期**，重新执行一次。
 * 宁可多打一次请求，也不要静默卡死。这与项目里既有的「未探测不阻断」
 * 「宁可这轮看不见图也别整轮报错」是同一个取舍方向。
 *
 * 正常时间下（`at <= now`）与原来的减法判定**逐字节等价**，所以替换不改变既有行为。
 */

/**
 * 从 `at` 到 `now` 经过的毫秒数。
 * 未来时间戳 / 非有限值 → Infinity（调用方的 `< TTL` 一律判 false）。
 */
export function elapsedSince(at, now = Date.now()) {
  let t, n;
  // Number(Symbol) / 会抛的 valueOf 不能让「容错工具」自己把调用方打挂。
  try { t = Number(at); n = Number(now); } catch { return Infinity; }
  const d = n - t;
  return Number.isFinite(t) && Number.isFinite(n) && Number.isFinite(d) && d >= 0 ? d : Infinity;
}

/** `at` 是否仍在 `windowMs` 窗口内（用于「冷却中 / 刚做过 / 缓存有效」判定）。 */
export function withinWindow(at, windowMs, now = Date.now()) {
  const w = Number(windowMs);
  return Number.isFinite(w) && w > 0 && elapsedSince(at, now) < w;
}

/** `at` 是否已超出 `windowMs` 窗口（用于「过期了 / 该重试了」判定）。 */
export function expiredSince(at, windowMs, now = Date.now()) {
  return !withinWindow(at, windowMs, now);
}

/**
 * 文件系统时间戳的过期判定，带时钟偏差容差。
 *
 * ⚠️ 不能直接用 `expiredSince()`：fs.statSync().mtimeMs 与 Date.now() **不同源**，
 *    Windows 上刚 writeFileSync 完的文件 mtime 常比 Date.now() 超前几毫秒到几秒。
 *    严格版会把「刚下载好的缓存」判成过期（每次都重拉），还会让 readCache 提前
 *    return 而跳过坏档清理 —— 这是 2026-11-11 全量回归里抓到的真副作用。
 * 所以：轻微超前（< 1 分钟）按「刚写入」处理，只有明显超前才当成时钟回拨/打包机
 * 时间超前，判为过期。内存里那些来自 Date.now() 的时间戳仍用严格版，两者别混。
 */
const FILE_MTIME_SKEW_MS = 60_000;

export function expiredSinceFile(at, windowMs, now = Date.now()) {
  let t, n, w;
  try { t = Number(at); n = Number(now); w = Number(windowMs); } catch { return true; }
  if (!Number.isFinite(t) || !Number.isFinite(n) || !Number.isFinite(w) || w <= 0) return true;
  const d = n - t;
  if (!Number.isFinite(d)) return true;
  if (d < -FILE_MTIME_SKEW_MS) return true;          // 明显未来 → 时间不可信
  return Math.max(0, d) > w;                          // 轻微超前 → 当作刚写入
}
