// 草稿级写入互斥（2026-10-28 审计修）。
//
// 为什么需要它：前端有 forgeBusy / upgradeBusy 两道界面守卫，但那只是**界面层** ——
// 刷新页面、开两个窗口、直接打接口都能绕过去。草稿是磁盘上的一堆文件，两个请求
// 同时往里写就是"谁后落盘谁说了算"，结果是文件清单与闸门结论对不上，而闸门结论
// 正是用户点「安装」的依据。
//
// 设计取舍：
//   · **进程内**锁，不落磁盘 —— 进程重启即清空，不存在"上次崩溃留下的死锁"；
//   · 只锁会改草稿/会落地的动作，读、查、预览一律不锁（否则界面会被无故卡住）；
//   · 没有 draftId（新建草稿）时直接放行 —— 新 id 不可能与任何在跑的请求冲突；
//   · 释放由调用方挂在响应结束上（见 routes.js 的 lockForgeDraft），
//     这样 handler 里任何 return 路径都能解开，不依赖 finally 包裹整个函数体。
//
// 单独成文件而不是塞进 routes.js：这段逻辑没有网络副作用，可以在单测里直接
// 验证"二次获取被拒 / 释放后可再取 / 不同草稿互不影响"，不用起 HTTP。

const BUSY = new Map();   // draftId -> { kind, since }

/**
 * 尝试获取草稿写锁。
 * @param {string} draftId
 * @param {string} kind 动作名（用于提示"正在被什么占用"）
 * @returns {{release: () => void} | {busy: {kind: string, since: number}}}
 */
export function acquireForgeDraftLock(draftId, kind) {
  const key = String(draftId || '').trim();
  if (!key) return { release: () => {} };
  const cur = BUSY.get(key);
  if (cur) return { busy: cur };
  BUSY.set(key, { kind, since: Date.now() });
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const held = BUSY.get(key);
      // 只释放自己持有的那份：防御性判断，正常不会被顶替
      if (held && held.kind === kind) BUSY.delete(key);
    }
  };
}

/** 当前持有者（没有则 null）。给日志/测试用。 */
export function forgeDraftLockHolder(draftId) {
  const key = String(draftId || '').trim();
  return key ? (BUSY.get(key) || null) : null;
}

/** 仅测试用：清空全部锁，避免用例之间互相影响。 */
export function __resetForgeDraftLocks() {
  BUSY.clear();
}

/**
 * 「已装扩展目标」的锁键：<kind>:<dir>（2026-11-16 审计修）。
 *
 * 升级安装 / 回滚写的是同一个 plugins/<dir> 或 skills/<dir>，
 * 而它们的 draftId 各不相同（回滚甚至没有草稿）——按 draftId 上锁拦不住
 * 这两条路交叉覆盖。统一改成按**目标目录**上锁才能互斥。
 *
 * 校验与 harness/forge/index.js 的 installedDirName 同口径：单段目录名，
 * 不含 `..` / 分隔符 / NUL；kind 只认 skill / plugin。非法返回空串（调用方
 * 据此不上锁 —— 那种请求本来就会被 harness 的 realpath containment 拒绝，
 * 不会产生写入）。
 */
export function forgeTargetLockKey(kind, dir) {
  const k = String(kind || '');
  if (k !== 'skill' && k !== 'plugin') return '';
  const d = String(dir || '').replace(/\\/g, '/');
  if (!d || d === '.' || d === '..' || d.includes('/') || d.includes('\0')) return '';
  return `${k}:${d}`;
}
